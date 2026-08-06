#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash) — denies destructive git commands that
# silently discard uncommitted working-tree content.
set -euo pipefail

INPUT="$(cat)"
# jq parse failure = no opinion, not an unpredictable non-blocking error
# (set -e would otherwise exit nonzero) — same pattern as approve-plugin-skills.sh
CMD="$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0

if [[ -z "$CMD" ]]; then
  exit 0
fi

DENY_SUFFIX=" Undo your own edits by editing instead of discarding them; ask Craig for an exception if this destructive command is genuinely needed."

deny() {
  local reason="$1"
  jq -n --arg reason "${reason}${DENY_SUFFIX}" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Git global options may appear between `git` and the subcommand
# (e.g. `git -C dir reset --hard`, `git -c k=v checkout -- f`), so every
# subcommand pattern below matches through them via $GIT instead of
# requiring the subcommand adjacent to `git`.
GIT_GOPT='(-C[[:space:]]*[^[:space:]]+|-c[[:space:]]*[^[:space:]]+|--git-dir(=[^[:space:]]+|[[:space:]]+[^[:space:]]+)|--work-tree(=[^[:space:]]+|[[:space:]]+[^[:space:]]+)|--namespace(=[^[:space:]]+|[[:space:]]+[^[:space:]]+)|--exec-path(=[^[:space:]]+)?|--super-prefix=[^[:space:]]+|--config-env=[^[:space:]]+|-p|--paginate|-P|--no-pager|--no-optional-locks|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--bare)'
GIT="git([[:space:]]+${GIT_GOPT})*[[:space:]]+"

# 1. `git checkout -- <pathspec>` (working-tree discard form).
#    Must NOT match ordinary branch checkouts (`git checkout main`,
#    `git checkout -b feature`, `git checkout --track ...`) — those have no
#    bare "--" token immediately after `checkout` (and its flags).
if echo "$CMD" | grep -Eq "${GIT}checkout([[:space:]]+[^|&;]*)?[[:space:]]--([[:space:]]|\$)"; then
  deny "git checkout -- discards working-tree changes."
fi

# 2. `git restore`, except the pure --staged unstage form (which never
#    touches worktree content). --staged combined with --worktree/-W does
#    touch the worktree, so that combination is still denied.
if echo "$CMD" | grep -Eq "${GIT}restore\\b"; then
  if echo "$CMD" | grep -Eq -- '--staged\b' && ! echo "$CMD" | grep -Eq -- '(--worktree\b|-W\b)'; then
    : # pure staged unstage - allow
  else
    deny "git restore discards or overwrites working-tree content."
  fi
fi

# 3. `git reset --hard`, any form (with or without a following ref).
#    Exact-token match: \b would treat '-' as a boundary and also deny
#    non-flags like `--hard-not-really`.
if echo "$CMD" | grep -Eq "${GIT}reset\\b" && echo "$CMD" | grep -Eq -- '--hard($|[[:space:]])'; then
  deny "git reset --hard discards working-tree and index changes."
fi

# 4. `git clean` with a force/delete flag (e.g. -f, --force, -fd, -fdx),
#    except a dry run (-n/--dry-run present anywhere, even combined with
#    --force — dry-run wins and nothing is actually deleted).
if echo "$CMD" | grep -Eq "${GIT}clean\\b"; then
  if echo "$CMD" | grep -Eq -- '(^|[[:space:]])(-[a-zA-Z]*n[a-zA-Z]*|--dry-run)([[:space:]]|$)'; then
    : # dry run - allow
  elif echo "$CMD" | grep -Eq -- '(^|[[:space:]])(-[a-zA-Z]*f[a-zA-Z]*|--force)([[:space:]]|$)'; then
    deny "git clean with a force flag permanently deletes untracked files."
  fi
fi

exit 0

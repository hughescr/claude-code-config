#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash) — denies destructive git commands that
# silently discard uncommitted working-tree content.
set -euo pipefail

INPUT="$(cat)"
CMD="$(echo "$INPUT" | jq -r '.tool_input.command // empty')"

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

# 1. `git checkout -- <pathspec>` (working-tree discard form).
#    Must NOT match ordinary branch checkouts (`git checkout main`,
#    `git checkout -b feature`, `git checkout --track ...`) — those have no
#    bare "--" token immediately after `checkout` (and its flags).
if echo "$CMD" | grep -Eq 'git[[:space:]]+checkout([[:space:]]+[^|&;]*)?[[:space:]]--([[:space:]]|$)'; then
  deny "git checkout -- discards working-tree changes."
fi

# 2. `git restore`, except the pure --staged unstage form (which never
#    touches worktree content). --staged combined with --worktree/-W does
#    touch the worktree, so that combination is still denied.
if echo "$CMD" | grep -Eq 'git[[:space:]]+restore\b'; then
  if echo "$CMD" | grep -Eq -- '--staged\b' && ! echo "$CMD" | grep -Eq -- '(--worktree\b|-W\b)'; then
    : # pure staged unstage - allow
  else
    deny "git restore discards or overwrites working-tree content."
  fi
fi

# 3. `git reset --hard`, any form (with or without a following ref).
if echo "$CMD" | grep -Eq 'git[[:space:]]+reset\b' && echo "$CMD" | grep -Eq -- '--hard\b'; then
  deny "git reset --hard discards working-tree and index changes."
fi

# 4. `git clean` with a force/delete flag (e.g. -f, --force, -fd, -fdx),
#    except a dry run (-n/--dry-run present anywhere, even combined with
#    --force — dry-run wins and nothing is actually deleted).
if echo "$CMD" | grep -Eq 'git[[:space:]]+clean\b'; then
  if echo "$CMD" | grep -Eq -- '(^|[[:space:]])(-[a-zA-Z]*n[a-zA-Z]*|--dry-run)([[:space:]]|$)'; then
    : # dry run - allow
  elif echo "$CMD" | grep -Eq -- '(^|[[:space:]])(-[a-zA-Z]*f[a-zA-Z]*|--force)([[:space:]]|$)'; then
    deny "git clean with a force flag permanently deletes untracked files."
  fi
fi

exit 0

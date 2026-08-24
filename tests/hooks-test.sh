#!/usr/bin/env bash
# Self-contained test runner for the PreToolUse hooks in hooks/.
# Feeds synthetic hook-input JSON (jq-constructed, matching the real format
# each script parses) to git-guard.sh and approve-plugin-skills.sh, and
# asserts on the permissionDecision.
# Exits non-zero if any assertion fails.
set -u

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../hooks" && pwd)"
PASS=0
FAIL=0

# run_hook <script> <json> [env VAR=VAL ...] -> prints decision (allow|deny|ask|none)
run_hook() {
  local script="$1" json="$2"
  shift 2
  local out
  out=$(printf '%s' "$json" | env "$@" bash "$script" 2>/dev/null)
  if [ -z "$out" ]; then
    echo "none"
  else
    printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "none"' 2>/dev/null || echo "unparseable"
  fi
}

# assert <expected-decision> <label> <script> <json> [env ...]
assert() {
  local expected="$1" label="$2" script="$3" json="$4"
  shift 4
  local got
  got=$(run_hook "$script" "$json" "$@")
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
    echo "ok   [$expected] $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL [$label] expected=$expected got=$got"
  fi
}

bash_json() { jq -cn --arg cmd "$1" '{tool_name:"Bash",tool_input:{command:$cmd}}'; }
skill_json() { jq -cn --arg s "$1" '{tool_name:"Skill",tool_input:{skill:$s}}'; }

echo "=== git-guard.sh ==="
GG="$HOOKS_DIR/git-guard.sh"

# Previously-blocked cases must still block
assert deny "checkout -- pathspec"            "$GG" "$(bash_json 'git checkout -- file.txt')"
assert deny "checkout flags then --"          "$GG" "$(bash_json 'git checkout HEAD -- src/')"
assert deny "restore worktree"                "$GG" "$(bash_json 'git restore file.txt')"
assert deny "restore --staged --worktree"     "$GG" "$(bash_json 'git restore --staged --worktree f')"
assert deny "restore --staged -W"             "$GG" "$(bash_json 'git restore --staged -W f')"
assert deny "reset --hard"                    "$GG" "$(bash_json 'git reset --hard')"
assert deny "reset --hard ref"                "$GG" "$(bash_json 'git reset --hard HEAD~1')"
assert deny "clean -fd"                       "$GG" "$(bash_json 'git clean -fd')"
assert deny "clean --force"                   "$GG" "$(bash_json 'git clean --force')"

# Global-flag bypasses must now block
assert deny "-C dir reset --hard"             "$GG" "$(bash_json 'git -C /some/dir reset --hard')"
assert deny "-c k=v checkout -- f"            "$GG" "$(bash_json 'git -c a=b checkout -- f')"
assert deny "-C dir -c k=v clean -fd"         "$GG" "$(bash_json 'git -C /d -c a=b clean -fd')"
assert deny "--no-pager restore f"            "$GG" "$(bash_json 'git --no-pager restore f')"
assert deny "--git-dir=... reset --hard"      "$GG" "$(bash_json 'git --git-dir=/d/.git reset --hard')"
assert deny "compound with -C reset --hard"   "$GG" "$(bash_json 'ls && git -C /d reset --hard HEAD')"

# Benign cases must still pass (empty stdout = no opinion)
assert none "git status"                      "$GG" "$(bash_json 'git status')"
assert none "-C dir status"                   "$GG" "$(bash_json 'git -C /some/dir status')"
assert none "restore --staged (pure)"         "$GG" "$(bash_json 'git restore --staged f')"
assert none "-C dir restore --staged"         "$GG" "$(bash_json 'git -C /d restore --staged f')"
assert none "clean -n dry run"                "$GG" "$(bash_json 'git clean -n')"
assert none "clean -fdn dry run wins"         "$GG" "$(bash_json 'git clean -fdn')"
assert none "clean bare (no force)"           "$GG" "$(bash_json 'git clean')"
assert none "checkout branch"                 "$GG" "$(bash_json 'git checkout main')"
assert none "checkout -b feature"             "$GG" "$(bash_json 'git checkout -b feature')"
assert none "-C dir checkout branch"          "$GG" "$(bash_json 'git -C /d checkout main')"
assert none "reset --soft"                    "$GG" "$(bash_json 'git reset --soft HEAD~1')"
assert none "empty command"                   "$GG" "$(bash_json '')"
assert none "non-git command"                 "$GG" "$(bash_json 'ls -la')"
assert none "reset --hard-not-really"         "$GG" "$(bash_json 'git reset --hard-not-really')"

# Malformed stdin must be a predictable no-opinion: exit 0, empty stdout
gg_out=$(printf 'not json at all' | bash "$GG" 2>/dev/null)
gg_rc=$?
if [ "$gg_rc" -eq 0 ] && [ -z "$gg_out" ]; then
  PASS=$((PASS + 1))
  echo "ok   [none] malformed JSON -> exit 0, empty output"
else
  FAIL=$((FAIL + 1))
  echo "FAIL [malformed JSON] expected exit=0/empty got exit=$gg_rc out=$gg_out"
fi

echo "=== approve-plugin-skills.sh ==="
AP="$HOOKS_DIR/approve-plugin-skills.sh"

# Fixture HOME: my-plugins (post-migration), legacy plugins/, cache-only,
# marketplace-only, and a traversal target OUTSIDE the plugin dirs.
FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/hooks-test.XXXXXX")
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/.claude/my-plugins/goodplugin" \
         "$FIXTURE/.claude/plugins/legacyplugin" \
         "$FIXTURE/.claude/plugins/cache/some-marketplace/cachedplugin" \
         "$FIXTURE/.claude/plugins/marketplaces/mm/marketonly" \
         "$FIXTURE/.claude/evil"

assert allow "my-plugins plugin approved"     "$AP" "$(skill_json 'goodplugin:some-skill')"  HOME="$FIXTURE"
assert allow "legacy plugins/ approved"       "$AP" "$(skill_json 'legacyplugin:some-skill')" HOME="$FIXTURE"
assert none  "cache-only plugin -> prompt"    "$AP" "$(skill_json 'cachedplugin:some-skill')" HOME="$FIXTURE"
assert none  "marketplace-only -> prompt"     "$AP" "$(skill_json 'marketonly:some-skill')"  HOME="$FIXTURE"
assert none  "traversal name rejected"        "$AP" "$(skill_json '../evil:some-skill')"     HOME="$FIXTURE"
assert none  "absolute-path name rejected"    "$AP" "$(skill_json '/tmp:some-skill')"        HOME="$FIXTURE"
assert none  "empty plugin name rejected"     "$AP" "$(skill_json ':some-skill')"            HOME="$FIXTURE"
assert none  "infra dir 'cache' rejected"     "$AP" "$(skill_json 'cache:some-skill')"       HOME="$FIXTURE"
assert none  "unknown plugin -> prompt"       "$AP" "$(skill_json 'nosuchplugin:skill')"     HOME="$FIXTURE"
assert none  "unqualified skill -> prompt"    "$AP" "$(skill_json 'plain-skill')"            HOME="$FIXTURE"
assert none  "no skill field -> prompt"       "$AP" '{"tool_name":"Skill","tool_input":{}}'  HOME="$FIXTURE"

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0

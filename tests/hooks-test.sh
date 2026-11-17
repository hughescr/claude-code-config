#!/usr/bin/env bash
# Self-contained test runner for the PreToolUse hooks in hooks/.
# Feeds synthetic hook-input JSON (jq-constructed, matching the real format
# each script parses) to approve-plugin-skills.sh and asserts on the
# permissionDecision.
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

skill_json() { jq -cn --arg s "$1" '{tool_name:"Skill",tool_input:{skill:$s}}'; }

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
         "$FIXTURE/.claude/evil" \
         "$FIXTURE/.claude/.claude-plugin"
# Craig's own marketplace manifest lists a plugin with no my-plugins/ dir;
# the listing alone must not approve it.
printf '%s\n' '{"name":"m","plugins":[{"name":"listedplugin","source":{"source":"github","repo":"o/r"}}]}' \
  >"$FIXTURE/.claude/.claude-plugin/marketplace.json"

assert allow "my-plugins plugin approved"     "$AP" "$(skill_json 'goodplugin:some-skill')"  HOME="$FIXTURE"
assert allow "legacy plugins/ approved"       "$AP" "$(skill_json 'legacyplugin:some-skill')" HOME="$FIXTURE"
assert none  "cache-only plugin -> prompt"    "$AP" "$(skill_json 'cachedplugin:some-skill')" HOME="$FIXTURE"
assert none  "marketplace-only -> prompt"     "$AP" "$(skill_json 'marketonly:some-skill')"  HOME="$FIXTURE"
assert none  "name only in marketplace.json -> prompt" "$AP" "$(skill_json 'listedplugin:some-skill')" HOME="$FIXTURE"
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

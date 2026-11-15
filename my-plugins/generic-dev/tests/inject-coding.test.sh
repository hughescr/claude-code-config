#!/usr/bin/env bash
# Tests for hooks/inject-coding.sh, the generic-dev SessionStart and
# SubagentStart injector of instructions/CODING.md. Runs under each POSIX shell
# found (sh, dash, ksh, bash). Needs jq (the tests, not the hook). Exits
# non-zero on any failure.
set -u

PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$PLUGIN/hooks/inject-coding.sh"
MARKER="<!-- generic-dev: CODING.md -->"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

unset CLAUDE_PLUGIN_ROOT

FIX=$(mktemp -d "${TMPDIR:-/tmp}/generic-dev-hook-test.XXXXXX")
trap 'rm -rf "$FIX"' EXIT

# A temp copy of the plugin without CODING.md; the real file is never touched.
cp -R "$PLUGIN" "$FIX/nocoding"
rm -f "$FIX/nocoding/instructions/CODING.md"

# $(...) strips trailing newlines on both sides: equality is modulo a trailing newline.
EXPECTED=$(
  printf '%s\n' "$MARKER"
  cat "$PLUGIN/instructions/CODING.md"
)

SHELLS=()
for s in /bin/sh dash ksh bash; do
  command -v "$s" >/dev/null 2>&1 && SHELLS+=("$(command -v "$s")")
done

for SH in "${SHELLS[@]}"; do
  echo "=== $SH ==="
  for ev in SessionStart SubagentStart; do
    OUT=$(printf '{"hook_event_name":"%s","cwd":"/nowhere"}' "$ev" | CLAUDE_PLUGIN_ROOT="$PLUGIN" "$SH" "$HOOK" "$ev" 2>"$FIX/stderr")
    RC=$?
    if [ "$RC" -ne 0 ]; then bad "$ev: exit $RC ($(cat "$FIX/stderr"))"; continue; fi
    if ! printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then bad "$ev: invalid JSON"; continue; fi
    got_event=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName')
    if [ "$got_event" != "$ev" ]; then bad "$ev: hookEventName=$got_event"; continue; fi
    got=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext')
    if [ "$got" != "$EXPECTED" ]; then
      bad "$ev: context differs"
      diff <(printf '%s\n' "$EXPECTED") <(printf '%s\n' "$got") | head -5
      continue
    fi
    ok "$ev: marker + CODING.md round-trips"

    OUT=$(printf '{}' | CLAUDE_PLUGIN_ROOT="$FIX/nocoding" "$SH" "$HOOK" "$ev" 2>"$FIX/stderr")
    RC=$?
    if [ "$RC" -eq 0 ] && [ -z "$OUT" ]; then ok "$ev: CODING.md absent -> exit 0, no output"; else bad "$ev: absent: rc=$RC out=${OUT:0:80}"; fi
  done

  OUT=$(printf '{}' | CLAUDE_PLUGIN_ROOT="$PLUGIN" "$SH" "$HOOK" Bogus 2>"$FIX/stderr")
  RC=$?
  if [ "$RC" -eq 1 ] && [ -z "$OUT" ]; then ok "unknown event -> exit 1"; else bad "unknown event: rc=$RC"; fi
done

# hooks.json must parse and name this script for both events.
if jq -e '[.hooks.SessionStart[].hooks[].command, .hooks.SubagentStart[].hooks[].command] | length == 2 and all(test("inject-coding.sh"))' "$PLUGIN/hooks/hooks.json" >/dev/null; then
  ok "hooks.json wires both events"
else
  bad "hooks.json wiring"
fi

echo
echo "shells: ${SHELLS[*]}"
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]

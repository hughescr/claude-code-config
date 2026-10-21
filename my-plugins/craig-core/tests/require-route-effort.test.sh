#!/usr/bin/env bash
# Tests for hooks/require-route-effort.sh, the craig-core PreToolUse hook that
# denies a route-agent Agent call without effort or with model. Every case runs
# under each POSIX shell found (sh, dash, ksh, bash), because the hook must work
# on macOS and on the Linux cloud VMs. Also checks that hooks.json wires the
# hook and that its route list agrees with the agent files and CLAUDE.md.
# Needs jq. Exits non-zero on any failure.
set -u

PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$PLUGIN/hooks/require-route-effort.sh"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

FIX=$(mktemp -d "${TMPDIR:-/tmp}/craig-core-effort-test.XXXXXX")
trap 'rm -rf "$FIX"' EXIT

# A PATH with cat but no jq, for the missing-jq case.
mkdir -p "$FIX/nojq"
ln -s "$(command -v cat)" "$FIX/nojq/cat"

ROUTES=(craig-core:opus craig-core:sonnet craig-core:haiku craig-core:fable gpt-sol gpt-astra gpt-luna deepseek-flash deepseek-v4-pro)

# --- helpers -------------------------------------------------------------------
# run SHELL STDIN [VAR=VAL ...]; sets OUT, ERR, RC
run() {
  local sh="$1" stdin="$2"
  shift 2
  OUT=$(printf '%s' "$stdin" | env "$@" "$sh" "$HOOK" 2>"$FIX/stderr")
  RC=$?
  ERR=$(cat "$FIX/stderr")
}

# call SHELL TOOL-INPUT-JSON [TOOL-NAME] [VAR=VAL ...]: run the hook on a
# PreToolUse input for one tool call. Callers pass JSON as a plain argument,
# never nested inside "$(...)": bash 3.2 (macOS /bin/bash) mis-parses nested
# quotes there and brace-expands the JSON.
call() {
  local sh="$1" in="$2" tool="${3:-Agent}" stdin
  shift 2
  [ $# -gt 0 ] && shift
  stdin=$(jq -cn --argjson in "$in" --arg tool "$tool" \
    '{session_id: "t", hook_event_name: "PreToolUse", tool_name: $tool, tool_input: $in, cwd: "/nowhere"}')
  run "$sh" "$stdin" "$@"
}

decision() {
  if [ -z "$OUT" ]; then echo allow; return; fi
  printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // "none"' 2>/dev/null || echo unparseable
}

reason() { printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""' 2>/dev/null; }

# expect LABEL allow|deny [REASON-SUBSTRING...]
expect() {
  local label="$1" want="$2"
  shift 2
  if [ "$RC" -ne 0 ]; then bad "$label: exit $RC ($ERR)"; return; fi
  local got
  got=$(decision)
  if [ "$got" != "$want" ]; then bad "$label: expected $want, got $got"; return; fi
  if [ "$want" = deny ]; then
    if [ "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName')" != PreToolUse ]; then
      bad "$label: hookEventName is not PreToolUse"
      return
    fi
    local r s
    r=$(reason)
    for s in "$@"; do
      case $r in
        *"$s"*) ;;
        *) bad "$label: reason lacks '$s': $r"; return ;;
      esac
    done
  fi
  ok "$label"
}

SHELLS=()
for s in /bin/sh dash ksh bash; do
  command -v "$s" >/dev/null 2>&1 && SHELLS+=("$(command -v "$s")")
done

for SH in "${SHELLS[@]}"; do
  echo "=== $SH ==="

  for r in "${ROUTES[@]}"; do
    call "$SH" "{\"subagent_type\":\"$r\",\"prompt\":\"p\",\"description\":\"d\"}"
    expect "$r without effort -> deny" deny "\"$r\"" "no effort" "\"effort\": \"<effort>\"" "CLAUDE.md routing table"
    call "$SH" "{\"subagent_type\":\"$r\",\"effort\":\"high\",\"prompt\":\"p\"}"
    expect "$r with effort -> allow" allow
    call "$SH" "{\"subagent_type\":\"$r\",\"effort\":\"high\",\"model\":\"opus\",\"prompt\":\"p\"}"
    expect "$r with effort and model -> deny" deny "\"$r\"" "model passed" 'no "model"'
  done

  call "$SH" '{"subagent_type":"craig-core:haiku","model":"haiku","prompt":"p"}'
  expect "route with model, no effort -> deny naming both" deny "no effort" "model passed"
  call "$SH" '{"subagent_type":"gpt-luna","effort":null,"prompt":"p"}'
  expect "route with effort null -> deny" deny "no effort"
  call "$SH" '{"subagent_type":"deepseek-flash","effort":"","prompt":"p"}'
  expect "route with empty effort -> deny" deny "no effort"
  call "$SH" '{"subagent_type":"craig-core:sonnet","effort":"medium","model":"","prompt":"p"}'
  expect "route with effort and empty model -> allow" allow
  call "$SH" '{"subagent_type":"craig-core:opus","prompt":"p"}' Task
  expect "route without effort via tool name Task -> deny" deny "no effort"

  # Not route agents: allowed whatever they pass.
  call "$SH" '{"subagent_type":"craig-core:project-steward","prompt":"p"}'
  expect "capability agent without effort -> allow" allow
  call "$SH" '{"subagent_type":"craig-core:project-steward","effort":"xhigh","prompt":"p"}'
  expect "capability agent with effort override -> allow" allow
  call "$SH" '{"subagent_type":"general-purpose","model":"sonnet","prompt":"p"}'
  expect "built-in agent with model -> allow" allow
  call "$SH" '{"subagent_type":"fork","prompt":"p"}'
  expect "fork -> allow" allow
  call "$SH" '{"subagent_type":"opus","prompt":"p"}'
  expect "unprefixed name that is not a route -> allow" allow
  call "$SH" '{"subagent_type":"craig-core:opusx","prompt":"p"}'
  expect "route-name prefix only -> allow" allow
  call "$SH" '{"prompt":"p"}'
  expect "no subagent_type -> allow" allow
  call "$SH" '{"subagent_type":"craig-core:opus","prompt":"p"}' Bash
  expect "other tool name -> allow" allow

  # Bad input: no opinion.
  run "$SH" 'not json'
  expect "unparseable input -> allow" allow
  run "$SH" ''
  expect "empty input -> allow" allow

  # Missing jq: reported, never blocks.
  call "$SH" '{"subagent_type":"craig-core:opus","prompt":"p"}' Agent PATH="$FIX/nojq"
  if [ "$RC" -eq 1 ] && [ -z "$OUT" ] && [ -n "$ERR" ]; then ok "missing jq -> exit 1, stderr, no decision"; else bad "missing jq: rc=$RC out=${OUT:0:80}"; fi
done

# hooks.json wires the hook for Agent.
if jq -e '[.hooks.PreToolUse[] | select(.matcher == "Agent") | .hooks[].command] | length == 1 and all(test("require-route-effort.sh"))' "$PLUGIN/hooks/hooks.json" >/dev/null; then
  ok "hooks.json wires require-route-effort.sh on PreToolUse Agent"
else
  bad "hooks.json PreToolUse wiring"
fi

# The script's route list is the one tested here.
script_routes=$(sed -n "s/^ROUTES='\(.*\)'$/\1/p" "$HOOK" | jq -r '.[]' | sort)
if [ "$script_routes" = "$(printf '%s\n' "${ROUTES[@]}" | sort)" ]; then
  ok "script ROUTES matches the tested route list"
else
  bad "script ROUTES differs: $(printf '%s' "$script_routes" | tr '\n' ' ')"
fi

# craig-core agent files: a route agent pins model and no effort and is in the
# route list; any other agent pins both model and effort.
for f in "$PLUGIN"/agents/*.md; do
  name=$(basename "$f" .md)
  fm=$(awk 'NR == 1 && /^---$/ { on = 1; next } on && /^---$/ { exit } on' "$f")
  has_model=no; has_effort=no
  printf '%s\n' "$fm" | grep -q '^model:' && has_model=yes
  printf '%s\n' "$fm" | grep -q '^effort:' && has_effort=yes
  if printf '%s\n' "${ROUTES[@]}" | grep -qx "craig-core:$name"; then
    if [ "$has_model" = yes ] && [ "$has_effort" = no ]; then ok "route agent $name pins model only"; else bad "route agent $name: model=$has_model effort=$has_effort"; fi
  else
    if [ "$has_model" = yes ] && [ "$has_effort" = yes ]; then ok "capability agent $name pins model and effort"; else bad "capability agent $name: model=$has_model effort=$has_effort"; fi
  fi
done
for r in "${ROUTES[@]}"; do
  case $r in
    craig-core:*)
      if [ -f "$PLUGIN/agents/${r#craig-core:}.md" ]; then ok "route $r has an agent file"; else bad "route $r has no agent file"; fi
      ;;
  esac
  if grep -q "^| \`$r\` @ " "$PLUGIN/instructions/COMMON-CLAUDE.md"; then ok "route $r has a CLAUDE.md routing row"; else bad "route $r has no CLAUDE.md routing row"; fi
done

echo
echo "shells: ${SHELLS[*]}"
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]

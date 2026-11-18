#!/usr/bin/env bash
# Tests for hooks/clean-session-env.sh, the craig-core SessionEnd hook. It removes the
# ending session's own empty session-env directory, and sweeps other empty directories
# whose name is a strict UUID, that are not the sessionId of a sessions/*.json record,
# and that were not modified in the last 60 minutes. Every case runs under each POSIX
# shell found (sh, dash, ksh, bash) and under two PATHs: the normal one, and one without
# jq, which exercises the sed fallback and skips the sweep. Every case works in a
# temporary CLAUDE_CONFIG_DIR or HOME, never the real ~/.claude. Needs jq (the tests, not
# the hook). Exits non-zero on any failure.
set -u

PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$PLUGIN/hooks/clean-session-env.sh"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

command -v jq >/dev/null 2>&1 || {
  echo "jq is required to run this test" >&2
  exit 1
}

unset CLAUDE_CONFIG_DIR

FIX=$(mktemp -d "${TMPDIR:-/tmp}/craig-core-session-env-test.XXXXXX")
[ -n "$FIX" ] && [ -d "$FIX" ] || {
  echo "mktemp failed" >&2
  exit 1
}
trap 'rm -rf "$FIX"' EXIT

CFG="$FIX/config"
BASE="$CFG/session-env"
SESSIONS="$CFG/sessions"
HOMEDIR="$FIX/home"
OUTSIDE="$FIX/outside"

OWN=1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d
OWN_UPPER=$(printf '%s' "$OWN" | tr 'a-f' 'A-F')
RUN=99999999-8888-4777-8666-555555555555
OTHER=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
OTHER2=bbbbbbbb-cccc-4ddd-8eee-ffffffffffff
THIRD=eeeeeeee-ffff-4000-8111-222222222222
UNLISTED=cccccccc-dddd-4eee-8fff-000000000000

# A PATH without jq: symlinks to the external tools, so the sed fallback runs.
mkdir -p "$FIX/nojq"
for t in cat sed head find rmdir; do ln -s "$(command -v "$t")" "$FIX/nojq/$t"; done

PATHV=$PATH

# --- helpers -------------------------------------------------------------------
# reset: an empty config dir with an empty session-env, and a sessions directory
# holding one record for a running session (RUN, which has no directory of its own);
# an empty HOME with its own session-env; and an outside directory the hook must never
# touch.
reset() {
  rm -rf "$CFG" "$HOMEDIR" "$OUTSIDE"
  mkdir -p "$BASE" "$SESSIONS" "$HOMEDIR/.claude/session-env" "$OUTSIDE"
  record 1000 "$RUN"
}

# record PID SESSION-ID: sessions/PID.json, the record of a running session
record() {
  printf '{"pid": %s, "sessionId": "%s"}\n' "$1" "$2" >"$SESSIONS/$1.json"
}

# old DIR: an empty directory whose mtime is in 2020
old() { mkdir -p "$1" && touch -t 202001010000 "$1"; }

# recent_old DIR MINUTES: an empty directory whose mtime is MINUTES minutes in the past
# (BSD date, then GNU date)
recent_old() {
  mkdir -p "$1" &&
    touch -t "$(date -v-"$2"M +%Y%m%d%H%M 2>/dev/null || date -d "$2 minutes ago" +%Y%m%d%H%M)" "$1"
}

# hook_input SESSION-ID: a SessionEnd hook input as one JSON line
hook_input() {
  jq -cn --arg s "$1" '{session_id: $s, hook_event_name: "SessionEnd", reason: "other", cwd: "/nowhere"}'
}

# run SHELL STDIN [VAR=VAL ...]: the hook under a clean environment, with PATHV as
# its PATH. Sets OUT, ERR and RC.
run() {
  local sh="$1" stdin="$2"
  shift 2
  OUT=$(printf '%s' "$stdin" | env -i PATH="$PATHV" "$@" "$sh" "$HOOK" 2>"$FIX/stderr")
  RC=$?
  ERR=$(cat "$FIX/stderr")
}

gone() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
kept() { [ -e "$1" ] || [ -L "$1" ]; }
link_kept() { [ -L "$1" ]; }

# check LABEL CHECK...: ok when the check command succeeds
check() {
  local label="$1"
  shift
  if "$@"; then ok "$label"; else bad "$label"; fi
}

# expect LABEL [CHECK...]: the last run exited 0 with no stdout, and the check
# command (when given) succeeded
expect() {
  local label="$1"
  shift
  if [ "$RC" -ne 0 ]; then
    bad "$label: exit $RC ($ERR)"
    return
  fi
  if [ -n "$OUT" ]; then
    bad "$label: stdout ${OUT:0:80}"
    return
  fi
  if [ $# -gt 0 ] && ! "$@"; then
    bad "$label"
    return
  fi
  ok "$label"
}

# --- cases that hold with or without jq -----------------------------------------
# The sweep runs only when jq is installed. Each case here passes in both PATH modes,
# so an other-session directory that must survive is given a record.
common_cases() {
  local SH="$1" J id

  # Own session: its directory goes only when it is empty.
  reset
  mkdir "$BASE/$OWN"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "own empty directory removed" gone "$BASE/$OWN"

  reset
  old "$BASE/$OWN"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "own old empty directory removed" gone "$BASE/$OWN"

  reset
  record 1001 "$OTHER"
  old "$BASE/$OTHER"
  mkdir "$BASE/$OWN"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "own empty directory removed beside a running session's old empty directory" gone "$BASE/$OWN"
  check "...and that running session's directory kept" kept "$BASE/$OTHER"

  reset
  mkdir -p "$BASE/$OWN"
  touch "$BASE/$OWN/notes.txt"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "own non-empty directory kept" kept "$BASE/$OWN/notes.txt"

  reset
  old "$BASE/$OWN/inner"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "own directory holding an empty subdirectory kept" kept "$BASE/$OWN"
  check "its empty subdirectory is not removed" kept "$BASE/$OWN/inner"

  reset
  mkdir "$BASE/$OWN_UPPER"
  J=$(hook_input "$OWN_UPPER")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "upper-case UUID accepted" gone "$BASE/$OWN_UPPER"

  # session_id that is not a strict UUID: its directory must survive. Each target is
  # created fresh, so only the own-session rule can decide, and at the path the id
  # would resolve to under the base.
  for id in "../x" ".." "../" "$OWN/" "$OWN " " $OWN" "$OWN.." "/" "" "a/b" \
    "zzzzzzzz-2222-4333-8444-555555555555" \
    "1111111-22222-4333-8444-555555555555" \
    "1-111111-2222-4333-8444-555555555555" \
    "-1111111-2222-4333-8444-555555555555" \
    "11111111_2222-4333-8444-555555555555" \
    "11111111-2222-4333-8444-55555555555g" \
    "11111111-2222-4333-8444-5555555555555"; do
    reset
    mkdir -p "$BASE/$id"
    J=$(hook_input "$id")
    run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
    expect "session_id '$id' ignored" kept "$BASE/$id"
    check "base directory kept after session_id '$id'" kept "$BASE"
  done

  # Stdin: no session_id means the own directory is not touched.
  reset
  mkdir "$BASE/$OWN"
  run "$SH" "" CLAUDE_CONFIG_DIR="$CFG"
  expect "empty stdin: own fresh empty directory kept" kept "$BASE/$OWN"

  reset
  mkdir "$BASE/$OWN"
  run "$SH" "not json" CLAUDE_CONFIG_DIR="$CFG"
  expect "unparseable stdin: own fresh empty directory kept" kept "$BASE/$OWN"

  reset
  mkdir "$BASE/$OWN"
  run "$SH" '{"hook_event_name":"SessionEnd"}' CLAUDE_CONFIG_DIR="$CFG"
  expect "no session_id: own directory kept" kept "$BASE/$OWN"

  reset
  mkdir "$BASE/$OWN"
  J=$(printf '{\n  "session_id": "%s",\n  "cwd": "/nowhere"\n}\n' "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "pretty-printed input: own empty directory removed" gone "$BASE/$OWN"

  # Symlinks are never followed or removed.
  reset
  mkdir "$OUTSIDE/victim"
  ln -s "$OUTSIDE/victim" "$BASE/$OWN"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "own session symlink kept" link_kept "$BASE/$OWN"
  check "directory behind own symlink kept" kept "$OUTSIDE/victim"

  # A symlinked session-env: the own directory is removed at its real location,
  # and the symlink itself stays.
  reset
  rm -rf "$BASE"
  mkdir -p "$OUTSIDE/realbase"
  ln -s "$OUTSIDE/realbase" "$BASE"
  mkdir "$OUTSIDE/realbase/$OWN"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "own empty directory removed through a symlinked session-env" gone "$OUTSIDE/realbase/$OWN"
  check "symlinked session-env itself kept" link_kept "$BASE"

  # Locating session-env.
  reset
  rm -rf "$CFG"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "missing session-env: exit 0, nothing created" gone "$CFG"

  reset
  mkdir "$HOMEDIR/.claude/session-env/$OWN"
  J=$(hook_input "$OWN")
  run "$SH" "$J" HOME="$HOMEDIR"
  expect "no CLAUDE_CONFIG_DIR: uses HOME/.claude" gone "$HOMEDIR/.claude/session-env/$OWN"

  reset
  mkdir "$HOMEDIR/.claude/session-env/$OWN"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR= HOME="$HOMEDIR"
  expect "empty CLAUDE_CONFIG_DIR falls back to HOME" gone "$HOMEDIR/.claude/session-env/$OWN"

  reset
  mkdir "$BASE/$OWN" "$HOMEDIR/.claude/session-env/$OWN"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG" HOME="$HOMEDIR"
  expect "CLAUDE_CONFIG_DIR wins over HOME" gone "$BASE/$OWN"
  check "HOME/.claude/session-env untouched when CLAUDE_CONFIG_DIR is set" kept "$HOMEDIR/.claude/session-env/$OWN"

  reset
  J=$(hook_input "$OWN")
  run "$SH" "$J"
  expect "neither HOME nor CLAUDE_CONFIG_DIR: exit 0, nothing touched" kept "$BASE"
}

# --- sweep: only with jq, which reads the session records -----------------------
sweep_cases() {
  local SH="$1" J i
  local names=(
    "not-a-uuid"
    "a b"
    "1-111111-2222-4333-8444-555555555555"
    "-1111111-2222-4333-8444-555555555555"
    "11111111-2222-4333-8444-5555555555555"
    "11111111-2222-4333-8444-55555555555"
    "zzzzzzzz-2222-4333-8444-555555555555"
    "$OTHER "
    "$OTHER"$'\n'"xyz"
    "x\"\$(touch pwned-by-name)"
  )

  reset
  old "$BASE/$OTHER"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "old empty directory with no record removed" gone "$BASE/$OTHER"

  reset
  record 1001 "$OTHER"
  old "$BASE/$OTHER"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "old empty directory with a record kept" kept "$BASE/$OTHER"

  reset
  old "$BASE/$OTHER"
  old "$BASE/$OTHER2"
  old "$BASE/$UNLISTED"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "several old empty directories with no record removed in one sweep" gone "$BASE/$OTHER"
  check "...and the second one removed" gone "$BASE/$OTHER2"
  check "...and the third one removed" gone "$BASE/$UNLISTED"

  reset
  old "$BASE/$OTHER"
  printf '{"pid": 1002, "sessionId": "%s"}\n' "$OTHER" >"$SESSIONS/1002.0a1b2c.key"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "a .key file does not protect the directory of its session" gone "$BASE/$OTHER"

  reset
  rm -f "$SESSIONS/1000.json"
  printf '{"pid": 1002, "sessionId": "%s"}\n' "$RUN" >"$SESSIONS/1002.0a1b2c.key"
  old "$BASE/$OTHER"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "sessions directory with only .key files: nothing swept" kept "$BASE/$OTHER"

  reset
  rm -f "$SESSIONS/1000.json"
  printf '{"pid": 1002, "sessionId":\n' >"$SESSIONS/1002.json"
  old "$BASE/$OTHER"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "sessions directory with only malformed JSON: nothing swept" kept "$BASE/$OTHER"

  reset
  rm -rf "$SESSIONS"
  old "$BASE/$OTHER"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "no sessions directory: nothing swept" kept "$BASE/$OTHER"

  reset
  record 1001 "$OTHER"
  printf '{"pid": 1002, "sessionId":\n' >"$SESSIONS/1002.json"
  record 1003 "$OTHER2"
  old "$BASE/$OTHER"
  old "$BASE/$OTHER2"
  old "$BASE/$UNLISTED"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "one malformed record among valid ones: unlisted old empty directory removed" gone "$BASE/$UNLISTED"
  check "...the valid record 1001 still protects its directory" kept "$BASE/$OTHER"
  check "...the valid record 1003 still protects its directory" kept "$BASE/$OTHER2"

  reset
  printf '{"pid": 2001, "sessionId": "%s"}' "$OTHER" >"$SESSIONS/2001.json"
  printf '{"pid": 2002, "sessionId": "%s"}' "$OTHER2" >"$SESSIONS/2002.json"
  printf '{\n  "pid": 2003,\n  "sessionId": "%s"\n}\n' "$THIRD" >"$SESSIONS/2003.json"
  old "$BASE/$OTHER"
  old "$BASE/$OTHER2"
  old "$BASE/$THIRD"
  old "$BASE/$UNLISTED"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "records without a trailing newline and a pretty-printed record: unlisted removed" gone "$BASE/$UNLISTED"
  check "...compact record without a trailing newline protects its directory" kept "$BASE/$OTHER"
  check "...second compact record without a trailing newline protects its directory" kept "$BASE/$OTHER2"
  check "...pretty-printed record protects its directory" kept "$BASE/$THIRD"

  reset
  record 2004 "$(printf '%s' "$OTHER" | tr 'a-f' 'A-F')"
  old "$BASE/$OTHER"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "upper-case sessionId in a record protects the lower-case directory" kept "$BASE/$OTHER"

  reset
  mkdir "$BASE/$OTHER"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "empty directory modified within the last 60 minutes kept" kept "$BASE/$OTHER"

  reset
  recent_old "$BASE/$OTHER" 30
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "empty directory modified 30 minutes ago kept" kept "$BASE/$OTHER"

  reset
  recent_old "$BASE/$OTHER" 120
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "empty directory modified 120 minutes ago removed" gone "$BASE/$OTHER"

  reset
  mkdir -p "$BASE/$OTHER"
  touch "$BASE/$OTHER/notes.txt"
  touch -t 202001010000 "$BASE/$OTHER"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "old directory holding a file kept" kept "$BASE/$OTHER/notes.txt"

  reset
  touch "$BASE/stray"
  touch -t 202001010000 "$BASE/stray"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "old plain file in session-env kept" kept "$BASE/stray"

  # Names that are not strict UUIDs are never removed, whatever their age.
  reset
  for i in "${!names[@]}"; do
    old "$BASE/${names[$i]}"
  done
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "old empty directories with names that are not strict UUIDs: run clean"
  for i in "${!names[@]}"; do
    check "non-UUID name #$i kept" kept "$BASE/${names[$i]}"
  done
  check "no name was run as a command" gone "$BASE/pwned-by-name"

  # Symlinks named like sessions, and old, are never removed or followed.
  reset
  mkdir "$OUTSIDE/victim" "$OUTSIDE/victim2"
  ln -s "$OUTSIDE/victim" "$BASE/$OTHER"
  ln -s "$OUTSIDE/victim2" "$BASE/$OTHER2"
  touch -h -t 202001010000 "$BASE/$OTHER" "$BASE/$OTHER2"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "old symlink named like a session kept" link_kept "$BASE/$OTHER"
  check "...second old symlink kept" link_kept "$BASE/$OTHER2"
  check "...directory behind the first symlink kept" kept "$OUTSIDE/victim"
  check "...directory behind the second symlink kept" kept "$OUTSIDE/victim2"
}

# --- without jq: the sweep is skipped, own directory still removed --------------
nojq_cases() {
  local SH="$1" J

  reset
  mkdir "$BASE/$OWN"
  old "$BASE/$OTHER"
  J=$(hook_input "$OWN")
  run "$SH" "$J" CLAUDE_CONFIG_DIR="$CFG"
  expect "no jq: own empty directory removed" gone "$BASE/$OWN"
  check "no jq: old empty directory with no record kept, nothing swept" kept "$BASE/$OTHER"
}

# --- run -------------------------------------------------------------------------
SHELLS=()
for s in /bin/sh dash ksh bash; do
  command -v "$s" >/dev/null 2>&1 && SHELLS+=("$(command -v "$s")")
done

for MODE in jq nojq; do
  if [ "$MODE" = jq ]; then
    PATHV=$PATH
  else
    PATHV=$FIX/nojq
  fi
  for SH in "${SHELLS[@]}"; do
    echo "=== $MODE, $SH ==="
    if [ "$MODE" = nojq ] && env -i PATH="$PATHV" "$SH" -c 'command -v jq >/dev/null 2>&1'; then
      bad "$MODE: PATH still finds jq under $SH"
    fi
    common_cases "$SH"
    if [ "$MODE" = jq ]; then
      sweep_cases "$SH"
    else
      nojq_cases "$SH"
    fi
  done
done
PATHV=$PATH

# hooks.json runs the hook at SessionEnd with the 5-second timeout.
if jq -e '[.hooks.SessionEnd[].hooks[] | select(.command == "sh \"${CLAUDE_PLUGIN_ROOT}/hooks/clean-session-env.sh\"" and .timeout == 5)] | length == 1' "$PLUGIN/hooks/hooks.json" >/dev/null; then
  ok "hooks.json wires clean-session-env.sh at SessionEnd with timeout 5"
else
  bad "hooks.json SessionEnd wiring"
fi

echo
echo "shells: ${SHELLS[*]}; PATH modes: jq, nojq (sed fallback)"
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]

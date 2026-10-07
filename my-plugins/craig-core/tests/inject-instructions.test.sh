#!/usr/bin/env bash
# Tests for hooks/inject-instructions.sh, the craig-core SessionStart and
# SubagentStart instruction injector. Every case runs under each POSIX shell
# found (sh, dash, ksh, bash), because the hook must work on macOS and on the
# Linux cloud VMs. Simulated HOME directories cover the layouts the hook has to
# tell apart. Needs jq (the tests, not the hook). Exits non-zero on any failure.
set -u

PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$PLUGIN/hooks/inject-instructions.sh"
INSTR="$PLUGIN/instructions"
CAP=10000 # Claude Code's per-string additionalContext cap (UTF-16 units)

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

unset ANTHROPIC_BASE_URL CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT

FIX=$(mktemp -d "${TMPDIR:-/tmp}/craig-core-hook-test.XXXXXX")
trap 'rm -rf "$FIX"' EXIT

# --- fixtures ----------------------------------------------------------------
# home_none:     no ~/.claude/CLAUDE.md (Cowork, cloud VM, fresh machine)
# home_repo:     ~/.claude is a checkout holding the plugin, and CLAUDE.md is
#                the same relative symlink the real repo tracks
# home_cache:    like home_repo, but the plugin runs from a cached copy
#                (how Claude Code installs from a directory marketplace)
# home_copy:     CLAUDE.md is a byte-identical regular file (a setup script copy)
# home_other:    CLAUDE.md is someone else's unrelated file
# home_dangling: CLAUDE.md is a broken symlink
# home_proxy:    no CLAUDE.md, but the local gpt-*/deepseek-* agents exist
mkdir -p "$FIX/home_none"
mkdir -p "$FIX/home_repo/.claude/my-plugins"
cp -R "$PLUGIN" "$FIX/home_repo/.claude/my-plugins/craig-core"
ln -s my-plugins/craig-core/instructions/COMMON-CLAUDE.md "$FIX/home_repo/.claude/CLAUDE.md"
mkdir -p "$FIX/home_cache/.claude/my-plugins" "$FIX/home_cache/.claude/plugins/cache/craigs-claude-plugins/craig-core"
cp -R "$PLUGIN" "$FIX/home_cache/.claude/my-plugins/craig-core"
cp -R "$PLUGIN" "$FIX/home_cache/.claude/plugins/cache/craigs-claude-plugins/craig-core/0e5846f"
ln -s my-plugins/craig-core/instructions/COMMON-CLAUDE.md "$FIX/home_cache/.claude/CLAUDE.md"
mkdir -p "$FIX/home_copy/.claude"
cp "$INSTR/COMMON-CLAUDE.md" "$FIX/home_copy/.claude/CLAUDE.md"
mkdir -p "$FIX/home_other/.claude"
printf '# somebody else\n' >"$FIX/home_other/.claude/CLAUDE.md"
mkdir -p "$FIX/home_dangling/.claude"
ln -s /nonexistent/COMMON-CLAUDE.md "$FIX/home_dangling/.claude/CLAUDE.md"
mkdir -p "$FIX/home_proxy/.claude/agents"
printf -- '---\nname: gpt-sol-high\n---\n' >"$FIX/home_proxy/.claude/agents/gpt-sol-high.md"

REPO_ROOT="$FIX/home_repo/.claude/my-plugins/craig-core"
CACHE_ROOT="$FIX/home_cache/.claude/plugins/cache/craigs-claude-plugins/craig-core/0e5846f"

# A project with its own MAIN/SUBAGENT layers, holding awkward characters.
PROJ="$FIX/project"
mkdir -p "$PROJ/.claude"
printf 'Project main: "quotes", back\\slash, tab:\there, CRLF line\r\nemoji 👍🏻 and → arrows\n' >"$PROJ/.claude/MAIN-CLAUDE.md"
printf 'Project subagent rules\n' >"$PROJ/.claude/SUBAGENT-CLAUDE.md"

AVAIL_YES="Cross-family routes: available in this session (ANTHROPIC_BASE_URL is the utraque proxy and gpt-*/deepseek-* agents are installed). Use one only if its agent type is in the available-agents list."
avail_no() { printf 'Cross-family routes: unavailable in this session (%s). Use only craig-core:* routes and the Claude-only columns of the CLAUDE.md pairing table, and report every check as same-family.' "$1"; }

COMMON_HDR="<!-- craig-core: CLAUDE.md, Craig's global instructions (injected because ~/.claude/CLAUDE.md does not load them here) -->"

# --- helpers -------------------------------------------------------------------
# run SHELL STDIN-JSON ARGS... [-- VAR=VAL ...]; sets OUT, ERR, RC
run() {
  local sh="$1" stdin="$2"
  shift 2
  local args=() envs=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do args+=("$1"); shift; done
  [ $# -gt 0 ] && shift
  envs=("$@")
  OUT=$(printf '%s' "$stdin" | env "${envs[@]}" "$sh" "$HOOK" "${args[@]}" 2>"$FIX/stderr")
  RC=$?
  ERR=$(cat "$FIX/stderr")
}

ctx() { printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext'; }

# check_ctx LABEL EVENT EXPECTED-TEXT: OUT is valid JSON for EVENT, the context
# round-trips exactly, and it fits under the cap.
check_ctx() {
  local label="$1" event="$2" expected="$3"
  if [ "$RC" -ne 0 ]; then bad "$label: exit $RC ($ERR)"; return; fi
  if ! printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then bad "$label: invalid JSON"; return; fi
  local got_event
  got_event=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName')
  if [ "$got_event" != "$event" ]; then bad "$label: hookEventName=$got_event"; return; fi
  if [ "$(ctx)" != "$expected" ]; then
    bad "$label: context differs"
    diff <(printf '%s\n' "$expected") <(ctx) | head -5
    return
  fi
  local units
  units=$(printf '%s' "$OUT" | jq '[.hookSpecificOutput.additionalContext | explode[] | if . > 65535 then 2 else 1 end] | add')
  if [ "$units" -ge "$CAP" ]; then bad "$label: $units characters, over the $CAP cap"; return; fi
  ok "$label ($units chars)"
}

check_empty() {
  local label="$1"
  if [ "$RC" -eq 0 ] && [ -z "$OUT" ]; then ok "$label (no output)"; else bad "$label: rc=$RC out=${OUT:0:80}"; fi
}

SHELLS=()
for s in /bin/sh dash ksh bash; do
  command -v "$s" >/dev/null 2>&1 && SHELLS+=("$(command -v "$s")")
done

IN_SESSION='{"session_id":"t","hook_event_name":"SessionStart","source":"startup","cwd":"/nowhere"}'
IN_SUB='{"session_id":"t","hook_event_name":"SubagentStart","agent_type":"craig-core:haiku-xhigh","cwd":"/nowhere"}'

EXP_COMMON=$(printf '%s\n' "$COMMON_HDR"; cat "$INSTR/COMMON-CLAUDE.md")
EXP_MAIN_NO=$(printf '%s\n' "<!-- craig-core: MAIN-CLAUDE.md -->"; cat "$INSTR/MAIN-CLAUDE.md"; printf '\n'; avail_no "ANTHROPIC_BASE_URL is not http://127.0.0.1:8317 and no gpt-*/deepseek-* agents are installed")
EXP_SUB_NO=$(printf '%s\n' "<!-- craig-core: SUBAGENT-CLAUDE.md -->"; cat "$INSTR/SUBAGENT-CLAUDE.md"; printf '\n'; avail_no "ANTHROPIC_BASE_URL is not http://127.0.0.1:8317 and no gpt-*/deepseek-* agents are installed")
EXP_SUB_YES=$(printf '%s\n' "<!-- craig-core: SUBAGENT-CLAUDE.md -->"; cat "$INSTR/SUBAGENT-CLAUDE.md"; printf '\n%s' "$AVAIL_YES")
EXP_SUB_NOPROXY=$(printf '%s\n' "<!-- craig-core: SUBAGENT-CLAUDE.md -->"; cat "$INSTR/SUBAGENT-CLAUDE.md"; printf '\n'; avail_no "ANTHROPIC_BASE_URL is not http://127.0.0.1:8317")
EXP_SUB_NOAGENTS=$(printf '%s\n' "<!-- craig-core: SUBAGENT-CLAUDE.md -->"; cat "$INSTR/SUBAGENT-CLAUDE.md"; printf '\n'; avail_no "no gpt-*/deepseek-* agents are installed")
EXP_PROJ_MAIN=$(printf '%s\n' "<!-- source: $PROJ/.claude/MAIN-CLAUDE.md -->"; tr -d '\r' <"$PROJ/.claude/MAIN-CLAUDE.md")
EXP_PROJ_SUB=$(printf '%s\n' "<!-- source: $PROJ/.claude/SUBAGENT-CLAUDE.md -->"; cat "$PROJ/.claude/SUBAGENT-CLAUDE.md")

for SH in "${SHELLS[@]}"; do
  echo "=== $SH ==="
  P="CLAUDE_PLUGIN_ROOT=$PLUGIN"

  # Common part: injected only when ~/.claude/CLAUDE.md does not already load it.
  for ev in SessionStart SubagentStart; do
    run "$SH" "$IN_SESSION" "$ev" common -- "$P" HOME="$FIX/home_none"
    check_ctx "$ev common, no ~/.claude/CLAUDE.md -> injected" "$ev" "$EXP_COMMON"
    run "$SH" "$IN_SESSION" "$ev" common -- CLAUDE_PLUGIN_ROOT="$REPO_ROOT" HOME="$FIX/home_repo"
    check_empty "$ev common, symlink to this plugin's file -> skipped"
    run "$SH" "$IN_SESSION" "$ev" common -- CLAUDE_PLUGIN_ROOT="$CACHE_ROOT" HOME="$FIX/home_cache"
    check_empty "$ev common, symlink into checkout, plugin from cache -> skipped"
    run "$SH" "$IN_SESSION" "$ev" common -- "$P" HOME="$FIX/home_copy"
    check_empty "$ev common, identical regular-file copy -> skipped"
    run "$SH" "$IN_SESSION" "$ev" common -- "$P" HOME="$FIX/home_other"
    check_ctx "$ev common, unrelated ~/.claude/CLAUDE.md -> injected" "$ev" "$EXP_COMMON"
    run "$SH" "$IN_SESSION" "$ev" common -- "$P" HOME="$FIX/home_dangling"
    check_ctx "$ev common, dangling symlink -> injected" "$ev" "$EXP_COMMON"
  done

  # Role part: MAIN for the session, SUBAGENT for sub-agents, plus availability.
  run "$SH" "$IN_SESSION" SessionStart role -- "$P" HOME="$FIX/home_repo"
  check_ctx "SessionStart role -> MAIN + unavailable" SessionStart "$EXP_MAIN_NO"
  run "$SH" "$IN_SUB" SubagentStart role -- "$P" HOME="$FIX/home_repo"
  check_ctx "SubagentStart role -> SUBAGENT + unavailable" SubagentStart "$EXP_SUB_NO"
  run "$SH" "$IN_SUB" SubagentStart role -- "$P" HOME="$FIX/home_proxy" ANTHROPIC_BASE_URL=http://127.0.0.1:8317
  check_ctx "role, proxy env + gpt agents -> available" SubagentStart "$EXP_SUB_YES"
  run "$SH" "$IN_SUB" SubagentStart role -- "$P" HOME="$FIX/home_proxy" ANTHROPIC_BASE_URL=http://127.0.0.1:8317/
  check_ctx "role, proxy env with trailing slash -> available" SubagentStart "$EXP_SUB_YES"
  run "$SH" "$IN_SUB" SubagentStart role -- "$P" HOME="$FIX/home_proxy"
  check_ctx "role, gpt agents but no proxy env -> unavailable" SubagentStart "$EXP_SUB_NOPROXY"
  run "$SH" "$IN_SUB" SubagentStart role -- "$P" HOME="$FIX/home_proxy" ANTHROPIC_BASE_URL=https://api.anthropic.com
  check_ctx "role, other base URL -> unavailable" SubagentStart "$EXP_SUB_NOPROXY"
  run "$SH" "$IN_SUB" SubagentStart role -- "$P" HOME="$FIX/home_none" ANTHROPIC_BASE_URL=http://127.0.0.1:8317
  check_ctx "role, proxy env but no agents (Cowork/cloud) -> unavailable" SubagentStart "$EXP_SUB_NOAGENTS"

  # Project layer, from CLAUDE_PROJECT_DIR or the input's cwd.
  run "$SH" "$IN_SESSION" SessionStart project -- "$P" HOME="$FIX/home_none" CLAUDE_PROJECT_DIR="$PROJ"
  check_ctx "SessionStart project via CLAUDE_PROJECT_DIR (escaping, CRLF, emoji)" SessionStart "$EXP_PROJ_MAIN"
  run "$SH" "{\"hook_event_name\":\"SubagentStart\",\"cwd\":\"$PROJ\"}" SubagentStart project -- "$P" HOME="$FIX/home_none"
  check_ctx "SubagentStart project via stdin cwd" SubagentStart "$EXP_PROJ_SUB"
  run "$SH" "$IN_SESSION" SessionStart project -- "$P" HOME="$FIX/home_none"
  check_empty "project, no project file"

  # No CLAUDE_PLUGIN_ROOT: the script finds its own plugin directory.
  run "$SH" "$IN_SESSION" SessionStart common -- HOME="$FIX/home_none"
  check_ctx "common without CLAUDE_PLUGIN_ROOT" SessionStart "$EXP_COMMON"

  # Errors: reported on stderr with exit 1, never half-written JSON.
  run "$SH" "$IN_SESSION" Bogus common -- "$P" HOME="$FIX/home_none"
  if [ "$RC" -eq 1 ] && [ -z "$OUT" ] && [ -n "$ERR" ]; then ok "unknown event -> exit 1, stderr"; else bad "unknown event: rc=$RC"; fi
  run "$SH" "$IN_SESSION" SessionStart bogus -- "$P" HOME="$FIX/home_none"
  if [ "$RC" -eq 1 ] && [ -z "$OUT" ] && [ -n "$ERR" ]; then ok "unknown part -> exit 1, stderr"; else bad "unknown part: rc=$RC"; fi
  run "$SH" "$IN_SESSION" SessionStart common -- CLAUDE_PLUGIN_ROOT="$FIX/home_none" HOME="$FIX/home_none"
  if [ "$RC" -eq 1 ] && [ -z "$OUT" ]; then ok "missing plugin file -> exit 1"; else bad "missing plugin file: rc=$RC"; fi
done

# hooks.json must parse and name this script for both events.
if jq -e '[.hooks.SessionStart[].hooks[].command, .hooks.SubagentStart[].hooks[].command] | length == 6 and all(test("inject-instructions.sh"))' "$PLUGIN/hooks/hooks.json" >/dev/null; then
  ok "hooks.json wires 3 parts for each event"
else
  bad "hooks.json wiring"
fi

echo
echo "shells: ${SHELLS[*]}"
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]

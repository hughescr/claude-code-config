#!/bin/sh
# craig-core: inject Craig's instructions at SessionStart and SubagentStart.
#
# Usage: inject-instructions.sh <SessionStart|SubagentStart> <common|role|project>
#
#   common   instructions/COMMON-CLAUDE.md (the global CLAUDE.md). Skipped when
#            $HOME/.claude/CLAUDE.md already is a craig-core common file, because
#            Claude Code then loads it natively for the session and every
#            sub-agent (Craig's Mac, where it is a symlink into this plugin).
#   role     instructions/MAIN-CLAUDE.md for SessionStart or
#            instructions/SUBAGENT-CLAUDE.md for SubagentStart, followed by one
#            line saying whether the cross-family routes are usable here.
#   project  <project>/.claude/MAIN-CLAUDE.md or SUBAGENT-CLAUDE.md, when the
#            project has one.
#
# Each part is a separate hook command because Claude Code caps every
# additionalContext string at 10,000 characters and replaces a longer one with
# a 2,000-character preview. tests/inject-instructions.test.sh enforces the cap.
#
# POSIX sh only (runs on macOS and the Linux cloud VMs); no jq. Prints nothing
# when there is nothing to inject. A missing plugin file is a packaging bug:
# it is reported on stderr with exit 1, which Claude Code shows but does not
# block on.

set -u
LC_ALL=C
export LC_ALL

event=${1:-}
part=${2:-}

case $event in
  SessionStart) role_file=MAIN-CLAUDE.md ;;
  SubagentStart) role_file=SUBAGENT-CLAUDE.md ;;
  *)
    echo "inject-instructions: unknown event '$event'" >&2
    exit 1
    ;;
esac

# Always drain the hook input JSON, so Claude Code never writes into a closed
# pipe. Only the project part uses it (for "cwd").
input=$(cat 2>/dev/null || true)

root=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$root" ]; then
  root=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd) || exit 1
fi
instructions=$root/instructions

# resolve PATH: print PATH's physical location with every symlink followed.
# Fails when PATH does not exist. (realpath and readlink -f are not POSIX.)
resolve() {
  _p=$1
  _n=0
  while [ -L "$_p" ]; do
    [ "$_n" -lt 40 ] || return 1
    _l=$(readlink "$_p") || return 1
    case $_l in
      /*) _p=$_l ;;
      *) _p=$(dirname "$_p")/$_l ;;
    esac
    _n=$((_n + 1))
  done
  [ -e "$_p" ] || return 1
  _d=$(cd -P "$(dirname "$_p")" 2>/dev/null && pwd) || return 1
  printf '%s/%s\n' "$_d" "$(basename "$_p")"
}

# True when $HOME/.claude/CLAUDE.md is craig-core's common file, so Claude Code
# already loads it natively. Locally the plugin usually runs from a cached copy
# (~/.claude/plugins/cache/...) while the symlink points into the marketplace
# checkout (~/.claude/my-plugins/craig-core), so any craig-core common file
# counts, as does a byte-identical copy.
native_common() {
  [ -n "${HOME:-}" ] || return 1
  _target=$(resolve "$HOME/.claude/CLAUDE.md") || return 1
  _own=$(resolve "$instructions/COMMON-CLAUDE.md") || return 1
  [ "$_target" = "$_own" ] && return 0
  case $_target in
    */craig-core/instructions/COMMON-CLAUDE.md) return 0 ;;
  esac
  cmp -s "$_target" "$_own"
}

# One line for the role part: the CLAUDE.md Route availability rule, evaluated
# for this session. Both conditions must hold: the local gpt-*/deepseek-* agent
# files exist and ANTHROPIC_BASE_URL is the utraque proxy.
availability() {
  _base=${ANTHROPIC_BASE_URL:-}
  _base=${_base%/}
  _proxy=no
  [ "$_base" = "http://127.0.0.1:8317" ] && _proxy=yes
  _agents=no
  if [ -n "${HOME:-}" ]; then
    for _f in "$HOME"/.claude/agents/gpt-*.md "$HOME"/.claude/agents/deepseek-*.md; do
      if [ -f "$_f" ]; then
        _agents=yes
        break
      fi
    done
  fi
  if [ "$_proxy" = yes ] && [ "$_agents" = yes ]; then
    printf '%s\n' "Cross-family routes: available in this session (ANTHROPIC_BASE_URL is the utraque proxy and gpt-*/deepseek-* agents are installed). Use one only if its agent type is in the available-agents list."
    return 0
  fi
  if [ "$_proxy" = no ] && [ "$_agents" = no ]; then
    _why="ANTHROPIC_BASE_URL is not http://127.0.0.1:8317 and no gpt-*/deepseek-* agents are installed"
  elif [ "$_proxy" = no ]; then
    _why="ANTHROPIC_BASE_URL is not http://127.0.0.1:8317"
  else
    _why="no gpt-*/deepseek-* agents are installed"
  fi
  printf '%s\n' "Cross-family routes: unavailable in this session ($_why). Use only craig-core:* routes and the Claude-only columns of the CLAUDE.md pairing table, and report every check as same-family."
}

# Read text on stdin and print it as one JSON string literal. Control
# characters other than tab and newline are dropped (CR included, so CRLF
# files work); backslash, double quote and tab are escaped; lines are joined
# with \n. LC_ALL=C makes sed and awk pass UTF-8 bytes through untouched.
json_string() {
  _tab=$(printf '\t')
  tr -d '\000-\010\013\014\015\016-\037' |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$_tab/\\\\t/g" |
    awk 'BEGIN { printf "\"" } NR > 1 { printf "%s", "\\n" } { printf "%s", $0 } END { printf "\"" }'
}

# emit: read the context text on stdin and print the hook's JSON output.
emit() {
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":' "$event"
  json_string
  printf '}}\n'
}

need() {
  if [ ! -f "$1" ]; then
    echo "inject-instructions: missing $1" >&2
    exit 1
  fi
}

case $part in
  common)
    need "$instructions/COMMON-CLAUDE.md"
    native_common && exit 0
    {
      printf '%s\n' "<!-- craig-core: CLAUDE.md, Craig's global instructions (injected because ~/.claude/CLAUDE.md does not load them here) -->"
      cat "$instructions/COMMON-CLAUDE.md"
    } | emit
    ;;
  role)
    need "$instructions/$role_file"
    {
      printf '%s\n' "<!-- craig-core: $role_file -->"
      cat "$instructions/$role_file"
      printf '\n'
      availability
    } | emit
    ;;
  project)
    dir=${CLAUDE_PROJECT_DIR:-}
    if [ -z "$dir" ]; then
      # The hook input JSON always carries "cwd". Plain sed instead of jq: a
      # project path containing a double quote or backslash is not supported.
      dir=$(printf '%s\n' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    fi
    [ -n "$dir" ] || exit 0
    file=$dir/.claude/$role_file
    [ -f "$file" ] || exit 0
    # Never repeat the plugin's own file if a project links to it.
    if _pf=$(resolve "$file") && _of=$(resolve "$instructions/$role_file") && [ "$_pf" = "$_of" ]; then
      exit 0
    fi
    {
      printf '%s\n' "<!-- source: $file -->"
      cat "$file"
    } | emit
    ;;
  *)
    echo "inject-instructions: unknown part '$part'" >&2
    exit 1
    ;;
esac
exit 0

#!/bin/sh
# generic-dev: inject instructions/CODING.md at SessionStart and SubagentStart.
#
# Usage: inject-coding.sh <SessionStart|SubagentStart>
#
# POSIX sh only; no jq. Prints nothing (exit 0) when CODING.md is missing. The
# JSON string escaping matches craig-core's inject-instructions.sh.

set -u
LC_ALL=C
export LC_ALL

event=${1:-}
case $event in
  SessionStart | SubagentStart) ;;
  *)
    echo "inject-coding: unknown event '$event'" >&2
    exit 1
    ;;
esac

# Drain the hook input JSON so Claude Code never writes into a closed pipe.
cat >/dev/null 2>&1 || true

root=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$root" ]; then
  root=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd) || exit 0
fi
file=$root/instructions/CODING.md
[ -f "$file" ] || exit 0

# Read text on stdin and print it as one JSON string literal. Control
# characters other than tab and newline are dropped (CR included); backslash,
# double quote and tab are escaped; lines are joined with \n.
json_string() {
  _tab=$(printf '\t')
  tr -d '\000-\010\013\014\015\016-\037' |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$_tab/\\\\t/g" |
    awk 'BEGIN { printf "\"" } NR > 1 { printf "%s", "\\n" } { printf "%s", $0 } END { printf "\"" }'
}

printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":' "$event"
{
  printf '%s\n' "<!-- generic-dev: CODING.md -->"
  cat "$file"
} | json_string
printf '}}\n'
exit 0

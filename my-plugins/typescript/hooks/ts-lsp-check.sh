#!/bin/sh
# typescript: SessionStart check of the TypeScript language server choice.
#
# Runs `bin/ts-lsp --explain` (the same resolution the launcher execs) and stays
# silent when the server the project's package.json declares was found. When a fallback or no server
# was chosen it prints one SessionStart JSON object: `systemMessage` shows the
# text to the user in the terminal, and `additionalContext` gives Claude the same
# text so it can explain odd diagnostics.
#
# POSIX sh only; no jq. Always exits 0 so a failure here never breaks the session.

set -u
LC_ALL=C
export LC_ALL

# Performance: this runs at every session start, so it spawns as few processes
# as it can (each costs a fork): the shell itself drains stdin, finds its own
# directory and splits the launcher's output.

# Drain the hook input JSON so Claude Code never writes into a closed pipe.
while IFS= read -r _line || [ -n "$_line" ]; do :; done 2>/dev/null

root=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$root" ]; then
  here=${0%/*}
  [ "$here" != "$0" ] || here=.
  root=$(cd "$here/.." 2>/dev/null && pwd) || exit 0
fi
launcher=$root/bin/ts-lsp
[ -f "$launcher" ] || exit 0

out=$(sh "$launcher" --explain 2>/dev/null </dev/null) || exit 0

# The first line of the output that starts with KEY= gives that field.
matched=
kind=
reason=
hint=
command=
nl='
'
set -f
IFS=$nl
for _line in $out; do
  case $_line in
    matched=*) [ -n "$matched" ] || matched=${_line#matched=} ;;
    kind=*) [ -n "$kind" ] || kind=${_line#kind=} ;;
    reason=*) [ -n "$reason" ] || reason=${_line#reason=} ;;
    hint=*) [ -n "$hint" ] || hint=${_line#hint=} ;;
    command=*) [ -n "$command" ] || command=${_line#command=} ;;
  esac
done
set +f
unset IFS

# Only a definite matched=no speaks; a missing or odd answer stays silent.
[ "$matched" = no ] || exit 0

if [ "$kind" = none ]; then
  msg="TypeScript LSP unavailable: $reason. To fix it, in the project: $hint."
else
  msg="TypeScript LSP is using a fallback ($kind: $command), not the server the project declares. Why: $reason. To get the declared server, in the project: $hint."
fi

# Print $1 as one JSON string literal: control characters are dropped, backslash
# and double quote are escaped.
json_string() {
  printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

js=$(json_string "$msg") # both fields carry the same text, so encode it once
printf '{"systemMessage":%s,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' \
  "$js" "$js"
exit 0

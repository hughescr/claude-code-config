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

# Drain the hook input JSON so Claude Code never writes into a closed pipe.
cat >/dev/null 2>&1 || true

root=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$root" ]; then
  root=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd) || exit 0
fi
launcher=$root/bin/ts-lsp
[ -f "$launcher" ] || exit 0

out=$(sh "$launcher" --explain 2>/dev/null </dev/null) || exit 0

field() {
  printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1
}

# Only a definite matched=no speaks; a missing or odd answer stays silent.
[ "$(field matched)" = no ] || exit 0

kind=$(field kind)
reason=$(field reason)
hint=$(field hint)
command=$(field command)

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

printf '{"systemMessage":%s,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' \
  "$(json_string "$msg")" "$(json_string "$msg")"
exit 0

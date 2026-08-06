#!/bin/bash
# Only allow mktemp and codex-*.sh scripts.
# The command is split on shell separators (;, &&, ||, |, newline) and EVERY
# subcommand must anchor-match the allowlist — a substring match would let
# e.g. `rm -rf ~; echo codex-start.sh` through.
INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || COMMAND=""

deny() {
  cat << 'DECISION'
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Codex agent can only run mktemp and codex-*.sh scripts. You are a relay - don't explore the codebase yourself."}}
DECISION
  exit 0
}

[ -z "$COMMAND" ] && deny

# Split into subcommands on ; && || | and newlines
SUBCOMMANDS=$(printf '%s' "$COMMAND" | awk '{gsub(/\|\||&&|;|\|/, "\n"); print}')

checked_any=false
while IFS= read -r sub; do
  # Trim leading/trailing whitespace
  sub="${sub#"${sub%%[![:space:]]*}"}"
  sub="${sub%"${sub##*[![:space:]]}"}"
  [ -z "$sub" ] && continue
  checked_any=true

  # Command/process substitution can smuggle arbitrary execution into an
  # otherwise-allowed subcommand
  if [[ "$sub" == *'$('* ]] || [[ "$sub" == *'`'* ]] || [[ "$sub" == *'<('* ]] || [[ "$sub" == *'>('* ]]; then
    deny
  fi

  # Allow: mktemp /tmp/claude/codex-query.* (also /private/tmp, the macOS
  # canonical alias)
  if [[ "$sub" =~ ^mktemp[[:space:]]+(/private)?/tmp/claude/codex-query ]]; then
    continue
  fi

  # Allow: codex wrapper scripts (must be the command itself, not an argument)
  if [[ "$sub" =~ ^[^[:space:]]*codex-(start|wait|get-session-id)\.sh([[:space:]]|$) ]]; then
    continue
  fi

  deny
done <<< "$SUBCOMMANDS"

# Whitespace/separator-only commands match nothing — treat as not allowed
[ "$checked_any" = false ] && deny

echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
exit 0

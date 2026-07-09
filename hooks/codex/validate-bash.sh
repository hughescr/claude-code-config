#!/bin/bash
# Only allow mktemp and codex-*.sh scripts
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || COMMAND=""

# Allow: mktemp /tmp/claude/codex-query.*
if [[ "$COMMAND" =~ ^mktemp[[:space:]]+/tmp/claude/codex-query ]]; then
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
fi

# Allow: codex wrapper scripts
if [[ "$COMMAND" =~ codex-start\.sh ]] || \
   [[ "$COMMAND" =~ codex-wait\.sh ]] || \
   [[ "$COMMAND" =~ codex-get-session-id\.sh ]]; then
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
fi

# Block everything else (structured deny on stdout; exit 0 carries the decision)
cat << 'DECISION'
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Codex agent can only run mktemp and codex-*.sh scripts. You are a relay - don't explore the codebase yourself."}}
DECISION
exit 0

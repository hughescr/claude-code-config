#!/bin/bash
# Only allow mktemp and codex-*.sh scripts
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Allow: mktemp /tmp/claude/codex-query.*
if [[ "$COMMAND" =~ ^mktemp[[:space:]]+/tmp/claude/codex-query ]]; then
  echo '{"hookSpecificOutput": {"permissionDecision": "allow"}}'
  exit 0
fi

# Allow: codex wrapper scripts
if [[ "$COMMAND" =~ codex-start\.sh ]] || \
   [[ "$COMMAND" =~ codex-wait\.sh ]] || \
   [[ "$COMMAND" =~ codex-get-session-id\.sh ]]; then
  echo '{"hookSpecificOutput": {"permissionDecision": "allow"}}'
  exit 0
fi

# Block everything else
cat >&2 << 'EOF'
{"decision": "block", "reason": "Codex agent can only run mktemp and codex-*.sh scripts. You are a relay - don't explore the codebase yourself."}
EOF
exit 2

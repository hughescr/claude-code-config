#!/bin/bash
# Block Write calls that don't match allowed codex patterns
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || FILE_PATH=""

# Allow: /tmp/claude/codex-query.* (query files)
if [[ "$FILE_PATH" =~ ^/tmp/claude/codex-query\. ]]; then
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
fi

# Block with explanation (structured deny on stdout; exit 0 carries the decision)
cat << 'DECISION'
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Codex agent can only write to /tmp/claude/codex-query.* files."}}
DECISION
exit 0

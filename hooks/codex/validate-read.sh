#!/bin/bash
# Block Read calls that don't match allowed codex patterns
INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || FILE_PATH=""

# A `..` path segment can traverse out of the allowed prefix
# (e.g. /tmp/claude/codex-query.x/../../../etc/passwd), so never allow it
if ! [[ "$FILE_PATH" =~ (^|/)\.\.(/|$) ]] &&
# Allow: /tmp/claude/codex-query.* (query files; /private/tmp is the macOS
# canonical alias for /tmp)
   [[ "$FILE_PATH" =~ ^(/private)?/tmp/claude/codex-query\. ]]; then
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
fi

# Block with explanation (structured deny on stdout; exit 0 carries the decision)
cat << 'DECISION'
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Codex agent can only read /tmp/claude/codex-query.* files. You are a relay - pass the query to Codex, don't read source files yourself."}}
DECISION
exit 0

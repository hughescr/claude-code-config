#!/bin/bash
# Block Write calls that don't match allowed codex patterns
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Allow: /tmp/claude/codex-query.* (query files)
if [[ "$FILE_PATH" =~ ^/tmp/claude/codex-query\. ]]; then
  exit 0  # Allow
fi

# Block with explanation
cat >&2 << 'EOF'
{"decision": "block", "reason": "Codex agent can only write to /tmp/claude/codex-query.* files."}
EOF
exit 2

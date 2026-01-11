#!/bin/bash
# Auto-approve bash commands that run the expected codex CLI pattern

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Match the expected pattern:
#   codex exec [flags in any order] "<prompt>"
#
# Required components (in any order after 'codex exec'):
#   - --full-auto
#   - --json
#   - -C <directory>
#
# Optionally followed by: resume <session-id>
# Ends with the prompt (quoted or unquoted)

# Check if it starts with 'codex exec'
if [[ "$command" =~ ^codex[[:space:]]+exec[[:space:]] ]]; then
  # Check for all required flags (order-independent)
  if [[ "$command" =~ --full-auto ]] && \
     [[ "$command" =~ --json ]] && \
     [[ "$command" =~ -C[[:space:]] ]]; then
    # Auto-approve codex exec commands with the expected flags
    echo '{"hookSpecificOutput": {"permissionDecision": "allow"}}' >&2
    exit 2
  fi
fi

# For all other commands, don't interfere (let normal permission flow happen)
exit 0

#!/bin/bash
# ============================================================================
# PreToolUse Hook Return Semantics
# Docs: https://docs.anthropic.com/en/docs/claude-code/hooks
# ============================================================================
#
# Exit Code | Stream  | Behavior
# ----------|---------|----------------------------------------------------------
# 0         | stdout  | Success - tool proceeds. If stdout contains JSON with
#           |         | {"hookSpecificOutput": {"permissionDecision": "allow"}},
#           |         | the tool runs without user permission prompt.
#           |         | Empty stdout = no opinion, normal permission flow.
# ----------|---------|----------------------------------------------------------
# 2         | stderr  | Decision provided - Claude reads stderr for JSON:
#           |         | {"hookSpecificOutput": {"permissionDecision": "deny|ask"},
#           |         |  "systemMessage": "explanation for Claude"}
#           |         | "deny" = block the tool, "ask" = prompt user
# ----------|---------|----------------------------------------------------------
# other     | stderr  | Error - shown to user only, Claude unaware, tool proceeds
# ============================================================================

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
    echo '{"hookSpecificOutput": {"permissionDecision": "allow"}}'
    exit 0
  fi
fi

# For all other commands, don't interfere (let normal permission flow happen)
exit 0

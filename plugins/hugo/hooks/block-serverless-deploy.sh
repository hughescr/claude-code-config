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

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Block serverless deploy commands
if [[ "$command" =~ serverless[[:space:]]+deploy ]] || [[ "$command" =~ sls[[:space:]]+deploy ]]; then
  cat << 'MSG' >&2
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny"}, "systemMessage": "BLOCKED: Manual serverless deploy is prohibited.\n\nDeployment workflow:\n1. Commit changes: git add . && git commit -m 'description'\n2. Push to trigger CI: git push origin develop\n3. Monitor GitHub Actions for deployment status\n\nThe CI pipeline handles Hugo build, S3 sync, and CloudFront invalidation automatically."}
MSG
  exit 2
fi

exit 0

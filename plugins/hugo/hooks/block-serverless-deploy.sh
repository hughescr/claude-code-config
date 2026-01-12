#!/bin/bash
input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Block serverless deploy commands
if [[ "$command" =~ serverless[[:space:]]+deploy ]] || [[ "$command" =~ sls[[:space:]]+deploy ]]; then
  cat << 'MSG'
{"hookSpecificOutput": {"permissionDecision": "deny"}, "systemMessage": "BLOCKED: Manual serverless deploy is prohibited.\n\nDeployment workflow:\n1. Commit changes: git add . && git commit -m 'description'\n2. Push to trigger CI: git push origin develop\n3. Monitor GitHub Actions for deployment status\n\nThe CI pipeline handles Hugo build, S3 sync, and CloudFront invalidation automatically."}
MSG
  exit 0
fi

exit 0

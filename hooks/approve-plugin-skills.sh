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
# 2         | stderr  | BLOCKING ERROR - the tool call is DENIED and stderr is
#           |         | fed back to Claude. Do NOT use for passthrough.
# ----------|---------|----------------------------------------------------------
# other     | stderr  | Non-blocking error - shown to user, tool proceeds via
#           |         | normal permission flow.
# ============================================================================

# Hook: Approve skills from known/installed plugins
# Returns: approve decision for known plugins; exit 0 with empty stdout
# (no opinion) for everything else, so normal permissions apply

set -euo pipefail

input=$(cat)
skill_full=$(echo "$input" | jq -r '.tool_input.skill // empty')

if [ -z "$skill_full" ]; then
  # No skill specified, passthrough (empty stdout = no opinion)
  exit 0
fi

# Extract plugin name (before the colon, or the whole thing if no colon)
if [[ "$skill_full" == *":"* ]]; then
  plugin_name="${skill_full%%:*}"
else
  # No colon - this is a simple skill name, not plugin-qualified
  # Passthrough to let normal permissions handle it (empty stdout = no opinion)
  exit 0
fi

# Check if this plugin exists in known locations:
# 1. User's authored plugins: ~/.claude/plugins/<plugin_name>/
# 2. Cached plugins: ~/.claude/plugins/cache/<marketplace>/<plugin_name>/

found=false

# Check authored plugins (direct subdirectories, excluding cache)
if [ -d "$HOME/.claude/plugins/$plugin_name" ] && [ "$plugin_name" != "cache" ]; then
  found=true
fi

# Check cached plugins from any marketplace
if [ "$found" = false ]; then
  for marketplace_dir in "$HOME/.claude/plugins/cache"/*/; do
    if [ -d "${marketplace_dir}${plugin_name}" ]; then
      found=true
      break
    fi
  done
fi

if [ "$found" = true ]; then
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
else
  # Unknown plugin, passthrough to normal permission system (empty stdout = no opinion)
  exit 0
fi

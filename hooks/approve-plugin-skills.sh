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
# jq parse failure = no opinion, not a block (set -e would otherwise exit 2)
skill_full=$(echo "$input" | jq -r '.tool_input.skill // empty' 2>/dev/null) || exit 0

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

# Sanitize the extracted plugin name: it is interpolated into filesystem
# paths below, so anything but a single path-safe token (no slashes, no
# dot segments, nothing outside [A-Za-z0-9_-]) gets no opinion from this hook.
if [[ ! "$plugin_name" =~ ^[A-Za-z0-9_-]+$ ]]; then
  exit 0
fi

# Auto-approve only plugins Craig authored/installed himself:
# 1. Post-migration home: ~/.claude/my-plugins/<plugin_name>/
# 2. Transitional legacy location: ~/.claude/plugins/<plugin_name>/
#    (direct subdirectories only, excluding infrastructure dirs)
# Marketplace/cache dirs (~/.claude/plugins/cache, ~/.claude/plugins/
# marketplaces) are NOT approval evidence — a skill whose plugin exists
# only there falls through to a normal permission prompt.

found=false

if [ -d "$HOME/.claude/my-plugins/$plugin_name" ]; then
  found=true
elif [ -d "$HOME/.claude/plugins/$plugin_name" ]; then
  case "$plugin_name" in
    cache|marketplaces|repos|data) : ;; # infrastructure dirs, not plugins
    *) found=true ;;
  esac
fi

if [ "$found" = true ]; then
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
else
  # Unknown plugin, passthrough to normal permission system (empty stdout = no opinion)
  exit 0
fi

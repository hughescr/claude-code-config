#!/bin/bash
# Hook: Approve skills from known/installed plugins
# Returns: approve decision for known plugins, exit 2 for passthrough

set -euo pipefail

input=$(cat)
skill_full=$(echo "$input" | jq -r '.tool_input.skill // empty')

if [ -z "$skill_full" ]; then
  # No skill specified, passthrough
  exit 2
fi

# Extract plugin name (before the colon, or the whole thing if no colon)
if [[ "$skill_full" == *":"* ]]; then
  plugin_name="${skill_full%%:*}"
else
  # No colon - this is a simple skill name, not plugin-qualified
  # Passthrough to let normal permissions handle it
  exit 2
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
  echo '{"decision": "approve"}'
  exit 0
else
  # Unknown plugin, passthrough to normal permission system
  exit 2
fi

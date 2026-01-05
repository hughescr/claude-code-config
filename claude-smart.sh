#!/usr/bin/env zsh
# Smart Claude wrapper with project detection and mixin support
# Loads plugin directories and their .mcp.json configs
#
# Mixins can be specified via:
#   1. CLAUDE_MIXINS env var (comma or space separated): CLAUDE_MIXINS="web,mobile"
#   2. .claude-mixins file in project root (one per line, # for comments)
#
# Priority: env var > marker file
# Priority for mixin plugins: ./.claude/ > ~/.claude/
# Auto-detected: typescript (via tsconfig.json or package.json)

set -euo pipefail

# Build up a set of plugin directories to load
PLUGIN_DIRS=()

# Detect TypeScript project
if [[ -f "tsconfig.json" ]] || \
   { [[ -f "package.json" ]] && command -v jq &>/dev/null && \
     jq -e '.devDependencies.typescript // .dependencies.typescript' package.json &>/dev/null 2>&1; }; then

    [[ -d ~/.claude/plugins/typescript ]] && PLUGIN_DIRS+=(~/.claude/plugins/typescript)
fi

# Detect and apply mixins (env var takes priority over marker file)
MIXINS=()
if [[ -n "${CLAUDE_MIXINS:-}" ]]; then
    # Parse from environment variable (comma or space separated)
    IFS=', ' read -rA MIXINS <<< "$CLAUDE_MIXINS"
elif [[ -f ".claude-mixins" ]]; then
    # Parse from marker file (one per line, skip comments and blank lines)
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Strip leading/trailing whitespace and skip comments/blank lines
        line="${line%%\#*}"  # Remove comments
        line="${line## }"     # Remove leading spaces
        line="${line%% }"     # Remove trailing spaces
        [[ -n "$line" ]] && MIXINS+=("$line")
    done < .claude-mixins
fi

# Add mixin plugin directories if they exist (local .claude/plugins takes priority over ~/.claude/plugins)
for mixin in "${MIXINS[@]}"; do
    if [[ -d "./.claude/plugins/${mixin}" ]]; then
        PLUGIN_DIRS+=("./.claude/plugins/${mixin}")
    elif [[ -d ~/.claude/plugins/${mixin} ]]; then
        PLUGIN_DIRS+=(~/.claude/plugins/${mixin})
    fi
done

# Prepare flags array
CLAUDE_FLAGS=()

# Add plugin directories
for dir in "${PLUGIN_DIRS[@]}"; do
    [[ -d "$dir" ]] && CLAUDE_FLAGS+=(--plugin-dir "$dir")
done

# Collect MCP configs from plugin directories
MCP_CONFIGS=()
for dir in "${PLUGIN_DIRS[@]}"; do
    [[ -f "$dir/.mcp.json" ]] && MCP_CONFIGS+=("$dir/.mcp.json")
done

# Execute via bunx (always fetch latest)
# Don't use exec so trap cleanup can run
bunx --smol --bun @anthropic-ai/claude-code@latest "${CLAUDE_FLAGS[@]}" "$@"

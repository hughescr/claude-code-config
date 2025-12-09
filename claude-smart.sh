#!/usr/bin/env zsh
# Smart Claude wrapper with project detection and mixin support
# Merges base and project-specific MCP configs and agents
#
# Mixins can be specified via:
#   1. CLAUDE_MIXINS env var (comma or space separated): CLAUDE_MIXINS="web,mobile"
#   2. .claude-mixins file in project root (one per line, # for comments)
#
# Priority: env var > marker file
# Priority for mixin configs: ./.claude/ > ~/.claude/
# Auto-detected: typescript (via tsconfig.json or package.json)

set -euo pipefail

# Base configs (always included)
MCP_FILES=(~/.claude/mcp-base.json)
AGENT_FILES=(~/.claude/agents-base.json)

# Detect TypeScript project
if [[ -f "tsconfig.json" ]] || \
   { [[ -f "package.json" ]] && command -v jq &>/dev/null && \
     jq -e '.devDependencies.typescript // .dependencies.typescript' package.json &>/dev/null 2>&1; }; then

    [[ -f ~/.claude/mcp-typescript.json ]] && MCP_FILES+=(~/.claude/mcp-typescript.json)
    [[ -f ~/.claude/agents-typescript.json ]] && AGENT_FILES+=(~/.claude/agents-typescript.json)
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

# Add mixin configs if they exist (local .claude/ takes priority over ~/.claude/)
for mixin in "${MIXINS[@]}"; do
    # MCP config: local .claude/ takes priority over ~/.claude/
    if [[ -f "./.claude/mcp-${mixin}.json" ]]; then
        MCP_FILES+=("./.claude/mcp-${mixin}.json")
    elif [[ -f ~/.claude/mcp-${mixin}.json ]]; then
        MCP_FILES+=(~/.claude/mcp-${mixin}.json)
    fi

    # Agents config: local .claude/ takes priority over ~/.claude/
    if [[ -f "./.claude/agents-${mixin}.json" ]]; then
        AGENT_FILES+=("./.claude/agents-${mixin}.json")
    elif [[ -f ~/.claude/agents-${mixin}.json ]]; then
        AGENT_FILES+=(~/.claude/agents-${mixin}.json)
    fi
done

# Prepare flags array
CLAUDE_FLAGS=()

# Merge and pass MCP configs via temporary file
if [[ ${#MCP_FILES[@]} -gt 0 ]] && command -v jq &>/dev/null; then
    EXISTING_MCP=()
    for f in "${MCP_FILES[@]}"; do
        [[ -f "$f" ]] && EXISTING_MCP+=("$f")
    done

    if [[ ${#EXISTING_MCP[@]} -gt 0 ]]; then
        # Create temporary file for merged MCP config
        # Later configs override earlier ones for the same server name
        MCP_TEMP=$(mktemp /tmp/claude-code-mcp.XXXXXXXX)
        trap "rm -f '$MCP_TEMP'" EXIT
        jq -sc 'reduce .[] as $item ({}; . * $item)' "${EXISTING_MCP[@]}" > "$MCP_TEMP"
        CLAUDE_FLAGS+=(--mcp-config "$MCP_TEMP")
    fi
fi

# Merge and pass agent configs
if [[ ${#AGENT_FILES[@]} -gt 0 ]] && command -v jq &>/dev/null; then
    EXISTING_AGENTS=()
    for f in "${AGENT_FILES[@]}"; do
        [[ -f "$f" ]] && EXISTING_AGENTS+=("$f")
    done

    if [[ ${#EXISTING_AGENTS[@]} -gt 0 ]]; then
        MERGED_JSON=$(jq -sc 'reduce .[] as $item ({}; . * $item)' "${EXISTING_AGENTS[@]}")
        [[ "$MERGED_JSON" != "{}" ]] && CLAUDE_FLAGS+=(--agents "$MERGED_JSON")
    fi
fi

# Execute via bunx (always fetch latest)
# Don't use exec so trap cleanup can run
bunx --bun @anthropic-ai/claude-code@latest "${CLAUDE_FLAGS[@]}" "$@"

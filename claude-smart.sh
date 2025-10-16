#!/usr/bin/env zsh
# Smart Claude wrapper with TypeScript project detection
# Merges base and project-specific MCP configs and agents

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
        jq -s 'reduce .[] as $item ({}; . * $item)' "${EXISTING_MCP[@]}" > "$MCP_TEMP"
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
        MERGED_AGENTS=$(jq -s 'reduce .[] as $item ({}; . * $item)' "${EXISTING_AGENTS[@]}")
        [[ "$MERGED_AGENTS" != "{}" ]] && CLAUDE_FLAGS+=(--agents "$MERGED_AGENTS")
    fi
fi

# Execute via bunx (always fetch latest)
# Don't use exec so trap cleanup can run
bunx --bun @anthropic-ai/claude-code@latest "${CLAUDE_FLAGS[@]}" "$@"

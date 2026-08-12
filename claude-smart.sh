#!/usr/bin/env zsh
# Smart Claude wrapper with project detection and mixin support
# Loads plugin directories and their .mcp.json configs
#
# Mixins can be specified via:
#   1. CLAUDE_MIXINS env var (comma or space separated): CLAUDE_MIXINS="web,mobile"
#   2. .claude-mixins file in project root (one per line, # for comments)
#
# Priority: env var > marker file
# Priority for mixin plugins: ./.claude/plugins/ > ~/.claude/my-plugins/
# Auto-detected: javascript (via package.json), typescript (via tsconfig.json or package.json),
#                hugo (via hugo.toml or config.toml with Hugo directories)
#
# Launches the natively installed claude binary.

set -euo pipefail

# Native claude binary (native installer)
CLAUDE_BIN="$HOME/.local/bin/claude"
if [[ ! -x "$CLAUDE_BIN" ]]; then
    echo "claude-smart: claude binary not found at $CLAUDE_BIN" >&2
    echo "claude-smart: install with: curl -fsSL https://claude.ai/install.sh | bash" >&2
    exit 1
fi

# Build up a set of plugin directories to load
PLUGIN_DIRS=()

# Detect project type
has_package_json=false
[[ -f "package.json" ]] && has_package_json=true

is_typescript=false
if [[ -f "tsconfig.json" ]]; then
    is_typescript=true
elif [[ "$has_package_json" == "true" ]] && command -v jq &>/dev/null; then
    if jq -e '.devDependencies.typescript // .dependencies.typescript' package.json &>/dev/null 2>&1; then
        is_typescript=true
    fi
fi

# Check for Hugo project
has_hugo_config="false"
if [[ -f "hugo.toml" ]] || [[ -f "hugo/hugo.toml" ]] || [[ -f "config/_default/hugo.toml" ]]; then
    has_hugo_config="true"
fi

# Load plugins based on detection (order matters: generic → hugo → js → ts)
if [[ "$has_package_json" == "true" ]]; then
    [[ -d ~/.claude/my-plugins/generic-dev ]] && PLUGIN_DIRS+=(~/.claude/my-plugins/generic-dev)
fi

# Load Hugo plugin if Hugo config detected
if [[ "$has_hugo_config" == "true" ]]; then
    [[ -d ~/.claude/my-plugins/hugo ]] && PLUGIN_DIRS+=(~/.claude/my-plugins/hugo)
fi

if [[ "$has_package_json" == "true" ]]; then
    [[ -d ~/.claude/my-plugins/javascript ]] && PLUGIN_DIRS+=(~/.claude/my-plugins/javascript)

    if [[ "$is_typescript" == "true" ]]; then
        [[ -d ~/.claude/my-plugins/typescript ]] && PLUGIN_DIRS+=(~/.claude/my-plugins/typescript)
    fi
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

# Add mixin plugin directories if they exist (local .claude/plugins takes priority over ~/.claude/my-plugins)
for mixin in "${MIXINS[@]}"; do
    if [[ -d "./.claude/plugins/${mixin}" ]]; then
        PLUGIN_DIRS+=("./.claude/plugins/${mixin}")
    elif [[ -d ~/.claude/my-plugins/${mixin} ]]; then
        PLUGIN_DIRS+=(~/.claude/my-plugins/${mixin})
    fi
done

# Prepare flags array
CLAUDE_FLAGS=()

# Add plugin directories
for dir in "${PLUGIN_DIRS[@]}"; do
    [[ -d "$dir" ]] && CLAUDE_FLAGS+=(--plugin-dir "$dir")
done

# Launch the native binary
exec "$CLAUDE_BIN" "${CLAUDE_FLAGS[@]}" "$@"

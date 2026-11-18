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
# Auto-detected from the current directory only (no subdirectory scan):
#   generic-dev: any code-project marker: package.json, tsconfig.json, Cargo.toml, go.mod,
#                Package.swift, *.xcodeproj, CMakeLists.txt, compile_commands.json,
#                pyproject.toml, deno.json, bunfig.toml (not Makefile: prose projects have them)
#   javascript:  ./package.json
#   typescript:  ./tsconfig.json, or a typescript dependency in ./package.json (needs jq)
#   hugo:        ./hugo.toml, ./hugo/hugo.toml, ./config/_default/hugo.toml or
#                ./config/_default/config.toml
# When claude is started in a parent directory of the real project, put a .claude-mixins file
# there (one plugin name per line, for example generic-dev) to load the plugins.
# Duplicate plugin directories (for example a generic-dev mixin) are loaded once.
#
# CLAUDE_SMART_DRY_RUN=1 prints the plugin directories, one per line, and exits without
# running claude (the binary need not exist).
#
# Launches the natively installed claude binary.

set -euo pipefail

# Plugin directories to load, without duplicates (first occurrence wins)
typeset -U PLUGIN_DIRS
PLUGIN_DIRS=()

has_package_json=false
[[ -f package.json ]] && has_package_json=true

is_typescript=false
if [[ -f tsconfig.json ]]; then
    is_typescript=true
elif [[ "$has_package_json" == "true" ]] && command -v jq &>/dev/null; then
    # Unparsable JSON just means "not detected"
    if jq -e '.devDependencies.typescript // .dependencies.typescript // empty' package.json &>/dev/null; then
        is_typescript=true
    fi
fi

# Any code-project marker; the *.xcodeproj glob matches directories only and is empty (not an error) with no match
xcodeprojs=(*.xcodeproj(N/))
is_code_project=false
if [[ "$has_package_json" == "true" || -f tsconfig.json || -f Cargo.toml || -f go.mod \
    || -f Package.swift || -f CMakeLists.txt || -f compile_commands.json \
    || -f pyproject.toml || -f deno.json || -f bunfig.toml ]] || (( ${#xcodeprojs} )); then
    is_code_project=true
fi

# Check for Hugo project
has_hugo_config="false"
if [[ -f "hugo.toml" ]] || [[ -f "hugo/hugo.toml" ]] || [[ -f "config/_default/hugo.toml" ]] || [[ -f "config/_default/config.toml" ]]; then
    has_hugo_config="true"
fi

# Load plugins based on detection (order matters: generic → hugo → js → ts)
if [[ "$is_code_project" == "true" ]]; then
    [[ -d ~/.claude/my-plugins/generic-dev ]] && PLUGIN_DIRS+=(~/.claude/my-plugins/generic-dev)
fi

# Load Hugo plugin if Hugo config detected
if [[ "$has_hugo_config" == "true" ]]; then
    [[ -d ~/.claude/my-plugins/hugo ]] && PLUGIN_DIRS+=(~/.claude/my-plugins/hugo)
fi

if [[ "$has_package_json" == "true" ]]; then
    [[ -d ~/.claude/my-plugins/javascript ]] && PLUGIN_DIRS+=(~/.claude/my-plugins/javascript)
fi

if [[ "$is_typescript" == "true" ]]; then
    [[ -d ~/.claude/my-plugins/typescript ]] && PLUGIN_DIRS+=(~/.claude/my-plugins/typescript)
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

# Dry run for tests: print the plugin directories that would be loaded and stop
if [[ "${CLAUDE_SMART_DRY_RUN:-}" == "1" ]]; then
    (( ${#CLAUDE_FLAGS} )) && printf '%s\n' "${(@)CLAUDE_FLAGS:#--plugin-dir}"
    exit 0
fi

# Native claude binary (native installer)
CLAUDE_BIN="$HOME/.local/bin/claude"
if [[ ! -x "$CLAUDE_BIN" ]]; then
    echo "claude-smart: claude binary not found at $CLAUDE_BIN" >&2
    echo "claude-smart: install with: curl -fsSL https://claude.ai/install.sh | bash" >&2
    exit 1
fi

# Route through the local utraque proxy when it is healthy, so Claude models bill
# the Max subscription and gpt-* routes reach OpenAI on the Codex subscription.
# If the proxy is not answering, leave the variables unset: Claude Code then talks
# to api.anthropic.com directly, exactly as it did before utraque existed.
if curl -sf --max-time 1 http://127.0.0.1:8317/healthz >/dev/null 2>&1; then
    export ANTHROPIC_BASE_URL="http://127.0.0.1:8317"
    export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
    # A non-api.anthropic.com base URL makes Claude Code treat every model as
    # third-party, which drops claude-* models from their true 1M window to the
    # 200000 default and can trap a long session in an auto-compact loop. This
    # variable restores native window detection from the built-in model table.
    export _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1
    # Only applies to models whose name does not start with "claude-", so this
    # sizes the gpt-* routes and never touches the Claude models above. 828000
    # is the Codex catalog's max_context_window (872000) less the 5% margin the
    # Codex CLI keeps; the backend accepted 800k-token prompts on gpt-6-luna.
    # Above 272k input the API prices a request at 2x, so long GPT sessions
    # probably drain the Codex allowance faster, most of all on astra.
    export CLAUDE_CODE_MAX_CONTEXT_TOKENS=828000
fi

# Launch the native binary
exec "$CLAUDE_BIN" "${CLAUDE_FLAGS[@]}" "$@"

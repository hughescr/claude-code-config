# Claude Code Configuration

Personal Claude Code configuration with plugin-based architecture, custom hooks, and orchestrator-mode workflow.

## Features

- **Plugin System**: Modular plugins containing agents, skills, hooks, and commands
- **Orchestrator Mode**: CLAUDE.md configures Claude as a delegating orchestrator that spawns sub-agents for all implementation work — launched **async** (in the background, so you stay interactive while they work), with a **Workflow engine** for large, opted-in, programmatically-enforced fan-out
- **Custom Hooks**: PreToolUse, SessionEnd, and Notification hooks for workflow automation
- **Marketplace Integration**: This repo doubles as a local plugin marketplace; plugins are *available* everywhere, *enabled* per project
- **Submodule Support**: Some skills are managed as git submodules from external repos

## Installing via marketplace

```
/plugin marketplace add hughescr/claude-code-config
/plugin install resin-print-prep@craigs-claude-plugins
```

The marketplace manifest lives at `.claude-plugin/marketplace.json` and lists every plugin in `my-plugins/`.

Locally, `settings.json` registers this directory itself as the `craigs-claude-plugins`
marketplace (a `directory` source in `extraKnownMarketplaces`). That makes every plugin
**available but not enabled**: nothing loads globally by default. Going forward, a project
opts in with a per-project `enabledPlugins` entry (e.g. `"hugo@craigs-claude-plugins": true`
in the project's `.claude/settings.json`), which replaces the `.claude-mixins` mechanism —
though `.claude-mixins` files are still honored by the `claude-smart.sh` shim.

## Plugin Structure

Plugins live in `my-plugins/` and can contain:

```
my-plugins/<plugin-name>/
├── .claude-plugin/     # Plugin metadata
├── agents/             # Specialized agent configurations
├── commands/           # Custom slash commands
├── hooks/              # PreToolUse/PostToolUse hooks
├── skills/             # Invokable skills
└── README.md           # Plugin documentation
```

Current plugins:
- **generic-dev** - General development agents and skills
- **hugo** - Hugo static site generator support (agents, commands, hooks, skills)
- **javascript** - JavaScript development agents and skills
- **typescript** - TypeScript hooks and skills
- **duckdb** - DuckDB integration
- **tmux** - Tmux session management
- **resin-print-prep** - Prep 3D meshes for resin printing in Blender (via Blender MCP)

(`plugins/` still exists but holds only Claude Code's own install machinery —
`config.json` and `.install-manifests/` — plus runtime state on the live machine;
no plugin sources live there anymore.)

## Launcher: claude-smart.sh

`claude-smart.sh` is a thin zsh shim around the natively installed binary
(`/opt/homebrew/bin/claude`, npm global install). On each launch it:

1. Detects project shape (package.json / tsconfig.json / Hugo configs) and assembles
   `--plugin-dir` flags for matching plugins in `~/.claude/my-plugins/`
2. Applies mixins from `CLAUDE_MIXINS` env var or a `.claude-mixins` file
   (local `./.claude/plugins/<name>` overrides `~/.claude/my-plugins/<name>`)
3. Runs `claude update` best-effort (60s timeout; offline or failed update never
   blocks launch)
4. `exec`s the native binary with the assembled flags

## Submodule Management

Some skills are git submodules pointing to external repositories (currently `skills/model-selection`). Update commands:

```bash
# Check for updates
git submodule update --remote --dry-run

# Apply updates
git submodule update --remote
```

## Contents

- `CLAUDE.md` - Global instructions (orchestrator mode, async-first delegation & question routing, workflow orchestration, sub-agent restrictions, git operations)
- `settings.json` - Permissions, hooks, model preferences, marketplace registration, enabled plugins
- `my-plugins/` - Plugin sources (agents, skills, hooks, commands) served via the local marketplace
- `claude-smart.sh` - Thin launcher shim (project detection, mixins, update-on-launch)
- `hooks/` - Global hook scripts
- `tests/` - Hook test runner (`tests/hooks-test.sh`)

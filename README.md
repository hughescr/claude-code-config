# Claude Code Configuration

Personal Claude Code configuration with plugin-based architecture, custom hooks, and orchestrator-mode workflow.

## Features

- **Plugin System**: Modular plugins containing agents, skills, hooks, and commands
- **Orchestrator Mode**: CLAUDE.md configures Claude as a delegating orchestrator that spawns sub-agents for implementation work
- **Custom Hooks**: PreToolUse, SessionEnd, and Notification hooks for workflow automation
- **Marketplace Integration**: Install plugins from configured marketplaces
- **Submodule Support**: Some plugins are managed as git submodules from external repos

## Plugin Structure

Plugins live in `plugins/` and can contain:

```
plugins/<plugin-name>/
├── .claude-plugin/     # Plugin metadata
├── agents/             # Specialized agent configurations
├── commands/           # Custom slash commands
├── hooks/              # PreToolUse/PostToolUse hooks
├── skills/             # Invokable skills
└── README.md           # Plugin documentation
```

Current plugins:
- **codex** - Agents, hooks, and skills for code analysis
- **generic-dev** - General development agents and skills
- **hugo** - Hugo static site generator support (agents, commands, hooks, skills)
- **humanizer** - Text humanization skill (external submodule)
- **javascript** - JavaScript development agents and skills
- **typescript** - TypeScript hooks and skills
- **duckdb** - DuckDB integration
- **tmux** - Tmux session management

## Setup

Add this alias to your shell configuration:

```bash
alias claude="claude --mcp-config ~/.claude/mcp.json"
```

## Submodule Management

Some plugins are git submodules pointing to external repositories. See CLAUDE.md for update commands:

```bash
# Check for updates
git submodule update --remote --dry-run

# Apply updates
git submodule update --remote
```

## Contents

- `CLAUDE.md` - Global instructions (orchestrator mode, sub-agent restrictions, git operations)
- `settings.json` - Permissions, hooks, model preferences, enabled marketplace plugins
- `plugins/` - Plugin directory with agents, skills, hooks, and commands
- `hooks/` - Global hook scripts

# Claude Code Configuration

Personal Claude Code configuration with plugin-based architecture, custom hooks, and orchestrator-mode workflow.

## Features

- **Plugin System**: Modular plugins containing agents, skills, hooks, and commands
- **Orchestrator Mode**: CLAUDE.md configures Claude as a delegating orchestrator that spawns sub-agents for all implementation work — launched **async** (in the background, so you stay interactive while they work), with a **Workflow engine** for large, opted-in, programmatically-enforced fan-out
- **Custom Hooks**: PreToolUse, SessionEnd, and Notification hooks for workflow automation
- **Marketplace Integration**: Install plugins from configured marketplaces
- **Submodule Support**: Some plugins are managed as git submodules from external repos

## Installing via marketplace

```
/plugin marketplace add hughescr/claude-code-config
/plugin install resin-print-prep@hughescr
```

The marketplace manifest lives at `.claude-plugin/marketplace.json` and lists every plugin in `plugins/`.

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

## estimator/

`estimator/` is a self-contained TypeScript-on-bun tool (zero npm dependencies) that turns Claude
Code's own transcripts into token-based **actuals** — API requests, turns, agent runs, workflow
runs and phases, task lifecycle events — in a local sqlite database, and turns them into estimate
bands, live burn tracking and calibration. Phase 0 (the collector) collects; Phase 1 — the `est`
verbs that record, track and score estimates, the hook wiring and the statusline segment — has
shipped.

**Its source is committed here; its data never is.** The database and its WAL sidecars, the OTLP
spool, the weekly backups, the sweep lock, and everything corpus-derived — the gate probes' raw
dumps AND their `gates/*.md` reports, the specification (`estimator/DESIGN.md`) and the decision
log (`estimator/DECISIONS.md`) — are all gitignored and stay on this machine: they quote private
prompts and real usage data, and this repo is public.

**What adopting this config actually runs.** `settings.json` wires three estimator hooks — a
`SessionEnd` sweep, a `PreToolUse`/`TaskUpdate` delete capture, and a `PostToolUse`/`Task|Workflow`
nudge — plus a statusline burn segment. Every one of them is advisory and fails open: no hook ever
denies a tool call, each exits 0 whatever happens inside it (the `SessionEnd` sweep is budgeted to
finish inside its own timeout), and the statusline segment degrades to nothing rather than to a
stale number or a stack trace. The scheduled leg (a launchd job running the daily
sweep and the weekly price sync and backup) is the one piece that is **not** wired by adopting this
repo: it stays an explicit `cp` + `launchctl bootstrap`, with the exact sequence in the plist's own
header. See `estimator/README.md` for commands, the per-file wiring table, and where the local-only
spec and decision log live.

## Submodule Management

Some plugins are git submodules pointing to external repositories. See CLAUDE.md for update commands:

```bash
# Check for updates
git submodule update --remote --dry-run

# Apply updates
git submodule update --remote
```

## Contents

- `CLAUDE.md` - Global instructions (orchestrator mode, async-first delegation & question routing, workflow orchestration, sub-agent restrictions, git operations)
- `settings.json` - Permissions, hooks, model preferences, enabled marketplace plugins
- `plugins/` - Plugin directory with agents, skills, hooks, and commands
- `hooks/` - Global hook scripts
- `estimator/` - Token-based estimation and tracking CLI (source committed, data gitignored)

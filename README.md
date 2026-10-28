# Claude Code Configuration

Personal Claude Code configuration with plugin-based architecture, custom hooks, and orchestrator-mode workflow.

## Features

- **Plugin System**: Modular plugins containing agents, skills, hooks, and commands
- **Portable core**: the `craig-core` plugin carries the global instructions, the Claude route agents, and the core skills, so they reach the Claude app (chat and Cowork) and cloud sessions as well as the local CLI
- **Orchestrator Mode**: the instructions configure Claude as a delegating orchestrator that spawns sub-agents for all implementation work — launched **async** (in the background, so you stay interactive while they work), with a **Workflow engine** for large, opted-in, programmatically-enforced fan-out
- **Environment-adaptive routing**: cross-family (GPT, DeepSeek) agent routes are used only where the local utraque proxy serves them; everywhere else the routing falls back to Claude-only pairings
- **Custom Hooks**: PreToolUse and SessionStart hooks for workflow automation
- **Marketplace Integration**: This repo doubles as a plugin marketplace; plugins are *available* everywhere, *enabled* per project (craig-core and bluesky globally)

## Installing via marketplace

```
/plugin marketplace add hughescr/claude-code-config
/plugin install craig-core@craigs-claude-plugins
/plugin install bluesky@craigs-claude-plugins
```

The marketplace manifest lives at `.claude-plugin/marketplace.json` and lists every plugin in `my-plugins/`. On claude.ai,
add the marketplace (`hughescr/claude-code-config`) with automatic sync to reach chat and Cowork.

Locally, `settings.json` registers this directory itself as the `craigs-claude-plugins`
marketplace (a `directory` source in `extraKnownMarketplaces`). That makes every plugin
**available but not enabled**; `settings.json` enables only `craig-core`, `bluesky` and
`mods-probe` globally. A project opts in to others with a per-project `enabledPlugins` entry (e.g.
`"hugo@craigs-claude-plugins": true` in the project's `.claude/settings.json`), which replaces the `.claude-mixins`
mechanism — though `.claude-mixins` files are still honored by the `claude-smart.sh` shim. Plugin manifests carry no
`version`: the commit SHA is the version.

## Surfaces

- **Mac CLI and Desktop Code** load `~/.claude` directly. The CLI gets the utraque proxy only through `claude-smart.sh`, so cross-family routes work only in sessions it launches. Desktop Code never goes through the launcher: `ANTHROPIC_BASE_URL` is `https://api.anthropic.com` there, and its verified session listed no `gpt-*` or `deepseek-*` agent types. `settings.json` hooks (git guard, plugin-skill approval) run only on these two. On the Mac, an installed plugin shadows its `@synced` copy from claude.ai, so nothing loads twice.
- **Claude app** (chat and Cowork) gets only plugins synced to the claude.ai account, and the craig-core SessionStart and SubagentStart hooks inject the instructions. Agents and hook context can arrive a moment after the session starts, so check again before assuming they are missing. Skills arrive through the sync, not uploads (`syncClaudeAiSkills: false` stops the upload sync). The app has no shell on the Mac, and its Mac-side tools (local MCP servers, granted folders, browser, computer use) work only while the Claude Desktop app is open. Make Mac changes in Claude Code (CLI, Desktop Code, or Remote Control from the phone). Do not enable `mods-probe` in the Claude app; it is a Mac-only diagnostic.
- **Cloud sessions** (claude.ai/code) get the cloned repo's committed `.claude/`, the environment's variables and setup script, and the account's synced plugins. They cannot reach the proxy, which listens on the Mac's `127.0.0.1`, and `ANTHROPIC_BASE_URL` must be set before Claude Code starts, so routing there is Claude-only.
- **Untested:** the route-effort hook on Desktop Code and cloud, and `routing-refresh` on the Claude app and cloud. The route-effort hook is verified on the Mac CLI (it enforces effort) and the Claude app (it allows a call without effort). SubagentStart is verified on Desktop Code, cloud and the Claude app.
- **After changing instructions, hooks or plugins,** check a fresh session on each surface: instructions appear once, every `craig-core:*` agent is listed, and each skill loads once. The Claude app and cloud need Craig to check.

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
- **craig-core** - Global instructions (CLAUDE.md, MAIN-CLAUDE.md, SUBAGENT-CLAUDE.md) injected at session and sub-agent start, the Claude route agents (`craig-core:<route>`), and the my-writing-style and routing-refresh skills; see `my-plugins/craig-core/README.md`
- **bluesky** - Read Bluesky posts, threads, profiles and search; draft in Craig's voice and post as @craig.rungie.com after a preview and explicit confirmation (a Node CLI plus the `bluesky` and `bluesky-voice` skills); see `my-plugins/bluesky/README.md`
- **generic-dev** - General development agents and skills
- **hugo** - Hugo static site generator support (agents, commands, hooks, skills)
- **javascript** - JavaScript development agents and skills
- **typescript** - TypeScript hooks and skills
- **duckdb** - DuckDB integration
- **tmux** - Tmux session management
- **resin-print-prep** - Prep 3D meshes for resin printing in Blender (via Blender MCP)
- **git-guard** - Blocks destructive git commands (in-process mod)
- **mods-probe** - Flag probe for hooks modules

(`plugins/` still exists but holds only Claude Code's own install machinery —
`config.json` and `.install-manifests/` — plus runtime state on the live machine;
no plugin sources live there anymore.)

## Launcher: claude-smart.sh

`claude-smart.sh` is a thin zsh shim around the natively installed binary
(`~/.local/bin/claude`, native installer). On each launch it:

1. Detects project shape (package.json / tsconfig.json / Hugo configs) and assembles
   `--plugin-dir` flags for matching plugins in `~/.claude/my-plugins/`
2. Applies mixins from `CLAUDE_MIXINS` env var or a `.claude-mixins` file
   (local `./.claude/plugins/<name>` overrides `~/.claude/my-plugins/<name>`)
3. Runs `claude update` best-effort (60s timeout; offline or failed update never
   blocks launch)
4. `exec`s the native binary with the assembled flags

## Contents

- `CLAUDE.md` - Symlink to `my-plugins/craig-core/instructions/COMMON-CLAUDE.md`, so the local CLI loads the global instructions natively (session, sub-agents and Workflow agents)
- `settings.json` - Permissions, hooks, model preferences, marketplace registration, enabled plugins
- `my-plugins/` - Plugin sources (agents, skills, hooks, commands) served via the marketplace
- `agents/` - The cross-family route agents (`gpt-*`, `deepseek-*`); local only, they need the utraque proxy
- `claude-smart.sh` - Thin launcher shim (project detection, mixins, update-on-launch, utraque proxy env)
- `hooks/` - Global hook scripts (git guard, plugin-skill approval, mods flag reconcile)
- `tests/` - Hook test runner (`tests/hooks-test.sh`); craig-core's hook tests are in `my-plugins/craig-core/tests/`
- `UTRAQUE-SETTINGS-DELTA.md` - How the utraque proxy is wired in at launch

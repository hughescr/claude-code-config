# What works where

Plugins from this marketplace reach each surface by a different path:

- **CLI and the Desktop Code tab** (local Mac) load `~/.claude` directly: `CLAUDE.md`, `agents/`, `hooks/`,
  `settings.json`, and the plugins it enables from this directory.
- **Claude app** (desktop, web, phone) is one surface with agentic tools, running in an Anthropic cloud workspace.
  It gets only the plugins added to Craig's claude.ai account from the GitHub marketplace.
- **Cloud sessions** (claude.ai/code) get the cloned repo's committed `.claude/` and the environment's variables
  and setup script. Whether account plugins reach them is unverified.

On the Mac, an installed plugin shadows the same-named `@synced` copy from claude.ai, so nothing loads twice.

## Features by surface

| Feature | CLI | Desktop Code | Claude app | Cloud |
|---|---|---|---|---|
| Global instructions (common part) | yes, natively via the `CLAUDE.md` symlink | yes, natively | yes, via craig-core SessionStart hook | plugin hook, if the plugin is installed |
| Main and sub-agent instructions | plugin hooks | plugin hooks | main: yes (SessionStart); sub-agent: untested (SubagentStart) | plugin hooks, if installed |
| `craig-core:*` route agents | yes | yes | yes, all 11 | if installed |
| `gpt-*` and `deepseek-*` routes | only with the utraque proxy (`claude-smart.sh` sets `ANTHROPIC_BASE_URL`) | only if `ANTHROPIC_BASE_URL` points at the proxy | no: Claude-only pairings | no: Claude-only pairings |
| my-writing-style | yes | yes | yes | if installed |
| model-selection (facts and route evidence) | yes | yes | yes | if installed |
| model-selection live Artificial Analysis queries | env var or `op` | env var or `op` | unverified (no documented secret mechanism) | `ARTIFICIAL_ANALYSIS_API_KEY` on the environment |
| Bluesky reading | tool | tool | read-only; runtime not guaranteed | tool |
| Bluesky posting and deleting | tool, password from `op` | tool, password from `op` | no: draft, Craig posts | tool, `BSKY_APP_PASSWORD` on the environment |
| bluesky-voice drafting | yes | yes | yes | if installed |
| settings.json hooks (git-guard, plugin-skill approval) | yes | yes | no | no |

Where cross-family routes are unavailable, the Route availability rule in `CLAUDE.md` applies: use only
`craig-core:*` routes and report every check as same-family.

## Claude app

Tested 2026-10-07, with the marketplace `hughescr/claude-code-config` added on claude.ai with sync on:

- Skills load: `craig-core:my-writing-style`, `bluesky:bluesky`, `bluesky:bluesky-voice`, `model-selection:model-selection`.
- All 11 `craig-core:*` agents load.
- The craig-core SessionStart hook fires and injects the instructions (Route availability, Orchestration).
- Routing falls back to `craig-core:*` routes only.
- Agents and hook context can arrive a moment after the session starts. If they are missing at first, check again.
- SubagentStart hook: untested.

**Mac access.** While the Claude Desktop app is open on the Mac, the Claude app session reaches local MCP servers (proxied as `claude-device__lcl-*` tools), granted folders (staged as snapshots, results written back), the browser and computer use. With the Mac off or the app closed (e.g. web, phone, scheduled runs), none of that is available. The Claude app cannot run shell commands on the Mac; use Claude Code (CLI, Desktop Code tab, or Remote Control from the phone) for that.

**Bluesky.** Read-only: no `BSKY_APP_PASSWORD`, no `op`, and the runtime is not guaranteed. Future option: a local Bluesky MCP server on the Mac, reached through the Desktop bridge.

## Craig's manual setup

- [x] **Land the migration locally** with the steps in `MIGRATION.md`. Publish model-selection's `plugin` branch first.
- [x] **Add the marketplace** on claude.ai, Customize, Plugins, Add marketplace: `hughescr/claude-code-config`, with **Sync automatically** on.
- [x] **Enable `craig-core`, `model-selection` and `bluesky`** on the account. Do not enable `mods-probe` in the Claude app: it is a Mac-only Claude Code diagnostic.
- [x] **Delete the uploaded skills** on claude.ai: `browsing-bluesky`, `model-selection` and `my-writing-style`. `syncClaudeAiSkills: false` stops the sync.
- [ ] **Rotate the Artificial Analysis key.** The old key sat in `creds.json` in the uploaded model-selection copy. Store the new key in 1Password (default ref `op://Private/Artificial Analysis/credential`, or set `ARTIFICIAL_ANALYSIS_OP_REF`) and, for cloud, as `ARTIFICIAL_ANALYSIS_API_KEY` on the environment.
- [ ] **Set `BSKY_APP_PASSWORD` per surface,** with a separate Bluesky app password for each so one can be revoked alone:
  - Mac: nothing to set; `op` reads the default item.
  - Cloud: the environment's **Environment variables** (not a network secret). Use a private environment. If network access is restricted, allow `bsky.social`, `*.host.bsky.network`, `public.api.bsky.app`, `api.bsky.app` and `cdn.bsky.app`.
  - Claude app: no supported mechanism yet. Read-only; posting stays manual.
- [ ] **Cloud setup script, if account plugins don't reach cloud sessions.** Pilot this in the environment's setup script (it must exit 0):

  ```sh
  claude plugin marketplace add hughescr/claude-code-config || true
  claude plugin install craig-core@craigs-claude-plugins || true
  claude plugin install model-selection@craigs-claude-plugins || true
  claude plugin install bluesky@craigs-claude-plugins || true
  ```

  Untested: whether `claude` is on PATH during setup, whether github.com is reachable, and whether the installed plugins then load.
- [x] **Verify the CLI.** A fresh session shows the Orchestration and Route availability text, all 11 `craig-core:*` agents, and no duplicated instructions.
- [ ] **Verify Desktop Code and cloud.** `/skills` lists `craig-core:*`, `model-selection:model-selection`, `bluesky:bluesky` and `bluesky:bluesky-voice`, with no `browsing-bluesky` and no unprefixed duplicates. Where agents exist, the agent list shows `craig-core:*`. In cloud, check that the session context contains the `<!-- craig-core: MAIN-CLAUDE.md -->` block, which shows the plugin hooks fired. The Claude app is checked (see above).

# What works where

Plugins from this marketplace reach each surface by a different path:

- **CLI and the Desktop Code tab** (local Mac) load `~/.claude` directly: `CLAUDE.md`, `agents/`, `hooks/`,
  `settings.json`, and the plugins it enables from this directory.
- **Cowork, claude.ai chat and phone** get only the plugins added to Craig's claude.ai account from the GitHub
  marketplace. Chat loads skills and commands only: no agents and no hooks.
- **Cloud sessions** (claude.ai/code) get the cloned repo's committed `.claude/` and the environment's variables
  and setup script. Whether account plugins reach them is unverified.

On the Mac, an installed plugin shadows the same-named `@synced` copy from claude.ai, so nothing loads twice.

## Features by surface

| Feature | CLI | Desktop Code | Cowork | Cloud | Chat, phone |
|---|---|---|---|---|---|
| Global instructions (common part) | yes, natively via the `CLAUDE.md` symlink | yes, natively | plugin hook, unverified | plugin hook, if the plugin is installed | no (no hooks) |
| Main and sub-agent instructions | plugin hooks | plugin hooks | plugin hooks, unverified | plugin hooks, if installed | no |
| `craig-core:*` route agents | yes | yes | yes | if installed | no (no agents) |
| `gpt-*` and `deepseek-*` routes | only with the utraque proxy (`claude-smart.sh` sets `ANTHROPIC_BASE_URL`) | only if `ANTHROPIC_BASE_URL` points at the proxy | no: Claude-only pairings | no: Claude-only pairings | no |
| my-writing-style, plan-review, review-changes | yes | yes | yes | if installed | my-writing-style; review-changes needs sub-agents, which chat lacks |
| model-selection (facts and route evidence) | yes | yes | yes | if installed | yes |
| model-selection live Artificial Analysis queries | env var or `op` | env var or `op` | unverified (no documented secret mechanism) | `ARTIFICIAL_ANALYSIS_API_KEY` on the environment | unverified |
| Bluesky reading | tool | tool | tool if node or bun exists, else public endpoints | tool | public endpoints via web fetch |
| Bluesky posting and deleting | tool, password from `op` | tool, password from `op` | not supported yet: draft, Craig posts | tool, `BSKY_APP_PASSWORD` on the environment | no: draft, Craig posts |
| bluesky-voice drafting | yes | yes | yes | if installed | yes |
| settings.json hooks (git-guard, plugin-skill approval) | yes | yes | no | no | no |

Where cross-family routes are unavailable, the Route availability rule in `CLAUDE.md` applies: use only
`craig-core:*` routes and report every check as same-family.

## Craig's manual setup

1. **Land the migration locally** with the steps in `MIGRATION.md`. Publish model-selection's `plugin` branch first.
2. **claude.ai, Customize, Plugins, Add marketplace:** `hughescr/claude-code-config`, with **Sync automatically**
   on. Add `craig-core`, `model-selection` and `bluesky` to the account.
3. **Delete the uploaded skills** on claude.ai: `browsing-bluesky`, `model-selection` and `my-writing-style`. They
   are stale copies, and they show up locally as duplicate `anthropic-skills:*` skills. Once none are left that you
   need, `syncClaudeAiSkills: false` stops the sync.
4. **Rotate the Artificial Analysis key.** The uploaded model-selection copy contains `creds.json` with the key.
   Store the new key in 1Password (default ref `op://Private/Artificial Analysis/credential`, or set
   `ARTIFICIAL_ANALYSIS_OP_REF`) and, for cloud, as `ARTIFICIAL_ANALYSIS_API_KEY` on the environment.
5. **Set `BSKY_APP_PASSWORD` per surface,** with a separate Bluesky app password for each so one can be revoked
   alone:
   - Mac: nothing to set; `op` reads the default item.
   - Cloud: the environment's **Environment variables** (not a network secret). Use a private environment. If
     network access is restricted, allow `bsky.social`, `*.host.bsky.network`, `public.api.bsky.app`,
     `api.bsky.app` and `cdn.bsky.app`.
   - Cowork: no supported mechanism yet. Posting stays manual.
6. **Cloud setup script, if account plugins don't reach cloud sessions.** Pilot this in the environment's setup
   script (it must exit 0):

   ```sh
   claude plugin marketplace add hughescr/claude-code-config || true
   claude plugin install craig-core@craigs-claude-plugins || true
   claude plugin install model-selection@craigs-claude-plugins || true
   claude plugin install bluesky@craigs-claude-plugins || true
   ```

   Untested: whether `claude` is on PATH during setup, whether github.com is reachable, and whether the installed
   plugins then load.
7. **Verify on each surface:** `/skills` lists `craig-core:*`, `model-selection:model-selection`, `bluesky:bluesky`
   and `bluesky:bluesky-voice`, with no `browsing-bluesky` and no unprefixed duplicates. Where agents exist, the
   agent list shows `craig-core:*`. In Cowork and cloud, check that the session context contains the
   `<!-- craig-core: MAIN-CLAUDE.md -->` block, which shows the plugin hooks fired.

# craig-core migration — runbook

## What changed

- **craig-core plugin** (`my-plugins/craig-core`): the only copy of the instructions (`instructions/COMMON-CLAUDE.md`,
  `MAIN-CLAUDE.md`, `SUBAGENT-CLAUDE.md`), the Claude route agents and `craig-core:project-steward` (all now `craig-core:<name>`), and
  the review-changes, plan-review and my-writing-style skills. Its SessionStart and SubagentStart hooks inject the
  instructions on surfaces that do not load `~/.claude/CLAUDE.md`.
- **`CLAUDE.md`** is a tracked symlink to `my-plugins/craig-core/instructions/COMMON-CLAUDE.md`.
- **settings.json**: the `inject-main-context.sh` and `inject-subagent-context.sh` hooks are gone (scripts deleted), so
  only the plugin injects; `craig-core`, `model-selection` and `bluesky` are enabled. The git-guard PreToolUse hook is unchanged.
- **Routing**: CLAUDE.md has one Route availability rule and Claude-only columns in the pairing table; every Claude
  route is named `craig-core:<route>`. The `gpt-*` and `deepseek-*` agents stay in `agents/`.
- **model-selection**: the `skills/model-selection` submodule is removed. The plugin installs from
  hughescr/model-selection (`github` source in the marketplace). Its key comes from `ARTIFICIAL_ANALYSIS_API_KEY`,
  else `op read`; there is no `creds.json`.
- **bluesky plugin** (`my-plugins/bluesky`): a Node CLI (`scripts/bsky.mjs`) plus the `bluesky` and `bluesky-voice`
  skills. It replaces the Python `skills/browsing-bluesky`, which is deleted. Enabled in settings.json.
- **Hygiene**: no `version` in plugin manifests; `.gitignore` covers root `.env`, root `creds.json`, and
  `plugins/plugin-directory-cache-v2.json`; `approve-plugin-skills.sh` also approves plugins named in this
  marketplace's manifest (so `model-selection:*` skills do not prompt).

## Merge procedure

1. **Publish model-selection first.** Push its `plugin` branch and merge it into `main` on GitHub: the marketplace
   installs the default branch, which until then has no plugin layout.
2. Stop other Claude Code sessions running against `~/.claude`, then merge into `develop`.
3. **Move the old submodule checkout out of `~/.claude/skills/`**, for example
   `mv ~/.claude/skills/model-selection ~/code/hughescr/model-selection`. Git leaves it in place on merge because it
   has its own `.git` directory, and while it stays its `SKILL.md` loads as a second, loose copy of the skill (with a
   plugin manifest it would also auto-load as `model-selection@skills-dir`). It holds a `creds.json` with the
   Artificial Analysis key: move the key to 1Password or the environment, then delete the file.
   Also remove what git leaves behind in the deleted skill folders: `~/.claude/skills/browsing-bluesky` keeps its
   untracked `__pycache__/` and `.claude/` folders, and the moved skills may leave empty folders. Once
   `ls ~/.claude/skills` shows only `synced` (and `model-selection` until you move it), nothing loose remains.
4. **Give model-selection its key**: export `ARTIFICIAL_ANALYSIS_API_KEY`, or store it in 1Password at
   `op://Private/Artificial Analysis/credential` (or set `ARTIFICIAL_ANALYSIS_OP_REF` to where it is).
5. **Remove stale submodule config** from the repo's `.git/config` (one entry still points at tkellogg's upstream):
   `git -C ~/.claude config --remove-section submodule.skills/model-selection` and
   `git -C ~/.claude config --remove-section submodule.plugins/humanizer/skills/humanizer`.
6. **Edit `~/.claude/.claude/CLAUDE.md`** (untracked project instructions): delete its "Git Submodules" section; this
   repo has no submodules now.
7. Restart and verify:
   - `ls -l ~/.claude/CLAUDE.md` shows the symlink into `my-plugins/craig-core/instructions/`.
   - `claude plugin list` shows `craig-core`, `model-selection` and `bluesky` (`@craigs-claude-plugins`) enabled.
   - The session context has a `<!-- craig-core: MAIN-CLAUDE.md -->` block ending in a "Cross-family routes:" line,
     and no `<!-- craig-core: CLAUDE.md` block (the symlink loads it natively).
   - An agent spawned as `craig-core:haiku-xhigh` receives the `<!-- craig-core: SUBAGENT-CLAUDE.md -->` block.
   - `/skills` lists `craig-core:review-changes`, `craig-core:plan-review`, `craig-core:my-writing-style` and
     `model-selection:model-selection`, `bluesky:bluesky` and `bluesky:bluesky-voice`, and no unprefixed
     `model-selection` or `browsing-bluesky`.
8. **claude.ai and the other surfaces**: follow the setup steps in `CAPABILITIES.md` (add the marketplace, delete the
   uploaded skills, rotate the Artificial Analysis key, set `BSKY_APP_PASSWORD` per surface).

## Rolling back

Revert the merge commit, restore the submodule with `git -C ~/.claude submodule update --init skills/model-selection`
(or move the clone back), and restart. The reverted settings.json brings back the old injector hooks, so the two
mechanisms never run together.

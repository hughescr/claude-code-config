# setup-refresh — migration runbook

## What changed on this branch

- **settings.json** — hook timeouts normalized to seconds (5/30; the field is seconds, verified experimentally); `curl`/`cat`/`find` Bash allows dropped; `Read`/`Edit` allows added for `/private/tmp/claude-*/**`; `block-temp-planning-files.sh` hook unwired; empty `deny`/`ask` removed; `craigs-claude-plugins` registered as a `directory`-source marketplace in `extraKnownMarketplaces` (plugins available, none globally enabled).
- **claude-smart.sh** — thin shim over the native binary at `/opt/homebrew/bin/claude` (bunx launch retired); plugin paths now `~/.claude/my-plugins/<name>`; best-effort `claude update` (60s timeout) before an `exec` of the real binary; mixin rules unchanged.
- **plugins** — the 7 plugin sources moved `plugins/` → `my-plugins/` (git renames); humanizer plugin and its submodule removed (`.gitmodules` now lists only `skills/model-selection`); `.claude-plugin/marketplace.json` sources rewritten to `./my-plugins/<name>` and the humanizer entry deleted.
- **hooks** — `git-guard.sh` closes the global-flag bypass (`-C`, `-c`, `--git-dir`, …); codex validators rewritten to anchor-match every shell subcommand and deny command/process substitution; `/private/tmp` accepted as an alias of `/tmp`; `approve-plugin-skills.sh` sanitizes plugin names and only auto-approves real plugin dirs; `block-temp-planning-files.sh` deleted; new `tests/hooks-test.sh` (70 assertions, all passing).
- **instructions** — MAIN-CLAUDE.md: marker line removed, effort-estimation section trimmed to non-duplicated content, git-guard restatement dropped, Codex cross-check guidance merged into Quality & Risk, phantom agent names fixed; CLAUDE.md git-guard description now matches the guard's actual allow/deny behavior.
- **packaging** — README.md reconciled with the above (codex/humanizer entries gone, `my-plugins/` paths, shim + marketplace model documented, dead `~/.claude/mcp.json` alias docs replaced); `apply-live.sh` post-merge cleanup script; this runbook.

## Merge procedure

1. Stop all other Claude Code sessions running against `~/.claude`.
2. In the live checkout: merge `setup-refresh` (e.g. `git -C ~/.claude merge setup-refresh` from `develop`).
3. Run `~/.claude/apply-live.sh` (interactive; `-f` to skip confirms). It backs up and removes the orphaned marketplace clone, drops the stale `hugo@craigs-claude-plugins` install record and frozen cache, and prints the manual edits needed in the two untracked files (`.claude/CLAUDE.md`, `.claude/settings.local.json`).
4. Restart: launch a fresh session via `claude-smart.sh` and run the verification steps the script prints (`/plugin marketplace list` shows `craigs-claude-plugins`; in misc.rungie.com the hugo plugin loads exactly once).

## Hugo drift evidence

Why the frozen cache install must go: the project-scoped `hugo@craigs-claude-plugins`
install in misc.rungie.com pins a cache copy at 1.0.0
(`~/.claude/plugins/cache/craigs-claude-plugins/hugo/1.0.0/`) that has silently drifted
behind the live source (`~/.claude/plugins/hugo/`, now `my-plugins/hugo/` on this branch).
`diff -rq` (2026-08-05): 3 files differ, plus a cache-only `.in_use` marker.

Summary of the drift (cache → live):

- `agents/hugo-asset-specialist.md` — Collaboration section still names the old agent
  ids `hugo-content-developer`/`hugo-template-architect`; live uses the renamed
  `hugo-content-manager`/`hugo-template-developer`.
- `agents/hugo-template-developer.md` — same stale `hugo-content-developer` reference.
- `skills/hugo-fundamentals/SKILL.md` — cache predates the Hugo v0.156.0
  `.Site.Author` removal: live adds the `[params.author]` config pattern (name/email
  replacing the flat `author` param), a "### .Site.Author Deprecation (Hugo v0.156.0+)"
  migration section with site-level (`.Site.Params.author.name`) and page-level
  (`.Params.author`) access, and matching trigger terms in the skill description
  (".Site.Author", "author config", "site params").

Representative hunks:

```diff
--- cache/hugo/1.0.0/agents/hugo-asset-specialist.md
+++ live/hugo/agents/hugo-asset-specialist.md
@@ -342,8 +342,8 @@
 ## Collaboration

-- **With hugo-content-developer**: Coordinate on content-specific styling needs
-- **With hugo-template-architect**: Ensure partials properly integrate asset processing
+- **With hugo-content-manager**: Coordinate on content-specific styling needs
+- **With hugo-template-developer**: Ensure partials properly integrate asset processing
```

```diff
--- cache/hugo/1.0.0/skills/hugo-fundamentals/SKILL.md
+++ live/hugo/skills/hugo-fundamentals/SKILL.md
@@ -340,7 +340,10 @@
 [params]
   description = "Site description for SEO"
-  author = "Author Name"
+
+  [params.author]
+    name = "Author Name"
+    email = "author@example.com"
@@ -353,6 +356,21 @@
+### .Site.Author Deprecation (Hugo v0.156.0+)
+
+`.Site.Author` was removed in Hugo v0.156.0. Migrate author data to `[params.author]`:
+...
+- **Site-level**: `{{ .Site.Params.author.name }}` — from `hugo.toml` `[params.author]`
+- **Page-level**: `{{ .Params.author }}` — from page frontmatter `author` field
```

After `apply-live.sh` deletes the cache and install record, the project re-enables hugo
through the directory-source marketplace and always tracks the live source.

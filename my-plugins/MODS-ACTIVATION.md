# Mods activation runbook

Status: the `typescript` per-file compiler guard is activated (its `.sh` is removed; the mod is the only guard). The
`git-guard` and `hugo` guard mods (`guard.ts`/`register.ts`) are staged on `develop` and **not wired**. Their `.sh`
command hooks stay the enforcement of record until you run this.

Why the wait: hooks modules load only while the server-side GrowthBook flag `tengu_plugin_hooks_modules` is ON for
the process. While it is off, every module is silently skipped, so a guard whose `.sh` was removed is **absent**.
The flag has flapped. `mods-probe` (installed and enabled) exists to measure that.

Rules for every step below:

- Never set `DISABLE_GROWTHBOOK=1` in a launcher or in settings. Use it only as a one-off prefix on
  `claude plugin test` (or `validate`).
- Overlap before you remove: the new guard is verified live while the old one still guards.
- `claude plugin test`/`validate` need network and may need the sandbox off. A sandboxed run falsely says
  "turned off".
- The live git-guard denies Bash commands containing destructive git strings. Write files that contain them with
  the Write/Edit tool, not shell redirection.

## (a) Is the flag stable? (all three, over several days)

- [ ] `~/.claude/mods-flag.log` has an `on` line for every `start` line (every session you started, CLI and
      desktop). The hook `hooks/mods-flag-reconcile.ts` writes the `start` and, 2 minutes later, an
      `inferred off` for any start that never got an `on` (see `my-plugins/mods-probe/README.md`). Run
      `bun ~/.claude/hooks/mods-flag-reconcile.ts --report`: it prints starts, on and off per day plus the last
      transition. Stable means `off` is 0 on every day of the window. `tail -n 30 ~/.claude/mods-flag.log` shows
      the raw lines.
- [ ] `jq '.cachedGrowthBookFeatures.tengu_plugin_hooks_modules' ~/.claude.json` prints `true` on each check, and
      did not print `false` between checks. It is a cache written by whichever process last refreshed it: a hint,
      not proof.
- [ ] `claude plugin test my-plugins/git-guard`, in a fresh process **without** `DISABLE_GROWTHBOOK`, ends
      `104 pass / 0 fail`. A "turned off" message means the flag is off right now.
- [ ] Your bar (suggested): every session for 7 days logged, `jq` never `false`, and the `plugin test` passed on at
      least 3 different days. Any miss restarts the count. If it fails, stop: change no wiring.

Also: every new session shows `mods-probe: hooks modules are ON in this process` at launch. No notice in a session
means mods are off in that session.

## (b) Activation, one guard at a time

### git-guard

1. [ ] Install and enable (this repo is the marketplace, a directory source):
       `claude plugin marketplace update craigs-claude-plugins`
       `claude plugin install git-guard@craigs-claude-plugins`
       The install adds `"git-guard@craigs-claude-plugins": true` to `enabledPlugins` in `~/.claude/settings.json`
       by itself (it did for `mods-probe`). Confirm with
       `jq '.enabledPlugins["git-guard@craigs-claude-plugins"]' ~/.claude/settings.json` (`true`). If absent, add
       that line to `enabledPlugins` by hand (settings.json is sandbox-protected; use the Edit tool with approval).
2. [ ] Verify the mod blocks, in a NEW session, while `hooks/git-guard.sh` is still wired:
       `claude-smart.sh --debug-file $TMPDIR/gg.txt` (or `claude --debug-file ...`), then ask it to run exactly
       `false && git clean -f --dry-run-NOT`
       Why this probe: `--dry-run-NOT` is not the token `--dry-run` and not a short `-...n...` flag, so the clean
       rule sees `-f` with no dry run and denies. Checked against `hooks/guard.ts`: it returns the clean reason.
       It is safe even if the guard failed open: `false &&` stops the shell, and git rejects the unknown option
       before it deletes anything. Do not use `--dry-run` (that is the allowed form).
       Expect the deny reason "git clean with a force flag permanently deletes untracked files. ..."
       Then, to prove the MOD answered (the old hook gives the same reason text):
       `grep -E 'git-guard.*(loaded|answered tool.call without next)' $TMPDIR/gg.txt`
       Also check `git status` runs (allowed), and repeat the probe from a subagent.
3. [ ] Only after step 2 passes in a session that showed the mods-probe notice: remove from
       `~/.claude/settings.json` ONLY this element of `hooks.PreToolUse`, keeping the `Skill` element:
       `{"matcher": "Bash", "hooks": [{"type": "command", "command": "${HOME}/.claude/hooks/git-guard.sh", "timeout": 5}]}`
       (Edit tool with approval.) Open a new session; repeat the step 2 probe (the mod is now the only guard).
4. [ ] Delete the script: `git rm hooks/git-guard.sh`. Then update the remaining references:
       `tests/hooks-test.sh` (its `git-guard.sh` section, from about line 44), and the
       "Status: staged only" paragraph of `my-plugins/git-guard/README.md`. Commit.
5. [ ] Note on `my-plugins/git-guard/tests/gen-git-guard-wordchars.ts`: it probes `/usr/bin/grep` directly and
       writes `hooks/wordchars.ts`; `git-guard.sh` is its parity reference (named in its header and in the corpus
       and test comments), not something it executes. After the deletion, restore the reference from history when
       you need it: `git log --diff-filter=D --format=%h -1 -- hooks/git-guard.sh`, then
       `git show <that-sha>^:hooks/git-guard.sh`. Rerun the generator only after a macOS upgrade:
       `bun my-plugins/git-guard/tests/gen-git-guard-wordchars.ts` (from `~/.claude`).
6. [ ] Later edits to an installed plugin take effect only after a version bump in its
       `.claude-plugin/plugin.json`, `claude plugin marketplace update craigs-claude-plugins`, and
       `claude plugin update git-guard@craigs-claude-plugins` (it runs from
       `~/.claude/plugins/cache/craigs-claude-plugins/git-guard/<version>`).

### hugo

typescript is done: its `hooks/hooks.json` keeps the `SessionStart` hook (`ts-lsp-check.sh`) beside the `modules`
key.

How the plugins load: they are NOT marketplace-installed on this machine (`installed_plugins.json` has no
`typescript@`/`hugo@craigs-claude-plugins`). `claude-smart.sh` adds
`--plugin-dir ~/.claude/my-plugins/typescript` (project has `tsconfig.json`, or typescript in `package.json`) and
`--plugin-dir ~/.claude/my-plugins/hugo` (project has a Hugo config) straight from this working tree. Two
consequences:

- A `--plugin-dir` folder is watched and hot-reloaded: **saving `hooks/hooks.json` is itself the cutover in every
  running `claude-smart.sh` session.**
- The desktop app and a plain `claude` do not go through `claude-smart.sh`, so these guards (shell or mod) are not
  loaded there at all. Nothing changes for them.

For hugo (`block-serverless-deploy.sh`):

1. [ ] Overlap. Edit `hooks/hooks.json` to carry BOTH keys: add `"modules": ["./register.ts"]` and keep the
       existing `"hooks": {...}` block. `claude plugin validate` accepts both together. The mod runs first; the
       `.sh` still guards when the flag is off.
2. [ ] Verify in a NEW `claude-smart.sh --debug-file $TMPDIR/x.txt` session in a Hugo project, asking it to run
       `false && sls deploy` (denied). Expect the new plain-text reason.
       `grep -E 'hugo.*(loaded|answered)' $TMPDIR/x.txt` shows the mod answered.
3. [ ] Remove the `.sh`: remove the `PreToolUse` entry that runs it from `hooks/hooks.json`, keeping the `modules`
       key and any other hooks (the plugin-authoring docs require one path under `modules`, relative to that file;
       if the file has no other hooks, it becomes exactly `{"modules": ["./register.ts"]}`). Repeat the step 2
       probe. Then `git rm my-plugins/hugo/hooks/block-serverless-deploy.sh`.
4. [ ] Update docs that name the shell hook: `my-plugins/hugo/README.md` (hooks table, line 66, and the file tree,
       line 132), `my-plugins/hugo/agents/hugo-deployment.md` (line 56).
5. [ ] Refresh:
       - `claude-smart.sh` sessions: nothing to install; they read the tree. Restart long-lived sessions.
       - Marketplace copies: `misc.rungie.com` and `erica-s-hughes` enable `hugo@craigs-claude-plugins` from GitHub
         (`hughescr/claude-code-config`, per the cutover plan). Pushing the activation commit to that repo's default
         branch is what activates it there. Then, in each, `claude plugin marketplace update craigs-claude-plugins`
         and `claude plugin update hugo@craigs-claude-plugins`. The hugo `plugin.json` has no `version` field, so
         check that the update picks up the new commit.
       - If `claude plugin list` ever shows `typescript@` or `hugo@craigs-claude-plugins` installed locally, run
         `claude plugin update <name>@craigs-claude-plugins` the same way.

## (c) Rollback (never `git checkout --` or `git restore`; the guards deny them)

- git-guard step 4 (script deleted): `git revert <sha>` restores `hooks/git-guard.sh` and its test section.
- git-guard step 3 (settings entry removed): re-add the exact `PreToolUse` Bash element from step 3, using the
  Edit tool. The script is still on disk if step 4 was not done.
- git-guard step 1 (install): `claude plugin disable git-guard@craigs-claude-plugins`, or
  `claude plugin uninstall git-guard@craigs-claude-plugins`; restart sessions.
- typescript (cutover done): `git revert <sha>` of the cutover commit restores `block-tsc-with-files.sh` and the
  `PreToolUse` entry in `hooks/hooks.json`.
- hugo step 3 (`.sh` removed): `git revert <sha>` restores the `.sh` and the old `hooks.json`.
- hugo step 1 (overlap): remove the `"modules"` key from `hooks/hooks.json` by editing it.
- Roll back at once if a session shows no mods-probe notice while a guard depends on the mod, a probe is not
  denied, or the flag log shows gaps.

## (d) Deliberate behaviour changes and preserved gaps

Deliberate changes:

- Commands over about 64 KiB no longer hit the shell's pipefail/SIGPIPE flakiness.
- A non-string command passes through (no opinion).
- tsc and hugo deny reasons are plain text, not a raw JSON blob.
- The `jq`/`sed` failure paths are gone.
- tsc: if the bash glob-expansion fallback cannot run, literal words are used (never weaker than the former shell
  hook in that situation).
- Plugin `tool.call` hooks run before settings `PreToolUse` hooks. When one command trips several guards, the model
  sees only the first plugin's reason. Allow/deny parity holds.
- Word boundaries are an exact generated 706-range table of what BSD grep treats as word characters, pinned to this
  macOS. A macOS upgrade can drift the shell script but not the mod: regenerate (step 5 above).
- Quadratic regex blowups are gone: a linear token scanner (1 MB worst case about 38 ms; the shell took 5 s on
  about 40 KB of repeated `git -C `).

Fail-open paths that remain:

- Flag off in a process: all mods are skipped (the reason for this runbook).
- A hook that throws or exceeds its budget is skipped.
- `--bare`, safe mode and untrusted workspaces load no installed-plugin modules (`--bare` also skips settings
  hooks, so parity holds there).
- tsc glob fallback: `$.session.cwd()` is assumed equal to the former shell hook's cwd; a subagent in its own
  cwd/worktree may differ.

Known gaps preserved on purpose, for parity (fix in a separate, flagged change with its own tests):

- `--staged` anywhere in the command allows `git restore`; `git restore -S f` is denied.
- A dry-run-like token anywhere (even `-name`) allows `git clean`.
- An unknown git global option, `git -C reset`, or an empty `--git-dir=` breaks the match.
- `git -c clean.requireForce=false clean` is allowed.
- Shell obfuscation is not handled.
- Over-denies: `--hard` or `-f` in unrelated commands next to a reset or clean.
- tsc/tsrs: a path-qualified invocation (`./node_modules/.bin/tsc a.ts`, `node node_modules/tsrs/bin/tsrs a.ts`)
  is allowed, because the gate needs whitespace, `|`, `;`, `&` or the start before the name, not `/`. `tsrs-lint`
  is a different binary and is not matched.
- tsc/tsrs: the deny reason names the compiler last invoked in the command. On a multi-line command naming both,
  an earlier line can be the one that denied, so the name can be the other compiler.

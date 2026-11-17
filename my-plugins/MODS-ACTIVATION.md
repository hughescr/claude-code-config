# Guard mods: operation and rollback

Status: the `git-guard`, `typescript` and `hugo` guards all run as hooks modules (`guard.ts`/`register.ts`). No shell
guard remains: their `.sh` hooks are removed, and the `settings.json` `PreToolUse` Bash entry for git-guard is gone.

## Why a guard can be absent

Hooks modules load only while the server-side GrowthBook flag `tengu_plugin_hooks_modules` is ON for the process.
While it is off, every module is silently skipped, so the guard is **absent** in that process. The flag has flapped.
`mods-probe` (installed and enabled) exists to measure that. Installed-plugin modules also do not load under
`--bare`, safe mode or an untrusted workspace.

To check:

- `bun ~/.claude/hooks/mods-flag-reconcile.ts --report` prints starts, on and off per day plus the last transition.
  The hook writes a `start` line to `~/.claude/mods-flag.log` for every session and, 2 minutes later, an
  `inferred off` for any start that never got an `on` (see `my-plugins/mods-probe/README.md`). `tail -n 30
  ~/.claude/mods-flag.log` shows the raw lines.
- `jq '.cachedGrowthBookFeatures.tengu_plugin_hooks_modules' ~/.claude.json` prints the cached flag. It is written
  by whichever process last refreshed it: a hint, not proof.
- Every new session shows `mods-probe: hooks modules are ON in this process` at launch. No notice means mods are
  off in that session.

Never set `DISABLE_GROWTHBOOK=1` in a launcher or in settings; use it only as a one-off prefix on
`claude plugin test` (or `validate`). `claude plugin test`/`validate` need network and may need the sandbox off; a
sandboxed run falsely says "turned off".

## How each guard loads

**git-guard** is installed as `git-guard@craigs-claude-plugins` (user scope; `enabledPlugins` in
`~/.claude/settings.json`). The marketplace `craigs-claude-plugins` is a directory source pointing at `~/.claude`,
so sessions load the plugin from its source folder, `~/.claude/my-plugins/git-guard/`, not from the plugin cache.
A new session reads `hooks/hooks.json` there; a running session re-reads the folder with `/reload-plugins`, or after
a restart. No `claude plugin update` is needed on this machine. The cache folder
`~/.claude/plugins/cache/craigs-claude-plugins/git-guard/unknown` from the install is not what sessions load. After
an edit, verify that the new behaviour is active with the probe and debug-file grep below.

**typescript and hugo** are NOT marketplace-installed on this machine (`installed_plugins.json` has no
`typescript@`/`hugo@craigs-claude-plugins`). `claude-smart.sh` adds
`--plugin-dir ~/.claude/my-plugins/typescript` (project has `tsconfig.json`, or typescript in `package.json`) and
`--plugin-dir ~/.claude/my-plugins/hugo` (project has a Hugo config) straight from this working tree. Two
consequences:

- A `--plugin-dir` folder is watched and hot-reloaded: **saving `hooks/hooks.json` takes effect in every running
  `claude-smart.sh` session.**
- The desktop app and a plain `claude` do not go through `claude-smart.sh`, so these guards are not loaded there at
  all.

typescript's `hooks/hooks.json` keeps the `SessionStart` hook (`ts-lsp-check.sh`) beside the `modules` key; hugo's is
exactly `{"modules": ["./register.ts"]}`.

Refreshing hugo elsewhere:

- `claude-smart.sh` sessions: nothing to install; they read the tree. Restart long-lived sessions.
- hugo marketplace copies: `misc.rungie.com` and `erica-s-hughes` enable `hugo@craigs-claude-plugins` from GitHub
  (`hughescr/claude-code-config`). Push the cutover commit to that repo's default branch. Then, in each of the two
  repos, run `claude plugin marketplace update craigs-claude-plugins` and
  `claude plugin update hugo@craigs-claude-plugins`. The hugo `plugin.json` has no `version` field, so check that the
  update picks up the new commit.
- If `claude plugin list` ever shows `typescript@` or `hugo@craigs-claude-plugins` installed locally, run
  `claude plugin update <name>@craigs-claude-plugins` the same way.

## Verifying a guard live

Start a NEW session with a debug file (`claude-smart.sh --debug-file $TMPDIR/gg.txt`, or
`claude --debug-file ...`), confirm it shows the mods-probe notice, and ask it to run exactly:

- git-guard: `false && git clean -f --dry-run-NOT`. `--dry-run-NOT` is not the token `--dry-run` and not a short
  `-...n...` flag, so the clean rule sees `-f` with no dry run and denies; the expected reason is "git clean with a
  force flag permanently deletes untracked files. ...". It is safe even if the guard failed open: `false &&` stops
  the shell, and git rejects the unknown option before it deletes anything. Do not use `--dry-run` (that is the
  allowed form). Also check that `git status` runs (allowed), and repeat the probe from a subagent.
- typescript: `false && tsc a.ts` and `false && tsrs a.ts` (both denied).
- hugo (in a Hugo project): `false && sls deploy` (denied).

Then prove the MOD answered, not something else:

    grep -E 'git-guard.*(loaded|answered tool.call without next)' $TMPDIR/gg.txt
    grep -E 'typescript.*(loaded|answered)' $TMPDIR/gg.txt
    grep -E 'hugo.*(loaded|answered)' $TMPDIR/gg.txt

The guard denies Bash commands containing destructive git strings, even inside quotes. Write files that contain them
with the Write/Edit tool, never shell redirection.

## Rollback (never the destructive git forms the guard denies; use `git revert`)

- git-guard: `git revert` the cutover commit (the one that deleted `hooks/git-guard.sh`; find it with
  `git log --diff-filter=D --format=%h -1 -- hooks/git-guard.sh`). It restores `hooks/git-guard.sh`, its section of
  `tests/hooks-test.sh` and the `settings.json` `PreToolUse` Bash element. Or re-add that element to
  `hooks.PreToolUse` in `~/.claude/settings.json` by hand with the Edit tool, keeping the `Skill` element, with this
  exact JSON (the script is then back from the revert, or from git history):
  `{"matcher": "Bash", "hooks": [{"type": "command", "command": "${HOME}/.claude/hooks/git-guard.sh", "timeout": 5}]}`
  To switch the mod off as well: `claude plugin disable git-guard@craigs-claude-plugins` (or `uninstall`), then
  restart sessions.
- typescript: `git revert 62480c5` restores `block-tsc-with-files.sh` and the `PreToolUse` entry in
  `hooks/hooks.json`.
- hugo: `git revert 454225c` restores `block-serverless-deploy.sh` and the old `hooks/hooks.json`.
- Roll back at once if a session shows no mods-probe notice while a guard depends on the mod, a probe is not denied,
  or the flag log shows gaps.

## Regenerating the word-character table

`my-plugins/git-guard/tests/gen-git-guard-wordchars.ts` probes `/usr/bin/grep` directly and writes
`hooks/wordchars.ts`. `hooks/git-guard.sh` is its parity reference (named in the generator's header and in the corpus
and test comments), not something it executes. The script is deleted; recover it from history when you need it:

    git log --diff-filter=D --format=%h -1 -- hooks/git-guard.sh
    git show <that-sha>^:hooks/git-guard.sh

Rerun the generator only after a macOS upgrade: `bun my-plugins/git-guard/tests/gen-git-guard-wordchars.ts` (from
`~/.claude`).

## Deliberate behaviour changes and preserved gaps

Deliberate changes:

- Commands over about 64 KiB no longer hit the shell's pipefail/SIGPIPE flakiness.
- A non-string command passes through (no opinion).
- tsc and hugo deny reasons are plain text, not a raw JSON blob.
- The `jq`/`sed` failure paths are gone.
- tsc: if the bash glob-expansion fallback cannot run, literal words are used (never weaker than the former shell
  hook in that situation).
- Plugin `tool.call` hooks run before settings `PreToolUse` hooks. When one command trips several guards, the model
  sees only the first plugin's reason. Allow/deny parity with the former shell hooks holds.
- Word boundaries are an exact generated 706-range table of what BSD grep treats as word characters, pinned to this
  macOS. A macOS upgrade can change what grep treats as word characters but not the mod's table: regenerate (see
  "Regenerating the word-character table").
- Quadratic regex blowups are gone: a linear token scanner (1 MB worst case about 38 ms; the shell took 5 s on
  about 40 KB of repeated `git -C `).

Fail-open paths that remain:

- Flag off in a process: all mods are skipped.
- A hook that throws or exceeds its budget is skipped.
- `--bare`, safe mode and untrusted workspaces load no installed-plugin modules (`--bare` also skips settings
  hooks, so the removal of the shell hooks changed nothing there).
- tsc glob fallback: `$.session.cwd()` is assumed equal to the former shell hook's cwd; a subagent in its own
  cwd/worktree may differ.

Known gaps preserved on purpose, for parity with the former shell hooks (fix in a separate, flagged change with its
own tests):

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

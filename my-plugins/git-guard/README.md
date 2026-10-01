# git-guard

An in-process `tool.call` mod that denies Bash git commands which silently discard uncommitted work. It is
the mod form of `hooks/git-guard.sh` and replaces it once cut over, saving the shell forks that script cost on
every Bash call (about 34 ms per call, against under a microsecond here).

**Status:** staged only. Until Craig decides otherwise, the `PreToolUse` Bash entry in `settings.json` that runs
`hooks/git-guard.sh` stays the enforcement of record. This plugin is inert until it is installed
(`marketplace update`, then `install`). Activation, verification and rollback: `my-plugins/MODS-ACTIVATION.md`.

## What it denies

Matched through git global options (`git -C dir ...`, `git -c k=v ...`, `--git-dir`, `--work-tree`, `--namespace`,
`--exec-path`, `--super-prefix=`, `--config-env=`, `-p`, `--paginate`, `-P`, `--no-pager`, `--no-optional-locks`,
`--no-replace-objects`, `--literal-pathspecs`, `--glob-pathspecs`, `--noglob-pathspecs`, `--icase-pathspecs`,
`--bare`):

| Command | Allowed exceptions |
|---|---|
| `git checkout ... -- <path>` (a bare `--` token after `checkout`, no `\|&;` between) | `git checkout main`, `-b`, `--track` |
| `git restore` | the pure `--staged` form (no `--worktree` or `-W` anywhere) |
| `git reset` with `--hard` as a whole token anywhere in the command | `--soft`, `--mixed`, `--hard-not-really` |
| `git clean` with a force flag (`-f`, `-fd`, `-fdx`, `--force`) | any dry run (`-n`, `--dry-run`, even with `--force`) |

Every deny reason ends with: "Undo your own edits by editing instead of discarding them; ask Craig for an
exception if this destructive command is genuinely needed." A command that is empty or not a string passes
through. `tool.call` fires for subagents as well, so there is no subagent filter.

## How it matches

`hooks/guard.ts` is pure string logic (no `claude-code` imports). The shell script's `[[:space:]]` and `\b`
are BSD grep and libc semantics, not Unicode properties, so the character classes are reproduced exactly:

- `[[:space:]]` is JS `\s` minus U+FEFF (24 code points).
- `\b` after a keyword uses `hooks/wordchars.ts`, a generated table of the characters BSD grep treats as word
  characters on this machine (706 ranges). `tests/gen-git-guard-wordchars.ts` regenerates it
  (`bun my-plugins/git-guard/tests/gen-git-guard-wordchars.ts` from `~/.claude`); rerun it only after
  a macOS upgrade, while `hooks/git-guard.sh` still exists as the reference.
- The `git ... <subcommand>` prefix is scanned token by token in linear time. The shell's regexes backtracked
  quadratically (`git -C ` repeated 5,700 times, about 40 KB, took 5 s), which would have crossed the hook timeout
  and failed open. Every 1 MB adversarial input now finishes in well under 100 ms.

## Preserved holes (parity with the script, to fix later in a separate, flagged change)

- `--staged` anywhere in the command allows `git restore`; `-S` is not recognised, so `git restore -S f` is denied.
- A dry-run-like token anywhere (even `-name`) allows `git clean`.
- An unknown global option, or `git -C reset ...` (the value swallows `reset`), slips through.
  `--git-dir=` with an empty value breaks the option chain.
- `git -c clean.requireForce=false clean -d` is allowed.
- No defence against shell obfuscation (variables, quoting tricks, `eval`, scripts that run git inside).
- Over-denies remain: `git reset HEAD~1; echo --hard` and `git clean -d; rm -f x` are denied.

## Deliberate behaviour changes

1. The shell's `set -o pipefail` with `echo | grep -q` could flakily miss a match on commands over about 64 KiB
   (SIGPIPE). The mod is deterministic.
2. A non-string command passes through (unreachable under the Bash schema).

## Tests

`claude plugin test my-plugins/git-guard` runs `tests/guard.test.ts` (the golden corpus in `tests/corpus.ts` through
`$.tool.call`, deny-reason text, and 1 MB performance cases). Parity with the shell script was proven by running
the original script and the mod over the same corpus plus random fuzz.

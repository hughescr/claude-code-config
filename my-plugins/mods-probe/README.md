# mods-probe

A flag tracker for Claude Code hooks modules ("mods"). Mods load only while the server-side GrowthBook flag
`tengu_plugin_hooks_modules` is ON for the process; while it is off, every hooks module is silently skipped. This
plugin turns that silence into evidence.

On `session.start` its module does two things:

1. Writes one transcript line: `mods-probe: hooks modules are ON in this process (logged to ~/.claude/mods-flag.log)`.
   A transcript line (`$.ui.log`) was chosen over a toast: a toast lasts 4 s and can be missed or not yet drawn at
   launch, while the line persists, and `-p`/SDK/desktop hosts receive it as `ui_log`.
2. Appends one line to `~/.claude/mods-flag.log`:

   ```
   2026-10-01T12:34:56.789Z session=<id|?> surface=<terminal|desktop|vscode|mobile|none> interactive=<true|false> version=<claude version|?> on
   ```

   `surface=none` is normal for a host that draws nowhere yet at start (some SDK/desktop sessions).

## Reading the log

The module never runs while the flag is off, so the probe alone can only say "on": silence from it means off or
unknown. The "off" half comes from a companion **SessionStart command hook**, `hooks/mods-flag-reconcile.ts` in
the `~/.claude` repo (wired in `~/.claude/settings.json`, run with `/opt/homebrew/bin/bun`). Settings hooks are not
gated by the flag, so it runs in every process and appends to the same log:

```
2026-10-01T12:34:56.000Z session=<id> source=<startup|resume|fork> pid=<claude pid|?> start
2026-10-01T12:34:56.789Z session=<id> surface=terminal interactive=true version=2.1.287 on        # this plugin
2026-10-01T12:38:10.000Z session=<id> pid=<claude pid|?> for_start=2026-10-01T12:34:56.000Z inferred off
```

One grammar for all three: `<ISO time> key=value... <state>`, the **last token is the state** (`start`, `on`,
`off`), `session=` is required. The rules:

- Each new claude process writes one `start`. `/clear` and compact keep the process and the probe's
  `session.start` does not fire for them, so they write nothing. A resume writes a `start` only for a new process
  (a pid with no `start` since it launched).
- A `start` older than 2 minutes with no `on` for the same session from 30 s before to 5 minutes after it gets
  one `inferred off` line on the next session start in any process. That line is also the marker that stops it
  being inferred again. The `on` of a session whose id the probe could not read (`session=?`) counts for any
  start near it.
- So **`on` = mods were on; `inferred off` = the process started and never logged `on`**. A `start` younger than
  2 minutes is still pending.

Report (read-only, also counts starts that are due an `off` but not yet marked; days are UTC, an off counts on its
start's day):

```bash
bun ~/.claude/hooks/mods-flag-reconcile.ts --report
# day         starts    on   off
# 2026-10-01       6     4     2
# total            6     4     2
# latest: off at 2026-10-01T12:34:56.000Z
# last transition: on -> off at 2026-10-01T12:34:56.000Z
```

Raw views (only `on`/`off` lines count; `start` lines are the denominator):

```bash
tail -n 20 ~/.claude/mods-flag.log
grep ' on$' ~/.claude/mods-flag.log | cut -dT -f1 | sort | uniq -c    # on-sessions per day
grep ' off$' ~/.claude/mods-flag.log | cut -dT -f1 | sort | uniq -c   # inferred offs per day (by inference time)
```

Limits. A reload of the module while a session runs (hot reload, enable) raises `session.start` again, so a
session can occasionally log `on` twice. The probe trims the file to its newest 2000 lines on each `on`, by
read-modify-write, so a `start` the hook appended during that instant can be lost (harmless: a lost `start` never
produces an `off`). Two probes writing in the same instant can lose an `on`, which would show as a false `off`.
The hook never rewrites the file except to trim an oversized one (over 1 MiB, only when mods have been off long
enough for the probe not to trim), by an atomic rename. If the probe does not report the resumed session's id the
way the hook sees it, a resumed process can look like an `off`. A claude pid that cannot be found (a sandboxed
`ps`) is logged as `pid=?`.

Cross-check the cached flag value with `jq '.cachedGrowthBookFeatures.tengu_plugin_hooks_modules' ~/.claude.json`.

## How it loads

Installed from the `craigs-claude-plugins` marketplace and enabled in `~/.claude/settings.json`
(`enabledPlugins`), which covers every session on this machine in any directory: the CLI (with or without
`claude-smart.sh`) and the desktop app, which share user settings. `claude-smart.sh --plugin-dir` is not used: it
only loads plugins by project type and never reaches the desktop app.

After editing the module, bump `version` in `.claude-plugin/plugin.json`, then
`claude plugin marketplace update craigs-claude-plugins && claude plugin update mods-probe@craigs-claude-plugins`
and restart sessions. See `my-plugins/MODS-ACTIVATION.md`.

## Check it

```bash
claude plugin validate my-plugins/mods-probe
DISABLE_GROWTHBOOK=1 claude plugin test my-plugins/mods-probe   # one-off only: never put this in a launcher or settings
```

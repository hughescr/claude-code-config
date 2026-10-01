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

The module never runs while the flag is off, so **every line means "on"; silence means off or unknown** (the probe
was not loaded, the session predates the install, the flag was off, or the write failed). The log cannot record
"off".

```bash
tail -n 20 ~/.claude/mods-flag.log          # recent sessions
wc -l < ~/.claude/mods-flag.log             # total "on" sessions
cut -d' ' -f1 ~/.claude/mods-flag.log | cut -dT -f1 | sort | uniq -c   # on-sessions per day
```

Compare against how many sessions you actually started: a day with sessions but no lines means the flag was off
for those. A reload of the module while a session runs (hot reload, enable) raises `session.start` again, so a
session can occasionally log twice. The file is trimmed to its newest 2000 lines. Two sessions starting in the same
instant can lose one line.

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

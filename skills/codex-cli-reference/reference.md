# Codex Invocation Reference — Details

Companion to `SKILL.md`. Covers the wrapper scripts, session management, output format, permissions, and troubleshooting.

## Wrapper Scripts

All three scripts live in `~/.claude/scripts/codex/` and must be run with `dangerouslyDisableSandbox: true`.

Binary resolution (codex-start.sh): uses `codex` if it is on `PATH`, otherwise falls back to `/opt/homebrew/bin/bunx @openai/codex`.

### codex-start.sh

Starts Codex in the background with lock-based completion tracking. Codex is invoked as `exec -s workspace-write -c approval_policy="never" --json`.

**Usage**:
```bash
~/.claude/scripts/codex/codex-start.sh <working-dir> <query-file> [session-id]
```

**Parameters**:
- `working-dir` — Absolute path to workspace, passed via `-C` (required)
- `query-file` — Path to a file containing the query text (required)
- `session-id` — UUID session id for resume; when present the script invokes `resume <session-id>` (optional)

**Returns**: RUNDIR path on stdout (e.g., `/tmp/claude/codex.X1y2Z3`).

**Exit Codes**:
- `0` — Codex started; RUNDIR path printed. Script returns immediately after the lock is confirmed held; Codex runs in the background.
- `1` — Error (too few arguments, working directory not found, or query file missing).

**RUNDIR contents** (five entries):
- `output` — raw JSONL: Codex stdout with interleaved stderr (debugging only)
- `exitcode` — Codex's exit code
- `lock` — the `lockf` lock file (held while Codex runs)
- `ready` — a FIFO used for the startup handshake (blocks the launcher until the lock is held)
- `run.sh` — the generated runner script with safely-quoted arguments

### codex-wait.sh

Blocks waiting for Codex to finish, using `lockf -s -t 600` (a 10-minute shared-lock wait).

**Usage**:
```bash
~/.claude/scripts/codex/codex-wait.sh <rundir>
```

**Parameters**:
- `rundir` — The RUNDIR path returned by codex-start.sh

**Behavior**: on success it greps `^{` lines from `<rundir>/output` and jq-extracts the `item.completed` / `agent_message` `.item.text`, printing that text to **stdout**. So the human-readable response IS the stdout of this script.

**Exit Codes** (caller-visible contract):
- `0` — Done. The agent response is on stdout.
- **Any nonzero** — Not done yet: Codex is still running OR the 10-minute wait elapsed. The two are indistinguishable to the caller, so just call again. (There is no distinct timeout signal.)

Codex may take 30+ minutes on complex tasks; keep calling until exit 0.

### codex-get-session-id.sh

Extracts the session ID for resume from the `thread.started` event in the output.

**Usage**:
```bash
~/.claude/scripts/codex/codex-get-session-id.sh <rundir>
```

**Parameters**:
- `rundir` — The RUNDIR path returned by codex-start.sh

**Returns**: the UUID session id (the top-level `.thread_id` from the first `thread.started` line) on stdout.

**Exit Codes**:
- `0` — Session ID found and printed.
- `1` — Error (bad arguments, RUNDIR missing, output file missing, or no session ID found).

Only works after Codex has produced its `thread.started` event (i.e., once a run has begun / completed).

## Session Management

### Starting a New Session

```
Bash({ command: "mktemp /tmp/claude/codex-query.XXXXXX" })
# → /tmp/claude/codex-query.a1B2c3

Write({ file_path: "/tmp/claude/codex-query.a1B2c3", content: "Analyze the codebase" })

Bash({
  command: "~/.claude/scripts/codex/codex-start.sh /path/to/workspace /tmp/claude/codex-query.a1B2c3",
  dangerouslyDisableSandbox: true
})
# → /tmp/claude/codex.X1y2Z3
```

### Extracting the Session ID

```
Bash({
  command: "~/.claude/scripts/codex/codex-get-session-id.sh /tmp/claude/codex.X1y2Z3",
  dangerouslyDisableSandbox: true
})
# → 019e7072-675a-7312-b0dc-a040ab91cda9
```

Session IDs are UUIDs, not opaque short tokens.

### Resuming a Session

Pass the session ID as the third argument to codex-start.sh:

```
Bash({
  command: "~/.claude/scripts/codex/codex-start.sh /path/to/workspace /tmp/claude/codex-query.b2C3d4 019e7072-675a-7312-b0dc-a040ab91cda9",
  dangerouslyDisableSandbox: true
})
```

## Output Format

Codex is invoked `exec -s workspace-write -c approval_policy="never" --json`, streaming JSONL to `<rundir>/output` (mixed with stderr). Each line is one event keyed by the top-level `.type`.

**Verified event types**:
- `thread.started` — emitted once. Shape `{"type":"thread.started","thread_id":"<uuid>"}`. The top-level `.thread_id` is the session id used for resume (consumed by codex-get-session-id.sh).
- `turn.started`
- `item.started` — an in-progress item.
- `item.completed` — a completed item; carries `.item` with `.item.type`. The agent's reply is an `item.completed` with `.item.type == "agent_message"`, text in `.item.text` (consumed by codex-wait.sh).
- `turn.completed` — carries `.usage` token counts.

**Observed item types** (non-exhaustive — other types such as reasoning or file-change may exist but were not observed in the sampled runs):
- `agent_message` — the assistant text reply; text in `.item.text`.
- `command_execution` — a shell command Codex ran; keys include `command`, `exit_code`, `aggregated_output`, `status`.

Note: there are no streaming message-delta or message-completed events in this stream — the agent reply is not chunked; it arrives as a single `item.completed` / `agent_message`.

## Permission Notes

The wrapper scripts invoke `codex exec` with `-s workspace-write -c approval_policy="never"` (replacing the now-deprecated `--full-auto` shorthand).

Verified from `codex --help` / `codex exec --help`:
- `-s, --sandbox workspace-write` — sandbox policy allowing file modifications within the workspace (one of `read-only` / `workspace-write` / `danger-full-access`). This is exactly what the deprecation message recommends.
- `approval_policy="never"` (set via the documented `-c key=value` config override) — the `never` approval policy. The help text describes `never` as "Never ask for user approval" and explicitly recommends it "for non-interactive runs." This guarantees the headless background run never blocks on an approval prompt.

Note: `codex exec` (the non-interactive subcommand the scripts use) does not even expose the `-a/--ask-for-approval` flag — only the top-level `codex` command does — so approval policy is pinned through `-c approval_policy="never"`. Empirically a smoke-test run with these flags completed cleanly with no approval prompt and no deprecation warning.

The previous `--full-auto` shorthand set sandbox `workspace-write` plus an approval policy; per Codex CLI behavior (not fully verified from the scripts) it enabled file modifications within the workspace. It is now deprecated in favor of the explicit flags above.

## Troubleshooting

### Heredoc Blocked Error
If you see "BLOCKED: Creating files via heredoc is forbidden", you used `<< EOF` syntax. Use the `Write` tool instead. (Operational convention: the `block-temp-planning-files.sh` hook blocks heredocs.)

### Sandbox Permission Error
If the wrapper scripts fail with permission errors, ensure `dangerouslyDisableSandbox: true` is set and that the working directory path is valid.

### Wait Returns Nonzero = Call Again
If `codex-wait.sh` returns a nonzero exit code, Codex is either still running or the 10-minute wait elapsed (indistinguishable). This is normal for complex tasks. Just keep calling the wait script until it returns 0. Codex can take 30+ minutes on large tasks.

### Session Not Found
If resume fails with "session not found": the session may have expired, or the session id may be incorrect. Start a new session instead.

### Deprecation Warning in Output
The script now invokes `codex exec` with the current `-s workspace-write -c approval_policy="never"` flags, so the old `warning: --full-auto is deprecated; ...` line should no longer appear in `<rundir>/output`. If you do see it, the script is out of date — it should not be passing `--full-auto` anymore.

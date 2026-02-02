---
name: codex-cli-reference
description: Reference documentation for invoking Codex through the wrapper scripts. This skill should be used when calling Codex, invoking Codex CLI, delegating tasks to Codex, running Codex in background, or managing Codex sessions. Covers codex-start.sh, codex-wait.sh, codex-get-session-id.sh, query file handling, and session management.
version: 2.0.0
---

# Codex Invocation Reference

Reference documentation for invoking OpenAI Codex through the Claude Code wrapper scripts.

## ⛔ Critical Rules

**NEVER use heredocs** for file creation - they are blocked by hooks. Use the `Write` tool.

**NEVER invoke `codex exec` directly** - use the wrapper scripts documented below.

## Workflow Overview

Invoking Codex requires these steps:

1. **Create query file** - `mktemp /tmp/claude/codex-query.XXXXXX`
2. **Write query** - `Write({ file_path, content })` (NOT heredoc)
3. **Start Codex** - `codex-start.sh <workdir> <query-file> [session-id]`
4. **Wait for completion** - `codex-wait.sh <rundir>` (repeat until exit 0)
5. **Read output** - `Read({ file_path: "<rundir>/output" })`
6. **Get session ID** (for follow-ups) - `codex-get-session-id.sh <rundir>`

## Wrapper Scripts

### codex-start.sh

Starts Codex in the background with lock-based completion tracking.

**Location**: `~/.claude/plugins/codex/scripts/codex-start.sh`

**Usage**:
```bash
~/.claude/plugins/codex/scripts/codex-start.sh <working-dir> <query-file> [session-id]
```

**Parameters**:
- `working-dir` - Absolute path to workspace (required)
- `query-file` - Path to file containing the query text (required)
- `session-id` - Thread ID for session resume (optional)

**Returns**: RUNDIR path (e.g., `/tmp/claude/codex.A1b2C3`)

**Exit Codes**:
- `0` - Codex started successfully, RUNDIR path output
- `1` - Error (invalid arguments, directory not found, or query file missing)

**Notes**:
- Must use `dangerouslyDisableSandbox: true` for Bash tool
- The RUNDIR contains: `output` (Codex JSONL response), `exitcode` (Codex exit code)
- Script returns immediately after lock is acquired; Codex runs in background

### codex-wait.sh

Waits for Codex to complete using lock-based detection.

**Location**: `~/.claude/plugins/codex/scripts/codex-wait.sh`

**Usage**:
```bash
~/.claude/plugins/codex/scripts/codex-wait.sh <rundir>
```

**Parameters**:
- `rundir` - The RUNDIR path returned by codex-start.sh

**Exit Codes**:
- `0` - Codex finished (read `<rundir>/output` for response)
- `1` - Timeout (10 min) or still running (call again)

**Notes**:
- Codex may take 30+ minutes on complex tasks
- Keep calling until exit code 0
- Must use `dangerouslyDisableSandbox: true` for Bash tool

### codex-get-session-id.sh

Extracts the session ID from Codex output for session resume.

**Location**: `~/.claude/plugins/codex/scripts/codex-get-session-id.sh`

**Usage**:
```bash
~/.claude/plugins/codex/scripts/codex-get-session-id.sh <rundir>
```

**Parameters**:
- `rundir` - The RUNDIR path returned by codex-start.sh

**Returns**: Session ID (thread_id) on stdout

**Exit Codes**:
- `0` - Session ID found and output
- `1` - No session ID found in output

**Notes**:
- Must use `dangerouslyDisableSandbox: true` for Bash tool
- Only works after Codex has completed (wait script returns 0)
- The session ID is needed for follow-up queries

## Query File Handling

Queries are passed via file to avoid shell escaping issues.

**Step 1: Create unique file path**
```
Bash({ command: "mktemp /tmp/claude/codex-query.XXXXXX" })
```

**Step 2: Write query content**
```
Write({ file_path: "/tmp/claude/codex-query.a1B2c3", content: "USER_QUERY_VERBATIM" })
```

⚠️ **NEVER use heredocs** - the `block-temp-planning-files.sh` hook will block them.

## Session Management

### Starting a New Session

```
Bash({ command: "mktemp /tmp/claude/codex-query.XXXXXX" })
# → /tmp/claude/codex-query.a1B2c3

Write({ file_path: "/tmp/claude/codex-query.a1B2c3", content: "Analyze the codebase" })

Bash({
  command: "~/.claude/plugins/codex/scripts/codex-start.sh /path/to/workspace /tmp/claude/codex-query.a1B2c3",
  dangerouslyDisableSandbox: true
})
# → /tmp/claude/codex.X1y2Z3
```

### Extracting Session ID

After Codex completes, extract the session ID using the helper script:

```
Bash({
  command: "~/.claude/plugins/codex/scripts/codex-get-session-id.sh /tmp/claude/codex.X1y2Z3",
  dangerouslyDisableSandbox: true
})
# → thread_abc123
```

### Resuming a Session

Pass the session ID as the third argument:

```
Bash({
  command: "~/.claude/plugins/codex/scripts/codex-start.sh /path/to/workspace /tmp/claude/codex-query.b2C3d4 thread_abc123",
  dangerouslyDisableSandbox: true
})
```

## Output Format

Codex outputs JSONL when invoked with `--json` (the wrapper scripts use this).

**Key events**:
- `thread.started` - Contains `thread_id` for session resume
- `message.delta` - Streaming response chunks
- `message.completed` - Final response

## Permission Notes

The wrapper scripts invoke Codex with `--full-auto`, which:
- Sets sandbox mode to `workspace-write`
- Sets approval policy to `on-request`
- Enables file modifications within the workspace

## Troubleshooting

### Heredoc Blocked Error

If you see "BLOCKED: Creating files via heredoc is forbidden":
- You used `<< EOF` syntax
- Use `Write` tool instead

### Sandbox Permission Error

If the wrapper scripts fail with permission errors:
- Ensure `dangerouslyDisableSandbox: true` is set
- Check the working directory path is valid

### Wait Script Returns 1

If `codex-wait.sh` keeps returning exit code 1:
- Codex is still running (normal for complex tasks)
- Keep calling the wait script until exit code 0
- Codex can take 30+ minutes on large tasks

### Session Not Found

If resume fails with "session not found":
- The session may have expired
- The thread ID may be incorrect
- Start a new session instead

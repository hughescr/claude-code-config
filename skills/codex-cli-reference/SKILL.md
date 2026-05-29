---
name: codex-cli-reference
description: Reference documentation for invoking Codex through the wrapper scripts. This skill should be used when calling Codex, invoking Codex CLI, delegating tasks to Codex, running Codex in background, or managing Codex sessions. Covers codex-start.sh, codex-wait.sh, codex-get-session-id.sh, query file handling, and session management.
---

# Codex Invocation Reference

Quickstart for invoking OpenAI Codex through the Claude Code wrapper scripts.

## ⛔ Critical Rules

**NEVER use heredocs** for file creation — they are blocked by hooks. Use the `Write` tool.

**NEVER invoke `codex exec` directly** — always use the wrapper scripts.

## Workflow

1. **Create query file** — `mktemp /tmp/claude/codex-query.XXXXXX`
2. **Write query** — `Write({ file_path, content })` (NOT heredoc)
3. **Start Codex** — `codex-start.sh <workdir> <query-file> [session-id]` → prints RUNDIR
4. **Wait for completion** — `codex-wait.sh <rundir>`; repeat until exit 0 (any nonzero = call again)
5. **Read the response** — it is the **stdout of `codex-wait.sh`** (the extracted agent reply). The `<rundir>/output` file is raw JSONL for debugging only.
6. **Get session ID** (for follow-ups) — `codex-get-session-id.sh <rundir>`

## Minimal Session Example

```
Bash({ command: "mktemp /tmp/claude/codex-query.XXXXXX" })
# → /tmp/claude/codex-query.a1B2c3

Write({ file_path: "/tmp/claude/codex-query.a1B2c3", content: "Analyze the codebase" })

Bash({
  command: "~/.claude/scripts/codex/codex-start.sh /path/to/workspace /tmp/claude/codex-query.a1B2c3",
  dangerouslyDisableSandbox: true
})
# → /tmp/claude/codex.X1y2Z3   (RUNDIR)

Bash({
  command: "~/.claude/scripts/codex/codex-wait.sh /tmp/claude/codex.X1y2Z3",
  dangerouslyDisableSandbox: true
})
# exit 0 → stdout IS the agent's response. Any nonzero → call again.

Bash({
  command: "~/.claude/scripts/codex/codex-get-session-id.sh /tmp/claude/codex.X1y2Z3",
  dangerouslyDisableSandbox: true
})
# → 019e7072-675a-7312-b0dc-a040ab91cda9   (UUID session id, for resume)
```

`dangerouslyDisableSandbox: true` is required for all three scripts (stryker-incremental.json and the lock dir are sandbox-protected).

For per-script parameter tables, output format, resume/session details, and troubleshooting, see `reference.md`.

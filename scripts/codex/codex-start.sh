#!/bin/bash
# codex-start.sh - Start Codex in background with lock-based completion detection
# Usage: codex-start.sh <working-dir> <query-file> [resume-session-id]
# Args:
#   working-dir: Path to workspace (-C flag)
#   query-file: Path to file containing the query
#   resume-session-id: Optional session ID for resume
# Returns: RUNDIR path on stdout

set -e

# Determine codex command (aliases don't load in non-interactive shells)
if command -v codex &>/dev/null; then
    CODEX_BIN="codex"
else
    CODEX_BIN="/opt/homebrew/bin/bunx @openai/codex"
fi

# Validate arguments
if [ $# -lt 2 ]; then
    echo "Usage: codex-start.sh <working-dir> <query-file> [resume-session-id]" >&2
    exit 1
fi

WORKING_DIR="$1"
QUERY_FILE="$2"
SESSION_ID="${3:-}"

# Validate working directory exists
if [ ! -d "$WORKING_DIR" ]; then
    echo "Error: Working directory does not exist: $WORKING_DIR" >&2
    exit 1
fi

# Validate query file exists
if [ ! -f "$QUERY_FILE" ]; then
    echo "Error: Query file does not exist: $QUERY_FILE" >&2
    exit 1
fi

# Read query from file
QUERY=$(cat "$QUERY_FILE")

# Create unique run directory
RUNDIR=$(mktemp -d /tmp/claude/codex.XXXXXX)
mkfifo "$RUNDIR/ready"

# Build codex command
if [ -n "$SESSION_ID" ]; then
    # Resume existing session
    CODEX_CMD="$CODEX_BIN exec --full-auto --json resume $SESSION_ID -C \"$WORKING_DIR\" \"$QUERY\""
else
    # Start new session
    CODEX_CMD="$CODEX_BIN exec --full-auto --json -C \"$WORKING_DIR\" \"$QUERY\""
fi

# Background subshell: holds lock while codex runs
(
    lockf "$RUNDIR/lock" sh -c "
        echo ready > \"$RUNDIR/ready\"
        $CODEX_CMD > \"$RUNDIR/output\" 2>&1
        echo \"\$?\" > \"$RUNDIR/exitcode\"
    "
) &

# Block until lock is confirmed held
read < "$RUNDIR/ready"

# Output the run directory path
echo "$RUNDIR"

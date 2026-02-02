#!/bin/bash
# codex-get-session-id.sh - Extract session ID from Codex output
# Usage: codex-get-session-id.sh <RUNDIR>
# Args:
#   RUNDIR: Path to the run directory (e.g., /tmp/claude/codex.A1b2C3)
# Returns: Session ID (thread_id) on stdout
# Exit code: 0 = success, 1 = no session ID found

set -e

# Validate arguments
if [ $# -ne 1 ]; then
    echo "Usage: codex-get-session-id.sh <RUNDIR>" >&2
    exit 1
fi

RUNDIR="$1"

# Validate RUNDIR exists
if [ ! -d "$RUNDIR" ]; then
    echo "Error: RUNDIR does not exist: $RUNDIR" >&2
    exit 1
fi

# Validate output file exists
if [ ! -f "$RUNDIR/output" ]; then
    echo "Error: Output file does not exist: $RUNDIR/output" >&2
    exit 1
fi

# Extract session ID from thread.started event
SESSION_ID=$(grep '"thread.started"' "$RUNDIR/output" | head -1 | jq -r '.thread_id')

# Validate we got a session ID
if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
    echo "Error: No session ID found in output" >&2
    exit 1
fi

echo "$SESSION_ID"
exit 0

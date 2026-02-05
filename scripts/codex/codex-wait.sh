#!/bin/bash
# codex-wait.sh - Wait for Codex to complete using lock-based blocking
# Usage: codex-wait.sh <RUNDIR>
# Exit code: 0 = done, 1 = timeout/still running

set -e

# Validate arguments
if [ $# -ne 1 ]; then
    echo "Usage: codex-wait.sh <RUNDIR>" >&2
    exit 1
fi

RUNDIR="$1"

# Validate RUNDIR exists
if [ ! -d "$RUNDIR" ]; then
    echo "Error: RUNDIR does not exist: $RUNDIR" >&2
    exit 1
fi

# Validate lock file exists
if [ ! -e "$RUNDIR/lock" ]; then
    echo "Error: Lock file does not exist: $RUNDIR/lock" >&2
    exit 1
fi

# Try to acquire shared lock with 10-minute timeout
# -s = silent (no error messages)
# -t 600 = timeout after 600 seconds
lockf -s -t 600 "$RUNDIR/lock" true
RC=$?

# Check result: lock acquired AND exitcode file exists = done
if [ $RC -eq 0 ] && [ -f "$RUNDIR/exitcode" ]; then
    cat "$RUNDIR/exitcode"
    exit 0
fi

exit 1

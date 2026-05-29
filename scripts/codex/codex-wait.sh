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

# Completion is signaled by run.sh writing $RUNDIR/exitcode after Codex exits.
# The lock file is removed by lockf on release, so a fast-finishing run may have
# completed (exitcode present) with the lock file already gone. Treat exitcode as
# the authoritative "done" signal, regardless of whether the lock file still exists.

if [ -f "$RUNDIR/exitcode" ]; then
    # Codex is DONE (lock may or may not still exist). Extract and exit 0.
    # Extract agent message text from JSONL output (skip non-JSON stderr lines)
    grep '^{' "$RUNDIR/output" | jq -r 'select(.type == "item.completed" and .item.type == "agent_message") | .item.text'
    exit 0
elif [ -e "$RUNDIR/lock" ]; then
    # Codex is still running; block on a shared lock with 10-minute timeout.
    # -s = silent (no error messages), -t 600 = timeout after 600 seconds.
    # Guard against set -e: a lockf timeout returns nonzero and must not abort
    # the script before we can re-check / return the "call again" signal.
    if lockf -s -t 600 "$RUNDIR/lock" true && [ -f "$RUNDIR/exitcode" ]; then
        # Lock acquired (codex released it) and exitcode present = done.
        grep '^{' "$RUNDIR/output" | jq -r 'select(.type == "item.completed" and .item.type == "agent_message") | .item.text'
        exit 0
    fi
    # Lock timed out, or released but exitcode not yet written: not done, call again.
    exit 1
else
    # Neither exitcode nor lock exists: run never started or RUNDIR is invalid.
    echo "Error: No lock file and no exitcode in RUNDIR: $RUNDIR" >&2
    exit 1
fi

#!/bin/bash
# codex-start.sh - Start Codex in background with lock-based completion detection
# Usage: codex-start.sh <working-dir> <query-file> [resume-session-id]
# Args:
#   working-dir: Path to workspace (-C flag)
#   query-file: Path to file containing the query
#   resume-session-id: Optional session ID for resume
# Returns: RUNDIR path on stdout

set -e

# Determine codex binary as array (handles the space in bunx path)
if command -v codex &>/dev/null; then
    CODEX_BIN_ARRAY=(codex)
else
    CODEX_BIN_ARRAY=(/opt/homebrew/bin/bunx "@openai/codex")
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

# Build full command as array
# --skip-git-repo-check: these runs are always headless/unattended (approval_policy
# is already forced to "never" below, so there is no one present to interactively
# grant trust anyway). Without this flag, codex refuses to start whenever the
# working directory is neither a recognized git repo nor already marked
# trust_level = "trusted" in ~/.codex/config.toml, exiting immediately with
# "Not inside a trusted directory and --skip-git-repo-check was not specified."
# before emitting any JSONL — which codex-wait.sh would otherwise be unable to
# distinguish from a genuinely empty response.
CODEX_ARGS=("${CODEX_BIN_ARRAY[@]}" exec -s workspace-write -c approval_policy="never" --skip-git-repo-check --json)
[ -n "$SESSION_ID" ] && CODEX_ARGS+=(resume "$SESSION_ID")
CODEX_ARGS+=(-C "$WORKING_DIR" "$QUERY")

# Write a bash runner script with properly-quoted arguments
# Using printf '%q' ensures all special chars in query/paths are safely escaped
{
    printf '#!/bin/bash\n'
    printf 'echo ready > %q\n' "$RUNDIR/ready"
    printf '%q ' "${CODEX_ARGS[@]}"
    printf '> %q 2>&1\n' "$RUNDIR/output"
    printf 'echo $? > %q\n' "$RUNDIR/exitcode"
} > "$RUNDIR/run.sh"
chmod +x "$RUNDIR/run.sh"

# Background subshell: holds lock while codex runs
(lockf "$RUNDIR/lock" "$RUNDIR/run.sh") &

# Block until lock is confirmed held
read < "$RUNDIR/ready"

# Output the run directory path
echo "$RUNDIR"

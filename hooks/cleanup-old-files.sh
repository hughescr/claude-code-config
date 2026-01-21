#!/bin/bash
# Clean up Claude Code temp files older than 3 days
# Runs silently at end of each session
#
# Smart cleanup logic:
# - Preserves CLI sessions that are linked to Desktop sessions
# - Deletes orphaned CLI sessions older than 3 days
# - Always cleans up debug logs and shell snapshots older than 3 days
#
# Usage:
#   cleanup-old-files.sh           # Silent cleanup (default)
#   cleanup-old-files.sh --dry-run # Show what would be deleted
#   cleanup-old-files.sh -n        # Same as --dry-run

# Parse arguments
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run|-n)
            DRY_RUN=true
            ;;
    esac
done

# Define paths
DESKTOP_SESSIONS="${HOME}/Library/Application Support/Claude/claude-code-sessions"
CLI_PROJECTS="${HOME}/.claude/projects"
DEBUG_DIR="${HOME}/.claude/debug"
SHELL_SNAPSHOTS="${HOME}/.claude/shell-snapshots"

# Initialize counters for dry-run summary
sessions_to_delete=0
sessions_protected=0
debug_files_to_delete=0
shell_snapshots_to_delete=0

# Step 1: Collect protected session IDs from active (non-archived) Desktop sessions
# Desktop sessions contain a cliSessionId field that references CLI session files
# Only non-archived sessions are protected - archived sessions can have their CLI data cleaned up
protected_ids=""
archived_count=0
if [[ -d "$DESKTOP_SESSIONS" ]]; then
    protected_ids=$(find "$DESKTOP_SESSIONS" -name "local_*.json" -exec jq -r 'select(.isArchived != true) | .cliSessionId // empty' {} \; 2>/dev/null | sort -u)
    archived_count=$(find "$DESKTOP_SESSIONS" -name "local_*.json" -exec jq -r 'select(.isArchived == true) | .cliSessionId // empty' {} \; 2>/dev/null | grep -c . || echo 0)
fi

# Dry-run: Print header and protected session IDs
if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== Smart Session Cleanup (DRY RUN) ==="
    echo ""
    echo "Protected Session IDs (linked to active Desktop sessions):"
    if [[ -n "$protected_ids" ]]; then
        echo "$protected_ids" | while read -r id; do
            [[ -n "$id" ]] && echo "  - $id"
        done
    else
        echo "  (none)"
    fi
    if [[ "$archived_count" -gt 0 ]]; then
        echo "  (${archived_count} archived session(s) NOT protected)"
    fi
    echo ""
fi

# Step 2: Clean up old CLI sessions selectively
# Only delete sessions that are:
# - Older than 3 days
# - NOT referenced by any Desktop session (not in protected_ids)
if [[ "$DRY_RUN" == "true" ]]; then
    echo "CLI Sessions older than 3 days:"
fi

if [[ -d "$CLI_PROJECTS" ]]; then
    find "$CLI_PROJECTS" -mindepth 2 -type f -name "*.jsonl" -mtime +3 2>/dev/null | while read -r session_file; do
        # Extract session ID from filename (remove .jsonl extension)
        session_id=$(basename "$session_file" .jsonl)

        # Check if this session is protected (linked to a Desktop session)
        # Delete only if not in protected list (avoid ! for zsh compatibility)
        if [[ -n "$protected_ids" ]] && echo "$protected_ids" | grep -qx "$session_id"; then
            # Session is protected, do not delete
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  PROTECTED: $session_file (linked to Desktop)"
                # Write to temp file for counting (subshell workaround)
                echo "protected" >> /tmp/claude/cleanup_protected_count_$$ 2>/dev/null
            fi
        else
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  WOULD DELETE: $session_file"
                # Write to temp file for counting (subshell workaround)
                echo "delete" >> /tmp/claude/cleanup_delete_count_$$ 2>/dev/null
            else
                rm "$session_file" 2>/dev/null
            fi
        fi
    done
fi

# Dry-run: Read counts from temp files (needed due to subshell)
if [[ "$DRY_RUN" == "true" ]]; then
    if [[ -f /tmp/claude/cleanup_delete_count_$$ ]]; then
        sessions_to_delete=$(wc -l < /tmp/claude/cleanup_delete_count_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_delete_count_$$ 2>/dev/null
    fi
    if [[ -f /tmp/claude/cleanup_protected_count_$$ ]]; then
        sessions_protected=$(wc -l < /tmp/claude/cleanup_protected_count_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_protected_count_$$ 2>/dev/null
    fi
    echo ""
fi

# Step 3: Clean up diagnostic files (always safe to delete)
# These are temporary files that don't need to be preserved
if [[ "$DRY_RUN" == "true" ]]; then
    debug_files_to_delete=$(find "$DEBUG_DIR" -type f -mtime +3 2>/dev/null | wc -l | tr -d ' ')
    shell_snapshots_to_delete=$(find "$SHELL_SNAPSHOTS" -type f -mtime +3 2>/dev/null | wc -l | tr -d ' ')
else
    find "$DEBUG_DIR" -type f -mtime +3 -delete 2>/dev/null
    find "$SHELL_SNAPSHOTS" -type f -mtime +3 -delete 2>/dev/null
fi

# Step 4: Clean up empty directories in projects folder
# After deleting session files, some project directories may be empty
if [[ "$DRY_RUN" != "true" ]]; then
    find "$CLI_PROJECTS" -type d -empty -delete 2>/dev/null
fi

# Dry-run: Print summary
if [[ "$DRY_RUN" == "true" ]]; then
    echo "Summary:"
    echo "  Sessions to delete: $sessions_to_delete"
    echo "  Sessions protected: $sessions_protected"
    echo "  Debug files to delete: $debug_files_to_delete"
    echo "  Shell snapshots to delete: $shell_snapshots_to_delete"
fi

# Hook requirement: always exit 0
exit 0

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
TODOS_DIR="${HOME}/.claude/todos"
PLANS_DIR="${HOME}/.claude/plans"
TASKS_DIR="${HOME}/.claude/tasks"
PASTE_CACHE="${HOME}/.claude/paste-cache"
FILE_HISTORY="${HOME}/.claude/file-history"

# Initialize counters for dry-run summary
sessions_to_delete=0
sessions_protected=0
debug_files_to_delete=0
shell_snapshots_to_delete=0
todos_to_delete=0
plans_to_delete=0
tasks_to_delete=0
tasks_protected=0
paste_cache_to_delete=0
file_history_to_delete=0
file_history_protected=0

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
    echo "CLI Sessions older than 14 days:"
fi

if [[ -d "$CLI_PROJECTS" ]]; then
    find "$CLI_PROJECTS" -mindepth 2 -type f -name "*.jsonl" -mtime +14 2>/dev/null | while read -r session_file; do
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

# Step 4: Clean up simple directories (todos, plans, paste-cache)
# These have no session protection needed
if [[ "$DRY_RUN" == "true" ]]; then
    todos_to_delete=$(find "$TODOS_DIR" -type f -mtime +14 2>/dev/null | wc -l | tr -d ' ')
    plans_to_delete=$(find "$PLANS_DIR" -type f -mtime +14 2>/dev/null | wc -l | tr -d ' ')
    paste_cache_to_delete=$(find "$PASTE_CACHE" -type f -mtime +14 2>/dev/null | wc -l | tr -d ' ')
else
    find "$TODOS_DIR" -type f -mtime +14 -delete 2>/dev/null
    find "$PLANS_DIR" -type f -mtime +14 -delete 2>/dev/null
    find "$PASTE_CACHE" -type f -mtime +14 -delete 2>/dev/null
fi

# Step 5: Clean up old task files with session protection
# Same logic as CLI sessions - protect tasks linked to active Desktop sessions
if [[ "$DRY_RUN" == "true" ]]; then
    echo "Task files older than 14 days:"
fi

if [[ -d "$TASKS_DIR" ]]; then
    find "$TASKS_DIR" -type f -name "*.json" -mtime +14 2>/dev/null | while read -r task_file; do
        # Extract session ID from filename (remove .json extension)
        session_id=$(basename "$task_file" .json)

        # Check if this session is protected (linked to a Desktop session)
        if [[ -n "$protected_ids" ]] && echo "$protected_ids" | grep -qx "$session_id"; then
            # Session is protected, do not delete
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  PROTECTED: $task_file (linked to Desktop)"
                echo "protected" >> /tmp/claude/cleanup_tasks_protected_$$ 2>/dev/null
            fi
        else
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  WOULD DELETE: $task_file"
                echo "delete" >> /tmp/claude/cleanup_tasks_delete_$$ 2>/dev/null
            else
                rm "$task_file" 2>/dev/null
            fi
        fi
    done
fi

# Dry-run: Read task counts from temp files
if [[ "$DRY_RUN" == "true" ]]; then
    if [[ -f /tmp/claude/cleanup_tasks_delete_$$ ]]; then
        tasks_to_delete=$(wc -l < /tmp/claude/cleanup_tasks_delete_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_tasks_delete_$$ 2>/dev/null
    fi
    if [[ -f /tmp/claude/cleanup_tasks_protected_$$ ]]; then
        tasks_protected=$(wc -l < /tmp/claude/cleanup_tasks_protected_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_tasks_protected_$$ 2>/dev/null
    fi
    echo ""
fi

# Step 6: Clean up old file-history directories with session protection
# file-history contains directories named by session ID
if [[ "$DRY_RUN" == "true" ]]; then
    echo "File history directories older than 14 days:"
fi

if [[ -d "$FILE_HISTORY" ]]; then
    find "$FILE_HISTORY" -mindepth 1 -maxdepth 1 -type d -mtime +14 2>/dev/null | while read -r history_dir; do
        # Extract session ID from directory name
        session_id=$(basename "$history_dir")

        # Check if this session is protected (linked to a Desktop session)
        if [[ -n "$protected_ids" ]] && echo "$protected_ids" | grep -qx "$session_id"; then
            # Session is protected, do not delete
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  PROTECTED: $history_dir (linked to Desktop)"
                echo "protected" >> /tmp/claude/cleanup_history_protected_$$ 2>/dev/null
            fi
        else
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  WOULD DELETE: $history_dir"
                echo "delete" >> /tmp/claude/cleanup_history_delete_$$ 2>/dev/null
            else
                rm -rf "$history_dir" 2>/dev/null
            fi
        fi
    done
fi

# Dry-run: Read file-history counts from temp files
if [[ "$DRY_RUN" == "true" ]]; then
    if [[ -f /tmp/claude/cleanup_history_delete_$$ ]]; then
        file_history_to_delete=$(wc -l < /tmp/claude/cleanup_history_delete_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_history_delete_$$ 2>/dev/null
    fi
    if [[ -f /tmp/claude/cleanup_history_protected_$$ ]]; then
        file_history_protected=$(wc -l < /tmp/claude/cleanup_history_protected_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_history_protected_$$ 2>/dev/null
    fi
    echo ""
fi

# Step 7: Clean up empty directories in all managed folders
# After deleting files/directories, some parent directories may be empty
if [[ "$DRY_RUN" != "true" ]]; then
    find "$CLI_PROJECTS" -type d -empty -delete 2>/dev/null
    find "$TODOS_DIR" -type d -empty -delete 2>/dev/null
    find "$PLANS_DIR" -type d -empty -delete 2>/dev/null
    find "$TASKS_DIR" -type d -empty -delete 2>/dev/null
    find "$PASTE_CACHE" -type d -empty -delete 2>/dev/null
    find "$FILE_HISTORY" -type d -empty -delete 2>/dev/null
fi

# Dry-run: Print summary
if [[ "$DRY_RUN" == "true" ]]; then
    echo "Summary:"
    echo "  Sessions to delete: $sessions_to_delete"
    echo "  Sessions protected: $sessions_protected"
    echo "  Debug files to delete: $debug_files_to_delete"
    echo "  Shell snapshots to delete: $shell_snapshots_to_delete"
    echo "  Todos to delete: $todos_to_delete"
    echo "  Plans to delete: $plans_to_delete"
    echo "  Tasks to delete: $tasks_to_delete"
    echo "  Tasks protected: $tasks_protected"
    echo "  Paste cache to delete: $paste_cache_to_delete"
    echo "  File history dirs to delete: $file_history_to_delete"
    echo "  File history dirs protected: $file_history_protected"
fi

# Hook requirement: always exit 0
exit 0

#!/bin/bash
# Clean up Claude Code temp files using two retention tiers
# Runs silently at end of each session
#
# Smart cleanup logic (two tiers):
# - Session data is retained 60 days: CLI sessions, session dirs, sidecars,
#   plans, paste-cache, tasks, file-history, teams, session-env, and sessions.
# - Diagnostic files are retained only 3 days: debug logs, shell snapshots,
#   and telemetry.
# - Preserves CLI/session data linked to active (non-archived) Desktop
#   sessions regardless of age.
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
PLANS_DIR="${HOME}/.claude/plans"
TASKS_DIR="${HOME}/.claude/tasks"
PASTE_CACHE="${HOME}/.claude/paste-cache"
FILE_HISTORY="${HOME}/.claude/file-history"
TELEMETRY_DIR="${HOME}/.claude/telemetry"
TEAMS_DIR="${HOME}/.claude/teams"
SESSION_ENV_DIR="${HOME}/.claude/session-env"
SESSIONS_DIR="${HOME}/.claude/sessions"

# Initialize counters for dry-run summary
sessions_to_delete=0
sessions_protected=0
debug_files_to_delete=0
shell_snapshots_to_delete=0
plans_to_delete=0
tasks_to_delete=0
tasks_protected=0
paste_cache_to_delete=0
file_history_to_delete=0
file_history_protected=0
telemetry_to_delete=0
session_dirs_to_delete=0
session_dirs_protected=0
sidecar_files_to_delete=0
teams_to_delete=0
teams_protected=0
session_env_to_delete=0
session_env_protected=0
sessions_to_delete_simple=0

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
# - Older than 60 days
# - NOT referenced by any Desktop session (not in protected_ids)
if [[ "$DRY_RUN" == "true" ]]; then
    echo "CLI Sessions older than 60 days:"
fi

if [[ -d "$CLI_PROJECTS" ]]; then
    find "$CLI_PROJECTS" -mindepth 2 -type f -name "*.jsonl" -mtime +60 2>/dev/null | while read -r session_file; do
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

    # Clean up old session directories (contain subagents/, tool-results/)
    if [[ "$DRY_RUN" == "true" ]]; then
        echo ""
        echo "Session directories older than 60 days:"
    fi

    find "$CLI_PROJECTS" -mindepth 2 -maxdepth 2 -type d -mtime +60 2>/dev/null | while read -r session_dir; do
        # Extract session ID from directory name
        session_id=$(basename "$session_dir")

        # Check if this session is protected (linked to a Desktop session)
        if [[ -n "$protected_ids" ]] && echo "$protected_ids" | grep -qx "$session_id"; then
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  PROTECTED: $session_dir (linked to Desktop)"
                echo "protected" >> /tmp/claude/cleanup_session_dirs_protected_$$ 2>/dev/null
            fi
        else
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  WOULD DELETE: $session_dir"
                echo "delete" >> /tmp/claude/cleanup_session_dirs_delete_$$ 2>/dev/null
            else
                rm -rf "$session_dir" 2>/dev/null
            fi
        fi
    done

    # Clean up orphaned sidecar files older than 60 days
    if [[ "$DRY_RUN" == "true" ]]; then
        echo ""
        echo "Sidecar files older than 60 days:"
    fi

    find "$CLI_PROJECTS" -mindepth 2 -type f \( -name "*.wakatime" -o -name "*.jpg" -o -name "*.pdf" -o -name "*.docx" \) -mtime +60 2>/dev/null | while read -r sidecar_file; do
        if [[ "$DRY_RUN" == "true" ]]; then
            echo "  WOULD DELETE: $sidecar_file"
            echo "delete" >> /tmp/claude/cleanup_sidecar_delete_$$ 2>/dev/null
        else
            rm "$sidecar_file" 2>/dev/null
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
    if [[ -f /tmp/claude/cleanup_session_dirs_delete_$$ ]]; then
        session_dirs_to_delete=$(wc -l < /tmp/claude/cleanup_session_dirs_delete_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_session_dirs_delete_$$ 2>/dev/null
    fi
    if [[ -f /tmp/claude/cleanup_session_dirs_protected_$$ ]]; then
        session_dirs_protected=$(wc -l < /tmp/claude/cleanup_session_dirs_protected_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_session_dirs_protected_$$ 2>/dev/null
    fi
    if [[ -f /tmp/claude/cleanup_sidecar_delete_$$ ]]; then
        sidecar_files_to_delete=$(wc -l < /tmp/claude/cleanup_sidecar_delete_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_sidecar_delete_$$ 2>/dev/null
    fi
    echo ""
fi

# Step 3: Clean up diagnostic files (always safe to delete)
# These are temporary files that don't need to be preserved
if [[ "$DRY_RUN" == "true" ]]; then
    debug_files_to_delete=$(find "$DEBUG_DIR" -type f -mtime +3 2>/dev/null | wc -l | tr -d ' ')
    shell_snapshots_to_delete=$(find "$SHELL_SNAPSHOTS" -type f -mtime +3 2>/dev/null | wc -l | tr -d ' ')
    telemetry_to_delete=$(find "$TELEMETRY_DIR" -type f -mtime +3 2>/dev/null | wc -l | tr -d ' ')
else
    find "$DEBUG_DIR" -type f -mtime +3 -delete 2>/dev/null
    find "$SHELL_SNAPSHOTS" -type f -mtime +3 -delete 2>/dev/null
    find "$TELEMETRY_DIR" -type f -mtime +3 -delete 2>/dev/null
fi

# Step 4: Clean up simple directories (plans, paste-cache, sessions)
# These have no session protection needed.
# sessions/ holds files named by PID (e.g. 2692.json), NOT session UUIDs,
# so no Desktop-session protection applies; the active session's file has a
# fresh mtime so a 60-day purge won't touch it.
if [[ "$DRY_RUN" == "true" ]]; then
    plans_to_delete=$(find "$PLANS_DIR" -type f -mtime +60 2>/dev/null | wc -l | tr -d ' ')
    paste_cache_to_delete=$(find "$PASTE_CACHE" -type f -mtime +60 2>/dev/null | wc -l | tr -d ' ')
    sessions_to_delete_simple=$(find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type f -mtime +60 2>/dev/null | wc -l | tr -d ' ')
else
    find "$PLANS_DIR" -type f -mtime +60 -delete 2>/dev/null
    find "$PASTE_CACHE" -type f -mtime +60 -delete 2>/dev/null
    find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type f -mtime +60 -delete 2>/dev/null
fi

# Step 5: Clean up old task directories with session protection
# Each task is a directory containing .json, .lock, and .highwatermark files
# Same logic as file-history - protect tasks linked to active Desktop sessions
if [[ "$DRY_RUN" == "true" ]]; then
    echo "Task directories older than 60 days:"
fi

if [[ -d "$TASKS_DIR" ]]; then
    find "$TASKS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +60 2>/dev/null | while read -r task_dir; do
        # Extract session ID from directory name
        session_id=$(basename "$task_dir")

        # Check if this session is protected (linked to a Desktop session)
        if [[ -n "$protected_ids" ]] && echo "$protected_ids" | grep -qx "$session_id"; then
            # Session is protected, do not delete
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  PROTECTED: $task_dir (linked to Desktop)"
                echo "protected" >> /tmp/claude/cleanup_tasks_protected_$$ 2>/dev/null
            fi
        else
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  WOULD DELETE: $task_dir"
                echo "delete" >> /tmp/claude/cleanup_tasks_delete_$$ 2>/dev/null
            else
                rm -rf "$task_dir" 2>/dev/null
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
    echo "File history directories older than 60 days:"
fi

if [[ -d "$FILE_HISTORY" ]]; then
    find "$FILE_HISTORY" -mindepth 1 -maxdepth 1 -type d -mtime +60 2>/dev/null | while read -r history_dir; do
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

# Step 6a: Clean up old teams directories with session protection
# teams contains directories named by session ID (same as file-history)
if [[ "$DRY_RUN" == "true" ]]; then
    echo "Teams directories older than 60 days:"
fi

if [[ -d "$TEAMS_DIR" ]]; then
    find "$TEAMS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +60 2>/dev/null | while read -r teams_dir; do
        # Extract session ID from directory name
        session_id=$(basename "$teams_dir")

        # Check if this session is protected (linked to a Desktop session)
        if [[ -n "$protected_ids" ]] && echo "$protected_ids" | grep -qx "$session_id"; then
            # Session is protected, do not delete
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  PROTECTED: $teams_dir (linked to Desktop)"
                echo "protected" >> /tmp/claude/cleanup_teams_protected_$$ 2>/dev/null
            fi
        else
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  WOULD DELETE: $teams_dir"
                echo "delete" >> /tmp/claude/cleanup_teams_delete_$$ 2>/dev/null
            else
                rm -rf "$teams_dir" 2>/dev/null
            fi
        fi
    done
fi

# Dry-run: Read teams counts from temp files
if [[ "$DRY_RUN" == "true" ]]; then
    if [[ -f /tmp/claude/cleanup_teams_delete_$$ ]]; then
        teams_to_delete=$(wc -l < /tmp/claude/cleanup_teams_delete_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_teams_delete_$$ 2>/dev/null
    fi
    if [[ -f /tmp/claude/cleanup_teams_protected_$$ ]]; then
        teams_protected=$(wc -l < /tmp/claude/cleanup_teams_protected_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_teams_protected_$$ 2>/dev/null
    fi
    echo ""
fi

# Step 6b: Clean up old session-env directories with session protection
# session-env contains directories named by session ID (same as file-history)
if [[ "$DRY_RUN" == "true" ]]; then
    echo "Session-env directories older than 60 days:"
fi

if [[ -d "$SESSION_ENV_DIR" ]]; then
    find "$SESSION_ENV_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +60 2>/dev/null | while read -r session_env_dir; do
        # Extract session ID from directory name
        session_id=$(basename "$session_env_dir")

        # Check if this session is protected (linked to a Desktop session)
        if [[ -n "$protected_ids" ]] && echo "$protected_ids" | grep -qx "$session_id"; then
            # Session is protected, do not delete
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  PROTECTED: $session_env_dir (linked to Desktop)"
                echo "protected" >> /tmp/claude/cleanup_session_env_protected_$$ 2>/dev/null
            fi
        else
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  WOULD DELETE: $session_env_dir"
                echo "delete" >> /tmp/claude/cleanup_session_env_delete_$$ 2>/dev/null
            else
                rm -rf "$session_env_dir" 2>/dev/null
            fi
        fi
    done
fi

# Dry-run: Read session-env counts from temp files
if [[ "$DRY_RUN" == "true" ]]; then
    if [[ -f /tmp/claude/cleanup_session_env_delete_$$ ]]; then
        session_env_to_delete=$(wc -l < /tmp/claude/cleanup_session_env_delete_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_session_env_delete_$$ 2>/dev/null
    fi
    if [[ -f /tmp/claude/cleanup_session_env_protected_$$ ]]; then
        session_env_protected=$(wc -l < /tmp/claude/cleanup_session_env_protected_$$ | tr -d ' ')
        rm /tmp/claude/cleanup_session_env_protected_$$ 2>/dev/null
    fi
    echo ""
fi

# Step 7: Clean up empty directories in all managed folders
# After deleting files/directories, some parent directories may be empty
if [[ "$DRY_RUN" != "true" ]]; then
    find "$CLI_PROJECTS" -type d -empty -delete 2>/dev/null
    find "$PLANS_DIR" -type d -empty -delete 2>/dev/null
    find "$TASKS_DIR" -type d -empty -delete 2>/dev/null
    find "$PASTE_CACHE" -type d -empty -delete 2>/dev/null
    find "$FILE_HISTORY" -type d -empty -delete 2>/dev/null
    find "$TELEMETRY_DIR" -type d -empty -delete 2>/dev/null
    find "$TEAMS_DIR" -type d -empty -delete 2>/dev/null
    find "$SESSION_ENV_DIR" -type d -empty -delete 2>/dev/null
fi

# Dry-run: Print summary
if [[ "$DRY_RUN" == "true" ]]; then
    echo "Summary:"
    echo "  Sessions to delete: $sessions_to_delete"
    echo "  Sessions protected: $sessions_protected"
    echo "  Session dirs to delete: $session_dirs_to_delete"
    echo "  Session dirs protected: $session_dirs_protected"
    echo "  Sidecar files to delete: $sidecar_files_to_delete"
    echo "  Debug files to delete: $debug_files_to_delete"
    echo "  Shell snapshots to delete: $shell_snapshots_to_delete"
    echo "  Telemetry files to delete: $telemetry_to_delete"
    echo "  Plans to delete: $plans_to_delete"
    echo "  Task dirs to delete: $tasks_to_delete"
    echo "  Task dirs protected: $tasks_protected"
    echo "  Paste cache to delete: $paste_cache_to_delete"
    echo "  File history dirs to delete: $file_history_to_delete"
    echo "  File history dirs protected: $file_history_protected"
    echo "  Teams dirs to delete: $teams_to_delete"
    echo "  Teams dirs protected: $teams_protected"
    echo "  Session-env dirs to delete: $session_env_to_delete"
    echo "  Session-env dirs protected: $session_env_protected"
    echo "  Sessions files to delete: $sessions_to_delete_simple"
fi

# Hook requirement: always exit 0
exit 0

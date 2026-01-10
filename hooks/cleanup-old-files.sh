#!/bin/bash
# Clean up Claude Code temp files older than 3 days
# Runs silently at end of each session

find "${HOME}/.claude/debug" -type f -mtime +3 -delete 2>/dev/null
find "${HOME}/.claude/shell-snapshots" -type f -mtime +3 -delete 2>/dev/null
find "${HOME}/.claude/projects" -mindepth 2 -type f -mtime +3 -delete 2>/dev/null

# Clean up empty project directories
find "${HOME}/.claude/projects" -type d -empty -delete 2>/dev/null

exit 0

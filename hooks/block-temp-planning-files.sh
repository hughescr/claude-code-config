#!/bin/bash
# ============================================================================
# PreToolUse Hook Return Semantics
# Docs: https://docs.anthropic.com/en/docs/claude-code/hooks
# ============================================================================
#
# Exit Code | Stream  | Behavior
# ----------|---------|----------------------------------------------------------
# 0         | stdout  | Success. JSON with {"hookSpecificOutput":
#           |         | {"permissionDecision": "allow|deny|ask",
#           |         |  "permissionDecisionReason": "..."}} sets the decision;
#           |         | empty stdout = no opinion, normal permission flow.
# ----------|---------|----------------------------------------------------------
# 2         | stderr  | BLOCKING ERROR - the tool call is DENIED and stderr text
#           |         | is fed back to Claude. Do NOT use for passthrough.
# ----------|---------|----------------------------------------------------------
# other     | stderr  | Non-blocking error - shown to user, tool proceeds via
#           |         | normal permission flow.
# ============================================================================

set -euo pipefail

input=$(cat)
# jq parse failure = no opinion, not a block (set -e would otherwise exit 2)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0

[ -z "$command" ] && exit 0

deny_heredoc() {
  cat << 'DECISION'
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "BLOCKED: Creating files via heredoc is forbidden. Use TodoWrite for task tracking, or use the Write tool for legitimate file creation. See CLAUDE.md."}}
DECISION
  exit 0
}

# Check for heredoc marker (case-insensitive delimiter)
has_heredoc=false
if [[ "$command" =~ \<\<-?[[:space:]]*[\'\"]?[A-Za-z_][A-Za-z0-9_]*[\'\"]? ]]; then
  has_heredoc=true
fi

if [ "$has_heredoc" = true ]; then
  # Pattern 1: cat/tee with heredoc and file redirect
  # Matches: cat > file << EOF, cat << EOF > file, tee file << EOF
  if [[ "$command" =~ ^[[:space:]]*(cat|tee)[[:space:]] ]]; then
    # Check for file redirect (> or >> followed by path-like string)
    if [[ "$command" =~ \>[[:space:]]*[A-Za-z0-9_./-] ]]; then
      deny_heredoc
    fi
    # Check for tee with file argument before heredoc
    if [[ "$command" =~ tee[[:space:]]+[A-Za-z0-9_./-] ]]; then
      deny_heredoc
    fi
  fi

  # Pattern 2: Pipe to tee (cat << EOF | tee file)
  if [[ "$command" =~ \|[[:space:]]*tee[[:space:]]+[A-Za-z0-9_./-] ]]; then
    deny_heredoc
  fi

  # Pattern 3: Any heredoc writing to planning-like files (.md, .txt, .log)
  if [[ "$command" =~ \.(md|txt|log|json)[[:space:]\"\'\>] ]] || \
     [[ "$command" =~ \.(md|txt|log|json)$ ]]; then
    deny_heredoc
  fi
fi

exit 0

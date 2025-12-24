#!/bin/bash
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

deny_heredoc() {
  cat >&2 << 'ERRMSG'
{"hookSpecificOutput": {"permissionDecision": "deny"}, "systemMessage": "BLOCKED: Creating files via heredoc is forbidden. Use TodoWrite for task tracking, or use the Write tool for legitimate file creation. See CLAUDE.md."}
ERRMSG
  exit 2
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

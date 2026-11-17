#!/bin/bash
# ============================================================================
# PreToolUse Hook Return Semantics
# Docs: https://docs.anthropic.com/en/docs/claude-code/hooks
# ============================================================================
#
# Exit Code | Stream  | Behavior
# ----------|---------|----------------------------------------------------------
# 0         | stdout  | Success - tool proceeds. If stdout contains JSON with
#           |         | {"hookSpecificOutput": {"permissionDecision": "allow"}},
#           |         | the tool runs without user permission prompt.
#           |         | Empty stdout = no opinion, normal permission flow.
# ----------|---------|----------------------------------------------------------
# 2         | stderr  | Decision provided - Claude reads stderr for JSON:
#           |         | {"hookSpecificOutput": {"permissionDecision": "deny|ask"},
#           |         |  "systemMessage": "explanation for Claude"}
#           |         | "deny" = block the tool, "ask" = prompt user
# ----------|---------|----------------------------------------------------------
# other     | stderr  | Error - shown to user only, Claude unaware, tool proceeds
# ============================================================================

set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

# The deny message names the compiler invoked ($1: tsc or tsrs).
deny_tsc_files() {
  local name="${1:-tsc}"
  cat << ERRMSG >&2
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny"}, "systemMessage": "BLOCKED: ${name} should not be run with individual file arguments. TypeScript needs to process the entire project for proper type-checking. Remove the file arguments and run '${name} --noEmit' instead."}
ERRMSG
  exit 2
}

# The compiler named last in the command (greedy .* finds the last match under
# POSIX leftmost-longest), used only to word the deny message. Exact for a
# single-line command, since only the text after the last compiler on a line is
# examined; on a multi-line command naming both, an earlier line may have denied.
# Same rule as compilerName in guard.ts.
compiler_name() {
  local re='^(.*[[:space:]|;&])?(npx|pnpm|yarn)?(tsc|tsrs)([[:space:]]|$)'
  if [[ "$command" =~ $re ]]; then
    echo "${BASH_REMATCH[3]}"
  else
    echo tsc
  fi
}

# Extract the compiler command portion (handles direct tsc/tsrs, npx, pnpm, yarn, bunx)
# First check if tsc or tsrs is invoked at all (tsrs-lint does not match: the
# name must be followed by whitespace or the end)
if ! [[ "$command" =~ (^|[[:space:]|;&])(npx|pnpm|yarn)?[[:space:]]*(dlx[[:space:]]+)?(tsc|tsrs)([[:space:]]|$) ]]; then
  exit 0
fi

# Get everything after 'tsc' or 'tsrs' (including any flags and arguments)
tsc_args=$(echo "$command" | sed -E 's/^.*(^|[[:space:]])(npx[[:space:]]+|pnpm[[:space:]]+(dlx[[:space:]]+)?|yarn[[:space:]]+)?(tsc|tsrs)([[:space:]]|$)//')

# Skip flags that take a file argument (these are config files, not source files)
# -p/--project, --build/-b can have config arguments
# We need to parse carefully to not mistake flag values for source files

skip_next=false
for word in $tsc_args; do
  if [ "$skip_next" = true ]; then
    skip_next=false
    continue
  fi

  # Flags that take a following argument (config files, not source files)
  case "$word" in
    -p|--project|--outDir|--outFile|--rootDir|--baseUrl|--declarationDir|--tsBuildInfoFile)
      skip_next=true
      continue
      ;;
  esac

  # Skip standalone flags (no arguments)
  if [[ "$word" =~ ^- ]]; then
    continue
  fi

  # Check if this non-flag argument is a .ts or .tsx file
  if [[ "$word" =~ \.(ts|tsx)$ ]]; then
    deny_tsc_files "$(compiler_name)"
  fi
done

exit 0

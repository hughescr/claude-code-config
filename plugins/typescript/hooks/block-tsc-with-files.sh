#!/bin/bash
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

deny_tsc_files() {
  cat >&2 << 'ERRMSG'
{"hookSpecificOutput": {"permissionDecision": "deny"}, "systemMessage": "BLOCKED: tsc should not be run with individual file arguments. TypeScript needs to process the entire project for proper type-checking. Remove the file arguments and run 'tsc --noEmit' instead."}
ERRMSG
  exit 2
}

# Extract the tsc command portion (handles direct tsc, npx tsc, pnpm tsc, yarn tsc)
# First check if tsc is invoked at all
if ! [[ "$command" =~ (^|[[:space:]|;&])(npx|pnpm|yarn)?[[:space:]]*(dlx[[:space:]]+)?tsc([[:space:]]|$) ]]; then
  exit 0
fi

# Get everything after 'tsc' (including any flags and arguments)
tsc_args=$(echo "$command" | sed -E 's/^.*(^|[[:space:]])(npx[[:space:]]+|pnpm[[:space:]]+(dlx[[:space:]]+)?|yarn[[:space:]]+)?tsc([[:space:]]|$)//')

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
    deny_tsc_files
  fi
done

exit 0

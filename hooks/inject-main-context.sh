#!/usr/bin/env bash
# SessionStart hook: injects MAIN-CLAUDE.md as additionalContext, layered
# user-global then project (mirroring CLAUDE.md layering). Emits nothing if
# neither file exists.
set -euo pipefail

FILE_NAME="MAIN-CLAUDE.md"
GLOBAL_FILE="${HOME}/.claude/${FILE_NAME}"

INPUT="$(cat)"

# Project dir: prefer $CLAUDE_PROJECT_DIR (the documented project-root env var
# exported to hook processes); fall back to the "cwd" field on stdin, which
# is documented as present for every hook event including SessionStart.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [[ -z "$PROJECT_DIR" && -n "$INPUT" ]]; then
  PROJECT_DIR="$(jq -r '.cwd // empty' <<<"$INPUT" 2>/dev/null || true)"
fi
PROJECT_FILE="${PROJECT_DIR:+${PROJECT_DIR}/.claude/${FILE_NAME}}"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [[ -f "$GLOBAL_FILE" ]]; then
  printf '<!-- source: %s -->\n' "$GLOBAL_FILE" >>"$TMP"
  cat "$GLOBAL_FILE" >>"$TMP"
  printf '\n' >>"$TMP"
fi

# Include the project file too, unless it's the same file as the global one
# (e.g. when the project IS ~/.claude, global and project paths could collide
# in principle — realpath dedupes that case).
if [[ -n "$PROJECT_FILE" && -f "$PROJECT_FILE" ]]; then
  if [[ ! -f "$GLOBAL_FILE" ]] || [[ "$(realpath "$PROJECT_FILE")" != "$(realpath "$GLOBAL_FILE")" ]]; then
    printf '<!-- source: %s -->\n' "$PROJECT_FILE" >>"$TMP"
    cat "$PROJECT_FILE" >>"$TMP"
  fi
fi

if [[ ! -s "$TMP" ]]; then
  exit 0
fi

jq -n --rawfile content "$TMP" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $content
  }
}'

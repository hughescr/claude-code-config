#!/bin/sh
# scripts/capture-delete-hook.sh — PreToolUse hook entry point, matcher
# `TaskUpdate` (design R4 §Phase 1 interfaces, P1.11; required by G-DELETE,
# §6.1).
#
# Wired in ~/.claude/settings.json, ADDITIVE alongside the existing PreToolUse
# entries (Bash / Skill matchers) — hooks merge additively across settings
# levels and within one event's array, so this must never replace that array.
#
# ALWAYS ALLOWS. Never denies the tool call, for any reason, including bun
# being unavailable or capture-delete.ts throwing. See that file for what it
# captures and why (transcripts alone cannot recover a delete whose
# tool_result was never written — G-DELETE found 9 task-dirs that lost every
# file with no deletion ever requested, so file-presence is unreliable too).

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/est-lib.sh"

est_bun_script capture-delete.ts
rc=$?
case "$rc" in
  0) : ;;
  *) echo "est capture-delete hook: non-zero exit ($rc) — always-allow, continuing" >&2 ;;
esac

exit 0

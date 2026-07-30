#!/bin/sh
# scripts/session-start-hook.sh — SessionStart hook entry point (no matcher).
#
# Wired in ~/.claude/settings.json. Thin shell wrapper for the same reason
# prompt-sweep-hook.sh is one: hook processes run with a minimal PATH that does
# not include ~/.bun/bin or /opt/homebrew/bin, so `bun` cannot be assumed to
# resolve without est-lib.sh's search.
#
# TWO absolute rules, and the first is STRICTER here than anywhere else:
#
#   1. SILENT. A SessionStart hook's stdout is injected into the model's context
#      as additional context for the session — that is the documented purpose of
#      the stream, not an accident of it. A stray line here is therefore not just
#      noise, it is an unattributable instruction sitting at the top of every
#      session Craig ever starts. Both streams are discarded: session-start.ts is
#      already silent by construction, and this redirect also swallows anything
#      bun itself might print (a resolver warning, a stack trace, est-lib.sh's
#      own "cannot find bun" diagnostic).
#   2. EXIT 0. Nothing about refreshing read caches is worth degrading a session
#      start for.
#
# The actual logic (throttled, detached micro-sweep — which since 2026-07-30
# includes the sweeper close pass) lives in session-start.ts and
# src/microsweep.ts; see those files.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/est-lib.sh"

est_bun_script session-start.ts >/dev/null 2>/dev/null

exit 0

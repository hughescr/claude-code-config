#!/bin/sh
# scripts/prompt-sweep-hook.sh — UserPromptSubmit hook entry point (no matcher).
#
# Wired in ~/.claude/settings.json. Thin shell wrapper for the same reason
# nudge-hook.sh is one: hook processes run with a minimal PATH that does not
# include ~/.bun/bin or /opt/homebrew/bin, so `bun` cannot be assumed to resolve
# without est-lib.sh's search.
#
# TWO absolute rules, and they are why this wrapper is not a copy of nudge-hook.sh:
#
#   1. SILENT. A UserPromptSubmit hook's stdout is injected into the model's
#      context on EVERY prompt, so a stray line here is a permanent per-turn tax
#      and, worse, unattributable noise inside Craig's conversation. Both streams
#      are discarded: prompt-sweep.ts is already silent by construction, and this
#      redirect also swallows anything bun itself might print (a resolver warning,
#      a stack trace, est-lib.sh's own "cannot find bun" diagnostic).
#   2. EXIT 0. A non-zero UserPromptSubmit hook can block the prompt outright.
#      Nothing about refreshing a statusline cache is worth failing a prompt for.
#
# The actual logic (throttled, detached micro-sweep) lives in prompt-sweep.ts and
# src/microsweep.ts; see those files.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/est-lib.sh"

est_bun_script prompt-sweep.ts >/dev/null 2>/dev/null

exit 0

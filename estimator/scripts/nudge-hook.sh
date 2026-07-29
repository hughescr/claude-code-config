#!/bin/sh
# scripts/nudge-hook.sh — PostToolUse hook entry point, matcher `Task|Workflow`
# (design R4 §Phase 1 interfaces, P1.10; enforcement rationale in §3.3).
#
# Wired in ~/.claude/settings.json. This is a thin shell wrapper for the same
# reason session-end-sweep.sh is one: hook processes run with a minimal PATH
# that does not include ~/.bun/bin or /opt/homebrew/bin, so `bun` cannot be
# assumed to resolve without est-lib.sh's search.
#
# ADVISORY ONLY. Always exits 0 — even if bun cannot be found or nudge.ts
# throws — so this can never be the thing that breaks Craig's hot path.
# The actual logic (decide + record + throttled detached micro-sweep) lives
# in nudge.ts; see that file for the three-job breakdown.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/est-lib.sh"

est_bun_script nudge.ts
rc=$?
case "$rc" in
  0) : ;;
  *) echo "est nudge hook: non-zero exit ($rc) — advisory only, continuing" >&2 ;;
esac

exit 0

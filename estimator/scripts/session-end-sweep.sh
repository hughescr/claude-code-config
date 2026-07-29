#!/bin/sh
# scripts/session-end-sweep.sh — the SessionEnd blocking sweep (design R3 §3.4).
#
# ############################################################################
# # NOT WIRED IN. This file is not referenced by ~/.claude/settings.json yet. #
# # Installing it is the orchestrator's job, not this script's. When it goes  #
# # in, it goes in ~/.claude/settings.json (USER level) as an ADDITIONAL      #
# # SessionEnd entry — hooks merge additively across settings levels and all  #
# # levels' hooks run, so never "replace the SessionEnd block": that would    #
# # silently drop whatever else is registered there.                          #
# ############################################################################
#
# What it does: one blocking, budgeted sweep so the session's own transcripts are
# in the database before the process goes away. `--budget 20s` sits inside the
# existing 30 s SessionEnd hook timeout; a sweep that exceeds it commits what it
# has (every upsert is idempotent) and logs anomaly(sweep_budget_exceeded), and the
# daily cron finishes the job.
#
# The GC ordering hazard, and why this script is the bare sweep today (§3.4):
# `cleanup-old-files.sh` deletes projects/*/*.jsonl at 60 days and fires on this
# same event; hooks at one event are NOT ordered relative to each other, so a sweep
# racing the GC would snapshot a partial corpus SILENTLY. As of 2026-07-28 that GC
# entry is stashed under `_disabledHooks` and `cleanupPeriodDays` is 3650, so there
# is nothing to race and a bare sweep is correct. If the GC is ever re-enabled, do
# NOT add a second SessionEnd entry (additive merge would run the GC twice) —
# change THIS script to chain them, snapshot first:
#
#     est sweep --blocking --budget 20s
#     "$HOME/.claude/hooks/cleanup-old-files.sh"
#
# Exit code is always 0. A SessionEnd hook cannot usefully fail — the session is
# already over — and a non-zero exit only produces noise. Real failures are on
# stderr and in the `anomaly` table; `est census` is where they are read.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/est-lib.sh"

est_run sweep --blocking --budget "${EST_SESSION_END_BUDGET:-20s}" --quiet
rc=$?

case "$rc" in
  0|3|4) : ;;  # ok / anomalies recorded / another writer already sweeping
  *) echo "est session-end sweep failed (exit $rc)" >&2 ;;
esac

exit 0

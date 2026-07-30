#!/bin/sh
# scripts/est-cron.sh — the scheduled maintenance leg of the estimator (design R3 §2, §8).
#
#   daily   est sweep --blocking --budget 300s
#           est recon                   (P2.6 reconciliation point; no --certify)
#   weekly  est prices --sync           (refresh model_price from upstream)
#           bun scripts/backup.ts       (VACUUM INTO backups/ + wal_checkpoint(TRUNCATE))
#
# "Weekly" is stamp-driven, not day-of-week-driven: if the laptop is asleep on the
# chosen day the work still happens on the next run, which a `date +%u` test would
# silently skip for a week.
#
# NOT INSTALLED. `scripts/com.craig.estimator.plist` is the launchd job that would
# run this; installing it is a deliberate, separate step (see that file's header).
# Run it by hand any time — every write path is idempotent:
#
#     sh ~/.claude/estimator/scripts/est-cron.sh          # daily leg, weekly if due
#     sh ~/.claude/estimator/scripts/est-cron.sh --weekly # force the weekly leg
#     sh ~/.claude/estimator/scripts/est-cron.sh --daily  # daily leg only
#
# Exit codes: 0 = everything ran. Non-zero = at least one leg failed; the specific
# failure is on stderr and, for sweeps, in the `anomaly` table. `est sweep` exit 3
# ("anomalies recorded") and exit 4 ("lock held by a live session") are NOT cron
# failures — they are normal states — so they are reported and swallowed here.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/est-lib.sh"

WEEKLY_STAMP="$EST_HOME/backups/.last-weekly"   # under backups/, which is gitignored
WEEKLY_INTERVAL_S=604800                        # 7 days
SWEEP_BUDGET="${EST_CRON_SWEEP_BUDGET:-300s}"
BACKUP_KEEP="${EST_CRON_BACKUP_KEEP:-8}"

mode="auto"
case "${1:-}" in
  --weekly) mode="weekly" ;;
  --daily)  mode="daily" ;;
  "")       mode="auto" ;;
  *)        echo "usage: est-cron.sh [--daily|--weekly]" >&2; exit 64 ;;
esac

log() { printf '%s est-cron: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

rc=0

# --- daily: sweep -----------------------------------------------------------
log "sweep (budget $SWEEP_BUDGET)"
est_run sweep --blocking --budget "$SWEEP_BUDGET"
sweep_rc=$?
case "$sweep_rc" in
  0) ;;
  3) log "sweep recorded anomalies or hit its budget (exit 3) — expected, see \`est census\`" ;;
  4) log "sweep lock held by a live session (exit 4) — skipped, the next run finishes the job" ;;
  *) log "sweep FAILED (exit $sweep_rc)"; rc=$sweep_rc ;;
esac

# --- daily: recon ------------------------------------------------------------
# P2.6, DAILY rather than weekly (Craig, 2026-07-30). `est recon` compares our numbers
# against Anthropic-computed ones on four axes and writes `recon`/`recon_metric` rows;
# the retirement criterion needs consecutive CLEAN WEEKS, and a weekly cadence gives it
# exactly one sample per week — so a receiver outage, a price-table drift or a join
# collapse sat undetected for up to seven days and then poisoned the whole week's
# certification with one bad point. A daily row makes the breach visible the next
# morning and gives the weekly aggregate something to be an aggregate OF.
#
# Runs AFTER the sweep, unconditionally: recon reads what the sweep just ingested, and a
# sweep that stepped aside for a live session (exit 4) still leaves yesterday's corpus
# worth reconciling.
#
# NO `--certify`. Retirement of the [unvalidated] marker is a deliberate human act; the
# plain verb still EVALUATES the criterion (and still clears a marker that no longer
# holds, which is the rolling half), it simply never grants it. NO `--dry-run` either:
# the whole point is to persist the daily point.
#
# Exit-code discipline mirrors the sweep step above, because `cmdRecon` deliberately
# reuses the same codes: 3 = "completed, an axis breached recon_alert_pct" (recorded as
# anomaly(recon_mismatch) — `est census` is where it is read), 4 = the writer lock was
# held. Neither is a cron failure. Anything else is.
log "recon (daily)"
est_run recon
recon_rc=$?
case "$recon_rc" in
  0) log "recon ok" ;;
  3) log "recon recorded an axis breach (exit 3) — expected while [unvalidated] stands, see \`est recon --dry-run\`" ;;
  4) log "recon lock held by a live session (exit 4) — skipped, tomorrow's run takes the point" ;;
  *) log "recon FAILED (exit $recon_rc)"; rc=$recon_rc ;;
esac

# --- weekly: is it due? -----------------------------------------------------
weekly_due() {
  [ "$mode" = "weekly" ] && return 0
  [ "$mode" = "daily" ] && return 1
  [ -f "$WEEKLY_STAMP" ] || return 0
  # Portable age check: no `stat -c` (GNU) vs `stat -f` (BSD) branching needed.
  last=$(cat "$WEEKLY_STAMP" 2>/dev/null || echo 0)
  case "$last" in (*[!0-9]*|"") return 0 ;; esac
  now=$(date +%s)
  [ $((now - last)) -ge "$WEEKLY_INTERVAL_S" ]
}

if weekly_due; then
  log "weekly leg"

  est_run prices --sync
  prices_rc=$?
  if [ "$prices_rc" -eq 0 ]; then
    log "prices --sync ok"
  else
    # A failed fetch writes price_sync(ok=0) and changes nothing else (§4.3): the
    # last good snapshot stays in force, so this is reported, never fatal.
    log "prices --sync did not complete cleanly (exit $prices_rc) — last good prices remain in force"
  fi

  est_bun_script backup.ts --keep "$BACKUP_KEEP"
  backup_rc=$?
  if [ "$backup_rc" -eq 0 ]; then
    log "backup ok"
    # Stamped only on success, so a transient failure retries tomorrow instead of
    # quietly skipping a week's snapshot.
    mkdir -p "$(dirname "$WEEKLY_STAMP")"
    date +%s > "$WEEKLY_STAMP"
  else
    log "backup FAILED (exit $backup_rc) — weekly leg not stamped, it will retry on the next run"
    rc=$backup_rc
  fi
else
  log "weekly leg not due"
fi

exit "$rc"

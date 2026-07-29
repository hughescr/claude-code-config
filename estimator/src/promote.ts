/**
 * src/promote.ts — P2.8 status promotion: `estimating -> in_progress`, by the sweeper.
 *
 * **The trigger.** The FIRST attributed request for the tid — concretely, the first
 * request the attribution pass (`src/attribute.ts`) hands `attr IN ('exclusive',
 * 'sticky', 'ambiguous')`. Run this AFTER `attributeTasks()` in the same sweep: it
 * reads `request.tid`/`request.attr`, which that pass just wrote.
 *
 * **The two exclusions, both load-bearing, and both already enforced upstream:**
 *
 *  - `attr='overhead'` (the estimating skill's own requests, §5.4 rule 1) never
 *    reaches this query — it is excluded by the `attr IN (...)` list, not filtered
 *    here, so the ceremony can never start the clock it exists to measure.
 *  - `attr='pre_task'` / `'none'` / `'replay'` are excluded the same way: none of
 *    them is a real touch of the task.
 *
 * **`started_at` comes from the transcript** (`request.ts` of that first attributed
 * request), never from `new Date()` — a backfill of a week-old session writes the
 * historically correct start rather than the moment the sweeper happened to run.
 *
 * **The sweeper owns exactly ONE status transition: `estimating -> in_progress`.**
 * `pending_verification`, `completed`, `abandoned`, `deleted` and `reopened` are
 * `est close`'s (P1.7, §6.2) under the quiescence gate. Stated as an invariant so a
 * second sweeper-driven edge never gets added here by accident.
 *
 * **`started_at` is monotone-EARLIEST and effectively write-once**, but not
 * status-gated: a later sweep that ingests a symlink-aliased or forked file can
 * legitimately discover an EARLIER first request for a task that has since moved past
 * `estimating` (or even finished), and the value may move backwards — never forwards.
 * A backdate is reported (`anomaly(kind='promotion_backdated')`), never suppressed.
 *
 * **A task closed while still `estimating` is legal.** If no request is ever
 * attributed to it, this module never touches it: `outcome` carries a NULL start and
 * the retro publishes `never_started_share`. A number is more useful than a
 * fabricated timestamp.
 */

import type { Database } from "bun:sqlite";
import type { IngestAnomaly } from "./ingest.ts";

export interface PromotionResult {
  /** Tasks moved `estimating -> in_progress` this pass. */
  promoted: number;
  /** Tasks whose `started_at` was NULL and is now set. */
  started_at_set: number;
  /** Tasks whose non-NULL `started_at` moved EARLIER (an `anomaly` accompanies each). */
  started_at_backdated: number;
  anomalies: IngestAnomaly[];
}

export function emptyPromotionResult(): PromotionResult {
  return { promoted: 0, started_at_set: 0, started_at_backdated: 0, anomalies: [] };
}

/**
 * One row per tid with at least one `exclusive`/`sticky`/`ambiguous` request:
 * the earliest such request's `ts` is the candidate `started_at`.
 */
const FIRST_TOUCH_SQL = `
SELECT tid, MIN(ts) AS first_ts
  FROM request
 WHERE tid IS NOT NULL AND attr IN ('exclusive','sticky','ambiguous')
 GROUP BY tid
`;

const PROMOTE_SQL = "UPDATE task SET status = 'in_progress' WHERE tid = ? AND status = 'estimating'";
const STARTED_AT_SQL =
  "UPDATE task SET started_at = ? WHERE tid = ? AND (started_at IS NULL OR ? < started_at)";

/**
 * Run inside the sweep's write transaction, AFTER `attributeTasks(db)`. Idempotent:
 * a re-run over an unchanged corpus promotes nothing and moves no `started_at`
 * (§2's "a re-sweep is a no-op").
 */
export function promoteStartedTasks(db: Database): PromotionResult {
  const firstTouches = db.query<{ tid: string; first_ts: string }, []>(FIRST_TOUCH_SQL).all();
  if (firstTouches.length === 0) return emptyPromotionResult();

  const tids = firstTouches.map((r) => r.tid);
  const placeholders = tids.map(() => "?").join(",");
  const current = db
    .query<{ tid: string; status: string; started_at: string | null }, string[]>(
      `SELECT tid, status, started_at FROM task WHERE tid IN (${placeholders})`,
    )
    .all(...tids);
  const byTid = new Map(current.map((t) => [t.tid, t]));

  const promoteStmt = db.prepare(PROMOTE_SQL);
  const startedStmt = db.prepare(STARTED_AT_SQL);

  const result = emptyPromotionResult();
  db.transaction(() => {
    for (const { tid, first_ts } of firstTouches) {
      const t = byTid.get(tid);
      // Raced with a delete between the two reads above (both inside this same
      // transaction in practice, so this is a defensive branch, not a live path).
      if (t === undefined) continue;

      if (t.status === "estimating") {
        const res = promoteStmt.run(tid) as unknown as { changes: number };
        if (Number(res.changes ?? 0) > 0) result.promoted += 1;
      }

      const prev = t.started_at;
      if (prev === null || first_ts < prev) {
        startedStmt.run(first_ts, tid, first_ts);
        if (prev === null) {
          result.started_at_set += 1;
        } else {
          result.started_at_backdated += 1;
          result.anomalies.push({
            kind: "promotion_backdated",
            detail: `task ${tid}: started_at moved from ${prev} to ${first_ts} (an earlier attributed request was discovered)`,
          });
        }
      }
    }
  }).immediate();

  return result;
}

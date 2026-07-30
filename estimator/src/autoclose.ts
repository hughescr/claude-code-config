/**
 * src/autoclose.ts — the SWEEPER CLOSE PASS (P1.7 / §6.2, Craig 2026-07-30).
 *
 * **The promise this file makes true.** §6.2's quiescence gate refuses a premature
 * `est close` with "wait for the task to go quiet … or leave the close to the sweeper".
 * Nothing in the sweeper closed anything. `closeTask` was reachable from exactly one
 * place — the `est close` CLI verb — so the sentence described a component that did not
 * exist, and the population it described (a task whose work finished, whose session went
 * away, and whose agent never came back to close it) simply accumulated as `in_progress`
 * forever. Those tasks are not merely untidy: an open task has no `outcome` row, so it
 * contributes nothing to `v_velocity`, and the calibration corpus silently omits every
 * task that ended the ordinary way instead of the ceremonial one.
 *
 * **Candidate filter FIRST, gate SECOND — never the other way round.** The quiescence
 * gate is five conditions, three of which read `turn`, `agent_run` and the live
 * `~/.claude/sessions/` directory per task. Running it over every open task on every
 * sweep would put a directory walk and three per-task queries on the micro-sweep's hot
 * path. So this module runs ONE indexed query that answers "could this task possibly be
 * closeable" — arm 1 of the gate, and nothing else — and only its hits pay for the full
 * evaluation. The gate is then evaluated in FULL, through `closeTask`'s ordinary path:
 * no `--force`, no `--accept`, no `heal`, no private shortcut. A candidate that fails
 * any of the other four arms is left exactly where it was, and the next sweep asks again.
 *
 * **completed vs abandoned (Craig's ruling, 2026-07-30).** A candidate reached this pass
 * for one of two reasons, and they are not the same fact:
 *
 *  - It carries a **linked completion signal** — a `task_event` whose `tid` this
 *    database resolved and whose `to_status` is `completed`, i.e. the harness's own
 *    TaskUpdate saying the work finished. That is positive evidence, and the close is
 *    `completed`.
 *  - It carries **nothing** and has been silent past `STALE_CLOSE_HOURS`. Craig's
 *    ruling: silence means the data is garbage for calibration. An `abandoned` close is
 *    `censored = 1` in `outcome`, so the actual enters the corpus as the LOWER BOUND it
 *    genuinely is instead of as a measurement nobody can vouch for. Recording it as
 *    `completed` would be the estimator asserting an outcome it did not observe, which
 *    is the P1.12 failure in a new costume. If a silent task really did finish,
 *    `est close <tid> --status reopened` un-does this by APPENDING, like everything
 *    else here.
 *
 * **Provenance.** `outcome` has no "who closed this" column and this pass does not add
 * one: the mechanism for the provenance of a close is already the `anomaly` ledger —
 * that is what `forced_close` (nobody is named) and `accepted_close` (the human's words,
 * verbatim) are for, and `est retro` already reads both. So a swept close writes
 * `anomaly(kind='swept_close', tid=…)`, BENIGN, in the same transaction as the close.
 *
 * **Throttle.** `close_pass_min_interval_min` (config, default 10) gates the pass on an
 * `mtime` check of a `.closepass` marker, the same filesystem mechanism P1.10 uses for
 * `.microsweep` and P2.7 uses for `.board`. Every hook fire in the machine spawns the
 * same `est sweep`, so without this a burst of micro-sweeps would run the candidate
 * query — and, worse, the full gate for every hit — several times a minute. The marker
 * is touched only AFTER the pass runs, so a throttled sweep costs nothing at all.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeTask, STALE_CLOSE_HOURS, type FinalStatus } from "./close.ts";
import { getConfig } from "./db.ts";
import { isoNow } from "./tasks.ts";
import { CLOSE_PASS_MARKER } from "./spool.ts";

/** Re-exported, never re-declared — `src/spool.ts` owns every name in the spool dir. */
export { CLOSE_PASS_MARKER };

/**
 * Minutes between close passes when `close_pass_min_interval_min` is unset or unusable.
 *
 * Ten, because the pass has nothing to gain from being faster: every candidate has
 * already been quiet for at least `quiesce_main_min` (60) by the time the gate lets it
 * through, so a task that becomes closeable at T is closed somewhere in [T, T+10min] —
 * a rounding error against the hour it had to be silent to qualify.
 */
export const DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN = 10;

export function closePassMinIntervalMin(db: Database): number {
  const raw = getConfig(db, "close_pass_min_interval_min");
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN;
}

/** True when a pass is due: no marker, or the marker is older than the window. */
export function closePassDue(
  spoolDir: string,
  minIntervalMin: number,
  now: Date = new Date(),
): boolean {
  let lastMs = 0;
  try {
    lastMs = statSync(join(spoolDir, CLOSE_PASS_MARKER)).mtimeMs;
  } catch {
    lastMs = 0; // no marker yet: due
  }
  return now.getTime() - lastMs >= minIntervalMin * 60_000;
}

/**
 * Stamp the throttle marker. Best-effort: an unwritable spool directory means the NEXT
 * sweep runs the pass again instead of being throttled, which is self-correcting and
 * never a false "the close pass is broken". Both close arms are idempotent — a task
 * closed twice in a row is refused by the gate the second time, because `closeTask`
 * moves `task.status` out of the open set — so the failure mode costs one query.
 */
export function touchClosePassMarker(spoolDir: string, now: Date = new Date()): void {
  try {
    mkdirSync(spoolDir, { recursive: true });
    const path = join(spoolDir, CLOSE_PASS_MARKER);
    writeFileSync(path, String(now.getTime()));
    // `closePassDue` reads mtime, not content. Pin it to the injected clock explicitly:
    // the filesystem always stamps real wall-clock time, which a test running at a
    // synthetic `now` would otherwise read as a marker from the future.
    utimesSync(path, now, now);
  } catch {
    // best-effort; see doc comment above
  }
}

/** The three `task.status` values a close pass may act on — §6.2's open set. */
export const OPEN_TASK_STATUS = ["estimating", "in_progress", "pending_verification"] as const;

/**
 * The candidate filter: arm 1 of the quiescence gate, and NOTHING else.
 *
 * Three predicates, and every one of them is served by an index:
 *
 *  - `EXISTS(task_event …)` uses the PARTIAL index `ix_task_event_completed`, whose
 *    predicate is repeated here VERBATIM so the planner can prove the index covers the
 *    query. The index holds only linked completion rows — a few per closed task —
 *    rather than the whole lifecycle table.
 *  - `MAX(request.ts)` uses `ix_req_tid`. This is the same "last attributed activity"
 *    the gate computes, and it falls back to `task.created_at` for a task that never
 *    got a request attributed to it, exactly as `quiescence` does.
 *  - The outer `task.status IN (…)` is a SCAN of `task`, deliberately. `task` holds one
 *    row per `est open` ceremony (hundreds, lifetime), the three open statuses are most
 *    of it in any live database, and an index whose predicate matches most of the table
 *    is slower than the scan it replaces. The cost this pass exists to avoid is the
 *    per-candidate lifecycle scan, which is what the partial index above kills.
 *
 * `pending_verification` is a candidate unconditionally: `quiescence` treats that status
 * as a completion signal in its own right (the harness said "done, awaiting check"), so
 * a filter that made it wait 48 hours would contradict the gate it is filtering for.
 *
 * `AS MATERIALIZED` is load-bearing, not decoration. Without it SQLite flattens the CTE
 * into the outer `WHERE` and evaluates BOTH correlated subqueries a second time per row
 * (visible in `EXPLAIN QUERY PLAN` as a duplicated pair of `CORRELATED SCALAR SUBQUERY`
 * blocks) — twice the indexed reads for the same answer.
 */
export const CLOSE_PASS_CANDIDATE_SQL = `
WITH open_task AS MATERIALIZED (
  SELECT t.tid    AS tid,
         t.status AS status,
         EXISTS (SELECT 1 FROM task_event e
                  WHERE e.tid = t.tid AND e.tid IS NOT NULL
                    AND e.to_status = 'completed') AS has_signal,
         COALESCE((SELECT MAX(r.ts) FROM request r WHERE r.tid = t.tid),
                  t.created_at) AS last_activity
    FROM task t
   WHERE t.status IN ('estimating','in_progress','pending_verification')
)
SELECT tid, status, has_signal, last_activity
  FROM open_task
 WHERE has_signal = 1
    OR status = 'pending_verification'
    OR last_activity < $stale_before
`;

export interface CloseCandidate {
  tid: string;
  status: string;
  /** A linked `task_event(to_status='completed')`, or the `pending_verification` status. */
  signal: boolean;
  /** MAX(request.ts) for this task, or `task.created_at` when it has none. */
  last_activity: string;
}

/** Run the candidate filter. One statement; see {@link CLOSE_PASS_CANDIDATE_SQL}. */
export function closePassCandidates(db: Database, now: Date = new Date()): CloseCandidate[] {
  const staleBefore = new Date(now.getTime() - STALE_CLOSE_HOURS * 3_600_000).toISOString();
  return db
    .query<
      { tid: string; status: string; has_signal: number; last_activity: string },
      { $stale_before: string }
    >(CLOSE_PASS_CANDIDATE_SQL)
    .all({ $stale_before: staleBefore })
    .map((r) => ({
      tid: r.tid,
      status: r.status,
      // The two things `quiescence` counts as a completion signal, unified here so the
      // filter and the completed/abandoned ruling below cannot disagree about one task.
      signal: r.has_signal === 1 || r.status === "pending_verification",
      last_activity: r.last_activity,
    }));
}

/** One close this pass performed. */
export interface SweptClose {
  tid: string;
  status: FinalStatus;
  revision: number;
  /** Why: a linked completion signal, or `STALE_CLOSE_HOURS` of silence. */
  reason: "completion_signal" | "stale";
}

export interface ClosePassResult {
  /** False => the throttle skipped the pass. Not a failure; nothing was even queried. */
  attempted: boolean;
  candidates: number;
  closed: SweptClose[];
  completed: number;
  abandoned: number;
  /** Candidates the FULL gate refused. Left open; the next pass asks again. */
  blocked: number;
  /** Candidates that threw for a reason other than the gate (no estimate, say). */
  failed: number;
}

export interface ClosePassOptions {
  now?: Date;
  /**
   * Where `.closepass` is stamped and read — per DATABASE, never per installation.
   *
   * `runSweep` passes its `boardSpoolDir`, which is `<dirname(db.filename)>/spool`
   * computed deliberately WITHOUT consulting the environment, and the reasoning is
   * P2.7's verbatim: this marker is throttle state for THAT database's close pass, and
   * two databases must not share one throttle. The consequence if they did is sharper
   * here than for the board — a test harness's sweep, or a copy of the database someone
   * was poking at, would silence the live database's close pass for ten minutes and
   * leave real tasks open. In production the two resolve to the same directory.
   */
  markerDir: string;
  /**
   * The HOOK spool, passed through to `closeTask` so it can reap the P1.10 overrun
   * marker for each task it closes. Environment-overridable (`EST_SPOOL_DIR`) because
   * that is where the hooks write, which is exactly why it is a different parameter
   * from {@link markerDir}. Defaults to `markerDir` for callers that have only one.
   */
  spoolDir?: string;
  /**
   * Skip the throttle for this call. `est sweep --full` (backfill) passes it: a
   * deliberate, human-initiated full rebuild should not be silenced by a marker some
   * hook's micro-sweep stamped ninety seconds ago.
   */
  force?: boolean;
  /**
   * The caller has ALREADY run `attributeTasks` over the whole corpus in this
   * transaction-free window. See {@link closeTask}'s `attributed` — without it every
   * candidate pays for its own corpus-wide attribution pass, turning an O(candidates)
   * loop into O(candidates x corpus).
   */
  attributed?: boolean;
}

const INSERT_SWEPT_CLOSE_SQL = `
INSERT INTO anomaly (ts, kind, detail, tid)
SELECT ?, 'swept_close', ?, ?
 WHERE NOT EXISTS (SELECT 1 FROM anomaly WHERE kind = 'swept_close' AND detail = ? AND tid = ?)
`;

/** Provenance text. Deliberately free of any number that moves between sweeps: the
 *  ledger dedups on (kind, detail, tid), and a figure in the key writes a row per pass. */
function sweptCloseDetail(status: FinalStatus): string {
  return status === "completed"
    ? "the sweeper closed this task: a linked task_event(to_status='completed') and the §6.2 quiescence gate met in full. " +
        "No human ran `est close`, and no gate arm was bypassed"
    : `the sweeper closed this task as ABANDONED: no completion signal ${STALE_CLOSE_HOURS}h after its last attributed request, ` +
        "so the actual is recorded right-censored rather than as a completion nobody observed (Craig 2026-07-30). " +
        "`est close <tid> --status reopened` appends a correction if the work is in fact live";
}

/**
 * The pass itself: filter, then gate, then close.
 *
 * Never throws. A candidate the gate refuses is counted and skipped; so is one that
 * throws for any other reason. A sweep must not fail because one task could not be
 * finalized — the whole point of doing this in the sweeper is that it is retried, for
 * free, on the next pass.
 */
export function runClosePass(db: Database, opts: ClosePassOptions): ClosePassResult {
  const now = opts.now ?? new Date();
  const result: ClosePassResult = {
    attempted: false,
    candidates: 0,
    closed: [],
    completed: 0,
    abandoned: 0,
    blocked: 0,
    failed: 0,
  };

  if (opts.force !== true && !closePassDue(opts.markerDir, closePassMinIntervalMin(db), now)) {
    return result;
  }
  result.attempted = true;
  const hookSpoolDir = opts.spoolDir ?? opts.markerDir;

  const candidates = closePassCandidates(db, now);
  result.candidates = candidates.length;
  const ts = isoNow(now);

  for (const c of candidates) {
    const status: FinalStatus = c.signal ? "completed" : "abandoned";
    try {
      // ONE transaction per candidate: the close and the row that says who did it are
      // one fact. `closeTask` opens its own immediate transaction, which nests as a
      // SAVEPOINT — the same shape `healClosedOutcomes` already relies on.
      db.transaction(() => {
        const r = closeTask(db, {
          tid: c.tid,
          status,
          now,
          spoolDir: hookSpoolDir,
          ...(opts.attributed === true ? { attributed: true } : {}),
        });
        const detail = sweptCloseDetail(status);
        db.query(INSERT_SWEPT_CLOSE_SQL).run(ts, detail, c.tid, detail, c.tid);
        result.closed.push({
          tid: c.tid,
          status,
          revision: r.revision,
          reason: c.signal ? "completion_signal" : "stale",
        });
      })();
      if (status === "completed") result.completed += 1;
      else result.abandoned += 1;
    } catch (e) {
      // The gate refusing is the DESIGNED outcome for a candidate whose session is
      // still live or whose agents have not returned, so it is counted apart from a
      // genuine fault (a task with no estimate row, say) rather than logged as one.
      if (e instanceof Error && /quiescence gate not met/.test(e.message)) result.blocked += 1;
      else result.failed += 1;
    }
  }

  // Stamped only after a pass that RAN, so a throttled call never buys itself a window
  // it did not use — the same rule `touchBoardMarker` follows.
  touchClosePassMarker(opts.markerDir, now);
  return result;
}

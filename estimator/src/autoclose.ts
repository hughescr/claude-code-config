/**
 * src/autoclose.ts — the SWEEPER CLOSE PASS (P1.7 / §6.2, Craig 2026-07-30).
 *
 * **The promise this file makes true.** §6.2's quiescence gate refuses a premature
 * `est close` and its remedy ends "leave the close to the sweeper". Nothing in the
 * sweeper closed anything. `closeTask` was reachable from exactly one place — the
 * `est close` CLI verb — so the sentence described a component that did not exist, and
 * the population it described (a task whose work finished, whose session went away, and
 * whose agent never came back to close it) simply accumulated as `in_progress` forever.
 * Those tasks are not merely untidy: an open task has no `outcome` row, so it
 * contributes nothing to `v_velocity`, and the calibration corpus silently omits every
 * task that ended the ordinary way instead of the ceremonial one.
 *
 * **Candidate filter FIRST, gate SECOND — never the other way round.** The quiescence
 * gate is five conditions, three of which read `turn`, `agent_run` and the live
 * `~/.claude/sessions/` directory. Running it over every open task on every sweep would
 * put a directory walk and three per-task queries on the micro-sweep's hot path. So this
 * module runs ONE indexed query that answers "could this task possibly be closeable" —
 * arm 1 of the gate, and nothing else — and only its hits pay for the full evaluation.
 * The gate is then evaluated in FULL, through `closeTask`'s ordinary path: no `--force`,
 * no `--accept`, no `heal`, no private shortcut. A candidate that fails any of the other
 * four arms is left exactly where it was, and the next sweep asks again.
 *
 * **The GATE decides the status, not the filter.** The filter is an optimisation, and an
 * optimisation is allowed to be conservative; a RULING is not. So the close status comes
 * from `QuiescenceReport.completion_kind`, which the gate computes over both alias shapes
 * and both terminal statuses — the filter's narrower answer is never consulted for
 * anything but candidacy. Three outcomes:
 *
 *  - `completion_kind === 'completed'` → closed **`completed`**. The harness's own
 *    TaskUpdate said the work finished. That is positive evidence.
 *  - `completion_kind === 'deleted'` → closed **`deleted`**. P1.11's delete-capture hook
 *    exists precisely so a `TaskUpdate status:"deleted"` survives a process death; a
 *    pass that folded that into `completed` or `abandoned` would launder the one signal
 *    that hook was built to preserve.
 *  - no signal at all, and silent past `close_abandon_after_h` → closed **`abandoned`**.
 *
 * **The abandon arm has its own, much longer clock (Craig, 2026-07-30 + review round).**
 * `STALE_CLOSE_HOURS` (48) is the GATE's permission threshold — "may this be closed at
 * all" — and it stays where it is. `close_abandon_after_h` (168, seven days) answers a
 * different question: "may it be closed AS A FAILURE, on no evidence either way". The two
 * were briefly the same number, and that was wrong in a way with an entirely ordinary
 * trigger: an auto-abandon permanently seals the task's attribution window, so a task
 * left quiet over a weekend would be abandoned by Monday's cron and every hour of resumed
 * work on it would land unattributed with nothing saying why. A week puts the boundary
 * past any normal gap in Craig's working week. Craig's ruling stands underneath it —
 * silence means the data is not calibration-grade, and `abandoned` is `censored = 1`, so
 * the actual enters the corpus as the LOWER BOUND it genuinely is instead of as a
 * completion nobody observed — but it is now a ruling with a margin, an ALERTING ledger
 * row (`swept_abandon`), and a signposted way back (`est close <tid> --status reopened`).
 *
 * **Provenance.** `outcome` has no "who closed this" column and this pass does not add
 * one: the mechanism for the provenance of a close is already the `anomaly` ledger —
 * that is what `forced_close` (nobody is named) and `accepted_close` (the human's words,
 * verbatim) are for, and `est retro` already reads both. So a swept close writes
 * `swept_close` (BENIGN) or `swept_abandon` (ALERTING) in the same transaction.
 *
 * **Throttle.** `close_pass_min_interval_min` (config, default 10) gates the pass on an
 * `mtime` check of a `.closepass.<db>` marker, the same filesystem mechanism P1.10 uses
 * for `.microsweep` and P2.7 uses for `.board`. Every hook fire in the machine spawns the
 * same `est sweep`, so without this a burst of micro-sweeps would run the candidate
 * query — and, worse, the full gate for every hit — several times a minute. The marker
 * is touched only AFTER the pass runs, so a throttled sweep costs nothing at all.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  closeTask,
  liveSessionPids,
  QuiescenceError,
  quiescence,
  STALE_CLOSE_HOURS,
  type FinalStatus,
  type QuiescenceReport,
} from "./close.ts";
import { configNum } from "./liveness.ts";
import { isoNow } from "./tasks.ts";
import { CLOSE_PASS_MARKER, closePassMarkerFile } from "./spool.ts";

/** Re-exported, never re-declared — `src/spool.ts` owns every name in the spool dir. */
export { CLOSE_PASS_MARKER, closePassMarkerFile };

/**
 * Minutes between close passes when `close_pass_min_interval_min` is unset or unusable.
 *
 * Ten, because the pass has nothing to gain from being faster: every candidate has
 * already been quiet for at least `quiesce_main_min` (60) by the time the gate lets it
 * through, so a task that becomes closeable at T is closed somewhere in [T, T+10min] —
 * a rounding error against the hour it had to be silent to qualify.
 */
export const DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN = 10;

/**
 * Hours of silence before a task with NO completion signal may be closed `abandoned`.
 *
 * Seven days, and deliberately NOT `STALE_CLOSE_HOURS` — see this file's header. The
 * abandon is the only thing this pass does that feels irreversible (it is reversible, by
 * `--status reopened`, but nothing prompts anyone to), and its cost is asymmetric: a
 * close that comes a week late costs a week of a row sitting on the board, while a close
 * that comes a weekend early costs every subsequent hour of that task's real work.
 */
export const DEFAULT_CLOSE_ABANDON_AFTER_H = 168;

/** Consecutive non-gate failures on one tid before `close_failed` is raised. */
export const DEFAULT_CLOSE_FAIL_ALERT_AFTER = 3;

/** Hours a candidate may be closeable and continuously refused before `close_blocked`. */
export const DEFAULT_CLOSE_BLOCKED_AFTER_H = 24;

export function closePassMinIntervalMin(db: Database): number {
  const v = configNum(db, "close_pass_min_interval_min", DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN;
}

export function closeAbandonAfterH(db: Database): number {
  const v = configNum(db, "close_abandon_after_h", DEFAULT_CLOSE_ABANDON_AFTER_H);
  // Never below the gate's own permission threshold: an abandon window shorter than the
  // window in which a close is permitted at all is a knob that cannot mean anything.
  return Number.isFinite(v) && v >= STALE_CLOSE_HOURS ? v : DEFAULT_CLOSE_ABANDON_AFTER_H;
}

export function closeFailAlertAfter(db: Database): number {
  const v = configNum(db, "close_fail_alert_after", DEFAULT_CLOSE_FAIL_ALERT_AFTER);
  return Number.isFinite(v) && v >= 1 ? Math.trunc(v) : DEFAULT_CLOSE_FAIL_ALERT_AFTER;
}

export function closeBlockedAfterH(db: Database): number {
  const v = configNum(db, "close_blocked_after_h", DEFAULT_CLOSE_BLOCKED_AFTER_H);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_CLOSE_BLOCKED_AFTER_H;
}

/** True when a pass is due: no marker, or the marker is older than the window. */
export function closePassDue(
  markerPath: string,
  minIntervalMin: number,
  now: Date = new Date(),
): boolean {
  let lastMs = 0;
  try {
    lastMs = statSync(markerPath).mtimeMs;
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
export function touchClosePassMarker(markerPath: string, now: Date = new Date()): void {
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, String(now.getTime()));
    // `closePassDue` reads mtime, not content. Pin it to the injected clock explicitly:
    // the filesystem always stamps real wall-clock time, which a test running at a
    // synthetic `now` would otherwise read as a marker from the future.
    utimesSync(markerPath, now, now);
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
 *    query. The index holds only linked TERMINAL rows — a few per finished task — rather
 *    than the whole lifecycle table. Both terminal statuses, because §6.2's gate reads
 *    both and a filter narrower than the gate would hide captured deletions from the
 *    pass entirely: they would reach it only via the staleness arm and be filed as
 *    `abandoned`, which is exactly the laundering P1.11's delete-capture exists to
 *    prevent.
 *  - `MAX(request.ts)` uses `ix_req_tid`. This is the same "last attributed activity"
 *    the gate computes, and it falls back to `task.created_at` for a task that never
 *    got a request attributed to it, exactly as `quiescence` does.
 *  - The outer `task.status IN (…)` is a SCAN of `task`, deliberately. `task` holds one
 *    row per `est open` ceremony (hundreds, lifetime), the three open statuses are most
 *    of it in any live database, and an index whose predicate matches most of the table
 *    is slower than the scan it replaces. The cost this pass exists to avoid is the
 *    per-candidate lifecycle scan, which is what the partial index above kills.
 *
 * **Every signal is bounded below by the task's latest REOPEN**, exactly as the gate
 * bounds its own. `task_event` is append-only, so without the floor the event that
 * justified the FIRST close makes a reopened task a candidate again forever.
 *
 * The floor here is a STRING compare where the gate's is a `julianday()` one, and the
 * asymmetry is deliberate. A string compare keeps `ts` usable as an index RANGE (the
 * plan shows `SEARCH e USING COVERING INDEX ix_task_event_completed (tid=? AND ts>?)`),
 * which is the whole point of this query; `julianday()` on the column would force a scan
 * of the partition. Its only inaccuracy is at sub-second precision — `task_event.ts`
 * carries milliseconds and `outcome.finalized_at` does not, and at index 19 `'.' < 'Z'` —
 * and that error is one-directional and harmless HERE: it can only fail to offer a
 * candidate, never mis-rule one, because the candidate reappears via the staleness arm
 * and the GATE (which compares exactly) makes every ruling.
 *
 * `pending_verification` is a candidate unconditionally: `quiescence` treats that status
 * as a completion signal in its own right (the harness said "done, awaiting check"), so
 * a filter that made it wait would contradict the gate it is filtering for.
 *
 * `AS MATERIALIZED` is load-bearing, not decoration. Without it SQLite flattens the CTE
 * into the outer `WHERE` and evaluates the correlated subqueries a second time per row
 * (visible in `EXPLAIN QUERY PLAN` as duplicated `CORRELATED SCALAR SUBQUERY` blocks) —
 * twice the indexed reads for the same answer. `test/autoclose.test.ts` pins the
 * `MATERIALIZE` line, because without that assertion removing the keyword is a silent
 * doubling that every other test still passes.
 */
export const CLOSE_PASS_CANDIDATE_SQL = `
WITH open_task AS MATERIALIZED (
  SELECT t.tid    AS tid,
         t.status AS status,
         COALESCE((SELECT MAX(o.finalized_at) FROM outcome o
                    WHERE o.tid = t.tid AND o.final_status = 'reopened'), '') AS reopened_at,
         COALESCE((SELECT MAX(r.ts) FROM request r WHERE r.tid = t.tid),
                  t.created_at) AS last_activity,
         EXISTS (SELECT 1 FROM task_event e
                  WHERE e.tid = t.tid AND e.tid IS NOT NULL
                    AND e.to_status IN ('completed','deleted')
                    AND e.ts > COALESCE((SELECT MAX(o2.finalized_at) FROM outcome o2
                                          WHERE o2.tid = t.tid
                                            AND o2.final_status = 'reopened'), '')) AS has_signal
    FROM task t
   WHERE t.status IN ('estimating','in_progress','pending_verification')
)
SELECT tid, status, last_activity, has_signal
  FROM open_task
 WHERE has_signal = 1
    OR status = 'pending_verification'
    OR last_activity < $stale_before
`;

export interface CloseCandidate {
  tid: string;
  status: string;
  /**
   * A linked terminal `task_event` postdating the latest reopen, or the
   * `pending_verification` status.
   *
   * ADVISORY ONLY. It decides candidacy and nothing else — the close STATUS comes from
   * `QuiescenceReport.completion_kind`, which is computed over both alias shapes and is
   * therefore never narrower than this. Two answers to "did this finish" would be two
   * things to drift apart; there is one, and this is not it.
   */
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
      signal: r.has_signal === 1 || r.status === "pending_verification",
      last_activity: r.last_activity,
    }));
}

/** One close this pass performed. */
export interface SweptClose {
  tid: string;
  status: FinalStatus;
  revision: number;
  /** Why: the gate observed a terminal signal, or the no-signal silence window elapsed. */
  reason: "completion_signal" | "stale";
}

export interface ClosePassResult {
  /** False => the pass did not run. `skipped` says why; nothing was even queried. */
  attempted: boolean;
  /**
   * Why the pass did not run: the throttle window, or a sweep whose corpus read was
   * incomplete. `null` when it ran.
   */
  skipped: "throttled" | "incomplete_sweep" | null;
  candidates: number;
  closed: SweptClose[];
  completed: number;
  abandoned: number;
  deleted: number;
  /** Candidates the FULL gate refused. Left open; the next pass asks again. */
  blocked: number;
  /** Candidates that threw for a reason other than the gate (no estimate, say). */
  failed: number;
  /**
   * Candidates whose no-signal silence has passed the gate's 48 h but not
   * `close_abandon_after_h`. Gate-eligible and deliberately NOT closed yet — reported
   * because "nothing happened" and "the safety margin is holding this back" are
   * different facts, and only one of them is worth waiting out.
   */
  awaiting_abandon: number;
}

export interface ClosePassOptions {
  now?: Date;
  /**
   * Full path of the `.closepass.<db>` throttle marker — see
   * {@link closePassMarkerFile}. Per DATABASE, never per directory: two databases whose
   * spool directories coincide (a live `estimator.db` and a `copy.db` someone is poking
   * at, with `EST_SPOOL_DIR` pointed at one place) must not share one throttle, or
   * sweeping the copy silences the live database's close pass for the whole window and
   * leaves real tasks open. `runSweep` derives it from `db.filename`.
   */
  markerPath: string;
  /**
   * The HOOK spool, passed through to `closeTask` so it can reap the P1.10 overrun
   * marker for each task it closes. Environment-overridable (`EST_SPOOL_DIR`) because
   * that is where the hooks write, which is exactly why it is a different parameter
   * from {@link markerPath}.
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
  /**
   * The sweep calling this could not read its corpus completely — it hit its wall-clock
   * budget, or at least one file's read aborted before EOF.
   *
   * **The pass is SKIPPED entirely.** A truncated read makes a task look quieter than it
   * is: the requests that would have moved `MAX(request.ts)` are precisely the ones that
   * were not read, so a live task can pass every arm of the gate and be closed on a
   * partial corpus. That is not self-healing the way a premature `--accept` close is —
   * `healClosedOutcomes` only re-checks tasks with spend that POSTDATES `finalized_at`,
   * and the rows a truncated sweep missed carry timestamps from BEFORE it, so they are
   * invisible to that repair forever. Not closing is free; closing wrong is not.
   */
  sweepIncomplete?: boolean;
}

const INSERT_CLOSE_ANOMALY_SQL = `
INSERT INTO anomaly (ts, kind, detail, tid)
SELECT ?, ?, ?, ?
 WHERE NOT EXISTS (SELECT 1 FROM anomaly WHERE kind = ? AND detail = ? AND tid = ?)
`;

/**
 * Provenance text. Deliberately free of any number that moves between sweeps: the ledger
 * dedups on (kind, detail, tid), and a figure in the key writes a row per pass.
 */
function sweptCloseDetail(status: FinalStatus, abandonAfterH: number): string {
  if (status === "abandoned") {
    return (
      `the sweeper closed this task as ABANDONED: no completion signal in the ${abandonAfterH}h ` +
      "after its last attributed request, so the actual is recorded RIGHT-CENSORED — a lower bound, " +
      "not a measurement (Craig 2026-07-30). If the work is in fact live, `est close <tid> --status reopened` " +
      "appends a correction and re-opens the attribution window; resumed work does NOT re-attach on its own"
    );
  }
  if (status === "deleted") {
    return (
      "the sweeper closed this task as DELETED: the §6.2 gate observed a terminal " +
      "task_event(to_status='deleted') — P1.11's captured deletion — and every gate arm was met. " +
      "No human ran `est close`, and no gate arm was bypassed"
    );
  }
  return (
    "the sweeper closed this task: the §6.2 gate observed a terminal " +
    "task_event(to_status='completed') and every arm was met in full. " +
    "No human ran `est close`, and no gate arm was bypassed"
  );
}

/** `completion_kind` → the status the close is filed under. Never the filter's answer. */
function statusForGate(gate: QuiescenceReport): FinalStatus | null {
  if (gate.completion_kind === "completed") return "completed";
  if (gate.completion_kind === "deleted") return "deleted";
  return null;
}

const FAIL_DETAIL = (alertAfter: number, message: string): string =>
  `the sweeper's close pass has failed ${alertAfter} times on this task for a non-gate reason ` +
  `(latest: ${message}) — it will never be finalized without intervention, so it contributes ` +
  "nothing to the calibration corpus";

/**
 * Record one non-gate close failure, and raise the ALERTING row once there have been
 * `alertAfter` of them for the same task.
 *
 * The counter lives in the ledger rather than in a new table, and it is BOUNDED: at most
 * `alertAfter` `close_attempt_failed` breadcrumbs are ever written per tid, because the
 * insert stops the moment the alert fires. Without the cap the breadcrumbs would be the
 * spam the alert exists to avoid — one row per pass, forever, for a task that will never
 * close. Each breadcrumb carries its ordinal and the error, so three of them are a
 * legible history rather than a bare count.
 */
function recordFailure(
  db: Database,
  tid: string,
  ts: string,
  message: string,
  alertAfter: number,
): void {
  const seen =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'close_attempt_failed' AND tid = ?",
      )
      .get(tid)?.n ?? 0;
  if (seen >= alertAfter) return; // already alerted; the history is complete
  const attempt = seen + 1;
  db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES (?, 'close_attempt_failed', ?, ?)").run(
    ts,
    `sweeper close attempt ${attempt}/${alertAfter} failed for a reason that was NOT the quiescence gate: ${message}`,
    tid,
  );
  if (attempt < alertAfter) return;
  const detail = FAIL_DETAIL(alertAfter, message);
  db.query(INSERT_CLOSE_ANOMALY_SQL).run(ts, "close_failed", detail, tid, "close_failed", detail, tid);
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
    skipped: null,
    candidates: 0,
    closed: [],
    completed: 0,
    abandoned: 0,
    deleted: 0,
    blocked: 0,
    failed: 0,
    awaiting_abandon: 0,
  };

  // Checked BEFORE the throttle, and it deliberately does NOT stamp the marker: a sweep
  // that could not read its corpus has not used up its window, and the next COMPLETE
  // sweep should run the pass immediately rather than wait another ten minutes.
  if (opts.sweepIncomplete === true) {
    result.skipped = "incomplete_sweep";
    return result;
  }
  if (opts.force !== true && !closePassDue(opts.markerPath, closePassMinIntervalMin(db), now)) {
    result.skipped = "throttled";
    return result;
  }
  result.attempted = true;
  const hookSpoolDir = opts.spoolDir;
  const abandonAfterH = closeAbandonAfterH(db);
  const blockedAfterH = closeBlockedAfterH(db);
  const failAlertAfter = closeFailAlertAfter(db);

  const candidates = closePassCandidates(db, now);
  result.candidates = candidates.length;
  const ts = isoNow(now);

  // ONE directory walk for the whole pass, threaded into every gate evaluation below.
  // `liveSessionPids` is a `readdir` plus a `JSON.parse` and a `kill(0)` per file; doing
  // that per candidate is the same answer recomputed N times per sweep — a per-item call
  // in a hot path, which is a defect rather than a style choice.
  const livePids = liveSessionPids();

  const anomalyOnce = (kind: string, detail: string, tid: string): void => {
    db.query(INSERT_CLOSE_ANOMALY_SQL).run(ts, kind, detail, tid, kind, detail, tid);
  };

  for (const c of candidates) {
    // The gate runs FIRST and ALONE, so its verdict — `completion_kind` included — is
    // what everything below reads. `closeTask` re-evaluates it inside the transaction;
    // that second evaluation is the authoritative one, and nothing writes between the
    // two, so a disagreement between them is impossible rather than merely unlikely.
    let gate: QuiescenceReport;
    try {
      gate = quiescence(db, c.tid, now, { livePids });
    } catch (e) {
      result.failed += 1;
      recordFailure(db, c.tid, ts, e instanceof Error ? e.message : String(e), failAlertAfter);
      continue;
    }

    const signalled = statusForGate(gate);
    if (signalled === null) {
      // No signal: the abandon arm, held back by its own much longer clock.
      const silentH = (now.getTime() - Date.parse(c.last_activity)) / 3_600_000;
      if (!(Number.isFinite(silentH) && silentH >= abandonAfterH)) {
        result.awaiting_abandon += 1;
        continue;
      }
    }
    const status: FinalStatus = signalled ?? "abandoned";

    if (!gate.ok) {
      result.blocked += 1;
      // A refusal is normal for minutes and suspicious for days. `eligibleSince` is the
      // moment this candidate first satisfied arm 1 — the staleness window for a
      // signalled task, the abandon window for a silent one — so the row claims only
      // what it can prove: "closeable for over N hours and still refused", with the ARM
      // named and no count in it, so (kind, detail, tid) holds it to one row per arm for
      // the life of the task.
      const eligibleSince =
        Date.parse(c.last_activity) +
        (signalled === null ? abandonAfterH : STALE_CLOSE_HOURS) * 3_600_000;
      if (
        Number.isFinite(eligibleSince) &&
        now.getTime() - eligibleSince >= blockedAfterH * 3_600_000
      ) {
        anomalyOnce(
          "close_blocked",
          `the sweeper's close pass has been refused by the quiescence gate for over ${blockedAfterH}h on: ` +
            `${gate.failing.join("; ")} — the task cannot be finalized while this holds, so it contributes ` +
            "nothing to the calibration corpus",
          c.tid,
        );
      }
      continue;
    }

    try {
      // ONE transaction per candidate, IMMEDIATE like every sibling sweep step: a
      // deferred BEGIN can upgrade to a write mid-transaction and take
      // SQLITE_BUSY_SNAPSHOT, which this loop would then swallow as a failure OF THE
      // TASK rather than of the lock. `closeTask` opens its own immediate transaction,
      // which nests as a SAVEPOINT — the shape `healClosedOutcomes` already relies on.
      let revision = 0;
      db.transaction(() => {
        const r = closeTask(db, {
          tid: c.tid,
          status,
          now,
          livePids,
          ...(hookSpoolDir === undefined ? {} : { spoolDir: hookSpoolDir }),
          ...(opts.attributed === true ? { attributed: true } : {}),
        });
        revision = r.revision;
        const detail = sweptCloseDetail(status, abandonAfterH);
        const kind = status === "abandoned" ? "swept_abandon" : "swept_close";
        db.query(INSERT_CLOSE_ANOMALY_SQL).run(ts, kind, detail, c.tid, kind, detail, c.tid);
      }).immediate();

      // AFTER the commit, never inside it. Pushed inside, a rollback left the tid on
      // `closed` AND counted in `failed` — two contradictory claims about one task, from
      // one pass, with the ledger agreeing with neither.
      result.closed.push({
        tid: c.tid,
        status,
        revision,
        reason: signalled === null ? "stale" : "completion_signal",
      });
      if (status === "completed") result.completed += 1;
      else if (status === "deleted") result.deleted += 1;
      else result.abandoned += 1;
    } catch (e) {
      // The gate refusing is the DESIGNED outcome, identified by CLASS rather than by a
      // regex over the message (see `QuiescenceError`). It can still land here despite
      // the pre-check above if `closeTask`'s own attribution pass moves the answer.
      if (e instanceof QuiescenceError) {
        result.blocked += 1;
        continue;
      }
      result.failed += 1;
      recordFailure(db, c.tid, ts, e instanceof Error ? e.message : String(e), failAlertAfter);
    }
  }

  // Stamped only after a pass that RAN, so a throttled call never buys itself a window
  // it did not use — the same rule `touchBoardMarker` follows.
  touchClosePassMarker(opts.markerPath, now);
  return result;
}

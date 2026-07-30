/**
 * src/burn.ts — `est burn`, its materialised cache, and the statusline contract.
 *
 * Three properties are non-negotiable here, because this code runs on Craig's screen
 * at a >= 5 s refresh interval, forever (P1.9): **it is fast, it never writes, and it
 * never shows an error.**
 *
 *  - **Fast.** Aggregating `v_wcet` over `request` at statusline cadence is not
 *    acceptable, so the read path is one indexed row from {@link refreshBurnCache}'s
 *    output. `--refresh` runs the live aggregation instead; it is for humans and for
 *    tests, and the statusline never passes it.
 *  - **Never writes.** The read connection is opened `readonly` with
 *    `PRAGMA query_only=ON` and a **50 ms** `busy_timeout` — it must fail fast rather
 *    than queue behind a running sweep. A statusline that blocks is worse than a
 *    statusline that is five seconds stale.
 *  - **Never shows an error.** No open estimate, no cache row, a busy database and a
 *    missing database are ALL the same well-formed `{"active": false, "reason": …}`
 *    answer at exit code 0, and the segment renders nothing at all. **A statusline
 *    that shows a wrong number is worse than one that shows nothing**, and a stale
 *    band from a task that closed yesterday is a wrong number.
 */

import type { Database } from "bun:sqlite";
import { getConfig, openDb, unvalidatedRetired } from "./db.ts";
import { isoNow, TERMINAL_TASK_STATUS } from "./tasks.ts";
import {
  buildEtaFit,
  checkBackForSession,
  countLiveAgents,
  formatEta,
  liveAgentMaxMin,
  type CheckBack,
  type CheckBackSeconds,
  type CheckBackState,
  type EtaFit,
  type EtaModel,
} from "./eta.ts";

/** Default rolling window for the burn rate, minutes (ccusage's `blocks.rs`, 5 h). */
export const DEFAULT_BURN_WINDOW_MIN = 300;

export function burnWindowMin(db: Database): number {
  const raw = getConfig(db, "burn_window_min");
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BURN_WINDOW_MIN;
}

export interface BurnAggregate {
  tid: string;
  consumed_wcet: number;
  wcet_main: number;
  wcet_sub: number;
  wcet_aux: number;
  usd: number;
  n_req: number;
  n_agents_live: number;
  n_agents_total: number;
  n_provisional: number;
  n_unpriced: number;
  active_s: number;
  burn_wcet_per_min: number;
  proj_total_wcet: number;
  first_ts: string | null;
  last_ts: string | null;
}

/**
 * `usd` carries the SAME `attr <> 'overhead'` guard as the Work-CET terms, and that
 * is not a stylistic matter: §5.4 rule 1 books the estimating skill's own requests to
 * the task's tid with `attr='overhead'`, so a dollar total that counted them while the
 * Work-CET denominator did not made `usd / consumed_wcet` — the ratio behind
 * `usd_per_hour` and `projection.total_usd` — a rate per unit of work that includes
 * spend no unit of work produced. One ceremony request inflated both several-fold.
 * Improving the ceremony must not worsen the numbers the ceremony produces.
 */
const AGG_SQL = `
SELECT
  COALESCE(SUM(CASE WHEN attr <> 'overhead' THEN wcet ELSE 0 END), 0) AS consumed_wcet,
  COALESCE(SUM(CASE WHEN origin='main'      AND attr<>'overhead' THEN wcet ELSE 0 END), 0) AS wcet_main,
  COALESCE(SUM(CASE WHEN origin='subagent'  AND attr<>'overhead' THEN wcet ELSE 0 END), 0) AS wcet_sub,
  COALESCE(SUM(CASE WHEN origin='auxiliary' AND attr<>'overhead' THEN wcet ELSE 0 END), 0) AS wcet_aux,
  COALESCE(SUM(CASE WHEN attr <> 'overhead'
                    THEN (in_tok*usd_in + out_tok*usd_out + cw_tok*usd_cw + cr_tok*usd_cr) / 1000000.0
                    ELSE 0 END), 0) AS usd,
  COUNT(*) AS n_req,
  MIN(ts) AS first_ts, MAX(ts) AS last_ts
FROM v_wcet WHERE tid = ?
`;

const WINDOW_SQL = `
SELECT COALESCE(SUM(CASE WHEN attr <> 'overhead' THEN wcet ELSE 0 END), 0) AS wcet,
       MIN(ts) AS first_ts, MAX(ts) AS last_ts
  FROM v_wcet WHERE tid = ? AND ts >= ?
`;

/**
 * Live aggregation for one task: consumed Work-CET, the origin split, USD, and the
 * ccusage-pattern burn rate + linear projection (§6.3).
 *
 * **The projection is crude and both output modes say so.** Its job is to answer
 * "will this blow the band in the next hour", not to forecast completion — a linear
 * extrapolation of a burn rate over a corpus where 97.4% of elapsed time is idle gaps
 * `[CB]` is not a completion model and must never be dressed as one.
 */
export function aggregateBurn(db: Database, tid: string, now: Date = new Date()): BurnAggregate {
  const base = db
    .query<
      {
        consumed_wcet: number;
        wcet_main: number;
        wcet_sub: number;
        wcet_aux: number;
        usd: number;
        n_req: number;
        first_ts: string | null;
        last_ts: string | null;
      },
      [string]
    >(AGG_SQL)
    .get(tid) ?? {
    consumed_wcet: 0,
    wcet_main: 0,
    wcet_sub: 0,
    wcet_aux: 0,
    usd: 0,
    n_req: 0,
    first_ts: null,
    last_ts: null,
  };

  const windowMin = burnWindowMin(db);
  const windowStart = new Date(now.getTime() - windowMin * 60_000);
  const win = db
    .query<{ wcet: number; first_ts: string | null; last_ts: string | null }, [string, string]>(WINDOW_SQL)
    .get(tid, isoNow(windowStart)) ?? { wcet: 0, first_ts: null, last_ts: null };

  // Rate over the OBSERVED span inside the window, not over the window's nominal
  // length: a task that started four minutes ago has not been idle for 296 of them,
  // and dividing by 300 would report a burn rate 75x too low at exactly the moment
  // the overrun nudge is supposed to fire.
  let spanMin = 0;
  if (win.first_ts !== null && win.last_ts !== null) {
    spanMin = (Date.parse(win.last_ts) - Date.parse(win.first_ts)) / 60_000;
  }
  const burnPerMin = spanMin > 0 ? win.wcet / spanMin : 0;

  const activeS = activeSeconds(db, tid);
  const agents = agentCounts(db, tid, now);
  const prices = priceFlagCounts(db, tid);
  // Linear: consumed + rate * (remaining time in this window). With no rate the
  // projection IS the consumption, which is the honest degenerate answer.
  const projectedExtra = burnPerMin > 0 ? burnPerMin * Math.max(0, windowMin - spanMin) : 0;
  return {
    tid,
    ...base,
    n_agents_live: agents.live,
    n_agents_total: agents.total,
    n_provisional: prices.provisional,
    n_unpriced: prices.unpriced,
    active_s: activeS,
    burn_wcet_per_min: burnPerMin,
    proj_total_wcet: Math.round(base.consumed_wcet + projectedExtra),
  };
}

/**
 * Bound agents: live (started, not ended, and still FRESH — the "2 agents live" of §6.3)
 * and total, from `agent_run(tid)`.
 *
 * Both land in `burn_cache`. The statusline reads them back off that row and never
 * calls this: `COUNT(*) FROM agent_run WHERE tid = ?` on the render path was a table
 * SCAN before `ix_agent_run_tid` and is a per-render count of an unbounded table
 * after it, and P1.9's budget is ONE indexed row read, not "a cheap query".
 *
 * **`live` goes through `countLiveAgents` (Craig, 2026-07-30) so this number and the idle
 * predicate cannot disagree.** Before the age bound, a session could render "1 agent" and
 * `⏸ awaiting input` in the same breath — the count saying work was in flight while the
 * suppression said nothing was — which is worse than either answer alone. `total` is
 * deliberately NOT bounded: it is the census of every agent this task ever launched, and a
 * dead one still ran.
 *
 * `now` defaults for callers that have none; `aggregateBurn` — the only production caller
 * — always passes the sweep's clock.
 */
export function agentCounts(
  db: Database,
  tid: string,
  now: Date = new Date(),
): { live: number; total: number } {
  const total =
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM agent_run WHERE tid = ?")
      .get(tid)?.n ?? 0;
  return { live: countLiveAgents(db, { tid }, now, liveAgentMaxMin(db)), total };
}

/** Live agents alone — kept as the named concept §6.3 talks about. */
export function liveAgents(db: Database, tid: string, now: Date = new Date()): number {
  return agentCounts(db, tid, now).live;
}

/**
 * Requests on this task priced provisionally, and requests with no price at all —
 * the evidence behind the `provisional_price` / `unpriced` warnings.
 *
 * This walks the task's whole request history through `v_priced`/`v_unpriced`, each
 * row of which resolves its own price by correlated subquery. That is a per-sweep
 * cost, never a per-render one: measured at ~127 ms on a task with 200k requests, it
 * was by far the dominant term in a statusline render before it moved into the cache.
 */
export function priceFlagCounts(db: Database, tid: string): { provisional: number; unpriced: number } {
  const row = db
    .query<{ n_prov: number; n_unpriced: number }, [string, string]>(
      `SELECT
         (SELECT COUNT(*) FROM v_priced WHERE tid = ? AND provisional = 1) AS n_prov,
         (SELECT COUNT(*) FROM v_unpriced WHERE tid = ?) AS n_unpriced`,
    )
    .get(tid, tid);
  return { provisional: row?.n_prov ?? 0, unpriced: row?.n_unpriced ?? 0 };
}

export interface TimeInterval {
  start: number;
  end: number;
}

export interface UnionResult {
  /** Measure of the UNION — async fan-out is visible rather than collapsed. */
  activeS: number;
  /** Sum of interval lengths. `busy_s / active_s` is the parallelism factor. */
  busyS: number;
  maxConcurrency: number;
}

/**
 * Sweep line over interval endpoints (§7.3).
 *
 * R1 defined active time as the SUM of attributed turn durations, which counts an
 * async fan-out as costing only the seconds the orchestrator spent launching it —
 * for exactly the async case Craig cares about, wall time was invisible. The union
 * fixes that: an agent running three hours past its launching turn contributes three
 * hours. `max_concurrency` and `parallelism_factor` fall out of the same pass, which
 * turns parallelism from an asserted global constant into a per-task measurement.
 */
export function intervalUnion(intervals: readonly TimeInterval[]): UnionResult {
  const events: Array<{ at: number; delta: number }> = [];
  let busyMs = 0;
  for (const i of intervals) {
    if (!Number.isFinite(i.start) || !Number.isFinite(i.end) || i.end <= i.start) continue;
    events.push({ at: i.start, delta: 1 }, { at: i.end, delta: -1 });
    busyMs += i.end - i.start;
  }
  if (events.length === 0) return { activeS: 0, busyS: 0, maxConcurrency: 0 };
  // Closes before opens at the same instant: two back-to-back intervals are one
  // continuous stretch at depth 1, not a momentary depth of 2.
  events.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at - b.at));

  let depth = 0;
  let maxDepth = 0;
  let openedAt = 0;
  let unionMs = 0;
  for (const e of events) {
    if (depth === 0 && e.delta === 1) openedAt = e.at;
    depth += e.delta;
    if (depth > maxDepth) maxDepth = depth;
    if (depth === 0) unionMs += e.at - openedAt;
  }
  return {
    activeS: Math.round(unionMs / 1000),
    busyS: Math.round(busyMs / 1000),
    maxConcurrency: maxDepth,
  };
}

/** Turn + agent intervals for a task, in epoch ms. */
export function taskIntervals(db: Database, tid: string): TimeInterval[] {
  const out: TimeInterval[] = [];
  for (const t of db
    .query<{ started_at: string; duration_ms: number | null }, [string]>(
      "SELECT started_at, duration_ms FROM turn WHERE tid = ?",
    )
    .all(tid)) {
    const start = Date.parse(t.started_at);
    if (!Number.isFinite(start)) continue;
    out.push({ start, end: start + (t.duration_ms ?? 0) });
  }
  for (const a of db
    .query<{ started_at: string | null; ended_at: string | null }, [string]>(
      "SELECT started_at, ended_at FROM agent_run WHERE tid = ?",
    )
    .all(tid)) {
    if (a.started_at === null || a.ended_at === null) continue;
    out.push({ start: Date.parse(a.started_at), end: Date.parse(a.ended_at) });
  }
  return out;
}

export function activeSeconds(db: Database, tid: string): number {
  return intervalUnion(taskIntervals(db, tid)).activeS;
}

// ---------------------------------------------------------------------------
// the compute clock (§7.3 clock 1) and the session the forecast belongs to
// ---------------------------------------------------------------------------

export interface ComputeClock {
  /** `SUM(duration_ms)/1000` over the task's attributed requests. */
  s: number;
  /**
   * Share of those requests that actually CARRY a duration.
   *
   * A compute figure without its coverage is a number whose denominator moved: the
   * column is NULL on every request until OTEL fills it (P2.4), so an uncaveated sum
   * over a 12%-covered corpus reads as "this task used 90 seconds of compute" when
   * what it means is "the eighth of it we can see did".
   */
  coverage_pct: number;
}

export function computeClock(db: Database, tid: string): ComputeClock {
  const row = db
    .query<{ n: number; n_dur: number; tot_ms: number }, [string]>(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS n_dur,
              COALESCE(SUM(duration_ms), 0) AS tot_ms
         FROM v_request_live WHERE tid = ?`,
    )
    .get(tid);
  const n = row?.n ?? 0;
  return {
    s: Math.round((row?.tot_ms ?? 0) / 1000),
    coverage_pct: n > 0 ? round1(((row?.n_dur ?? 0) / n) * 100) : 0,
  };
}

/**
 * Which SESSION the check-back forecast for this task is about.
 *
 * `burn_cache` is keyed by tid and the forecast is session-scoped (P2.1), so the two
 * have to be joined somewhere. The rule: among the sessions bound to the task, prefer
 * the most recently bound one that HAS an open segment; fall back to the most recently
 * bound. In practice the statusline resolved this very tid FROM its own session, so
 * the two coincide; the preference is what keeps a task bound to several sessions from
 * reporting the ETA of a session that stopped hours ago.
 */
export function forecastSessionForTask(db: Database, tid: string): string | null {
  const bound = db
    .query<{ session_id: string }, [string]>(
      "SELECT session_id FROM task_alias WHERE tid = ? ORDER BY first_seen DESC, session_id DESC",
    )
    .all(tid)
    .map((r) => r.session_id);
  if (bound.length === 0) return null;
  for (const sid of bound) {
    const open = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM run_segment WHERE session_id = ? AND terminator = 'open'",
      )
      .get(sid);
    if ((open?.n ?? 0) > 0) return sid;
  }
  return bound[0]!;
}

/**
 * What the check-back field says about a task, via its session — the forecast, or the
 * fact that Claude is blocked on the human (P2.2, Craig 2026-07-30).
 *
 * A task bound to no session is neither: nothing here can observe whether anybody is
 * waiting, and `{waiting: false, forecast: null}` is the existing "no answer" shape.
 */
export function checkBackStateForTask(
  db: Database,
  tid: string,
  fit: EtaFit,
  now: Date,
): CheckBackState {
  const session = forecastSessionForTask(db, tid);
  if (session === null) return { waiting: false, forecast: null };
  return checkBackForSession(db, session, fit, now);
}

/**
 * The forecast alone, for callers that only want the band. Prefer
 * {@link checkBackStateForTask}: this one cannot tell "nothing to forecast" from
 * "Claude is waiting for you", and the payload has to.
 */
export function checkBackForTask(
  db: Database,
  tid: string,
  fit: EtaFit,
  now: Date,
): CheckBackSeconds | null {
  return checkBackStateForTask(db, tid, fit, now).forecast;
}

// ---------------------------------------------------------------------------
// the cache
// ---------------------------------------------------------------------------

const UPSERT_BURN_SQL = `
INSERT INTO burn_cache (tid, as_of, consumed_wcet, wcet_main, wcet_sub, wcet_aux, usd, n_req,
                        n_agents_live, n_agents_total, n_provisional, n_unpriced,
                        active_s, burn_wcet_per_min, proj_total_wcet,
                        seg_started_at, seg_elapsed_s, check_back_p50_s, check_back_p90_s,
                        eta_model, eta_probation, eta_n_seg, compute_s, compute_coverage_pct,
                        eta_waiting_on_input)
VALUES ($tid, $as_of, $consumed_wcet, $wcet_main, $wcet_sub, $wcet_aux, $usd, $n_req,
        $n_agents_live, $n_agents_total, $n_provisional, $n_unpriced,
        $active_s, $burn_wcet_per_min, $proj_total_wcet,
        $seg_started_at, $seg_elapsed_s, $check_back_p50_s, $check_back_p90_s,
        $eta_model, $eta_probation, $eta_n_seg, $compute_s, $compute_coverage_pct,
        $eta_waiting_on_input)
ON CONFLICT(tid) DO UPDATE SET
  as_of = excluded.as_of, consumed_wcet = excluded.consumed_wcet,
  wcet_main = excluded.wcet_main, wcet_sub = excluded.wcet_sub, wcet_aux = excluded.wcet_aux,
  usd = excluded.usd, n_req = excluded.n_req, n_agents_live = excluded.n_agents_live,
  n_agents_total = excluded.n_agents_total, n_provisional = excluded.n_provisional,
  n_unpriced = excluded.n_unpriced,
  active_s = excluded.active_s, burn_wcet_per_min = excluded.burn_wcet_per_min,
  proj_total_wcet = excluded.proj_total_wcet,
  seg_started_at = excluded.seg_started_at, seg_elapsed_s = excluded.seg_elapsed_s,
  check_back_p50_s = excluded.check_back_p50_s, check_back_p90_s = excluded.check_back_p90_s,
  eta_model = excluded.eta_model, eta_probation = excluded.eta_probation,
  eta_n_seg = excluded.eta_n_seg,
  compute_s = excluded.compute_s, compute_coverage_pct = excluded.compute_coverage_pct,
  eta_waiting_on_input = excluded.eta_waiting_on_input
`;

/**
 * Recompute `burn_cache` for every non-terminal task. Called by the sweeper —
 * including the §6.3 micro-sweep — INSIDE the sweep's existing transaction, which is
 * why it takes no lock of its own.
 *
 * Rows for tasks that have since gone terminal are DELETED rather than left to rot:
 * `est burn` resolving to a closed task's stale band is precisely the "wrong number"
 * P1.9 exists to make impossible.
 */
export function refreshBurnCache(db: Database, now: Date = new Date()): number {
  const asOf = isoNow(now);
  const open = db
    .query<{ tid: string }, []>(
      `SELECT t.tid FROM task t
        WHERE t.status NOT IN ('completed','abandoned','deleted')
          AND NOT EXISTS (SELECT 1 FROM v_outcome_current o
                           WHERE o.tid = t.tid AND o.final_status <> 'reopened')`,
    )
    .all();
  const keep = new Set(open.map((r) => r.tid));

  // ONE fit for the whole sweep. The KM curve is a property of the corpus, not of a
  // task, and refitting it per open task would be the unbounded per-render work the
  // cache exists to abolish, merely moved into the writer.
  const fit = buildEtaFit(db);

  const stmt = db.prepare(UPSERT_BURN_SQL);
  for (const { tid } of open) {
    const agg = aggregateBurn(db, tid, now);
    // The WHOLE state, not just the band: when the session is idle every forecast column
    // is written NULL and the flag carries the answer instead. Storing a suppressed
    // forecast "in case" is how a stale number gets back on screen the moment a reader
    // forgets to check the flag.
    const st = checkBackStateForTask(db, tid, fit, now);
    const cb = st.forecast;
    const compute = computeClock(db, tid);
    stmt.run({
      $tid: tid,
      $as_of: asOf,
      $consumed_wcet: agg.consumed_wcet,
      $wcet_main: agg.wcet_main,
      $wcet_sub: agg.wcet_sub,
      $wcet_aux: agg.wcet_aux,
      $usd: agg.usd,
      $n_req: agg.n_req,
      $n_agents_live: agg.n_agents_live,
      $n_agents_total: agg.n_agents_total,
      $n_provisional: agg.n_provisional,
      $n_unpriced: agg.n_unpriced,
      $active_s: agg.active_s,
      $burn_wcet_per_min: agg.burn_wcet_per_min,
      $proj_total_wcet: agg.proj_total_wcet,
      $seg_started_at: cb?.seg_started_at ?? null,
      $seg_elapsed_s: cb?.seg_elapsed_s ?? null,
      $check_back_p50_s: cb?.p50_s ?? null,
      $check_back_p90_s: cb?.p90_s ?? null,
      $eta_model: cb?.eta_model ?? null,
      $eta_probation: cb === null ? null : cb.probation ? 1 : 0,
      // P1.9 again: `n_seg` is the LAST field of the payload that was still an
      // aggregate at render time (`COUNT(*) FROM run_segment`, an unindexed scan on
      // `gap_min`). `checkBackForTask` already has the number in hand here, so the
      // write pays for it once per sweep instead of once per statusline refresh.
      $eta_n_seg: cb?.n_seg ?? null,
      $compute_s: compute.s,
      $compute_coverage_pct: compute.coverage_pct,
      // 0, not NULL, when the session is busy: NULL is reserved for a row written by a
      // binary that predates the column, and `burnJson` reads that as "not waiting" for
      // exactly one sweep. Writing 0 makes the distinction unnecessary going forward.
      $eta_waiting_on_input: st.waiting ? 1 : 0,
    } as never);
  }
  const stale = db.query<{ tid: string }, []>("SELECT tid FROM burn_cache").all();
  const del = db.prepare("DELETE FROM burn_cache WHERE tid = ?");
  for (const row of stale) if (!keep.has(row.tid)) del.run(row.tid);
  return open.length;
}

// ---------------------------------------------------------------------------
// the JSON contract (P1.9)
// ---------------------------------------------------------------------------

export type BurnWarn = "over_p50" | "over_p90" | "stale" | "provisional_price" | "unpriced";
export type EmptyReason = "no_open_estimate" | "no_cache" | "db_busy" | "db_missing";

/**
 * `check_back` when Claude is blocked on the human (Craig, 2026-07-30).
 *
 * "Blocked" means no FRESH delegation is in flight: an unfinished `agent_run` or
 * `workflow_run` stops counting once it has been silent for `config.eta_live_agent_max_min`
 * (src/eta.ts `countLiveAgents`), because "started and never ended" is also what a dead
 * agent looks like and one corpse would otherwise pin its session as busy forever.
 *
 * Deliberately ONE field. The temptation is to attach the last segment's start, or how
 * long the session has been quiet, and both would be read as a forecast in disguise —
 * "waiting since 14:32" invites the arithmetic the estimand refuses. The whole content
 * of this object is that there is no forecast to make, and why.
 *
 * A separate SHAPE rather than a flag inside {@link CheckBack} for the same reason: a
 * band with `waiting_on_input: true` and numbers in it would let a consumer render the
 * numbers, which is the defect this exists to prevent.
 */
export interface CheckBackWaiting {
  waiting_on_input: true;
}

/** Discriminator for the two non-null `check_back` shapes. */
export function isWaitingOnInput(
  cb: CheckBack | CheckBackWaiting | null | undefined,
): cb is CheckBackWaiting {
  return cb !== null && cb !== undefined && "waiting_on_input" in cb;
}

/**
 * HOW the task in this payload was chosen (P1.6's resolution order), so a consumer can
 * tell an answer from a guess.
 *
 *  - `explicit`  — the caller named the tid.
 *  - `session`   — a `task_alias` row bound the caller's session to it.
 *  - `fallback`  — NOTHING bound it: this is the most recently touched non-terminal
 *    task in the whole database, which may belong to another session entirely. It is
 *    a reasonable answer for a human typing `est burn`, and a WRONG number for a
 *    statusline that supplied a session and got someone else's task back, so the
 *    segment renders nothing at all for it (P1.9).
 */
export type BurnTarget = "explicit" | "session" | "fallback";

export interface BurnEmpty {
  schema: 1;
  active: false;
  as_of: string;
  reason: EmptyReason;
}

export interface BurnActive {
  schema: 1;
  active: true;
  as_of: string;
  stale_s: number;
  tid: string;
  /** Provenance of `tid` — see {@link BurnTarget}. A guess is labelled as one. */
  target: BurnTarget;
  subject: string;
  kind: string;
  status: string;
  wcet: { consumed: number; p50: number; p90: number; pct_p50: number; pct_p90: number };
  split: { main: number; sub: number; aux: number };
  requests: { n: number; p50: number | null; p90: number | null };
  agents: { live: number; total: number };
  time: { active_s: number; p50_s: number | null; p90_s: number | null };
  burn: { wcet_per_min: number; usd_per_hour: number; window_min: number };
  projection: {
    total_wcet: number;
    total_usd: number;
    minutes_to_p90: number | null;
    method: "linear";
    crude: true;
  };
  band: {
    eid: number;
    reason: string;
    uncalibrated: boolean;
    ref_model: string;
    estimand: string;
    price_epoch: string;
    refclass_as_of: string | null;
  };
  /**
   * False iff `config.unvalidated_retired_at` is present — and `est recon --certify`
   * is its only writer (P2.6). It stays TRUE by default and for as long as
   * reconciliation has not run: the number is ours and unchecked against any
   * Anthropic-computed total, and the statusline must say so.
   *
   * This is a boolean rather than the literal `true` it was in P1.9, which is an
   * ADDITIVE change under P2.0's rule — no field removed, no field retyped from the
   * consumer's point of view (`scripts/statusline-burn.ts` already reads it as a
   * truthy test) — so `"schema"` stays 1.
   */
  unvalidated: boolean;
  /**
   * The check-back forecast (P2.1) — Claude-ACTIVE minutes to the next human-input
   * boundary. **Session-scoped**, which is why it sits in its own object rather than
   * inside `wcet` or `time`: every other number in this payload is about the task.
   *
   * THREE shapes, and a consumer has to handle all three:
   *
   *  - a {@link CheckBack} band — a forecast was issued;
   *  - `{waiting_on_input: true}` — Claude is blocked on the human, so there is nothing
   *    to forecast (see {@link CheckBackWaiting});
   *  - `null` — no answer either way: the resolved session has no open segment, or
   *    fewer than `config.eta_min_fit` closed segments exist to fit, or the task is
   *    bound to no session at all.
   *
   * All three are well-formed answers at exit 0, on the same rule as every other empty
   * result. ADDITIVE under P2.0's rule — no field removed, none retyped, and a field
   * that was already `object | null` gaining a second object shape is the same widening
   * `unvalidated` made when it stopped being the literal `true` — so `"schema"` stays
   * `1`. What it does cost is a re-read of every consumer that DEREFERENCES the object:
   * `scripts/statusline-burn.ts` and `renderBurn` below both discriminate on
   * `waiting_on_input` (via {@link isWaitingOnInput}) rather than on truthiness. The
   * board (`src/retro.ts`) reads the `burn_cache` COLUMNS instead of this payload, and
   * needs no change for a different reason: the sweeper nulls every forecast column when
   * it sets the flag, so an idle session's card simply carries no check-back line.
   */
  check_back: CheckBack | CheckBackWaiting | null;
  /**
   * §7.3 clock 1. `s` is `SUM(request.duration_ms)/1000` over the task's attributed
   * requests and `coverage_pct` is the share that carry one — see {@link ComputeClock}
   * for why the second number is not optional.
   */
  compute: ComputeClock;
  warn: BurnWarn[];
}

export type BurnJson = BurnActive | BurnEmpty;

export interface BurnTargetOptions {
  tid?: string | null;
  session?: string | null;
}

export interface BurnTargetResolution {
  tid: string | null;
  /** Which step of the order produced `tid` (or would have, when it is null). */
  target: BurnTarget;
}

/**
 * Target resolution, in P1.6's order: explicit `<tid>` -> the tid bound to
 * `--session` -> the resolved anchor session's binding -> the most recently touched
 * non-terminal task. **If none resolves, that is the EMPTY RESULT, not an error.**
 *
 * The last step is a GUESS and is reported as one. It is kept — a human typing
 * `est burn` with no arguments means "the thing I am working on", and the most
 * recently touched open task is the best available reading of that — but the payload
 * says `target: "fallback"` so a caller that supplied a session and got an unrelated
 * task back can decline to render it.
 */
export function resolveBurnTarget(db: Database, opts: BurnTargetOptions = {}): BurnTargetResolution {
  const nonTerminal = (tid: string): boolean => {
    const t = db.query<{ status: string }, [string]>("SELECT status FROM task WHERE tid = ?").get(tid);
    if (t === null || t === undefined) return false;
    if (TERMINAL_TASK_STATUS.has(t.status)) return false;
    const o = db
      .query<{ final_status: string }, [string]>("SELECT final_status FROM v_outcome_current WHERE tid = ?")
      .get(tid);
    return o === null || o === undefined || o.final_status === "reopened";
  };

  if (opts.tid !== null && opts.tid !== undefined && opts.tid !== "") {
    return { tid: nonTerminal(opts.tid) ? opts.tid : null, target: "explicit" };
  }
  const session = opts.session ?? process.env.EST_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? null;
  if (session !== null && session !== "") {
    // A session hosts many tasks (schema v6), so this asks for the NEWEST binding
    // first: the statusline follows the work in front of Craig, not the first task
    // this session ever opened. `tid` breaks ties because uuidv7 sorts by mint time,
    // which keeps two same-second bindings from resolving differently run to run.
    const bound = db
      .query<{ tid: string }, [string]>(
        "SELECT tid FROM task_alias WHERE session_id = ? ORDER BY first_seen DESC, tid DESC",
      )
      .all(session);
    for (const b of bound) if (nonTerminal(b.tid)) return { tid: b.tid, target: "session" };
  }
  const recent = db
    .query<{ tid: string }, []>(
      `SELECT t.tid FROM task t
        WHERE t.status NOT IN ('completed','abandoned','deleted')
          AND NOT EXISTS (SELECT 1 FROM v_outcome_current o
                           WHERE o.tid = t.tid AND o.final_status <> 'reopened')
        ORDER BY COALESCE((SELECT MAX(ts) FROM request WHERE tid = t.tid), t.created_at) DESC
        LIMIT 1`,
    )
    .get();
  return { tid: recent?.tid ?? null, target: "fallback" };
}

interface BandRow {
  eid: number;
  reason: string;
  cal_p50_wcet: number;
  cal_p90_wcet: number;
  cal_req_p50: number | null;
  cal_req_p90: number | null;
  active_p50_s: number | null;
  active_p90_s: number | null;
  ref_model: string;
  estimand: string;
  price_epoch: string;
  refclass_as_of: string | null;
  shrink_w: number;
}

/** The CURRENT band (max eid). Accuracy is judged against MIN(eid); the live burn
 *  bar is not accuracy — it is "am I about to blow the number I most recently
 *  committed to", so it reads the newest. */
export function currentBand(db: Database, tid: string): BandRow | null {
  return (
    db
      .query<BandRow, [string]>(
        `SELECT eid, reason, cal_p50_wcet, cal_p90_wcet, cal_req_p50, cal_req_p90,
                active_p50_s, active_p90_s, ref_model, estimand, price_epoch, refclass_as_of, shrink_w
           FROM estimate WHERE tid = ? ORDER BY eid DESC LIMIT 1`,
      )
      .get(tid) ?? null
  );
}

/**
 * Drop the seconds-precision fields before the object reaches the payload.
 *
 * They exist for the `burn_cache` columns and nowhere else: a seconds-precision ETA
 * from a model whose p90 is 30× its p50 is theatre, and the surest way for one to end
 * up on screen is for the JSON contract to carry it "just in case".
 */
function stripSeconds(cb: CheckBackSeconds): CheckBack {
  return {
    p50_min: cb.p50_min,
    p90_min: cb.p90_min,
    seg_started_at: cb.seg_started_at,
    seg_elapsed_min: cb.seg_elapsed_min,
    eta_model: cb.eta_model,
    n_seg: cb.n_seg,
    probation: cb.probation,
    basis: cb.basis,
  };
}

export interface BurnJsonOptions {
  tid?: string | null;
  session?: string | null;
  refresh?: boolean;
  now?: Date;
  /** A cache row older than this many seconds adds the `stale` warning. */
  staleAfterS?: number;
}

/** Build the P1.9 object from an already-open (possibly read-only) connection. */
export function burnJson(db: Database, opts: BurnJsonOptions = {}): BurnJson {
  const now = opts.now ?? new Date();
  const asOf = isoNow(now);
  const { tid, target } = resolveBurnTarget(db, {
    tid: opts.tid ?? null,
    session: opts.session ?? null,
  });
  if (tid === null) return { schema: 1, active: false, as_of: asOf, reason: "no_open_estimate" };

  const band = currentBand(db, tid);
  if (band === null) return { schema: 1, active: false, as_of: asOf, reason: "no_open_estimate" };

  const meta = db
    .query<{ kind: string; status: string; subject: string }, [string]>(
      `SELECT t.kind AS kind, t.status AS status, s.subject AS subject
         FROM task t JOIN v_scope_current s ON s.tid = t.tid WHERE t.tid = ?`,
    )
    .get(tid);
  if (meta === null || meta === undefined) {
    return { schema: 1, active: false, as_of: asOf, reason: "no_open_estimate" };
  }

  let consumed: number;
  let main: number;
  let sub: number;
  let aux: number;
  let usd: number;
  let nReq: number;
  let liveAgentCount: number;
  let totalAgents: number;
  let nProvisional: number;
  let nUnpriced: number;
  let activeS: number;
  let perMin: number;
  let projTotal: number;
  let cacheAsOf: string;
  let checkBack: CheckBack | CheckBackWaiting | null;
  let compute: ComputeClock;

  if (opts.refresh === true) {
    const agg = aggregateBurn(db, tid, now);
    // `--refresh` is the live path by contract: it refits the corpus rather than
    // reading yesterday's columns. It is for humans and for tests; the statusline
    // never passes it, and this is why.
    const st = checkBackStateForTask(db, tid, buildEtaFit(db), now);
    checkBack = st.waiting
      ? { waiting_on_input: true }
      : st.forecast === null
        ? null
        : stripSeconds(st.forecast);
    compute = computeClock(db, tid);
    consumed = agg.consumed_wcet;
    main = agg.wcet_main;
    sub = agg.wcet_sub;
    aux = agg.wcet_aux;
    usd = agg.usd;
    nReq = agg.n_req;
    liveAgentCount = agg.n_agents_live;
    totalAgents = agg.n_agents_total;
    nProvisional = agg.n_provisional;
    nUnpriced = agg.n_unpriced;
    activeS = agg.active_s;
    perMin = agg.burn_wcet_per_min;
    projTotal = agg.proj_total_wcet;
    cacheAsOf = asOf;
  } else {
    // ONE primary-key row, and every derived fact the payload needs is a column of
    // it. Nothing on this path may touch `request`, `agent_run` or a priced view:
    // those are unbounded in corpus size, and P1.9's budget is a bounded read at a
    // 5 s cadence forever, not "fast enough on today's database".
    const row = db
      .query<
        {
          as_of: string;
          consumed_wcet: number | null;
          wcet_main: number | null;
          wcet_sub: number | null;
          wcet_aux: number | null;
          usd: number | null;
          n_req: number | null;
          n_agents_live: number | null;
          n_agents_total: number | null;
          n_provisional: number | null;
          n_unpriced: number | null;
          active_s: number | null;
          burn_wcet_per_min: number | null;
          proj_total_wcet: number | null;
          seg_started_at: string | null;
          seg_elapsed_s: number | null;
          check_back_p50_s: number | null;
          check_back_p90_s: number | null;
          eta_model: string | null;
          eta_probation: number | null;
          eta_n_seg: number | null;
          compute_s: number | null;
          compute_coverage_pct: number | null;
          eta_waiting_on_input: number | null;
        },
        [string]
      >("SELECT * FROM burn_cache WHERE tid = ?")
      .get(tid);
    if (row === null || row === undefined) {
      return { schema: 1, active: false, as_of: asOf, reason: "no_cache" };
    }
    consumed = row.consumed_wcet ?? 0;
    main = row.wcet_main ?? 0;
    sub = row.wcet_sub ?? 0;
    aux = row.wcet_aux ?? 0;
    usd = row.usd ?? 0;
    nReq = row.n_req ?? 0;
    liveAgentCount = row.n_agents_live ?? 0;
    // NULL only for a row written before the v6 -> v7 widening; the next sweep
    // fills it, which is the documented cost of this cache being a cache.
    totalAgents = row.n_agents_total ?? 0;
    nProvisional = row.n_provisional ?? 0;
    nUnpriced = row.n_unpriced ?? 0;
    activeS = row.active_s ?? 0;
    perMin = row.burn_wcet_per_min ?? 0;
    projTotal = row.proj_total_wcet ?? consumed;
    cacheAsOf = row.as_of;
    // Straight out of the columns, with NO re-derivation against `now`. A conditional
    // residual-life quantile is not a countdown — subtracting the staleness from it
    // would be arithmetic on a number that was never a remaining-seconds counter — and
    // the drift is bounded anyway: the segment blanks entirely once `stale` fires.
    // Every column is NULL on a row written before the v7 -> v8 rebuild, which is one
    // sweep away and reads as "no forecast yet", exactly like too thin a corpus.
    //
    // The waiting flag is read FIRST and outranks the columns, mirroring
    // `checkBackForSession`'s precedence — and the sweeper writes the forecast columns
    // NULL whenever it sets the flag, so the two cannot contradict each other even if a
    // future reader gets the order wrong. NULL means "written by a binary older than the
    // column", which reads as not-waiting for the one sweep it takes to fill in.
    checkBack = (row.eta_waiting_on_input ?? 0) !== 0
      ? { waiting_on_input: true }
      : row.seg_started_at === null || row.check_back_p50_s === null || row.eta_model === null
        ? null
        : {
            p50_min: Math.round(row.check_back_p50_s / 60),
            p90_min: Math.round((row.check_back_p90_s ?? row.check_back_p50_s) / 60),
            seg_started_at: row.seg_started_at,
            seg_elapsed_min: Math.round((row.seg_elapsed_s ?? 0) / 60),
            eta_model: row.eta_model as EtaModel,
            // OUT OF THE ROW, never `etaCorpusSize(db)`: that was a COUNT(*) over
            // `run_segment` filtered on `gap_min`, which no index covers, so the one
            // read path that promises to be bounded by the ROW was doing a table scan
            // that grew with the corpus. NULL only on a pre-v8 row, which reads as
            // "0 segments" for the one sweep it takes to fill in.
            n_seg: row.eta_n_seg ?? 0,
            // NULL reads as "on probation": the marker's default is ON, and a missing
            // value is not evidence that a model earned its way off it.
            probation: (row.eta_probation ?? 1) !== 0,
            basis: "session",
          };
    compute = { s: row.compute_s ?? 0, coverage_pct: row.compute_coverage_pct ?? 0 };
  }

  const staleS = Math.max(0, Math.round((now.getTime() - Date.parse(cacheAsOf)) / 1000));
  const windowMin = burnWindowMin(db);
  const usdPerHour = consumed > 0 && perMin > 0 ? (usd / consumed) * perMin * 60 : 0;
  const projUsd = consumed > 0 ? (usd / consumed) * projTotal : usd;
  const minutesToP90 =
    perMin > 0 && band.cal_p90_wcet > consumed
      ? Math.round((band.cal_p90_wcet - consumed) / perMin)
      : null;

  const warn: BurnWarn[] = [];
  if (consumed >= band.cal_p90_wcet && band.cal_p90_wcet > 0) warn.push("over_p90");
  else if (consumed >= band.cal_p50_wcet && band.cal_p50_wcet > 0) warn.push("over_p50");
  if (opts.refresh !== true && staleS > (opts.staleAfterS ?? 120)) warn.push("stale");
  if (nProvisional > 0) warn.push("provisional_price");
  if (nUnpriced > 0) warn.push("unpriced");

  return {
    schema: 1,
    active: true,
    as_of: cacheAsOf,
    stale_s: staleS,
    tid,
    target,
    subject: meta.subject.length > 80 ? `${meta.subject.slice(0, 79)}…` : meta.subject,
    kind: meta.kind,
    status: meta.status,
    wcet: {
      consumed,
      p50: band.cal_p50_wcet,
      p90: band.cal_p90_wcet,
      pct_p50: band.cal_p50_wcet > 0 ? round1((consumed / band.cal_p50_wcet) * 100) : 0,
      pct_p90: band.cal_p90_wcet > 0 ? round1((consumed / band.cal_p90_wcet) * 100) : 0,
    },
    split: { main, sub, aux },
    requests: { n: nReq, p50: band.cal_req_p50, p90: band.cal_req_p90 },
    agents: { live: liveAgentCount, total: totalAgents },
    // §7.3: null until the three-clock model beats its baseline. While they are null
    // the segment reports CONSUMPTION, never time remaining.
    time: { active_s: activeS, p50_s: band.active_p50_s, p90_s: band.active_p90_s },
    burn: { wcet_per_min: round1(perMin), usd_per_hour: round2(usdPerHour), window_min: windowMin },
    projection: {
      total_wcet: projTotal,
      total_usd: round2(projUsd),
      minutes_to_p90: minutesToP90,
      method: "linear",
      crude: true,
    },
    band: {
      eid: band.eid,
      reason: band.reason,
      uncalibrated: band.shrink_w === 0 && band.refclass_as_of === null,
      ref_model: band.ref_model,
      estimand: band.estimand,
      price_epoch: band.price_epoch,
      refclass_as_of: band.refclass_as_of,
    },
    // The marker is retired ONLY by the presence of `config.unvalidated_retired_at`,
    // which `est recon --certify` writes and any later breaching week removes (P2.6).
    // Note what this does NOT do: it says nothing about `check_back`'s probation `?`.
    // Money and time are validated by different evidence, and one certifying the other
    // is how a system talks itself into trusting a number nobody checked.
    unvalidated: !unvalidatedRetired(db),
    check_back: checkBack,
    compute,
    warn,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Which empty result a thrown open/read failure is.
 *
 * ONE classifier for every catch on this path. `openDb` probes `sqlite_master` for the
 * `config` table before it can report a version, and that probe needs a shared lock —
 * so a sweeper holding the file makes the OPEN throw, not just the query. A catch that
 * hardcoded `db_missing` therefore made `db_busy` unreachable and left the reason field
 * unable to tell "never initialised" from "the sweeper has it for a moment". Both still
 * render nothing; only the diagnosis was wrong, and only a shared classifier keeps the
 * two catches from drifting apart again.
 */
export function classifyOpenError(e: unknown): EmptyReason {
  const msg = e instanceof Error ? e.message : String(e);
  return /busy|locked/i.test(msg) ? "db_busy" : "db_missing";
}

/**
 * The whole statusline read path: open read-only with a 50 ms timeout, answer, close.
 *
 * Every failure — missing file, uninitialised database, a schema this binary does not
 * know, a sweep holding the write lock — becomes the same well-formed empty object at
 * exit 0. That is not error-swallowing: the alternative is a status line that prints a
 * stack trace into Craig's prompt.
 */
export function burnRead(dbPath: string, opts: BurnJsonOptions = {}): BurnJson {
  const asOf = isoNow(opts.now ?? new Date());
  let db: Database;
  try {
    db = openDb({ path: dbPath, readonly: true, busyTimeoutMs: 50 });
  } catch (e) {
    return { schema: 1, active: false, as_of: asOf, reason: classifyOpenError(e) };
  }
  try {
    return burnJson(db, opts);
  } catch (e) {
    return { schema: 1, active: false, as_of: asOf, reason: classifyOpenError(e) };
  } finally {
    db.close();
  }
}

/** `est burn`'s human line plus a burn bar. One line, because that is the budget. */
export function renderBurn(b: BurnJson): string {
  if (!b.active) {
    return `est burn: nothing to show (${b.reason}) — the statusline renders nothing at all in this state`;
  }
  const pct = b.wcet.pct_p50;
  const width = 24;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  const fmt = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const lines = [
    `${b.subject}  [${b.kind}/${b.status}]` +
      // Nothing bound this task to the caller: it is the most recently touched open
      // task, which may be someone else's. Say so rather than let the band be read
      // as an answer about the work in front of the reader.
      (b.target === "fallback" ? "  (GUESSED TARGET: no binding — most recently touched open task)" : ""),
    `${bar} ${fmt(b.wcet.consumed)}/${fmt(b.wcet.p50)} WCET (${pct}% of p50, ${b.wcet.pct_p90}% of p90)` +
      (b.band.uncalibrated ? "  UNCALIBRATED" : ""),
    `main ${fmt(b.split.main)} · sub ${fmt(b.split.sub)} · aux ${fmt(b.split.aux)} · ` +
      `${b.requests.n} req · ${b.agents.live}/${b.agents.total} agents live · active ${Math.round(b.time.active_s / 60)}m`,
    `burn ${b.burn.wcet_per_min.toFixed(1)} WCET/min ($${b.burn.usd_per_hour.toFixed(2)}/h over a ${b.burn.window_min}m window) · ` +
      `projection ${fmt(b.projection.total_wcet)} WCET — LINEAR AND CRUDE: it answers "will this blow the band in the next hour", not "when will this finish"`,
  ];
  // The check-back band, with BOTH quantiles — this is where p90 lives. The statusline
  // shows p50 alone (one line of budget, and a two-number band stops being glanceable);
  // a terminal has room to say how wide the band actually is, and the width is the
  // honest part: p90 runs ~30× p50 on the corpus this was specified against.
  if (isWaitingOnInput(b.check_back)) {
    // No band, and deliberately no number of any kind: the session has no live agent, no
    // open workflow and a closed newest turn, so the honest answer to "when will this
    // stop needing me" is "it already does". Saying how long it has been waiting would
    // be the availability model §7.3 descoped, arrived at by the back door.
    lines.push(
      `check back NOW — awaiting input: no agent live, no delegation open and the last turn is closed, ` +
        `so Claude is blocked on you. No forecast is issued for an idle session (the burn figures above are unaffected)`,
    );
  } else if (b.check_back !== null) {
    const cb = b.check_back;
    lines.push(
      `check back ${formatEta(cb.p50_min)}${cb.probation ? "?" : ""} (p90 ${formatEta(cb.p90_min)}) · ` +
        `SESSION-scoped, Claude-ACTIVE time to the next human-input boundary — never token-derived · ` +
        `segment running ${cb.seg_elapsed_min}m · model ${cb.eta_model} over ${cb.n_seg} closed segment(s)` +
        (cb.probation
          ? `\n  ? = ON PROBATION: this model has not yet beaten a constant-median predictor by enough, over enough segments, with p90 coverage that contains 0.90. The number is a hint, not a promise.`
          : ""),
    );
  }
  lines.push(
    `compute ${Math.round(b.compute.s / 60)}m of API time over ${b.compute.coverage_pct}% of requests` +
      (b.compute.coverage_pct < 100
        ? ` — the rest carry no duration, so this is a floor, not a total`
        : "") +
      (b.warn.length > 0 ? `  ·  warn: ${b.warn.join(", ")}` : ""),
  );
  // GATED on the payload's own flag, exactly as `scripts/statusline-burn.ts` gates its
  // `[unvalidated]` suffix. The two renderers read the SAME field for the same reason:
  // once `est recon --certify` has written `config.unvalidated_retired_at` the marker
  // is retired, and a terminal that kept printing the sentence would be telling Craig
  // his numbers are unreconciled while the statusline and `--json` say they are — one
  // reader of a fact is a fact, two readers that disagree is a bug on screen.
  //
  // The warn list moved ONTO the compute line above rather than staying attached to
  // this sentence: it was concatenated onto a string that must now sometimes vanish,
  // so gating alone would have taken the warnings with it.
  if (b.unvalidated) {
    lines.push(
      `unvalidated: this number is ours and is not yet reconciled against any Anthropic-computed total (§7.5, Phase 2)`,
    );
  }
  return lines.join("\n");
}

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
import { getConfig, openDb } from "./db.ts";
import { isoNow, TERMINAL_TASK_STATUS } from "./tasks.ts";

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
  const agents = agentCounts(db, tid);
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
 * Bound agents: live (started, not ended — the "2 agents live" of §6.3) and total,
 * from ONE indexed pass over `agent_run(tid)`.
 *
 * Both land in `burn_cache`. The statusline reads them back off that row and never
 * calls this: `COUNT(*) FROM agent_run WHERE tid = ?` on the render path was a table
 * SCAN before `ix_agent_run_tid` and is a per-render count of an unbounded table
 * after it, and P1.9's budget is ONE indexed row read, not "a cheap query".
 */
export function agentCounts(db: Database, tid: string): { live: number; total: number } {
  const row = db
    .query<{ live: number; total: number }, [string]>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN started_at IS NOT NULL AND ended_at IS NULL THEN 1 ELSE 0 END), 0) AS live
         FROM agent_run WHERE tid = ?`,
    )
    .get(tid);
  return { live: row?.live ?? 0, total: row?.total ?? 0 };
}

/** Live agents alone — kept as the named concept §6.3 talks about. */
export function liveAgents(db: Database, tid: string): number {
  return agentCounts(db, tid).live;
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
// the cache
// ---------------------------------------------------------------------------

const UPSERT_BURN_SQL = `
INSERT INTO burn_cache (tid, as_of, consumed_wcet, wcet_main, wcet_sub, wcet_aux, usd, n_req,
                        n_agents_live, n_agents_total, n_provisional, n_unpriced,
                        active_s, burn_wcet_per_min, proj_total_wcet)
VALUES ($tid, $as_of, $consumed_wcet, $wcet_main, $wcet_sub, $wcet_aux, $usd, $n_req,
        $n_agents_live, $n_agents_total, $n_provisional, $n_unpriced,
        $active_s, $burn_wcet_per_min, $proj_total_wcet)
ON CONFLICT(tid) DO UPDATE SET
  as_of = excluded.as_of, consumed_wcet = excluded.consumed_wcet,
  wcet_main = excluded.wcet_main, wcet_sub = excluded.wcet_sub, wcet_aux = excluded.wcet_aux,
  usd = excluded.usd, n_req = excluded.n_req, n_agents_live = excluded.n_agents_live,
  n_agents_total = excluded.n_agents_total, n_provisional = excluded.n_provisional,
  n_unpriced = excluded.n_unpriced,
  active_s = excluded.active_s, burn_wcet_per_min = excluded.burn_wcet_per_min,
  proj_total_wcet = excluded.proj_total_wcet
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

  const stmt = db.prepare(UPSERT_BURN_SQL);
  for (const { tid } of open) {
    const agg = aggregateBurn(db, tid, now);
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
  unvalidated: true;
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

  if (opts.refresh === true) {
    const agg = aggregateBurn(db, tid, now);
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
    // Until weekly reconciliation lands (Phase 2, §7.5) the number is OURS and
    // unchecked against any Anthropic-computed total, and the segment MUST render
    // that marker.
    unvalidated: true,
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
    `unvalidated: this number is ours and is not yet reconciled against any Anthropic-computed total (§7.5, Phase 2)` +
      (b.warn.length > 0 ? `  ·  warn: ${b.warn.join(", ")}` : ""),
  ];
  return lines.join("\n");
}

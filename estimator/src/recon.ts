/**
 * src/recon.ts — weekly reconciliation, and the criterion that retires `[unvalidated]`
 * (P2.6, §7.5).
 *
 * ## Four axes, not one
 *
 * §7.5 asked for a USD comparison. One USD comparison can agree for the wrong reasons
 * — a pricing error and a dedup error of opposite sign net out — so this compares four
 * quantities that fail independently:
 *
 * | axis | ours | theirs | what a mismatch means |
 * |---|---|---|---|
 * | USD | Spend-CET over `v_wcet` | `SUM(claude_code.cost.usage)` | pricing, dedup or attribution is wrong |
 * | tokens | the four counters over `v_request_live` | `claude_code.token.usage` | the DEDUP CHAIN is wrong (§5.2) |
 * | active seconds | the §7.3 interval union | `claude_code.active_time.total` | the INTERVAL UNION is wrong — see the independence caveat below |
 * | requests | `COUNT(*)` over `v_request_live` | `COUNT(*)` over `otel_request` | the join itself; this is `join_pct`'s numerator |
 *
 * ## The active-seconds axis is only PARTLY an external check
 *
 * Two of the union's three legs — `turn` and `agent_run` — are transcript-derived and
 * genuinely independent of OTEL. The third, `v_request_live.duration_ms`, is written by
 * OTEL and by nothing else, so those seconds sit on BOTH sides of the comparison. The
 * axis therefore reports `otel_derived_pct`: the share of our union seconds that only
 * the OTEL leg supplied. At 0% this is the external check §7.5 wanted; the closer it
 * runs to 100%, the more a small delta is the telemetry agreeing with itself. It is
 * measured every run rather than asserted once, because the share moves with how many
 * turns carry a duration.
 *
 * ## Temporality is a correctness gate, not metadata
 *
 * DELTA points sum. CUMULATIVE points must be differenced per series. A window that
 * mixes the two cannot be summed at all, and summing it anyway produces a number that
 * looks like a reconciliation and is arithmetic nonsense — the same class of bug as
 * the MAX-vs-first dedup rule that cost 88% of sub-agent output (§5.2), and it gets
 * the same paranoia: {@link theirsForMetric} REFUSES rather than guessing, and the
 * refusal travels to the caller as a `note` on a null.
 *
 * ## join_pct is the clause that stops self-certification
 *
 * A week in which the receiver was down for six days produces a tiny delta on a tiny
 * base. Without a join floor the system would certify itself on the strength of
 * MISSING DATA — the exact shape of the 82.8% coverage figure that turned out to be an
 * artefact of what a probe never opened (§5.4).
 */

import type { Database } from "bun:sqlite";
import { getConfig, UNVALIDATED_RETIRED_KEY, unvalidatedRetired } from "./db.ts";
import { intervalUnion, type TimeInterval } from "./burn.ts";
import type { IngestAnomaly } from "./ingest.ts";
import { isoNow } from "./otel.ts";

export const RECON_SOURCE_USD = "otel_cost";

export type ReconAxis = "usd" | "tokens" | "active_s" | "requests";

export interface AxisResult {
  axis: ReconAxis;
  ours: number;
  /** null when OTEL cannot answer — no rows, or a window this code refuses to sum. */
  theirs: number | null;
  /** `(ours - theirs) / theirs * 100`. null exactly when `theirs` is null. */
  delta_pct: number | null;
  unit: string;
  alert: boolean;
  note: string | null;
  /**
   * `active_s` ONLY (null on every other axis): the share of OUR union seconds that
   * only the OTEL-derived leg supplied — `v_request_live.duration_ms`, a column OTEL
   * writes and nothing else does.
   *
   * 0 means the axis is a genuine two-source check (transcript vs OTEL). 100 means
   * both sides of the comparison came from the same place and a small `delta_pct` is
   * self-agreement, not corroboration. It travels beside the delta for the same reason
   * `join_pct` does: a number is only as good as the coverage it was computed on.
   */
  otel_derived_pct: number | null;
}

export interface ReconWindow {
  start: string;
  end: string;
}

export interface ReconReport {
  as_of: string;
  window: ReconWindow;
  axes: AxisResult[];
  /**
   * Share of the requests OTEL COULD have missed that it in fact saw, 0–100.
   *
   * The denominator is {@link ReconReport.n_join_denom}, not `n_our_requests`:
   * `origin='auxiliary'` rows are inserted by the OTEL ingest itself and are joined by
   * construction, so counting them moves numerator and denominator together and lets a
   * routine drain drive this toward 100% on data nothing external corroborated.
   */
  join_pct: number;
  n_our_requests: number;
  /** `n_our_requests` minus the auxiliary rows — what `join_pct` actually divides by. */
  n_join_denom: number;
  /** The excluded rows, reported so the exclusion is visible rather than silent. */
  n_auxiliary_requests: number;
  n_otel_requests: number;
  alert_pct: number;
  /** Written (or, on `--dry-run`, would be written). */
  wrote: boolean;
  certification: CertificationResult | null;
  anomalies: IngestAnomaly[];
}

export interface CertificationResult {
  /** True when the marker is (or has just been) retired. */
  certified: boolean;
  /** `config.unvalidated_retired_at` after this run, or null. */
  retired_at: string | null;
  weeks_required: number;
  weeks_examined: number;
  max_delta_pct: number;
  min_join_pct: number;
  /** Per-week verdicts, newest first. */
  weeks: Array<{ week: string; delta_pct: number; join_pct: number | null; clean: boolean }>;
  /** Why the criterion did not pass, or why the key was cleared. */
  reason: string;
  /** A previously-written key was removed by this run (retirement is ROLLING). */
  cleared: boolean;
  /**
   * THIS call wrote the key — as opposed to finding one an earlier `--certify` wrote.
   *
   * Only the INSERT branch sets it. A caller that wants to undo a grant it did not
   * intend must key off this and not off `retired_at !== null`, which cannot tell a
   * grant made this run from one made last month.
   */
  granted: boolean;
}

// ---------------------------------------------------------------------------
// window parsing
// ---------------------------------------------------------------------------

/**
 * `--window 7d` or `--window <iso>/<iso>`. Default 7 days back from `now`.
 *
 * The window is closed-open on `ts` everywhere it is used, so two adjacent weekly runs
 * partition the corpus rather than double-counting the boundary request.
 */
export function parseWindow(spec: string | null, now: Date = new Date()): ReconWindow {
  const end = isoNow(now);
  if (spec === null || spec.trim() === "") return { start: daysBefore(now, 7), end };
  const trimmed = spec.trim();
  const rel = /^(\d+)d$/.exec(trimmed);
  if (rel !== null) return { start: daysBefore(now, Number(rel[1])), end };
  const parts = trimmed.split("/");
  if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
    const a = Date.parse(parts[0]);
    const b = Date.parse(parts[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
      return { start: isoNow(new Date(a)), end: isoNow(new Date(b)) };
    }
  }
  throw new Error(`--window must be \`<n>d\` or \`<iso>/<iso>\`; got "${spec}"`);
}

function daysBefore(now: Date, days: number): string {
  return isoNow(new Date(now.getTime() - days * 86400_000));
}

// ---------------------------------------------------------------------------
// theirs — the OTEL side, with the temporality gate
// ---------------------------------------------------------------------------

interface TheirsResult {
  value: number | null;
  note: string | null;
}

/**
 * Sum one OTEL metric over the window, or refuse.
 *
 * - **delta** → `SUM(value)`, which is what the `…TEMPORALITY_PREFERENCE=delta`
 *   setting exists to make the common path.
 * - **cumulative** → differenced per series `(session_id, model, query_source,
 *   token_type)` against a CARRIED BASELINE, walking every point rather than the two
 *   endpoints. See {@link cumulativeTotal} for the three data-loss modes that rule
 *   exists to close.
 * - **unspecified** → REFUSED. A gauge has no temporality and summing gauge points is
 *   not an aggregation, it is a coincidence.
 * - **mixed** → REFUSED, loudly, with the mix named.
 */
export function theirsForMetric(
  db: Database,
  metric: string,
  window: ReconWindow,
): TheirsResult {
  const kinds = db
    .query<{ temporality: string; n: number }, [string, string, string]>(
      `SELECT temporality, COUNT(*) AS n FROM otel_metric
        WHERE metric = ? AND ts >= ? AND ts < ?
        GROUP BY temporality ORDER BY temporality`,
    )
    .all(metric, window.start, window.end);
  if (kinds.length === 0) return { value: null, note: `no ${metric} points in the window` };
  if (kinds.length > 1) {
    return {
      value: null,
      // Refusing is the whole point: a mixed window has no legal sum, and producing
      // one anyway would be a reconciliation number nobody could defend.
      note: `${metric} mixes temporalities in this window (${kinds
        .map((k) => `${k.temporality}=${k.n}`)
        .join(", ")}); delta points SUM and cumulative points must be DIFFERENCED, so the window is not summable`,
    };
  }
  const only = kinds[0]!.temporality;
  if (only === "unspecified") {
    return {
      value: null,
      note: `${metric} points carry no aggregation temporality; a value with no temporality is not summable`,
    };
  }
  if (only === "delta") {
    const row = db
      .query<{ v: number | null }, [string, string, string]>(
        `SELECT SUM(value) AS v FROM otel_metric
          WHERE metric = ? AND ts >= ? AND ts < ?`,
      )
      .get(metric, window.start, window.end);
    return { value: row?.v ?? 0, note: null };
  }

  // Cumulative: difference per SERIES, never sum. The series key is every dimension in
  // the primary key except `ts`, which is exactly what makes two points comparable.
  // Differencing in TypeScript rather than SQL because the reset rule is a policy, not
  // an aggregate, and burying it in a correlated subquery is how it stops being
  // reviewable.
  const points = db
    .query<{ key: string; value: number }, [string, string, string]>(
      `SELECT ${seriesKeySql()} AS key, value
         FROM otel_metric
        WHERE metric = ? AND ts >= ? AND ts < ?
        ORDER BY ts ASC`,
    )
    .all(metric, window.start, window.end);
  const baselines = cumulativeBaselines(db, metric, window);
  const t = cumulativeTotal(points, baselines);
  const parts = [`${metric} arrived as CUMULATIVE points and was differenced per series, not summed`];
  if (t.baselined > 0) {
    parts.push(`${t.baselined} series differenced against their last pre-window point`);
  }
  if (t.unbaselined > 0) {
    // Stated rather than hidden: with no pre-window point and no stored
    // `start_time_unix_nano`, "this series began inside the window" is an INFERENCE.
    // Counting the first value in full is the choice that cannot silently discard a
    // whole session's spend; it can over-count a series that started earlier and
    // reported nothing until now.
    parts.push(
      `${t.unbaselined} series had no pre-window point and were counted from 0 (a series that began before the window and first reported inside it is over-counted; persisting start_time_unix_nano would settle it)`,
    );
  }
  if (t.resets > 0) parts.push(`${t.resets} counter reset(s) kept their pre-reset segment`);
  return { value: t.total, note: parts.join("; ") };
}

/** Every dimension of `otel_metric`'s primary key except `ts` — what makes two points
 *  comparable, and therefore what a cumulative difference is taken WITHIN. */
function seriesKeySql(alias = ""): string {
  const p = alias === "" ? "" : `${alias}.`;
  // `dim_digest` belongs here and `ts_nanos` does NOT. The digest is the part of the
  // point's identity the allowlist drops, so two distinct series that share every stored
  // dimension are still two series and must be differenced apart; `ts_nanos` is a
  // TIMESTAMP, and folding it in would make every point its own series, whose first and
  // last are the same point and whose difference is therefore always zero.
  return (
    `${p}session_id || char(31) || ${p}model || char(31) || ${p}query_source || char(31) || ` +
    `${p}token_type || char(31) || ${p}dim_digest`
  );
}

/**
 * The last point of each series BEFORE the window — the baseline a cumulative counter
 * is differenced against.
 *
 * Without it the window's first point is thrown away: a series whose in-window points
 * are 1000 and 1500 has contributed 1500 since a pre-window baseline of 0, and
 * endpoint-differencing reported 500. Restricted by `EXISTS` to series that actually
 * appear in the window, so this reads one row per LIVE series rather than one per
 * series that has ever existed.
 */
function cumulativeBaselines(db: Database, metric: string, window: ReconWindow): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db
    .query<{ key: string; value: number }, [string, string, string, string, string]>(
      `SELECT key, value FROM (
         SELECT ${seriesKeySql("m")} AS key, m.value AS value,
                ROW_NUMBER() OVER (PARTITION BY m.session_id, m.model, m.query_source, m.token_type
                                   ORDER BY m.ts DESC) AS rn
           FROM otel_metric m
          WHERE m.metric = ? AND m.ts < ?
            AND EXISTS (SELECT 1 FROM otel_metric w
                         WHERE w.metric = ? AND w.ts >= ? AND w.ts < ?
                           AND w.session_id = m.session_id AND w.model = m.model
                           AND w.query_source = m.query_source AND w.token_type = m.token_type)
       ) WHERE rn = 1`,
    )
    .all(metric, window.start, metric, window.start, window.end)) {
    out.set(r.key, r.value);
  }
  return out;
}

export interface CumulativeTotal {
  total: number;
  /** Series differenced against a real pre-window point. */
  baselined: number;
  /** Series whose first in-window value was counted in full (no pre-window point). */
  unbaselined: number;
  resets: number;
}

/**
 * Difference a cumulative window against a carried baseline, walking EVERY point.
 *
 * The three data-loss modes this closes, all of them reachable from ordinary process
 * restarts and all of them silent:
 *
 *  1. **One point in the window.** `first === last`, so endpoint-differencing returned
 *     0 — a session that reported once contributed nothing at all.
 *  2. **No baseline.** The pre-window value was never read, so a series sitting at 0
 *     when the window opened and at 1500 when it closed was credited with
 *     `1500 - 1000 = 500` instead of 1500.
 *  3. **A mid-window reset.** Endpoints alone see `100 … 50` and floor at 50, throwing
 *     away the entire pre-reset segment. Walking the points keeps `(200-100) + 50`.
 *
 * A monotone counter that went BACKWARDS was reset, not negative: the post-reset value
 * is the whole of what it has counted since, and subtracting anyway would credit the
 * window with a negative number of tokens.
 */
export function cumulativeTotal(
  points: readonly { key: string; value: number }[],
  baselines: ReadonlyMap<string, number>,
): CumulativeTotal {
  const bySeries = new Map<string, number[]>();
  for (const p of points) {
    let values = bySeries.get(p.key);
    if (values === undefined) {
      values = [];
      bySeries.set(p.key, values);
    }
    values.push(p.value);
  }
  let total = 0;
  let baselined = 0;
  let unbaselined = 0;
  let resets = 0;
  for (const [key, values] of bySeries) {
    const base = baselines.get(key);
    if (base === undefined) unbaselined += 1;
    else baselined += 1;
    let prev: number | null = base ?? null;
    for (const v of values) {
      if (prev === null) total += v;
      else if (v >= prev) total += v - prev;
      else {
        total += v;
        resets += 1;
      }
      prev = v;
    }
  }
  return { total, baselined, unbaselined, resets };
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

function deltaPct(ours: number, theirs: number | null): number | null {
  if (theirs === null) return null;
  // A zero denominator has no percentage. Both zero is exact agreement (0%); ours
  // non-zero against nothing is reported as 100% rather than Infinity, which no
  // consumer and no CHECK could store.
  if (theirs === 0) return ours === 0 ? 0 : 100;
  return ((ours - theirs) / theirs) * 100;
}

// CACHE-TTL-PRICING.md D3: cw_cost replaces the flat cw_tok*usd_cw — it is the
// TTL-aware, clamped cache-write cost v_wcet already computes per row.
const OURS_USD_SQL = `
SELECT COALESCE(SUM((in_tok*usd_in + out_tok*usd_out + cw_cost + cr_tok*usd_cr) / 1000000.0), 0) AS v
FROM v_wcet WHERE ts >= ? AND ts < ?
`;

const OURS_TOKENS_SQL = `
SELECT COALESCE(SUM(in_tok + out_tok + cw_tok + cr_tok), 0) AS v
FROM v_request_live WHERE ts >= ? AND ts < ?
`;

const OURS_REQUESTS_SQL = `
SELECT COUNT(*) AS v FROM v_request_live WHERE ts >= ? AND ts < ?
`;

/**
 * `join_pct`'s denominator, and it is NOT the requests axis.
 *
 * The axis counts every live request, because that is what OTEL's request count is being
 * compared against. The join FRACTION must exclude `origin='auxiliary'`, which is a
 * provenance marker rather than a category here — `src/otel.ts`'s auxiliary insert is the
 * only writer of it, and `src/ingest.ts` classifies every transcript row as `main` or
 * `subagent`. Those rows were therefore inserted BY the OTEL ingest itself: one exists
 * only if OTEL saw
 * it, so it is joined by construction and moves numerator and denominator together. A
 * routine drain of auxiliary spend therefore drove join_pct arbitrarily close to 100%
 * on data the estimator synthesised — and join_pct is "the clause that stops
 * self-certification", read directly by `evaluateCertification`'s
 * `unvalidated_min_join_pct` floor. Excluding them keeps the question the one that
 * matters: of the requests OTEL COULD have failed to see, how many did it see?
 */
const JOIN_DENOM_SQL = `
SELECT COUNT(*) AS v FROM v_request_live WHERE ts >= ? AND ts < ? AND origin <> 'auxiliary'
`;

const AUXILIARY_REQUESTS_SQL = `
SELECT COUNT(*) AS v FROM v_request_live WHERE ts >= ? AND ts < ? AND origin = 'auxiliary'
`;

const JOINED_REQUESTS_SQL = `
SELECT COUNT(*) AS v FROM v_request_live r
 WHERE r.ts >= ? AND r.ts < ? AND r.origin <> 'auxiliary'
   AND EXISTS (SELECT 1 FROM otel_request o WHERE o.request_id = r.request_id)
`;

/** Which legs of the §7.3 union to gather. `request` is the OTEL-DERIVED one. */
export type IntervalSource = "turn" | "agent" | "request";
export const INDEPENDENT_SOURCES: readonly IntervalSource[] = ["turn", "agent"];
export const ALL_SOURCES: readonly IntervalSource[] = ["turn", "agent", "request"];

/**
 * The §7.3 interval union over the whole window — merged by sweep line, NOT summed: a
 * sum would count an async fan-out three times and would disagree with Anthropic's
 * figure for a reason that has nothing to do with our data.
 *
 * **Two of the three legs are independent of OTEL; the third is not.** `turn` and
 * `agent_run` come from the transcript. `v_request_live.duration_ms` is written by OTEL
 * and by nothing else (`src/otel.ts`'s own invariant: "OTEL may write
 * `request.duration_ms` and NOTHING ELSE"), so the seconds it contributes sit on the
 * "ours" side of a comparison whose "theirs" side is also OTEL. That leg is included
 * because it is what buys the coverage — 27% of turns carry no duration at all — but
 * the axis is only as external a check as the share of union seconds the first two legs
 * supply, which is why `computeRecon` measures that share and reports it (see
 * `otel_derived_pct`). `sources` exists so the honest two-source union can be computed
 * with the same code as the full one.
 */
export function windowIntervals(
  db: Database,
  window: ReconWindow,
  sources: readonly IntervalSource[] = ALL_SOURCES,
): TimeInterval[] {
  const want = new Set(sources);
  const out: TimeInterval[] = [];
  const lo = Date.parse(window.start);
  const hi = Date.parse(window.end);
  const clip = (start: number, end: number): void => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const s = Math.max(start, lo);
    const e = Math.min(end, hi);
    if (e > s) out.push({ start: s, end: e });
  };
  if (want.has("turn")) {
    for (const t of db
      .query<{ started_at: string; duration_ms: number | null }, [string, string]>(
        "SELECT started_at, duration_ms FROM turn WHERE started_at >= ? AND started_at < ?",
      )
      .all(window.start, window.end)) {
      const start = Date.parse(t.started_at);
      clip(start, start + (t.duration_ms ?? 0));
    }
  }
  if (want.has("agent")) {
    for (const a of db
      .query<{ started_at: string | null; ended_at: string | null }, [string, string]>(
        "SELECT started_at, ended_at FROM agent_run WHERE ended_at >= ? AND started_at < ?",
      )
      .all(window.start, window.end)) {
      if (a.started_at === null || a.ended_at === null) continue;
      clip(Date.parse(a.started_at), Date.parse(a.ended_at));
    }
  }
  // The third source, and what OTEL buys: 27% of turns carry no duration at all, and a
  // turn with no duration contributes nothing to the union. Per-request durations fill
  // the inside of exactly those turns — at the cost of this leg's independence, which
  // is measured rather than assumed away (see the doc comment above).
  if (want.has("request")) {
    for (const r of db
      .query<{ ts: string; duration_ms: number }, [string, string]>(
        "SELECT ts, duration_ms FROM v_request_live WHERE duration_ms IS NOT NULL AND ts >= ? AND ts < ?",
      )
      .all(window.start, window.end)) {
      const start = Date.parse(r.ts);
      clip(start, start + r.duration_ms);
    }
  }
  return out;
}

export interface ReconOptions {
  window?: string | null;
  now?: Date;
  /** Restrict which axes run. Default: all four. */
  axes?: readonly ReconAxis[];
}

/** Compute the four axes. Pure read — writing is {@link writeRecon}'s job. */
export function computeRecon(db: Database, opts: ReconOptions = {}): ReconReport {
  const now = opts.now ?? new Date();
  const window = parseWindow(opts.window ?? null, now);
  const alertPct = Number(getConfig(db, "recon_alert_pct") ?? 5);
  const wanted = new Set<ReconAxis>(opts.axes ?? ["usd", "tokens", "active_s", "requests"]);

  const ourUsd = db.query<{ v: number }, [string, string]>(OURS_USD_SQL).get(window.start, window.end)?.v ?? 0;
  const ourTokens =
    db.query<{ v: number }, [string, string]>(OURS_TOKENS_SQL).get(window.start, window.end)?.v ?? 0;
  const ourRequests =
    db.query<{ v: number }, [string, string]>(OURS_REQUESTS_SQL).get(window.start, window.end)?.v ?? 0;
  const joinDenom =
    db.query<{ v: number }, [string, string]>(JOIN_DENOM_SQL).get(window.start, window.end)?.v ?? 0;
  const auxiliaryRequests =
    db.query<{ v: number }, [string, string]>(AUXILIARY_REQUESTS_SQL).get(window.start, window.end)?.v ?? 0;
  const joinedRequests =
    db.query<{ v: number }, [string, string]>(JOINED_REQUESTS_SQL).get(window.start, window.end)?.v ?? 0;
  const otelRequests =
    db
      .query<{ v: number }, [string, string]>(
        "SELECT COUNT(*) AS v FROM otel_request WHERE ts >= ? AND ts < ?",
      )
      .get(window.start, window.end)?.v ?? 0;
  const activeS = intervalUnion(windowIntervals(db, window)).activeS;
  // The SAME union with the OTEL-derived leg withheld. The difference is how much of
  // "ours" only exists because OTEL filled `request.duration_ms`, and therefore how
  // much of this axis is a check against itself rather than against an outside source.
  const independentS = intervalUnion(windowIntervals(db, window, INDEPENDENT_SOURCES)).activeS;
  const otelDerivedPct = activeS === 0 ? 0 : round2(((activeS - independentS) / activeS) * 100);

  const axes: AxisResult[] = [];
  const push = (
    axis: ReconAxis,
    ours: number,
    theirs: TheirsResult,
    unit: string,
    otelDerived: number | null = null,
  ): void => {
    if (!wanted.has(axis)) return;
    const d = deltaPct(ours, theirs.value);
    axes.push({
      axis,
      ours,
      theirs: theirs.value,
      delta_pct: d === null ? null : round2(d),
      unit,
      alert: d !== null && Math.abs(d) > alertPct,
      // The caveat rides on the note only when there is one to make: at 0% the axis IS
      // the two-source check §7.5 asked for, and saying so every week would train the
      // reader to skip the line on the week it stops being true. The NUMBER is always
      // on the result either way.
      note:
        otelDerived === null || otelDerived === 0
          ? theirs.note
          : [
              theirs.note,
              `${otelDerived}% of our union seconds come only from request.duration_ms, which OTEL alone writes — that share is NOT an independent check`,
            ]
              .filter((s): s is string => s !== null)
              .join("; "),
      otel_derived_pct: otelDerived,
    });
  };

  push("usd", round4(ourUsd), theirsForMetric(db, "claude_code.cost.usage", window), "usd");
  push("tokens", ourTokens, theirsForMetric(db, "claude_code.token.usage", window), "tokens");
  push(
    "active_s",
    activeS,
    theirsForMetric(db, "claude_code.active_time.total", window),
    "s",
    otelDerivedPct,
  );
  push(
    "requests",
    ourRequests,
    { value: otelRequests === 0 ? null : otelRequests, note: otelRequests === 0 ? "no OTEL requests in the window" : null },
    "requests",
  );

  // Over `joinDenom`, NOT `ourRequests`: see JOIN_DENOM_SQL. Dividing by the axis
  // denominator let auxiliary rows the OTEL ingest had just inserted certify the ingest.
  const joinPct = joinDenom === 0 ? 0 : round2((joinedRequests / joinDenom) * 100);

  const anomalies: IngestAnomaly[] = [];
  for (const a of axes) {
    if (!a.alert) continue;
    anomalies.push({
      kind: "recon_mismatch",
      detail:
        `${a.axis}: ours ${a.ours} vs theirs ${a.theirs} = ${a.delta_pct}% over ` +
        `${window.start}..${window.end} (alert above ${alertPct}%), join ${joinPct}%`,
    });
  }

  return {
    as_of: isoNow(now),
    window,
    axes,
    join_pct: joinPct,
    n_our_requests: ourRequests,
    n_join_denom: joinDenom,
    n_auxiliary_requests: auxiliaryRequests,
    n_otel_requests: otelRequests,
    alert_pct: alertPct,
    wrote: false,
    certification: null,
    anomalies,
  };
}

const INSERT_RECON_SQL = `
INSERT INTO recon (as_of, source, window_start, window_end, ours_usd, theirs_usd, delta_pct, note)
VALUES ($as_of, '${RECON_SOURCE_USD}', $window_start, $window_end, $ours, $theirs, $delta_pct, $note)
ON CONFLICT(as_of, source) DO UPDATE SET
  window_start = excluded.window_start, window_end = excluded.window_end,
  ours_usd = excluded.ours_usd, theirs_usd = excluded.theirs_usd,
  delta_pct = excluded.delta_pct, note = excluded.note
`;

const INSERT_RECON_METRIC_SQL = `
INSERT INTO recon_metric (as_of, metric, source, window_start, window_end,
                          ours, theirs, delta_pct, join_pct, unit, note)
VALUES ($as_of, $metric, $source, $window_start, $window_end,
        $ours, $theirs, $delta_pct, $join_pct, $unit, $note)
ON CONFLICT(as_of, metric, source) DO UPDATE SET
  window_start = excluded.window_start, window_end = excluded.window_end,
  ours = excluded.ours, theirs = excluded.theirs, delta_pct = excluded.delta_pct,
  join_pct = excluded.join_pct, unit = excluded.unit, note = excluded.note
`;

const METRIC_SOURCE: Record<Exclude<ReconAxis, "usd">, string> = {
  tokens: "otel_tokens",
  active_s: "otel_active",
  requests: "otel_request",
};

/**
 * Persist the report: one `recon` row for USD (the existing table, `source='otel_cost'`)
 * and one `recon_metric` row per other axis.
 *
 * An axis OTEL could not answer writes NO row: `recon_metric.theirs` is NOT NULL, and
 * inventing a zero would enter the corpus as "they measured nothing", which is a
 * measurement rather than the absence of one. The reason is still visible — it is the
 * `note` on the returned report and, for the caller, on `--json`.
 *
 * Call inside a transaction the caller owns.
 */
export function writeRecon(db: Database, report: ReconReport): void {
  const usd = report.axes.find((a) => a.axis === "usd");
  if (usd !== undefined && usd.theirs !== null && usd.delta_pct !== null) {
    db.query(INSERT_RECON_SQL).run({
      $as_of: report.as_of,
      $window_start: report.window.start,
      $window_end: report.window.end,
      $ours: usd.ours,
      $theirs: usd.theirs,
      $delta_pct: usd.delta_pct,
      $note: usd.note,
    } as never);
  }
  const stmt = db.prepare(INSERT_RECON_METRIC_SQL);
  for (const a of report.axes) {
    if (a.axis === "usd") continue;
    if (a.theirs === null || a.delta_pct === null) continue;
    stmt.run({
      $as_of: report.as_of,
      $metric: a.axis,
      $source: METRIC_SOURCE[a.axis],
      $window_start: report.window.start,
      $window_end: report.window.end,
      $ours: a.ours,
      $theirs: a.theirs,
      $delta_pct: a.delta_pct,
      // join_pct travels on EVERY row, because a delta is only meaningful against the
      // coverage it was computed on — a 1% delta on a 30% join is agreement with
      // nothing, and the certification criterion reads exactly this column.
      $join_pct: report.join_pct,
      $unit: a.unit,
      $note: a.note,
    } as never);
  }
}

// ---------------------------------------------------------------------------
// certification (P2.6)
// ---------------------------------------------------------------------------

/** Re-exported so a reader of this file sees the key it writes. Declared in db.ts to
 *  keep the read path (`src/burn.ts`) and this writer free of an import cycle. */
export const RETIRED_KEY = UNVALIDATED_RETIRED_KEY;

interface WeekRow {
  week: string;
  as_of: string;
  window_start: string;
  usd_delta_pct: number;
  join_pct: number | null;
}

/**
 * Evaluate the retirement criterion, stated exactly because "reconciliation lands" has
 * been doing a criterion's work since R2:
 *
 * > The marker is retired when, over the `unvalidated_weeks` (4) most recent
 * > CONSECUTIVE weekly `recon` rows with `source='otel_cost'`, EVERY week satisfies
 * > both `abs(delta_pct) <= unvalidated_max_delta_pct` (2%) and
 * > `join_pct >= unvalidated_min_join_pct` (95%).
 *
 * `apply` = false evaluates without writing (`--dry-run`, and the read path of
 * `est burn`). With `apply` = true this is the ONLY writer of `config.unvalidated_retired_at`
 * — and the only remover: retirement is ROLLING, so a later week that breaches either
 * clause clears the key and the marker comes back. A validation that cannot expire is
 * not a validation.
 */
export function evaluateCertification(
  db: Database,
  opts: { apply: boolean; now?: Date } = { apply: false },
): CertificationResult {
  const now = opts.now ?? new Date();
  const weeksRequired = Math.max(1, Number(getConfig(db, "unvalidated_weeks") ?? 4));
  const maxDelta = Number(getConfig(db, "unvalidated_max_delta_pct") ?? 2);
  const minJoin = Number(getConfig(db, "unvalidated_min_join_pct") ?? 95);
  const existing = getConfig(db, RETIRED_KEY);

  const rows = db
    .query<WeekRow, [number]>(
      `SELECT week, as_of, window_start, usd_delta_pct, join_pct
         FROM v_recon_week ORDER BY window_start DESC LIMIT ?`,
    )
    .all(weeksRequired);

  const weeks = rows.map((r) => ({
    week: r.week,
    delta_pct: r.usd_delta_pct,
    join_pct: r.join_pct,
    clean:
      Math.abs(r.usd_delta_pct) <= maxDelta &&
      r.join_pct !== null &&
      r.join_pct >= minJoin,
  }));

  const result: CertificationResult = {
    certified: false,
    retired_at: existing,
    weeks_required: weeksRequired,
    weeks_examined: weeks.length,
    max_delta_pct: maxDelta,
    min_join_pct: minJoin,
    weeks,
    reason: "",
    cleared: false,
    granted: false,
  };

  if (weeks.length < weeksRequired) {
    result.reason = `only ${weeks.length} weekly reconciliation(s) recorded; ${weeksRequired} consecutive clean weeks are required`;
  } else if (!consecutive(rows)) {
    // A gap is not four consecutive weeks. Certifying across one would mean the
    // receiver's silence had been counted as evidence of agreement.
    result.reason = `the ${weeksRequired} most recent weeks are not consecutive (a gap means the receiver was not running, and silence is not evidence)`;
  } else {
    const dirty = weeks.filter((w) => !w.clean);
    if (dirty.length === 0) {
      result.certified = true;
      result.reason = `${weeksRequired} consecutive weeks within ${maxDelta}% USD at >= ${minJoin}% join`;
    } else {
      const w = dirty[0]!;
      result.reason =
        w.join_pct === null || w.join_pct < minJoin
          ? `week ${w.week} joined only ${w.join_pct ?? 0}% of our requests (floor ${minJoin}%) — a small delta on a small join is agreement with nothing`
          : `week ${w.week} is ${w.delta_pct}% off (tolerance ${maxDelta}%)`;
    }
  }

  if (!opts.apply) return result;

  if (result.certified) {
    if (existing === null) {
      db.query("INSERT INTO config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(
        RETIRED_KEY,
        isoNow(now),
      );
      result.retired_at = isoNow(now);
      result.granted = true;
    }
  } else if (existing !== null) {
    db.query("DELETE FROM config WHERE k = ?").run(RETIRED_KEY);
    result.retired_at = null;
    result.cleared = true;
  }
  return result;
}

/** Consecutive weekly windows: each successive `window_start` is 7 days ± 2 apart. */
function consecutive(rows: readonly WeekRow[]): boolean {
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const a = Date.parse(rows[i]!.window_start);
    const b = Date.parse(rows[i + 1]!.window_start);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const days = (a - b) / 86400_000;
    if (days < 5 || days > 9) return false;
  }
  return true;
}

export { unvalidatedRetired };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** One line per axis — §7.5's promise, widened. */
export function renderRecon(r: ReconReport): string {
  const lines: string[] = [];
  lines.push(`recon ${r.window.start} .. ${r.window.end}`);
  for (const a of r.axes) {
    if (a.theirs === null) {
      lines.push(`  ${pad(a.axis)} ours ${fmt(a.ours)} · theirs — · ${a.note ?? "unavailable"}`);
      continue;
    }
    lines.push(
      `  ${pad(a.axis)} ours ${fmt(a.ours)} · theirs ${fmt(a.theirs)} · ${signed(a.delta_pct)}%` +
        (a.alert ? "  ALERT" : "") +
        (a.note === null ? "" : `  (${a.note})`),
    );
  }
  lines.push(
    `  join ${r.join_pct}%  (${r.n_our_requests} ours / ${r.n_otel_requests} theirs` +
      // Named on the line rather than left implicit: join_pct divides by a SMALLER
      // denominator than the requests axis, and a reader comparing the two numbers is
      // owed the reason.
      (r.n_auxiliary_requests > 0
        ? `; ${r.n_auxiliary_requests} auxiliary excluded from the join, ${r.n_join_denom} denominator`
        : "") +
      ")",
  );
  if (r.certification !== null) {
    const c = r.certification;
    lines.push(
      c.certified
        ? `  [unvalidated] RETIRED at ${c.retired_at} — ${c.reason}`
        : `  [unvalidated] stands${c.cleared ? " (retirement CLEARED — it is rolling, not permanent)" : ""}: ${c.reason}`,
    );
  }
  return lines.join("\n");
}

function pad(s: string): string {
  return s.padEnd(9);
}
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4);
}
function signed(n: number | null): string {
  if (n === null) return "—";
  return `${n > 0 ? "+" : ""}${n}`;
}

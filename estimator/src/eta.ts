/**
 * src/eta.ts — the check-back forecast (P2.1).
 *
 * THE DELIVERABLE, in one sentence: *"come back and check on me in ~57 min"* — a
 * forecast of the **Claude-ACTIVE** wall-clock minutes remaining before the current
 * run reaches a point where a human is needed. Not total elapsed time, not task
 * completion time, and **never derived from tokens**.
 *
 * THE INVARIANT, and it is tested rather than intended (test/eta.test.ts): no code
 * path in this file may read a token counter, a Work-CET figure, an estimate band, a
 * burn rate or a projection. Everything here reads intervals, counts and timestamps.
 * ×10 every token counter in a fixture and every number this module produces must be
 * bit-identical. The tokens→time chain has already been refuted twice at r² ≈ 0.001–
 * 0.003, and the cheapest way for it to creep back in is a well-meaning "we already
 * have the burn rate right here".
 *
 * THE UNIT is a **run segment**: a maximal run of components of the §7.3 interval
 * union whose consecutive gaps are all shorter than `config.segment_gap_min` **and
 * none of which contains a user prompt**. Three interval sources feed the union —
 * turns (`turn.started_at` + `turn.duration_ms`), agent runs
 * (`started_at`..`ended_at`) and OTEL-upgraded requests (`request.ts` +
 * `request.duration_ms`, filled by the P2.4 drain). The third is what OTEL buys: a
 * turn whose `turn_duration` record never landed contributes nothing to the union,
 * and per-request durations fill the inside of exactly those turns.
 *
 * THE BOUNDARY RULE (Craig, 2026-07-30) is the second half of that definition and it
 * is the difference between answering the question and answering a different one. A
 * purely gap-based segment measures **how long an activity streak lasts**; the estimand
 * is **Claude-active time to the next human-input boundary**. Those come apart exactly
 * when a background agent BRIDGES a gap that contains a prompt: measured live, one
 * segment ran 4.6 h across five prompts, so `residual_life` forecast "check back ~5.3h"
 * at a moment when zero agents were live and Claude was, in fact, waiting on Craig.
 * A prompt that lands while Claude is idle therefore CUTS the segment, however short
 * the surrounding gap — and the cut is what makes both halves of the number honest:
 * `seg_elapsed` is measured from the prompt, and the closed segment enters the survival
 * corpus as one prompt-to-boundary span instead of a streak of several glued together.
 *
 * THE ONE EXCEPTION, and it is the whole of the exception: **a prompt that lands while
 * work is still in flight is not a boundary.** The rule is about the MAIN CHAIN
 * blocking on input, not about the human speaking. If the interval union covers the
 * prompt instant then something — a turn mid-response, a delegated agent, an in-flight
 * request — was running, so Claude was not waiting for anybody, and cutting there would
 * fabricate an idle boundary inside a still-running delegation: the pre-prompt piece
 * would enter the corpus as a genuine "Claude needed a human" observation that never
 * happened, biasing every subsequent forecast short. The delegated work keeps its own
 * segment, and the mechanical test for "was Claude blocked" is free: a prompt inside a
 * union COMPONENT is covered by definition, and a prompt in a GAP is not.
 *
 * The complement of that rule lives in {@link waitingOnInput}: when nothing is in
 * flight there is no forecast to issue at all, only the fact that Claude is blocked.
 * The two are deliberately the same predicate read at two instants — the prompt's, for
 * where the corpus is cut, and now, for whether a forecast is issued.
 *
 * SCOPE: the forecast is **session-scoped**, not task-scoped, and that is a deliberate
 * departure from every other number in the system. `run_segment.tid` records the task
 * that owned the majority of a segment's busy seconds — for the board and the retro —
 * but the question "when will this stop needing me" is about the session in front of
 * Craig, and what stops is the session's activity.
 *
 * WHAT IS DELIBERATELY NOT MODELLED: `gap_after_s`, the length of the human-wait gap,
 * is RECORDED because it is free and because a future availability model would need
 * it. Nothing here reads it for prediction (§7.3 clock 3 is descoped, not deferred).
 */

import type { Database } from "bun:sqlite";
import {
  configNum,
  countLiveAgents,
  liveAgentMaxMin,
  DEFAULT_ETA_LIVE_AGENT_MAX_MIN,
} from "./liveness.ts";
import type { IngestAnomaly } from "./ingest.ts";
import { isoNow } from "./tasks.ts";
import { jeffreysInterval, pinball } from "./calibrate.ts";
import { liveSessionIds } from "./close.ts";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/**
 * Re-exported, never redeclared. `configNum` and the three liveness names below live in
 * src/liveness.ts because §6.2’s quiescence gate needs the SAME rule and this module
 * already imports src/close.ts — importing back would close a cycle. One definition,
 * two callers; see that file’s header.
 */
export { configNum, countLiveAgents, liveAgentMaxMin, DEFAULT_ETA_LIVE_AGENT_MAX_MIN };

export function segmentGapMin(db: Database): number {
  const v = configNum(db, "segment_gap_min", 5);
  return v > 0 ? v : 5;
}

/**
 * How far back a normal sweep rebuilds segments.
 *
 * A code constant, not a `config` row, because P2.0's key set is CLOSED — `est config
 * set` refuses an unknown key, and a knob that only half exists is worse than one that
 * does not. Bounded work per sweep is the point: segments are durable (P2.5), so a
 * sweep only has to revisit the sessions that could still be moving. `est backfill`
 * rebuilds everything, and so does the first run over a database with no segments.
 */
export const SEGMENT_RECOMPUTE_DAYS = 7;

// ---------------------------------------------------------------------------
// intervals
// ---------------------------------------------------------------------------

export type IntervalSrc = "turn" | "agent" | "otel";

/** Canonical order for `run_segment.interval_src_mix`, so the string is stable. */
const SRC_ORDER: readonly IntervalSrc[] = ["turn", "agent", "otel"];

export interface SessionInterval {
  start: number;
  end: number;
  src: IntervalSrc;
  /** The task this interval's row is bound to, for the majority-owner vote. */
  tid: string | null;
}

/**
 * Everything the segmenter needs about a set of sessions, loaded in FOUR queries
 * total rather than four per session.
 *
 * The per-session shape read naturally and scaled quadratically: `agent_run` carries
 * no index on `session_id` (its indexes are `(run_id, wf_launch_id)` and `tid`), and
 * the compaction ledger is a `LIKE` over `anomaly`, so a backfill over hundreds of
 * sessions was a full scan of both tables per session. Bounded `IN (…)` filtering
 * keeps the indexed prefix on `turn` and `request` when only a few sessions are being
 * rebuilt, and the whole-corpus case reads each table exactly once.
 */
export interface IntervalIndex {
  intervals: Map<string, SessionInterval[]>;
  turnStarts: Map<string, number[]>;
  compactions: Map<string, number[]>;
}

/** Above this many sessions, filtering in SQL costs more than reading the table once. */
const IN_FILTER_MAX = 400;

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const prev = m.get(k);
  if (prev === undefined) m.set(k, [v]);
  else prev.push(v);
}

/**
 * Load the three interval sources plus the turn starts and `/compact` boundaries.
 *
 * A turn with no `turn_duration` record yields `end === start` and is dropped by the
 * merge — that is the 27%-of-turns hole OTEL exists to fill, and it must stay visible
 * as a hole rather than be papered over with an assumed duration. Its START is kept
 * regardless, because that is the `human_input` discriminator.
 */
export function loadIntervalIndex(db: Database, sessions: readonly string[] | null = null): IntervalIndex {
  const idx: IntervalIndex = { intervals: new Map(), turnStarts: new Map(), compactions: new Map() };
  const filter =
    sessions !== null && sessions.length > 0 && sessions.length <= IN_FILTER_MAX ? sessions : null;
  const want = sessions === null ? null : new Set(sessions);
  const clause = filter === null ? "" : ` AND session_id IN (${filter.map(() => "?").join(",")})`;
  const args = filter ?? [];
  const keep = (sid: string): boolean => want === null || want.has(sid);

  for (const t of db
    .query<
      { session_id: string; started_at: string; duration_ms: number | null; tid: string | null },
      string[]
    >(`SELECT session_id, started_at, duration_ms, tid FROM turn WHERE 1=1${clause}`)
    .all(...args)) {
    if (!keep(t.session_id)) continue;
    const start = Date.parse(t.started_at);
    if (!Number.isFinite(start)) continue;
    push(idx.turnStarts, t.session_id, start);
    push(idx.intervals, t.session_id, {
      start,
      end: start + (t.duration_ms ?? 0),
      src: "turn",
      tid: t.tid,
    });
  }
  for (const a of db
    .query<
      { session_id: string; started_at: string; ended_at: string; tid: string | null },
      string[]
    >(
      `SELECT session_id, started_at, ended_at, tid FROM agent_run
        WHERE started_at IS NOT NULL AND ended_at IS NOT NULL${clause}`,
    )
    .all(...args)) {
    if (!keep(a.session_id)) continue;
    const start = Date.parse(a.started_at);
    const end = Date.parse(a.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    push(idx.intervals, a.session_id, { start, end, src: "agent", tid: a.tid });
  }
  // `v_request_live`, not `request`: a replayed row is the same work counted twice, and
  // double-counting an interval inflates concurrency even though the union is idempotent.
  for (const r of db
    .query<{ session_id: string; ts: string; duration_ms: number; tid: string | null }, string[]>(
      `SELECT session_id, ts, duration_ms, tid FROM v_request_live WHERE duration_ms IS NOT NULL${clause}`,
    )
    .all(...args)) {
    if (!keep(r.session_id)) continue;
    const start = Date.parse(r.ts);
    if (!Number.isFinite(start)) continue;
    push(idx.intervals, r.session_id, { start, end: start + r.duration_ms, src: "otel", tid: r.tid });
  }
  // The compaction ledger, parsed once for the whole corpus. The detail string is
  // written by `compactionAnomalies` in src/ingest.ts and this is its only reader;
  // test/eta.test.ts pins the two together so a reworded detail fails a test rather
  // than silently turning every /compact boundary into a fabricated `human_input`.
  for (const a of db
    .query<{ detail: string }, []>(
      "SELECT detail FROM anomaly WHERE kind = 'compaction_continuation'",
    )
    .all()) {
    const m = /^session (\S+): \/compact boundary at ([^\s,]+)/.exec(a.detail);
    if (m === null) continue;
    const sid = m[1]!;
    if (!keep(sid)) continue;
    const t = Date.parse(m[2]!);
    if (Number.isFinite(t)) push(idx.compactions, sid, t);
  }
  for (const list of idx.turnStarts.values()) list.sort((a, b) => a - b);
  for (const list of idx.compactions.values()) list.sort((a, b) => a - b);
  return idx;
}

/** The three interval sources for one session, in epoch ms. */
export function sessionIntervals(db: Database, sessionId: string): SessionInterval[] {
  return loadIntervalIndex(db, [sessionId]).intervals.get(sessionId) ?? [];
}

export interface Component {
  start: number;
  end: number;
}

/**
 * Sweep-line merge into the union's connected components.
 *
 * `intervalUnion` in src/burn.ts measures the union; this returns its SHAPE, which is
 * what segmentation needs. Zero-length and inverted intervals are dropped on the same
 * rule as there.
 */
export function mergeComponents(intervals: readonly { start: number; end: number }[]): Component[] {
  const kept = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Component[] = [];
  for (const i of kept) {
    const last = out[out.length - 1];
    // `>=`, not `>`: two back-to-back intervals are one continuous stretch, the same
    // "closes before opens" rule the union's sweep line applies at a shared instant.
    if (last !== undefined && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else {
      out.push({ start: i.start, end: i.end });
    }
  }
  return out;
}

/** Max simultaneous intervals — the parallelism the union deliberately collapses. */
export function maxConcurrency(intervals: readonly { start: number; end: number }[]): number {
  const events: Array<{ at: number; delta: number }> = [];
  for (const i of intervals) {
    if (!Number.isFinite(i.start) || !Number.isFinite(i.end) || i.end <= i.start) continue;
    events.push({ at: i.start, delta: 1 }, { at: i.end, delta: -1 });
  }
  events.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at - b.at));
  let depth = 0;
  let max = 0;
  for (const e of events) {
    depth += e.delta;
    if (depth > max) max = depth;
  }
  return max;
}

// ---------------------------------------------------------------------------
// segmentation
// ---------------------------------------------------------------------------

export type Terminator = "human_input" | "compaction" | "session_end" | "open";

export interface SegmentRow {
  session_id: string;
  started_at: string;
  ended_at: string;
  active_s: number;
  busy_s: number;
  max_concurrency: number;
  n_turns: number;
  n_agents: number;
  gap_before_s: number | null;
  gap_after_s: number | null;
  terminator: Terminator;
  interval_src_mix: string | null;
  gap_min: number;
  tid: string | null;
}

export interface SegmentContext {
  /**
   * User-prompt instants (`turn.started_at`), which do two jobs here: they are the
   * `human_input` discriminator, and since the 2026-07-30 boundary rule they are also
   * the CUT POINTS — a prompt that falls in a gap ends a segment however narrow the gap
   * is. See the file header for why, and for the one case that is not a cut.
   *
   * These are derived at sweep time from the transcript's own user-message timestamps
   * (`src/segment.ts` -> the `turn` table), never from the `UserPromptSubmit` hook. The
   * hook is a FRESHNESS assist only — it spawns a micro-sweep so the boundary lands in
   * `run_segment` within seconds — because a boundary definition that depended on a hook
   * would silently differ between sessions that had it wired and sessions that did not,
   * and the historical corpus has none of them.
   */
  turnStarts: readonly number[];
  /** `/compact` boundary instants for this session, from the anomaly ledger. */
  compactions: readonly number[];
  /** Whether a live harness process still owns this session (§6.2). */
  live: boolean;
  now: number;
  gapMin: number;
}

/**
 * Group union components into segments and classify each one's terminator.
 *
 * Pure: everything it needs about the world arrives in `ctx`, which is what makes the
 * fixture tests possible and what keeps the classification rules readable in one place.
 *
 * TWO things split a segment, and the second is the 2026-07-30 boundary rule:
 *
 *  a. a gap at least `gapMin` wide — the original rule, and the only one that ever
 *     applies INSIDE a component (there are no gaps inside one, by construction);
 *  b. a **user prompt lying in a gap**, at any width. A prompt inside a component is
 *     covered by work that was still running and is therefore NOT a cut: that is the
 *     "still-running delegation" exception the file header sets out, and it needs no
 *     extra evidence — component containment IS the test for "was Claude blocked".
 *
 * Terminator precedence, and the reason for each step:
 *
 *  1. `open` — the last segment, with less than one gap-width of silence since it ended
 *     AND no prompt after it. The ONLY kind a live forecast is issued against. The
 *     prompt clause is rule (b) applied to the tail: if Craig has typed since the last
 *     observable activity then that segment ended at a human-input boundary, and leaving
 *     it open would forecast from a start instant that predates the prompt — the exact
 *     defect this rule exists to kill, in the one shape a re-grouping cannot reach
 *     (there is no later component to group away from). What follows the prompt has not
 *     become visible yet, so the honest answer until it does is no open segment at all.
 *  2. `compaction` — a `compact_boundary` fell inside the gap. Positive evidence, so
 *     it outranks the inference below: `/compact` ENDS a session, and reading that as
 *     "a human typed something" would put a boundary in the corpus that never happened.
 *  3. `human_input` — a turn starts after the gap. The boundary the forecast aims at.
 *  4. `session_end` — nothing later in the session AND no live pid among its bound
 *     sessions.
 *  5. `human_input` again, as the documented fallback for a closed segment that IS
 *     followed by more activity but carries no turn-start evidence (a resumed agent,
 *     or a turn whose `turn_duration` never landed). Both alternatives are positively
 *     refuted there — the session is neither over nor compacted — and a resumption
 *     after a multi-minute gap is overwhelmingly a person. It is a guess, it is
 *     labelled as one here, and `est segments` shows the mix so it stays auditable.
 */
export function classifySegments(
  sessionId: string,
  components: readonly Component[],
  raw: readonly SessionInterval[],
  ctx: SegmentContext,
): SegmentRow[] {
  if (components.length === 0) return [];
  const gapMs = ctx.gapMin * 60_000;

  // Ascending, because `promptInGap` scans it and the callers hand it over already
  // sorted — copying and re-sorting costs one small array per session and removes an
  // ordering assumption from a pure function's contract.
  const prompts = [...ctx.turnStarts].sort((a, b) => a - b);

  /**
   * Is there a prompt in the silence between `from` and `to` that the segment starting
   * at `after` has not already been cut at?
   *
   * INCLUSIVE at both ends on purpose. The ordinary case is a prompt that lands while
   * Claude is idle: the turn interval it opens starts at exactly that instant, so the
   * next component's `start` IS the prompt and an exclusive test would miss every real
   * boundary. `p > after` keeps a group from being cut at the prompt that opened it.
   */
  const promptInGap = (from: number, to: number, after: number): boolean =>
    prompts.some((p) => p >= from && p <= to && p > after);

  // group components into segments: a wide-enough gap splits, and so does a prompt in
  // any gap (rule (b) above)
  const groups: Component[][] = [];
  let cur: Component[] = [components[0]!];
  for (let i = 1; i < components.length; i += 1) {
    const c = components[i]!;
    const prev = cur[cur.length - 1]!;
    if (c.start - prev.end < gapMs && !promptInGap(prev.end, c.start, cur[0]!.start)) cur.push(c);
    else {
      groups.push(cur);
      cur = [c];
    }
  }
  groups.push(cur);

  const rows: SegmentRow[] = [];
  for (let g = 0; g < groups.length; g += 1) {
    const comps = groups[g]!;
    const start = comps[0]!.start;
    const end = comps[comps.length - 1]!.end;
    const isLast = g === groups.length - 1;
    const nextStart = isLast ? null : groups[g + 1]![0]!.start;
    const prevEnd = g === 0 ? null : groups[g - 1]![groups[g - 1]!.length - 1]!.end;

    const inside = raw.filter((i) => i.end > i.start && i.start >= start && i.end <= end);
    const activeMs = comps.reduce((t, c) => t + (c.end - c.start), 0);
    const busyMs = inside.reduce((t, i) => t + (i.end - i.start), 0);

    const srcs = new Set(inside.map((i) => i.src));
    const mix = SRC_ORDER.filter((s) => srcs.has(s)).join("+");

    // Majority owner by BUSY seconds, not union seconds: splitting a shared instant
    // between two concurrent tasks would need an apportionment rule nothing else in
    // the system has, and the vote only has to pick a winner.
    const byTid = new Map<string, number>();
    for (const i of inside) {
      if (i.tid === null) continue;
      byTid.set(i.tid, (byTid.get(i.tid) ?? 0) + (i.end - i.start));
    }
    let tid: string | null = null;
    let best = 0;
    for (const [k, v] of byTid) {
      // Ties break on the tid string so a re-sweep of unchanged inputs is a no-op.
      if (v > best || (v === best && tid !== null && k < tid)) {
        best = v;
        tid = k;
      }
    }

    const boundary = nextStart ?? ctx.now;
    const compacted = ctx.compactions.some((c) => c > end && c <= boundary);
    const turnAfter = ctx.turnStarts.some((t) => t > end && (nextStart === null || t <= nextStart + 1000));
    // Rule (b) on the tail. Only the LAST group can be affected: for every other group
    // a prompt after `end` is inside the gap the grouping loop already cut at.
    const promptAfter = isLast && prompts.some((p) => p > end);

    let terminator: Terminator;
    if (isLast && !promptAfter && ctx.now - end < gapMs) terminator = "open";
    else if (compacted) terminator = "compaction";
    else if (turnAfter) terminator = "human_input";
    else if (isLast && !ctx.live) terminator = "session_end";
    else terminator = "human_input";

    rows.push({
      session_id: sessionId,
      // SECONDS precision, via `isoNow`, like every other timestamp this schema stores.
      // Milliseconds here are worse than useless: `run_segment.started_at` is half the
      // primary key and `ended_at` is compared lexicographically against a caller-typed
      // `--since` (`segmentsReport`), and at index 19 '.' < 'Z' — so a ms-precision
      // `...:00.000Z` sorts BELOW the `...:00Z` a user types and every segment ending
      // inside the boundary second silently vanishes from the report.
      started_at: isoNow(new Date(start)),
      ended_at: isoNow(new Date(end)),
      active_s: Math.round(activeMs / 1000),
      busy_s: Math.round(busyMs / 1000),
      max_concurrency: maxConcurrency(inside),
      n_turns: ctx.turnStarts.filter((t) => t >= start && t <= end).length,
      n_agents: inside.filter((i) => i.src === "agent").length,
      gap_before_s: prevEnd === null ? null : Math.round((start - prevEnd) / 1000),
      // NULL on the newest segment: the gap has not finished happening, and a gap
      // measured against `now` would shrink every time it were re-read.
      gap_after_s: nextStart === null ? null : Math.round((nextStart - end) / 1000),
      terminator,
      interval_src_mix: mix === "" ? null : mix,
      gap_min: ctx.gapMin,
      tid,
    });
  }
  return rows;
}

/** `/compact` boundary instants for a session, read back out of the anomaly ledger. */
export function compactionInstants(db: Database, sessionId: string): number[] {
  return loadIntervalIndex(db, [sessionId]).compactions.get(sessionId) ?? [];
}

/** Every segment of one session, from an already-loaded index. */
export function segmentsFromIndex(
  idx: IntervalIndex,
  sessionId: string,
  opts: { gapMin: number; now: Date; live?: boolean },
): SegmentRow[] {
  const raw = idx.intervals.get(sessionId) ?? [];
  return classifySegments(sessionId, mergeComponents(raw), raw, {
    turnStarts: idx.turnStarts.get(sessionId) ?? [],
    compactions: idx.compactions.get(sessionId) ?? [],
    live: opts.live ?? false,
    now: opts.now.getTime(),
    gapMin: opts.gapMin,
  });
}

/** Every segment of one session, rebuilt from scratch at `gapMin`. */
export function buildSessionSegments(
  db: Database,
  sessionId: string,
  opts: { gapMin: number; now: Date; live?: boolean },
): SegmentRow[] {
  return segmentsFromIndex(loadIntervalIndex(db, [sessionId]), sessionId, opts);
}

/**
 * Upsert one segment. **No `WHERE run_segment.terminator = 'open'` guard**, and that
 * absence is the fix for a real defect rather than an oversight.
 *
 * The guard used to FREEZE a segment the instant it turned terminal, on the reasoning
 * that a closed segment is a corpus observation and re-fitting on a moved target is what
 * the append-only doctrine exists to prevent everywhere else in this schema. But a
 * segment's WINDOW can still move after it closes: `drainOtel` fills
 * `request.duration_ms` where there was none, those rows join the §7.3 interval union on
 * the NEXT sweep, and a filled gap either merges two segments into one or moves a start
 * earlier. With the guard in force the recomputed shape was REFUSED where the primary key
 * collided and INSERTED beside the old row where it did not — so `run_segment` ended up
 * holding either a stale pre-OTEL partition or two OVERLAPPING rows, and `v_eta_corpus`
 * handed Kaplan–Meier the same wall-clock minute twice, once as a short observation and
 * once inside a long one. Freezing did not protect the fitting corpus; it corrupted it.
 *
 * A re-cut is ATOMIC instead ({@link refreshSegments}): the instants the recompute no
 * longer produces are deleted and the ones it does are restated, both inside the sweep's
 * transaction, and every restatement or removal of a TERMINAL row is written to the
 * ledger as `segment_recut`. The corpus still may not move SILENTLY — it now moves
 * auditably instead of not at all.
 */
const UPSERT_SEGMENT_SQL = `
INSERT INTO run_segment (session_id, started_at, ended_at, active_s, busy_s, max_concurrency,
                         n_turns, n_agents, gap_before_s, gap_after_s, terminator,
                         interval_src_mix, gap_min, tid, first_seen, last_seen)
VALUES ($session_id, $started_at, $ended_at, $active_s, $busy_s, $max_concurrency,
        $n_turns, $n_agents, $gap_before_s, $gap_after_s, $terminator,
        $interval_src_mix, $gap_min, $tid, $now, $now)
ON CONFLICT(session_id, gap_min, started_at) DO UPDATE SET
  ended_at = excluded.ended_at, active_s = excluded.active_s, busy_s = excluded.busy_s,
  max_concurrency = excluded.max_concurrency, n_turns = excluded.n_turns,
  n_agents = excluded.n_agents, gap_before_s = excluded.gap_before_s,
  gap_after_s = excluded.gap_after_s, terminator = excluded.terminator,
  interval_src_mix = excluded.interval_src_mix, gap_min = excluded.gap_min,
  tid = excluded.tid, last_seen = excluded.last_seen
`;

/**
 * Delete one superseded instant. `gap_min` is in the key and therefore in the WHERE:
 * see {@link refreshSegments} for why a re-cut is authoritative for ONE partition only.
 */
const DELETE_SEGMENT_SQL =
  "DELETE FROM run_segment WHERE session_id = ? AND gap_min = ? AND started_at = ?";

export interface SegmentRefresh {
  sessions: number;
  segments: number;
  open: number;
  /** Terminal rows a re-cut RESTATED — the corpus moved, and `segment_recut` says so. */
  recut: number;
  /** Rows a re-cut removed because it no longer cuts a segment at that instant. */
  removed: number;
  /** `segment_recut` findings; the caller feeds these to `insertAnomalies`. */
  anomalies: IngestAnomaly[];
}

/** The stored row a re-cut compares against, for the restatement check. */
interface PriorSegment {
  session_id: string;
  started_at: string;
  ended_at: string;
  active_s: number;
  busy_s: number;
  max_concurrency: number;
  n_turns: number;
  n_agents: number;
  terminator: string;
  gap_min: number;
}

/**
 * What a re-cut changed about one segment, or `null` if nothing did.
 *
 * TWO classes, deliberately, and the ledger detail carries the CLASS rather than the
 * values: `insertAnomalies` dedups on `(kind, detail)`, so a detail carrying the numbers
 * would write a fresh row every time a late OTEL duration nudged one — the row-per-sweep
 * growth `receiverDownAnomaly` documents avoiding. Two classes bounds the ledger at two
 * `segment_recut` rows per segment for its whole life.
 */
function recutClass(prior: PriorSegment, next: SegmentRow): "span" | "shape" | null {
  if (prior.ended_at !== next.ended_at) return "span";
  if (
    prior.active_s !== next.active_s ||
    prior.busy_s !== next.busy_s ||
    prior.max_concurrency !== next.max_concurrency ||
    prior.n_turns !== next.n_turns ||
    prior.n_agents !== next.n_agents ||
    prior.terminator !== next.terminator ||
    prior.gap_min !== next.gap_min
  ) {
    return "shape";
  }
  return null;
}

/**
 * Does any surviving interval still overlap a stored segment's span?
 *
 * The test a full rebuild uses before it removes a cut from outside the recompute
 * horizon. "No overlap" means the evidence for that stretch of wall clock is gone — GC
 * pruned it (P2.10) — and a recompute that cannot see the inputs is not entitled to
 * conclude the segment never happened. A degenerate stored span (`ended_at ==
 * started_at`, which the schema permits) gets a one-second window so an interval
 * beginning at exactly that instant still counts as coverage.
 */
function spanStillCovered(
  raw: readonly SessionInterval[],
  startedAt: string,
  endedAt: string,
): boolean {
  const from = Date.parse(startedAt);
  const to = Date.parse(endedAt);
  if (!Number.isFinite(from)) return false;
  const until = Math.max(Number.isFinite(to) ? to : from, from + 1000);
  return raw.some((i) => i.end > from && i.start < until);
}

/**
 * Rebuild `run_segment` for the sessions that could still be moving, INSIDE the
 * sweeper's existing transaction (so it takes no lock of its own, like
 * `refreshBurnCache`).
 *
 * Bounded by design: durable segments mean a sweep only revisits recent sessions.
 * `all: true` (backfill, and the bootstrap case of an empty table) does the corpus.
 */
export function refreshSegments(
  db: Database,
  opts: { now?: Date; all?: boolean } = {},
): SegmentRefresh {
  const now = opts.now ?? new Date();
  const gapMin = segmentGapMin(db);
  const nowIso = isoNow(now);

  const haveAny = (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment").get()?.n ?? 0) > 0;
  const all = opts.all === true || !haveAny;
  // SECONDS precision, like every column it is compared against: a `.000Z` fraction
  // sorts BELOW a bare `Z` at index 19, so a millisecond horizon silently shifts every
  // lexicographic `>=` in this function by up to a second.
  const since = isoNow(new Date(now.getTime() - SEGMENT_RECOMPUTE_DAYS * 86_400_000));

  const sessions = new Set<string>();
  const collect = (sql: string, args: string[]): void => {
    for (const r of db.query<{ session_id: string }, string[]>(sql).all(...args)) {
      if (r.session_id !== null && r.session_id !== "") sessions.add(r.session_id);
    }
  };
  if (all) {
    collect("SELECT DISTINCT session_id FROM turn", []);
    collect("SELECT DISTINCT session_id FROM agent_run", []);
    collect("SELECT DISTINCT session_id FROM v_request_live", []);
  } else {
    collect("SELECT session_id FROM turn GROUP BY session_id HAVING MAX(started_at) >= ?", [since]);
    collect(
      "SELECT session_id FROM agent_run GROUP BY session_id HAVING MAX(COALESCE(ended_at, started_at)) >= ?",
      [since],
    );
    collect("SELECT session_id FROM v_request_live GROUP BY session_id HAVING MAX(ts) >= ?", [since]);
    // An open segment must be revisited even if nothing new landed: that silence is
    // precisely what turns it from `open` into `human_input` or `session_end`.
    collect("SELECT session_id FROM v_segment_current", []);
  }
  if (sessions.size === 0) {
    return { sessions: 0, segments: 0, open: 0, recut: 0, removed: 0, anomalies: [] };
  }

  // One directory scan for the whole refresh rather than one per session (§6.2's check
  // is a readdir + a kill(0) per file, and it is the same answer for every session),
  // and one pass over each interval source rather than one per session.
  const live = liveSessionIds();
  const idx = loadIntervalIndex(db, all ? null : [...sessions]);
  const stmt = db.prepare(UPSERT_SEGMENT_SQL);
  const del = db.prepare(DELETE_SEGMENT_SQL);

  // Every stored row this re-cut is allowed to touch, in ONE scan rather than a query
  // per session. THREE bounds on that authority, and each is load-bearing:
  //
  //   * ONE PARTITION. `gap_min` is part of the primary key because rows cut at two
  //     minutes and rows cut at thirty are different observations of the same wall
  //     clock, never one corpus. A refresh running at the threshold in force says
  //     nothing about a retired partition, so it may not delete from one.
  //   * OPEN rows at ANY age — an open segment is not yet an observation, it is a
  //     provisional cut of the live tail, so the refresh owns it outright.
  //   * TERMINAL rows only INSIDE the recompute horizon — UNLESS this is a full rebuild,
  //     and then only where the inputs are still visible. Outside the horizon the
  //     transcripts that produced a segment may already have been pruned (P2.10 prunes
  //     at 365 days and a segment outlives its inputs by design), so silence from
  //     `loadIntervalIndex` must not be read as "this segment never was".
  //
  //     A full rebuild (`est backfill`, or the bootstrap case of an empty table) has to
  //     reach further back than that, because the 2026-07-30 boundary rule changed WHERE
  //     segments are cut: every stored cut is an observation of a superseded estimand,
  //     and leaving the old ones beside the new ones would hand Kaplan–Meier the same
  //     wall-clock minute twice — once as a prompt-to-boundary span and once inside the
  //     streak it was carved out of. So a full rebuild loads the prior rows unbounded and
  //     earns its authority per ROW instead of per horizon: an old cut is superseded only
  //     if some surviving interval still OVERLAPS it (see the removal loop). Pruned
  //     inputs produce no overlap, so a segment whose evidence is gone is kept, which is
  //     the same protection the horizon was giving — expressed against the thing that
  //     actually matters rather than against a date.
  const priorBound = all ? null : since;
  const prior = new Map<string, Map<string, PriorSegment>>();
  for (const r of db
    .query<PriorSegment, [number, string | null]>(
      `SELECT session_id, started_at, ended_at, active_s, busy_s, max_concurrency,
              n_turns, n_agents, terminator, gap_min
         FROM run_segment
        WHERE gap_min = ?1 AND (?2 IS NULL OR terminator = 'open' OR started_at >= ?2)`,
    )
    .all(gapMin, priorBound)) {
    if (!sessions.has(r.session_id)) continue;
    let bySession = prior.get(r.session_id);
    if (bySession === undefined) {
      bySession = new Map();
      prior.set(r.session_id, bySession);
    }
    bySession.set(r.started_at, r);
  }

  let segments = 0;
  let open = 0;
  let recut = 0;
  let removed = 0;
  const anomalies: IngestAnomaly[] = [];
  for (const sid of sessions) {
    const rows = segmentsFromIndex(idx, sid, { gapMin, now, live: live.has(sid) });
    const was = prior.get(sid) ?? new Map<string, PriorSegment>();

    // ---- 1. instants this re-cut no longer produces -------------------------
    //
    // An upsert alone cannot express "this segment no longer exists", and it has to be
    // able to. `FILL_DURATION_SQL` back-fills `request.duration_ms` for rows that had
    // none; those rows join the §7.3 interval union on the NEXT sweep; and a filled gap
    // either MERGES two segments into one or moves a start earlier. Both re-partitions
    // strand the old rows: the merged shape collides with one primary key and inserts
    // beside the other, so the table ended up holding a pre-OTEL partition and its
    // successor at once and `v_eta_corpus` fed Kaplan-Meier the same wall-clock minute
    // twice — once as a short observation, once inside a long one.
    const keepStarts = new Set(rows.map((r) => r.started_at));
    const raw = idx.intervals.get(sid) ?? [];
    for (const [startedAt, stale] of was) {
      if (keepStarts.has(startedAt)) continue;
      // The per-row half of the authority rule above: past the horizon a stored cut is
      // only superseded if its own span is still covered by surviving evidence. GC prunes
      // by AGE, not by session, so a long-lived session can keep contributing intervals
      // while its oldest ones are gone — and a session-level check would eat exactly
      // those segments. `since` is the boundary of the incremental horizon; inside it
      // nothing changes, so this cannot alter what a normal sweep does.
      if (startedAt < since && !spanStillCovered(raw, startedAt, stale.ended_at)) continue;
      del.run(sid, gapMin, startedAt);
      removed += 1;
      // Only a TERMINAL removal is a finding. An open row being re-cut is the normal
      // life of the live tail and would be pure noise in the ledger.
      if (stale.terminator !== "open") {
        anomalies.push({
          kind: "segment_recut",
          detail:
            `session ${sid} segment ${startedAt} was REMOVED by a later re-cut: the recomputed ` +
            `partition no longer starts a segment there (a filled duration merged it into a ` +
            `neighbour). The fitting corpus changed, and this row is the audit trail`,
        });
      }
    }

    // ---- 2. the rows it does produce ---------------------------------------
    for (const row of rows) {
      const before = was.get(row.started_at);
      if (before !== undefined && before.terminator !== "open") {
        const cls = recutClass(before, row);
        if (cls !== null) {
          recut += 1;
          anomalies.push({
            kind: "segment_recut",
            detail:
              `session ${sid} segment ${row.started_at} was RESTATED by a later re-cut (${cls}); ` +
              `a closed segment is a corpus observation, so the population the check-back band ` +
              `and the probation verdict are fitted from has moved`,
          });
        }
      }
      stmt.run({
        $session_id: row.session_id,
        $started_at: row.started_at,
        $ended_at: row.ended_at,
        $active_s: row.active_s,
        $busy_s: row.busy_s,
        $max_concurrency: row.max_concurrency,
        $n_turns: row.n_turns,
        $n_agents: row.n_agents,
        $gap_before_s: row.gap_before_s,
        $gap_after_s: row.gap_after_s,
        $terminator: row.terminator,
        $interval_src_mix: row.interval_src_mix,
        $gap_min: row.gap_min,
        $tid: row.tid,
        $now: nowIso,
      } as never);
      segments += 1;
      if (row.terminator === "open") open += 1;
    }
  }
  return { sessions: sessions.size, segments, open, recut, removed, anomalies };
}

// ---------------------------------------------------------------------------
// the empirical distribution: Kaplan–Meier with right censoring
// ---------------------------------------------------------------------------

export interface Observation {
  /** Segment span in seconds. */
  len_s: number;
  /** An OPEN segment: the length is a lower bound, not a measurement. */
  censored: boolean;
  n_agents: number;
  max_concurrency: number;
}

export interface KmCurve {
  /** Distinct event (death) times, ascending. */
  t: number[];
  /** Survival AFTER each event time. */
  s: number[];
  /** Largest observed time of any kind — the edge of the support. */
  tMax: number;
  /** Survival at `tMax`; > 0 iff the longest observation was censored. */
  sLast: number;
  /**
   * Constant-hazard rate fitted through the last KM point, for the tail beyond the
   * support. `null` when the curve reaches zero (no extrapolation needed) or when
   * there is nothing to fit. Exponential is the honest default here: it is the
   * memoryless tail, it needs one parameter, and the alternative — refusing to answer
   * once a segment outlives every observation — would blank the ETA in exactly the
   * long-run case that made Craig ask for it.
   */
  lambda: number | null;
  n: number;
  n_censored: number;
}

/**
 * Kaplan–Meier estimator over segment lengths.
 *
 * Open segments enter as RIGHT-CENSORED observations rather than being dropped — the
 * same censoring treatment §6.2 gives abandoned tasks, and for the same reason:
 * dropping the long-running ones biases the estimator short exactly when it matters.
 */
export function kaplanMeier(obs: readonly Observation[]): KmCurve {
  const clean = obs.filter((o) => Number.isFinite(o.len_s) && o.len_s >= 0);
  const n = clean.length;
  const nCensored = clean.filter((o) => o.censored).length;
  if (n === 0) return { t: [], s: [], tMax: 0, sLast: 1, lambda: null, n: 0, n_censored: 0 };

  // ONE ascending sweep, not a filter per event time. The retro fits this curve
  // leave-one-out across the whole corpus, so a quadratic estimator inside a linear
  // loop is a cubic retro — the kind of cost that only shows up a year in, on the
  // corpus that finally has enough segments to be worth fitting.
  const sorted = [...clean].sort((a, b) => (a.len_s === b.len_s ? (a.censored ? 1 : 0) - (b.censored ? 1 : 0) : a.len_s - b.len_s));
  const t: number[] = [];
  const s: number[] = [];
  let surv = 1;
  let remaining = n;
  let i = 0;
  while (i < sorted.length) {
    const time = sorted[i]!.len_s;
    let d = 0;
    let c = 0;
    while (i < sorted.length && sorted[i]!.len_s === time) {
      if (sorted[i]!.censored) c += 1;
      else d += 1;
      i += 1;
    }
    // At risk at `time` is everything not yet ended, censored observations included —
    // they were alive up to their own length. They leave the risk set AFTER it.
    if (d > 0 && remaining > 0) {
      surv *= 1 - d / remaining;
      t.push(time);
      s.push(surv);
    }
    remaining -= d + c;
  }
  const tMax = sorted[sorted.length - 1]!.len_s;
  const sLast = s.length === 0 ? 1 : s[s.length - 1]!;
  let lambda: number | null = null;
  if (sLast > 0 && sLast < 1 && tMax > 0) lambda = -Math.log(sLast) / tMax;
  return { t, s, tMax, sLast, lambda, n, n_censored: nCensored };
}

/** Survival at `x`, extended past the support by the fitted constant hazard. */
export function survivalAt(km: KmCurve, x: number): number {
  if (km.t.length === 0) return 1;
  if (x >= km.tMax) {
    if (km.lambda === null) return km.sLast;
    return km.sLast * Math.exp(-km.lambda * (x - km.tMax));
  }
  let surv = 1;
  for (let i = 0; i < km.t.length; i += 1) {
    if (km.t[i]! > x) break;
    surv = km.s[i]!;
  }
  return surv;
}

export interface ResidualQuantile {
  /** Seconds remaining at quantile `q`, given the segment has already run `t`. */
  s: number;
  /** True when the answer came from the fitted tail rather than observed data. */
  extrapolated: boolean;
}

/**
 * Conditional residual life: `q_p(L − t | L > t)`.
 *
 * This is the whole forecast in one function. The tail is the shape, not noise (p90 is
 * ~30× p50 on the corpus this was specified against), which is why the residual-life
 * form is used at all: it stops one five-hour segment from dragging the median, and it
 * is why any point estimate would be a lie.
 */
export function residualQuantile(km: KmCurve, t: number, q: number): ResidualQuantile | null {
  if (km.t.length === 0) return null;
  const st = survivalAt(km, t);
  if (!(st > 0)) return null;
  const target = st * (1 - q);
  for (let i = 0; i < km.t.length; i += 1) {
    if (km.t[i]! <= t) continue;
    if (km.s[i]! <= target) return { s: Math.max(0, km.t[i]! - t), extrapolated: false };
  }
  // Unreachable inside the observed support: continue with the fitted tail.
  if (km.lambda !== null && km.lambda > 0 && km.sLast > 0) {
    const u = km.tMax + Math.log(km.sLast / target) / km.lambda;
    return { s: Math.max(0, u - t), extrapolated: true };
  }
  return { s: Math.max(0, km.tMax - t), extrapolated: true };
}

/** Empirical quantile of a sorted-ascending sample (linear interpolation). */
export function quantileOf(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

// ---------------------------------------------------------------------------
// the three models
// ---------------------------------------------------------------------------

export type EtaModel = "const_median" | "residual_life" | "fanout_cond";

/** The live structural state a `fanout_cond` prediction conditions on. */
export interface Features {
  live_agents: number;
  /** Declared phases still to run in an in-flight workflow, or 0. */
  wf_phases_left: number;
  /** Median span of one completed workflow phase, in seconds, or null. */
  phase_median_s: number | null;
}

export const NO_FEATURES: Features = { live_agents: 0, wf_phases_left: 0, phase_median_s: null };

export interface Prediction {
  p50_s: number;
  p90_s: number;
  extrapolated: boolean;
}

/** Structural stratum for `fanout_cond`. Three levels, because n is small. */
export function stratumOf(agents: number): "solo" | "small" | "large" {
  return agents === 0 ? "solo" : agents <= 2 ? "small" : "large";
}

export interface FittedModels {
  km: KmCurve;
  /** Closed lengths, ascending — the `const_median` sample. */
  closed: number[];
  strata: Map<string, KmCurve>;
  n_closed: number;
  n_censored: number;
}

export function fitModels(obs: readonly Observation[]): FittedModels {
  const closed = obs
    .filter((o) => !o.censored)
    .map((o) => o.len_s)
    .sort((a, b) => a - b);
  const strata = new Map<string, KmCurve>();
  for (const level of ["solo", "small", "large"] as const) {
    const subset = obs.filter((o) => stratumOf(o.n_agents) === level);
    if (subset.length > 0) strata.set(level, kaplanMeier(subset));
  }
  return {
    km: kaplanMeier(obs),
    closed,
    strata,
    n_closed: closed.length,
    n_censored: obs.filter((o) => o.censored).length,
  };
}

/**
 * `const_median` — the floor. It is NOT shipped; it exists to be beaten, and a model
 * that cannot beat it has learned nothing.
 *
 * Fitted on closed segments only: a censored length is a lower bound, and averaging
 * lower bounds with measurements is how a baseline flatters itself.
 */
export function predictConstMedian(fit: FittedModels, elapsedS: number): Prediction | null {
  const p50 = quantileOf(fit.closed, 0.5);
  const p90 = quantileOf(fit.closed, 0.9);
  if (p50 === null || p90 === null) return null;
  return {
    p50_s: Math.max(0, p50 - elapsedS),
    p90_s: Math.max(0, Math.max(p50, p90) - elapsedS),
    extrapolated: false,
  };
}

/** `residual_life` — the default. Conditional KM residual quantiles. */
export function predictResidualLife(fit: FittedModels, elapsedS: number): Prediction | null {
  const p50 = residualQuantile(fit.km, elapsedS, 0.5);
  const p90 = residualQuantile(fit.km, elapsedS, 0.9);
  if (p50 === null || p90 === null) return null;
  return {
    p50_s: p50.s,
    p90_s: Math.max(p50.s, p90.s),
    extrapolated: p50.extrapolated || p90.extrapolated,
  };
}

/**
 * `fanout_cond` — the candidate. Conditions on STRUCTURE only: how many agents are
 * live, and whether a workflow is in flight with phases still to run.
 *
 * The one case with a structural answer is worth naming: **a headless workflow cannot
 * ask for input until it returns**, so remaining declared phases × per-phase residual
 * life is a LOWER BOUND on check-back, and that is the shape most likely to beat the
 * baseline. It is applied as a floor, never as the estimate itself.
 */
export function predictFanoutCond(
  fit: FittedModels,
  elapsedS: number,
  f: Features,
  minFit: number,
): Prediction | null {
  const level = stratumOf(f.live_agents);
  const stratum = fit.strata.get(level);
  // A stratum thinner than the global fit floor is noise wearing a feature's clothes.
  const km = stratum !== undefined && stratum.n >= minFit ? stratum : fit.km;
  const p50 = residualQuantile(km, elapsedS, 0.5);
  const p90 = residualQuantile(km, elapsedS, 0.9);
  if (p50 === null || p90 === null) return null;
  let lower = 0;
  if (f.wf_phases_left > 0 && f.phase_median_s !== null && f.phase_median_s > 0) {
    lower = f.wf_phases_left * f.phase_median_s;
  }
  const a = Math.max(p50.s, lower);
  const b = Math.max(p90.s, lower, a);
  return { p50_s: a, p90_s: b, extrapolated: p50.extrapolated || p90.extrapolated };
}

export function predict(
  model: EtaModel,
  fit: FittedModels,
  elapsedS: number,
  f: Features,
  minFit: number,
): Prediction | null {
  if (model === "const_median") return predictConstMedian(fit, elapsedS);
  if (model === "residual_life") return predictResidualLife(fit, elapsedS);
  return predictFanoutCond(fit, elapsedS, f, minFit);
}

// ---------------------------------------------------------------------------
// the corpus, the live features, the fit
// ---------------------------------------------------------------------------

/**
 * The fitting corpus: `run_segment` rows cut at the gap threshold CURRENTLY in force.
 *
 * The `gap_min` filter is not decoration. The measured p50 moves ~10× across plausible
 * thresholds, so mixing rows cut at 2 minutes with rows cut at 30 is a category error
 * of the same family as averaging two estimands (§4.2 delta 3).
 */
export function etaCorpus(db: Database, gapMin: number, asOf?: Date): Observation[] {
  // `asOf` is the retro's injected clock, and it BOUNDS THE CORPUS rather than decorating
  // the call: `est retro --as-of <iso>` exists to re-run a scoring as it would have gone
  // at that instant, and a re-run that silently scored segments cut after it is not a
  // re-run, it is a different experiment wearing the same flag.
  const bound = asOf === undefined ? null : isoNow(asOf);
  return db
    .query<
      { span_s: number; censored: number; n_agents: number; max_concurrency: number },
      [number, string | null]
    >(
      // NEWEST FIRST: `scoreEtaModels` caps the held-out set and takes it off the
      // front, so the order is load-bearing rather than cosmetic.
      `SELECT span_s, censored, n_agents, max_concurrency
         FROM v_eta_corpus WHERE gap_min = ?1 AND span_s >= 0
           AND (?2 IS NULL OR started_at <= ?2)
        ORDER BY started_at DESC`,
    )
    .all(gapMin, bound)
    .map((r) => ({
      len_s: r.span_s,
      censored: r.censored === 1,
      n_agents: r.n_agents,
      max_concurrency: r.max_concurrency,
    }));
}

/**
 * How many CLOSED segments the model was fitted on, at the threshold in force.
 *
 * The one aggregate the P1.9 read path is allowed to run, and the reason it is allowed:
 * `run_segment` is bounded by WALL-CLOCK TIME, not by corpus volume — a segment spans
 * minutes to hours, and P2.10 prunes at 365 days, so the row count is bounded by how
 * long a person has been using the thing. That is orders of magnitude off `request`,
 * whose per-render aggregate is what forced this cache into existence in the first
 * place. The budget is pinned by a test rather than by this comment.
 */
export function etaCorpusSize(db: Database, gapMin?: number): number {
  const g = gapMin ?? segmentGapMin(db);
  return (
    db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM run_segment WHERE gap_min = ? AND terminator <> 'open'",
      )
      .get(g)?.n ?? 0
  );
}

/**
 * Median span of one completed workflow phase, in seconds — the `fanout_cond` floor.
 *
 * `asOf` bounds it for the same reason it bounds {@link etaCorpus}: this number is a
 * model PARAMETER, so a retro replayed at an earlier instant that fitted it on phases
 * which had not finished yet would be scoring a model that never existed.
 */
export function phaseMedianSeconds(db: Database, asOf?: Date): number | null {
  const bound = asOf === undefined ? null : isoNow(asOf);
  const spans = db
    .query<{ span_s: number }, [string | null]>(
      `SELECT CAST((julianday(MAX(ended_at)) - julianday(MIN(started_at))) * 86400 AS INTEGER) AS span_s
         FROM agent_run
        WHERE run_id IS NOT NULL AND phase_idx IS NOT NULL
          AND started_at IS NOT NULL AND ended_at IS NOT NULL
          AND (?1 IS NULL OR ended_at <= ?1)
        GROUP BY run_id, wf_launch_id, phase_idx`,
    )
    .all(bound)
    .map((r) => r.span_s)
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b);
  return quantileOf(spans, 0.5);
}

// ---------------------------------------------------------------------------
// liveness — what still counts as work in flight
// ---------------------------------------------------------------------------

/**
 * Open `workflow_run` rows that are still plausibly running, by the same rule.
 *
 * A workflow dangles the same way an agent does — worse, in fact: `workflow_run.ended_at`
 * is DERIVED from its agents' transcripts (R2), so a run whose agents never returned has
 * nothing to close it. Its liveness clock is `MAX(started_at, the newest bound of any of
 * its agents)`, which advances while phases keep finishing and freezes when they stop.
 *
 * `started_at IS NULL` counts as LIVE: the column is nullable because the start is derived
 * too, so a NULL means "no age evidence at all", and the safe reading of no evidence is
 * "do not claim Claude is waiting".
 */
export function countLiveWorkflows(
  db: Database,
  sessionId: string,
  now: Date,
  maxMin: number,
): number {
  const freshSince = isoNow(new Date(now.getTime() - maxMin * 60_000));
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM workflow_run w
          WHERE w.session_id = ?1 AND w.ended_at IS NULL
            AND (w.started_at IS NULL
                 OR MAX(julianday(w.started_at),
                        COALESCE((SELECT MAX(julianday(COALESCE(a.ended_at, a.started_at)))
                                    FROM agent_run a
                                   WHERE a.run_id = w.run_id AND a.wf_launch_id = w.wf_launch_id),
                                 0)) >= julianday(?2))`,
      )
      .get(sessionId, freshSince)?.n ?? 0
  );
}

/**
 * Live structural features for one session (no token counter is read here).
 *
 * `live_agents` is the `fanout_cond` STRATUM, so it uses the bounded liveness rule too
 * ({@link countLiveAgents}): the strata are fitted from `run_segment.n_agents`, which
 * counts agents with BOTH bounds, and predicting with an unbounded live count would let a
 * dead agent push a solo session into the `small` stratum and answer from the wrong curve.
 * `now`/`maxMin` default so a caller that has neither still gets the old, unbounded count
 * rather than a silently-shifted one.
 */
export function liveFeatures(
  db: Database,
  sessionId: string,
  phaseMedianS: number | null,
  opts: { now?: Date; maxMin?: number } = {},
): Features {
  const agents =
    opts.now !== undefined
      ? countLiveAgents(db, { session: sessionId }, opts.now, opts.maxMin ?? liveAgentMaxMin(db))
      : db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM agent_run WHERE session_id = ? AND started_at IS NOT NULL AND ended_at IS NULL",
          )
          .get(sessionId)?.n ?? 0;
  const wf = db
    .query<{ planned: number | null; done: number | null }, [string]>(
      `SELECT w.n_phases_planned AS planned,
              (SELECT COUNT(DISTINCT a.phase_idx) FROM agent_run a
                WHERE a.run_id = w.run_id AND a.wf_launch_id = w.wf_launch_id
                  AND a.phase_idx IS NOT NULL AND a.ended_at IS NOT NULL) AS done
         FROM workflow_run w
        WHERE w.session_id = ? AND w.ended_at IS NULL
        ORDER BY w.started_at DESC LIMIT 1`,
    )
    .get(sessionId);
  const planned = wf?.planned ?? 0;
  const done = wf?.done ?? 0;
  return {
    live_agents: agents,
    wf_phases_left: planned > 0 ? Math.max(0, planned - done) : 0,
    phase_median_s: phaseMedianS,
  };
}

/**
 * The three pieces of evidence that decide whether Claude is blocked on the human —
 * the live half of the boundary rule (see the file header).
 */
export interface BlockState {
  /**
   * `agent_run` rows for this session that started, have not ended, and are still FRESH
   * by {@link countLiveAgents}' rule. A dead agent is not a running one.
   */
  live_agents: number;
  /** A fresh `workflow_run` with no `ended_at`: a headless run cannot ask for input mid-flight. */
  open_workflow: boolean;
  /**
   * The session's NEWEST turn carries no `turn_duration` record yet, so as far as the
   * transcript is concerned the main chain is still mid-response.
   */
  open_turn: boolean;
  /**
   * Unfinished rows the age bound EXCLUDED — dangling agents, and open workflow runs whose
   * phases stopped advancing. Reported rather than merely dropped: "Claude is waiting"
   * over a session holding two corpses is a different sentence from the same verdict over
   * a session holding none, and this is the number that says which one you are reading.
   */
  stale_agents: number;
}

export function blockState(db: Database, sessionId: string, now: Date = new Date()): BlockState {
  const maxMin = liveAgentMaxMin(db);
  const agents = countLiveAgents(db, { session: sessionId }, now, maxMin);
  // Not `liveFeatures.wf_phases_left > 0`: that is 0 for an open run whose
  // `n_phases_planned` never landed, and "we do not know how many phases are left" is
  // not the same fact as "no workflow is running".
  const wf = countLiveWorkflows(db, sessionId, now, maxMin);
  const unfinished =
    db
      .query<{ n: number }, [string]>(
        `SELECT (SELECT COUNT(*) FROM agent_run
                  WHERE session_id = ?1 AND started_at IS NOT NULL AND ended_at IS NULL)
              + (SELECT COUNT(*) FROM workflow_run WHERE session_id = ?1 AND ended_at IS NULL) AS n`,
      )
      .get(sessionId)?.n ?? 0;
  const turn = db
    .query<{ duration_ms: number | null }, [string]>(
      "SELECT duration_ms FROM turn WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
    )
    .get(sessionId);
  return {
    live_agents: agents,
    open_workflow: wf > 0,
    // No turn at all is not an open turn: an empty session is not mid-response.
    open_turn: turn !== null && turn !== undefined && turn.duration_ms === null,
    stale_agents: Math.max(0, unfinished - agents - wf),
  };
}

/**
 * IDLE SUPPRESSION (Craig, 2026-07-30): is Claude blocked on the human right now?
 *
 * When it is, there is nothing to forecast — the answer to "when will Claude next need
 * me" is "now" — and `est burn --json` says `check_back: {waiting_on_input: true}`
 * rather than issuing a residual-life quantile against a segment that is not moving.
 * This is the defect's live half: the 4.6 h segment was still `open` (its last activity
 * was inside the gap window) with zero agents live, so a Lindy-style residual quantile
 * confidently forecast five more hours of a run that had already stopped.
 *
 * The three conditions are the three ways work can still be in flight, and each one is
 * a POSITIVE observation rather than an inference:
 *
 *  - a live `agent_run` — a delegation is running and will report back;
 *  - an open `workflow_run` — a headless run cannot ask for input until it returns;
 *  - an open turn — the newest turn has no `turn_duration` record, so the main chain
 *    has not handed control back yet.
 *
 * **The first two are AGE-BOUNDED (Craig, 2026-07-30).** "Unfinished" is what a running
 * delegation looks like and also what a dead one looks like, and dead ones are common
 * enough (§5.6's `agent_never_returned`; 49 of 54 unfinished rows on the live corpus were
 * more than six hours old) that without a bound a single corpse would pin its session as
 * busy forever and suppression could never fire — neutering this predicate for the
 * long-lived sessions it exists for. {@link countLiveAgents} states the rule and why its
 * clock is last-observed-activity rather than `started_at`.
 *
 * The third is deliberately CONSERVATIVE in the safe direction. 27% of turns in the
 * specification corpus never got a `turn_duration` record at all, and for those the
 * newest turn reads as open forever — so suppression sometimes fails to fire and the
 * forecast is issued as before. That is the right way round: falsely claiming "awaiting
 * input" while Claude is mid-response puts a wrong statement on Craig's screen, whereas
 * failing to claim it merely leaves the previous behaviour in place, and the boundary
 * rule has already fixed the segment that behaviour is issued against.
 *
 * No token counter is read here — see the file header's invariant.
 */
export function waitingOnInput(db: Database, sessionId: string, now: Date = new Date()): boolean {
  const s = blockState(db, sessionId, now);
  return s.live_agents === 0 && !s.open_workflow && !s.open_turn;
}

export interface EtaFit {
  gapMin: number;
  /** `config.eta_live_agent_max_min`, resolved ONCE per sweep like every other knob here. */
  liveAgentMaxMin: number;
  minFit: number;
  minSegments: number;
  gain: number;
  models: FittedModels;
  /** Which model issues the number on screen — recorded per render, not per release. */
  shipped: EtaModel;
  probation: boolean;
  phaseMedianS: number | null;
}

/**
 * Which model ships, and whether it is on probation.
 *
 * The reconciliation of two rules that read as if they contradict: "the default issues
 * bands only while it beats `const_median`" and "probation starts on day one". They
 * agree once you notice that `check_back` is `null` in EXACTLY three enumerated cases
 * (no open segment, too few closed segments, empty payload) — so a fitted model must
 * issue something. `residual_life` therefore ships from day one wearing a `?`, and the
 * gates decide only (a) whether `fanout_cond` REPLACES it and (b) when the `?` comes
 * off. A model that never earns its stripes keeps the marker forever, which is the
 * honest outcome the probation regime is there to produce.
 */
function shippedModel(db: Database): { model: EtaModel; probation: boolean } {
  // The LATEST retro decides, and only the latest: "the candidate issues bands only
  // WHILE it beats the default" is a present-tense rule. Asking for the newest row with
  // `won = 1` would instead let a candidate that won once keep the crown after every
  // subsequent retro had taken it away — a stale winner is exactly the failure mode the
  // per-render `eta_model` record exists to make visible.
  const latest = db.query<{ as_of: string }, []>("SELECT MAX(as_of) AS as_of FROM eta_run").get();
  if (latest === null || latest === undefined || latest.as_of === null) {
    return { model: "residual_life", probation: true };
  }
  const rows = db
    .query<{ eta_model: string; won: number; probation: number }, [string]>(
      "SELECT eta_model, won, probation FROM eta_run WHERE as_of = ?",
    )
    .all(latest.as_of);
  for (const want of ["fanout_cond", "residual_life"] as const) {
    const r = rows.find((x) => x.eta_model === want && x.won !== 0);
    if (r !== undefined) return { model: want, probation: r.probation !== 0 };
  }
  // Nothing won: `residual_life` still ships (the payload's null cases are enumerated
  // and "no model won" is not among them) and it keeps its `?`.
  return { model: "residual_life", probation: true };
}

export function buildEtaFit(db: Database): EtaFit {
  const gapMin = segmentGapMin(db);
  const ship = shippedModel(db);
  return {
    gapMin,
    liveAgentMaxMin: liveAgentMaxMin(db),
    minFit: Math.max(1, Math.round(configNum(db, "eta_min_fit", 5))),
    minSegments: Math.max(1, Math.round(configNum(db, "eta_min_segments", 30))),
    gain: configNum(db, "eta_min_pinball_gain", 0.05),
    models: fitModels(etaCorpus(db, gapMin)),
    shipped: ship.model,
    probation: ship.probation,
    phaseMedianS: phaseMedianSeconds(db),
  };
}

// ---------------------------------------------------------------------------
// the forecast
// ---------------------------------------------------------------------------

export interface CheckBack {
  p50_min: number;
  p90_min: number;
  seg_started_at: string;
  seg_elapsed_min: number;
  eta_model: EtaModel;
  n_seg: number;
  probation: boolean;
  basis: "session";
}

/** Seconds form, for the `burn_cache` columns. */
export interface CheckBackSeconds extends CheckBack {
  p50_s: number;
  p90_s: number;
  seg_elapsed_s: number;
}

/**
 * The check-back forecast for one session, or `null`.
 *
 * `null` in exactly two cases, and BOTH are well-formed answers at exit 0: the session
 * has no open segment, or fewer than `eta_min_fit` closed segments exist to fit.
 *
 * This is the FORECASTER and nothing else: it does not ask whether a forecast should be
 * issued at all. {@link checkBackForSession} owns that, so that every payload path goes
 * through one place that can say "Claude is blocked on you" instead.
 */
export function forecastSession(
  db: Database,
  sessionId: string,
  fit: EtaFit,
  now: Date = new Date(),
): CheckBackSeconds | null {
  // `gap_min = ?` for the reason `run_segment`'s key carries it: a retune leaves the
  // retired partition's open row in the table, and it starts at a different instant.
  // Forecasting against a segment cut to a threshold nobody is using is a wrong number,
  // not a stale one. Same scope as `v_segment_current`.
  const seg = db
    .query<{ started_at: string }, [string, number]>(
      `SELECT started_at FROM run_segment
        WHERE session_id = ? AND terminator = 'open' AND gap_min = ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(sessionId, fit.gapMin);
  if (seg === null || seg === undefined) return null;
  if (fit.models.n_closed < fit.minFit) return null;

  const startedMs = Date.parse(seg.started_at);
  if (!Number.isFinite(startedMs)) return null;
  const elapsedS = Math.max(0, Math.round((now.getTime() - startedMs) / 1000));

  // `now` and the liveness bound go in: the stratum must be counted by the same rule the
  // idle predicate uses, or `fanout_cond` answers from the wrong curve when an agent died.
  const features = liveFeatures(db, sessionId, fit.phaseMedianS, { now, maxMin: fit.liveAgentMaxMin });
  const p = predict(fit.shipped, fit.models, elapsedS, features, fit.minFit);
  if (p === null) return null;

  return {
    p50_s: Math.round(p.p50_s),
    p90_s: Math.round(p.p90_s),
    p50_min: Math.round(p.p50_s / 60),
    p90_min: Math.round(p.p90_s / 60),
    seg_started_at: seg.started_at,
    seg_elapsed_s: elapsedS,
    seg_elapsed_min: Math.round(elapsedS / 60),
    eta_model: fit.shipped,
    n_seg: fit.models.n_closed,
    probation: fit.probation,
    basis: "session",
  };
}

/** What the check-back field of a payload is about to say, for one session. */
export interface CheckBackState {
  /**
   * Claude is blocked on the human RIGHT NOW ({@link waitingOnInput}), so there is
   * nothing to forecast. This OUTRANKS `forecast`, which is why the two never both
   * carry a value: a residual-life quantile issued over an idle session is the defect.
   */
  waiting: boolean;
  forecast: CheckBackSeconds | null;
}

/**
 * The one place that decides what the check-back field says about a session.
 *
 * Precedence, and it is deliberate: **waiting beats forecasting, and waiting is
 * reported even when no forecast could have been issued anyway.** Whether Claude is
 * blocked on Craig is a FACT about the session, observed from live agents, open
 * workflows and the newest turn — it does not depend on there being an open segment or
 * on the corpus being thick enough to fit. So an idle session says `waiting_on_input`
 * whether or not the segment closed and whether or not `n_closed >= eta_min_fit`, and
 * the enumerated `null` cases keep their old meaning for a session that is NOT idle:
 * "something is running and we cannot yet say for how long".
 */
export function checkBackForSession(
  db: Database,
  sessionId: string,
  fit: EtaFit,
  now: Date = new Date(),
): CheckBackState {
  if (waitingOnInput(db, sessionId, now)) return { waiting: true, forecast: null };
  return { waiting: false, forecast: forecastSession(db, sessionId, fit, now) };
}

/**
 * "~57m" / "~2.4h", the ONE rounding rule, shared by the statusline and `est burn`.
 *
 * Never seconds: a seconds-precision ETA from a model whose p90 is 30× its p50 is
 * theatre. `<1m` rather than `~0m` because zero reads as "done" and the honest claim
 * is "any moment now".
 */
export function formatEta(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "?";
  if (minutes < 1) return "<1m";
  if (minutes < 90) return `~${Math.round(minutes)}m`;
  return `~${(minutes / 60).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// scoring: what the model was fitted on, and what it had to beat
// ---------------------------------------------------------------------------

/**
 * Conditioning times the retro scores at, in seconds.
 *
 * A FIXED grid, not a function of the held-out segment's own length: scoring at `L/2`
 * would leak the answer into the question, which is the classic way a residual-life
 * model marks its own homework.
 */
export const PROBE_S: readonly number[] = [0, 300, 900, 1800, 3600];

/**
 * Most recent closed segments to HOLD OUT, one at a time.
 *
 * Leave-one-out refits the curve per held-out observation, so the loop is quadratic in
 * the corpus. Capping the held-out set — not the fitting set, which stays whole — keeps
 * a weekly retro bounded as the corpus grows past a year, and recency is the right axis
 * to cap on: model families, harness versions and Craig's own working shape all drift,
 * and a segment from fourteen months ago is a weaker witness than last week's.
 */
export const ETA_SCORE_MAX_HELDOUT = 400;

export interface EtaScore {
  eta_model: EtaModel;
  n_seg: number;
  n_censored: number;
  gap_min: number;
  pinball_p50: number | null;
  pinball_p90: number | null;
  baseline_pinball_p50: number;
  coverage_p90: number | null;
  cov_lo: number | null;
  cov_hi: number | null;
  won: boolean;
  probation: boolean;
  params: Record<string, unknown>;
}

/**
 * Score all three models by leave-one-out pinball loss at p50/p90, plus p90 coverage
 * with a Jeffreys interval — the same §7.4 discipline the token calibrator uses.
 *
 * Leave-one-out, because with n in the low hundreds a held-out split throws away the
 * tail that IS the distribution.
 */
export function scoreEtaModels(db: Database, opts: { asOf?: Date } = {}): EtaScore[] {
  const gapMin = segmentGapMin(db);
  const minFit = Math.max(1, Math.round(configNum(db, "eta_min_fit", 5)));
  const minSegments = Math.max(1, Math.round(configNum(db, "eta_min_segments", 30)));
  const gate = configNum(db, "eta_min_pinball_gain", 0.05);
  // HONOURED, not discarded. `src/retro.ts` passes the retro's injected clock here, and
  // for a while this function threw it away (`void opts`) and scored the whole table —
  // so `est retro --as-of <past instant>` reported a score that depended on segments
  // recorded after it. That is not a replay, and the flag's only purpose is replay.
  const obs = etaCorpus(db, gapMin, opts.asOf);
  const closedIdx = obs.map((o, i) => (o.censored ? -1 : i)).filter((i) => i >= 0);
  const nClosed = closedIdx.length;
  const nCensored = obs.length - nClosed;

  const models: EtaModel[] = ["const_median", "residual_life", "fanout_cond"];
  const loss: Record<string, { p50: number[]; p90: number[]; covered: number; scored: number }> = {};
  for (const m of models) loss[m] = { p50: [], p90: [], covered: 0, scored: 0 };

  if (nClosed >= minFit) {
    const phaseMedian = phaseMedianSeconds(db, opts.asOf);
    // `etaCorpus` returns newest first, so this takes the most recent held-out set.
    for (const i of closedIdx.slice(0, ETA_SCORE_MAX_HELDOUT)) {
      const held = obs[i]!;
      const rest = obs.filter((_, j) => j !== i);
      if (rest.filter((o) => !o.censored).length < 1) continue;
      const fit = fitModels(rest);
      const features: Features = {
        live_agents: held.n_agents,
        wf_phases_left: 0,
        phase_median_s: phaseMedian,
      };
      for (const t of PROBE_S) {
        if (held.len_s <= t) continue;
        const actual = held.len_s - t;
        for (const m of models) {
          const p = predict(m, fit, t, features, minFit);
          if (p === null) continue;
          loss[m]!.p50.push(pinball(actual, p.p50_s, 0.5));
          loss[m]!.p90.push(pinball(actual, p.p90_s, 0.9));
          loss[m]!.scored += 1;
          if (actual <= p.p90_s) loss[m]!.covered += 1;
        }
      }
    }
  }

  const mean = (xs: readonly number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((t, v) => t + v, 0) / xs.length;

  const baseline = mean(loss.const_median!.p50) ?? 0;
  const scores: EtaScore[] = [];
  for (const m of models) {
    const l = loss[m]!;
    const p50 = mean(l.p50);
    const p90 = mean(l.p90);
    const cov = l.scored > 0 ? jeffreysInterval(l.covered, l.scored, 0.9) : null;
    const coverage = l.scored > 0 ? l.covered / l.scored : null;
    const gain = baseline > 0 && p50 !== null ? (baseline - p50) / baseline : 0;
    const beatsBaseline = gain >= gate;
    const beatsDefault =
      p50 !== null && mean(loss.residual_life!.p50) !== null && p50 < mean(loss.residual_life!.p50)!;
    const won =
      m === "const_median" ? false : m === "residual_life" ? beatsBaseline : beatsBaseline && beatsDefault;
    const covOk = cov !== null && cov.lo <= 0.9 && cov.hi >= 0.9;
    scores.push({
      eta_model: m,
      n_seg: nClosed,
      n_censored: nCensored,
      gap_min: gapMin,
      pinball_p50: p50,
      pinball_p90: p90,
      baseline_pinball_p50: baseline,
      coverage_p90: coverage,
      cov_lo: cov?.lo ?? null,
      cov_hi: cov?.hi ?? null,
      won,
      // Probation ends only on ALL THREE: enough closed segments, a real gain over the
      // floor, and a p90 coverage interval that contains 0.90. Any one of them missing
      // and the `?` stays on Craig's screen.
      probation: !(won && nClosed >= minSegments && covOk),
      params: {
        probe_s: PROBE_S,
        n_scored: l.scored,
        gain,
        censoring: "kaplan_meier_right_censored",
        tail: "exponential_constant_hazard",
      },
    });
  }
  return scores;
}

/** Append one `eta_run` row per model. Append-only: the table's triggers enforce it. */
export function writeEtaRuns(db: Database, scores: readonly EtaScore[], asOf: Date = new Date()): number {
  const ts = isoNow(asOf);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO eta_run (as_of, eta_model, n_seg, n_censored, gap_min,
                                    pinball_p50, pinball_p90, baseline_pinball_p50,
                                    coverage_p90, cov_lo, cov_hi, won, probation, params_json)
     VALUES ($as_of, $eta_model, $n_seg, $n_censored, $gap_min,
             $pinball_p50, $pinball_p90, $baseline_pinball_p50,
             $coverage_p90, $cov_lo, $cov_hi, $won, $probation, $params_json)`,
  );
  let n = 0;
  for (const s of scores) {
    stmt.run({
      $as_of: ts,
      $eta_model: s.eta_model,
      $n_seg: s.n_seg,
      $n_censored: s.n_censored,
      $gap_min: s.gap_min,
      $pinball_p50: s.pinball_p50,
      $pinball_p90: s.pinball_p90,
      $baseline_pinball_p50: s.baseline_pinball_p50,
      $coverage_p90: s.coverage_p90,
      $cov_lo: s.cov_lo,
      $cov_hi: s.cov_hi,
      $won: s.won ? 1 : 0,
      $probation: s.probation ? 1 : 0,
      $params_json: JSON.stringify(s.params),
    } as never);
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// `est segments` — the tuning surface
// ---------------------------------------------------------------------------

export interface SegmentsQuery {
  session?: string | null;
  /** Recompute at this threshold instead of reading persisted rows. NEVER persisted. */
  gap?: number | null;
  since?: string | null;
  limit?: number;
  now?: Date;
}

export interface SegmentsReport {
  schema: 1;
  as_of: string;
  gap_min: number;
  /** True when `--gap` recomputed on the fly rather than reading `run_segment`. */
  recomputed: boolean;
  n: number;
  segments: SegmentRow[];
}

/**
 * Read-only. Never writes, never locks, always exits 0 — an empty list is an answer.
 *
 * `--gap` recomputes at a different threshold WITHOUT persisting anything, which is how
 * `segment_gap_min` gets fitted by evidence instead of taste. It is the same "make the
 * knob's effect visible" move `est refclass --full` makes for the reference class.
 */
export function segmentsReport(db: Database, q: SegmentsQuery = {}): SegmentsReport {
  const now = q.now ?? new Date();
  const limit = q.limit === undefined || q.limit <= 0 ? 50 : q.limit;
  const recomputed = q.gap !== null && q.gap !== undefined && q.gap > 0;
  const gapMin = recomputed ? q.gap! : segmentGapMin(db);

  let rows: SegmentRow[];
  if (recomputed) {
    const sessions =
      q.session !== null && q.session !== undefined && q.session !== ""
        ? [q.session]
        : db
            .query<{ session_id: string }, []>(
              `SELECT DISTINCT session_id FROM (
                 SELECT session_id FROM turn
                 UNION SELECT session_id FROM agent_run
                 UNION SELECT session_id FROM v_request_live)`,
            )
            .all()
            .map((r) => r.session_id);
    const live = liveSessionIds();
    const idx = loadIntervalIndex(db, sessions);
    rows = [];
    for (const sid of sessions) {
      rows.push(...segmentsFromIndex(idx, sid, { gapMin, now, live: live.has(sid) }));
    }
  } else {
    const where: string[] = ["gap_min = ?"];
    const args: (string | number)[] = [gapMin];
    if (q.session !== null && q.session !== undefined && q.session !== "") {
      where.push("session_id = ?");
      args.push(q.session);
    }
    if (q.since !== null && q.since !== undefined && q.since !== "") {
      where.push("ended_at >= ?");
      args.push(q.since);
    }
    rows = db
      .query<SegmentRow, (string | number)[]>(
        `SELECT session_id, started_at, ended_at, active_s, busy_s, max_concurrency,
                n_turns, n_agents, gap_before_s, gap_after_s, terminator,
                interval_src_mix, gap_min, tid
           FROM run_segment WHERE ${where.join(" AND ")}`,
      )
      .all(...args);
  }

  if (q.since !== null && q.since !== undefined && q.since !== "" && recomputed) {
    rows = rows.filter((r) => r.ended_at >= q.since!);
  }
  rows.sort((a, b) => (a.started_at === b.started_at ? 0 : a.started_at < b.started_at ? 1 : -1));
  const n = rows.length;
  return {
    schema: 1,
    as_of: isoNow(now),
    gap_min: gapMin,
    recomputed,
    n,
    segments: rows.slice(0, limit),
  };
}

/**
 * test/eta.test.ts — the check-back forecast (P2.1, P2.2).
 *
 * Four things this file is responsible for proving, in descending order of how badly
 * the system breaks if one of them stops being true:
 *
 *  1. **`check_back` is never token-derived.** ×10 every token counter in a fixture and
 *     every check-back number must be bit-identical. This is the design's own test, and
 *     it exists because the tokens→time chain is the single most seductive wrong idea in
 *     this problem space: it has already been refuted twice at r² ≈ 0.001–0.003, and the
 *     cheapest way for it to come back is a well-meaning "we already have the burn rate
 *     right here".
 *  2. **The segmentation is what the spec says it is** — fixture-driven, at more than
 *     one gap threshold, including the turn that contributes no interval at all.
 *  3. **The forecast degrades to nothing rather than to a wrong number.** No open
 *     segment, too thin a corpus, a stale cache row, a guessed target: all of them are
 *     an empty ETA, never a confident one.
 *  4. **The statusline stays cheap and honest** — the `?` while on probation, p50 only,
 *     and a read path bounded by the row rather than by the corpus behind it.
 *
 * Every fixture is synthetic (see test/fixtures/eta/README.md).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { makeHarness, openArgs, seedPrices, type Harness } from "./support.ts";
import { compactionAnomalies, INSERT_ANOMALY_SQL } from "../src/ingest.ts";
import {
  buildEtaFit,
  buildSessionSegments,
  etaCorpus,
  etaCorpusSize,
  fitModels,
  formatEta,
  forecastSession,
  kaplanMeier,
  mergeComponents,
  predictConstMedian,
  predictFanoutCond,
  predictResidualLife,
  refreshSegments,
  residualQuantile,
  scoreEtaModels,
  segmentsReport,
  stratumOf,
  survivalAt,
  waitingOnInput,
  writeEtaRuns,
  type CheckBack,
  type Observation,
  type SegmentRow,
} from "../src/eta.ts";
import {
  burnJson,
  burnRead,
  isWaitingOnInput,
  refreshBurnCache,
  renderBurn,
  type BurnActive,
  type CheckBackWaiting,
} from "../src/burn.ts";
import { formatSegment } from "../scripts/statusline-burn.ts";

/**
 * Narrow `check_back` to the BAND, failing loudly if it is the waiting shape or null.
 *
 * A cast would compile just as well and would silently pass `undefined` into every
 * following assertion the day suppression starts firing where a band was expected — so
 * the discrimination is an assertion, not an annotation.
 */
function band(cb: CheckBack | CheckBackWaiting | null | undefined): CheckBack {
  expect(isWaitingOnInput(cb)).toBe(false);
  expect(cb).not.toBeNull();
  return cb as CheckBack;
}

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "eta");

interface FixtureCase {
  gap_min: number;
  segments: Array<Record<string, unknown>>;
}
interface Fixture {
  name: string;
  note: string;
  session: string;
  now: string;
  live: boolean;
  turns: Array<{ prompt: string; at: string; duration_ms: number | null }>;
  /** `ended_at: null` is a LIVE agent: no interval (the union needs both bounds), but the
   *  session is not idle — which is how a fixture can be busy without changing its rows. */
  agents: Array<{ id: string; started_at: string; ended_at: string | null }>;
  requests: Array<{ id: string; at: string; duration_ms: number }>;
  compactions: string[];
  cases: FixtureCase[];
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture);
}

/** Load one fixture's rows into a database. Token counters are a parameter on purpose. */
function loadFixture(db: Database, fx: Fixture, tokenScale = 1): void {
  for (const t of fx.turns) {
    db.query(
      `INSERT OR REPLACE INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid)
       VALUES (?,?,?,?,NULL,NULL,NULL)`,
    ).run(fx.session, t.prompt, t.at, t.duration_ms);
  }
  for (const a of fx.agents) {
    db.query(
      `INSERT OR REPLACE INTO agent_run (agent_id, session_id, run_id, wf_launch_id, agent_type, spawn_depth,
                                         launch_prompt_id, transcript_path, status, label,
                                         started_at, ended_at, interval_src, queued_at, attempt,
                                         reported_tokens, phase_idx, phase_title, phase_conf, tid)
       VALUES (?,?,NULL,NULL,'general-purpose',1,NULL,NULL,'completed',NULL,?,?,'transcript',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
    ).run(a.id, fx.session, a.started_at, a.ended_at);
  }
  for (const r of fx.requests) {
    db.query(
      `INSERT OR REPLACE INTO request (request_id, message_id, is_sidechain, session_id, prompt_id, origin,
                                       agent_id, run_id, wf_launch_id, model, model_family,
                                       attribution_agent, attribution_skill, ts,
                                       in_tok, out_tok, cw_tok, cr_tok, duration_ms, tid, attr)
       VALUES (?,?,0,?,NULL,'main',NULL,NULL,NULL,'claude-test-1','claude-test-1',NULL,NULL,?,?,?,?,?,?,NULL,'none')`,
    ).run(
      r.id,
      `msg-${r.id}`,
      fx.session,
      r.at,
      11 * tokenScale,
      22 * tokenScale,
      33 * tokenScale,
      44 * tokenScale,
      r.duration_ms,
    );
  }
  // Through ingest's OWN writer, so the detail string this fixture depends on is the
  // one production writes — the coupling between the two is the point (see below).
  const stmt = db.prepare(INSERT_ANOMALY_SQL);
  for (const a of compactionAnomalies(
    fx.session,
    fx.compactions.map((ts) => ({ ts, preTokens: null })),
  )) {
    stmt.run({ $ts: fx.now, $kind: a.kind, $detail: a.detail } as never);
  }
}

let h: Harness;
beforeEach(() => {
  h = makeHarness("est-eta-");
  seedPrices(h.db);
});
afterEach(() => h.close());

// ---------------------------------------------------------------------------
// 1. segmentation, fixture-driven
// ---------------------------------------------------------------------------

describe("run segments — P2.1", () => {
  for (const fx of loadFixtures()) {
    for (const c of fx.cases) {
      test(`${fx.name} @ gap ${c.gap_min}m — ${fx.note.slice(0, 60)}…`, () => {
        loadFixture(h.db, fx);
        const rows = buildSessionSegments(h.db, fx.session, {
          gapMin: c.gap_min,
          now: new Date(fx.now),
          live: fx.live,
        });
        expect(rows.length).toBe(c.segments.length);
        rows.forEach((row, i) => {
          const want = c.segments[i]!;
          for (const [k, v] of Object.entries(want)) {
            expect({ field: k, value: (row as unknown as Record<string, unknown>)[k] }).toEqual({
              field: k,
              value: v,
            });
          }
          expect(row.gap_min).toBe(c.gap_min);
          expect(row.session_id).toBe(fx.session);
        });
      });
    }
  }

  test("a turn with no turn_duration contributes NO interval — the hole OTEL fills", () => {
    h.db
      .query(
        `INSERT INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid)
         VALUES ('s-hole','p1','2026-03-01T10:00:00.000Z',NULL,NULL,NULL,NULL)`,
      )
      .run();
    const rows = buildSessionSegments(h.db, "s-hole", { gapMin: 5, now: new Date("2026-03-01T10:01:00Z") });
    // Not "a zero-length segment": no segment at all. Inventing a duration here would
    // manufacture corpus observations out of missing data.
    expect(rows).toEqual([]);
  });

  test("mergeComponents joins touching intervals and drops inverted ones", () => {
    expect(
      mergeComponents([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 30, end: 25 },
        { start: 40, end: 40 },
        { start: 5, end: 8 },
      ]),
    ).toEqual([{ start: 0, end: 20 }]);
  });

  test("the compaction detail string ingest writes is the one eta parses", () => {
    // These two live in different modules and are joined only by a format. A reworded
    // detail must fail HERE rather than silently empty the compaction list and turn
    // every /compact boundary into a fabricated `human_input` observation.
    const [a] = compactionAnomalies("s-fmt", [{ ts: "2026-03-01T09:03:00.000Z", preTokens: 1234 }]);
    h.db
      .prepare(INSERT_ANOMALY_SQL)
      .run({ $ts: "2026-03-01T09:03:00.000Z", $kind: a!.kind, $detail: a!.detail } as never);
    const fx = loadFixtures().find((f) => f.name === "compaction")!;
    loadFixture(h.db, { ...fx, session: "s-fmt", compactions: [] });
    const rows = buildSessionSegments(h.db, "s-fmt", { gapMin: 5, now: new Date(fx.now) });
    expect(rows[0]!.terminator).toBe("compaction");
  });
});

// ---------------------------------------------------------------------------
// 2. persistence
// ---------------------------------------------------------------------------

describe("run_segment persistence — P2.5", () => {
  test("re-running the refresh over unchanged inputs is a no-op", () => {
    const fx = loadFixtures().find((f) => f.name === "basic")!;
    loadFixture(h.db, fx);
    const now = new Date(fx.now);
    const first = refreshSegments(h.db, { now, all: true });
    expect(first.segments).toBe(3);
    const before = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment").get()?.n;
    refreshSegments(h.db, { now, all: true });
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment").get()?.n).toBe(before!);
  });

  test("timestamps are SECONDS precision, like every other column they sort against", () => {
    const fx = loadFixtures().find((f) => f.name === "basic")!;
    loadFixture(h.db, fx);
    refreshSegments(h.db, { now: new Date(fx.now), all: true });
    for (const r of h.db
      .query<{ started_at: string; ended_at: string }, []>(
        "SELECT started_at, ended_at FROM run_segment",
      )
      .all()) {
      expect(r.started_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(r.ended_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    }
    // The reason it matters: `--since` is compared lexicographically, and at index 19
    // '.' (0x2E) sorts BELOW 'Z' (0x5A). A ms-precision `ended_at` therefore fell out of
    // the report for the exact boundary second a user types.
    expect(segmentsReport(h.db, { since: "2026-03-01T10:12:00Z", now: new Date(fx.now) }).n).toBe(2);
  });

  test("a terminal segment is RESTATED by a re-cut, and the ledger says so", () => {
    const fx = loadFixtures().find((f) => f.name === "basic")!;
    loadFixture(h.db, fx);
    refreshSegments(h.db, { now: new Date(fx.now), all: true });
    h.db.query("UPDATE run_segment SET active_s = 999999 WHERE terminator <> 'open'").run();
    const r = refreshSegments(h.db, { now: new Date(fx.now), all: true });
    // The corpus is REGENERABLE, not append-only: freezing a terminal row was what let a
    // stale partition survive a later OTEL fill (see the test below). What the doctrine
    // still forbids is moving it SILENTLY, so every restatement is an anomaly.
    expect(
      h.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM run_segment WHERE active_s = 999999",
        )
        .get()?.n,
    ).toBe(0);
    expect(r.recut).toBeGreaterThan(0);
    expect(r.anomalies.every((a) => a.kind === "segment_recut")).toBe(true);
    expect(r.anomalies[0]!.detail).toContain("RESTATED");
    // The detail carries the CLASS of the change, never the values: `insertAnomalies`
    // dedups on (kind, detail), and numbers in the key would write a row per sweep.
    expect(r.anomalies[0]!.detail).not.toContain("999999");
  });

  test("a late OTEL duration MERGES two segments: one row survives, not two overlapping ones", () => {
    // The exact shape the freeze doctrine got wrong. Three turns, and a request in the
    // 10:01–10:10 gap whose `duration_ms` has not arrived yet — so it contributes no
    // interval and the sweep cuts three segments.
    const session = "s-recut";
    const turn = h.db.prepare(
      `INSERT INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid)
       VALUES (?,?,?,?,NULL,NULL,NULL)`,
    );
    turn.run(session, "p0", "2026-03-01T10:00:00Z", 60_000);
    turn.run(session, "p1", "2026-03-01T10:10:00Z", 60_000);
    turn.run(session, "p2", "2026-03-01T11:00:00Z", 60_000);
    h.db
      .query(
        `INSERT INTO request (request_id, message_id, is_sidechain, session_id, prompt_id, origin,
                              agent_id, run_id, wf_launch_id, model, model_family,
                              attribution_agent, attribution_skill, ts,
                              in_tok, out_tok, cw_tok, cr_tok, duration_ms, tid, attr)
         VALUES ('rq-late','msg-late',0,?,NULL,'main',NULL,NULL,NULL,'claude-test-1','claude-test-1',
                 NULL,NULL,'2026-03-01T10:02:00Z',1,1,1,1,NULL,NULL,'none')`,
      )
      .run(session);

    const now = new Date("2026-03-01T11:30:00Z");
    expect(refreshSegments(h.db, { now, all: true }).segments).toBe(3);

    // `drainOtel`'s FILL_DURATION_SQL lands: the request now spans 10:02–10:11, which
    // closes the 10:01–10:10 gap and merges the first two segments into one.
    h.db.query("UPDATE request SET duration_ms = 540000 WHERE request_id = 'rq-late'").run();
    const r = refreshSegments(h.db, { now, all: true });

    const rows = h.db
      .query<{ started_at: string; ended_at: string }, []>(
        "SELECT started_at, ended_at FROM run_segment ORDER BY started_at",
      )
      .all();
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({
      started_at: "2026-03-01T10:00:00Z",
      ended_at: "2026-03-01T10:11:00Z",
    });
    expect(rows[1]!.started_at).toBe("2026-03-01T11:00:00Z");
    expect(r.removed).toBe(1);
    expect(r.anomalies.some((a) => a.detail.includes("REMOVED"))).toBe(true);

    // And the FITTING CORPUS is the thing that had to come out right. Before the fix
    // this was THREE observations — the merged 660 s span plus the two pre-OTEL cuts it
    // supersedes — so Kaplan–Meier saw 10:00–10:01 twice, once alone and once inside its
    // successor. (`v_eta_corpus.span_s` truncates a julianday difference, hence 59.)
    const lens = etaCorpus(h.db, 5)
      .map((o) => o.len_s)
      .sort((a, b) => a - b);
    expect(lens.length).toBe(2);
    expect(lens[1]).toBe(660);
  });

  /**
   * RETUNING `segment_gap_min` is an anticipated operation — schema.sql says the
   * constant "moves the estimand by ~10x" and that the retro fits it like every other
   * constant here — so the corpus has to survive it INTACT.
   *
   * It did not. With `(session_id, started_at)` as the primary key, a re-cut at a new
   * threshold collided with the frozen row cut at the old one and the upsert's
   * `WHERE terminator = 'open'` turned the collision into a silent no-op: the table kept
   * the stale partition, `etaCorpus`/`etaCorpusSize` filter on the threshold in force,
   * and the fit ran on whichever fraction of the corpus happened not to collide — with
   * two contradictory segmentations of the same wall-clock minute stored side by side.
   */
  test("retuning segment_gap_min rebuilds the WHOLE corpus at the new threshold", () => {
    // Identical inputs, two partitions: 2 segments at gap 5, 3 at gap 2.
    const fx = loadFixtures().find((f) => f.name === "gap-sensitivity")!;
    loadFixture(h.db, fx);
    const now = new Date(fx.now);

    h.db.query("UPDATE config SET v='5' WHERE k='segment_gap_min'").run();
    const first = refreshSegments(h.db, { now, all: true });
    expect(first.segments).toBe(2);
    expect(etaCorpusSize(h.db)).toBe(2);

    h.db.query("UPDATE config SET v='2' WHERE k='segment_gap_min'").run();
    const second = refreshSegments(h.db, { now, all: true });
    expect(second.segments).toBe(3);

    // EVERY segment the rebuild produced is in the corpus — not the 1 of 3 that
    // happened to miss a collision.
    expect(etaCorpusSize(h.db)).toBe(3);
    expect(etaCorpus(h.db, 2).length).toBe(3);
    // And the retired partition cannot leak into it: a corpus filtered by the threshold
    // in force never sees a row cut at another one.
    expect(
      h.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment WHERE gap_min = 2")
        .get()?.n,
    ).toBe(3);
    for (const o of etaCorpus(h.db, 2)) expect(o.len_s).toBeLessThan(120);
  });

  test("a segment OUTSIDE the recompute horizon is never removed — its inputs may be pruned", () => {
    // P2.10 prunes transcripts at 365 days and a segment outlives its inputs by design,
    // so silence from `loadIntervalIndex` past the horizon means "pruned", not "never
    // was". A re-cut that read it the other way would eat the corpus a week at a time.
    const session = "s-old";
    h.db
      .query(
        `INSERT INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid)
         VALUES (?, 'p0', '2026-03-01T10:00:00Z', 60000, NULL, NULL, NULL)`,
      )
      .run(session);
    h.db
      .query(
        `INSERT INTO run_segment (session_id, started_at, ended_at, active_s, busy_s, max_concurrency,
                                  n_turns, n_agents, gap_before_s, gap_after_s, terminator,
                                  interval_src_mix, gap_min, tid, first_seen, last_seen)
         VALUES (?, '2026-01-01T00:00:00Z', '2026-01-01T00:20:00Z', 1200, 1200, 1, 1, 0,
                 NULL, NULL, 'human_input', 'turn', 5, NULL,
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run(session);

    const r = refreshSegments(h.db, { now: new Date("2026-03-01T11:30:00Z"), all: true });
    expect(r.removed).toBe(0);
    expect(
      h.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM run_segment WHERE started_at = '2026-01-01T00:00:00Z'",
        )
        .get()?.n,
    ).toBe(1);
  });

  test("a FULL rebuild re-cuts an old segment whose inputs survive — the boundary rule is retroactive", () => {
    // The 2026-07-30 amendment changed WHERE segments are cut, so every stored cut is an
    // observation of a superseded estimand. An incremental sweep may not reach past its
    // horizon (a pruned input reads as silence, and silence must not be read as "this
    // segment never was"), but a full rebuild has to, or the fitting corpus is a mixture
    // of two definitions and Kaplan-Meier sees the same minute twice.
    const session = "s-hist";
    const turn = h.db.prepare(
      `INSERT INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid)
       VALUES (?,?,?,60000,NULL,NULL,NULL)`,
    );
    // Two exchanges four minutes apart: ONE segment under the gap rule alone (the gap is
    // under `segment_gap_min`), TWO once the prompt in that gap counts as a boundary.
    turn.run(session, "p0", "2026-01-05T10:00:00Z");
    turn.run(session, "p1", "2026-01-05T10:04:00Z");
    // The row the old rule would have written, well outside the recompute horizon.
    h.db
      .query(
        `INSERT INTO run_segment (session_id, started_at, ended_at, active_s, busy_s, max_concurrency,
                                  n_turns, n_agents, gap_before_s, gap_after_s, terminator,
                                  interval_src_mix, gap_min, tid, first_seen, last_seen)
         VALUES (?, '2026-01-05T10:00:00Z', '2026-01-05T10:05:00Z', 120, 120, 1, 2, 0,
                 NULL, NULL, 'human_input', 'turn', 5, NULL,
                 '2026-01-05T10:05:00Z', '2026-01-05T10:05:00Z')`,
      )
      .run(session);

    const now = new Date("2026-03-01T11:30:00Z");
    // The incremental path is still bounded: nothing here is inside seven days of `now`,
    // so it neither re-cuts nor removes.
    const incremental = refreshSegments(h.db, { now });
    expect(incremental.removed).toBe(0);

    const full = refreshSegments(h.db, { now, all: true });
    const rows = h.db
      .query<{ started_at: string; ended_at: string; n_turns: number }, [string]>(
        "SELECT started_at, ended_at, n_turns FROM run_segment WHERE session_id = ? ORDER BY started_at",
      )
      .all(session);
    expect(rows).toEqual([
      { started_at: "2026-01-05T10:00:00Z", ended_at: "2026-01-05T10:01:00Z", n_turns: 1 },
      { started_at: "2026-01-05T10:04:00Z", ended_at: "2026-01-05T10:05:00Z", n_turns: 1 },
    ]);
    // Restated, not silently: the corpus moved and the ledger says so.
    expect(full.recut).toBe(1);
    expect(full.anomalies.some((a) => a.detail.includes("RESTATED"))).toBe(true);
  });

  test("a re-cut is authoritative for ONE gap_min partition, never a retired one", () => {
    // `gap_min` is in the primary key because rows cut at two minutes and rows cut at
    // five are different observations of the same wall clock. A refresh at the threshold
    // in force therefore says nothing about the retired partition and must not delete
    // from it — the corpus for a threshold is retired by being ignored, never by being
    // silently eaten a session at a time.
    const fx = loadFixtures().find((f) => f.name === "basic")!;
    loadFixture(h.db, fx);
    h.db.query("UPDATE config SET v = '2' WHERE k = 'segment_gap_min'").run();
    const at2 = refreshSegments(h.db, { now: new Date(fx.now), all: true });
    expect(at2.segments).toBeGreaterThan(0);

    h.db.query("UPDATE config SET v = '5' WHERE k = 'segment_gap_min'").run();
    const at5 = refreshSegments(h.db, { now: new Date(fx.now), all: true });
    expect(at5.removed).toBe(0);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment WHERE gap_min = 2").get()
        ?.n,
    ).toBe(at2.segments);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment WHERE gap_min = 5").get()
        ?.n,
    ).toBe(at5.segments);
  });

  test("an OPEN segment is still mutable — silence is what closes it", () => {
    const fx = loadFixtures().find((f) => f.name === "otel-open")!;
    loadFixture(h.db, fx);
    refreshSegments(h.db, { now: new Date(fx.now), all: true });
    expect(
      h.db.query<{ t: string }, []>("SELECT terminator AS t FROM run_segment").get()?.t,
    ).toBe("open");
    // One hour later, nothing new: the same segment closes, and (with no live pid for a
    // synthetic session id) it closes as `session_end`.
    refreshSegments(h.db, { now: new Date("2026-03-01T11:25:00Z"), all: true });
    const rows = h.db.query<{ t: string }, []>("SELECT terminator AS t FROM run_segment").all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.t).toBe("session_end");
  });
});

// ---------------------------------------------------------------------------
// 3. the estimator: Kaplan–Meier, residual life, the three models
// ---------------------------------------------------------------------------

const obs = (len: number, censored = false, agents = 0): Observation => ({
  len_s: len,
  censored,
  n_agents: agents,
  max_concurrency: 1,
});

describe("Kaplan–Meier residual life", () => {
  test("with no censoring the curve is the empirical survival function", () => {
    const km = kaplanMeier([10, 20, 30, 40, 50].map((n) => obs(n)));
    expect(km.t).toEqual([10, 20, 30, 40, 50]);
    km.s.forEach((s, i) => expect(s).toBeCloseTo((4 - i) / 5, 10));
    expect(survivalAt(km, 0)).toBe(1);
    expect(survivalAt(km, 25)).toBeCloseTo(0.6, 10);
  });

  test("conditional residual quantiles condition on what has already elapsed", () => {
    const km = kaplanMeier([10, 20, 30, 40, 50].map((n) => obs(n)));
    // At t=0 the median residual is the first time survival drops to <= 0.5 → 30.
    expect(residualQuantile(km, 0, 0.5)).toEqual({ s: 30, extrapolated: false });
    // Having already run 20, S(20)=0.6, so the target is 0.3 → 40, i.e. 20 remaining.
    expect(residualQuantile(km, 20, 0.5)).toEqual({ s: 20, extrapolated: false });
    expect(residualQuantile(km, 20, 0.9)).toEqual({ s: 30, extrapolated: false });
  });

  test("open segments enter as right-censored observations, not as omissions", () => {
    // Dropping the long-running ones biases the estimator short exactly when it matters.
    const withCensoring = kaplanMeier([obs(10), obs(20, true), obs(30)]);
    expect(withCensoring.n).toBe(3);
    expect(withCensoring.n_censored).toBe(1);
    expect(withCensoring.s[0]).toBeCloseTo(2 / 3, 10);
    const dropped = kaplanMeier([obs(10), obs(30)]);
    expect(dropped.s[0]).toBeCloseTo(0.5, 10);
    expect(withCensoring.s[0]!).toBeGreaterThan(dropped.s[0]!);
  });

  test("beyond the observed support the fitted tail answers instead of refusing", () => {
    // One short death and one long censored run: the curve never reaches the p90
    // target inside its support, so the constant-hazard tail supplies the quantile.
    const km = kaplanMeier([obs(10), obs(100, true)]);
    expect(km.sLast).toBeCloseTo(0.5, 10);
    const r = residualQuantile(km, 0, 0.9)!;
    expect(r.extrapolated).toBe(true);
    // lambda = -ln(0.5)/100; u solves 0.5·exp(-lambda(u-100)) = 0.1.
    expect(r.s).toBeCloseTo(100 + Math.log(5) / (Math.log(2) / 100), 6);
  });

  test("a memoryless tail is monotone: p90 never lands under p50", () => {
    const fit = fitModels([obs(60), obs(120), obs(3600, true), obs(300)]);
    for (const t of [0, 100, 1000, 10_000, 100_000]) {
      const p = predictResidualLife(fit, t)!;
      expect(p.p90_s).toBeGreaterThanOrEqual(p.p50_s);
      expect(p.p50_s).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the three models", () => {
  const corpus = [obs(60), obs(120), obs(180), obs(600), obs(1200, false, 3), obs(2400, true, 4)];

  test("const_median is the floor and it is fitted on CLOSED segments only", () => {
    const fit = fitModels(corpus);
    // 2400 is censored — a lower bound — so it is not in the baseline's sample.
    expect(fit.closed).toEqual([60, 120, 180, 600, 1200]);
    expect(predictConstMedian(fit, 0)!.p50_s).toBe(180);
    // It is a countdown, floored at zero: that is exactly why it is easy to beat.
    expect(predictConstMedian(fit, 100)!.p50_s).toBe(80);
    expect(predictConstMedian(fit, 100_000)!.p50_s).toBe(0);
  });

  test("residual_life does NOT collapse to zero once elapsed passes the median", () => {
    const fit = fitModels(corpus);
    const cm = predictConstMedian(fit, 5000)!;
    const rl = predictResidualLife(fit, 5000)!;
    expect(cm.p50_s).toBe(0);
    // The floor says "any second now" forever; the conditional model says a run that
    // has already outlived the median has more left, which is the whole point.
    expect(rl.p50_s).toBeGreaterThan(0);
  });

  test("fanout_cond floors on remaining declared phases — a headless workflow cannot ask", () => {
    const fit = fitModels(corpus);
    const plain = predictFanoutCond(fit, 0, { live_agents: 0, wf_phases_left: 0, phase_median_s: 600 }, 5)!;
    const wf = predictFanoutCond(fit, 0, { live_agents: 0, wf_phases_left: 4, phase_median_s: 600 }, 5)!;
    expect(wf.p50_s).toBeGreaterThanOrEqual(4 * 600);
    expect(wf.p50_s).toBeGreaterThanOrEqual(plain.p50_s);
    expect(wf.p90_s).toBeGreaterThanOrEqual(wf.p50_s);
  });

  test("a stratum thinner than the fit floor falls back to the pooled curve", () => {
    const fit = fitModels(corpus);
    expect(stratumOf(0)).toBe("solo");
    expect(stratumOf(2)).toBe("small");
    expect(stratumOf(9)).toBe("large");
    // `large` holds one observation against a floor of 5, so this must equal the
    // pooled residual-life answer rather than a curve fitted on a single point.
    const pooled = predictResidualLife(fit, 0)!;
    const cond = predictFanoutCond(fit, 0, { live_agents: 9, wf_phases_left: 0, phase_median_s: null }, 5)!;
    expect(cond.p50_s).toBe(pooled.p50_s);
  });
});

describe("scoring and probation", () => {
  test("a thin corpus scores nothing and keeps every model on probation", () => {
    const scores = scoreEtaModels(h.db);
    expect(scores.map((s) => s.eta_model).sort()).toEqual(["const_median", "fanout_cond", "residual_life"]);
    for (const s of scores) {
      expect(s.pinball_p50).toBeNull();
      expect(s.won).toBe(false);
      expect(s.probation).toBe(true);
    }
  });

  test("probation needs all three of: enough segments, a real gain, and p90 coverage", () => {
    seedSegments(h.db, 40);
    const scores = scoreEtaModels(h.db);
    const rl = scores.find((s) => s.eta_model === "residual_life")!;
    expect(rl.n_seg).toBe(40);
    expect(rl.pinball_p50).not.toBeNull();
    expect(rl.baseline_pinball_p50).toBeGreaterThan(0);
    // const_median is never shipped, whatever it scores.
    expect(scores.find((s) => s.eta_model === "const_median")!.won).toBe(false);
    // Whatever the verdict, probation may only be off if every leg holds.
    for (const s of scores) {
      if (!s.probation) {
        expect(s.won).toBe(true);
        expect(s.n_seg).toBeGreaterThanOrEqual(30);
        expect(s.cov_lo).toBeLessThanOrEqual(0.9);
        expect(s.cov_hi).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  test("only the LATEST retro decides which model ships", () => {
    // A candidate that won once must not keep the crown after a later retro takes it
    // away: "the candidate issues bands only WHILE it beats the default" is present
    // tense, and `eta_run` is append-only, so the old winning row is still sitting there.
    seedSegments(h.db, 12);
    const scores = scoreEtaModels(h.db);
    const win = (model: string, won: boolean, probation: boolean, asOf: string): void => {
      writeEtaRuns(
        h.db,
        scores.map((s) => (s.eta_model === model ? { ...s, won, probation } : { ...s, won: false })),
        new Date(asOf),
      );
    };
    win("fanout_cond", true, false, "2026-03-01T00:00:00Z");
    expect(buildEtaFit(h.db).shipped).toBe("fanout_cond");
    expect(buildEtaFit(h.db).probation).toBe(false);

    win("residual_life", true, true, "2026-03-08T00:00:00Z");
    const fit = buildEtaFit(h.db);
    expect(fit.shipped).toBe("residual_life");
    expect(fit.probation).toBe(true);
  });

  /**
   * `est retro --as-of <iso>` exists to REPLAY a scoring as it would have gone at that
   * instant. For a while `scoreEtaModels` accepted the option and dropped it on the
   * floor (`void opts;`), scoring the whole table — so the one caller that passes it,
   * `src/retro.ts`'s injected-clock path, reported a number that depended on segments
   * recorded after the instant it claimed to be reporting from. That is not a replay,
   * and nothing would have caught it: every other call site omits the option.
   */
  test("--as-of BOUNDS the corpus rather than decorating the call", () => {
    // 12 segments, one per day from 2026-01-01. `seedSegments` starts them at UTC
    // midnight, so a cut after the 6th leaves exactly 6 behind it.
    seedSegments(h.db, 12);
    expect(scoreEtaModels(h.db).find((s) => s.eta_model === "residual_life")!.n_seg).toBe(12);

    const asOf = new Date("2026-01-06T12:00:00Z");
    const bounded = scoreEtaModels(h.db, { asOf }).find((s) => s.eta_model === "residual_life")!;
    expect(bounded.n_seg).toBe(6);
    // A whole-table score and a bounded one must actually DIFFER, or the assertion
    // above would pass on a function that still ignored the option.
    expect(bounded.pinball_p50).not.toBe(
      scoreEtaModels(h.db).find((s) => s.eta_model === "residual_life")!.pinball_p50,
    );
  });

  test("--as-of after every segment scores exactly what an unbounded call does", () => {
    seedSegments(h.db, 12);
    const all = scoreEtaModels(h.db);
    const late = scoreEtaModels(h.db, { asOf: new Date("2030-01-01T00:00:00Z") });
    expect(late).toEqual(all);
  });

  test("eta_run is append-only", () => {
    seedSegments(h.db, 12);
    expect(writeEtaRuns(h.db, scoreEtaModels(h.db), new Date("2026-03-02T00:00:00Z"))).toBe(3);
    expect(() => h.db.query("UPDATE eta_run SET won = 1").run()).toThrow(/append-only/);
    expect(() => h.db.query("DELETE FROM eta_run").run()).toThrow(/append-only/);
  });
});

/** `n` closed segments of increasing length plus one open one, at the seeded gap. */
function seedSegments(db: Database, n: number, gapMin = 5): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO run_segment (session_id, started_at, ended_at, active_s, busy_s, max_concurrency,
                                         n_turns, n_agents, gap_before_s, gap_after_s, terminator,
                                         interval_src_mix, gap_min, tid, first_seen, last_seen)
     VALUES (?,?,?,?,?,1,1,?, NULL, NULL, ?, 'turn', ?, NULL, '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
  );
  for (let i = 0; i < n; i += 1) {
    const start = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000);
    const lenS = 300 + i * 120;
    stmt.run(
      `s-seed-${gapMin}-${i}`,
      start.toISOString(),
      new Date(start.getTime() + lenS * 1000).toISOString(),
      lenS,
      lenS,
      i % 4,
      "human_input",
      gapMin,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. THE INVARIANT — never token-derived
// ---------------------------------------------------------------------------

describe("check_back is never token-derived — the P2.1 invariant", () => {
  test("×10 every token counter and every check-back number is bit-identical", async () => {
    const fx = loadFixtures().find((f) => f.name === "otel-open")!;
    const now = new Date(fx.now);

    const run = async (scale: number): Promise<{ payload: BurnActive; segs: string }> => {
      const g = makeHarness("est-eta-inv-");
      try {
        seedPrices(g.db);
        loadFixture(g.db, fx, scale);
        seedSegments(g.db, 20);
        const r = await g.cli(...openArgs({ subject: `invariant ${scale}` }), "--session", fx.session, "--json");
        expect(r.code).toBe(0);
        const tid = r.json<{ tid: string }>().tid;
        g.db.query("UPDATE request SET tid = ? WHERE session_id = ?").run(tid, fx.session);
        refreshSegments(g.db, { now, all: true });
        refreshBurnCache(g.db, now);
        const payload = burnJson(g.db, { tid, now }) as BurnActive;
        // `tid` is a uuidv7 minted per run, so it is nulled out: it is a task IDENTITY,
        // not a time quantity, and comparing it would fail for a reason the invariant
        // is not about.
        const segs = JSON.stringify(
          segmentsReport(g.db, { session: fx.session, now }).segments.map((r) => ({ ...r, tid: null })),
        );
        return { payload, segs };
      } finally {
        g.close();
      }
    };

    const one = await run(1);
    const ten = await run(10);

    // The premise: scaling the counters DID move the token numbers. Without this the
    // assertion below would pass on two identical corpora and prove nothing.
    expect(ten.payload.wcet.consumed).toBe(one.payload.wcet.consumed * 10);

    expect(ten.payload.check_back).toEqual(one.payload.check_back);
    expect(ten.payload.check_back).not.toBeNull();
    expect(ten.segs).toBe(one.segs);
    // The converse is explicitly NOT required: a segment with zero attributed tokens
    // still has a length, which the `compute` clock below is free to disagree about.
    expect(ten.payload.compute).toEqual(one.payload.compute);
  });

  test("src/eta.ts names no token counter anywhere", () => {
    // A grep, deliberately: the invariant above catches a wrong NUMBER, and this
    // catches the wrong DEPENDENCY arriving before it has had a chance to be wrong.
    const src = readFileSync(join(import.meta.dir, "..", "src", "eta.ts"), "utf8");
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["out_tok", "cw_tok", "cr_tok", "in_tok", "wcet", "usd", "consumed", "burn_"]) {
      expect({ forbidden, found: code.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. the payload and the segment
// ---------------------------------------------------------------------------

async function liveTask(g: Harness, session: string, now: Date): Promise<string> {
  const r = await g.cli(...openArgs(), "--session", session, "--json");
  expect(r.code).toBe(0);
  const tid = r.json<{ tid: string }>().tid;
  // What the attribution pass would have done on the next sweep.
  g.db.query("UPDATE request SET tid = ? WHERE session_id = ?").run(tid, session);
  refreshSegments(g.db, { now, all: true });
  refreshBurnCache(g.db, now);
  return tid;
}

describe("est burn --json — the check_back fields (P2.2)", () => {
  test("a well-formed band, session-scoped, with its model and its probation flag", async () => {
    const fx = loadFixtures().find((f) => f.name === "otel-open")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    seedSegments(h.db, 20);
    const tid = await liveTask(h, fx.session, now);
    const b = burnJson(h.db, { tid, now }) as BurnActive;

    expect(b.schema).toBe(1);
    const cb = band(b.check_back);
    expect(cb.basis).toBe("session");
    expect(cb.eta_model).toBe("residual_life");
    expect(cb.probation).toBe(true);
    expect(cb.seg_started_at).toBe("2026-03-01T10:20:00Z");
    expect(cb.seg_elapsed_min).toBe(5);
    expect(cb.p50_min).toBeGreaterThanOrEqual(0);
    expect(cb.p90_min).toBeGreaterThanOrEqual(cb.p50_min);
    expect(cb.n_seg).toBe(20);
    // `compute` always travels WITH its coverage: a compute figure without one is a
    // number whose denominator moved.
    expect(b.compute.s).toBe(150);
    expect(b.compute.coverage_pct).toBe(100);
  });

  test("null — not absent, not zero — when the session has no open segment", async () => {
    // `trailing-prompt`: the segment closed at the prompt, and the turn that prompt
    // opened has no `turn_duration` yet, so nothing is observable. NOT the idle case —
    // the newest turn is open, so `waitingOnInput` is false and this stays the enumerated
    // `null`: "something is running and we cannot yet say for how long".
    const fx = loadFixtures().find((f) => f.name === "trailing-prompt")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    seedSegments(h.db, 20);
    const tid = await liveTask(h, fx.session, now);
    const b = burnJson(h.db, { tid, now }) as BurnActive;
    expect("check_back" in b).toBe(true);
    expect(b.check_back).toBeNull();
  });

  test("null while the corpus is thinner than eta_min_fit", async () => {
    const fx = loadFixtures().find((f) => f.name === "otel-open")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    const tid = await liveTask(h, fx.session, now);
    // The only closed segments are the fixture's own — far under the floor of 5.
    expect((burnJson(h.db, { tid, now }) as BurnActive).check_back).toBeNull();
    seedSegments(h.db, 20);
    refreshBurnCache(h.db, now);
    expect((burnJson(h.db, { tid, now }) as BurnActive).check_back).not.toBeNull();
  });

  test("seg_elapsed is measured from the PROMPT, not from the streak it interrupted", async () => {
    // `prompt-boundary`: activity 10:00-10:03, prompt at 10:04, `now` 10:06. The gap rule
    // alone would have reported one segment running since 10:00 — six minutes of
    // 'elapsed' that includes a previous exchange — and conditioned the residual-life
    // quantile on it.
    const fx = loadFixtures().find((f) => f.name === "prompt-boundary")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    seedSegments(h.db, 20);
    const tid = await liveTask(h, fx.session, now);
    const cb = band((burnJson(h.db, { tid, now }) as BurnActive).check_back);
    expect(cb.seg_started_at).toBe("2026-03-01T10:04:00Z");
    expect(cb.seg_elapsed_min).toBe(2);
    // And the session is busy for a REASON the payload can also be asked about: a2 is
    // still running, which is why this is a forecast and not `waiting_on_input`.
    expect(waitingOnInput(h.db, fx.session)).toBe(false);
  });

  test("a delegation spanning the prompt keeps ONE segment, and it is still forecast", async () => {
    // The exception, end to end. The prompt at 10:10 landed inside a running agent, so it
    // is not a boundary: the forecast is issued against the segment that started at 10:00,
    // BEFORE the last prompt, and that is the correct answer rather than a leftover of the
    // old rule — Claude was not blocked on Craig at 10:10 and is not blocked now.
    const fx = loadFixtures().find((f) => f.name === "delegation-spans-prompt")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    // A second delegation, launched as the first returned and still running at `now`, so
    // the session is busy. Live agents carry no `ended_at` and so contribute no interval:
    // this changes what is forecast, never how the corpus is cut.
    h.db
      .query(
        `INSERT INTO agent_run (agent_id, session_id, run_id, wf_launch_id, agent_type, spawn_depth,
                                launch_prompt_id, transcript_path, status, label, started_at, ended_at,
                                interval_src, queued_at, attempt, reported_tokens, phase_idx,
                                phase_title, phase_conf, tid)
         VALUES ('a2',?,NULL,NULL,'general-purpose',1,NULL,NULL,'running',NULL,
                 '2026-03-01T10:20:30Z',NULL,'transcript',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
      )
      .run(fx.session);
    seedSegments(h.db, 20);
    const tid = await liveTask(h, fx.session, now);

    expect(
      h.db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM run_segment WHERE session_id = ?",
      ).get(fx.session)?.n,
    ).toBe(1);
    const cb = band((burnJson(h.db, { tid, now }) as BurnActive).check_back);
    expect(cb.seg_started_at).toBe("2026-03-01T10:00:00Z");
    expect(cb.seg_elapsed_min).toBe(22);

    // And the two halves compose: retire the delegation without touching the corpus, and
    // the SAME open segment stops being forecast at all. The boundary rule decides where
    // the corpus is cut; suppression decides whether anything is issued against it.
    h.db.query("DELETE FROM agent_run WHERE agent_id = 'a2'").run();
    refreshBurnCache(h.db, now);
    expect((burnJson(h.db, { tid, now }) as BurnActive).check_back).toEqual({
      waiting_on_input: true,
    });
  });

  test("an idle session says waiting_on_input instead of forecasting", async () => {
    // `basic`: every turn closed, no agent live, no workflow — Craig is the only thing
    // that can move this session, and a residual-life quantile issued over it is the
    // 4.6-hour forecast that started all this.
    const fx = loadFixtures().find((f) => f.name === "basic")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    seedSegments(h.db, 20);
    const tid = await liveTask(h, fx.session, now);
    const b = burnJson(h.db, { tid, now }) as BurnActive;
    expect(b.check_back).toEqual({ waiting_on_input: true });
    // Suppression is a REPLACEMENT, not a blanking: the task's own numbers are untouched.
    expect(b.active).toBe(true);
    expect(b.wcet.pct_p50).toBeGreaterThanOrEqual(0);
    // And no suppressed forecast is left in the columns for a careless reader to find.
    const row = h.db
      .query<{ p50: number | null; seg: string | null; flag: number | null }, [string]>(
        `SELECT check_back_p50_s AS p50, seg_started_at AS seg, eta_waiting_on_input AS flag
           FROM burn_cache WHERE tid = ?`,
      )
      .get(tid);
    expect(row).toEqual({ p50: null, seg: null, flag: 1 });
    // The cached and live paths agree about it, like they do about a band.
    expect((burnJson(h.db, { tid, now, refresh: true }) as BurnActive).check_back).toEqual({
      waiting_on_input: true,
    });
  });

  test("a live agent, an open workflow or an open turn each keep the forecast alive", async () => {
    // The three conditions of `waitingOnInput`, one at a time, over the SAME idle session.
    const fx = loadFixtures().find((f) => f.name === "basic")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    seedSegments(h.db, 20);
    const tid = await liveTask(h, fx.session, now);
    expect(waitingOnInput(h.db, fx.session)).toBe(true);

    // 1. an agent that started and has not ended. It contributes NO interval (the union
    //    needs both bounds), so this is not the same fact as "the segment is still open".
    h.db
      .query(
        `INSERT INTO agent_run (agent_id, session_id, run_id, wf_launch_id, agent_type, spawn_depth,
                                launch_prompt_id, transcript_path, status, label, started_at, ended_at,
                                interval_src, queued_at, attempt, reported_tokens, phase_idx,
                                phase_title, phase_conf, tid)
         VALUES ('ag-live',?,NULL,NULL,'general-purpose',1,NULL,NULL,'running',NULL,
                 '2026-03-01T11:30:00Z',NULL,'transcript',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
      )
      .run(fx.session);
    expect(waitingOnInput(h.db, fx.session)).toBe(false);
    h.db.query("DELETE FROM agent_run WHERE agent_id = 'ag-live'").run();
    expect(waitingOnInput(h.db, fx.session)).toBe(true);

    // 2. a workflow run with no ended_at — and with NO declared phase count, which is
    //    exactly the case `liveFeatures.wf_phases_left > 0` would have missed.
    h.db
      .query(
        `INSERT INTO workflow_run (run_id, wf_launch_id, session_id, workflow_name, transcript_dir,
                                   default_model, launch_prompt_id, n_phases_planned,
                                   started_at, ended_at, tid)
         VALUES ('wf-1','wl-1',?,'w',NULL,NULL,NULL,NULL,'2026-03-01T11:30:00Z',NULL,NULL)`,
      )
      .run(fx.session);
    expect(waitingOnInput(h.db, fx.session)).toBe(false);
    h.db.query("DELETE FROM workflow_run WHERE run_id = 'wf-1'").run();
    expect(waitingOnInput(h.db, fx.session)).toBe(true);

    // 3. a newest turn with no `turn_duration` record: the main chain has not handed
    //    control back. Conservative in the safe direction — 27% of turns never get one,
    //    so this errs towards forecasting rather than towards a false "awaiting input".
    h.db
      .query(
        `INSERT INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid)
         VALUES (?, 'p-open', '2026-03-01T11:45:00Z', NULL, NULL, NULL, NULL)`,
      )
      .run(fx.session);
    expect(waitingOnInput(h.db, fx.session)).toBe(false);
  });

  test("the cached and the --refresh paths agree", async () => {
    const fx = loadFixtures().find((f) => f.name === "otel-open")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    seedSegments(h.db, 20);
    const tid = await liveTask(h, fx.session, now);
    const cached = (burnJson(h.db, { tid, now }) as BurnActive).check_back!;
    const live = (burnJson(h.db, { tid, now, refresh: true }) as BurnActive).check_back!;
    expect(live).toEqual(cached);
  });

  test("`est burn`'s human output carries p90 and says what probation means", async () => {
    const fx = loadFixtures().find((f) => f.name === "otel-open")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    seedSegments(h.db, 20);
    const tid = await liveTask(h, fx.session, now);
    const text = renderBurn(burnJson(h.db, { tid, now }));
    expect(text).toContain("check back");
    expect(text).toContain("p90");
    expect(text).toContain("PROBATION");
    expect(text).toContain("never token-derived");
  });

  test("the P1.9 empty result is untouched — no check_back key at all", () => {
    const b = burnRead(join(h.dir, "does-not-exist.db"));
    expect(b.active).toBe(false);
    expect("check_back" in b).toBe(false);
  });
});

describe("the statusline segment — P2.2", () => {
  const base: BurnActive = {
    schema: 1,
    active: true,
    as_of: "2026-03-01T10:25:00.000Z",
    stale_s: 1,
    tid: "t-1",
    target: "session",
    subject: "widget pipeline rewrite",
    kind: "implement",
    status: "in_progress",
    wcet: { consumed: 340_000, p50: 512_000, p90: 900_000, pct_p50: 66, pct_p90: 37 },
    split: { main: 1, sub: 1, aux: 0 },
    requests: { n: 5, p50: null, p90: null },
    agents: { live: 2, total: 3 },
    time: { active_s: 100, p50_s: null, p90_s: null },
    burn: { wcet_per_min: 1, usd_per_hour: 1, window_min: 300 },
    projection: { total_wcet: 1, total_usd: 1, minutes_to_p90: null, method: "linear", crude: true },
    band: {
      eid: 1,
      reason: "initial",
      uncalibrated: false,
      ref_model: "claude-sonnet-4-5",
      estimand: "work_cet",
      price_epoch: "2026-01-01T00:00:00Z",
      refclass_as_of: null,
    },
    unvalidated: true,
    check_back: {
      p50_min: 57,
      p90_min: 214,
      seg_started_at: "2026-03-01T10:00:00.000Z",
      seg_elapsed_min: 23,
      eta_model: "residual_life",
      n_seg: 137,
      probation: true,
      basis: "session",
    },
    compute: { s: 1840, coverage_pct: 73.2 },
    warn: [],
  };

  test("renders the spec's line, with the probation `?` and WITHOUT p90", () => {
    const out = formatSegment(base);
    expect(out).toBe("task 340k/512k WCET · 66% p50 · 2 agents · check back ~57m? [unvalidated]");
    expect(out).not.toContain("214");
  });

  test("the `?` comes off only when the model is off probation", () => {
    const out = formatSegment({ ...base, check_back: { ...band(base.check_back), probation: false } });
    expect(out).toContain("check back ~57m ");
    expect(out).not.toContain("~57m?");
  });

  test("`?` and [unvalidated] are independent markers", () => {
    // Money and time are validated by different evidence; one certifying the other is
    // how a system talks itself into trusting a number nobody checked.
    const out = formatSegment({ ...base, unvalidated: false });
    expect(out).toContain("check back ~57m?");
    expect(out).not.toContain("[unvalidated]");
  });

  test("a guessed target or a stale row blanks the whole segment, ETA included", () => {
    expect(formatSegment({ ...base, target: "fallback" })).toBe("");
    expect(formatSegment({ ...base, warn: ["stale"] })).toBe("");
  });

  test("no forecast means no ETA text, not a zero", () => {
    const out = formatSegment({ ...base, check_back: null });
    expect(out).not.toContain("check back");
    expect(out).toContain("66% p50");
  });

  test("an idle session renders `awaiting input` in place of the ETA, and keeps the rest", () => {
    // The half of the 2026-07-30 fix Craig sees. THREE things are being pinned at once,
    // and the third is the one a careless implementation gets wrong:
    //   1. the words are there instead of a number;
    //   2. no forecast leaks — no "check back", no minutes, no probation `?`;
    //   3. the SEGMENT SURVIVES. P1.9 blanks the line for numbers that are WRONG
    //      (someone else's task, a stale row). An idle session makes exactly one number
    //      unavailable, and taking the burn percentage down with it would be a worse
    //      answer than the one being replaced.
    const out = formatSegment({ ...base, check_back: { waiting_on_input: true } });
    expect(out).toBe("task 340k/512k WCET · 66% p50 · 2 agents · ⏸ awaiting input [unvalidated]");
    expect(out).not.toContain("check back");
    expect(out).not.toContain("57");
    expect(out).not.toContain("?");
  });

  test("waiting still yields to the two P1.9 refusals", () => {
    // "Awaiting input" about a task nobody bound to this session, or out of a row that is
    // minutes stale, is as wrong as a forecast would have been. Suppression replaces the
    // ETA; it does not promote the payload past the refusals above it.
    const waiting = { waiting_on_input: true } as const;
    expect(formatSegment({ ...base, check_back: waiting, target: "fallback" })).toBe("");
    expect(formatSegment({ ...base, check_back: waiting, warn: ["stale"] })).toBe("");
  });

  test("`est burn`'s human output says why there is no forecast, and offers no number", () => {
    const text = renderBurn({ ...base, check_back: { waiting_on_input: true } });
    expect(text).toContain("awaiting input");
    expect(text).toContain("blocked on you");
    // Not a band, not a countdown, and above all not "waiting since <time>": that would
    // be the availability model §7.3 descoped, arrived at by the back door.
    expect(text).not.toContain("p90 ");
    expect(text).not.toContain("PROBATION");
  });

  test("rounding: minutes under 90, hours above, and never seconds", () => {
    expect(formatEta(0)).toBe("<1m");
    expect(formatEta(0.4)).toBe("<1m");
    expect(formatEta(57)).toBe("~57m");
    expect(formatEta(89)).toBe("~89m");
    expect(formatEta(90)).toBe("~1.5h");
    expect(formatEta(214)).toBe("~3.6h");
  });

  test("a payload from an older binary (no check_back key) still renders", () => {
    // P2.0's additive rule read from the consumer's side: the statusline tolerates a
    // missing field rather than throwing into Craig's prompt.
    const legacy = { ...base } as Partial<BurnActive>;
    delete legacy.check_back;
    expect(formatSegment(legacy as BurnActive)).toBe(
      "task 340k/512k WCET · 66% p50 · 2 agents [unvalidated]",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. `est segments`, and the read budget
// ---------------------------------------------------------------------------

describe("est segments — the tuning surface", () => {
  test("--gap recomputes at another threshold and persists nothing", async () => {
    const fx = loadFixtures().find((f) => f.name === "gap-sensitivity")!;
    loadFixture(h.db, fx);
    const now = new Date(fx.now);
    refreshSegments(h.db, { now, all: true });
    const persisted = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment").get()?.n;
    expect(persisted).toBe(2);

    const recomputed = segmentsReport(h.db, { session: fx.session, gap: 2, now });
    expect(recomputed.recomputed).toBe(true);
    expect(recomputed.n).toBe(3);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment").get()?.n).toBe(persisted!);
  });

  test("reads only segments cut at the threshold in force", () => {
    seedSegments(h.db, 6, 5);
    seedSegments(h.db, 4, 30);
    // Mixing rows cut at different thresholds is the same category error as averaging
    // across two estimands: the p50 moves ~10x between them.
    expect(segmentsReport(h.db, {}).n).toBe(6);
  });

  test("an empty corpus is a well-formed answer", async () => {
    const r = await h.cli("segments", "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ n: number; segments: unknown[] }>().n).toBe(0);
    const human = await h.cli("segments");
    expect(human.code).toBe(0);
  });

  test("the verb takes no lock and writes nothing", async () => {
    seedSegments(h.db, 3);
    const before = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment").get()?.n;
    const r = await h.cli("segments", "--limit", "2");
    expect(r.code).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment").get()?.n).toBe(before!);
  });
});

describe("the write path scales with the corpus, not with its square", () => {
  test("a whole-corpus rebuild reads each interval source once, not once per session", () => {
    // The shapes this guards against, both of which read naturally and were both
    // present in the first draft: four queries PER SESSION (and `agent_run` carries no
    // index on `session_id`), and a Kaplan–Meier estimator that filtered the sample
    // once per event time — quadratic inside a leave-one-out loop, i.e. a cubic retro.
    const t = h.db.prepare(
      `INSERT INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid)
       VALUES (?,?,?,90000,NULL,NULL,NULL)`,
    );
    const a = h.db.prepare(
      `INSERT INTO agent_run (agent_id, session_id, run_id, wf_launch_id, agent_type, spawn_depth,
                              launch_prompt_id, transcript_path, status, label, started_at, ended_at,
                              interval_src, queued_at, attempt, reported_tokens, phase_idx, phase_title,
                              phase_conf, tid)
       VALUES (?,?,NULL,NULL,'general-purpose',1,NULL,NULL,'completed',NULL,?,?,'transcript',
               NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
    );
    h.db
      .transaction(() => {
        for (let s = 0; s < 250; s += 1) {
          const base = Date.UTC(2025, 0, 1) + s * 7 * 3600_000;
          for (let i = 0; i < 6; i += 1) {
            const at = base + i * 11 * 60_000;
            t.run(`sx-${s}`, `p${i}`, new Date(at).toISOString());
            if (i % 3 === 0) {
              a.run(
                `ag-${s}-${i}`,
                `sx-${s}`,
                new Date(at + 1000).toISOString(),
                new Date(at + 400_000).toISOString(),
              );
            }
          }
        }
      })
      .immediate();

    const now = new Date("2026-03-01T00:00:00Z");
    const t0 = performance.now();
    const r = h.db.transaction(() => refreshSegments(h.db, { now, all: true })).immediate();
    const rebuildMs = performance.now() - t0;
    expect(r.sessions).toBe(250);
    // SIX per session, one per turn, not the four the gap rule alone produced. Each
    // session's turns are 11 minutes apart and two of the six launch an agent that runs
    // 6.7 minutes, leaving a 4.3-minute gap that `segment_gap_min = 5` used to bridge —
    // and a prompt sits in both of those gaps, so the boundary rule cuts them. This
    // number moving is the corpus-wide effect of the 2026-07-30 amendment: what used to
    // be one observation per activity streak is now one per prompt-to-boundary span.
    expect(r.segments).toBe(1500);

    const t1 = performance.now();
    const scores = scoreEtaModels(h.db);
    const scoreMs = performance.now() - t1;
    expect(scores.find((s) => s.eta_model === "residual_life")!.n_seg).toBe(1500);

    // Generous ceilings: these are regression guards on the SHAPE of the cost, not
    // benchmarks. The quadratic forms they replaced were seconds, not milliseconds.
    expect(rebuildMs).toBeLessThan(2000);
    expect(scoreMs).toBeLessThan(4000);

    // And the incremental path revisits nothing when nothing moved.
    const again = h.db
      .transaction(() => refreshSegments(h.db, { now: new Date("2026-03-01T00:10:00Z") }))
      .immediate();
    expect(again.sessions).toBe(0);
  });

  test("fanout_cond can beat the default when structure really does predict length", () => {
    // Two populations that differ only structurally: solo segments run short, segments
    // with agents run long. This is the case the candidate model exists for, and if it
    // cannot win HERE the conditioning is wired wrong.
    const stmt = h.db.prepare(
      `INSERT INTO run_segment (session_id, started_at, ended_at, active_s, busy_s, max_concurrency,
                                n_turns, n_agents, gap_before_s, gap_after_s, terminator,
                                interval_src_mix, gap_min, tid, first_seen, last_seen)
       VALUES (?,?,?,?,?,1,1,?,NULL,NULL,'human_input','turn',5,NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );
    for (let i = 0; i < 60; i += 1) {
      const agents = i % 2 === 0 ? 0 : 3;
      const lenS = agents === 0 ? 120 + (i % 5) : 3600 + (i % 5);
      const start = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000);
      stmt.run(
        `s-fan-${i}`,
        start.toISOString(),
        new Date(start.getTime() + lenS * 1000).toISOString(),
        lenS,
        lenS,
        agents,
      );
    }
    const scores = scoreEtaModels(h.db);
    const fan = scores.find((s) => s.eta_model === "fanout_cond")!;
    const rl = scores.find((s) => s.eta_model === "residual_life")!;
    expect(fan.pinball_p50!).toBeLessThan(rl.pinball_p50!);
    expect(fan.won).toBe(true);
  });
});

describe("the read budget — P1.9 is not renegotiated by P2.2", () => {
  test("the cached read stays bounded by the row, not by the segment corpus", async () => {
    const fx = loadFixtures().find((f) => f.name === "otel-open")!;
    const now = new Date(fx.now);
    loadFixture(h.db, fx);
    // Two years of segments at the observed rate, so a linear scan would be visible.
    seedSegments(h.db, 800);
    const tid = await liveTask(h, fx.session, now);

    for (let i = 0; i < 5; i += 1) burnRead(h.dbPath, { tid, now });
    const runs: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const t0 = performance.now();
      const b = burnRead(h.dbPath, { tid, now }) as BurnActive;
      runs.push(performance.now() - t0);
      expect(b.active).toBe(true);
    }
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)]!;
    // The statusline's whole budget is ~50 ms including bun's own startup, so the
    // read itself has to be an order of magnitude under it. This is a REGRESSION
    // guard, not a benchmark: the failure it exists to catch is someone computing a
    // residual-life quantile per render.
    expect(median).toBeLessThan(20);
  });
});

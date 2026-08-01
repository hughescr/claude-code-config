/**
 * Story points as the estimand (schema v15).
 *
 * The switch Craig is making is small in code and total in meaning: agents stop
 * predicting an absolute token quantity (Work-CET — 61.9× cross-model spread, with
 * repeated silent 1000× outliers) and start predicting a RELATIVE size against a fixed
 * anchor (1.96× when they decompose first). The actual never changes: it is always
 * log-derived Work-CET.
 *
 * Four properties carry the whole design, and every test here is one of them:
 *
 *  1. **The flip segregates, it does not delete.** `estimand` is already a calibration
 *     key everywhere — `estimate.estimand`, `refclass`'s primary key, `v_velocity`'s
 *     projection, every consumer's filter — so `est config set estimand story_point`
 *     puts the new corpus in its own reference class and leaves the old one intact and
 *     readable. The one place that was NOT already true is `v_task_actual_epoch`,
 *     whose `CASE e.estimand` would have fallen through to NULL and quietly dropped
 *     every completed story-point task out of `v_velocity` forever.
 *  2. **The anchor is pinned.** "8 points" is meaningless without knowing what one
 *     point was defined to be, so `estimate.sp_anchor_id` records it per row and a
 *     later anchor edit cannot redenominate history.
 *  3. **A rate is never invented.** `pointsToWcet` returns `rate: null` rather than
 *     falling back to 1.0, and `est open` then prints no Work-CET and no Spend-CET
 *     figure at all.
 *  4. **A Work-CET number typed under points is refused.** `estimate` is append-only,
 *     so a 2,400,000-point row could never be corrected — it would drag the bucket's
 *     fitted rate three orders of magnitude off, permanently.
 *
 * Fixtures are synthetic throughout (`test/support.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, openArgs, REF_MODEL, request, seedPrices, turn, type Harness } from "./support.ts";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db.ts";
import {
  COLD_START_N,
  isPointsEstimand,
  maxPoints,
  POINTS_ESTIMAND,
  pointsToWcet,
  storyPointAnchor,
} from "../src/tasks.ts";
import { attributeTasks } from "../src/attribute.ts";
import { bandUnit, type BandUnitRow, type PointsRateResolver } from "../src/burn.ts";
import { retro } from "../src/retro.ts";

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-story-points-");
  seedPrices(h.db);
  turn(h.db, { session: "s1", prompt: "p1", at: "2026-01-01T00:00:00Z" });
});

afterEach(() => {
  h.close();
});

/** Throw the switch, exactly as Craig will. */
function flipToPoints(): void {
  h.db.query("UPDATE config SET v = ? WHERE k = 'estimand'").run(POINTS_ESTIMAND);
}

/**
 * Bump the anchor the way a user has to since v19: the id SELECTS a definition and the
 * text STATES it, and `est open` refuses a points band in the gap between the two. Tests
 * that issue a band after a bump therefore state the definition; the ones that only ask
 * `pointsToWcet` a question leave the id dangling on purpose, because "no definition
 * recorded" is a legal state for a config key and an illegal one for a band.
 */
async function bumpAnchor(id: string, text: string): Promise<void> {
  expect((await h.cli("config", "set", "sp_anchor_id", id)).code).toBe(0);
  expect((await h.cli("config", "set", "sp_anchor_text", text)).code).toBe(0);
}

const KEY = {
  bucket: "global",
  estimatorFamily: "unknown",
  refModel: REF_MODEL,
  estimand: POINTS_ESTIMAND,
};

/**
 * One completed task, sized `p50` in whatever the estimand currently is, that really
 * consumed `wcet` Work-CET. `seedPrices` makes `usd_out = 1` for both families, so
 * `out_tok` IS the Work-CET figure and an assertion can state the ratio directly.
 */
async function completed(
  n: number,
  wcet: number,
  p50 = 1000,
  p90 = 3000,
  /** `close: false` leaves the task open so more fixture (blocks, a workflow) can be
   *  hung off it before it is finalized. */
  opts: { close?: boolean } = {},
): Promise<string> {
  const session = `sp${n}`;
  const at = `2026-02-${String((n % 27) + 1).padStart(2, "0")}T00:00:00Z`;
  turn(h.db, { session, prompt: "p1", at, durationMs: 60_000 });
  const r = await h.cli(
    ...openArgs({ subject: `sized work ${n}`, "raw-p50": p50, "raw-p90": p90 }),
    "--session", session, "--prompt", "p1", "--json",
  );
  expect(r.code).toBe(0);
  const tid = r.json<{ tid: string }>().tid;
  request(h.db, `rq-sp-${n}`, { session, out: wcet, ts: at });
  attributeTasks(h.db);
  if (opts.close !== false) {
    expect((await h.cli("close", tid, "--force")).code).toBeLessThanOrEqual(3);
  }
  return tid;
}

// ---------------------------------------------------------------------------
// 1 — the estimand flip segregates the corpus, end to end
// ---------------------------------------------------------------------------

describe("the estimand switch segregates buckets", () => {
  test("a Work-CET corpus stays whole and invisible to the points bucket", async () => {
    await completed(1, 5000);
    await completed(2, 7000);
    const before = h.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_velocity WHERE estimand = 'work_cet'")
      .get()!.n;
    expect(before).toBe(2);

    flipToPoints();

    // Nothing was deleted, restated or redenominated: the old rows are exactly where
    // they were, still labelled with the unit they were issued in.
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_velocity WHERE estimand = 'work_cet'").get()!.n,
    ).toBe(before);
    // And the new unit starts empty rather than inheriting them.
    expect(
      h.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM v_velocity WHERE estimand = ?")
        .get(POINTS_ESTIMAND)!.n,
    ).toBe(0);
    // Which is what `est open`'s cold-start guard reads.
    expect(pointsToWcet(h.db, KEY)).toEqual({ rate: null, source: null, n: 0 });
  });

  test("a points band never lands in the Work-CET reference class, and vice versa", async () => {
    await completed(3, 5000);
    flipToPoints();
    const pointsTask = await completed(4, 6000, 8, 13);

    const row = h.db
      .query<{ estimand: string; raw_p50_wcet: number }, [string]>(
        "SELECT estimand, raw_p50_wcet FROM estimate WHERE tid = ?",
      )
      .get(pointsTask)!;
    expect(row.estimand).toBe(POINTS_ESTIMAND);
    expect(row.raw_p50_wcet).toBe(8);

    // `est refclass` filters both its match rows AND its cold distribution on the
    // active estimand, so the Work-CET task cannot appear beside a points band.
    const r = await h.cli("refclass", "--text", "sized work", "--json");
    expect(r.code).toBe(0);
    const body = r.json<{
      estimand: string;
      matches: Array<{ subject: string; raw_p50: number }>;
      cold_distribution: { n: number } | null;
    }>();
    expect(body.estimand).toBe(POINTS_ESTIMAND);
    expect(body.matches.map((m) => m.subject)).toEqual(["sized work 4"]);
    expect(body.cold_distribution?.n).toBe(1);
  });

  /**
   * The one place the flip did NOT segregate cleanly before v15, and the failure mode
   * was silent: `v_task_actual_epoch`'s `CASE e.estimand` knew three counter sets, so a
   * fourth value fell through to NULL, `outcome.actual_wcet_at_epoch` was NULL, and
   * `v_velocity`'s `actual_wcet_at_epoch IS NOT NULL` filter dropped the row. A corpus
   * that can never learn a rate looks exactly like a corpus nobody has finished work in.
   */
  test("a completed story-point task DOES reach v_velocity, with velocity in Work-CET per point", async () => {
    flipToPoints();
    const tid = await completed(5, 60_000, 8, 13);

    const outcome = h.db
      .query<{ actual_wcet_at_epoch: number | null; velocity_raw: number | null }, [string]>(
        "SELECT actual_wcet_at_epoch, velocity_raw FROM v_outcome_current WHERE tid = ?",
      )
      .get(tid)!;
    expect(outcome.actual_wcet_at_epoch).toBe(60_000);
    // 60,000 Work-CET / 8 points = 7,500 Work-CET per point. THIS is the learning signal.
    expect(outcome.velocity_raw).toBeCloseTo(7500, 6);

    const v = h.db
      .query<{ n: number; estimand: string }, [string]>(
        "SELECT COUNT(*) AS n, MAX(estimand) AS estimand FROM v_velocity WHERE estimand = ?",
      )
      .get(POINTS_ESTIMAND)!;
    expect(v.n).toBe(1);
  });

  /**
   * The other half of the same honesty rule, on the close side. When `est open` found
   * no rate, `cal_p50_wcet`/`cal_p90_wcet` are still POINTS — so scoring a 60,000
   * Work-CET actual against a p90 of 13 would record a wild overrun for a task that may
   * have landed exactly on its estimate. `velocity_raw` (the learning signal) is
   * unaffected; the two band-relative figures go NULL rather than wrong.
   */
  test("velocity_cal and in_band go NULL when the band was never converted to Work-CET", async () => {
    flipToPoints();
    const tid = await completed(9, 60_000, 8, 13);
    const o = h.db
      .query<{ velocity_raw: number | null; velocity_cal: number | null; in_band: number | null }, [string]>(
        "SELECT velocity_raw, velocity_cal, in_band FROM v_outcome_current WHERE tid = ?",
      )
      .get(tid)!;
    expect(o.velocity_raw).toBeCloseTo(7500, 6);
    expect(o.velocity_cal).toBeNull();
    expect(o.in_band).toBeNull();
  });

  test("with a rate, the calibrated band IS Work-CET and is scored normally", async () => {
    flipToPoints();
    h.db.query("UPDATE config SET v = '10000' WHERE k = 'sp_seed_wcet_per_point'").run();
    h.db.query("UPDATE config SET v = 'v1' WHERE k = 'sp_seed_anchor_id'").run();
    const tid = await completed(10, 60_000, 8, 13); // cal = 80,000 / 130,000 Work-CET
    const o = h.db
      .query<{ velocity_cal: number | null; in_band: number | null }, [string]>(
        "SELECT velocity_cal, in_band FROM v_outcome_current WHERE tid = ?",
      )
      .get(tid)!;
    expect(o.velocity_cal).toBeCloseTo(60_000 / 80_000, 6);
    expect(o.in_band).toBe(1);
  });

  test("a Work-CET task still scores against its band exactly as before", async () => {
    const tid = await completed(11, 2000, 1000, 3000);
    const o = h.db
      .query<{ velocity_raw: number | null; velocity_cal: number | null; in_band: number | null }, [string]>(
        "SELECT velocity_raw, velocity_cal, in_band FROM v_outcome_current WHERE tid = ?",
      )
      .get(tid)!;
    expect(o.velocity_raw).toBeCloseTo(2, 6);
    expect(o.velocity_cal).toBeCloseTo(2, 6);
    expect(o.in_band).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2 — the anchor is pinned onto the row and surfaces
// ---------------------------------------------------------------------------

describe("the story-point anchor is pinned and surfaces", () => {
  test("schema.sql seeds anchor v1 with the agreed text", () => {
    const a = storyPointAnchor(h.db);
    expect(a.id).toBe("v1");
    expect(a.text).toBe(
      "rename a single variable across 3 files in a TypeScript codebase, with no tests to update",
    );
  });

  test("a points band pins sp_anchor_id; a Work-CET band leaves it NULL", async () => {
    const wcetTid = await completed(6, 1000);
    flipToPoints();
    const pointsTid = await completed(7, 1000, 5, 8);

    const anchorOf = (tid: string): string | null =>
      h.db
        .query<{ sp_anchor_id: string | null }, [string]>(
          "SELECT sp_anchor_id FROM estimate WHERE tid = ? ORDER BY eid ASC LIMIT 1",
        )
        .get(tid)!.sp_anchor_id;

    // NULL means "no anchor was involved", never "the current one" — the whole reason
    // the column exists rather than being read from config at query time.
    expect(anchorOf(wcetTid)).toBeNull();
    expect(anchorOf(pointsTid)).toBe("v1");
  });

  test("re-wording the anchor cannot redenominate a band already on disk", async () => {
    flipToPoints();
    const tid = await completed(8, 1000, 5, 8);
    // Through the CLI, not raw SQL: since v19 a band cannot be issued against an anchor
    // id with no `sp_anchor` row, and hand-editing the two config keys leaves exactly
    // that state. `setConfig` is the registry's writer and the id-then-text order is what
    // registers the definition.
    await bumpAnchor("v2", "add one CLI flag with a test");

    expect(
      h.db
        .query<{ sp_anchor_id: string | null }, [string]>(
          "SELECT sp_anchor_id FROM estimate WHERE tid = ?",
        )
        .get(tid)!.sp_anchor_id,
    ).toBe("v1");
    // And the next band records the NEW anchor, so the two are distinguishable.
    const r = await h.cli(
      ...openArgs({ subject: "after the anchor moved", "raw-p50": 5, "raw-p90": 8 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r.json<{ sp_anchor: { id: string } }>().sp_anchor.id).toBe("v2");
  });

  test("`est open` shows the anchor on both render paths", async () => {
    flipToPoints();
    const human = await h.cli(
      ...openArgs({ subject: "anchor on screen", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1",
    );
    expect(human.code).toBe(0);
    expect(human.out).toContain("8 / 13 points");
    expect(human.out).toContain("anchor v1");
    expect(human.out).toContain("rename a single variable across 3 files");

    const json = await h.cli(
      ...openArgs({ subject: "anchor in json", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    const body = json.json<{
      sp_anchor: { id: string; text: string };
      band: { p50_points: number | null; p90_points: number | null };
    }>();
    expect(body.sp_anchor.id).toBe("v1");
    expect(body.band.p50_points).toBe(8);
    expect(body.band.p90_points).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// 3 — pointsToWcet: never invents a rate
// ---------------------------------------------------------------------------

describe("pointsToWcet", () => {
  test("returns null cleanly with no data and no seed", () => {
    flipToPoints();
    expect(pointsToWcet(h.db, KEY)).toEqual({ rate: null, source: null, n: 0 });
  });

  test("returns null for a Work-CET estimand — there is nothing to convert", () => {
    expect(pointsToWcet(h.db, { ...KEY, estimand: "work_cet" })).toEqual({
      rate: null,
      source: null,
      n: 0,
    });
  });

  test("a seed is used only when its anchor matches the anchor in force", () => {
    flipToPoints();
    h.db.query("UPDATE config SET v = '15000' WHERE k = 'sp_seed_wcet_per_point'").run();

    // Seeded, but for no anchor at all: a rate per point of nothing is not a rate.
    expect(pointsToWcet(h.db, KEY).rate).toBeNull();

    h.db.query("UPDATE config SET v = 'v1' WHERE k = 'sp_seed_anchor_id'").run();
    expect(pointsToWcet(h.db, KEY)).toEqual({ rate: 15000, source: "seed", n: 0 });

    // The anchor moves; the seed goes stale rather than silently carrying across.
    h.db.query("UPDATE config SET v = 'v2' WHERE k = 'sp_anchor_id'").run();
    expect(pointsToWcet(h.db, KEY)).toEqual({ rate: null, source: null, n: 0 });
  });

  test("a malformed or non-positive seed is unset, not a rate", () => {
    flipToPoints();
    h.db.query("UPDATE config SET v = 'v1' WHERE k = 'sp_seed_anchor_id'").run();
    for (const bad of ["", "   ", "not-a-number", "0", "-5"]) {
      h.db.query("UPDATE config SET v = ? WHERE k = 'sp_seed_wcet_per_point'").run(bad);
      expect(pointsToWcet(h.db, KEY).rate).toBeNull();
    }
  });

  /**
   * The normal path, and deliberately not a parallel calibrator: `refclass.mult_p50` is
   * the decayed, shrunk median of `velocity_raw`, and `velocity_raw` is
   * `actual_wcet / raw_p50` — so with `raw_p50` in points it already IS Work-CET per
   * point. `est retro` fits it; this function reads it.
   */
  test("fitted beats seed once the corpus reaches the cold-start floor", async () => {
    flipToPoints();
    h.db.query("UPDATE config SET v = '99' WHERE k = 'sp_seed_wcet_per_point'").run();
    h.db.query("UPDATE config SET v = 'v1' WHERE k = 'sp_seed_anchor_id'").run();

    // Ten completed 10-point tasks that each really cost 20,000 Work-CET: 2,000 per point.
    for (let i = 0; i < COLD_START_N; i += 1) await completed(20 + i, 20_000, 10, 20);
    expect((await h.cli("retro")).code).toBeLessThanOrEqual(3);

    const rate = pointsToWcet(h.db, KEY);
    expect(rate.source).toBe("fitted");
    expect(rate.n).toBeGreaterThanOrEqual(COLD_START_N);
    expect(rate.rate).toBeCloseTo(2000, -2);
  });

  test("`est open` prints no Work-CET and no Spend-CET figure when there is no rate", async () => {
    flipToPoints();
    const r = await h.cli(
      ...openArgs({ subject: "no rate yet", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("no points→Work-CET rate");
    // No FIGURE, in either currency. (The refusal line names both by name, which is the
    // point of it, so the assertion is about numbers rather than about words.)
    expect(r.out).not.toMatch(/Work-CET forecast\s+[\d,]/);
    expect(r.out).not.toMatch(/\$\s*[\d.]/);

    // And the machine contract says the same thing by omission rather than by a wrong
    // number: 8 points must never be reported as 8 Work-CET.
    const j = await h.cli(
      ...openArgs({ subject: "no rate yet json", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    const band = j.json<{
      band: { p50_wcet: number | null; spend_usd_p50: number | null; p50_points: number | null };
      wcet_rate: { rate: number | null; source: string | null; n: number };
    }>();
    expect(band.band.p50_wcet).toBeNull();
    expect(band.band.spend_usd_p50).toBeNull();
    expect(band.band.p50_points).toBe(8);
    expect(band.wcet_rate).toEqual({ rate: null, source: null, n: 0 });
  });

  // The THIRD seed-remedy surface, pinned the way `est burn`'s band note
  // (test/burn-points.test.ts) and the retro's `unit_refusal` already are. `est open` is
  // where a person meets the cold start first and while they are least patient, and it
  // used to offer the seed in a trailing "or set the bootstrap with …" clause: a
  // co-equal fix, no §13.1, no bar. Three surfaces, one shape — so the answer cannot
  // depend on which one you happened to read.
  test("the no-rate remedy leads with `do nothing`, cites the decision, and states the bar", async () => {
    flipToPoints();
    const r = await h.cli(
      ...openArgs({ subject: "no rate remedy", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("do nothing");
    expect(r.out).toContain(`${COLD_START_N} completed`);
    expect(r.out).toContain("no seed is set DELIBERATELY");
    expect(r.out).toContain("DECISIONS.md §13.1");
    expect(r.out).toContain("rate CV < 0.3");
    expect(r.out).toContain(`≥${COLD_START_N} REAL completed tasks`);
    expect(r.out).toContain("impatience is not that evidence");
    // "do nothing" comes FIRST: an option listed after the lever is an option nobody
    // reads, which is exactly how the old phrasing failed. Ordered against the OFFER
    // (`est config set …`) rather than against the bare key — the diagnosis line names
    // `config.sp_seed_wcet_per_point` earlier to say it is unset, which is a statement
    // of fact about the corpus, not an invitation.
    expect(r.out.indexOf("do nothing")).toBeLessThan(r.out.indexOf("est config set sp_seed_wcet_per_point"));
    // And the old phrasing is gone, not merely buried — it offered the seed with no bar.
    expect(r.out).not.toContain("or set the bootstrap with");
  });

  test("a seeded rate produces a labelled Work-CET forecast", async () => {
    flipToPoints();
    h.db.query("UPDATE config SET v = '15000' WHERE k = 'sp_seed_wcet_per_point'").run();
    h.db.query("UPDATE config SET v = 'v1' WHERE k = 'sp_seed_anchor_id'").run();
    const r = await h.cli(
      ...openArgs({ subject: "seeded", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    const body = r.json<{
      band: { p50_wcet: number | null; p90_wcet: number | null };
      wcet_rate: { rate: number | null; source: string | null; n: number };
    }>();
    expect(body.band.p50_wcet).toBe(120_000);
    expect(body.band.p90_wcet).toBe(195_000);
    // A seed is backed by no observations and says so.
    expect(body.wcet_rate).toEqual({ rate: 15000, source: "seed", n: 0 });

    const human = await h.cli(
      ...openArgs({ subject: "seeded human", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1",
    );
    expect(human.out).toContain("Work-CET forecast");
    expect(human.out).toContain("bootstrapped convention");
  });

  test("the request band is NOT scaled by a Work-CET-per-point rate", async () => {
    flipToPoints();
    h.db.query("UPDATE config SET v = '15000' WHERE k = 'sp_seed_wcet_per_point'").run();
    h.db.query("UPDATE config SET v = 'v1' WHERE k = 'sp_seed_anchor_id'").run();
    const r = await h.cli(
      ...openArgs({ subject: "requests stay requests", "raw-p50": 8, "raw-p90": 13, "exp-requests": 40 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    // 40 requests, not 600,000.
    expect(r.json<{ band: { req_p50: number; req_p90: number } }>().band).toMatchObject({
      req_p50: 40,
      req_p90: 40,
    });
  });
});

// ---------------------------------------------------------------------------
// 4 — the sanity bound
// ---------------------------------------------------------------------------

describe("the points sanity bound", () => {
  test("a Work-CET-scale number under story points is refused with exit 1 and stored nowhere", async () => {
    flipToPoints();
    const before = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate").get()!.n;
    const r = await h.cli(
      ...openArgs({ subject: "wrong unit", "raw-p50": 2_400_000, "raw-p90": 3_000_000 }),
      "--session", "s1", "--prompt", "p1",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("story points");
    expect(r.err).toContain("[1, 1000]");
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate").get()!.n).toBe(before);
    // Nor a half-written task.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task").get()!.n).toBe(0);
  });

  test("zero points is not a size", async () => {
    flipToPoints();
    const r = await h.cli(
      ...openArgs({ subject: "zero", "raw-p50": 0, "raw-p90": 3 }),
      "--session", "s1", "--prompt", "p1",
    );
    expect(r.code).toBe(1);
  });

  test("the ceiling is a tunable, not a literal", async () => {
    flipToPoints();
    expect(maxPoints(h.db)).toBe(1000);
    h.db.query("UPDATE config SET v = '5000' WHERE k = 'sp_max_points'").run();
    expect(maxPoints(h.db)).toBe(5000);
    const r = await h.cli(
      ...openArgs({ subject: "huge but allowed", "raw-p50": 2000, "raw-p90": 3000 }),
      "--session", "s1", "--prompt", "p1",
    );
    expect(r.code).toBe(0);
  });

  test("the bound does not exist under a Work-CET estimand", async () => {
    // The magnitude of a Work-CET band carries no information about which unit the
    // estimator was in, so applying the bound there would refuse ordinary work.
    const r = await h.cli(
      ...openArgs({ subject: "big but correct", "raw-p50": 2_400_000, "raw-p90": 3_000_000 }),
      "--session", "s1", "--prompt", "p1",
    );
    expect(r.code).toBe(0);
  });

  test("`est block` carries the same bound — blocks roll UP into the task band", async () => {
    flipToPoints();
    const open = await h.cli(
      ...openArgs({ subject: "blocked work", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    const tid = open.json<{ tid: string }>().tid;
    const bad = await h.cli("block", tid, "--phase", "0", "--title", "phase one", "--p50", "900000", "--p90", "900000");
    expect(bad.code).toBe(1);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_block").get()!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5 — `est block` promoted: the task band as the roll-up
// ---------------------------------------------------------------------------

describe("est block --> the task band is the roll-up", () => {
  async function openTid(estimandIsPoints: boolean): Promise<string> {
    if (estimandIsPoints) flipToPoints();
    const r = await h.cli(
      ...openArgs({
        subject: "decomposed work",
        "raw-p50": estimandIsPoints ? 8 : 100_000,
        "raw-p90": estimandIsPoints ? 13 : 300_000,
      }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    return r.json<{ tid: string }>().tid;
  }

  /**
   * The legitimate shape, and the only one `--from-blocks` admits since the roll-up
   * became mechanically first-estimate-safe: the phases were sized, an estimate was
   * issued, and then the phases were RE-sized against a later estimate. The blocks the
   * roll-up sums therefore hang off eid > MIN(eid), so the band it produces is a real
   * refinement rather than the decomposition of the opening guess.
   */
  test("--from-blocks issues the SUM of the block estimates as the task band", async () => {
    const tid = await openTid(true);
    await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "2", "--p90", "3");
    await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "5", "--p90", "8");

    // The phases turned out bigger. A new estimate, then the re-sized phases against it.
    const mid = await h.cli(
      "open", "--tid", tid, "--reason", "refinement",
      "--raw-p50", "7", "--raw-p90", "11",
      "--exp-agents", "2", "--exp-wf-phases", "2", "--exp-files-write", "4",
      "--exp-turns", "6", "--exp-requests", "40",
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(mid.code).toBe(0);
    await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "3", "--p90", "5");
    await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "8", "--p90", "13");

    const r = await h.cli(
      "open", "--tid", tid, "--reason", "refinement", "--from-blocks",
      "--exp-agents", "2", "--exp-wf-phases", "2", "--exp-files-write", "4",
      "--exp-turns", "6", "--exp-requests", "40",
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    const body = r.json<{
      raw: { p50: number; p90: number };
      rolled_up_from_blocks: number | null;
    }>();
    expect(body.raw).toEqual({ p50: 11, p90: 18 });
    expect(body.rolled_up_from_blocks).toBe(2);

    // And that is what lands in the append-only row, so `est retro`'s block panel
    // compares the task band against its own parts rather than against a second guess.
    const row = h.db
      .query<{ raw_p50_wcet: number; raw_p90_wcet: number }, [string]>(
        "SELECT raw_p50_wcet, raw_p90_wcet FROM estimate WHERE tid = ? ORDER BY eid DESC LIMIT 1",
      )
      .get(tid)!;
    expect(row).toEqual({ raw_p50_wcet: 11, raw_p90_wcet: 18 });
  });

  test("--from-blocks refuses a parallel guess for the same band", async () => {
    const tid = await openTid(true);
    await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "3", "--p90", "5");
    const r = await h.cli(
      "open", "--tid", tid, "--reason", "refinement", "--from-blocks",
      "--raw-p50", "20", "--raw-p90", "30",
      "--exp-agents", "1", "--exp-wf-phases", "1", "--exp-files-write", "1",
      "--exp-turns", "1", "--exp-requests", "1",
      "--session", "s1", "--prompt", "p1",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("--from-blocks");
  });

  test("--from-blocks with nothing to roll up is a usage error, not an empty band", async () => {
    const tid = await openTid(true);
    const r = await h.cli(
      "open", "--tid", tid, "--reason", "refinement", "--from-blocks",
      "--exp-agents", "1", "--exp-wf-phases", "1", "--exp-files-write", "1",
      "--exp-turns", "1", "--exp-requests", "1",
      "--session", "s1", "--prompt", "p1",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("no block estimates");
  });

  test("existing Work-CET tasks are unchanged: no flag, no new behaviour", async () => {
    const tid = await openTid(false);
    const b = await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "40000", "--p90", "60000");
    expect(b.code).toBe(0);
    expect(b.out).toContain("Work-CET");
    expect(b.out).not.toContain("points");
    // The task band is untouched by the block — the roll-up is opt-in.
    expect(
      h.db
        .query<{ raw_p50_wcet: number }, [string]>(
          "SELECT raw_p50_wcet FROM estimate WHERE tid = ? ORDER BY eid DESC LIMIT 1",
        )
        .get(tid)!.raw_p50_wcet,
    ).toBe(100_000);
  });

  test("every block prints the roll-up so far, in the unit in force", async () => {
    const tid = await openTid(true);
    const r = await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "3", "--p90", "5");
    expect(r.out).toContain("3 / 5 points");
    expect(r.out).toContain("roll-up so far  3 / 5 points over 1 block(s)");
  });
});

// ---------------------------------------------------------------------------
// 6 — the seed's storage is visible and is not an observation
// ---------------------------------------------------------------------------

describe("the bootstrapped seed", () => {
  test("lives in config, where `est config` can show and tune it", async () => {
    const list = await h.cli("config", "list", "--json");
    const cfg = list.json<{ config: Record<string, string> }>().config;
    expect(cfg).toHaveProperty("sp_seed_wcet_per_point", "");
    expect(cfg).toHaveProperty("sp_seed_anchor_id", "");
    expect(cfg).toHaveProperty("sp_anchor_id", "v1");
    expect(cfg).toHaveProperty("sp_max_points", "1000");

    // The key set is CLOSED, so a seeded key is exactly what makes it tunable.
    expect((await h.cli("config", "set", "sp_seed_wcet_per_point", "12000")).code).toBe(0);
    expect((await h.cli("config", "get", "sp_seed_wcet_per_point")).out.trim()).toBe("12000");
  });

  test("is never written as an estimate row and never enters v_velocity", async () => {
    flipToPoints();
    await h.cli("config", "set", "sp_seed_wcet_per_point", "12000");
    await h.cli("config", "set", "sp_seed_anchor_id", "v1");
    expect(pointsToWcet(h.db, KEY).source).toBe("seed");

    // The seed produced a forecast, and produced no row anywhere in the spine.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate").get()!.n).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()!.n).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_velocity").get()!.n).toBe(0);
  });

  test("`est census` surfaces it, with a live/ignored verdict", async () => {
    flipToPoints();
    await h.cli("config", "set", "sp_seed_wcet_per_point", "12000");
    await h.cli("config", "set", "sp_seed_anchor_id", "v1");

    const j = await h.cli("census", "--json");
    const sp = j.json<{
      story_points: {
        active: boolean;
        seed: { wcet_per_point: number | null; live: boolean; source: string };
        rate: { source: string | null };
      };
    }>().story_points;
    expect(sp.active).toBe(true);
    expect(sp.seed).toMatchObject({ wcet_per_point: 12000, live: true, source: "config" });
    expect(sp.rate.source).toBe("seed");

    const human = await h.cli("census");
    expect(human.out).toContain("story points");
    expect(human.out).toContain("seed rate: 12,000 Work-CET/point");
    expect(human.out).toContain("LIVE");

    // Move the anchor: the seed is still SET but no longer applies, and says so.
    await bumpAnchor("v2", "add one CLI flag with a test");
    expect(
      (await h.cli("census", "--json")).json<{ story_points: { seed: { live: boolean } } }>()
        .story_points.seed.live,
    ).toBe(false);
    expect((await h.cli("census")).out).toContain("IGNORED");
  });
});

// ---------------------------------------------------------------------------
// 7 — the v14 -> v15 migration
// ---------------------------------------------------------------------------

describe("schema migration 14 -> 15", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "est-sp-migrate-"));
    db = openDb({ path: join(dir, "estimator.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The obligation every step in src/db.ts carries: a migrated file is byte-identical
   * to a fresh one. It matters more than usual here because the column half is an
   * `ALTER TABLE ADD COLUMN`, and SQLite splices the new definition into the stored
   * `CREATE TABLE` text at a position schema.sql has to match exactly.
   */
  test("a v14 database migrates to exactly the shape schema.sql builds", () => {
    db.exec(`
      -- EVERY trailing column comes off, newest first. \`ALTER TABLE ADD COLUMN\` appends
      -- after the LAST column definition, so a v14 file that still carried v17's
      -- \`procedure_version\` (or v19's \`wcet_rate\` pair) would come out of the 14 -> 15
      -- step with them spliced in the opposite order to a fresh file — which is precisely
      -- the fidelity this test exists to catch, but for the wrong reason.
      ALTER TABLE estimate DROP COLUMN wcet_rate_src;
      ALTER TABLE estimate DROP COLUMN wcet_rate;
      ALTER TABLE estimate DROP COLUMN procedure_version;
      ALTER TABLE estimate DROP COLUMN sp_anchor_id;
      DROP VIEW v_task_actual_epoch;
      CREATE VIEW v_task_actual_epoch AS
      SELECT r.tid,
        SUM(CAST((CASE e.estimand
                    WHEN 'out'       THEN r.out_tok*pe.usd_out
                    WHEN 'work_cet'  THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw
                    WHEN 'out_cw_in' THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw + r.in_tok*pe.usd_in
                  END) / rf.usd_out AS INTEGER)) AS wcet_at_epoch,
        e.price_epoch, e.eid AS eid_at_start
      FROM v_request_live r
      JOIN estimate e ON e.eid = (SELECT MIN(eid) FROM estimate WHERE tid = r.tid)
      JOIN model_price pe ON pe.family = r.model_family
       AND pe.effective_from = (SELECT MAX(effective_from) FROM model_price
                                WHERE family = pe.family AND effective_from <= e.price_epoch)
      JOIN model_price rf ON rf.family = e.ref_model
       AND rf.effective_from = (SELECT MAX(effective_from) FROM model_price
                                WHERE family = rf.family AND effective_from <= e.price_epoch)
      WHERE r.tid IS NOT NULL AND r.attr <> 'overhead'
        AND r.origin IN ('main','subagent')
      GROUP BY r.tid;
      DELETE FROM config WHERE k IN
        ('sp_anchor_id','sp_anchor_text','sp_seed_wcet_per_point','sp_seed_anchor_id','sp_max_points',
         'procedure_version');
      UPDATE config SET v = '14' WHERE k = 'schema_version';
    `);
    // Migration rule 2: a value Craig has already tuned must survive untouched.
    db.query("UPDATE config SET v='999' WHERE k='shrink_k'").run();
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='shrink_k'").get()?.v).toBe("999");
    expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='sp_anchor_id'").get()?.v).toBe("v1");

    const freshDir = mkdtempSync(join(tmpdir(), "est-sp-fresh-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const objects = (d: Database): unknown =>
        d
          .query<{ type: string; name: string; sql: string | null }, []>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      expect(objects(db)).toEqual(objects(fresh));
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  /**
   * Rule 3: applied to a file that already has the shape but an older marker. SQLite
   * has no `ADD COLUMN IF NOT EXISTS`, which is exactly why the column half of the step
   * is guarded in TypeScript rather than written as SQL.
   */
  test("the step is idempotent against a file that already has the column", () => {
    const path = join(dir, "estimator.db");
    db.query("UPDATE config SET v = '14' WHERE k = 'schema_version'").run();
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pragma_table_info('estimate') WHERE name='sp_anchor_id'").get()!.n,
    ).toBe(1);
  });

  test("the existing corpus keeps its actuals across the step", async () => {
    // Guards the view half: the branch that was ADDED must not change how the three
    // pre-existing estimands are priced.
    const local = makeHarness("est-sp-carry-");
    try {
      seedPrices(local.db);
      turn(local.db, { session: "sc", prompt: "p1", at: "2026-01-01T00:00:00Z" });
      const r = await local.cli(
        ...openArgs({ subject: "carried" }), "--session", "sc", "--prompt", "p1", "--json",
      );
      const tid = r.json<{ tid: string }>().tid;
      request(local.db, "rq-carry", { session: "sc", out: 4000, cw: 1000, ts: "2026-01-01T00:00:00Z" });
      attributeTasks(local.db);
      await local.cli("close", tid, "--force");
      expect(
        local.db
          .query<{ w: number | null }, [string]>(
            "SELECT actual_wcet_at_epoch AS w FROM v_outcome_current WHERE tid = ?",
          )
          .get(tid)!.w,
      ).toBe(5000); // out + cw, the work_cet counter set, unchanged
    } finally {
      local.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 8 — the cutover itself
// ---------------------------------------------------------------------------

describe("the cutover", () => {
  test("ships with estimand still work_cet — the flip is Craig's call", async () => {
    expect((await h.cli("config", "get", "estimand")).out.trim()).toBe("work_cet");
    expect(isPointsEstimand("work_cet")).toBe(false);
    expect(isPointsEstimand(POINTS_ESTIMAND)).toBe(true);
  });

  test("`est config set estimand story_point` is the one command that performs it", async () => {
    const r = await h.cli("config", "set", "estimand", POINTS_ESTIMAND);
    expect(r.code).toBe(0);
    expect(r.out).toContain("estimand: work_cet → story_point");

    // And it takes effect on the very next band, with no restart and no migration.
    const open = await h.cli(
      ...openArgs({ subject: "first points band", "raw-p50": 5, "raw-p90": 8 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(open.json<{ estimand: string }>().estimand).toBe(POINTS_ESTIMAND);
  });
});

// ---------------------------------------------------------------------------
// 9 — the scoring surfaces refuse a cross-unit comparison
// ---------------------------------------------------------------------------

/**
 * ONE guard, four consumers. `est close` had it; `est retro`'s two scoring panels and
 * `v_block_accuracy` had each independently made the same mistake, which is why the
 * test now lives in `src/tasks.ts` as `bandUnscorable` / `blocksInWcet` and everything
 * reads it from there rather than carrying a copy.
 *
 * The refusal is NULL, never a conversion. Choosing between the rate pinned at issue
 * time (there is none — that is the state) and whatever rate exists today is a
 * modelling decision nobody has made, and the output would wear the units of a
 * measurement while being neither.
 */
describe("scoring refuses a points band against a Work-CET actual", () => {
  /** One workflow run + two declared phases + a phase-0 agent, on an existing task. */
  function seedWorkflow(tid: string): string {
    const session = h.db
      .query<{ anchor_session: string }, [string]>("SELECT anchor_session FROM task WHERE tid = ?")
      .get(tid)!.anchor_session;
    h.db
      .query(
        `INSERT INTO workflow_run (run_id, wf_launch_id, session_id, workflow_name, transcript_dir,
                                   default_model, launch_prompt_id, n_phases_planned, started_at, ended_at, tid)
         VALUES ('wf-1','launch-1',?,'demo',NULL,NULL,'p1',2,'2026-02-01T00:00:00Z',NULL,?)`,
      )
      .run(session, tid);
    for (const [idx, title] of [[0, "survey"], [1, "build"]] as const) {
      h.db
        .query(
          "INSERT INTO workflow_phase (run_id, wf_launch_id, phase_idx, title, detail, model) VALUES ('wf-1','launch-1',?,?,NULL,NULL)",
        )
        .run(idx, title);
    }
    h.db
      .query(
        `INSERT INTO agent_run (agent_id, session_id, run_id, wf_launch_id, agent_type, spawn_depth,
                                launch_prompt_id, status, label, started_at, ended_at, interval_src,
                                phase_idx, phase_conf, tid)
         VALUES ('a1', ?, 'wf-1', 'launch-1', 'general-purpose', 1, 'p1', 'completed', 'demo',
                 '2026-02-01T00:01:00Z', '2026-02-01T00:05:00Z', 'transcript', 0, 'exact', ?)`,
      )
      .run(session, tid);
    return session;
  }

  /** Turn on the seed rate, so `est open` converts the band AT OPEN TIME. */
  function seedRate(perPoint: number): void {
    h.db.query("UPDATE config SET v = ? WHERE k = 'sp_seed_wcet_per_point'").run(String(perPoint));
    h.db.query("UPDATE config SET v = 'v1' WHERE k = 'sp_seed_anchor_id'").run();
  }

  test("a points task with no rate contributes NO number to the baseline panel", async () => {
    flipToPoints();
    await completed(30, 60_000, 8, 13);

    const r = retro(h.db, { dryRun: true, asOf: new Date("2026-03-01T00:00:00Z") });
    const s = r.scoring;
    // The outcome EXISTS and is completed and priced — it is the comparison that is
    // undefined, not the data that is missing, which is the distinction the counters
    // and the alert carry.
    expect(s.unscorable.baseline).toBe(1);
    expect(s.n_scored).toBe(0);
    expect(s.pinball_p50).toBeNull();
    expect(s.pinball_p90).toBeNull();
    expect(s.log_score).toBeNull();
    expect(s.coverage_p50).toBeNull();
    expect(s.coverage_p90).toBeNull();
    expect(s.cov_lo).toBeNull();
    expect(s.cov_hi).toBeNull();
    const alert = r.alerts.find((a) => a.includes("unit_refusal"))!;
    expect(alert).toBeDefined();
    // The remedy in `est close`'s exit-2 shape: "do nothing" first, with its consequence,
    // and the seed named as the decided-against lever it is rather than as a co-equal
    // fix offered with no bar attached (DECISIONS.md §13.1).
    expect(alert).toContain("Do nothing");
    expect(alert).toContain("DECISIONS.md §13.1");
    expect(alert).toContain("rate CV < 0.3");
    expect(alert).toContain("not on impatience");
    expect(alert.indexOf("Do nothing")).toBeLessThan(alert.indexOf("sp_seed_wcet_per_point"));

    // `velocity_raw` is Work-CET PER POINT and stays a real measurement, so the
    // raw-denominated origin ratios are computed over the refused row too.
    expect(s.origin.velocity_main).toBeCloseTo(60_000 / 8, 6);
  });

  test("a points task WITH a rate at open scores normally at task level", async () => {
    flipToPoints();
    seedRate(10_000);
    await completed(31, 60_000, 8, 13); // cal = 80,000 / 130,000 Work-CET

    const s = retro(h.db, { dryRun: true, asOf: new Date("2026-03-01T00:00:00Z") }).scoring;
    expect(s.unscorable.baseline).toBe(0);
    expect(s.n_scored).toBe(1);
    expect(s.pinball_p50).not.toBeNull();
    expect(s.coverage_p50).toBe(1); // 60,000 <= 80,000
    expect(s.coverage_p90).toBe(1);
  });

  test("a legacy Work-CET task is scored exactly as before", async () => {
    await completed(32, 2000, 1000, 3000);

    const s = retro(h.db, { dryRun: true, asOf: new Date("2026-03-01T00:00:00Z") }).scoring;
    expect(s.unscorable).toEqual({ baseline: 0, refinement: 0, block_tasks: 0, blocks: 0 });
    expect(s.n_scored).toBe(1);
    // pinball(actual=2000, p50=1000, 0.5) = 0.5 * 1000
    expect(s.pinball_p50).toBeCloseTo(500, 6);
    expect(s.coverage_p50).toBe(0);
    expect(s.coverage_p90).toBe(1);
  });

  /**
   * The refinement leg is guarded on BOTH ends of its pair: `pinball` reads the
   * refinement's band and `moved_toward_actual` reads the baseline's, so one
   * unconverted points band on either side makes the whole comparison cross-unit.
   */
  test("a refinement pair is refused when either end is an unconverted points band", async () => {
    flipToPoints();
    const tid = await completed(36, 60_000, 8, 13, { close: false });
    const ref = await h.cli(
      "open", "--tid", tid, "--reason", "refinement",
      "--raw-p50", "10", "--raw-p90", "16",
      "--kind", "implement", "--subject", "sized work 36",
      "--exp-agents", "2", "--exp-wf-phases", "0", "--exp-files-write", "3",
      "--exp-turns", "10", "--exp-requests", "20", "--json",
    );
    expect(ref.code).toBe(0);
    expect((await h.cli("close", tid, "--force")).code).toBeLessThanOrEqual(3);

    const s = retro(h.db, { dryRun: true, asOf: new Date("2026-03-01T00:00:00Z") }).scoring;
    expect(s.unscorable.refinement).toBe(1);
    expect(s.refinement.n).toBe(0);
    expect(s.refinement.pinball_p50).toBeNull();
    expect(s.refinement.moved_toward_actual_pct).toBeNull();
  });

  test("v_block_accuracy nulls the actual under points and says why", async () => {
    flipToPoints();
    const tid = await completed(33, 60_000, 8, 13, { close: false });
    const session = seedWorkflow(tid);
    expect((await h.cli("block", tid, "--phase", "0", "--title", "survey", "--p50", "3", "--p90", "5")).code).toBe(0);
    expect((await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "5", "--p90", "8")).code).toBe(0);
    request(h.db, "rq-blk-33", { session, agent: "a1", origin: "subagent", out: 40_000 });
    attributeTasks(h.db);

    const rows = h.db
      .query<{ phase_idx: number; p50_wcet: number; actual_wcet: number | null; unit_mismatch: number }, []>(
        "SELECT phase_idx, p50_wcet, actual_wcet, unit_mismatch FROM v_block_accuracy ORDER BY phase_idx",
      )
      .all();
    expect(rows).toHaveLength(2);
    // The ESTIMATE side is still true and still wanted — the board renders it — so the
    // row survives; it is the actual beside it that is withheld.
    expect(rows[0]).toMatchObject({ phase_idx: 0, p50_wcet: 3, actual_wcet: null, unit_mismatch: 1 });
    // Phase 1 never ran, so there is no actual to refuse: `unit_mismatch` counts
    // REFUSALS, not absences.
    expect(rows[1]).toMatchObject({ phase_idx: 1, p50_wcet: 5, actual_wcet: null, unit_mismatch: 0 });
  });

  test("a Work-CET task's blocks keep their actuals and are never flagged", async () => {
    const tid = await completed(34, 60_000, 1000, 3000, { close: false });
    const session = seedWorkflow(tid);
    expect((await h.cli("block", tid, "--phase", "0", "--title", "survey", "--p50", "300", "--p90", "500")).code).toBe(0);
    request(h.db, "rq-blk-34", { session, agent: "a1", origin: "subagent", out: 40_000 });
    attributeTasks(h.db);

    const row = h.db
      .query<{ actual_wcet: number | null; unit_mismatch: number }, []>(
        "SELECT actual_wcet, unit_mismatch FROM v_block_accuracy WHERE phase_idx = 0",
      )
      .get()!;
    expect(row.actual_wcet).toBe(40_000);
    expect(row.unit_mismatch).toBe(0);
  });

  /**
   * The block axis is refused MORE broadly than the task band, and deliberately: an
   * `estimate_block` row is stored in the unit in force and nothing ever converts it —
   * the table has no `cal_*` pair and its append-only triggers mean it could not acquire
   * one — so a rate applied to `estimate` at `est open` does not reach the blocks
   * hanging off it. A rolled-up points figure pinballed against a Work-CET actual would
   * be cross-unit however well the task band itself scores.
   */
  test("the block panel stays refused even when the task band WAS converted at open", async () => {
    flipToPoints();
    seedRate(10_000);
    const tid = await completed(35, 60_000, 8, 13, { close: false });
    const session = seedWorkflow(tid);
    expect((await h.cli("block", tid, "--phase", "0", "--title", "survey", "--p50", "3", "--p90", "5")).code).toBe(0);
    request(h.db, "rq-blk-35", { session, agent: "a1", origin: "subagent", out: 40_000 });
    attributeTasks(h.db);
    expect((await h.cli("close", tid, "--force")).code).toBeLessThanOrEqual(3);

    const s = retro(h.db, { dryRun: true, asOf: new Date("2026-03-01T00:00:00Z") }).scoring;
    // Task level: converted at open, so it scores.
    expect(s.n_scored).toBe(1);
    expect(s.unscorable.baseline).toBe(0);
    // Block level: refused, and the verdict falls through to the arm that already
    // meant "we cannot tell".
    expect(s.blocks.rollup_pinball_p50).toBeNull();
    expect(s.blocks.task_pinball_p50).toBeNull();
    expect(s.blocks.per_block_pinball_p50).toBeNull();
    expect(s.blocks.n_tasks).toBe(0);
    expect(s.blocks.verdict).toBe("insufficient_data");
    expect(s.unscorable.block_tasks).toBe(1);
    expect(s.unscorable.blocks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10 — schema migration 15 -> 16
// ---------------------------------------------------------------------------

describe("schema migration 15 -> 16", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "est-sp-migrate16-"));
    db = openDb({ path: join(dir, "estimator.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a v15 database migrates to exactly the shape schema.sql builds", () => {
    // The pre-v16 definition, verbatim: no unit guard on either column.
    db.exec(`
      DROP VIEW v_block_accuracy;
      CREATE VIEW v_block_accuracy AS
      SELECT b.eid, e.tid, b.phase_idx, b.title, b.p50_wcet, b.p90_wcet, b.exp_agents,
             pa.wcet AS actual_wcet, pa.n_agents, pa.phase_conf
      FROM estimate_block b
      JOIN estimate e     ON e.eid = b.eid
      JOIN workflow_run r ON r.tid = e.tid
      LEFT JOIN v_phase_actual pa
             ON pa.run_id = r.run_id AND pa.wf_launch_id = r.wf_launch_id
            AND pa.phase_idx = b.phase_idx;
      UPDATE config SET v = '15' WHERE k = 'schema_version';
    `);
    // Migration rule 2: a value Craig has already tuned must survive untouched.
    db.query("UPDATE config SET v='999' WHERE k='shrink_k'").run();
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='shrink_k'").get()?.v).toBe("999");

    const freshDir = mkdtempSync(join(tmpdir(), "est-sp-fresh16-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const objects = (d: Database): unknown =>
        d
          .query<{ type: string; name: string; sql: string | null }, []>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      expect(objects(db)).toEqual(objects(fresh));
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("the step is idempotent against a file that already has the new view", () => {
    const path = join(dir, "estimator.db");
    db.query("UPDATE config SET v = '15' WHERE k = 'schema_version'").run();
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM pragma_table_info('v_block_accuracy') WHERE name='unit_mismatch'",
        )
        .get()!.n,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11 — the ANCHOR is enforced, not merely recorded (v17, Codex finding 1)
// ---------------------------------------------------------------------------

/**
 * `estimate.sp_anchor_id` was added so that "8 points" stays interpretable: re-wording
 * the anchor redefines the unit, and a rate fitted per point of the v1 anchor says
 * nothing about a point of the v2 anchor. The SEED path enforced that from the start
 * (`sp_seed_anchor_id` must equal the anchor in force). The FITTED path did not — the
 * anchor was absent from `PointsRateKey`, from `v_velocity`'s projection and from every
 * check between `refclass` and a caller — so a rate fitted under v1 was handed straight
 * to a v2 band, `source: "fitted"`, `n: 10`, nothing on screen saying the denominator
 * had changed underneath it.
 *
 * These tests are Codex's repro and its mirror image.
 */
describe("a fitted points rate is denominated in an anchor", () => {
  /** `n` completed 10-point tasks at 20,000 Work-CET each — 2,000 Work-CET per point —
   *  then a retro, so `pointsToWcet` has a `refclass` snapshot to read back. */
  async function fitARate(offset: number, asOf?: string): Promise<void> {
    for (let i = 0; i < COLD_START_N; i += 1) await completed(offset + i, 20_000, 10, 20);
    const argv = asOf === undefined ? (["retro"] as const) : (["retro", "--as-of", asOf] as const);
    expect((await h.cli(...argv)).code).toBeLessThanOrEqual(3);
  }

  test("bumping the anchor COLD-STARTS the rate instead of inheriting the old scale", async () => {
    flipToPoints();
    await fitARate(100);
    // The state Codex reproduced from: ten tasks, one fitted rate, everything correct.
    // (The rate is a shrunk median of logs, so it lands a float's breadth off 2,000.)
    const fitted = pointsToWcet(h.db, KEY);
    expect(fitted.source).toBe("fitted");
    expect(fitted.n).toBe(COLD_START_N);
    expect(fitted.rate).toBeCloseTo(2000, 6);

    // One line redefines what a point is.
    expect((await h.cli("config", "set", "sp_anchor_id", "v2")).code).toBe(0);
    expect(storyPointAnchor(h.db).id).toBe("v2");

    // Before v17 this still returned { rate: 2000, source: "fitted", n: 10 }: ten tasks
    // sized against a sentence nobody is using any more, priced as if they were evidence
    // about the new one. A v2 estimate has to start where the v1 estimates started.
    expect(pointsToWcet(h.db, KEY)).toEqual({ rate: null, source: null, n: 0 });
  });

  test("an estimate issued under the new anchor reports NO Work-CET band at all", async () => {
    flipToPoints();
    await fitARate(200);
    await bumpAnchor("v2", "add one CLI flag with a test");

    turn(h.db, { session: "s-v2", prompt: "p1", at: "2026-03-01T00:00:00Z" });
    const r = await h.cli(
      ...openArgs({ subject: "first work under the new anchor", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s-v2", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    const body = r.json<{
      band: { p50_wcet: number | null; p90_wcet: number | null; p50_points: number };
      wcet_rate: { rate: number | null; source: string | null; n: number };
      sp_anchor: { id: string };
    }>();
    expect(body.sp_anchor.id).toBe("v2");
    expect(body.wcet_rate).toEqual({ rate: null, source: null, n: 0 });
    // The band that IS issued is the points band, unconverted — never 8 x 2000.
    expect(body.band.p50_wcet).toBeNull();
    expect(body.band.p90_wcet).toBeNull();
    expect(body.band.p50_points).toBe(8);
  });

  test("a band keeps ITS anchor's rate after the bump, rather than losing it", async () => {
    flipToPoints();
    await fitARate(300);
    await bumpAnchor("v2", "add one CLI flag with a test");

    // The corpus is still ten v1 tasks and the snapshot is still fitted from exactly
    // them, so a v1 band is still readable at 2,000 Work-CET per v1 point. The guard is
    // a denomination check, not a blanket refusal after any config edit.
    const v1 = pointsToWcet(h.db, { ...KEY, anchorId: "v1" });
    expect(v1.source).toBe("fitted");
    expect(v1.n).toBe(COLD_START_N);
    expect(v1.rate).toBeCloseTo(2000, 6);
  });

  test("a v1 band is NOT rendered with a rate fitted under v2", async () => {
    flipToPoints();
    // The whole corpus is v2 from the outset, so the only fitted rate that exists is a
    // v2 rate. Asking for a v1 band is asking a question this corpus cannot answer.
    await bumpAnchor("v2", "add one CLI flag with a test");
    await fitARate(400);
    const v2 = pointsToWcet(h.db, KEY);
    expect(v2.source).toBe("fitted");
    expect(v2.rate).toBeCloseTo(2000, 6);

    // Before v17 the anchor was not in the key at all, so this returned the v2 rate:
    // a v1 band's points multiplied by Work-CET per v2 point.
    expect(pointsToWcet(h.db, { ...KEY, anchorId: "v1" })).toEqual({
      rate: null,
      source: null,
      n: 0,
    });
    // And a row that records NO anchor (pre-v15) is an unknown denomination, never the
    // current one.
    expect(pointsToWcet(h.db, { ...KEY, anchorId: null })).toEqual({
      rate: null,
      source: null,
      n: 0,
    });
  });

  /** An UNCONVERTED points band on disk — `wcet_rate_src = 'none'`, which is what SAYS
   *  no rate existed at `est open` (v19: a stored fact, not `cal === raw` inferred) — so
   *  `bandUnit` reaches its state-3 branch and asks the bridge. Everything but the anchor
   *  is held constant. */
  function storedBand(anchorId: string | null): BandUnitRow {
    return {
      estimand: POINTS_ESTIMAND,
      raw_p50_wcet: 8,
      raw_p90_wcet: 13,
      cal_p50_wcet: 8,
      cal_p90_wcet: 13,
      sp_anchor_id: anchorId,
      refclass_as_of: null,
      ref_model: REF_MODEL,
      estimator_model: "unknown",
      wcet_rate: null,
      wcet_rate_src: "none",
    };
  }

  // The rule above was pinned only at `pointsToWcet`, which is not the function any
  // surface calls. `bandUnit` is — burn, the statusline and every board card go through
  // it — and it built the key WITHOUT `anchorId`, so it asked for "the rate for the
  // anchor in force" on behalf of a band that is denominated in whatever it was stored
  // under. The refusal has to hold through the read path, not just under it.
  test("a v1 band is not rendered at a v2 rate THROUGH bandUnit", async () => {
    flipToPoints();
    // The whole corpus is v2, so the only fitted rate in existence is a v2 rate.
    await bumpAnchor("v2", "add one CLI flag with a test");
    await fitARate(600);

    // Positive control, and it is what makes the refusal below mean something: a v2 band
    // IS converted, at the rate this corpus actually fitted.
    const v2 = bandUnit(h.db, storedBand("v2"));
    expect(v2.points?.converted).toBe("at_read");
    expect(v2.points?.rate_source).toBe("fitted");
    expect(v2.p50).toBe(16_000); // 8 points x 2,000 Work-CET per v2 point
    expect(v2.p90).toBe(26_000);

    // The same band, denominated in v1: no rate exists for a v1 point here, so no
    // Work-CET figure is issued at all and the points survive as points. This used to
    // come back as 16,000/26,000 — v1 points priced per v2 point, indistinguishable on
    // screen from a measurement.
    const v1 = bandUnit(h.db, storedBand("v1"));
    expect(v1.p50).toBeNull();
    expect(v1.p90).toBeNull();
    expect(v1.points).toEqual({
      p50: 8,
      p90: 13,
      anchor_id: "v1",
      rate: null,
      rate_source: null,
      rate_n: 0,
      converted: null,
    });

    // A pre-v15 row records no anchor: an unknown denomination, which is not a licence
    // to use the current one.
    const none = bandUnit(h.db, storedBand(null));
    expect(none.p50).toBeNull();
    expect(none.points?.rate).toBeNull();
  });

  // The board memoises the bridge across up to 200 cards per column. Once the anchor is
  // part of the question, it has to be part of the cache key too, or the first card's
  // anchor answers for every card behind it — the same mixing, one layer up.
  test("the board's rate memo is keyed on the anchor, so a v2 card cannot answer for a v1 one", async () => {
    flipToPoints();
    await bumpAnchor("v2", "add one CLI flag with a test");
    await fitARate(700);

    const seen: Array<string | null | undefined> = [];
    const resolve: PointsRateResolver = (k) => {
      seen.push(k.anchorId);
      return pointsToWcet(h.db, k);
    };
    bandUnit(h.db, storedBand("v2"), resolve);
    bandUnit(h.db, storedBand("v1"), resolve);
    // The anchor reaches the resolver at all — which is what a cache key can be built
    // from — and it is the band's, not the one in force.
    expect(seen).toEqual(["v2", "v1"]);
  });

  test("a snapshot fitted ACROSS a bump is refused for both anchors", async () => {
    flipToPoints();
    for (let i = 0; i < COLD_START_N; i += 1) await completed(500 + i, 20_000, 10, 20);
    await bumpAnchor("v2", "add one CLI flag with a test");
    for (let i = 0; i < COLD_START_N; i += 1) await completed(600 + i, 60_000, 10, 20);
    // One retro, late enough to have seen every close: `refclass` is keyed on
    // (as_of, bucket, family, ref_model, estimand) and NOT on the anchor, so this
    // snapshot's median is a blend of 2,000/point and 6,000/point — a rate per point of
    // nothing in particular. Both anchors have COLD_START_N samples of their own, so the
    // count gate alone would pass it; the foreign-sample check is what refuses it.
    expect((await h.cli("retro", "--as-of", "2030-01-01T00:00:00Z")).code).toBeLessThanOrEqual(3);

    expect(pointsToWcet(h.db, KEY).rate).toBeNull();
    expect(pointsToWcet(h.db, { ...KEY, anchorId: "v1" }).rate).toBeNull();
  });

  test("the SEED is gated on the band's anchor, not on the anchor in force", async () => {
    flipToPoints();
    await h.cli("config", "set", "sp_seed_wcet_per_point", "15000");
    await h.cli("config", "set", "sp_seed_anchor_id", "v1");
    // In force is v1, so a band opened now is a v1 band and the seed applies.
    expect(pointsToWcet(h.db, KEY)).toEqual({ rate: 15000, source: "seed", n: 0 });
    // A v2 band is not what the seed was reasoned against, even though nothing about
    // `config` has changed.
    expect(pointsToWcet(h.db, { ...KEY, anchorId: "v2" })).toEqual({
      rate: null,
      source: null,
      n: 0,
    });
  });

  test("v_velocity carries the anchor, which is what makes the segregation possible", async () => {
    flipToPoints();
    await completed(700, 20_000, 10, 20);
    expect(
      h.db
        .query<{ anchor: string | null }, [string]>(
          "SELECT sp_anchor_id AS anchor FROM v_velocity WHERE estimand = ?",
        )
        .get(POINTS_ESTIMAND)!.anchor,
    ).toBe("v1");
  });

  // -------------------------------------------------------------------------
  // v19, defect 1: a REFUSED rate must not be persisted, and must not be scored
  // -------------------------------------------------------------------------

  /**
   * Codex's repro, end to end, and the reason `bandInWcet` had to stop being an
   * inference.
   *
   * `pointsToWcet` is anchor-aware and refuses correctly here — the test above pins
   * that. `calibrationFor` is NOT anchor-aware, and `est open` fell through to it: the
   * first v2 band came out multiplied by the V1 snapshot's multiplier, carrying the v1
   * snapshot's `refclass_as_of` / `shrink_w` / `bucket_n`. `cal != raw` then read as
   * "a rate converted this", so `est close` recorded a `velocity_cal` and an `in_band`
   * against a rate the system had just declined to issue.
   *
   * Three assertions, and each one fails on its own without the fix.
   */
  test("a first band under a new anchor stores cal = raw and no refclass provenance", async () => {
    flipToPoints();
    await fitARate(800);
    await bumpAnchor("v2", "add one CLI flag with a test");
    expect(pointsToWcet(h.db, KEY)).toEqual({ rate: null, source: null, n: 0 });

    turn(h.db, { session: "s-d1", prompt: "p1", at: "2026-03-01T00:00:00Z" });
    const r = await h.cli(
      ...openArgs({ subject: "first v2 band", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s-d1", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    const tid = r.json<{ tid: string }>().tid;

    const row = h.db
      .query<
        {
          raw_p50_wcet: number;
          raw_p90_wcet: number;
          cal_p50_wcet: number;
          cal_p90_wcet: number;
          refclass_as_of: string | null;
          shrink_w: number;
          wcet_rate: number | null;
          wcet_rate_src: string;
        },
        [string]
      >(
        `SELECT raw_p50_wcet, raw_p90_wcet, cal_p50_wcet, cal_p90_wcet, refclass_as_of,
                shrink_w, wcet_rate, wcet_rate_src
           FROM estimate WHERE tid = ?`,
      )
      .get(tid)!;

    // Codex measured 16,000 / 26,000 here — 8 and 13 v2 points priced per V1 point.
    expect(row.cal_p50_wcet).toBe(row.raw_p50_wcet);
    expect(row.cal_p90_wcet).toBe(row.raw_p90_wcet);
    expect(row.cal_p50_wcet).toBe(8);
    // No provenance, because no reference class produced this band. The v1 snapshot's
    // `as_of` used to be stamped here, which is what made the row look calibrated.
    expect(row.refclass_as_of).toBeNull();
    expect(row.shrink_w).toBe(0);
    // And the refusal is a STORED FACT, not a coincidence between two columns.
    expect(row.wcet_rate).toBeNull();
    expect(row.wcet_rate_src).toBe("none");
  });

  test("a band whose rate was refused is unscorable at close, not scored at the old anchor's rate", async () => {
    flipToPoints();
    await fitARate(900);
    await bumpAnchor("v2", "add one CLI flag with a test");

    const at = "2026-03-02T00:00:00Z";
    turn(h.db, { session: "s-d1b", prompt: "p1", at, durationMs: 60_000 });
    const r = await h.cli(
      ...openArgs({ subject: "first v2 band, closed", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s-d1b", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    const tid = r.json<{ tid: string }>().tid;
    request(h.db, "rq-d1b", { session: "s-d1b", out: 20_000, ts: at });
    attributeTasks(h.db);
    expect((await h.cli("close", tid, "--force")).code).toBeLessThanOrEqual(3);

    const o = h.db
      .query<{ velocity_raw: number | null; velocity_cal: number | null; in_band: number | null }, [string]>(
        "SELECT velocity_raw, velocity_cal, in_band FROM v_outcome_current WHERE tid = ?",
      )
      .get(tid)!;
    // `velocity_raw` is the learning signal and stays meaningful: Work-CET per v2 point.
    expect(o.velocity_raw).toBeCloseTo(2500, 6);
    // The calibrated pair is not. Before the fix these came back as 1.25 and 0 — a
    // plausible-looking velocity and a recorded overrun, both computed against 8 points
    // dressed up as 16,000 Work-CET by a rate for a different-sized point.
    expect(o.velocity_cal).toBeNull();
    expect(o.in_band).toBeNull();
  });

  // -------------------------------------------------------------------------
  // v19, defect 3: `est refclass` never shows one anchor's number beside another's
  // -------------------------------------------------------------------------

  /**
   * Step 1 of the ceremony is the surface an estimator is required to read BEFORE stating
   * any number, so a stale multiplier there anchors the estimate directly. It used to
   * render `points→Work-CET: NO RATE YET` and, four lines down, `×2000.00 p50 · snapshot
   * <as_of>` off the v1 snapshot — with `anchor v2` in the header.
   */
  /**
   * `est repair-identity --apply` before the retro is what makes this fixture reproduce
   * the defect rather than merely assert the fix. `est open` files a brand-new session's
   * estimates under the repairable 'unknown' family (its own requests are not on disk
   * yet), so without the repair the snapshot is fitted under `unknown` while `est
   * refclass` resolves `claude-test-1` and finds no snapshot at all — the multiplier
   * would be absent for a reason that has nothing to do with the anchor.
   */
  async function fitARateAsThisEstimator(offset: number): Promise<void> {
    for (let i = 0; i < COLD_START_N; i += 1) await completed(offset + i, 20_000, 10, 20);
    expect((await h.cli("repair-identity", "--apply")).code).toBe(0);
    expect((await h.cli("retro")).code).toBeLessThanOrEqual(3);
  }

  test("`est refclass` shows no multiplier and no foreign-anchor matches after a bump", async () => {
    flipToPoints();
    await fitARateAsThisEstimator(1000);
    // The state the defect is visible from: a snapshot this estimator CAN read, fitted
    // at ~2,000 Work-CET per v1 point, and an anchor that is no longer v1.
    await bumpAnchor("v2", "add one CLI flag with a test");

    const out = (await h.cli("refclass", "--text", "sized work")).out;
    expect(out).toContain("anchor v2");
    expect(out).toContain("NO RATE YET");
    // The multiplier is the Work-CET-per-point rate under points. One of these two lines
    // was a lie, and it was this one.
    expect(out).not.toContain("×2000");
    expect(out).not.toMatch(/×[\d.]+ p50/);

    // ...and the match table is v2-only, which at this point means empty. Ten completed
    // v1 tasks used to be listed as the reference class for a v2 estimate, with their
    // v1 point counts under a "raw p50 (pts)" heading.
    const json = (await h.cli("refclass", "--text", "sized work", "--json")).json<{
      matches: unknown[];
      bucket: { n: number; mult_p50: number | null; n_eff: number | null; as_of: string | null };
    }>();
    expect(json.matches).toEqual([]);
    expect(json.bucket.mult_p50).toBeNull();
    expect(json.bucket.n_eff).toBeNull();
    expect(json.bucket.as_of).toBeNull();
    // The count is the anchor-local one, not the v1 corpus's ten.
    expect(json.bucket.n).toBe(0);

    // The control: back under v1, the same corpus is the reference class it always was,
    // multiplier and all. The fix is a denomination filter, not a blanket suppression.
    expect((await h.cli("config", "set", "sp_anchor_id", "v1")).code).toBe(0);
    const v1json = (await h.cli("refclass", "--text", "sized work", "--json")).json<{
      matches: unknown[];
      bucket: { n: number; mult_p50: number | null };
    }>();
    expect(v1json.matches.length).toBeGreaterThan(0);
    expect(v1json.bucket.n).toBe(COLD_START_N);
    expect(v1json.bucket.mult_p50).toBeCloseTo(2000, 6);
  });

  /**
   * The other suppression path, and the one whose PROSE matters: ten completed tasks at
   * the anchor in force, so the cold-start sentence ("below 10 comparable completed
   * tasks") would be visibly false beside `n=10` — but the snapshot behind the
   * multiplier was fitted across both anchors, so the multiplier is a median of two
   * different units and must not be shown.
   */
  test("`est refclass` names the anchor, not the sample count, when the snapshot is mixed", async () => {
    flipToPoints();
    for (let i = 0; i < COLD_START_N; i += 1) await completed(1100 + i, 20_000, 10, 20);
    await bumpAnchor("v2", "add one CLI flag with a test");
    for (let i = 0; i < COLD_START_N; i += 1) await completed(1200 + i, 60_000, 10, 20);
    expect((await h.cli("repair-identity", "--apply")).code).toBe(0);
    expect((await h.cli("retro", "--as-of", "2030-01-01T00:00:00Z")).code).toBeLessThanOrEqual(3);

    const out = (await h.cli("refclass", "--text", "sized work")).out;
    expect(out).toContain(`n=${COLD_START_N} at anchor v2`);
    expect(out).toContain("NO MULTIPLIER SHOWN");
    expect(out).not.toMatch(/×[\d.]+ p50/);
    expect(out).not.toContain("below 10 comparable completed tasks");
    // Every listed match is a v2 task. The v1 ten are a different unit and are gone.
    const json = (await h.cli("refclass", "--text", "sized work", "--json")).json<{
      matches: Array<{ subject: string }>;
    }>();
    expect(json.matches.length).toBeGreaterThan(0);
    for (const m of json.matches) {
      expect(Number(m.subject.replace("sized work ", ""))).toBeGreaterThanOrEqual(1200);
    }
  });
});

// ---------------------------------------------------------------------------
// 12 — a block's unit comes from its PARENT, not from ambient config
//      (v17, Codex finding 2)
// ---------------------------------------------------------------------------

/**
 * `est block` used to read `config.estimand` and `config.sp_anchor_id` to validate and
 * label its quantiles, then fetch only the parent `eid`. `estimate_block` stores neither
 * unit nor anchor and `v_block_accuracy` reads the unit off `estimate.estimand`, so a
 * Work-CET task blocked after `est config set estimand story_point` acquired an 8/13
 * POINT block that the shared guard then scored as Work-CET.
 *
 * It fires at CUTOVER, on any task open across the flip, which is every task in flight
 * the moment Craig throws the switch.
 */
describe("a block is denominated by the estimate it hangs off", () => {
  async function openWorkCet(): Promise<string> {
    const r = await h.cli(
      ...openArgs({ subject: "open before the cutover", "raw-p50": 200_000, "raw-p90": 600_000 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    return r.json<{ tid: string }>().tid;
  }

  test("a POINTS block is refused against a Work-CET parent", async () => {
    const tid = await openWorkCet();
    flipToPoints();
    const r = await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "8", "--p90", "13");
    // Exit 2: an invariant refusal, not a malformed command line. Retyping the numbers
    // cannot fix it.
    expect(r.code).toBe(2);
    expect(r.err).toContain("work_cet");
    expect(r.err).toContain(POINTS_ESTIMAND);
    // And nothing landed: `estimate_block` is append-only, so a stored mismatch would be
    // permanent.
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_block").get()!.n,
    ).toBe(0);
  });

  test("a Work-CET block is refused against a points parent", async () => {
    flipToPoints();
    const r0 = await h.cli(
      ...openArgs({ subject: "opened in points", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r0.code).toBe(0);
    const tid = r0.json<{ tid: string }>().tid;
    h.db.query("UPDATE config SET v = 'work_cet' WHERE k = 'estimand'").run();

    const r = await h.cli(
      "block", tid, "--phase", "0", "--title", "recon", "--p50", "120000", "--p90", "300000",
    );
    expect(r.code).toBe(2);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_block").get()!.n,
    ).toBe(0);
  });

  test("an ANCHOR bump is refused too — a point of v1 is not a point of v2", async () => {
    flipToPoints();
    const r0 = await h.cli(
      ...openArgs({ subject: "opened against v1", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r0.code).toBe(0);
    const tid = r0.json<{ tid: string }>().tid;
    await bumpAnchor("v2", "add one CLI flag with a test");

    const r = await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "3", "--p90", "5");
    expect(r.code).toBe(2);
    expect(r.err).toContain("v1");
    expect(r.err).toContain("v2");
  });

  test("the block's reported unit is the PARENT's, not config's", async () => {
    flipToPoints();
    const r0 = await h.cli(
      ...openArgs({ subject: "decomposed", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    const tid = r0.json<{ tid: string }>().tid;
    const r = await h.cli(
      "block", tid, "--phase", "0", "--title", "recon", "--p50", "3", "--p90", "5", "--json",
    );
    expect(r.code).toBe(0);
    expect(r.json<{ estimand: string }>().estimand).toBe(POINTS_ESTIMAND);
    expect(r.json<{ spAnchor: { id: string } }>().spAnchor.id).toBe("v1");
  });

  test("`est open --tid` across a flip is refused rather than re-denominated", async () => {
    const tid = await openWorkCet();
    flipToPoints();
    const r = await h.cli(
      "open", "--tid", tid, "--reason", "refinement", "--raw-p50", "8", "--raw-p90", "13",
      "--exp-agents", "1", "--exp-wf-phases", "0", "--exp-files-write", "2",
      "--exp-turns", "4", "--exp-requests", "20",
      "--session", "s1", "--prompt", "p1",
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("work_cet");
    // Only the baseline row exists: an 8-point band inside a Work-CET task would have
    // been unrecoverable, `estimate` being append-only.
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM estimate WHERE tid = ?").get(tid)!.n,
    ).toBe(1);
  });

  test("`est open --continue` across a flip is refused — it copies the previous band verbatim", async () => {
    const tid = await openWorkCet();
    flipToPoints();
    // `--continue` re-issues `prev.raw_p50_wcet` unchanged. Under the new estimand those
    // 200,000 Work-CET would have been stored as 200,000 POINTS (or bounced off
    // `sp_max_points` with a message about a flag the caller never typed).
    const r = await h.cli("open", "--continue", tid, "--session", "s1", "--prompt", "p1");
    expect(r.code).toBe(2);
    expect(r.err).toContain("estimand");
  });
});

// ---------------------------------------------------------------------------
// 12b — a REFUSED `--continue` binds nothing
// ---------------------------------------------------------------------------

/**
 * The refusal above is only half a refusal if the session binding survives it.
 *
 * `est open --continue <tid> --session <sid>` used to bind the session in `cmdOpen`,
 * BEFORE `openTask` ran the checks that can reject the continuation — and `bindTask`
 * commits in its own `.immediate()` transaction, so the refusal could not take it
 * back. A cutover continuation therefore exited 2, wrote no estimate, and still left
 * `sid -> tid` in `task_alias`; §5.4 then read that alias as the authority it is and
 * booked the session's next request to the task the system had just refused to
 * associate it with, `exclusive`, with nothing downstream able to tell.
 *
 * The bind belongs to `openTask`, which already writes it inside the same
 * `.immediate()` transaction as the estimate row (the `existingTid !== null` arm), so
 * the two land together or not at all. These two tests are the pair: refused binds
 * nothing, accepted still binds.
 */
describe("a refused `--continue` leaves no binding behind", () => {
  async function openWorkCet(session = "s1"): Promise<string> {
    const r = await h.cli(
      ...openArgs({ subject: "open before the cutover", "raw-p50": 200_000, "raw-p90": 600_000 }),
      "--session", session, "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    return r.json<{ tid: string }>().tid;
  }

  const sessionAliases = (session: string): string[] =>
    h.db
      .query<{ tid: string }, [string]>(
        "SELECT tid FROM task_alias WHERE id_kind = 'session' AND session_id = ?",
      )
      .all(session)
      .map((r) => r.tid);

  test("the rejected continuation writes no alias, and the next request is not booked to it", async () => {
    const tid = await openWorkCet("s1");
    flipToPoints();

    // The fork: a NEW session resumes the pre-cutover task.
    turn(h.db, { session: "s2", prompt: "q1", at: "2026-01-01T01:00:00Z", durationMs: 1000 });
    const r = await h.cli("open", "--continue", tid, "--session", "s2", "--prompt", "q1");
    expect(r.code).toBe(2);

    // No estimate was appended — the baseline is still the only row.
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM estimate WHERE tid = ?").get(tid)!.n,
    ).toBe(1);
    // ...and no binding either. This is the assertion the bug failed.
    expect(sessionAliases("s2")).toEqual([]);

    // The consequence, stated end to end: s2's spend falls to the residual rather than
    // to the task the continuation was refused for.
    request(h.db, "r-s2", { session: "s2", prompt: "q1", out: 1000, ts: "2026-01-01T01:00:01Z" });
    attributeTasks(h.db);
    const req = h.db
      .query<{ tid: string | null; attr: string }, [string]>(
        "SELECT tid, attr FROM request WHERE request_id = ?",
      )
      .get("r-s2")!;
    expect(req.tid).toBeNull();
    expect(req.attr).not.toBe("exclusive");
  });

  test("an ACCEPTED `--continue` still binds the resuming session", async () => {
    const tid = await openWorkCet("s1");
    // No flip: the continuation is legitimate and must land BOTH halves.
    turn(h.db, { session: "s2", prompt: "q1", at: "2026-01-01T01:00:00Z", durationMs: 1000 });
    const r = await h.cli("open", "--continue", tid, "--session", "s2", "--prompt", "q1", "--json");
    expect(r.code).toBe(0);
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM estimate WHERE tid = ?").get(tid)!.n,
    ).toBe(2);
    expect(sessionAliases("s2")).toEqual([tid]);

    // And the binding is live: the fork's request books to the task.
    request(h.db, "r-s2", { session: "s2", prompt: "q1", out: 1000, ts: "2026-01-01T01:00:01Z" });
    attributeTasks(h.db);
    expect(
      h.db
        .query<{ tid: string | null }, [string]>("SELECT tid FROM request WHERE request_id = ?")
        .get("r-s2")!.tid,
    ).toBe(tid);
  });
});

// ---------------------------------------------------------------------------
// 13 — `--from-blocks` NOTICES the old shape; it does not refuse it (v18)
// ---------------------------------------------------------------------------

/**
 * v17 added a mechanical guard here — reject when the rolled-up blocks belong to
 * `MIN(eid)` — and v18 DELETES it rather than repairing it, because it was wrong in both
 * directions:
 *
 *  - it missed the shape it was written for. An ordinary `est open --continue` creates
 *    eid2, so a task's first-ever blocks attach to `MAX(eid)` = eid2 and sail straight
 *    past a `MAX != MIN` test, while `est close` still scores the coarse eid1 baseline;
 *  - and it fired on a legitimately newly-discovered phase blocked onto eid1, which is a
 *    real refinement and the one shape `--from-blocks` exists for.
 *
 * The premise was wrong too. `--from-blocks` requires `--tid`, so it can only ever land
 * as a REFINEMENT, and a refinement is by design never the scored baseline — `est close`
 * fits from `MIN(eid)` on purpose, because first-estimate-wins is what makes baseline
 * accuracy a real measurement. A roll-up landing as a refinement was never going to be
 * the baseline and was never supposed to be. The actual defect was the CLI advertising
 * open-coarse-then-roll-up as the way to decompose, and that was fixed as guidance.
 *
 * What is left is a NON-BLOCKING notice, because blocks sitting on `MIN(eid)` does
 * indicate someone followed the withdrawn advice.
 */
describe("--from-blocks notices the opened-coarse shape without refusing it", () => {
  async function openAndBlock(): Promise<string> {
    flipToPoints();
    const r = await h.cli(
      ...openArgs({ subject: "opened coarse", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    const tid = r.json<{ tid: string }>().tid;
    await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "3", "--p90", "5");
    await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "8", "--p90", "13");
    return tid;
  }

  const rollUp = (tid: string, ...extra: string[]): Promise<{ code: number; err: string; json<T>(): T }> =>
    h.cli(
      "open", "--tid", tid, "--reason", "refinement", "--from-blocks",
      "--exp-agents", "2", "--exp-wf-phases", "2", "--exp-files-write", "4",
      "--exp-turns", "6", "--exp-requests", "40",
      "--session", "s1", "--prompt", "p1", ...extra,
    ) as never;

  test("the roll-up lands, and the shape is recorded rather than rejected", async () => {
    const tid = await openAndBlock();
    const r = await rollUp(tid, "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ raw: { p50: number; p90: number } }>().raw).toEqual({ p50: 11, p90: 18 });
    // The refinement exists...
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM estimate WHERE tid = ?").get(tid)!.n,
    ).toBe(2);
    // ...and so does the notice, in the ledger where `est census` will show it.
    const anomaly = h.db
      .query<{ detail: string }, [string]>(
        "SELECT detail FROM anomaly WHERE kind = 'from_blocks_on_baseline' AND tid = ?",
      )
      .get(tid);
    expect(anomaly?.detail).toContain("FIRST estimate");
  });

  /**
   * The direction the v17 guard got backwards. A phase discovered mid-task is blocked
   * onto whatever estimate is current — which, for a task that has only ever had one, is
   * `MIN(eid)`. That is a genuine re-sizing and the guard rejected it outright.
   */
  test("a newly-discovered phase on the first estimate rolls up instead of being refused", async () => {
    const tid = await openAndBlock();
    await h.cli("block", tid, "--phase", "2", "--title", "the phase nobody saw coming", "--p50", "5", "--p90", "8");
    const r = await rollUp(tid, "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ raw: { p50: number; p90: number } }>().raw).toEqual({ p50: 16, p90: 26 });
  });

  /**
   * The direction the v17 guard MISSED. `--continue` mints eid2 without any blocks of its
   * own; the first-ever blocks then attach to eid2, so `MAX != MIN` holds and the guard
   * passed — while `est close` still scored the coarse eid1 baseline. A guard that admits
   * exactly the case it was written to catch is not a guard.
   */
  test("the shape the old guard let through is the same shape, and it still rolls up", async () => {
    flipToPoints();
    const opened = await h.cli(
      ...openArgs({ subject: "opened coarse then continued", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(opened.code).toBe(0);
    const tid = opened.json<{ tid: string }>().tid;
    // eid2, with no blocks yet.
    expect((await h.cli("open", "--continue", tid, "--session", "s1", "--prompt", "p1")).code).toBe(0);
    await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "3", "--p90", "5");
    await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "8", "--p90", "13");

    const r = await rollUp(tid, "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ raw: { p50: number; p90: number } }>().raw).toEqual({ p50: 11, p90: 18 });
    // No notice: the blocks are not on MIN(eid), which is exactly why the mechanical test
    // could never see this case.
    expect(
      h.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'from_blocks_on_baseline' AND tid = ?",
        )
        .get(tid)!.n,
    ).toBe(0);
    // And `est close` still scores eid1 — which is the fact that made the guard
    // unnecessary, not the fact that made it needed.
    expect(
      h.db.query<{ eid: number }, [string]>("SELECT MIN(eid) AS eid FROM estimate WHERE tid = ?").get(tid)!.eid,
    ).toBe(
      h.db
        .query<{ eid: number }, [string]>("SELECT eid FROM estimate WHERE tid = ? AND version = 1")
        .get(tid)!.eid,
    );
  });

  test("a genuine later refinement still rolls up", async () => {
    const tid = await openAndBlock();
    const mid = await h.cli(
      "open", "--tid", tid, "--reason", "refinement", "--raw-p50", "11", "--raw-p90", "18",
      "--exp-agents", "2", "--exp-wf-phases", "2", "--exp-files-write", "4",
      "--exp-turns", "6", "--exp-requests", "40",
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(mid.code).toBe(0);
    // The phases were re-sized, which is only expressible against the NEW estimate.
    await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "5", "--p90", "8");
    await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "13", "--p90", "21");
    const r = await rollUp(tid, "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ raw: { p50: number; p90: number } }>().raw).toEqual({ p50: 18, p90: 29 });
  });

  /**
   * The notice reaches BOTH surfaces or it reaches nobody who matters. The estimating
   * skill drives `est open --json` and never reads the human render; a person at a
   * terminal reads the human render and never parses the JSON. `anomaly` catches neither
   * of them at the moment they are deciding what to do.
   */
  test("the notice is emitted on stderr AND in --json, and the exit code is untouched", async () => {
    const tid = await openAndBlock();
    const r = await rollUp(tid, "--json");
    // Advisory, so: still 0. This is the whole difference from the v17 refusal.
    expect(r.code).toBe(0);
    const notice = r.json<{ rollup_notice: string | null }>().rollup_notice;
    expect(notice).not.toBeNull();
    expect(notice).toContain("FIRST estimate");
    // Stderr carries the same text, prefixed like every other `est open` advisory, and
    // stdout stays the single parseable object the `--json` contract promises.
    expect(r.err).toContain("est open: NOTICE");
    expect(r.err).toContain("FIRST estimate");
    expect(() => r.json<Record<string, unknown>>()).not.toThrow();
    // ...and the ledger has it too, which is what `est census` reads.
    expect(
      h.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'from_blocks_on_baseline' AND tid = ?",
        )
        .get(tid)!.n,
    ).toBe(1);
  });

  test("the HUMAN render emits it too — the surface a person is actually looking at", async () => {
    const tid = await openAndBlock();
    const r = await rollUp(tid);
    expect(r.code).toBe(0);
    expect(r.err).toContain("est open: NOTICE");
    expect(r.err).toContain("canonical order");
  });

  /**
   * The other direction, which is what makes the notice mean anything: a roll-up whose
   * blocks hang off a LATER estimate is an ordinary re-sizing, and saying nothing about
   * it is the point. A notice on every roll-up would be noise the reader learns to skip.
   */
  test("a roll-up above the baseline emits no notice on either surface", async () => {
    const tid = await openAndBlock();
    const mid = await h.cli(
      "open", "--tid", tid, "--reason", "refinement", "--raw-p50", "11", "--raw-p90", "18",
      "--exp-agents", "2", "--exp-wf-phases", "2", "--exp-files-write", "4",
      "--exp-turns", "6", "--exp-requests", "40",
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(mid.code).toBe(0);
    await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "5", "--p90", "8");
    await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "13", "--p90", "21");

    const r = await rollUp(tid, "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ rollup_notice: string | null }>().rollup_notice).toBeNull();
    expect(r.err).not.toContain("est open: NOTICE");
    expect(
      h.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'from_blocks_on_baseline' AND tid = ?",
        )
        .get(tid)!.n,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14 — `estimate.procedure_version` (v17)
// ---------------------------------------------------------------------------

/**
 * Four things fix what a band means: the model, the prices, the unit, and the
 * INSTRUCTION that produced the number. The first three were versioned and pinned onto
 * every row; the fourth was not — and inside the Work-CET era it changed twice in one
 * day (raw-as-floor, then uncorrected judgement), leaving two different measurements
 * pooled in one reference class with nothing on the rows to separate them. `estimate` is
 * append-only, so no later pass could have added the distinction.
 *
 * It enters no pooling key today. It only has to be RECORDED.
 */
describe("procedure_version", () => {
  async function openOne(subject: string): Promise<{ tid: string; procedure: string | null }> {
    const r = await h.cli(
      ...openArgs({ subject, "raw-p50": 100_000, "raw-p90": 300_000 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    const tid = r.json<{ tid: string }>().tid;
    const procedure = h.db
      .query<{ v: string | null }, [string]>(
        "SELECT procedure_version AS v FROM estimate WHERE tid = ? ORDER BY eid DESC LIMIT 1",
      )
      .get(tid)!.v;
    return { tid, procedure };
  }

  test("the value in force is pinned onto the band", async () => {
    const seeded = h.db
      .query<{ v: string }, []>("SELECT v FROM config WHERE k = 'procedure_version'")
      .get()!.v;
    expect(seeded).not.toBe("");
    expect((await openOne("first")).procedure).toBe(seeded);
  });

  test("a later change does not reach back — each band keeps the procedure that made it", async () => {
    const first = await openOne("under the old procedure");
    expect((await h.cli("config", "set", "procedure_version", "2026-08-01-decompose-first")).code).toBe(0);
    const second = await openOne("under the new procedure");

    expect(second.procedure).toBe("2026-08-01-decompose-first");
    expect(first.procedure).not.toBe(second.procedure);
    // The point of the column: the old row still says what it always said. `estimate` is
    // append-only, so this is the ONLY way the distinction could ever exist.
    expect(
      h.db
        .query<{ v: string | null }, [string]>(
          "SELECT procedure_version AS v FROM estimate WHERE tid = ? ORDER BY eid ASC LIMIT 1",
        )
        .get(first.tid)!.v,
    ).toBe(first.procedure);
  });

  test("unset means NULL — a vintage nobody stated is not the current one", async () => {
    h.db.query("UPDATE config SET v = '' WHERE k = 'procedure_version'").run();
    expect((await openOne("no procedure recorded")).procedure).toBeNull();
  });

  // Recorded on the row is not the same as VISIBLE. `est open --json` is the estimating
  // skill's only view of the band it just filed, and the field was computed, carried on
  // `OpenResult` and written to the database while being dropped on the way out — so the
  // one consumer that could report which procedure produced a number could not read it.
  test("`est open --json` emits it, beside the other things that fix what the band means", async () => {
    const inForce = h.db
      .query<{ v: string }, []>("SELECT v FROM config WHERE k = 'procedure_version'")
      .get()!.v;
    const r = await h.cli(
      ...openArgs({ subject: "procedure on the wire", "raw-p50": 100_000, "raw-p90": 300_000 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    const body = r.json<{ procedure_version: string | null; tid: string }>();
    expect(body.procedure_version).toBe(inForce);
    // The payload agrees with the row it just wrote — the JSON is a report of what was
    // stored, not a second computation of it.
    expect(
      h.db
        .query<{ v: string | null }, [string]>(
          "SELECT procedure_version AS v FROM estimate WHERE tid = ? ORDER BY eid DESC LIMIT 1",
        )
        .get(body.tid)!.v,
    ).toBe(body.procedure_version);

    // Unset is `null` on the wire, not an absent key and not "": a consumer must be able
    // to tell "no vintage was stated" from "the field is gone".
    h.db.query("UPDATE config SET v = '' WHERE k = 'procedure_version'").run();
    const bare = await h.cli(
      ...openArgs({ subject: "no procedure on the wire", "raw-p50": 100_000, "raw-p90": 300_000 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(bare.code).toBe(0);
    const parsed = JSON.parse(bare.out) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "procedure_version")).toBe(true);
    expect(parsed.procedure_version).toBeNull();
  });

  test("it is snapshotted for a Work-CET band too, not only for points", async () => {
    const wcet = await openOne("work_cet band");
    expect(wcet.procedure).not.toBeNull();
    flipToPoints();
    const r = await h.cli(
      ...openArgs({ subject: "points band", "raw-p50": 8, "raw-p90": 13 }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    expect(
      h.db
        .query<{ v: string | null }, [string]>(
          "SELECT procedure_version AS v FROM estimate WHERE tid = ?",
        )
        .get(r.json<{ tid: string }>().tid)!.v,
    ).toBe(wcet.procedure);
  });
});

// ---------------------------------------------------------------------------
// 15 — schema migration 16 -> 17
// ---------------------------------------------------------------------------

describe("schema migration 16 -> 17", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "est-sp-migrate17-"));
    db = openDb({ path: join(dir, "estimator.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a v16 database migrates to exactly the shape schema.sql builds", () => {
    db.exec(`
      -- Newest first, for the reason the 14 -> 15 test spells out: a v16 file that still
      -- carried v19's pair would have \`procedure_version\` spliced in behind it.
      ALTER TABLE estimate DROP COLUMN wcet_rate_src;
      ALTER TABLE estimate DROP COLUMN wcet_rate;
      ALTER TABLE estimate DROP COLUMN procedure_version;
      DROP VIEW v_velocity;
      CREATE VIEW v_velocity AS
      SELECT e.bucket, i.estimator_model, e.price_epoch, e.refclass_as_of,
             e.ref_model, e.estimand,
             o.velocity_raw, o.velocity_cal, o.finalized_at,
             o.wcet_main, o.wcet_sub, o.wcet_aux,
             o.wcet_main + o.wcet_sub AS wcet_task_effort,
             e.exp_agents, o.n_agents
      FROM v_outcome_current o
      JOIN estimate e ON e.eid = o.eid_at_start
      JOIN v_estimate_identity i ON i.eid = e.eid
      WHERE o.scope_changed = 0 AND o.censored = 0 AND o.final_status = 'completed'
        AND o.unpriced_share = 0 AND o.price_provisional = 0
        AND o.actual_wcet_at_epoch IS NOT NULL;
      DELETE FROM config WHERE k = 'procedure_version';
      UPDATE config SET v = '16' WHERE k = 'schema_version';
    `);
    // Migration rule 2: a value Craig has already tuned survives untouched.
    db.query("UPDATE config SET v='999' WHERE k='shrink_k'").run();
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='shrink_k'").get()?.v).toBe("999");
    expect(
      db.query<{ v: string }, []>("SELECT v FROM config WHERE k='procedure_version'").get()?.v,
    ).toBe("2026-07-31-uncorrected-judgement");

    const freshDir = mkdtempSync(join(tmpdir(), "est-sp-fresh17-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const objects = (d: Database): unknown =>
        d
          .query<{ type: string; name: string; sql: string | null }, []>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      expect(objects(db)).toEqual(objects(fresh));
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("the step is idempotent against a file that already has the shape", () => {
    const path = join(dir, "estimator.db");
    db.query("UPDATE config SET v = '16' WHERE k = 'schema_version'").run();
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM pragma_table_info('estimate') WHERE name='procedure_version'",
        )
        .get()!.n,
    ).toBe(1);
  });

  test("a pre-v17 row keeps NULL: the column widens rows, it does not backfill a vintage", () => {
    // A row that exists BEFORE the column does is of genuinely unknown vintage, and
    // stamping today's procedure onto it would manufacture the very claim the column
    // exists to make honestly.
    db.exec(`
      ALTER TABLE estimate DROP COLUMN procedure_version;
      UPDATE config SET v = '16' WHERE k = 'schema_version';
      INSERT INTO task (tid, kind, status, created_at, anchor_session, anchor_prompt)
        VALUES ('t-old', 'implement', 'estimating', '2026-01-01T00:00:00Z', 's0', 'p0');
      INSERT INTO task_scope (tid, seq, ts, subject, description, dod_json, scope_hash, source, reason, diff_summary)
        VALUES ('t-old', 1, '2026-01-01T00:00:00Z', 'legacy', NULL, '[]', 'h', 'est_open', NULL, NULL);
      INSERT INTO estimate (tid, version, created_at, reason, scope_seq, raw_p50_wcet, raw_p90_wcet,
                            exp_agents, exp_wf_phases, exp_files_write, exp_turns, exp_requests,
                            bucket, bucket_n, refclass_as_of, shrink_w, cal_p50_wcet, cal_p90_wcet,
                            cal_req_p50, cal_req_p90, price_epoch, ref_model, estimand, estimator_model)
        VALUES ('t-old', 1, '2026-01-01T00:00:00Z', 'initial', 1, 1000, 3000,
                1, 0, 1, 1, 1, 'global', 0, NULL, 0, 1000, 3000, 1, 1,
                '2026-01-01T00:00:00Z', 'claude-sonnet-4-5', 'work_cet', 'unknown');
    `);
    const path = join(dir, "estimator.db");
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      db
        .query<{ v: string | null }, []>("SELECT procedure_version AS v FROM estimate WHERE tid = 't-old'")
        .get()!.v,
    ).toBeNull();
  });
});

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
    h.db.query("UPDATE config SET v = 'v2' WHERE k = 'sp_anchor_id'").run();
    h.db.query("UPDATE config SET v = 'add one CLI flag with a test' WHERE k = 'sp_anchor_text'").run();

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

  test("--from-blocks issues the SUM of the block estimates as the task band", async () => {
    const tid = await openTid(true);
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
    await h.cli("config", "set", "sp_anchor_id", "v2");
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
        ('sp_anchor_id','sp_anchor_text','sp_seed_wcet_per_point','sp_seed_anchor_id','sp_max_points');
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
    expect(r.alerts.join(" ")).toContain("unit_refusal");

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

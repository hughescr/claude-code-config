/**
 * `est burn`, the statusline and the board when the BAND is in story points (v15).
 *
 * One rule holds every test here together: **never a percentage, a projection or an
 * overrun warning that compares two different units.** The actual is always log-derived
 * Work-CET; the band, since `config.estimand = 'story_point'`, may be a count of points
 * against a fixed anchor. Those two are not divisible, and a system whose entire design
 * premise is that a confident wrong figure is the failure mode to avoid may not print
 * `0.006% of p50` because 41,000 Work-CET happened to land beside a band of 8.
 *
 * Three states, and every surface is asserted in all three:
 *
 *  1. **No rate.** `pointsToWcet` has neither a fitted rate nor a seed — the common
 *     case today, since no seed is set. `wcet.p50`/`p90`/`pct_*` are NULL by contract
 *     (never the points number in a Work-CET field), the points band travels in its own
 *     object, and no `over_p50`/`over_p90`/`minutes_to_p90` is issued.
 *  2. **A seed rate.** A convention reasoned to, backed by no completed work: the band
 *     converts, the percentage is real arithmetic, and every surface marks it with the
 *     probation `?` that `check_back` already established for a provisional number.
 *  3. **A fitted rate.** Measured from completed story-point tasks, on the same
 *     cold-start floor as every other multiplier: converted, source named, no `?`.
 *
 * Plus the one that must not move: a legacy Work-CET band behaves exactly as it did
 * before any of this existed.
 *
 * Fixtures are synthetic (`test/support.ts`); prices are $1/Mtok, so Work-CET is
 * numerically `out_tok + cw_tok`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, openArgs, request, seedPrices, turn, type Harness } from "./support.ts";
import {
  bandUnit,
  burnJson,
  currentBand,
  refreshBurnCache,
  renderBurn,
  type BurnActive,
} from "../src/burn.ts";
import { board } from "../src/retro.ts";
import { renderBoardHtml, renderBoardMd } from "../src/board-render.ts";
import { attributeTasks } from "../src/attribute.ts";
import { COLD_START_N, POINTS_ESTIMAND } from "../src/tasks.ts";
import { formatSegment } from "../scripts/statusline-burn.ts";

let h: Harness;

const NOW = new Date("2026-01-01T00:03:00Z");

beforeEach(() => {
  h = makeHarness("est-burn-points-");
  seedPrices(h.db);
  turn(h.db, { session: "s1", prompt: "p1", at: "2026-01-01T00:00:00Z", durationMs: 60_000 });
});

afterEach(() => {
  h.close();
});

function flipToPoints(): void {
  h.db.query("UPDATE config SET v = ? WHERE k = 'estimand'").run(POINTS_ESTIMAND);
}

function setSeed(wcetPerPoint: string, anchor = "v1"): void {
  h.db.query("UPDATE config SET v = ? WHERE k = 'sp_seed_wcet_per_point'").run(wcetPerPoint);
  h.db.query("UPDATE config SET v = ? WHERE k = 'sp_seed_anchor_id'").run(anchor);
}

/**
 * One open task with `wcet` Work-CET of attributed spend, bound to session `s7` so the
 * statusline is allowed to render it, and a fresh cache row.
 *
 * `p50`/`p90` are in whatever `config.estimand` currently is — 8/13 points, or 1000/3000
 * Work-CET — which is the whole point: the CALLER states the unit and every surface has
 * to work it out from the row.
 */
async function taskWithSpend(
  opts: { p50: number; p90: number; wcet: number; subject?: string } = {
    p50: 8,
    p90: 13,
    wcet: 41_000,
  },
): Promise<string> {
  const r = await h.cli(
    ...openArgs({
      subject: opts.subject ?? "widget pipeline rewrite",
      "raw-p50": opts.p50,
      "raw-p90": opts.p90,
    }),
    "--session", "s1", "--prompt", "p1", "--json",
  );
  expect(r.code).toBe(0);
  const tid = r.json<{ tid: string }>().tid;
  request(h.db, `r-main-${tid}`, { origin: "main", out: opts.wcet, ts: "2026-01-01T00:01:00Z" });
  attributeTasks(h.db);
  await h.cli("bind", tid, "--session", "s7");
  refreshBurnCache(h.db, NOW);
  return tid;
}

/** Ten completed 10-point tasks at 20,000 Work-CET each — 2,000 Work-CET per point —
 *  then a retro to snapshot the refclass `pointsToWcet` reads back as `fitted`. */
async function fitARate(): Promise<void> {
  for (let i = 0; i < COLD_START_N; i += 1) {
    const session = `sp${i}`;
    const at = `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`;
    turn(h.db, { session, prompt: "p1", at, durationMs: 60_000 });
    const r = await h.cli(
      ...openArgs({ subject: `sized work ${i}`, "raw-p50": 10, "raw-p90": 20 }),
      "--session", session, "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    request(h.db, `rq-sp-${i}`, { session, out: 20_000, ts: at });
    attributeTasks(h.db);
    expect((await h.cli("close", r.json<{ tid: string }>().tid, "--force")).code).toBeLessThanOrEqual(3);
  }
  expect((await h.cli("retro")).code).toBeLessThanOrEqual(3);
}

// ---------------------------------------------------------------------------
// 1 — currentBand must be able to say what unit it holds
// ---------------------------------------------------------------------------

describe("currentBand projects the unit", () => {
  test("estimand and sp_anchor_id come back on the row, for both estimands", async () => {
    const legacy = await taskWithSpend({ p50: 1000, p90: 3000, wcet: 500, subject: "legacy" });
    const legacyBand = currentBand(h.db, legacy)!;
    expect(legacyBand.estimand).toBe("work_cet");
    expect(legacyBand.sp_anchor_id).toBeNull();

    flipToPoints();
    const pts = await taskWithSpend({ p50: 8, p90: 13, wcet: 41_000, subject: "points" });
    const ptsBand = currentBand(h.db, pts)!;
    expect(ptsBand.estimand).toBe(POINTS_ESTIMAND);
    expect(ptsBand.sp_anchor_id).toBe("v1");
    // And the raw band, which is the points themselves — the only honest thing to show
    // when nothing can convert them.
    expect(ptsBand.raw_p50_wcet).toBe(8);
    expect(ptsBand.raw_p90_wcet).toBe(13);
  });

  test("bandUnit reads a Work-CET row straight through and asks the bridge nothing", async () => {
    const tid = await taskWithSpend({ p50: 1000, p90: 3000, wcet: 500, subject: "legacy" });
    expect(bandUnit(h.db, currentBand(h.db, tid)!)).toEqual({ p50: 1000, p90: 3000, points: null });
  });
});

// ---------------------------------------------------------------------------
// 2 — no rate: the state the whole fix exists for
// ---------------------------------------------------------------------------

describe("a points band with NO points→Work-CET rate", () => {
  async function noRate(): Promise<BurnActive> {
    flipToPoints();
    const tid = await taskWithSpend();
    return burnJson(h.db, { tid, now: NOW }) as BurnActive;
  }

  test("the JSON contract nulls every Work-CET band field rather than emitting points", async () => {
    const b = await noRate();
    // The KEY SET is untouched — this is an extension, not a break (P2.0's rule).
    expect(Object.keys(b.wcet).sort()).toEqual(["consumed", "p50", "p90", "pct_p50", "pct_p90"]);
    expect(b.schema).toBe(1);
    // Consumed is a real measurement and stays.
    expect(b.wcet.consumed).toBe(41_000);
    // The band is not. `8` must never appear in a field named after Work-CET.
    expect(b.wcet.p50).toBeNull();
    expect(b.wcet.p90).toBeNull();
    expect(b.wcet.pct_p50).toBeNull();
    expect(b.wcet.pct_p90).toBeNull();
    // ...and it is not lost either: it travels in its own object, in its own unit.
    expect(b.points).toEqual({
      p50: 8,
      p90: 13,
      anchor_id: "v1",
      rate: null,
      rate_source: null,
      rate_n: 0,
      converted: null,
    });
    expect(b.band.estimand).toBe(POINTS_ESTIMAND);
    expect(b.band.sp_anchor_id).toBe("v1");
  });

  test("the same answer arrives through burnRead — the READ-ONLY, query_only path", async () => {
    // `bandUnit` asks the bridge again when the band on disk is still points, and the
    // statusline's connection is opened `readonly` with `PRAGMA query_only=ON` and a
    // 50 ms busy timeout. A lookup that needed a write (or a lock) would turn the
    // segment into an empty result, silently, on Craig's screen — this is the test that
    // says it does not.
    flipToPoints();
    const tid = await taskWithSpend();
    const r = await h.cli("burn", tid, "--json");
    expect(r.code).toBe(0);
    const b = r.json<BurnActive>();
    expect(b.active).toBe(true);
    expect(b.wcet.p50).toBeNull();
    expect(b.points).toMatchObject({ p50: 8, p90: 13, rate: null });
  });

  test("no overrun warning and no projection to p90 — consumed dwarfs the band NUMBER, not the band", async () => {
    const b = await noRate();
    // 41,000 >= 13 is arithmetic that means nothing. The old code fired over_p90 here.
    expect(b.warn).not.toContain("over_p90");
    expect(b.warn).not.toContain("over_p50");
    expect(b.projection.minutes_to_p90).toBeNull();
  });

  test("`est burn` shows both, side by side, with no percentage and no bar", async () => {
    const b = await noRate();
    const text = renderBurn(b);
    expect(text).toContain("41k WCET consumed");
    expect(text).toContain("band 8 / 13 points (anchor v1)");
    expect(text).toContain("NOT COMPARABLE");
    expect(text).toContain("no points→Work-CET rate");
    // No percentage of any kind, and no bar glyph: a bar is a fraction.
    expect(text).not.toMatch(/% of p50/);
    expect(text).not.toMatch(/% of p90/);
    expect(text).not.toContain("█");
    expect(text).not.toContain("░");
  });

  test("the statusline stays USEFUL: consumed, the band with its unit, and why there is no %", async () => {
    flipToPoints();
    const tid = await taskWithSpend();
    const seg = formatSegment(burnJson(h.db, { tid, session: "s7", now: NOW }));
    expect(seg).toContain("41k WCET");
    expect(seg).toContain("band 8/13 pt");
    expect(seg).toContain("no pt→WCET rate");
    // Terse: it shares one line with the model, the branch and the context bar.
    expect(seg.length).toBeLessThan(80);
    // And not one percentage, nor the p90 warning glyph.
    expect(seg).not.toContain("%");
    expect(seg).not.toContain("⚠");
  });

  test("the board draws no bar, colours no zone, and says so on every renderer", async () => {
    flipToPoints();
    await taskWithSpend();
    const report = board(h.db, { now: NOW });
    const card = report.columns.flatMap((c) => c.cards).find((c) => c.subject.startsWith("widget"))!;
    // `cal_*` are 0 — "no Work-CET band", which is what `burnZone`'s `> 0` guards read
    // as no claim. Crucially they are NOT 8 and 13.
    expect(card.cal_p50).toBe(0);
    expect(card.cal_p90).toBe(0);
    expect(card.points).toMatchObject({ p50: 8, p90: 13, rate: null, converted: null });

    const md = renderBoardMd(report);
    expect(md).toContain("8 / 13 pt (anchor v1)");
    expect(md).toContain("NOT COMPARABLE");

    const html = renderBoardHtml(report);
    expect(html).toContain("8 / 13 pt (anchor v1)");
    expect(html).toContain("no points→Work-CET rate yet");
    // No fill element for this card means no zone class can have been applied.
    expect(html).not.toContain("bar-fill critical");
    expect(html).not.toContain("bar-fill warning");
  });

  test("the terminal board column marks the unit and legends it", async () => {
    flipToPoints();
    await taskWithSpend();
    const r = await h.cli("board");
    expect(r.code).toBe(0);
    expect(r.out).toContain("8 pt");
    expect(r.out).toContain("13 pt");
    expect(r.out).toContain("pt = STORY POINTS");
    expect(r.out).toContain("NOT comparable with the consumed column");
  });
});

// ---------------------------------------------------------------------------
// 3 — a SEED rate: converted, and marked provisional everywhere
// ---------------------------------------------------------------------------

describe("a points band converted through the SEED rate", () => {
  test("converts at OPEN time when the seed was already set, and names the source", async () => {
    flipToPoints();
    setSeed("5000");
    const tid = await taskWithSpend();
    const b = burnJson(h.db, { tid, now: NOW }) as BurnActive;

    // 8 points x 5,000 Work-CET/point. The seed converts BOTH ends (it is one rate,
    // not a distribution), so p90 is 13 x 5,000.
    expect(b.wcet.p50).toBe(40_000);
    expect(b.wcet.p90).toBe(65_000);
    expect(b.wcet.pct_p50).toBeCloseTo(102.5, 1);
    expect(b.points).toMatchObject({
      p50: 8,
      p90: 13,
      rate: 5000,
      rate_source: "seed",
      converted: "at_open",
    });
    // A real comparison exists now, so the overrun warning is legitimate again.
    expect(b.warn).toContain("over_p50");
  });

  test("converts at READ time when the seed arrived after the band was issued", async () => {
    flipToPoints();
    const tid = await taskWithSpend();
    expect((burnJson(h.db, { tid, now: NOW }) as BurnActive).wcet.p50).toBeNull();

    setSeed("5000");
    const b = burnJson(h.db, { tid, now: NOW }) as BurnActive;
    expect(b.wcet.p50).toBe(40_000);
    expect(b.points).toMatchObject({ rate: 5000, rate_source: "seed", converted: "at_read" });
    expect(renderBurn(b)).toContain("applied at READ time");
  });

  test("`est burn` marks the percentages `?` and explains what the marker costs", async () => {
    flipToPoints();
    setSeed("5000");
    const tid = await taskWithSpend();
    const text = renderBurn(burnJson(h.db, { tid, now: NOW }) as BurnActive);
    expect(text).toMatch(/%\? of p50/);
    expect(text).toMatch(/%\? of p90/);
    expect(text).toContain("× 5k Work-CET/point (seed)");
    expect(text).toContain("? = SEED-DERIVED");
    expect(text).toContain("backed by NO completed story-point task");
  });

  test("the statusline shows a real percentage, marked `?`", async () => {
    flipToPoints();
    setSeed("5000");
    const tid = await taskWithSpend();
    const seg = formatSegment(burnJson(h.db, { tid, session: "s7", now: NOW }));
    expect(seg).toContain("41k/40k WCET");
    expect(seg).toMatch(/%\? p50/);
  });

  test("the board draws the bar again, names the rate and carries the `?`", async () => {
    flipToPoints();
    setSeed("5000");
    await taskWithSpend();
    const report = board(h.db, { now: NOW });
    const card = report.columns.flatMap((c) => c.cards).find((c) => c.subject.startsWith("widget"))!;
    expect(card.cal_p50).toBe(40_000);
    expect(card.cal_p90).toBe(65_000);

    const md = renderBoardMd(report);
    expect(md).toContain("Work-CET/pt (seed)");
    expect(md).toContain(" ?)");
    const html = renderBoardHtml(report);
    expect(html).toContain("bar-fill");
    expect(html).toContain("a bootstrapped convention, not measured");
  });
});

// ---------------------------------------------------------------------------
// 4 — a FITTED rate: converted, source named, and NO provisional marker
// ---------------------------------------------------------------------------

describe("a points band converted through a FITTED rate", () => {
  test("converts, reports the sample size, and earns no `?`", async () => {
    flipToPoints();
    await fitARate();
    const tid = await taskWithSpend();
    const b = burnJson(h.db, { tid, now: NOW }) as BurnActive;

    expect(b.points?.rate_source).toBe("fitted");
    expect(b.points?.rate).toBeCloseTo(2000, -2);
    expect(b.wcet.p50).not.toBeNull();
    expect(b.wcet.pct_p50).not.toBeNull();

    const text = renderBurn(b);
    expect(text).toContain("Work-CET/point (fitted");
    // Measured, not conventional: no probation marker and no seed footnote.
    expect(text).not.toContain("? = SEED-DERIVED");
    expect(text).not.toMatch(/%\? of p50/);
    expect(formatSegment(burnJson(h.db, { tid, session: "s7", now: NOW }))).not.toContain("%?");
  });
});

// ---------------------------------------------------------------------------
// 5 — the regression that must not happen: a Work-CET band is untouched
// ---------------------------------------------------------------------------

describe("a legacy Work-CET band behaves exactly as before", () => {
  test("percentages, warnings, projection and the bar are all unchanged", async () => {
    const tid = await taskWithSpend({ p50: 1000, p90: 3000, wcet: 1500, subject: "legacy" });
    const b = burnJson(h.db, { tid, now: NOW }) as BurnActive;

    expect(b.points).toBeNull();
    expect(b.wcet).toEqual({ consumed: 1500, p50: 1000, p90: 3000, pct_p50: 150, pct_p90: 50 });
    expect(b.band.estimand).toBe("work_cet");
    expect(b.band.sp_anchor_id).toBeNull();
    expect(b.warn).toContain("over_p50");

    const text = renderBurn(b);
    expect(text).toContain("2k/1k WCET (150% of p50, 50% of p90)");
    expect(text).toContain("█");
    // No points vocabulary reaches a Work-CET render, in any of its forms.
    expect(text).not.toContain("point");
    expect(text).not.toContain(" pt");
    expect(text).not.toContain("NOT COMPARABLE");

    const seg = formatSegment(burnJson(h.db, { tid, session: "s7", now: NOW }));
    expect(seg).toContain("2k/1k WCET");
    expect(seg).toContain("150% p50");
    expect(seg).not.toContain("?");
    expect(seg).not.toContain("pt");

    const md = renderBoardMd(board(h.db, { now: NOW }));
    expect(md).toContain("band 1k/3k * · consumed 2k");
    expect(md).not.toContain("pt (anchor");
    expect(md).not.toContain("Work-CET/pt");
  });

  test("the terminal board prints no points legend when no card is in points", async () => {
    await taskWithSpend({ p50: 1000, p90: 3000, wcet: 1500, subject: "legacy" });
    const r = await h.cli("board");
    expect(r.out).not.toContain("pt = STORY POINTS");
    expect(r.out).not.toContain("SEED rate");
  });
});

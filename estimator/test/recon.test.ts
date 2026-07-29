/**
 * test/recon.test.ts — the four-axis reconciliation and the certification criterion
 * (P2.6).
 *
 * Two of P2.13's mandated tests live here:
 *
 *  - **metric temporality**: a delta series sums, a cumulative series is DIFFERENCED
 *    per series, and a window mixing the two is REFUSED. Summing a mixed window would
 *    produce a number that looks like a reconciliation and is arithmetic nonsense.
 *  - **the certification NEGATIVE case**: four weeks of ≤2% delta at 30% join must NOT
 *    certify. That is the 82.8%-coverage failure mode in a new place — a number that
 *    looks like agreement and is an artefact of what was never measured.
 *
 * Every id, price and counter here is synthetic (§4).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getConfig } from "../src/db.ts";
import {
  computeRecon,
  evaluateCertification,
  parseWindow,
  RETIRED_KEY,
  theirsForMetric,
  unvalidatedRetired,
  writeRecon,
} from "../src/recon.ts";
import { makeHarness, request, seedPrices, turn, type Harness } from "./support.ts";

let h: Harness;
let db: Database;

beforeEach(() => {
  h = makeHarness("est-recon-");
  db = h.db;
  seedPrices(db);
});

afterEach(() => {
  h.close();
});

const WINDOW = { start: "2026-03-01T00:00:00Z", end: "2026-03-08T00:00:00Z" };

function metric(
  name: string,
  value: number,
  over: {
    ts?: string;
    temporality?: "delta" | "cumulative" | "unspecified";
    session?: string;
    tokenType?: string;
    unit?: string;
  } = {},
): void {
  db.query(
    `INSERT INTO otel_metric (metric, ts, session_id, model, query_source, token_type,
                              value, unit, temporality, received_at)
     VALUES (?,?,?,'','',?,?,?,?,'2026-03-08T00:00:00Z')`,
  ).run(
    name,
    over.ts ?? "2026-03-02T00:00:00Z",
    over.session ?? "",
    over.tokenType ?? "",
    value,
    over.unit ?? null,
    over.temporality ?? "delta",
  );
}

function otelRequest(id: string, ts = "2026-03-02T00:00:00Z"): void {
  db.query(
    "INSERT INTO otel_request (request_id, session_id, ts, received_at) VALUES (?, 's1', ?, ?)",
  ).run(id, ts, ts);
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

describe("parseWindow", () => {
  test("defaults to seven days, accepts <n>d and an explicit ISO range", () => {
    const now = new Date("2026-03-08T00:00:00Z");
    expect(parseWindow(null, now)).toEqual({ start: "2026-03-01T00:00:00Z", end: "2026-03-08T00:00:00Z" });
    expect(parseWindow("2d", now).start).toBe("2026-03-06T00:00:00Z");
    expect(parseWindow("2026-01-01T00:00:00Z/2026-01-08T00:00:00Z", now)).toEqual({
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-08T00:00:00Z",
    });
  });

  test("a malformed or inverted window is a loud failure, not a silent default", () => {
    expect(() => parseWindow("last week")).toThrow(/--window/);
    expect(() => parseWindow("2026-02-01T00:00:00Z/2026-01-01T00:00:00Z")).toThrow(/--window/);
  });
});

// ---------------------------------------------------------------------------
// temporality — the MANDATED test
// ---------------------------------------------------------------------------

describe("temporality decides whether summing is legal", () => {
  test("a DELTA series sums", () => {
    metric("claude_code.cost.usage", 1, { ts: "2026-03-02T00:00:00Z" });
    metric("claude_code.cost.usage", 2, { ts: "2026-03-03T00:00:00Z" });
    expect(theirsForMetric(db, "claude_code.cost.usage", WINDOW)).toEqual({ value: 3, note: null });
  });

  test("a CUMULATIVE series is DIFFERENCED per series, never summed", () => {
    // One monotone counter per session, each already running when the window opened —
    // which is what the pre-window point states rather than assumes. Summing would
    // report 10+40 + 20+50 = 120 instead of the 30 + 30 = 60 actually spent inside it.
    const cum = { temporality: "cumulative" as const };
    metric("claude_code.token.usage", 10, { ts: "2026-02-28T00:00:00Z", ...cum, session: "sA" });
    metric("claude_code.token.usage", 20, { ts: "2026-02-28T00:00:00Z", ...cum, session: "sB" });
    metric("claude_code.token.usage", 10, { ts: "2026-03-02T00:00:00Z", ...cum, session: "sA" });
    metric("claude_code.token.usage", 40, { ts: "2026-03-04T00:00:00Z", ...cum, session: "sA" });
    metric("claude_code.token.usage", 20, { ts: "2026-03-02T00:00:00Z", ...cum, session: "sB" });
    metric("claude_code.token.usage", 50, { ts: "2026-03-04T00:00:00Z", ...cum, session: "sB" });
    const r = theirsForMetric(db, "claude_code.token.usage", WINDOW);
    expect(r.value).toBe(60);
    expect(r.note).toContain("differenced per series");
    expect(r.note).toContain("2 series differenced against their last pre-window point");
  });

  test("a cumulative counter that RESET counts its post-reset value, not a negative", () => {
    const cum = { temporality: "cumulative" as const, session: "sA" };
    metric("claude_code.token.usage", 100, { ts: "2026-02-28T00:00:00Z", ...cum });
    metric("claude_code.token.usage", 100, { ts: "2026-03-02T00:00:00Z", ...cum });
    metric("claude_code.token.usage", 7, { ts: "2026-03-04T00:00:00Z", ...cum });
    expect(theirsForMetric(db, "claude_code.token.usage", WINDOW).value).toBe(7);
  });

  /**
   * The three ways endpoint-differencing lost data, each reachable from an ordinary
   * process restart and each silent. Pinned because the axes these feed drive
   * `evaluateCertification`, so an under-count reads as a delta and blocks (or, with the
   * sign the other way, buys) retirement of `[unvalidated]`.
   */
  test("a series that reported ONCE in the window still contributes", () => {
    // first === last, so endpoint-differencing returned 0 for the whole session.
    metric("claude_code.token.usage", 5000, {
      ts: "2026-03-02T00:00:00Z",
      temporality: "cumulative",
      session: "sA",
    });
    expect(theirsForMetric(db, "claude_code.token.usage", WINDOW).value).toBe(5000);
  });

  test("the pre-window baseline is carried, so the window's FIRST point is not thrown away", () => {
    const cum = { temporality: "cumulative" as const, session: "sA" };
    metric("claude_code.token.usage", 0, { ts: "2026-02-28T23:00:00Z", ...cum });
    metric("claude_code.token.usage", 1000, { ts: "2026-03-02T00:00:00Z", ...cum });
    metric("claude_code.token.usage", 1500, { ts: "2026-03-04T00:00:00Z", ...cum });
    // 1500 - 0, not 1500 - 1000: the first in-window point is a MEASUREMENT of what was
    // spent since the baseline, not the baseline itself.
    expect(theirsForMetric(db, "claude_code.token.usage", WINDOW).value).toBe(1500);
  });

  test("a MID-window reset keeps its pre-reset segment", () => {
    const cum = { temporality: "cumulative" as const, session: "sA" };
    metric("claude_code.token.usage", 100, { ts: "2026-02-28T00:00:00Z", ...cum });
    metric("claude_code.token.usage", 100, { ts: "2026-03-02T00:00:00Z", ...cum });
    metric("claude_code.token.usage", 200, { ts: "2026-03-03T00:00:00Z", ...cum });
    metric("claude_code.token.usage", 10, { ts: "2026-03-04T00:00:00Z", ...cum });
    metric("claude_code.token.usage", 50, { ts: "2026-03-05T00:00:00Z", ...cum });
    // (200-100) + 50. Reading the endpoints alone sees 100 … 50, floors at 50 and
    // discards the entire pre-reset segment.
    const r = theirsForMetric(db, "claude_code.token.usage", WINDOW);
    expect(r.value).toBe(150);
    expect(r.note).toContain("1 counter reset(s) kept their pre-reset segment");
  });

  test("a series with NO pre-window point is counted from 0, and says so", () => {
    const cum = { temporality: "cumulative" as const, session: "sA" };
    metric("claude_code.token.usage", 300, { ts: "2026-03-02T00:00:00Z", ...cum });
    metric("claude_code.token.usage", 400, { ts: "2026-03-04T00:00:00Z", ...cum });
    const r = theirsForMetric(db, "claude_code.token.usage", WINDOW);
    expect(r.value).toBe(400);
    // The inference is NAMED rather than hidden: nothing in `otel_metric` records when
    // a series began, so "it started inside the window" is a choice, not a fact.
    expect(r.note).toContain("no pre-window point");
  });

  test("a MIXED window is REFUSED — it has no legal sum", () => {
    metric("claude_code.cost.usage", 1, { ts: "2026-03-02T00:00:00Z", temporality: "delta" });
    metric("claude_code.cost.usage", 2, { ts: "2026-03-03T00:00:00Z", temporality: "cumulative" });
    const r = theirsForMetric(db, "claude_code.cost.usage", WINDOW);
    expect(r.value).toBeNull();
    expect(r.note).toContain("mixes temporalities");
  });

  test("points with no temporality are refused rather than assumed summable", () => {
    metric("claude_code.active_time.total", 60, { temporality: "unspecified" });
    const r = theirsForMetric(db, "claude_code.active_time.total", WINDOW);
    expect(r.value).toBeNull();
    expect(r.note).toContain("not summable");
  });

  test("an empty window answers null with a reason, never zero", () => {
    // Zero would enter the corpus as "they measured nothing spent", which is a
    // measurement rather than the absence of one.
    expect(theirsForMetric(db, "claude_code.cost.usage", WINDOW)).toEqual({
      value: null,
      note: "no claude_code.cost.usage points in the window",
    });
  });

  test("the window is closed-open, so two adjacent runs never double-count a point", () => {
    metric("claude_code.cost.usage", 5, { ts: WINDOW.start });
    metric("claude_code.cost.usage", 7, { ts: WINDOW.end });
    expect(theirsForMetric(db, "claude_code.cost.usage", WINDOW).value).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// the four axes
// ---------------------------------------------------------------------------

describe("computeRecon", () => {
  test("compares all four axes and reports the join coverage beside them", () => {
    request(db, "r1", { out: 100, ts: "2026-03-02T00:00:00Z" });
    request(db, "r2", { out: 100, ts: "2026-03-03T00:00:00Z" });
    otelRequest("r1");
    otelRequest("r2");
    // usd_out is 1.0 per Mtok in the harness, so 200 output tokens = 0.0002 USD.
    metric("claude_code.cost.usage", 0.0002);
    metric("claude_code.token.usage", 200);
    turn(db, { at: "2026-03-02T00:00:00Z", durationMs: 60_000 });
    metric("claude_code.active_time.total", 60);

    const r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` });
    const byAxis = Object.fromEntries(r.axes.map((a) => [a.axis, a]));
    expect(byAxis.usd?.delta_pct).toBe(0);
    expect(byAxis.tokens?.ours).toBe(200);
    expect(byAxis.tokens?.delta_pct).toBe(0);
    expect(byAxis.active_s?.ours).toBe(60);
    expect(byAxis.active_s?.delta_pct).toBe(0);
    expect(byAxis.requests?.ours).toBe(2);
    expect(byAxis.requests?.theirs).toBe(2);
    expect(r.join_pct).toBe(100);
    expect(r.anomalies).toHaveLength(0);
  });

  test("an axis past recon_alert_pct alerts and writes recon_mismatch", () => {
    request(db, "r1", { out: 100, ts: "2026-03-02T00:00:00Z" });
    otelRequest("r1");
    metric("claude_code.cost.usage", 0.00005); // ours is 2x theirs
    const r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` });
    const usd = r.axes.find((a) => a.axis === "usd");
    expect(usd?.delta_pct).toBe(100);
    expect(usd?.alert).toBe(true);
    expect(r.anomalies[0]?.kind).toBe("recon_mismatch");
  });

  test("an axis OTEL cannot answer is null with a note, and is NOT persisted as zero", () => {
    request(db, "r1", { out: 100, ts: "2026-03-02T00:00:00Z" });
    const r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` });
    for (const a of r.axes) {
      expect(a.theirs).toBeNull();
      expect(a.delta_pct).toBeNull();
      expect(a.alert).toBe(false);
    }
    db.transaction(() => writeRecon(db, r)).immediate();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM recon").get()?.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM recon_metric").get()?.n).toBe(0);
  });

  test("the interval UNION is what active_s compares — an async fan-out is not summed", () => {
    // Two agents running concurrently for a minute each is ONE minute of active time.
    // A sum would report two and disagree with Anthropic's figure for a reason that
    // has nothing to do with our data.
    db.query(
      `INSERT INTO agent_run (agent_id, session_id, spawn_depth, status, started_at, ended_at, interval_src)
       VALUES ('a1','s1',1,'completed','2026-03-02T00:00:00Z','2026-03-02T00:01:00Z','transcript'),
              ('a2','s1',1,'completed','2026-03-02T00:00:00Z','2026-03-02T00:01:00Z','transcript')`,
    ).run();
    const r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` });
    expect(r.axes.find((a) => a.axis === "active_s")?.ours).toBe(60);
  });

  test("a request duration OTEL supplied counts toward active time", () => {
    // The 27%-of-turns case: a turn with no `turn_duration` contributes nothing to the
    // union, and per-request durations fill exactly those turns.
    request(db, "r1", { ts: "2026-03-02T00:00:00Z", durationMs: 30_000 });
    const r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` });
    expect(r.axes.find((a) => a.axis === "active_s")?.ours).toBe(30);
  });

  /**
   * §7.5 calls this axis the union's first external check. It is only that to the
   * extent the union does NOT come from OTEL — and `request.duration_ms` is a column
   * OTEL writes and nothing else does, so seconds it supplies sit on both sides of the
   * comparison. The share is measured every run rather than assumed away.
   */
  test("active_s reports how much of OUR union only OTEL could have supplied", () => {
    // Transcript-only: a turn with its own duration. Fully independent of OTEL.
    turn(db, { session: "s1", at: "2026-03-02T00:00:00Z", durationMs: 60_000 });
    let r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` });
    let axis = r.axes.find((a) => a.axis === "active_s")!;
    expect(axis.ours).toBe(60);
    expect(axis.otel_derived_pct).toBe(0);

    // Now a request duration OTEL filled, outside every transcript interval: half the
    // union's seconds are OTEL's own.
    request(db, "r1", { ts: "2026-03-03T00:00:00Z", durationMs: 60_000 });
    r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` });
    axis = r.axes.find((a) => a.axis === "active_s")!;
    expect(axis.ours).toBe(120);
    expect(axis.otel_derived_pct).toBe(50);
    expect(axis.note).toContain("NOT an independent check");
    // Only this axis carries the share; the others are not interval unions at all.
    expect(r.axes.find((a) => a.axis === "usd")?.otel_derived_pct).toBeNull();
  });

  test("--source restricts which axes run", () => {
    const r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}`, axes: ["usd"] });
    expect(r.axes.map((a) => a.axis)).toEqual(["usd"]);
  });

  test("join_pct counts OUR requests OTEL also saw", () => {
    request(db, "r1", { ts: "2026-03-02T00:00:00Z" });
    request(db, "r2", { ts: "2026-03-02T00:00:00Z" });
    request(db, "r3", { ts: "2026-03-02T00:00:00Z" });
    request(db, "r4", { ts: "2026-03-02T00:00:00Z" });
    otelRequest("r1");
    expect(computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` }).join_pct).toBe(25);
  });
});

describe("writeRecon", () => {
  test("writes one recon row for USD and one recon_metric row per other axis", () => {
    request(db, "r1", { out: 100, ts: "2026-03-02T00:00:00Z" });
    otelRequest("r1");
    metric("claude_code.cost.usage", 0.0001);
    metric("claude_code.token.usage", 100);
    const r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` });
    db.transaction(() => writeRecon(db, r)).immediate();

    expect(
      db.query<{ source: string; delta: number }, []>("SELECT source, delta_pct AS delta FROM recon").get(),
    ).toEqual({ source: "otel_cost", delta: 0 });
    const metrics = db
      .query<{ metric: string; source: string; join_pct: number }, []>(
        "SELECT metric, source, join_pct FROM recon_metric ORDER BY metric",
      )
      .all();
    expect(metrics.map((m) => m.metric)).toEqual(["requests", "tokens"]);
    // join_pct travels on EVERY row: a delta is only meaningful against the coverage it
    // was computed on.
    expect(metrics.every((m) => m.join_pct === 100)).toBe(true);
  });

  test("re-running the same as_of updates in place rather than failing on the key", () => {
    request(db, "r1", { out: 100, ts: "2026-03-02T00:00:00Z" });
    otelRequest("r1");
    metric("claude_code.cost.usage", 0.0001);
    const r = computeRecon(db, { window: `${WINDOW.start}/${WINDOW.end}` });
    db.transaction(() => {
      writeRecon(db, r);
      writeRecon(db, r);
    }).immediate();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM recon").get()?.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// certification — the MANDATED negative case
// ---------------------------------------------------------------------------

/** One weekly recon + its `requests` companion, at a chosen delta and join. */
function week(index: number, deltaPct: number, joinPct: number | null): void {
  const start = new Date(Date.UTC(2026, 0, 5 + index * 7));
  const end = new Date(start.getTime() + 7 * 86400_000);
  const asOf = `${end.toISOString().slice(0, 19)}Z`;
  db.query(
    `INSERT INTO recon (as_of, source, window_start, window_end, ours_usd, theirs_usd, delta_pct, note)
     VALUES (?, 'otel_cost', ?, ?, 100, 100, ?, NULL)`,
  ).run(asOf, `${start.toISOString().slice(0, 19)}Z`, `${end.toISOString().slice(0, 19)}Z`, deltaPct);
  if (joinPct === null) return;
  db.query(
    `INSERT INTO recon_metric (as_of, metric, source, window_start, window_end,
                               ours, theirs, delta_pct, join_pct, unit, note)
     VALUES (?, 'requests', 'otel_request', ?, ?, 10, 10, 0, ?, 'requests', NULL)`,
  ).run(asOf, `${start.toISOString().slice(0, 19)}Z`, `${end.toISOString().slice(0, 19)}Z`, joinPct);
}

describe("the criterion that retires [unvalidated]", () => {
  test("four consecutive clean weeks certify, and only --certify's caller may write the key", () => {
    for (let i = 0; i < 4; i += 1) week(i, 1.0, 99);
    const dry = evaluateCertification(db, { apply: false });
    expect(dry.certified).toBe(true);
    expect(getConfig(db, RETIRED_KEY)).toBeNull(); // apply:false wrote nothing

    const applied = evaluateCertification(db, { apply: true, now: new Date("2026-02-02T00:00:00Z") });
    expect(applied.certified).toBe(true);
    expect(applied.retired_at).toBe("2026-02-02T00:00:00Z");
    expect(unvalidatedRetired(db)).toBe(true);
  });

  test("MANDATED: four weeks inside 2% at 30% join must NOT certify", () => {
    // The trivially-passing case. A week in which the receiver was down for six days
    // produces a tiny delta on a tiny base; without the join floor the system would
    // certify itself on the strength of missing data.
    for (let i = 0; i < 4; i += 1) week(i, 1.0, 30);
    const r = evaluateCertification(db, { apply: true });
    expect(r.certified).toBe(false);
    expect(r.reason).toContain("30%");
    expect(r.reason).toContain("agreement with nothing");
    expect(getConfig(db, RETIRED_KEY)).toBeNull();
  });

  test("a week with no join figure at all does not count as clean", () => {
    for (let i = 0; i < 4; i += 1) week(i, 1.0, i === 3 ? null : 99);
    expect(evaluateCertification(db, { apply: false }).certified).toBe(false);
  });

  test("one week outside the delta tolerance is enough to refuse", () => {
    for (let i = 0; i < 4; i += 1) week(i, i === 1 ? 5.0 : 1.0, 99);
    const r = evaluateCertification(db, { apply: false });
    expect(r.certified).toBe(false);
    expect(r.reason).toContain("tolerance");
  });

  test("fewer weeks than required is a refusal with a count, not a pass", () => {
    week(0, 0.5, 99);
    const r = evaluateCertification(db, { apply: false });
    expect(r.certified).toBe(false);
    expect(r.weeks_examined).toBe(1);
    expect(r.reason).toContain("4 consecutive clean weeks are required");
  });

  test("a GAP in the weeks is not four consecutive weeks", () => {
    // Silence is not evidence: a missing week means the receiver was not running.
    week(0, 1, 99);
    week(1, 1, 99);
    week(2, 1, 99);
    week(6, 1, 99);
    const r = evaluateCertification(db, { apply: false });
    expect(r.certified).toBe(false);
    expect(r.reason).toContain("not consecutive");
  });

  test("retirement is ROLLING: a later breaching week clears the key again", () => {
    for (let i = 0; i < 4; i += 1) week(i, 1.0, 99);
    evaluateCertification(db, { apply: true });
    expect(unvalidatedRetired(db)).toBe(true);

    // A fifth week breaches the join floor — the marker comes back. A validation that
    // cannot expire is not a validation.
    week(4, 1.0, 10);
    const r = evaluateCertification(db, { apply: true });
    expect(r.certified).toBe(false);
    expect(r.cleared).toBe(true);
    expect(unvalidatedRetired(db)).toBe(false);
  });
});

describe("the statusline marker", () => {
  test("est burn --json reports unvalidated until the key exists, and false once it does", async () => {
    const opened = await h.cli(
      "open",
      "--kind",
      "implement",
      "--subject",
      "widget pipeline rewrite",
      "--raw-p50",
      "1000",
      "--raw-p90",
      "3000",
      "--exp-agents",
      "1",
      "--exp-wf-phases",
      "0",
      "--exp-files-write",
      "2",
      "--exp-turns",
      "3",
      "--exp-requests",
      "10",
      "--session",
      "s1",
      "--prompt",
      "p1",
      "--json",
    );
    expect(opened.code).toBe(0);
    const tid = opened.json<{ tid: string }>().tid;

    // `--refresh` computes the payload live, so the test does not depend on a sweep
    // having written the cache row first.
    const before = await h.cli("burn", tid, "--refresh", "--json");
    expect(before.json<{ unvalidated: boolean }>().unvalidated).toBe(true);

    for (let i = 0; i < 4; i += 1) week(i, 1.0, 99);
    evaluateCertification(db, { apply: true });

    const after = await h.cli("burn", tid, "--refresh", "--json");
    expect(after.json<{ unvalidated: boolean }>().unvalidated).toBe(false);
  });
});

describe("est recon (the verb)", () => {
  test("--dry-run prints the axes, writes nothing and takes no lock", async () => {
    request(db, "r1", { out: 100, ts: "2026-03-02T00:00:00Z" });
    otelRequest("r1");
    metric("claude_code.cost.usage", 0.0001);
    const r = await h.cli("recon", "--window", `${WINDOW.start}/${WINDOW.end}`, "--dry-run", "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ schema: number; wrote: boolean }>().schema).toBe(1);
    expect(r.json<{ wrote: boolean }>().wrote).toBe(false);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM recon").get()?.n).toBe(0);
  });

  test("a breached axis exits 3 and lands a recon_mismatch row", async () => {
    request(db, "r1", { out: 100, ts: "2026-03-02T00:00:00Z" });
    otelRequest("r1");
    metric("claude_code.cost.usage", 0.00005);
    const r = await h.cli("recon", "--window", `${WINDOW.start}/${WINDOW.end}`);
    expect(r.code).toBe(3);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind='recon_mismatch'").get()?.n,
    ).toBe(1);
  });

  test("an agreeing window exits 0 and writes the rows", async () => {
    request(db, "r1", { out: 100, ts: "2026-03-02T00:00:00Z" });
    otelRequest("r1");
    metric("claude_code.cost.usage", 0.0001);
    metric("claude_code.token.usage", 100);
    const r = await h.cli("recon", "--window", `${WINDOW.start}/${WINDOW.end}`);
    expect(r.code).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM recon").get()?.n).toBe(1);
  });

  test("--certify without the criterion met leaves the marker in place and says why", async () => {
    for (let i = 0; i < 4; i += 1) week(i, 1.0, 30);
    const r = await h.cli("recon", "--certify", "--json");
    expect(r.code).toBe(0);
    const cert = r.json<{ certification: { certified: boolean; reason: string } }>().certification;
    expect(cert.certified).toBe(false);
    expect(getConfig(db, RETIRED_KEY)).toBeNull();
  });

  test("a plain run CLEARS a stale retirement but never grants one", async () => {
    for (let i = 0; i < 4; i += 1) week(i, 1.0, 99);
    // Without --certify the criterion may be met and the marker still must not be
    // retired: granting is an explicit act.
    const plain = await h.cli("recon", "--json");
    expect(getConfig(db, RETIRED_KEY)).toBeNull();
    expect(plain.json<{ certification: { reason: string } }>().certification.reason).toContain("--certify");

    await h.cli("recon", "--certify");
    expect(unvalidatedRetired(db)).toBe(true);

    // …and a plain run afterwards, with a breaching week, takes it away.
    week(4, 1.0, 10);
    await h.cli("recon");
    expect(unvalidatedRetired(db)).toBe(false);
  });

  test("a plain run leaves an ALREADY-granted retirement alone while the weeks stay clean", async () => {
    // The weekly cron leg is a plain `est recon`. Keying the undo off
    // `retired_at !== null` made that leg revoke the marker a previous `--certify`
    // had legitimately granted, so the marker could never survive its own cron —
    // and nothing breached, so nothing said why.
    for (let i = 0; i < 4; i += 1) week(i, 1.0, 99);
    await h.cli("recon", "--certify");
    expect(unvalidatedRetired(db)).toBe(true);
    const grantedAt = getConfig(db, RETIRED_KEY);

    const plain = await h.cli("recon", "--json");
    expect(plain.code).toBe(0);
    expect(unvalidatedRetired(db)).toBe(true);
    expect(getConfig(db, RETIRED_KEY)).toBe(grantedAt);
    const cert = plain.json<{
      certification: { certified: boolean; retired_at: string | null; granted: boolean; cleared: boolean; reason: string };
    }>().certification;
    expect(cert.certified).toBe(true);
    expect(cert.retired_at).toBe(grantedAt);
    expect(cert.granted).toBe(false);
    expect(cert.cleared).toBe(false);
    expect(cert.reason).not.toContain("--certify");
  });

  test("--certify and --dry-run together are a usage error, not a silent no-write", async () => {
    const r = await h.cli("recon", "--certify", "--dry-run");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--dry-run");
  });

  test("an unknown --source axis is refused by name", async () => {
    const r = await h.cli("recon", "--source", "dollars");
    expect(r.code).toBe(1);
    expect(r.err).toContain("dollars");
  });
});

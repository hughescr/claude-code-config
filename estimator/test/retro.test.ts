/**
 * `est board` and `est retro` — the read model and the write-back that makes the
 * ceremony non-inert (P1.8, §7.4).
 *
 * `est retro` is the only verb that writes a `refclass` snapshot, and a snapshot is
 * what the NEXT estimate inherits — so the tests here are mostly about restraint:
 *
 *  - `--dry-run` computes and writes NOTHING (it is the right habit while n is small);
 *  - the panel groups by `(ref_model, estimand)` and never pools across units;
 *  - candidate bucket splits are RECORDED, never auto-applied;
 *  - an alerting panel exits 3 rather than printing a clean-looking zero;
 *  - refinements are scored BESIDE baseline calibration, never blended into it.
 *
 * `est board` is a projection over views that already exist, so its tests are about
 * the column mapping and the cold-start marker rather than about arithmetic.
 *
 * Fixtures are synthetic (`test/support.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeHarness,
  openArgs,
  request,
  seedPrices,
  turn,
  type Harness,
} from "./support.ts";
import { attributeTasks } from "../src/attribute.ts";
import { closeTask } from "../src/close.ts";
import { board, retro, BOARD_COLUMNS, ATTR_COVERAGE_GATE } from "../src/retro.ts";

let h: Harness;

const LONG_AGO = "2026-01-01T00:00:00Z";
const NOW = new Date("2026-02-01T00:00:00Z");

beforeEach(() => {
  h = makeHarness("est-retro-");
  seedPrices(h.db);
});

afterEach(() => {
  h.close();
});

/**
 * One complete, quiescent, priced task: turn -> estimate -> one attributed request.
 * `actualOut` is the Work-CET it consumed, so `actualOut / rawP50` is its velocity.
 */
async function completedTask(
  n: number,
  opts: { rawP50?: number; actualOut?: number; subject?: string; close?: boolean } = {},
): Promise<string> {
  const session = `s${n}`;
  const at = `2026-01-0${(n % 9) + 1}T00:00:00Z`;
  turn(h.db, { session, prompt: "p1", at, durationMs: 60_000 });
  const r = await h.cli(
    ...openArgs({
      subject: opts.subject ?? `task number ${n}`,
      "raw-p50": opts.rawP50 ?? 1000,
      "raw-p90": (opts.rawP50 ?? 1000) * 3,
    }),
    "--session",
    session,
    "--prompt",
    "p1",
    "--json",
  );
  expect(r.code).toBe(0);
  const tid = r.json<{ tid: string }>().tid;
  request(h.db, `req-${n}`, { session, out: opts.actualOut ?? 1000, ts: at });
  attributeTasks(h.db);
  if (opts.close !== false) closeTask(h.db, { tid, now: NOW });
  return tid;
}

// ---------------------------------------------------------------------------
// P1.8 — est board
// ---------------------------------------------------------------------------

describe("est board — P1.8", () => {
  test("an empty board is every column, empty, at exit 0", async () => {
    const r = await h.cli("board", "--json");
    expect(r.code).toBe(0);
    const body = r.json<{ columns: Array<{ column: string; cards: unknown[] }> }>();
    expect(body.columns.map((c) => c.column)).toEqual([...BOARD_COLUMNS]);
    for (const col of body.columns) expect(col.cards).toEqual([]);
  });

  test("a freshly opened task lands in Estimating with its band and cold-start marker", async () => {
    await completedTask(1, { close: false });
    const r = await h.cli("board", "--json");
    const body = r.json<{ columns: Array<{ column: string; cards: Array<{ subject: string; uncalibrated: boolean; cal_p50: number }> }> }>();
    const estimating = body.columns.find((c) => c.column === "Estimating")!;
    expect(estimating.cards).toHaveLength(1);
    expect(estimating.cards[0]!.subject).toBe("task number 1");
    expect(estimating.cards[0]!.uncalibrated).toBe(true);
    expect(estimating.cards[0]!.cal_p50).toBe(1000);

    const human = await h.cli("board");
    expect(human.out).toContain("Estimating (1)");
    expect(human.out).toContain("* = uncalibrated");
  });

  test("a closed task moves to Done (7d) and an abandoned one to Abandoned", async () => {
    const done = await completedTask(2);
    const gone = await completedTask(3, { close: false });
    closeTask(h.db, { tid: gone, status: "abandoned", now: NOW });

    // `now` is inside the 7-day window of the finalization timestamp.
    const b = board(h.db, { now: NOW });
    const col = (name: string): string[] =>
      b.columns.find((c) => c.column === name)!.cards.map((c) => c.tid);
    expect(col("Done (7d)")).toEqual([done]);
    expect(col("Abandoned")).toEqual([gone]);
  });

  test("Done (7d) means 7 days: an older completion drops off rather than accumulating", async () => {
    await completedTask(4);
    const b = board(h.db, { now: new Date("2026-06-01T00:00:00Z") });
    expect(b.columns.find((c) => c.column === "Done (7d)")!.cards).toEqual([]);
  });

  test("--status selects one column and --limit caps each", async () => {
    await completedTask(5, { close: false });
    await completedTask(6, { close: false });
    const r = await h.cli("board", "--status", "estimating", "--limit", "1", "--json");
    const body = r.json<{ columns: Array<{ column: string; cards: unknown[] }> }>();
    expect(body.columns).toHaveLength(1);
    expect(body.columns[0]!.cards).toHaveLength(1);
  });

  test("board never writes and never takes the lock", async () => {
    await completedTask(7, { close: false });
    const before = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n;
    expect((await h.cli("board")).code).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n).toBe(before);
    expect(await Bun.file(h.lockPath).exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1.8 — est retro
// ---------------------------------------------------------------------------

describe("est retro — P1.8", () => {
  test("--dry-run computes and writes nothing", async () => {
    await completedTask(1);
    const r = await h.cli("retro", "--dry-run", "--json");
    expect(r.code).toBe(0);
    const body = r.json<{ dry_run: boolean; written: { refclass: number; calib_run: number } }>();
    expect(body.dry_run).toBe(true);
    expect(body.written).toEqual({ refclass: 0, calib_run: 0 });
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM refclass").get()?.n).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM calib_run").get()?.n).toBe(0);
  });

  test("a real run writes one refclass snapshot per (bucket, estimator_family) and one calib_run", async () => {
    await completedTask(1);
    await completedTask(2);
    const report = retro(h.db, { asOf: NOW });
    expect(report.written.calib_run).toBe(1);
    expect(report.written.refclass).toBe(report.buckets.length);
    expect(report.buckets.length).toBeGreaterThan(0);

    const snap = h.db.query<{ bucket: string; estimator_family: string; n: number; params_json: string }, []>(
      "SELECT bucket, estimator_family, n, params_json FROM refclass",
    ).get()!;
    expect(snap.bucket).toBe("global");
    expect(snap.n).toBe(2);
    // ref_model is not a refclass column, so it rides in params_json — without it a
    // snapshot could be read back against a different normaliser and silently mean
    // something else.
    expect(JSON.parse(snap.params_json)).toMatchObject({ ref_model: "claude-sonnet-4-5" });
  });

  test("refclass is append-only: a second retro adds a snapshot, it does not edit one", async () => {
    await completedTask(1);
    retro(h.db, { asOf: NOW });
    retro(h.db, { asOf: new Date("2026-02-08T00:00:00Z") });
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM refclass").get()?.n).toBe(2);
    expect(() => h.db.query("UPDATE refclass SET n = 99").run()).toThrow(/append-only/);
  });

  test("a second retro at the SAME --as-of is REJECTED (exit 2) with the append path named", async () => {
    // `refclass` is keyed on (as_of, bucket, estimator_family, ref_model, estimand) and
    // append-only, so the second write is a constraint failure. Left to the driver it
    // surfaced as exit 1 with a raw `UNIQUE constraint failed:` line — which reads as
    // "transient, retry it", the exact response P1.12 exists to prevent.
    await completedTask(1);
    expect((await h.cli("retro", "--as-of", "2026-02-01T00:00:00Z")).code).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM refclass").get()?.n).toBe(1);

    const again = await h.cli("retro", "--as-of", "2026-02-01T00:00:00Z");
    expect(again.code).toBe(2);
    expect(again.err).toContain("already exists");
    expect(again.err).toContain("est: instead:");
    expect(again.err).toContain("--dry-run");
    // Nothing half-written: the check runs before the transaction.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM refclass").get()?.n).toBe(1);
  });

  test("the same rejection is typed at the library boundary, not just at the CLI", async () => {
    // `verb()` maps a raw SQLITE_CONSTRAINT to exit 2 as a backstop, but a caller of
    // `retro()` gets the InvariantError itself — with the remedy — rather than a
    // driver message it would have to pattern-match.
    await completedTask(1);
    retro(h.db, { asOf: NOW });
    expect(() => retro(h.db, { asOf: NOW })).toThrow(/already exists/);
  });

  test("velocity is measured, not asserted: a 3x overrun produces a ~3x multiplier", async () => {
    for (let i = 1; i <= 12; i += 1) await completedTask(i, { rawP50: 1000, actualOut: 3000 });
    const report = retro(h.db, { asOf: NOW });
    const fit = report.buckets[0]!;
    expect(fit.n).toBe(12);
    expect(fit.median_velocity).toBeCloseTo(3, 1);
    // Shrinkage toward the global median is a no-op when the bucket IS the global set,
    // so the multiplier lands on the measurement rather than short of it.
    expect(fit.mult_p50).toBeCloseTo(3, 1);
    expect(fit.mult_p90).toBeGreaterThanOrEqual(fit.mult_p50);
  });

  test("the snapshot is what `est open` then calibrates against — cold start ends at n = 10", async () => {
    for (let i = 1; i <= 12; i += 1) await completedTask(i, { rawP50: 1000, actualOut: 3000 });
    retro(h.db, { asOf: NOW });

    turn(h.db, { session: "s-new", prompt: "p1", at: LONG_AGO, durationMs: 1000 });
    const r = await h.cli(
      ...openArgs({ subject: "the next task", "raw-p50": 1000, "raw-p90": 3000 }),
      "--session", "s-new", "--prompt", "p1", "--json",
    );
    const body = r.json<{ uncalibrated: boolean; band: { p50_wcet: number }; raw: { p50: number } }>();
    expect(body.uncalibrated).toBe(false);
    expect(body.raw.p50).toBe(1000);
    // The whole point of the loop: the raw self-estimate is treated as a floor and
    // corrected upward by the estimator's own measured history.
    expect(body.band.p50_wcet).toBeGreaterThan(2000);
  });

  test("a snapshot is never read back in a unit it was not fitted in", async () => {
    for (let i = 1; i <= 12; i += 1) await completedTask(i, { rawP50: 1000, actualOut: 3000 });
    retro(h.db, { asOf: NOW });

    // The one-line flip §4.2 delta 3 anticipates. The snapshot above is denominated
    // in sonnet-4-5 output-equivalents and there are ZERO comparable tasks in the
    // new unit — so the multiplier fitted in the old one must not be applied, and
    // the band must say cold start out loud rather than inherit `n = 12`.
    h.db.query("UPDATE config SET v = 'claude-opus-5' WHERE k = 'ref_model'").run();

    turn(h.db, { session: "s-flip", prompt: "p1", at: LONG_AGO, durationMs: 1000 });
    const r = await h.cli(
      ...openArgs({ subject: "the first task in the new unit", "raw-p50": 1000, "raw-p90": 3000 }),
      "--session", "s-flip", "--prompt", "p1", "--json",
    );
    const body = r.json<{
      uncalibrated: boolean;
      bucket_n: number;
      refclass_as_of: string | null;
      ref_model: string;
      band: { p50_wcet: number };
    }>();
    expect(body.ref_model).toBe("claude-opus-5");
    expect(body.uncalibrated).toBe(true);
    expect(body.bucket_n).toBe(0);
    expect(body.refclass_as_of).toBeNull();
    expect(body.band.p50_wcet).toBe(1000); // the raw band, unmultiplied
  });

  test("the estimand axis is keyed too, not just the normaliser", async () => {
    for (let i = 1; i <= 12; i += 1) await completedTask(i, { rawP50: 1000, actualOut: 3000 });
    retro(h.db, { asOf: NOW });
    h.db.query("UPDATE config SET v = 'out_cw_in' WHERE k = 'estimand'").run();

    turn(h.db, { session: "s-estimand", prompt: "p1", at: LONG_AGO, durationMs: 1000 });
    const r = await h.cli(
      ...openArgs({ subject: "a band in a different estimand", "raw-p50": 1000, "raw-p90": 3000 }),
      "--session", "s-estimand", "--prompt", "p1", "--json",
    );
    const body = r.json<{ uncalibrated: boolean; estimand: string; refclass_as_of: string | null }>();
    expect(body.estimand).toBe("out_cw_in");
    expect(body.uncalibrated).toBe(true);
    expect(body.refclass_as_of).toBeNull();
  });

  test("two units can coexist at one as_of instead of colliding on an append-only table", async () => {
    for (let i = 1; i <= 12; i += 1) await completedTask(i, { rawP50: 1000, actualOut: 3000 });
    retro(h.db, { asOf: NOW });
    const before = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM refclass").get()!.n;

    // Same instant, different unit: under a (as_of, bucket, estimator_family) key
    // this was a PRIMARY KEY violation on a table nothing may update or delete.
    h.db
      .query(
        `INSERT INTO refclass SELECT as_of, bucket, estimator_family, n, n_eff, med_log_v, iqr_log_v,
                shrink_w, shrink_k, half_life_days, mult_p50, mult_p90,
                boot_lo_p50, boot_hi_p50, boot_lo_p90, boot_hi_p90, method,
                'claude-opus-5', estimand, params_json
           FROM refclass`,
      )
      .run();
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM refclass").get()!.n).toBe(before * 2);
  });

  test("never pools across units: a task issued under another ref_model is not in the corpus", async () => {
    await completedTask(1);
    h.db.query("UPDATE config SET v = 'claude-other-9' WHERE k = 'ref_model'").run();
    const report = retro(h.db, { asOf: NOW, dryRun: true });
    expect(report.ref_model).toBe("claude-other-9");
    expect(report.n_outcomes).toBe(0);
    expect(report.buckets).toEqual([]);
  });

  test("refinements are scored beside the baseline, never blended into it", async () => {
    const tid = await completedTask(1, { rawP50: 1000, actualOut: 1000, close: false });
    await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "refinement", "--raw-p50", "900", "--raw-p90", "2700");
    closeTask(h.db, { tid, now: NOW });
    const report = retro(h.db, { asOf: NOW, dryRun: true });
    expect(report.scoring.n_scored).toBe(1);
    expect(report.scoring.refinement.n).toBe(1);
    // The baseline pinball loss is computed against eid_at_start; the refinement has
    // its own number and does not replace it.
    expect(report.scoring.pinball_p50).not.toBeNull();
    expect(report.scoring.refinement.pinball_p50).not.toBeNull();
  });

  test("a scope_change task is excluded from velocity but still counted as an outcome", async () => {
    const tid = await completedTask(1, { close: false });
    await h.cli("scope", tid, "--reason", "the goal moved", "--subject", "a different task entirely");
    await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "scope_change");
    closeTask(h.db, { tid, now: NOW });
    expect(h.db.query<{ scope_changed: number }, [string]>(
      "SELECT scope_changed FROM v_outcome_current WHERE tid = ?",
    ).get(tid)!.scope_changed).toBe(1);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_velocity").get()?.n).toBe(0);
    expect(retro(h.db, { asOf: NOW, dryRun: true }).n_outcomes).toBe(0);
  });

  test("candidate bucket splits are recorded, never auto-applied", async () => {
    for (let i = 1; i <= 12; i += 1) await completedTask(i, { rawP50: 1000, actualOut: 1000 + i * 100 });
    const report = retro(h.db, { asOf: NOW });
    const stored = h.db.query<{ splits_json: string }, []>("SELECT splits_json FROM calib_run").get()!;
    const parsed = JSON.parse(stored.splits_json) as { applied: unknown[]; note: string };
    expect(parsed.applied).toEqual([]);
    expect(parsed.note).toContain("never auto-applied");
    // Whatever the candidates are, the bucket in force is still the single global one.
    expect(report.buckets.every((b) => b.bucket === "global")).toBe(true);
  });

  test("an alerting panel exits 3 — a corpus_shrink event is never a clean run", async () => {
    await completedTask(1);
    h.db.query(
      "INSERT INTO anomaly (ts, kind, detail, tid) VALUES (?, 'corpus_shrink', '1 file vanished', NULL)",
    ).run(LONG_AGO);
    const r = await h.cli("retro", "--dry-run", "--json");
    expect(r.code).toBe(3);
    expect(r.json<{ alerts: string[] }>().alerts.join(" ")).toContain("corpus_shrink");
  });

  test("the attribution coverage gate is reported as the headline, in the design's own terms", async () => {
    await completedTask(1);
    const human = await h.cli("retro", "--dry-run");
    expect(human.out).toContain("ATTRIBUTION COVERAGE");
    expect(human.out).toContain(`gate ${ATTR_COVERAGE_GATE * 100}%`);
    expect(human.out).toContain("DRY RUN");
  });

  test("the panel states its own blind spots rather than implying full compliance", async () => {
    await completedTask(1);
    const report = retro(h.db, { asOf: NOW, dryRun: true });
    expect(report.quality.t4_note).toContain("blind spot");
    const human = await h.cli("retro", "--dry-run");
    // `t3_candidates` is an upper bound on T3 misses and the panel must say so, and
    // until `est recon` ships (Phase 2) every number in it is ours and unvalidated.
    expect(human.out).toContain("UPPER BOUND");
    expect(human.out).toContain("reconciliation: none");
  });

  test("--as-of must parse; a garbage instant is a usage error rather than a silent now()", async () => {
    expect((await h.cli("retro", "--as-of", "last tuesday")).code).toBe(1);
  });

  test("an empty database still produces a well-formed panel at exit 0", async () => {
    const r = await h.cli("retro", "--dry-run", "--json");
    expect(r.code).toBe(0);
    const body = r.json<{ n_outcomes: number; scoring: { n_scored: number }; buckets: unknown[] }>();
    expect(body.n_outcomes).toBe(0);
    expect(body.scoring.n_scored).toBe(0);
    expect(body.buckets).toEqual([]);
  });
});

/**
 * The estimator identity — WHO estimated, and what happens when the answer was wrong.
 *
 * `estimate.estimator_model` is a CALIBRATION KEY: `est retro` groups `v_velocity` on
 * it and `est open` looks the reference class up with it. Two ceremonies that disagree
 * do not mis-label a row, they fit multipliers in one bucket and read them out of
 * another — so the properties pinned here are the two that make the key trustworthy:
 *
 *  1. **Determinism.** The same anchor gives the same answer, whenever it is asked, and
 *     `est refclass` (step 1) resolves EXACTLY what `est open` (step 7) will stamp.
 *  2. **Correctability, without a hole in the append-only spine.** `estimate` is
 *     append-only and `outcome.eid_at_start` is `MIN(eid)`, so a corrected estimate
 *     VERSION would look like a fix and change nothing downstream. The correction is an
 *     append to `estimate_identity_repair`, read through `v_estimate_identity`, and
 *     `v_velocity` reads the EFFECTIVE value.
 *
 * Property 2's failure mode is a PARTIAL repoint, which is a quieter version of the bug
 * it fixes: `est retro` fitting on the repaired key while `est open` looks up on the
 * recorded key means every band silently misses its own bucket. The test named
 * "the family retro groups under is the family est open looks up" is that gate.
 *
 * Everything here is synthetic (test/support.ts). No real session id, model or figure.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, openArgs, request, seedPrices, turn, type Harness } from "./support.ts";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db.ts";
import {
  ANOMALY_AMBIGUOUS,
  ANOMALY_REPAIRED,
  recordSessionModel,
  repairEstimatorIdentity,
  resolveEstimatorIdentity,
  UNKNOWN_ESTIMATOR,
} from "../src/identity.ts";
import { refclass } from "../src/tasks.ts";

/** Deliberately not real families, and deliberately distinguishable at a glance. */
const ORCH = "claude-test-orchestrator-9";
const OTHER = "claude-test-orchestrator-2";
const WORKER = "claude-test-worker-1";

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-identity-");
  seedPrices(h.db);
  delete process.env.EST_ESTIMATOR_MODEL;
  delete process.env.EST_SESSION_ID;
  delete process.env.EST_PROMPT_ID;
});

afterEach(() => {
  delete process.env.EST_ESTIMATOR_MODEL;
  delete process.env.EST_SESSION_ID;
  delete process.env.EST_PROMPT_ID;
  h.close();
});

/** `est open` against an explicit anchor; returns the parsed JSON body. */
async function open(
  over: Record<string, string | number> = {},
  session = "s1",
  prompt = "p1",
): Promise<{ tid: string; eid: number; estimator_model: string; estimator_method: string }> {
  const r = await h.cli(...openArgs(over), "--session", session, "--prompt", prompt, "--json");
  expect(r.code).toBe(0);
  return r.json();
}

function recordedModel(db: Database, tid: string): string {
  return db
    .query<{ estimator_model: string }, [string]>(
      "SELECT estimator_model FROM estimate WHERE tid = ? ORDER BY eid ASC LIMIT 1",
    )
    .get(tid)!.estimator_model;
}

function effectiveModel(db: Database, eid: number): string {
  return db
    .query<{ estimator_model: string }, [number]>(
      "SELECT estimator_model FROM v_estimate_identity WHERE eid = ?",
    )
    .get(eid)!.estimator_model;
}

// ---------------------------------------------------------------------------
// the documented resolution order
// ---------------------------------------------------------------------------

describe("the resolution rule", () => {
  test("EST_ESTIMATOR_MODEL outranks config, which outranks everything derived", () => {
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });
    recordSessionModel(h.db, "s1", OTHER);
    h.db.query("INSERT INTO config (k, v) VALUES ('estimator_model', 'claude-test-pinned-2')").run();

    expect(resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p1" })).toMatchObject({
      model: "claude-test-pinned-2",
      method: "config",
    });

    process.env.EST_ESTIMATOR_MODEL = "claude-test-env-3";
    expect(resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p1" })).toMatchObject({
      model: "claude-test-env-3",
      method: "env",
    });
  });

  test("session_model answers ahead of the transcript — it is the leg ingest cannot lag", () => {
    // The whole reason this leg exists: `request` is written by the SWEEP, and
    // `est open` runs at the START of the anchoring turn, so the turn's own rows are
    // not on disk yet. `session_model` is written by the statusline shim from the
    // harness payload and is fresh within one render.
    recordSessionModel(h.db, "s1", ORCH);
    expect(resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p1" })).toMatchObject({
      model: ORCH,
      method: "statusline",
    });
    // And it is scoped to its own session, never leaked to another.
    expect(resolveEstimatorIdentity(h.db, { session: "s2", promptId: "p1" }).method).toBe("pending");
  });

  test("the transcript leg is anchored to the ESTIMATING TURN, not to 'newest'", () => {
    // The turn being estimated.
    request(h.db, "r-a", { session: "s1", prompt: "p1", family: ORCH, out: 10, ts: "2026-01-01T00:00:10Z" });
    // A LATER turn of the same session on a different model — a `/model` switch after
    // the ceremony. Under the old `ORDER BY ts DESC LIMIT 1` rule this retroactively
    // changed what the same `est open` would have recorded.
    request(h.db, "r-b", { session: "s1", prompt: "p2", family: OTHER, out: 10, ts: "2026-01-01T09:00:00Z" });

    expect(resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p1" })).toMatchObject({
      model: ORCH,
      method: "anchor_prompt",
    });
    // The other turn resolves to the other model, which is the point: the answer is a
    // function of the TURN, so both are right and neither moves the other.
    expect(resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p2" }).model).toBe(OTHER);
  });

  test("within one turn the FIRST main request wins, so a mid-turn fallback cannot move it", () => {
    request(h.db, "r-1", { session: "s1", prompt: "p1", family: ORCH, out: 10, ts: "2026-01-01T00:00:10Z" });
    request(h.db, "r-2", { session: "s1", prompt: "p1", family: OTHER, out: 10, ts: "2026-01-01T00:00:20Z" });
    const id = resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p1" });
    expect(id.model).toBe(ORCH);
    // The evidence still records that the window was mixed — which is what makes the
    // repair pass refuse this shape rather than pick from it.
    expect(id.evidence.families).toEqual([OTHER, ORCH].sort());
    expect(id.evidence.n_main).toBe(2);
  });

  test("the at_created fallback is BOUNDED ABOVE, so a later request cannot answer for an earlier band", () => {
    request(h.db, "r-before", { session: "s1", prompt: "p0", family: ORCH, out: 10, ts: "2026-01-01T00:00:00Z" });
    request(h.db, "r-after", { session: "s1", prompt: "p9", family: OTHER, out: 10, ts: "2026-01-02T00:00:00Z" });
    // The anchoring turn itself has no ingested main request (ingest lag), so the
    // fallback answers — with what the session was running AT the estimate's instant.
    const id = resolveEstimatorIdentity(h.db, {
      session: "s1",
      promptId: "p-not-swept",
      at: "2026-01-01T12:00:00Z",
    });
    expect(id).toMatchObject({ model: ORCH, method: "at_created" });
  });

  test("a subagent request is NEVER the estimator identity", () => {
    // A subagent request names the model the ORCHESTRATOR delegated to. Reading it as
    // the orchestrator's own identity is the exact confusion that put a refuted claim
    // into the decision log.
    request(h.db, "r-sub", {
      session: "s1",
      prompt: "p1",
      origin: "subagent",
      agent: "a1",
      family: WORKER,
      out: 10,
    });
    expect(resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p1" })).toMatchObject({
      model: UNKNOWN_ESTIMATOR,
      method: "pending",
    });
  });

  test("'unknown' is a PENDING sentinel, reported as such rather than as an identity", () => {
    const id = resolveEstimatorIdentity(h.db, { session: "s-brand-new", promptId: "p1" });
    expect(id.model).toBe(UNKNOWN_ESTIMATOR);
    expect(id.method).toBe("pending");
    expect(id.evidence.n_main).toBe(0);
    expect(id.evidence.families).toEqual([]);
  });

  test("resolving twice over an unchanged database gives an identical answer", () => {
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });
    const a = resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p1", at: "2026-06-01T00:00:00Z" });
    const b = resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p1", at: "2026-06-01T00:00:00Z" });
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// step 1 and step 7 of the ceremony resolve the SAME identity
// ---------------------------------------------------------------------------

describe("est refclass and est open agree", () => {
  test("both resolve the identity from the SAME anchor", async () => {
    turn(h.db, { session: "s1", prompt: "p1" });
    request(h.db, "r-s1", { session: "s1", prompt: "p1", family: ORCH, out: 10 });
    // A DIFFERENT session, more recently active. `est refclass` used to resolve the
    // session by "newest turn anywhere", so a bare refclass beside
    // `est open --session s1` genuinely printed this session's calibration and
    // stamped the other's.
    turn(h.db, { session: "s2", prompt: "p1", at: "2026-06-01T00:00:00Z" });
    request(h.db, "r-s2", { session: "s2", prompt: "p1", family: OTHER, out: 10, ts: "2026-06-01T00:00:00Z" });

    const rc = refclass(h.db, { text: "widget pipeline", session: "s1", prompt: "p1" });
    const body = await open({}, "s1", "p1");
    expect(rc.estimator_model).toBe(ORCH);
    expect(body.estimator_model).toBe(ORCH);
    expect(rc.estimator_method).toBe(body.estimator_method);
    expect(rc.bucket.estimator_family).toBe(ORCH);
  });

  test("the CLI forwards --session/--prompt to refclass", async () => {
    turn(h.db, { session: "s1", prompt: "p1" });
    request(h.db, "r-s1", { session: "s1", prompt: "p1", family: ORCH, out: 10 });
    turn(h.db, { session: "s2", prompt: "p1", at: "2026-06-01T00:00:00Z" });
    request(h.db, "r-s2", { session: "s2", prompt: "p1", family: OTHER, out: 10, ts: "2026-06-01T00:00:00Z" });

    const r = await h.cli("refclass", "--text", "widget", "--session", "s1", "--prompt", "p1", "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ estimator_model: string }>().estimator_model).toBe(ORCH);
  });
});

// ---------------------------------------------------------------------------
// the repair path
// ---------------------------------------------------------------------------

describe("est repair-identity", () => {
  /** A band opened with nothing on disk yet, so it lands under the sentinel. */
  async function pendingBand(session = "s1", prompt = "p1"): Promise<{ tid: string; eid: number }> {
    const body = await open({}, session, prompt);
    expect(body.estimator_model).toBe(UNKNOWN_ESTIMATOR);
    expect(recordedModel(h.db, body.tid)).toBe(UNKNOWN_ESTIMATOR);
    return { tid: body.tid, eid: body.eid };
  }

  test("the ingest-lag shape is reproduced, then repaired — without touching the ledger row", async () => {
    const { tid, eid } = await pendingBand();
    // The sweep lands the anchoring turn a moment later. THIS is the whole defect:
    // same session, same ceremony, an answer that only exists after the fact.
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });

    const dry = repairEstimatorIdentity(h.db, { apply: false });
    expect(dry.candidates).toBe(1);
    expect(dry.applied).toBe(0);
    expect(dry.proposals).toHaveLength(1);
    expect(dry.proposals[0]).toMatchObject({
      eid,
      from: UNKNOWN_ESTIMATOR,
      to: ORCH,
      method: "anchor_prompt",
    });
    // A dry run writes NOTHING.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_identity_repair").get()!.n).toBe(0);

    const applied = repairEstimatorIdentity(h.db, { apply: true });
    expect(applied.applied).toBe(1);

    // The append-only proof: the ledger row is byte-for-byte what was believed at the
    // time, and the correction lives BESIDE it.
    expect(recordedModel(h.db, tid)).toBe(UNKNOWN_ESTIMATOR);
    expect(effectiveModel(h.db, eid)).toBe(ORCH);
    const row = h.db
      .query<{ estimator_model_recorded: string; repair_method: string | null }, [number]>(
        "SELECT estimator_model_recorded, repair_method FROM v_estimate_identity WHERE eid = ?",
      )
      .get(eid)!;
    expect(row).toEqual({ estimator_model_recorded: UNKNOWN_ESTIMATOR, repair_method: "anchor_prompt" });
  });

  test("the evidence is stored, so the correction can be re-derived or refuted", async () => {
    const { eid } = await pendingBand();
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });
    repairEstimatorIdentity(h.db, { apply: true });

    const ev = JSON.parse(
      h.db
        .query<{ evidence: string }, [number]>(
          "SELECT evidence FROM estimate_identity_repair WHERE eid = ?",
        )
        .get(eid)!.evidence,
    ) as { session: string; prompt_id: string; request_id: string; n_main: number; families: string[] };
    expect(ev).toEqual({
      session: "s1",
      prompt_id: "p1",
      request_id: "r-main",
      n_main: 1,
      families: [ORCH],
    });
  });

  test("re-running writes zero rows and zero anomalies — the idempotence property", async () => {
    await pendingBand();
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });
    repairEstimatorIdentity(h.db, { apply: true });

    const rows = (): number =>
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_identity_repair").get()!.n;
    const anomalies = (): number =>
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n;
    const rowsAfter = rows();
    const anomaliesAfter = anomalies();

    const second = repairEstimatorIdentity(h.db, { apply: true });
    expect(second.candidates).toBe(0);
    expect(second.applied).toBe(0);
    expect(rows()).toBe(rowsAfter);
    expect(anomalies()).toBe(anomaliesAfter);
  });

  test("an ambiguous window is REFUSED, and says so exactly once", async () => {
    const { eid } = await pendingBand();
    // The anchoring turn spans a model switch. There is no honest answer here, and
    // guessing one is worse than leaving the sentinel standing.
    request(h.db, "r-1", { session: "s1", prompt: "p1", family: ORCH, out: 10, ts: "2026-01-01T00:00:10Z" });
    request(h.db, "r-2", { session: "s1", prompt: "p1", family: OTHER, out: 10, ts: "2026-01-01T00:00:20Z" });

    const r = repairEstimatorIdentity(h.db, { apply: true });
    expect(r.applied).toBe(0);
    expect(r.ambiguous).toBe(1);
    expect(effectiveModel(h.db, eid)).toBe(UNKNOWN_ESTIMATOR);

    const ambiguous = (): number =>
      h.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = ?")
        .get(ANOMALY_AMBIGUOUS)!.n;
    expect(ambiguous()).toBe(1);
    // `anomaly` is already dominated by two chatty kinds. A third that writes a row per
    // sweep, forever, makes the ledger less readable rather than more.
    repairEstimatorIdentity(h.db, { apply: true });
    repairEstimatorIdentity(h.db, { apply: true });
    expect(ambiguous()).toBe(1);
  });

  /**
   * `'unknown'` is a real `request.model_family` — a transcript line whose model could
   * not be read — and it is byte-identical to this module's own "no leg answered"
   * sentinel. So the `anchor_prompt` leg answered `'unknown'`, the loop accepted it
   * because `method !== 'pending'`, the row was "repaired" from the sentinel INTO the
   * sentinel, and it remained a candidate: one `estimate_identity_repair` row and one
   * `estimator_identity_repaired` anomaly PER SWEEP, forever, on a table with a
   * `RAISE(ABORT,'append-only')` DELETE trigger and via an insert that bypasses
   * `insertAnomalies`' (kind, detail) dedup. Idempotence is the property this pass
   * promises; this is the case that broke it.
   */
  test("an anchor turn whose own model is 'unknown' stays PENDING, sweep after sweep", async () => {
    await pendingBand();
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: UNKNOWN_ESTIMATOR, out: 10 });

    const rows = (): number =>
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_identity_repair").get()!.n;
    const anomalies = (): number =>
      h.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = ?")
        .get(ANOMALY_REPAIRED)!.n;

    for (let i = 0; i < 3; i += 1) {
      const r = repairEstimatorIdentity(h.db, { apply: true });
      expect(r.candidates).toBe(1);
      expect(r.applied).toBe(0);
      expect(r.ambiguous).toBe(0);
      expect(r.pending).toBe(1);
    }
    expect(rows()).toBe(0);
    expect(anomalies()).toBe(0);
  });

  test("no main request yet is PENDING, not a failure and not an anomaly", async () => {
    await pendingBand();
    const r = repairEstimatorIdentity(h.db, { apply: true });
    expect(r.candidates).toBe(1);
    expect(r.pending).toBe(1);
    expect(r.applied).toBe(0);
    expect(r.ambiguous).toBe(0);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind LIKE 'estimator_identity%'").get()!.n,
    ).toBe(0);
  });

  test("a CONCRETE recorded family is never touched automatically", async () => {
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });
    const body = await open();
    expect(body.estimator_model).toBe(ORCH);
    // Now the corpus says something else about that session. An auto-repair here would
    // be unsound (the recorded value may have come from an env override that leaves no
    // trace in `request`) AND would flip-flop the row on every sweep.
    request(h.db, "r-late", { session: "s1", prompt: "p1", family: OTHER, out: 10, ts: "2026-01-01T00:00:30Z" });
    const r = repairEstimatorIdentity(h.db, { apply: true });
    expect(r.candidates).toBe(0);
    expect(effectiveModel(h.db, body.eid)).toBe(ORCH);
  });

  test("the pass never reads env, config or session_model — those describe the machine NOW", async () => {
    const { eid } = await pendingBand();
    // Every non-transcript leg says OTHER; none of them may date a historical row.
    recordSessionModel(h.db, "s1", OTHER);
    h.db.query("INSERT INTO config (k, v) VALUES ('estimator_model', 'claude-test-pinned-2')").run();
    process.env.EST_ESTIMATOR_MODEL = "claude-test-env-3";
    try {
      const r = repairEstimatorIdentity(h.db, { apply: true });
      expect(r.applied).toBe(0);
      expect(r.pending).toBe(1);
      expect(effectiveModel(h.db, eid)).toBe(UNKNOWN_ESTIMATOR);
    } finally {
      delete process.env.EST_ESTIMATOR_MODEL;
    }
  });

  test("a repair row is APPEND-ONLY, physically", async () => {
    await pendingBand();
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });
    repairEstimatorIdentity(h.db, { apply: true });
    expect(() => h.db.query("UPDATE estimate_identity_repair SET estimator_model = 'x'").run()).toThrow(
      /append-only/,
    );
    expect(() => h.db.query("DELETE FROM estimate_identity_repair").run()).toThrow(/append-only/);
  });

  test("a later repair supersedes an earlier one — current is MAX(seq)", async () => {
    const { tid, eid } = await pendingBand();
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });
    repairEstimatorIdentity(h.db, { apply: true });
    // The manual path, which is the ONLY way a concrete value is ever overridden.
    h.db
      .query(
        `INSERT INTO estimate_identity_repair (eid, seq, repaired_at, estimator_model, method, evidence, note)
         VALUES (?, 2, '2026-02-01T00:00:00Z', ?, 'manual', '{}', 'operator correction')`,
      )
      .run(eid, OTHER);
    expect(effectiveModel(h.db, eid)).toBe(OTHER);
    // Two corrections deep, and the ledger row is still what was believed at the time.
    expect(recordedModel(h.db, tid)).toBe(UNKNOWN_ESTIMATOR);
  });

  test("the CLI dry-runs by default and requires --apply to write", async () => {
    await pendingBand();
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });

    const dry = await h.cli("repair-identity", "--json");
    expect(dry.code).toBe(0);
    const body = dry.json<{ dry_run: boolean; applied: number; proposals: unknown[] }>();
    expect(body.dry_run).toBe(true);
    expect(body.applied).toBe(0);
    expect(body.proposals).toHaveLength(1);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_identity_repair").get()!.n).toBe(0);

    const wrote = await h.cli("repair-identity", "--apply", "--json");
    expect(wrote.code).toBe(0);
    expect(wrote.json<{ applied: number }>().applied).toBe(1);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_identity_repair").get()!.n).toBe(1);
    expect(
      h.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = ?")
        .get(ANOMALY_REPAIRED)!.n,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the read path — the high-risk half
// ---------------------------------------------------------------------------

describe("every consumer reads the EFFECTIVE identity", () => {
  test("v_velocity carries the repaired family, not the recorded one", async () => {
    // Directly seeded rather than driven through `est close`, because the property
    // under test is the VIEW's join, and a fixture that has to complete a whole task
    // to assert it would fail for a dozen unrelated reasons.
    const body = await open();
    const eid = body.eid;
    h.db
      .query(
        `INSERT INTO estimate_identity_repair (eid, seq, repaired_at, estimator_model, method, evidence)
         VALUES (?, 1, '2026-02-01T00:00:00Z', ?, 'anchor_prompt', '{}')`,
      )
      .run(eid, ORCH);

    const recorded = h.db
      .query<{ estimator_model: string }, [number]>("SELECT estimator_model FROM estimate WHERE eid = ?")
      .get(eid)!.estimator_model;
    expect(recorded).toBe(UNKNOWN_ESTIMATOR);
    expect(effectiveModel(h.db, eid)).toBe(ORCH);

    // And no row of `v_velocity` may ever surface the sentinel once it is repaired —
    // a stray 'unknown' is a whole extra reference class with n=1.
    const families = h.db
      .query<{ estimator_model: string }, []>("SELECT DISTINCT estimator_model FROM v_velocity")
      .all()
      .map((r) => r.estimator_model);
    expect(families).not.toContain(UNKNOWN_ESTIMATOR);
  });

  test("the family retro groups under is the family est open looks up", async () => {
    // THE gate against a partial repoint. `est retro` fits multipliers keyed on
    // `priceFamily(v_velocity.estimator_model)`; `est open` looks the snapshot up with
    // `priceFamily(resolveEstimatorIdentity(...))`. If those two strings ever diverge,
    // every band silently misses its own calibration bucket — a quieter version of the
    // bug this whole mechanism exists to fix.
    const { eid } = await (async () => {
      const b = await open();
      return { eid: b.eid };
    })();
    h.db
      .query(
        `INSERT INTO estimate_identity_repair (eid, seq, repaired_at, estimator_model, method, evidence)
         VALUES (?, 1, '2026-02-01T00:00:00Z', ?, 'anchor_prompt', '{}')`,
      )
      .run(eid, ORCH);
    // The same transcript fact the repair was derived from is now on disk, which is
    // what a real sweep would have left behind.
    request(h.db, "r-main", { session: "s1", prompt: "p1", family: ORCH, out: 10 });

    const openSideKey = resolveEstimatorIdentity(h.db, { session: "s1", promptId: "p1" }).family;
    const retroSideKey = effectiveModel(h.db, eid);
    expect(openSideKey).toBe(retroSideKey);
  });
});

// ---------------------------------------------------------------------------
// v9 -> v10 lands on exactly what schema.sql builds
// ---------------------------------------------------------------------------

describe("the v10 migration", () => {
  test("a v9 database migrates to exactly the shape schema.sql builds", () => {
    const dir = mkdtempSync(join(tmpdir(), "est-identity-mig-"));
    const path = join(dir, "estimator.db");
    let db = openDb({ path });
    try {
      // Downgrade in place: drop every v10 object and restore v9's `v_velocity`, so the
      // starting file is what a real v9 database looks like.
      db.exec(`
        DROP VIEW v_velocity;
        CREATE VIEW v_velocity AS
        SELECT e.bucket, e.estimator_model, e.price_epoch, e.refclass_as_of,
               e.ref_model, e.estimand,
               o.velocity_raw, o.velocity_cal, o.finalized_at,
               o.wcet_main, o.wcet_sub, o.wcet_aux,
               o.wcet_main + o.wcet_sub AS wcet_task_effort,
               e.exp_agents, o.n_agents
        FROM v_outcome_current o
        JOIN estimate e ON e.eid = o.eid_at_start
        WHERE o.scope_changed = 0 AND o.censored = 0 AND o.final_status = 'completed'
          AND o.unpriced_share = 0 AND o.price_provisional = 0
          AND o.actual_wcet_at_epoch IS NOT NULL;
        DROP VIEW v_estimate_identity;
        DROP TRIGGER eir_ro_u;
        DROP TRIGGER eir_ro_d;
        DROP TABLE estimate_identity_repair;
        DROP TABLE session_model;
        UPDATE config SET v = '9' WHERE k = 'schema_version';
      `);
      // A tuned value must survive the step: the config seeds are INSERT OR IGNORE, and
      // a migration that restated one would be rewriting a row Craig set on purpose.
      db.query("UPDATE config SET v='999' WHERE k='shrink_k'").run();
      db.close();

      db = openDb({ path }); // migrates on open
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='shrink_k'").get()?.v).toBe("999");

      const freshDir = mkdtempSync(join(tmpdir(), "est-identity-fresh-"));
      const fresh = openDb({ path: join(freshDir, "estimator.db") });
      try {
        const objects = (d: Database): unknown =>
          d
            .query<unknown, []>(
              `SELECT type, name, sql FROM sqlite_master
                WHERE name NOT LIKE 'sqlite_%'
                  AND (name IN ('session_model','estimate_identity_repair','eir_ro_u','eir_ro_d',
                                'v_estimate_identity','v_velocity'))
                ORDER BY type, name`,
            )
            .all();
        // The whole `sqlite_master` row, `sql` text included — SQLite strips
        // `IF NOT EXISTS` before storing, so the migration's idempotence guard costs
        // nothing in fidelity and this stays an EXACT comparison.
        expect(objects(db)).toEqual(objects(fresh));
      } finally {
        fresh.close();
        rmSync(freshDir, { recursive: true, force: true });
      }

      // The triggers came back with the table.
      db.query(
        `INSERT INTO task (tid, kind, status, created_at, anchor_session, anchor_prompt)
         VALUES ('T1','implement','estimating','2026-01-01T00:00:00Z','s1','p1')`,
      ).run();
      db.query(
        `INSERT INTO task_scope (tid, seq, ts, subject, dod_json, scope_hash, source)
         VALUES ('T1', 1, '2026-01-01T00:00:00Z', 's', '[]', 'h', 'est_open')`,
      ).run();
      db.query(
        `INSERT INTO estimate (tid, version, created_at, reason, scope_seq, raw_p50_wcet,
                               raw_p90_wcet, exp_agents, exp_wf_phases, exp_files_write,
                               exp_turns, exp_requests, bucket, bucket_n, refclass_as_of,
                               shrink_w, cal_p50_wcet, cal_p90_wcet, price_epoch, ref_model,
                               estimand, estimator_model)
         VALUES ('T1',1,'2026-01-01T00:00:00Z','initial',1,1000,2000,1,0,1,5,10,'global',0,
                 NULL,0,1000,2000,'2026-01-01T00:00:00Z','claude-sonnet-4-5','work_cet','unknown')`,
      ).run();
      const eid = db.query<{ eid: number }, []>("SELECT eid FROM estimate").get()!.eid;
      db.query(
        `INSERT INTO estimate_identity_repair (eid, seq, repaired_at, estimator_model, method, evidence)
         VALUES (?, 1, '2026-02-01T00:00:00Z', ?, 'anchor_prompt', '{}')`,
      ).run(eid, ORCH);
      expect(() => db.query("UPDATE estimate_identity_repair SET seq = 9").run()).toThrow(/append-only/);
      expect(
        db
          .query<{ estimator_model: string }, [number]>(
            "SELECT estimator_model FROM v_estimate_identity WHERE eid = ?",
          )
          .get(eid)!.estimator_model,
      ).toBe(ORCH);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

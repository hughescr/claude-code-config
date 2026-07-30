/**
 * The SWEEPER CLOSE PASS (P1.7/§6.2, Craig 2026-07-30) — `src/autoclose.ts`.
 *
 * The claim under test is the one §6.2's refusal message has always made and nothing
 * implemented: **a task that goes quiet gets closed by the sweeper, without a human.**
 * Four properties have to hold together for that to be safe rather than merely
 * automatic, and each has a test below:
 *
 *   1. The completed/abandoned ruling follows the EVIDENCE, never convenience. A linked
 *      completion signal closes `completed`; silence past `STALE_CLOSE_HOURS` closes
 *      `abandoned` (censored), because a completion nobody observed is not a
 *      measurement.
 *   2. The FULL quiescence gate still decides. The candidate filter is arm 1 and
 *      nothing else; a candidate whose session is still live stays open.
 *   3. It is throttled, so the micro-sweep every hook fires does not run it per prompt.
 *   4. It is idempotent: the second pass over the same corpus closes nothing new.
 *
 * All fixtures are synthetic (`test/support.ts`) against a temp database; the "live pid"
 * arm is exercised through a fake sessions root, never the machine's real one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRun, makeHarness, openArgs, request, seedPrices, turn, type Harness } from "./support.ts";
import { BENIGN_ANOMALY_KINDS } from "../src/cli.ts";
import { SESSIONS_ROOT, STALE_CLOSE_HOURS } from "../src/close.ts";
import {
  CLOSE_PASS_CANDIDATE_SQL,
  CLOSE_PASS_MARKER,
  DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN,
  closePassCandidates,
  closePassMinIntervalMin,
  runClosePass,
} from "../src/autoclose.ts";

let h: Harness;
let spool: string;

/** Every fixture request lands here; `NOW` is a month later, so everything is stale. */
const LONG_AGO = "2026-01-01T00:00:00Z";
const NOW = new Date("2026-02-01T00:00:00Z");

beforeEach(() => {
  h = makeHarness("est-autoclose-");
  seedPrices(h.db);
  spool = mkdtempSync(join(tmpdir(), "est-autoclose-spool-"));
  turn(h.db, { session: "s1", prompt: "p1", at: LONG_AGO, durationMs: 60_000 });
});

afterEach(() => {
  h.close();
  rmSync(spool, { recursive: true, force: true });
});

async function openTask(over: Record<string, string | number> = {}): Promise<string> {
  const r = await h.cli(...openArgs(over), "--session", "s1", "--prompt", "p1", "--json");
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

/** Monotone request-id source: a uuidv7's leading bytes are a millisecond clock, so two
 *  tasks minted inside one tick share a prefix and a `request_id` derived from it. */
let seq = 0;

/**
 * A task with attributed spend, all of it `LONG_AGO` — quiet by every arm of the gate.
 *
 * Two things are done by hand rather than left to the ordinary machinery, and both are
 * about making the fixture's CLOCK the test's clock:
 *
 *  - `est open` stamps `created_at` at real wall-clock time, which is far in the future
 *    of the synthetic `NOW` these tests reason in. A task whose only timestamp is a
 *    future `created_at` is never stale, so `created_at` is backdated to `LONG_AGO`.
 *  - The request is bound to THIS tid directly instead of through `attributeTasks`.
 *    Every task here is anchored to the same session `s1` (that is the shape both
 *    incidents have), and §5.4's staleness closure would hand a second task's request
 *    to the first — which is a correct attribution decision and the wrong fixture.
 */
async function quietTask(over: Record<string, string | number> = {}): Promise<string> {
  const tid = await openTask(over);
  h.db.query("UPDATE task SET created_at = ? WHERE tid = ?").run(LONG_AGO, tid);
  const rid = `r-${(seq += 1)}`;
  request(h.db, rid, { origin: "main", out: 150, cw: 50, ts: "2026-01-01T00:01:00Z", durationMs: 4000 });
  h.db.query("UPDATE request SET tid = ?, attr = 'exclusive' WHERE request_id = ?").run(tid, rid);
  return tid;
}

/**
 * The §6.2 completion signal the alias fix made visible: a `task_event` this database
 * has LINKED to a tid, whose `to_status` is `completed`. Written directly rather than
 * through the ingest so the test states the shape it depends on.
 */
function completionSignal(tid: string, taskNum = "1"): void {
  h.db
    .query(
      `INSERT INTO task_event (tid, session_id, kind, task_num, ts, from_status, to_status, source)
       VALUES (?, 's1', 'status', ?, ?, 'in_progress', 'completed', 'transcript')`,
    )
    .run(tid, taskNum, "2026-01-01T00:05:00Z");
}

const outcomeOf = (tid: string): { final_status: string; censored: number } | null =>
  h.db
    .query<{ final_status: string; censored: number }, [string]>(
      "SELECT final_status, censored FROM v_outcome_current WHERE tid = ?",
    )
    .get(tid);

const statusOf = (tid: string): string | undefined =>
  h.db.query<{ status: string }, [string]>("SELECT status FROM task WHERE tid = ?").get(tid)?.status;

/**
 * Still open, by the §6.2 definition, and with no `outcome` row.
 *
 * Asserted as a SET rather than as a literal: which of the three open statuses a task
 * holds is `promoteStartedTasks`'s business (P2.8), and it runs in the sweep — so a
 * direct `runClosePass` call leaves a task `estimating` where the same task reached
 * through `est sweep` is `in_progress`. Neither is what these tests are about.
 */
function expectStillOpen(tid: string): void {
  expect(["estimating", "in_progress", "pending_verification"]).toContain(statusOf(tid) ?? "<none>");
  expect(outcomeOf(tid)).toBe(null);
}

// ---------------------------------------------------------------------------
// the candidate filter
// ---------------------------------------------------------------------------

describe("close pass — the candidate filter is arm 1 of the gate and nothing else", () => {
  test("a signal-bearing task is a candidate; a fresh silent one is not", async () => {
    const signalled = await quietTask({ subject: "alpha widget pipeline" });
    completionSignal(signalled);
    const fresh = await openTask({ subject: "beta cache layer" });
    h.db.query("UPDATE task SET created_at = ? WHERE tid = ?").run(LONG_AGO, fresh);
    request(h.db, "r-fresh", { out: 10, ts: new Date(NOW.getTime() - 60_000).toISOString() });
    h.db.query("UPDATE request SET tid = ?, attr = 'exclusive' WHERE request_id = 'r-fresh'").run(fresh);

    const tids = closePassCandidates(h.db, NOW).map((c) => c.tid);
    expect(tids).toContain(signalled);
    expect(tids).not.toContain(fresh);
  });

  test("silence past STALE_CLOSE_HOURS makes a task a candidate with signal=false", async () => {
    const tid = await quietTask();
    const [c] = closePassCandidates(h.db, NOW);
    expect(c?.tid).toBe(tid);
    expect(c?.signal).toBe(false);
    // The fixture is a month old, which is comfortably past the threshold the gate uses.
    expect(NOW.getTime() - Date.parse(c!.last_activity)).toBeGreaterThan(
      STALE_CLOSE_HOURS * 3_600_000,
    );
  });

  test("a task just inside the window is NOT a candidate", async () => {
    const tid = await openTask();
    h.db.query("UPDATE task SET created_at = ? WHERE tid = ?").run(LONG_AGO, tid);
    request(h.db, "r-recent", {
      out: 10,
      ts: new Date(NOW.getTime() - (STALE_CLOSE_HOURS - 1) * 3_600_000).toISOString(),
    });
    h.db.query("UPDATE request SET tid = ?, attr = 'exclusive' WHERE request_id = 'r-recent'").run(tid);
    expect(closePassCandidates(h.db, NOW).map((c) => c.tid)).not.toContain(tid);
  });

  test("a task already CLOSED is outside the open set entirely", async () => {
    const tid = await quietTask();
    runClosePass(h.db, { now: NOW, markerDir: spool });
    expect(closePassCandidates(h.db, NOW).map((c) => c.tid)).not.toContain(tid);
  });

  /**
   * The point of `ix_task_event_completed`, asserted against the PLANNER rather than
   * against prose — the same shape `test/schema.test.ts` uses for
   * `ix_task_event_unlinked`, and for the same reason: the index's predicate and the
   * query's have to stay verbatim identical, and a lifecycle-table scan per open task
   * is exactly the regression this index exists to prevent.
   */
  test("the candidate query hits an index for both of its correlated subqueries", () => {
    const plan = h.db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${CLOSE_PASS_CANDIDATE_SQL}`)
      .all()
      .map((r) => r.detail);
    const joined = plan.join(" | ");

    // The completion-signal probe: a partial-index search, never a scan of task_event.
    expect(joined).toContain("ix_task_event_completed");
    expect(joined).not.toMatch(/SCAN task_event(?! USING)/);
    // The last-activity probe: `request` is the biggest table in the schema.
    expect(joined).toContain("ix_req_tid");
    expect(joined).not.toMatch(/SCAN request(?! USING)/);
    // `SCAN t` (the `task` table) is DELIBERATE — see CLOSE_PASS_CANDIDATE_SQL's note.
    // What must not come back is the CTE being flattened, which re-evaluates both
    // correlated subqueries once more per row.
    expect(joined).toContain("MATERIALIZE");
    expect(plan.filter((d) => d.includes("ix_task_event_completed")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the ruling: completed vs abandoned
// ---------------------------------------------------------------------------

describe("close pass — the completed/abandoned ruling follows the evidence", () => {
  test("signal + quiet => completed, and the outcome is NOT censored", async () => {
    const tid = await quietTask();
    completionSignal(tid);

    const r = runClosePass(h.db, { now: NOW, markerDir: spool });
    expect(r.attempted).toBe(true);
    expect(r.completed).toBe(1);
    expect(r.abandoned).toBe(0);
    expect(r.blocked).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.closed[0]?.reason).toBe("completion_signal");

    expect(statusOf(tid)).toBe("completed");
    expect(outcomeOf(tid)).toEqual({ final_status: "completed", censored: 0 });
  });

  test("48h stale with NO signal => abandoned, and the actual is right-censored", async () => {
    const tid = await quietTask();

    const r = runClosePass(h.db, { now: NOW, markerDir: spool });
    expect(r.abandoned).toBe(1);
    expect(r.completed).toBe(0);
    expect(r.closed[0]?.reason).toBe("stale");

    expect(statusOf(tid)).toBe("abandoned");
    // Craig's ruling: silence means the data is not calibration-grade, so the actual
    // enters the corpus as the LOWER BOUND it genuinely is.
    expect(outcomeOf(tid)).toEqual({ final_status: "abandoned", censored: 1 });
  });

  test("`pending_verification` counts as a signal without waiting 48h", async () => {
    const tid = await openTask();
    // Quiet by every other arm, but only three hours old — the staleness arm refuses it.
    request(h.db, "r-pv", { out: 10, ts: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() });
    h.db.query("UPDATE request SET tid = ?, attr = 'exclusive' WHERE request_id = 'r-pv'").run(tid);
    h.db
      .query("UPDATE task SET status = 'pending_verification', created_at = ? WHERE tid = ?")
      .run(LONG_AGO, tid);

    const r = runClosePass(h.db, { now: NOW, markerDir: spool });
    expect(r.completed).toBe(1);
    expect(outcomeOf(tid)?.final_status).toBe("completed");
  });

  test("every close is attributable to the sweeper in the ledger, and the row is benign", async () => {
    const tid = await quietTask();
    runClosePass(h.db, { now: NOW, markerDir: spool });

    const rows = h.db
      .query<{ kind: string; detail: string; tid: string | null }, [string]>(
        "SELECT kind, detail, tid FROM anomaly WHERE tid = ? AND kind = 'swept_close'",
      )
      .all(tid);
    expect(rows.length).toBe(1);
    expect(rows[0]?.detail).toContain("ABANDONED");
    // `outcome` has no provenance column; this ledger row IS the provenance, exactly as
    // it is for `forced_close` and `accepted_close`.
    expect(BENIGN_ANOMALY_KINDS.has("swept_close")).toBe(true);
    // ...and no gate was bypassed, so neither override row exists.
    expect(
      h.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM anomaly WHERE tid = ? AND kind IN ('forced_close','accepted_close')",
        )
        .get(tid)?.n,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the gate still decides
// ---------------------------------------------------------------------------

describe("close pass — the FULL quiescence gate still decides", () => {
  test("a candidate with a non-terminal agent_run is NOT closed", async () => {
    const tid = await quietTask();
    completionSignal(tid);
    // Arm 5: a bound agent that started and never ended. The candidate filter cannot
    // see this — only the full gate can, which is the whole point of running it.
    agentRun(h.db, "a-live", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: LONG_AGO,
      endedAt: null,
    });
    h.db.query("UPDATE agent_run SET tid = ? WHERE agent_id = 'a-live'").run(tid);

    const r = runClosePass(h.db, { now: NOW, markerDir: spool });
    expect(r.candidates).toBe(1);
    expect(r.blocked).toBe(1);
    expect(r.completed + r.abandoned).toBe(0);

    // Still open, and no outcome row was appended.
    expectStillOpen(tid);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind='swept_close'").get()?.n,
    ).toBe(0);
  });

  test("a candidate with an OPEN turn in a bound session is NOT closed", async () => {
    const tid = await quietTask();
    completionSignal(tid);
    // Arm 3: the session's newest turn has no `turn_duration` record and the session is
    // still emitting requests — a live long-running turn.
    turn(h.db, { session: "s1", prompt: "p9", at: new Date(NOW.getTime() - 60_000).toISOString(), durationMs: null });
    request(h.db, "r-live", { session: "s1", prompt: "p9", out: 5, ts: new Date(NOW.getTime() - 30_000).toISOString() });

    const r = runClosePass(h.db, { now: NOW, markerDir: spool });
    expect(r.blocked).toBe(1);
    expectStillOpen(tid);
  });

  test("a candidate whose bound session has a LIVE pid is NOT closed", async () => {
    const tid = await quietTask();
    completionSignal(tid);
    // Arm 4. `SESSIONS_ROOT` is resolved at IMPORT (test/preload.ts points it at a
    // guaranteed-absent temp directory), so the fixture is written INTO that root rather
    // than by re-pointing the variable — which would change nothing at this stage.
    // `<pid>.json` names THIS process, the one pid `process.kill(pid, 0)` can always
    // confirm is alive.
    const marker = join(SESSIONS_ROOT, `${process.pid}.json`);
    mkdirSync(SESSIONS_ROOT, { recursive: true });
    writeFileSync(marker, JSON.stringify({ sessionId: "s1" }));
    try {
      const r = runClosePass(h.db, { now: NOW, markerDir: spool });
      expect(r.blocked).toBe(1);
      expectStillOpen(tid);
    } finally {
      rmSync(marker, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// the throttle, and idempotence
// ---------------------------------------------------------------------------

describe("close pass — throttle and idempotence", () => {
  test("the interval is a seeded, tunable config key with a documented default", async () => {
    expect(closePassMinIntervalMin(h.db)).toBe(DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN);
    // P2.0's key set is CLOSED: this proves the knob is SEEDED, not merely defaulted.
    const set = await h.cli("config", "set", "close_pass_min_interval_min", "45");
    expect(set.code).toBe(0);
    expect(closePassMinIntervalMin(h.db)).toBe(45);
  });

  test("a second pass inside the window does not even query", async () => {
    await quietTask();
    const first = runClosePass(h.db, { now: NOW, markerDir: spool });
    expect(first.attempted).toBe(true);
    expect(first.abandoned).toBe(1);

    // A brand-new candidate appears, but the window has not elapsed.
    const later = new Date(NOW.getTime() + 60_000);
    const second = await quietTask({ subject: "gamma indexer" });
    const throttled = runClosePass(h.db, { now: later, markerDir: spool });
    expect(throttled.attempted).toBe(false);
    expect(throttled.candidates).toBe(0);
    expectStillOpen(second);

    // Past the window, the same pass picks it up.
    const past = new Date(NOW.getTime() + (DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN + 1) * 60_000);
    const third = runClosePass(h.db, { now: past, markerDir: spool });
    expect(third.attempted).toBe(true);
    expect(third.abandoned).toBe(1);
    expect(statusOf(second)).toBe("abandoned");
  });

  test("`force` runs the pass regardless of the marker (the `est backfill` path)", async () => {
    await quietTask();
    runClosePass(h.db, { now: NOW, markerDir: spool });
    const tid = await quietTask({ subject: "delta compactor" });
    const forced = runClosePass(h.db, { now: new Date(NOW.getTime() + 1000), markerDir: spool, force: true });
    expect(forced.attempted).toBe(true);
    expect(statusOf(tid)).toBe("abandoned");
  });

  test("the marker is stamped only by a pass that RAN, and the pruner knows its name", async () => {
    const markerPath = join(spool, CLOSE_PASS_MARKER);
    runClosePass(h.db, { now: NOW, markerDir: spool });
    expect(Math.round(statSync(markerPath).mtimeMs)).toBe(NOW.getTime());

    // A throttled call must not re-stamp: otherwise a burst of micro-sweeps would push
    // the window forward forever and the pass would never run again.
    runClosePass(h.db, { now: new Date(NOW.getTime() + 60_000), markerDir: spool });
    expect(Math.round(statSync(markerPath).mtimeMs)).toBe(NOW.getTime());

    const { pruneMarkers, CLOSE_PASS_MARKER_TTL_MS } = await import("../src/spool.ts");
    expect(pruneMarkers(spool, new Date(NOW.getTime() + CLOSE_PASS_MARKER_TTL_MS + 1000))).toBe(1);
  });

  test("a second unthrottled pass over the same corpus closes NOTHING new", async () => {
    const a = await quietTask({ subject: "alpha widget pipeline" });
    completionSignal(a);
    const b = await quietTask({ subject: "beta cache layer" });

    const first = runClosePass(h.db, { now: NOW, markerDir: spool, force: true });
    expect(first.completed).toBe(1);
    expect(first.abandoned).toBe(1);

    const second = runClosePass(h.db, { now: new Date(NOW.getTime() + 1000), markerDir: spool, force: true });
    expect(second.attempted).toBe(true);
    expect(second.candidates).toBe(0);
    expect(second.completed + second.abandoned + second.blocked + second.failed).toBe(0);

    // Exactly one outcome revision each, and exactly one provenance row each.
    for (const tid of [a, b]) {
      expect(
        h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM outcome WHERE tid = ?").get(tid)?.n,
      ).toBe(1);
      expect(
        h.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM anomaly WHERE kind='swept_close' AND tid = ?",
          )
          .get(tid)?.n,
      ).toBe(1);
    }
  });

  test("never throws: a candidate with no estimate is counted, not fatal", async () => {
    const good = await quietTask({ subject: "alpha widget pipeline" });
    const orphan = await quietTask({ subject: "beta cache layer" });
    // `estimate` is append-only in the CLI, but this test needs the shape `closeTask`
    // refuses — a task with no baseline to judge an actual against.
    h.db.query("PRAGMA writable_schema = ON").run();
    h.db.query("DROP TRIGGER est_ro_d").run();
    h.db.query("PRAGMA writable_schema = OFF").run();
    h.db.query("DELETE FROM estimate WHERE tid = ?").run(orphan);

    const r = runClosePass(h.db, { now: NOW, markerDir: spool });
    expect(r.failed).toBe(1);
    expect(r.abandoned).toBe(1);
    expect(statusOf(good)).toBe("abandoned");
    expectStillOpen(orphan);
  });
});

// ---------------------------------------------------------------------------
// wiring: the sweep runs it
// ---------------------------------------------------------------------------

describe("close pass — wired into the sweep every hook already spawns", () => {
  test("`est sweep` runs the pass and reports it", async () => {
    const tid = await quietTask();
    completionSignal(tid);
    // The sweep derives its spool from the database's own directory (see SweepOptions),
    // which for the harness is the temp dir — never the deployed spool.
    const r = await h.cli("sweep", "--json");
    expect(r.code === 0 || r.code === 3).toBe(true);
    const report = r.json<{ close_pass: { attempted: boolean; completed: number } }>();
    expect(report.close_pass.attempted).toBe(true);
    expect(report.close_pass.completed).toBe(1);
    expect(statusOf(tid)).toBe("completed");
  });

  test("a second sweep inside the window is throttled, and closes nothing new", async () => {
    await quietTask();
    const first = await h.cli("sweep", "--json");
    expect(first.json<{ close_pass: { attempted: boolean } }>().close_pass.attempted).toBe(true);
    const tid = await quietTask({ subject: "epsilon planner" });
    const second = await h.cli("sweep", "--json");
    expect(second.json<{ close_pass: { attempted: boolean } }>().close_pass.attempted).toBe(false);
    expectStillOpen(tid);
  });
});

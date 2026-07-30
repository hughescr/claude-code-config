/**
 * The SWEEPER CLOSE PASS (P1.7/§6.2, Craig 2026-07-30) — `src/autoclose.ts`.
 *
 * The claim under test is the one §6.2's refusal message has always made and nothing
 * implemented: **a task that goes quiet gets closed by the sweeper, without a human.**
 * Six properties have to hold together for that to be safe rather than merely automatic:
 *
 *   1. The RULING comes from the GATE, not from the candidate filter. The filter is an
 *      optimisation and is allowed to be conservative; the status a task is finalized
 *      under is not. `completed`, `deleted` and `abandoned` are three different claims.
 *   2. Silence alone closes `abandoned` only after `close_abandon_after_h` (a week) —
 *      far past the gate's 48 h permission threshold — because an auto-abandon seals the
 *      task's attribution window permanently.
 *   3. A completion signal only counts if it POSTDATES the latest reopen. `task_event`
 *      is append-only, so without that floor a reopened task is re-closed forever on the
 *      evidence that justified its first close.
 *   4. The FULL quiescence gate still decides — including the aged-out liveness rule for
 *      dangling agents, which is what lets the pass reach the tasks it exists for.
 *   5. It is throttled PER DATABASE, and it does not run at all on a sweep that could not
 *      read its corpus.
 *   6. It is idempotent, it never throws, and every close is attributable in the ledger.
 *
 * All fixtures are synthetic (`test/support.ts`) against a temp database; the "live pid"
 * arm is exercised through the preload's fake sessions root, never the machine's real one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRun, makeHarness, openArgs, request, seedPrices, turn, type Harness } from "./support.ts";
import { BENIGN_ANOMALY_KINDS } from "../src/cli.ts";
import { closeTask, quiescence, SESSIONS_ROOT, STALE_CLOSE_HOURS } from "../src/close.ts";
import {
  CLOSE_PASS_CANDIDATE_SQL,
  DEFAULT_CLOSE_ABANDON_AFTER_H,
  DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN,
  closeAbandonAfterH,
  closePassCandidates,
  closePassMarkerFile,
  closePassMinIntervalMin,
  runClosePass,
} from "../src/autoclose.ts";

let h: Harness;
let spool: string;
/** The per-DATABASE throttle marker path this harness's passes use. */
let marker: string;

/** Every fixture request lands here; `NOW` is a month later — past the abandon window. */
const LONG_AGO = "2026-01-01T00:00:00Z";
const NOW = new Date("2026-02-01T00:00:00Z");
const HOUR_MS = 3_600_000;

beforeEach(() => {
  h = makeHarness("est-autoclose-");
  seedPrices(h.db);
  spool = mkdtempSync(join(tmpdir(), "est-autoclose-spool-"));
  marker = join(spool, closePassMarkerFile(h.dbPath));
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

/** Monotone id source: a uuidv7's leading bytes are a millisecond clock, so two tasks
 *  minted inside one tick share a prefix and any id derived from it. */
let seq = 0;

/** One request, attributed to `tid` BY HAND — see {@link quietTask}. */
function spend(tid: string, at: string): void {
  const rid = `r-${(seq += 1)}`;
  request(h.db, rid, { origin: "main", out: 150, cw: 50, ts: at, durationMs: 4000 });
  h.db.query("UPDATE request SET tid = ?, attr = 'exclusive' WHERE request_id = ?").run(tid, rid);
}

/**
 * A task with attributed spend, quiet by every arm of the gate.
 *
 * Two things are done by hand rather than left to the ordinary machinery, and both are
 * about making the fixture's CLOCK the test's clock:
 *
 *  - `est open` stamps `created_at` at real wall-clock time, which is far in the future
 *    of the synthetic `NOW` these tests reason in. A task whose only timestamp is a
 *    future `created_at` is never stale, so `created_at` is backdated.
 *  - The request is bound to THIS tid directly instead of through `attributeTasks`.
 *    Every task here is anchored to the same session `s1` (that is the shape both
 *    duplicate-mint incidents have), and §5.4's staleness closure would hand a second
 *    task's request to the first — a correct attribution decision and the wrong fixture.
 */
async function quietTask(
  over: Record<string, string | number> = {},
  at: string = "2026-01-01T00:01:00Z",
): Promise<string> {
  const tid = await openTask(over);
  h.db.query("UPDATE task SET created_at = ? WHERE tid = ?").run(LONG_AGO, tid);
  spend(tid, at);
  return tid;
}

/**
 * The §6.2 terminal signal: a `task_event` this database has LINKED to a tid. Written
 * directly rather than through the ingest so the test states the shape it depends on.
 */
function terminalEvent(
  tid: string,
  to: "completed" | "deleted" = "completed",
  at = "2026-01-01T00:05:00Z",
): void {
  h.db
    .query(
      `INSERT INTO task_event (tid, session_id, kind, task_num, ts, from_status, to_status, source)
       VALUES (?, 's1', 'status', ?, ?, 'in_progress', ?, 'transcript')`,
    )
    .run(tid, `n${(seq += 1)}`, at, to);
}

const outcomeOf = (tid: string): { final_status: string; censored: number } | null =>
  h.db
    .query<{ final_status: string; censored: number }, [string]>(
      "SELECT final_status, censored FROM v_outcome_current WHERE tid = ?",
    )
    .get(tid);

const statusOf = (tid: string): string | undefined =>
  h.db.query<{ status: string }, [string]>("SELECT status FROM task WHERE tid = ?").get(tid)?.status;

function anomalyCount(kind: string, tid?: string): number {
  if (tid === undefined) {
    return (
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = ?").get(kind)
        ?.n ?? 0
    );
  }
  return (
    h.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM anomaly WHERE kind = ? AND tid = ?",
      )
      .get(kind, tid)?.n ?? 0
  );
}

const anomalyDetail = (kind: string, tid: string): string | undefined =>
  h.db
    .query<{ detail: string }, [string, string]>(
      "SELECT detail FROM anomaly WHERE kind = ? AND tid = ?",
    )
    .get(kind, tid)?.detail;

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
  // `reopened` IS an open state: it is the outcome revision that says the work restarted,
  // and `v_outcome_current` keeps it as the latest until something finalizes the task
  // again. Anything else here would mean this pass closed it.
  expect(outcomeOf(tid)?.final_status ?? "reopened").toBe("reopened");
}

/** A fresh, unfinished delegation bound to `tid` — the shape that must still block. */
function liveAgent(tid: string, id = "a-live", startedAt = new Date(NOW.getTime() - 10 * 60_000)): void {
  agentRun(h.db, id, {
    session: "s1",
    launchPrompt: "p1",
    startedAt: startedAt.toISOString(),
    endedAt: null,
  });
  h.db.query("UPDATE agent_run SET tid = ? WHERE agent_id = ?").run(tid, id);
}

// ---------------------------------------------------------------------------
// the candidate filter
// ---------------------------------------------------------------------------

describe("close pass — the candidate filter is arm 1 of the gate and nothing else", () => {
  test("a signal-bearing task is a candidate; a fresh silent one is not", async () => {
    const signalled = await quietTask({ subject: "alpha widget pipeline" });
    terminalEvent(signalled);
    const fresh = await quietTask(
      { subject: "beta cache layer" },
      new Date(NOW.getTime() - 60_000).toISOString(),
    );

    const tids = closePassCandidates(h.db, NOW).map((c) => c.tid);
    expect(tids).toContain(signalled);
    expect(tids).not.toContain(fresh);
  });

  test("a DELETED terminal event makes a task a candidate too", async () => {
    // The filter must be no narrower than the gate. Before this, a captured deletion was
    // invisible to the filter and reached the pass only via the staleness arm, where it
    // was filed `abandoned` — laundering the one signal P1.11's hook exists to preserve.
    const tid = await quietTask({}, new Date(NOW.getTime() - 3 * HOUR_MS).toISOString());
    terminalEvent(tid, "deleted");
    const [c] = closePassCandidates(h.db, NOW);
    expect(c?.tid).toBe(tid);
    expect(c?.signal).toBe(true);
  });

  test("silence past STALE_CLOSE_HOURS makes a task a candidate with signal=false", async () => {
    const tid = await quietTask();
    const [c] = closePassCandidates(h.db, NOW);
    expect(c?.tid).toBe(tid);
    expect(c?.signal).toBe(false);
    expect(NOW.getTime() - Date.parse(c!.last_activity)).toBeGreaterThan(STALE_CLOSE_HOURS * HOUR_MS);
  });

  test("a task just inside the window is NOT a candidate", async () => {
    const tid = await quietTask(
      {},
      new Date(NOW.getTime() - (STALE_CLOSE_HOURS - 1) * HOUR_MS).toISOString(),
    );
    expect(closePassCandidates(h.db, NOW).map((c) => c.tid)).not.toContain(tid);
  });

  test("a task already CLOSED is outside the open set entirely", async () => {
    const tid = await quietTask();
    runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(closePassCandidates(h.db, NOW).map((c) => c.tid)).not.toContain(tid);
  });

  /**
   * The point of `ix_task_event_completed`, asserted against the PLANNER rather than
   * against prose — the same shape `test/schema.test.ts` uses for
   * `ix_task_event_unlinked`, and for the same reason: the index's predicate and the
   * query's have to stay verbatim identical, and a lifecycle-table scan per open task
   * is exactly the regression this index exists to prevent.
   */
  test("the candidate query hits an index for every correlated subquery, and MATERIALIZEs", () => {
    const plan = h.db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${CLOSE_PASS_CANDIDATE_SQL}`)
      .all()
      .map((r) => r.detail);
    const joined = plan.join(" | ");

    // The terminal-signal probe: a partial-index search, never a scan of task_event.
    expect(joined).toContain("ix_task_event_completed");
    expect(joined).not.toMatch(/SCAN task_event(?! USING)/);
    // The last-activity probe: `request` is the biggest table in the schema.
    expect(joined).toContain("ix_req_tid");
    expect(joined).not.toMatch(/SCAN request(?! USING)/);
    // `SCAN t` (the `task` table) is DELIBERATE — see CLOSE_PASS_CANDIDATE_SQL's note.
    //
    // The CTE must MATERIALIZE. Dropping `AS MATERIALIZED` lets SQLite flatten it into
    // the outer WHERE and evaluate the correlated subqueries a SECOND time per row —
    // twice the indexed reads for the same answer, and every other test in this suite
    // still passes. Named explicitly (not merely "MATERIALIZE" somewhere in the plan) so
    // the assertion cannot be satisfied by an unrelated future subquery.
    expect(joined).toContain("MATERIALIZE open_task");
  });
});

// ---------------------------------------------------------------------------
// the ruling comes from the GATE
// ---------------------------------------------------------------------------

describe("close pass — the ruling comes from the gate, not from the filter", () => {
  test("signal + quiet => completed, and the outcome is NOT censored", async () => {
    const tid = await quietTask();
    terminalEvent(tid);

    const r = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(r.attempted).toBe(true);
    expect(r.skipped).toBe(null);
    expect(r.completed).toBe(1);
    expect(r.abandoned + r.deleted + r.blocked + r.failed).toBe(0);
    expect(r.closed[0]?.reason).toBe("completion_signal");

    expect(statusOf(tid)).toBe("completed");
    expect(outcomeOf(tid)).toEqual({ final_status: "completed", censored: 0 });
  });

  test("a DELETED signal closes as `deleted`, never as completed or abandoned", async () => {
    // P1.11's delete-capture hook exists so a `TaskUpdate status:"deleted"` survives a
    // process death. Folding it into `completed` would assert an outcome nobody saw;
    // folding it into `abandoned` would discard the one signal that WAS captured.
    const tid = await quietTask({}, new Date(NOW.getTime() - 3 * HOUR_MS).toISOString());
    terminalEvent(tid, "deleted");

    const r = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(r.deleted).toBe(1);
    expect(r.completed + r.abandoned).toBe(0);
    expect(outcomeOf(tid)).toEqual({ final_status: "deleted", censored: 1 });
    // Provenance says so too, and it is the BENIGN kind: a recorded deletion is evidence.
    expect(anomalyCount("swept_close", tid)).toBe(1);
    expect(anomalyCount("swept_abandon", tid)).toBe(0);
    expect(anomalyDetail("swept_close", tid)).toContain("DELETED");
  });

  test("'completed' beats 'deleted' when a task carries both", async () => {
    const tid = await quietTask({}, new Date(NOW.getTime() - 3 * HOUR_MS).toISOString());
    terminalEvent(tid, "deleted", "2026-01-01T00:05:00Z");
    terminalEvent(tid, "completed", "2026-01-01T00:06:00Z");
    expect(quiescence(h.db, tid, NOW).completion_kind).toBe("completed");
    runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(outcomeOf(tid)?.final_status).toBe("completed");
  });

  test("a signal the FILTER cannot see is still honoured by the gate", async () => {
    // The gate reads BOTH alias shapes; the filter reads only `task_event.tid`. A task
    // whose event is reachable only through its `session_task` alias therefore arrives
    // as a stale-arm candidate with `signal: false` — and must still close `completed`,
    // because the ruling is the gate's. This is the case that made "the filter decides"
    // wrong rather than merely conservative.
    const tid = await quietTask();
    h.db
      .query(
        `INSERT INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
         VALUES (?, 'session_task', 's1', '7', ?, 'sweeper')`,
      )
      .run(tid, LONG_AGO);
    h.db
      .query(
        `INSERT INTO task_event (tid, session_id, kind, task_num, ts, from_status, to_status, source)
         VALUES (NULL, 's1', 'status', '7', '2026-01-01T00:05:00Z', 'in_progress', 'completed', 'transcript')`,
      )
      .run();

    const [c] = closePassCandidates(h.db, NOW);
    expect(c?.signal).toBe(false); // the filter cannot see it…
    expect(quiescence(h.db, tid, NOW).completion_kind).toBe("completed"); // …the gate can

    const r = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(r.completed).toBe(1);
    expect(r.abandoned).toBe(0);
    expect(outcomeOf(tid)).toEqual({ final_status: "completed", censored: 0 });
  });

  test("`pending_verification` counts as a signal without waiting for the window", async () => {
    const tid = await quietTask({}, new Date(NOW.getTime() - 3 * HOUR_MS).toISOString());
    h.db.query("UPDATE task SET status = 'pending_verification' WHERE tid = ?").run(tid);

    const r = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(r.completed).toBe(1);
    expect(outcomeOf(tid)?.final_status).toBe("completed");
  });

  test("every close is attributable in the ledger, and no gate was bypassed", async () => {
    const tid = await quietTask();
    terminalEvent(tid);
    runClosePass(h.db, { now: NOW, markerPath: marker });

    expect(anomalyCount("swept_close", tid)).toBe(1);
    // `outcome` has no provenance column; this ledger row IS the provenance, exactly as
    // it is for `forced_close` and `accepted_close`.
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
// the abandon arm and its safety margin
// ---------------------------------------------------------------------------

describe("close pass — the abandon arm has its own, much longer clock", () => {
  test("the abandon window is a seeded, tunable key far longer than the gate's threshold", async () => {
    expect(closeAbandonAfterH(h.db)).toBe(DEFAULT_CLOSE_ABANDON_AFTER_H);
    expect(DEFAULT_CLOSE_ABANDON_AFTER_H).toBeGreaterThan(STALE_CLOSE_HOURS);
    const set = await h.cli("config", "set", "close_abandon_after_h", "500");
    expect(set.code).toBe(0);
    expect(closeAbandonAfterH(h.db)).toBe(500);
  });

  test("a value below the gate's own threshold is refused in favour of the default", async () => {
    // A window shorter than the window in which a close is permitted at all cannot mean
    // anything, so the knob refuses to express it rather than silently half-applying.
    expect((await h.cli("config", "set", "close_abandon_after_h", "1")).code).toBe(0);
    expect(closeAbandonAfterH(h.db)).toBe(DEFAULT_CLOSE_ABANDON_AFTER_H);
  });

  test("gate-eligible but inside the margin => NOT closed, and reported as such", async () => {
    // 72 h of silence: past the gate's 48 h, far short of the 168 h abandon window. This
    // is the weekend-quiet LIVE task — closing it here would seal its attribution window
    // and make every hour of Monday's work unattributable, with nothing saying why.
    const tid = await quietTask({}, new Date(NOW.getTime() - 72 * HOUR_MS).toISOString());

    const r = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(r.candidates).toBe(1);
    expect(r.awaiting_abandon).toBe(1);
    expect(r.abandoned).toBe(0);
    expectStillOpen(tid);
    expect(anomalyCount("swept_abandon")).toBe(0);
  });

  test("past the margin => abandoned, right-censored, and the row is ALERTING", async () => {
    const tid = await quietTask(); // a month of silence

    const r = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(r.abandoned).toBe(1);
    expect(r.completed + r.deleted).toBe(0);
    expect(r.closed[0]?.reason).toBe("stale");

    expect(statusOf(tid)).toBe("abandoned");
    // Craig's ruling: silence means the data is not calibration-grade, so the actual
    // enters the corpus as the LOWER BOUND it genuinely is.
    expect(outcomeOf(tid)).toEqual({ final_status: "abandoned", censored: 1 });

    // ALERTING, unlike its `swept_close` sibling: an abandon preserves no measurement and
    // permanently seals the attribution window, so it is the one a human must be told.
    expect(anomalyCount("swept_abandon", tid)).toBe(1);
    expect(BENIGN_ANOMALY_KINDS.has("swept_abandon")).toBe(false);
    expect(BENIGN_ANOMALY_KINDS.has("swept_close")).toBe(true);
    // And the row signposts the road back, because nothing else will.
    expect(anomalyDetail("swept_abandon", tid)).toContain("--status reopened");
  });

  test("`est open --tid` on a swept-abandoned task names the reopen command", async () => {
    const tid = await quietTask();
    runClosePass(h.db, { now: NOW, markerPath: marker });
    const r = await h.cli(...openArgs(), "--tid", tid, "--reason", "refinement");
    expect(r.code).toBe(2);
    expect(r.err).toContain(`est close ${tid} --status reopened`);
    expect(r.err).toContain("attribution window");
  });
});

// ---------------------------------------------------------------------------
// reopen-bounded signals
// ---------------------------------------------------------------------------

describe("close pass — a completion signal must postdate the latest reopen", () => {
  /** close → reopen → resume. Returns the instant of the reopen. */
  async function reopened(tid: string): Promise<Date> {
    terminalEvent(tid);
    expect(runClosePass(h.db, { now: NOW, markerPath: marker }).completed).toBe(1);
    const at = new Date(NOW.getTime() + HOUR_MS);
    closeTask(h.db, { tid, status: "reopened", now: at, spoolDir: spool });
    expect(statusOf(tid)).toBe("in_progress");
    spend(tid, at.toISOString()); // a reopen means the work resumed
    return at;
  }

  test("complete -> close -> reopen -> quiet does NOT re-close from the stale event", async () => {
    const tid = await quietTask();
    const reopenAt = await reopened(tid);

    // Two hours on: the append-only `task_event` from the FIRST run is still there. It
    // must not make this task a candidate, and the gate must not read it as a signal.
    const later = new Date(reopenAt.getTime() + 2 * HOUR_MS);
    expect(closePassCandidates(h.db, later).map((c) => c.tid)).not.toContain(tid);
    expect(quiescence(h.db, tid, later).completion_signal).toBe(false);
    const r = runClosePass(h.db, { now: later, markerPath: marker, force: true });
    expect(r.completed).toBe(0);
    expectStillOpen(tid);
  });

  test("after a reopen, silence eventually closes ABANDONED — never `completed` again", async () => {
    const tid = await quietTask();
    const reopenAt = await reopened(tid);

    // Past the abandon window with no new signal: the stale event must not resurrect as
    // a `completed` close, which is the whole failure mode the floor exists to stop.
    const muchLater = new Date(reopenAt.getTime() + (DEFAULT_CLOSE_ABANDON_AFTER_H + 1) * HOUR_MS);
    const r = runClosePass(h.db, { now: muchLater, markerPath: marker, force: true });
    expect(r.abandoned).toBe(1);
    expect(r.completed).toBe(0);
    expect(outcomeOf(tid)).toEqual({ final_status: "abandoned", censored: 1 });
  });

  test("the reopen floor compares INSTANTS, not strings", async () => {
    // `task_event.ts` comes from a transcript and carries milliseconds; `finalized_at` is
    // `isoNow`, seconds. At index 19 `'.' (0x2E) < 'Z' (0x5A)`, so a lexicographic floor
    // reads an event 500 ms AFTER the reopen as being before it — the same scar
    // src/eta.ts carries for `run_segment.ended_at`. The gate must compare with
    // `julianday()` on both sides.
    const tid = await quietTask();
    const reopenAt = await reopened(tid);
    const halfSecondLater = new Date(reopenAt.getTime() + 500).toISOString();
    expect(halfSecondLater).toContain(".500Z"); // the fixture really is sub-second
    expect(halfSecondLater < new Date(reopenAt.getTime()).toISOString().replace(/\.\d+/, "")).toBe(
      true, // …and a string compare really does get it backwards
    );

    terminalEvent(tid, "completed", halfSecondLater);
    expect(quiescence(h.db, tid, new Date(reopenAt.getTime() + 2 * HOUR_MS)).completion_kind).toBe(
      "completed",
    );
  });

  test("a signal recorded AFTER the reopen does count", async () => {
    const tid = await quietTask();
    const reopenAt = await reopened(tid);
    terminalEvent(tid, "completed", new Date(reopenAt.getTime() + 60_000).toISOString());

    const later = new Date(reopenAt.getTime() + 2 * HOUR_MS);
    expect(quiescence(h.db, tid, later).completion_kind).toBe("completed");
    const r = runClosePass(h.db, { now: later, markerPath: marker, force: true });
    expect(r.completed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the gate still decides
// ---------------------------------------------------------------------------

describe("close pass — the FULL quiescence gate still decides", () => {
  test("a LIVE agent_run blocks the close; a DANGLING one no longer does", async () => {
    const tid = await quietTask();
    terminalEvent(tid);
    liveAgent(tid);

    const blocked = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(blocked.candidates).toBe(1);
    expect(blocked.blocked).toBe(1);
    expect(blocked.completed + blocked.abandoned + blocked.deleted).toBe(0);
    expectStillOpen(tid);
    expect(anomalyCount("swept_close")).toBe(0);

    // Age it out: "started and never ended" is what a live agent looks like AND what a
    // DEAD one looks like (§5.6 `agent_never_returned`, 54 rows on the live corpus). One
    // corpse used to block its task from ever being closeable — which made the pass
    // unable to reach the exact population it exists for.
    h.db.query("UPDATE agent_run SET started_at = ? WHERE agent_id = 'a-live'").run(LONG_AGO);
    const r = runClosePass(h.db, { now: NOW, markerPath: marker, force: true });
    expect(r.completed).toBe(1);
    expect(outcomeOf(tid)?.final_status).toBe("completed");
  });

  test("a dangling agent that is still EMITTING is not aged out", async () => {
    // The clock is `MAX(started_at, the agent's last request)`, so a genuinely long run
    // keeps blocking. Bounding on `started_at` alone would close live work — the one
    // direction this must not fail in.
    const tid = await quietTask();
    terminalEvent(tid);
    agentRun(h.db, "a-long", { session: "s1", launchPrompt: "p1", startedAt: LONG_AGO, endedAt: null });
    h.db.query("UPDATE agent_run SET tid = ? WHERE agent_id = 'a-long'").run(tid);
    request(h.db, "r-agent-live", {
      origin: "subagent",
      agent: "a-long",
      prompt: null,
      out: 10,
      ts: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });

    const r = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(r.blocked).toBe(1);
    expectStillOpen(tid);
  });

  test("a candidate with an OPEN turn in a bound session is NOT closed", async () => {
    const tid = await quietTask();
    terminalEvent(tid);
    turn(h.db, {
      session: "s1",
      prompt: "p9",
      at: new Date(NOW.getTime() - 60_000).toISOString(),
      durationMs: null,
    });
    request(h.db, "r-live", {
      session: "s1",
      prompt: "p9",
      out: 5,
      ts: new Date(NOW.getTime() - 30_000).toISOString(),
    });

    const r = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(r.blocked).toBe(1);
    expectStillOpen(tid);
  });

  test("a candidate whose bound session has a LIVE pid is NOT closed", async () => {
    const tid = await quietTask();
    terminalEvent(tid);
    // Arm 4. `SESSIONS_ROOT` is resolved at IMPORT (test/preload.ts points it at a
    // guaranteed-absent temp directory), so the fixture is written INTO that root rather
    // than by re-pointing the variable, which would change nothing at this stage.
    const pidFile = join(SESSIONS_ROOT, `${process.pid}.json`);
    mkdirSync(SESSIONS_ROOT, { recursive: true });
    writeFileSync(pidFile, JSON.stringify({ sessionId: "s1" }));
    try {
      const r = runClosePass(h.db, { now: NOW, markerPath: marker });
      expect(r.blocked).toBe(1);
      expectStillOpen(tid);
    } finally {
      rmSync(pidFile, { force: true });
    }
  });

  test("a long-blocked candidate is surfaced ONCE, naming the arm", async () => {
    const tid = await quietTask();
    terminalEvent(tid);
    liveAgent(tid);

    // Eligible since `last_activity + 48 h`, i.e. a month ago — far past the 24 h line.
    // The three instants stay inside `eta_live_agent_max_min` of the agent's start, so
    // it is still LIVE at each of them and the refusal is the same one every time.
    for (const at of [NOW, new Date(NOW.getTime() + 30 * 60_000), new Date(NOW.getTime() + 60 * 60_000)]) {
      expect(runClosePass(h.db, { now: at, markerPath: marker, force: true }).blocked).toBe(1);
    }
    // ONE row, however many passes: the detail names the ARM and carries no count, so
    // the ledger's (kind, detail, tid) dedup holds it.
    expect(anomalyCount("close_blocked", tid)).toBe(1);
    expect(BENIGN_ANOMALY_KINDS.has("close_blocked")).toBe(true);
    expect(anomalyDetail("close_blocked", tid)).toContain("agent_run");
  });

  test("a candidate blocked only briefly is NOT surfaced", async () => {
    // Closeable for two hours, refused: entirely normal, and not worth a ledger row.
    const tid = await quietTask(
      {},
      new Date(NOW.getTime() - (STALE_CLOSE_HOURS + 2) * HOUR_MS).toISOString(),
    );
    terminalEvent(tid, "completed", new Date(NOW.getTime() - HOUR_MS).toISOString());
    liveAgent(tid);

    expect(runClosePass(h.db, { now: NOW, markerPath: marker }).blocked).toBe(1);
    expect(anomalyCount("close_blocked", tid)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// throttle, per-database isolation, incomplete sweeps, idempotence
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
    const first = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(first.attempted).toBe(true);
    expect(first.abandoned).toBe(1);

    const later = new Date(NOW.getTime() + 60_000);
    const second = await quietTask({ subject: "gamma indexer" });
    const throttled = runClosePass(h.db, { now: later, markerPath: marker });
    expect(throttled.attempted).toBe(false);
    expect(throttled.skipped).toBe("throttled");
    expect(throttled.candidates).toBe(0);
    expectStillOpen(second);

    const past = new Date(NOW.getTime() + (DEFAULT_CLOSE_PASS_MIN_INTERVAL_MIN + 1) * 60_000);
    const third = runClosePass(h.db, { now: past, markerPath: marker });
    expect(third.attempted).toBe(true);
    expect(third.abandoned).toBe(1);
    expect(statusOf(second)).toBe("abandoned");
  });

  test("the throttle is PER DATABASE: sweeping a copy cannot silence the original", () => {
    // Two databases sharing one spool directory — the `EST_SPOOL_DIR` shape — must not
    // share one window, or a sweep of a throwaway copy leaves the live database's real
    // tasks open for the whole interval with nothing saying why.
    const a = join(spool, closePassMarkerFile("/somewhere/estimator.db"));
    const b = join(spool, closePassMarkerFile("/somewhere/copy.db"));
    expect(a).not.toBe(b);
    runClosePass(h.db, { now: NOW, markerPath: a });
    expect(statSync(a).isFile()).toBe(true);
    // B has no marker of its own, so its next pass is still due.
    const r = runClosePass(h.db, { now: new Date(NOW.getTime() + 60_000), markerPath: b });
    expect(r.attempted).toBe(true);
  });

  test("`force` runs the pass regardless of the marker (the `est backfill` path)", async () => {
    await quietTask();
    runClosePass(h.db, { now: NOW, markerPath: marker });
    const tid = await quietTask({ subject: "delta compactor" });
    const forced = runClosePass(h.db, {
      now: new Date(NOW.getTime() + 1000),
      markerPath: marker,
      force: true,
    });
    expect(forced.attempted).toBe(true);
    expect(statusOf(tid)).toBe("abandoned");
  });

  test("an INCOMPLETE sweep skips the pass entirely, and does not burn the window", async () => {
    // A truncated corpus read makes a live task look quiet: the requests that would have
    // moved `MAX(request.ts)` are precisely the ones that were not read. And
    // `healClosedOutcomes` cannot repair it — it only re-checks spend POSTDATING
    // `finalized_at`, and the missed rows carry timestamps from before it.
    const tid = await quietTask();
    terminalEvent(tid);
    const skipped = runClosePass(h.db, { now: NOW, markerPath: marker, sweepIncomplete: true });
    expect(skipped.attempted).toBe(false);
    expect(skipped.skipped).toBe("incomplete_sweep");
    expect(skipped.candidates).toBe(0);
    expectStillOpen(tid);

    // No marker was stamped, so the very NEXT complete sweep runs — it does not have to
    // wait out a window it never used.
    const r = runClosePass(h.db, { now: new Date(NOW.getTime() + 1000), markerPath: marker });
    expect(r.attempted).toBe(true);
    expect(r.completed).toBe(1);
  });

  test("the marker is stamped only by a pass that RAN, and the pruner knows its name", async () => {
    runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(Math.round(statSync(marker).mtimeMs)).toBe(NOW.getTime());

    // A throttled call must not re-stamp: otherwise a burst of micro-sweeps would push
    // the window forward forever and the pass would never run again.
    runClosePass(h.db, { now: new Date(NOW.getTime() + 60_000), markerPath: marker });
    expect(Math.round(statSync(marker).mtimeMs)).toBe(NOW.getTime());

    const { pruneMarkers, CLOSE_PASS_MARKER_TTL_MS } = await import("../src/spool.ts");
    expect(pruneMarkers(spool, new Date(NOW.getTime() + CLOSE_PASS_MARKER_TTL_MS + 1000))).toBe(1);
  });

  test("a second unthrottled pass over the same corpus closes NOTHING new", async () => {
    const a = await quietTask({ subject: "alpha widget pipeline" });
    terminalEvent(a);
    const b = await quietTask({ subject: "beta cache layer" });

    const first = runClosePass(h.db, { now: NOW, markerPath: marker, force: true });
    expect(first.completed).toBe(1);
    expect(first.abandoned).toBe(1);

    const second = runClosePass(h.db, {
      now: new Date(NOW.getTime() + 1000),
      markerPath: marker,
      force: true,
    });
    expect(second.attempted).toBe(true);
    expect(second.candidates).toBe(0);
    expect(second.completed + second.abandoned + second.blocked + second.failed).toBe(0);

    for (const tid of [a, b]) {
      expect(
        h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM outcome WHERE tid = ?").get(tid)?.n,
      ).toBe(1);
    }
    expect(anomalyCount("swept_close", a)).toBe(1);
    expect(anomalyCount("swept_abandon", b)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------

describe("close pass — failures are counted, bounded and eventually alerting", () => {
  /** A task the close path cannot finalize: `closeTask` refuses one with no estimate. */
  async function orphanTask(): Promise<string> {
    const tid = await quietTask({ subject: "beta cache layer" });
    h.db.query("PRAGMA writable_schema = ON").run();
    h.db.query("DROP TRIGGER est_ro_d").run();
    h.db.query("PRAGMA writable_schema = OFF").run();
    h.db.query("DELETE FROM estimate WHERE tid = ?").run(tid);
    return tid;
  }

  test("never throws: one bad candidate does not stop the others", async () => {
    const good = await quietTask({ subject: "alpha widget pipeline" });
    const orphan = await orphanTask();

    const r = runClosePass(h.db, { now: NOW, markerPath: marker });
    expect(r.failed).toBe(1);
    expect(r.abandoned).toBe(1);
    expect(statusOf(good)).toBe("abandoned");
    expectStillOpen(orphan);
  });

  test("three consecutive failures raise the ALERTING close_failed, once", async () => {
    const orphan = await orphanTask();

    for (let i = 0; i < 5; i++) {
      const r = runClosePass(h.db, {
        now: new Date(NOW.getTime() + i * 60_000),
        markerPath: marker,
        force: true,
      });
      expect(r.failed).toBe(1);
    }

    // The breadcrumbs are CAPPED at the alert threshold, so the bookkeeping cannot become
    // the spam the alert exists to avoid.
    expect(anomalyCount("close_attempt_failed", orphan)).toBe(3);
    expect(anomalyCount("close_failed", orphan)).toBe(1);
    expect(BENIGN_ANOMALY_KINDS.has("close_attempt_failed")).toBe(true);
    expect(BENIGN_ANOMALY_KINDS.has("close_failed")).toBe(false);
  });

  test("one or two failures do NOT alert", async () => {
    const orphan = await orphanTask();
    for (let i = 0; i < 2; i++) {
      runClosePass(h.db, { now: new Date(NOW.getTime() + i * 60_000), markerPath: marker, force: true });
    }
    expect(anomalyCount("close_attempt_failed", orphan)).toBe(2);
    expect(anomalyCount("close_failed", orphan)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// wiring: the sweep runs it
// ---------------------------------------------------------------------------

describe("close pass — wired into the sweep every hook already spawns", () => {
  test("`est sweep` runs the pass and reports it", async () => {
    const tid = await quietTask();
    terminalEvent(tid);
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
    const cp = second.json<{ close_pass: { attempted: boolean; skipped: string | null } }>().close_pass;
    expect(cp.attempted).toBe(false);
    expect(cp.skipped).toBe("throttled");
    expectStillOpen(tid);
  });
});

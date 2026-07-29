/**
 * `est close` — finalize by arithmetic (P1.7, P1.12).
 *
 * The load-bearing claim of this verb is a negative one: **there is no flag that
 * accepts a token count, a cost, or a velocity, and there never will be.** No agent
 * grades its own work; the actual is deterministic SQL over harness logs. The first
 * test in this file asserts that about the FLAG TABLE rather than about prose, because
 * prose does not fail a build.
 *
 * The rest is the quiescence gate (§6.2) — which exists so a task cannot be closed
 * while its own agents are still spending — and the append-only outcome history: a
 * reopen is `revision + 1`, never an edit, and accuracy is judged against `MIN(eid)`
 * no matter how many refinements followed.
 *
 * All fixtures are synthetic (`test/support.ts`); the "live pid" leg of the gate is
 * exercised through session ids (`s1`) that cannot collide with a real session file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentRun,
  makeHarness,
  openArgs,
  request,
  seedPrices,
  turn,
  type Harness,
} from "./support.ts";
import { COMMAND_FLAGS } from "../src/cli.ts";
import { closeTask, quiescence } from "../src/close.ts";
import { attributeTasks } from "../src/attribute.ts";

let h: Harness;

/** Every fixture request lands here; "now" in the tests is months later. */
const LONG_AGO = "2026-01-01T00:00:00Z";
const NOW = new Date("2026-02-01T00:00:00Z");

const minutesBefore = (at: Date, minutes: number): string =>
  new Date(at.getTime() - minutes * 60_000).toISOString();

beforeEach(() => {
  h = makeHarness("est-close-");
  seedPrices(h.db);
  turn(h.db, { session: "s1", prompt: "p1", at: LONG_AGO, durationMs: 60_000 });
});

afterEach(() => {
  h.close();
});

async function openTask(over: Record<string, string | number> = {}): Promise<string> {
  const r = await h.cli(...openArgs(over), "--session", "s1", "--prompt", "p1", "--json");
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

/** A quiescent task carrying 200 main + 800 sub Work-CET across two requests. */
async function quietTask(): Promise<string> {
  const tid = await openTask();
  request(h.db, "r-main", { origin: "main", out: 150, cw: 50, ts: "2026-01-01T00:01:00Z", durationMs: 4000 });
  agentRun(h.db, "a1", {
    session: "s1",
    launchPrompt: "p1",
    startedAt: "2026-01-01T00:01:00Z",
    endedAt: "2026-01-01T00:06:00Z",
  });
  request(h.db, "r-sub", {
    origin: "subagent",
    agent: "a1",
    prompt: null,
    out: 700,
    cw: 100,
    ts: "2026-01-01T00:02:00Z",
    durationMs: 6000,
  });
  attributeTasks(h.db);
  return tid;
}

// ---------------------------------------------------------------------------
// P1.12 — the anti-Goodhart shape of the verb itself
// ---------------------------------------------------------------------------

describe("est close — P1.12 accepts no measured quantity", () => {
  test("the flag table has no token, cost or velocity input, and no --amend", () => {
    expect(COMMAND_FLAGS.close).toEqual({ booleans: ["force"], values: ["status"] });
    const everyFlag = Object.values(COMMAND_FLAGS).flatMap((s) => [...s.booleans, ...s.values]);
    for (const forbidden of ["amend", "force-overwrite", "wcet", "actual", "tokens", "velocity", "cost"]) {
      expect(everyFlag).not.toContain(forbidden);
    }
  });

  test("`--fix` exists on exactly ONE verb, and that verb cannot touch the spine", async () => {
    // P2.12's `est audit --fix` is the single sanctioned repair path in the whole CLI,
    // and the guard here is that it stays single AND stays bounded. A `--fix` on any
    // verb that writes the append-only spine would be `--amend` under another name.
    const withFix = Object.entries(COMMAND_FLAGS)
      .filter(([, spec]) => spec.booleans.includes("fix") || spec.values.includes("fix"))
      .map(([verb]) => verb);
    expect(withFix).toEqual(["audit"]);

    const { FIXABLE, SPINE } = await import("../src/audit.ts");
    for (const table of SPINE) expect(table in FIXABLE).toBe(false);
  });

  test("`est delete` does not exist anywhere in the verb surface", () => {
    expect(Object.keys(COMMAND_FLAGS)).not.toContain("delete");
  });

  test("outcome is append-only in the database, not only in the CLI", async () => {
    const tid = await quietTask();
    closeTask(h.db, { tid, now: NOW });
    expect(() => h.db.query("UPDATE outcome SET actual_wcet = 1").run()).toThrow(/append-only/);
    expect(() => h.db.query("DELETE FROM outcome").run()).toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// P1.7 — the quiescence gate
// ---------------------------------------------------------------------------

describe("est close — P1.7 quiescence", () => {
  test("a live task is REJECTED (exit 2) and the message names the failing condition", async () => {
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    const r = await h.cli("close", tid);
    expect(r.code).toBe(2);
    expect(r.err).toContain("quiescence");
    expect(r.err).toMatch(/no completion signal|last attributed request/);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(0);
  });

  test("an open turn blocks the close even when everything else is quiet", async () => {
    const tid = await quietTask();
    turn(h.db, { session: "s1", prompt: "p2", at: minutesBefore(NOW, 5), durationMs: null });
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.ok).toBe(false);
    expect(gate.open_turns).toBe(1);
    expect(gate.failing.join(" ")).toContain("open turn");
  });

  test("a long-running turn is held open by its SESSION's activity, not by its start time", async () => {
    const tid = await quietTask();
    // The case the condition exists for: a turn 20 h in and still going. Its start is
    // far outside the quiet window; the requests it is still making are not.
    turn(h.db, { session: "s1", prompt: "p2", at: minutesBefore(NOW, 20 * 60), durationMs: null });
    request(h.db, "r-live", { prompt: "p2", out: 10, ts: minutesBefore(NOW, 10) });
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.open_turns).toBe(1);
    expect(gate.failing.join(" ")).toContain("open turn");
  });

  test("a NULL duration_ms in the session's HISTORY is not an open turn", async () => {
    const tid = await quietTask();
    // The harness writes `turn_duration` at turn end; a turn it never wrote one for
    // keeps `duration_ms IS NULL` for ever. Counting those would mean a single missing
    // record blocks every future close in that session — and later turns that closed
    // normally prove this one is not running.
    turn(h.db, { session: "s1", prompt: "p0", at: "2025-06-01T00:00:00Z", durationMs: null });
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.open_turns).toBe(0);
    expect(gate.ok).toBe(true);
  });

  test("a session whose LAST turn never got a turn_duration still closes once it goes quiet", async () => {
    const tid = await quietTask();
    // The shape a killed or crashed session leaves behind, and the common one: the
    // newest turn has no duration record and never will. Quiet for a month, it is a
    // dead record rather than a live turn, and `--force` must not be the only way out.
    turn(h.db, { session: "s1", prompt: "p2", at: "2026-01-01T00:05:00Z", durationMs: null });
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.open_turns).toBe(0);
    expect(gate.ok).toBe(true);
    expect((await h.cli("close", tid)).code).toBe(0);
  });

  test("a bound agent that never ended blocks the close", async () => {
    const tid = await quietTask();
    agentRun(h.db, "a-live", { session: "s1", launchPrompt: "p1", startedAt: LONG_AGO, endedAt: null });
    attributeTasks(h.db);
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.ok).toBe(false);
    expect(gate.nonterminal_agents).toBe(1);
  });

  test("--force overrides the gate, records anomaly(forced_close), and says FORCED", async () => {
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    const r = await h.cli("close", tid, "--force");
    expect(r.code).toBeLessThanOrEqual(3);
    expect(r.out).toContain("FORCED");
    const anomaly = h.db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'forced_close' AND tid = ?",
    ).get(tid);
    expect(anomaly?.n).toBe(1);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(1);
  });

  test("a quiet task closes cleanly at exit 0", async () => {
    const tid = await quietTask();
    const r = await h.cli("close", tid);
    expect(r.code).toBe(0);
    expect(r.out).toContain("closed");
    expect(r.out).not.toContain("FORCED");
  });

  test("an unknown tid is REJECTED (exit 2)", async () => {
    expect((await h.cli("close", "no-such-tid")).code).toBe(2);
  });

  test("a task with no estimate is REJECTED: an outcome with no baseline is not a measurement", () => {
    // Built by hand rather than by deleting an estimate, because `estimate` is
    // append-only BY TRIGGER — the delete this test would otherwise need is itself
    // one of the operations the design forbids.
    h.db.query(
      `INSERT INTO task (tid, kind, status, created_at, anchor_session, anchor_prompt)
       VALUES ('bare-tid', 'implement', 'estimating', ?, 's1', 'p1')`,
    ).run(LONG_AGO);
    h.db.query(
      `INSERT INTO task_scope (tid, seq, ts, subject, description, dod_json, scope_hash, source, reason, diff_summary)
       VALUES ('bare-tid', 1, ?, 'no estimate here', NULL, '[]', 'aaaa', 'est_open', NULL, NULL)`,
    ).run(LONG_AGO);
    expect(() => closeTask(h.db, { tid: "bare-tid", now: NOW })).toThrow(/no estimate/);
  });

  test("--status is validated against the closed set", async () => {
    const tid = await quietTask();
    expect((await h.cli("close", tid, "--status", "finished")).code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P1.7 — the arithmetic
// ---------------------------------------------------------------------------

describe("est close — P1.7 the actual is arithmetic", () => {
  test("actual_wcet, the origin split, request and agent counts all come from the logs", async () => {
    const tid = await quietTask();
    const r = closeTask(h.db, { tid, now: NOW });
    expect(r.actual_wcet).toBe(1000);
    expect(r.wcet_main).toBe(200);
    expect(r.wcet_sub).toBe(800);
    expect(r.wcet_aux).toBe(0);
    expect(r.n_requests).toBe(2);
    expect(r.n_agents).toBe(1);
  });

  test("the three clocks are the interval UNION, with parallelism reported", async () => {
    const tid = await quietTask();
    const r = closeTask(h.db, { tid, now: NOW });
    // turn 00:00:00–00:01:00 and agent 00:01:00–00:06:00 are back to back: 360 s of
    // union at concurrency 1, and busy == active because nothing overlapped.
    expect(r.active_s).toBe(360);
    expect(r.busy_s).toBe(360);
    expect(r.max_concurrency).toBe(1);
    expect(r.parallelism_factor).toBeCloseTo(1, 5);
  });

  test("velocity is computed from actual_wcet_at_epoch and judged against the FIRST estimate", async () => {
    const tid = await quietTask();
    // A refinement that moves the band must not become the baseline. BOTH ends move:
    // `est open` refuses a p90 below the p50, so the fixture cannot raise p50 alone.
    await h.cli(
      ...openArgs({ subject: "", "raw-p50": 1_000_000, "raw-p90": 3_000_000 }),
      "--tid",
      tid,
      "--reason",
      "refinement",
    );
    const r = closeTask(h.db, { tid, now: NOW });

    const eids = h.db.query<{ eid: number }, [string]>(
      "SELECT eid FROM estimate WHERE tid = ? ORDER BY eid",
    ).all(tid).map((x) => x.eid);
    expect(r.eid_at_start).toBe(eids[0]!);
    expect(r.eid_final).toBe(eids[1]!);
    // raw p50 was 1,000 and the actual is 1,000 Work-CET => velocity 1.0 against the
    // BASELINE. Against the refinement it would have been 0.001, which is the number
    // an estimator could manufacture if refinements re-pointed the baseline.
    expect(r.velocity_raw).toBeCloseTo(1, 6);
    expect(r.in_band).toBe(true);
  });

  test("velocity stays NULL rather than joining under a vintage that never existed", async () => {
    const tid = await quietTask();
    // Remove the ref model's price: `v_task_actual_epoch` can no longer normalise, so
    // the honest answer is "not computable" and the task drops out of the corpus.
    h.db.query("DELETE FROM model_price WHERE family = 'claude-sonnet-4-5'").run();
    const r = closeTask(h.db, { tid, now: NOW });
    expect(r.actual_wcet_at_epoch).toBeNull();
    expect(r.velocity_raw).toBeNull();
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM v_velocity WHERE bucket = 'global' AND velocity_raw IS NOT NULL").get("")?.n ?? 0,
    ).toBe(0);
  });

  test("ceremony overhead is reported separately and excluded from the actual", async () => {
    const tid = await openTask();
    request(h.db, "r-work", { out: 500, ts: "2026-01-01T00:01:00Z" });
    request(h.db, "r-ceremony", { out: 400, ts: "2026-01-01T00:01:30Z", skill: "estimating" });
    attributeTasks(h.db);
    const r = closeTask(h.db, { tid, now: NOW });
    expect(r.actual_wcet).toBe(500);
    expect(r.overhead_wcet).toBe(400);
  });

  test("an unpriced request is an alerting condition (exit 3), never a silently smaller actual", async () => {
    const tid = await openTask();
    request(h.db, "r-priced", { out: 500, ts: "2026-01-01T00:01:00Z" });
    request(h.db, "r-unpriced", { family: "claude-unknown-0", out: 5000, ts: "2026-01-01T00:01:30Z" });
    attributeTasks(h.db);
    const r = await h.cli("close", tid);
    expect(r.code).toBe(3);
    expect(r.out).toContain("unpriced_share");
    const row = h.db.query<{ unpriced_share: number }, [string]>(
      "SELECT unpriced_share FROM outcome WHERE tid = ?",
    ).get(tid)!;
    expect(row.unpriced_share).toBeCloseTo(0.5, 6);
  });

  test("abandoned and deleted are right-censored: the actual is a LOWER bound", async () => {
    const tid = await quietTask();
    const r = closeTask(h.db, { tid, status: "abandoned", now: NOW });
    expect(r.censored).toBe(true);
    expect(h.db.query<{ status: string }, [string]>("SELECT status FROM task WHERE tid = ?").get(tid)!.status).toBe("abandoned");
    // Censored rows are kept for the cost distribution and excluded from velocity.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_velocity").get()?.n).toBe(0);
  });

  test("a scope revision since the baseline is recorded, and an undeclared drift is an anomaly", async () => {
    const tid = await quietTask();
    // Drift with no `est scope` call: appended directly, the way the sweeper would
    // discover it. The close must notice that the scope moved without a declaration.
    h.db.query(
      `INSERT INTO task_scope (tid, seq, ts, subject, description, dod_json, scope_hash, source, reason, diff_summary)
       VALUES (?, 2, ?, 'drifted subject', NULL, '[]', 'deadbeef', 'sweeper_diff', NULL, NULL)`,
    ).run(tid, LONG_AGO);
    const r = closeTask(h.db, { tid, now: NOW });
    expect(r.scope_changed).toBe(true);
    expect(r.scope_declared).toBe(false);
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM anomaly WHERE kind='scope_undeclared' AND tid = ?").get(tid)?.n,
    ).toBe(1);
  });

  test("the burn cache row is dropped on close, so the statusline cannot show a closed band", async () => {
    const tid = await quietTask();
    h.db.query(
      "INSERT INTO burn_cache (tid, as_of, consumed_wcet) VALUES (?, ?, 1)",
    ).run(tid, LONG_AGO);
    closeTask(h.db, { tid, now: NOW });
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM burn_cache").get()?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P1.7 — the close's attribution pass never moves a sibling's spend
// ---------------------------------------------------------------------------

describe("est close — P1.7 the attribution pass is global", () => {
  test("closing one task leaves a SIBLING task's agent spend where it was", async () => {
    const a = await quietTask();

    // A second task in the same session, owning a sub-agent of its own — the shape
    // `est bind --agent` produces, and the one an attribution pass that could see only
    // the closing task would resolve to "nobody claims this agent, so the session's
    // one task must own it".
    const open = await h.cli(
      ...openArgs({ subject: "sibling work" }), "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(open.code).toBe(0);
    const b = open.json<{ tid: string }>().tid;
    agentRun(h.db, "ag-b", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: "2026-01-01T00:03:00Z",
      endedAt: "2026-01-01T00:04:00Z",
    });
    expect((await h.cli("bind", b, "--agent", "ag-b")).code).toBe(0);
    request(h.db, "r-b", {
      origin: "subagent",
      agent: "ag-b",
      prompt: null,
      out: 500,
      ts: "2026-01-01T00:03:30Z",
    });
    attributeTasks(h.db);

    const ownerOf = (rid: string): string | null =>
      h.db.query<{ tid: string | null }, [string]>("SELECT tid FROM request WHERE request_id = ?").get(rid)!.tid;
    expect(ownerOf("r-b")).toBe(b);

    const closed = closeTask(h.db, { tid: a, now: NOW });
    // `outcome` is append-only, so a stolen request here would be permanently wrong.
    expect(closed.actual_wcet).toBe(1000);
    expect(closed.n_requests).toBe(2);
    expect(ownerOf("r-b")).toBe(b);
    expect(
      h.db.query<{ tid: string | null }, [string]>("SELECT tid FROM agent_run WHERE agent_id = ?").get("ag-b")!.tid,
    ).toBe(b);
    expect(
      h.db.query<{ wcet: number | null }, [string]>("SELECT wcet FROM v_task_actual WHERE tid = ?").get(b)?.wcet,
    ).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// P1.7 — reopen is a revision, never an edit
// ---------------------------------------------------------------------------

describe("est close — P1.7 reopen", () => {
  test("a second close appends revision 2 and v_outcome_current reads only the latest", async () => {
    const tid = await quietTask();
    expect(closeTask(h.db, { tid, now: NOW }).revision).toBe(1);
    const reopened = closeTask(h.db, { tid, status: "reopened", now: NOW });
    expect(reopened.revision).toBe(2);

    expect(h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM outcome WHERE tid = ?").get(tid)?.n).toBe(2);
    const current = h.db.query<{ revision: number; final_status: string }, [string]>(
      "SELECT revision, final_status FROM v_outcome_current WHERE tid = ?",
    ).get(tid)!;
    expect(current).toMatchObject({ revision: 2, final_status: "reopened" });
    // A reopened task is workable again: its status returns to in_progress.
    expect(h.db.query<{ status: string }, [string]>("SELECT status FROM task WHERE tid = ?").get(tid)!.status).toBe("in_progress");
  });

  test("estimates may be appended again after a reopen, but not while terminal", async () => {
    const tid = await quietTask();
    closeTask(h.db, { tid, now: NOW });
    const blocked = await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "refinement");
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain("finalized");

    closeTask(h.db, { tid, status: "reopened", now: NOW });
    const allowed = await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "refinement");
    expect(allowed.code).toBe(0);
  });

  test("closing twice never overwrites the first outcome's numbers", async () => {
    const tid = await quietTask();
    const first = closeTask(h.db, { tid, now: NOW });
    request(h.db, "r-late", { out: 5000, ts: "2026-01-10T00:00:00Z" });
    closeTask(h.db, { tid, status: "reopened", now: NOW });
    const stored = h.db.query<{ actual_wcet: number }, [string]>(
      "SELECT actual_wcet FROM outcome WHERE tid = ? AND revision = 1",
    ).get(tid)!;
    expect(stored.actual_wcet).toBe(first.actual_wcet);
  });
});

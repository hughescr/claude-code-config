/**
 * test/attribute.test.ts — §5.4 attribution, and the four defects that broke the
 * tid chain between `est bind` and `burn_cache`.
 *
 * The chain as designed is `est bind` -> `task_alias` -> `attributeTasks` ->
 * `turn.tid` -> `agent_run.tid` (inherited from the launching turn) -> `request.tid`
 * -> `v_wcet WHERE tid = ?` -> `burn_cache`. Every link but one worked, and the one
 * that did not was invisible to the existing tests because they all used SHORT
 * sessions: the staleness counter was incremented for every candidate task on every
 * turn of a bound session, INCLUDING the turns that predate the task's own window,
 * so a task opened on turn 31 of a 48-turn session arrived at its own anchor turn
 * already past `attr_stale_turns` and the anchor turn — and, worse, the turn that
 * launched its agents — were refused. Because a sub-agent inherits from the turn,
 * one refused launching turn orphaned every agent and every request beneath it.
 *
 * Every fixture here is synthetic (§4: no real id, path or absolute token figure in
 * a tracked file). These tests deliberately do NOT go through `est open`: they seed
 * `task`/`task_alias` directly, so what is under test is the attribution pass rather
 * than the ceremony that happens to be its usual caller.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { agentRun, makeHarness, price, request, seedPrices, turn, type Harness } from "./support.ts";
import { attributeTasks } from "../src/attribute.ts";

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-attr-");
  seedPrices(h.db);
});

afterEach(() => {
  h.close();
});

// ---------------------------------------------------------------------------
// seeding — `task` + `task_alias` directly, no ceremony
// ---------------------------------------------------------------------------

interface TaskSpec {
  session?: string;
  prompt?: string;
  createdAt?: string;
  status?: string;
  /** Bind the session too (the `est open` default). */
  bindSession?: boolean;
}

function seedTask(db: Database, tid: string, spec: TaskSpec = {}): string {
  const session = spec.session ?? "s1";
  const prompt = spec.prompt ?? "p1";
  db.query(
    `INSERT INTO task (tid, kind, status, created_at, started_at, ended_at, anchor_session, anchor_prompt)
     VALUES (?, 'implement', ?, ?, NULL, NULL, ?, ?)`,
  ).run(tid, spec.status ?? "in_progress", spec.createdAt ?? "2026-01-01T00:00:00Z", session, prompt);
  if (spec.bindSession !== false) alias(db, tid, "session", session, session);
  return tid;
}

function alias(db: Database, tid: string, kind: string, session: string, localId: string): void {
  db.query(
    `INSERT OR REPLACE INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z', 'manual')`,
  ).run(tid, kind, session, localId);
}

function workflowRun(
  db: Database,
  runId: string,
  spec: { launchId?: string; session?: string; launchPrompt?: string | null; startedAt?: string; endedAt?: string | null } = {},
): void {
  db.query(
    `INSERT OR REPLACE INTO workflow_run
       (run_id, wf_launch_id, session_id, workflow_name, transcript_dir, default_model,
        launch_prompt_id, n_phases_planned, started_at, ended_at, tid)
     VALUES (?, ?, ?, 'demo', NULL, NULL, ?, 2, ?, ?, NULL)`,
  ).run(
    runId,
    spec.launchId ?? `${runId}-l1`,
    spec.session ?? "s1",
    spec.launchPrompt === undefined ? "p1" : spec.launchPrompt,
    spec.startedAt ?? "2026-01-01T00:00:00Z",
    spec.endedAt === undefined ? "2026-01-01T00:10:00Z" : spec.endedAt,
  );
}

const turnTid = (session: string, prompt: string): string | null =>
  h.db
    .query<{ tid: string | null }, [string, string]>(
      "SELECT tid FROM turn WHERE session_id = ? AND prompt_id = ?",
    )
    .get(session, prompt)?.tid ?? null;

const agentTid = (agentId: string): string | null =>
  h.db.query<{ tid: string | null }, [string]>("SELECT tid FROM agent_run WHERE agent_id = ?").get(agentId)
    ?.tid ?? null;

const runTid = (runId: string): string | null =>
  h.db.query<{ tid: string | null }, [string]>("SELECT tid FROM workflow_run WHERE run_id = ?").get(runId)
    ?.tid ?? null;

const req = (id: string): { tid: string | null; attr: string } =>
  h.db
    .query<{ tid: string | null; attr: string }, [string]>(
      "SELECT tid, attr FROM request WHERE request_id = ?",
    )
    .get(id)!;

const TID = "019f0000-0000-7000-8000-000000000001";
const TID2 = "019f0000-0000-7000-8000-000000000002";

// ---------------------------------------------------------------------------
// F1 — a turn before the window opened is not evidence the task went quiet
// ---------------------------------------------------------------------------

describe("F1: the attribution window is not dead on arrival", () => {
  /**
   * The exact refusal that cost ~90% of a real task's measured spend. Six turns
   * predate the anchor and `attr_stale_turns` is 5, so the pre-fix counter had the
   * task at six turns quiet the instant its own window opened — and refused both the
   * anchor turn and the turn that launched its agents.
   */
  test("the ANCHOR turn and the turn that launches its agents are exclusive, not pre_task", () => {
    // Six turns of unrelated work first. In a real 48-turn session this is 30.
    for (let i = 0; i < 6; i += 1) {
      turn(h.db, { session: "s1", prompt: `pre${i}`, at: `2026-02-01T09:${String(i * 5).padStart(2, "0")}:00Z` });
    }
    turn(h.db, { session: "s1", prompt: "anchor", at: "2026-02-01T10:00:00Z", durationMs: 60_000 });
    turn(h.db, { session: "s1", prompt: "launch", at: "2026-02-01T10:05:00Z", durationMs: 30_000 });
    seedTask(h.db, TID, { session: "s1", prompt: "anchor", createdAt: "2026-02-01T10:00:00Z" });

    agentRun(h.db, "ag1", {
      session: "s1",
      launchPrompt: "launch",
      startedAt: "2026-02-01T10:05:30Z",
      endedAt: "2026-02-01T10:40:00Z",
    });
    request(h.db, "rq-anchor", { session: "s1", prompt: "anchor", ts: "2026-02-01T10:00:10Z", out: 10 });
    request(h.db, "rq-launch", { session: "s1", prompt: "launch", ts: "2026-02-01T10:05:10Z", out: 10 });
    request(h.db, "rq-agent", {
      session: "s1",
      prompt: "launch",
      origin: "subagent",
      agent: "ag1",
      ts: "2026-02-01T10:20:00Z",
      out: 100,
    });

    const result = attributeTasks(h.db);
    expect(turnTid("s1", "anchor")).toBe(TID);
    expect(turnTid("s1", "launch")).toBe(TID);
    // The whole point: the sub-agent inherits from the launching turn, so a refused
    // launching turn orphans it and every request under it.
    expect(agentTid("ag1")).toBe(TID);
    expect(req("rq-anchor")).toEqual({ tid: TID, attr: "exclusive" });
    expect(req("rq-launch")).toEqual({ tid: TID, attr: "exclusive" });
    expect(req("rq-agent")).toEqual({ tid: TID, attr: "exclusive" });
    expect(result.turns_assigned).toBe(2);
    expect(result.agents_assigned).toBe(1);
  });

  test("turns BEFORE the window are still refused — the residual class is not widened", () => {
    turn(h.db, { session: "s1", prompt: "early", at: "2026-02-01T09:00:00Z" });
    turn(h.db, { session: "s1", prompt: "anchor", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "anchor", createdAt: "2026-02-01T10:00:00Z" });
    request(h.db, "rq-early", { session: "s1", prompt: "early", ts: "2026-02-01T09:00:10Z", out: 10 });

    attributeTasks(h.db);
    expect(turnTid("s1", "early")).toBeNull();
    expect(req("rq-early")).toEqual({ tid: null, attr: "pre_task" });
  });

  test("a task that really does go quiet still closes after `attr_stale_turns`", () => {
    turn(h.db, { session: "s1", prompt: "anchor", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "anchor", createdAt: "2026-02-01T10:00:00Z" });
    // A SECOND task in the same session keeps winning the turns, so the first goes
    // quiet inside its own window — which is the case staleness exists for.
    turn(h.db, { session: "s1", prompt: "anchor2", at: "2026-02-01T10:01:00Z" });
    seedTask(h.db, TID2, { session: "s1", prompt: "anchor2", createdAt: "2026-02-01T10:01:00Z" });
    for (let i = 0; i < 8; i += 1) {
      turn(h.db, { session: "s1", prompt: `t${i}`, at: `2026-02-01T10:${String(2 + i).padStart(2, "0")}:00Z` });
    }
    attributeTasks(h.db);
    // The later task keeps absorbing; the earlier one is closed out by the quiet
    // counter and stops being a candidate, so the turns stop being `ambiguous`.
    const attrs = h.db
      .query<{ tid: string | null; n: number }, []>(
        "SELECT tid, COUNT(*) AS n FROM turn WHERE prompt_id LIKE 't%' GROUP BY tid",
      )
      .all();
    expect(attrs.some((r) => r.tid === TID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F2 — §5.4's third touch: a delegation attributed to the task
// ---------------------------------------------------------------------------

describe("F2: a running delegation keeps its task alive", () => {
  test("a 30s turn launching a 3h agent still owns a turn 2.5h later", () => {
    turn(h.db, { session: "s1", prompt: "launch", at: "2026-02-01T12:00:00Z", durationMs: 30_000 });
    seedTask(h.db, TID, { session: "s1", prompt: "launch", createdAt: "2026-02-01T12:00:00Z" });
    agentRun(h.db, "ag1", {
      session: "s1",
      launchPrompt: "launch",
      startedAt: "2026-02-01T12:00:30Z",
      endedAt: "2026-02-01T15:00:00Z",
    });
    // 2.5h after the launching turn: 150 minutes, past the 120-minute wall clock.
    turn(h.db, { session: "s1", prompt: "checkin", at: "2026-02-01T14:30:00Z" });
    request(h.db, "rq-checkin", { session: "s1", prompt: "checkin", ts: "2026-02-01T14:30:10Z", out: 10 });

    attributeTasks(h.db);
    expect(turnTid("s1", "checkin")).toBe(TID);
    expect(req("rq-checkin").attr).toBe("exclusive");
  });

  test("without a delegation the wall clock still closes the task", () => {
    turn(h.db, { session: "s1", prompt: "launch", at: "2026-02-01T12:00:00Z", durationMs: 30_000 });
    seedTask(h.db, TID, { session: "s1", prompt: "launch", createdAt: "2026-02-01T12:00:00Z" });
    turn(h.db, { session: "s1", prompt: "checkin", at: "2026-02-01T14:30:00Z" });

    attributeTasks(h.db);
    expect(turnTid("s1", "launch")).toBe(TID);
    expect(turnTid("s1", "checkin")).toBeNull();
  });

  test("an EXPLICITLY bound background run keeps its task alive across a quiet session", () => {
    turn(h.db, { session: "s1", prompt: "launch", at: "2026-02-01T12:00:00Z", durationMs: 30_000 });
    seedTask(h.db, TID, { session: "s1", prompt: "launch", createdAt: "2026-02-01T12:00:00Z" });
    // `est bind --run` — the run's launching turn is not even in this session.
    workflowRun(h.db, "wfA", {
      session: "sX",
      launchPrompt: null,
      startedAt: "2026-02-01T12:01:00Z",
      endedAt: "2026-02-01T15:00:00Z",
    });
    alias(h.db, TID, "workflow_run", "", "wfA");
    turn(h.db, { session: "s1", prompt: "checkin", at: "2026-02-01T14:30:00Z" });

    attributeTasks(h.db);
    expect(turnTid("s1", "checkin")).toBe(TID);
  });
});

// ---------------------------------------------------------------------------
// F3 — workflow_run.tid, which had no writer at all
// ---------------------------------------------------------------------------

describe("F3: workflow_run.tid is written, by all three routes", () => {
  test("route 1 — an explicit `est bind --run` alias", () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "p1" });
    workflowRun(h.db, "wfA", { session: "sX", launchPrompt: null });
    alias(h.db, TID, "workflow_run", "", "wfA");

    const result = attributeTasks(h.db);
    expect(runTid("wfA")).toBe(TID);
    expect(result.runs_assigned).toBe(1);
  });

  test("route 2 — the launching turn, the same rule agents follow", () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "p1" });
    workflowRun(h.db, "wfB", { session: "s1", launchPrompt: "p1" });

    attributeTasks(h.db);
    expect(runTid("wfB")).toBe(TID);
  });

  test("route 3 — a majority of the run's own agents, tie broken on the tid string", () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T10:00:00Z" });
    turn(h.db, { session: "s1", prompt: "p2", at: "2026-02-01T10:01:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "p1" });
    seedTask(h.db, TID2, { session: "s1", prompt: "p2" });
    // No launch prompt on the run at all, so only its agents can speak for it.
    workflowRun(h.db, "wfC", { session: "s1", launchPrompt: null });
    agentRun(h.db, "agA", { session: "s1", launchPrompt: "p1", runId: "wfC" });
    agentRun(h.db, "agB", { session: "s1", launchPrompt: "p2", runId: "wfC" });
    agentRun(h.db, "agC", { session: "s1", launchPrompt: "p2", runId: "wfC" });

    attributeTasks(h.db);
    // Two agents for TID2 against one for TID.
    expect(runTid("wfC")).toBe(TID2);
  });

  test("a re-sweep of unchanged inputs does not flip a tied majority", () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T10:00:00Z" });
    turn(h.db, { session: "s1", prompt: "p2", at: "2026-02-01T10:01:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "p1" });
    seedTask(h.db, TID2, { session: "s1", prompt: "p2" });
    workflowRun(h.db, "wfD", { session: "s1", launchPrompt: null });
    agentRun(h.db, "agA", { session: "s1", launchPrompt: "p1", runId: "wfD" });
    agentRun(h.db, "agB", { session: "s1", launchPrompt: "p2", runId: "wfD" });

    attributeTasks(h.db);
    const first = runTid("wfD");
    // Ties break on the tid string ASC, so the answer is a fact about the data, not
    // about map iteration order.
    expect(first).toBe(TID < TID2 ? TID : TID2);
    attributeTasks(h.db);
    expect(runTid("wfD")).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// F4 — clear-then-write, so attribution can REMOVE a claim
// ---------------------------------------------------------------------------

describe("F4: a claim that is lost is cleared, not retained", () => {
  test("unbinding the alias and re-running clears turn, agent_run and workflow_run", () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "p1" });
    workflowRun(h.db, "wfA", { session: "s1", launchPrompt: "p1" });
    agentRun(h.db, "ag1", { session: "s1", launchPrompt: "p1", runId: "wfA" });
    request(h.db, "rq-1", { session: "s1", prompt: "p1", ts: "2026-02-01T10:00:10Z", out: 10 });

    attributeTasks(h.db);
    expect(turnTid("s1", "p1")).toBe(TID);
    expect(agentTid("ag1")).toBe(TID);
    expect(runTid("wfA")).toBe(TID);
    expect(req("rq-1").tid).toBe(TID);

    h.db.query("DELETE FROM task_alias WHERE tid = ?").run(TID);
    attributeTasks(h.db);
    // Before the clear-then-write these three kept a stale tid forever: the writers
    // only ever SET, so no amount of re-sweeping could take a claim back and a
    // mis-attribution was permanent.
    expect(turnTid("s1", "p1")).toBeNull();
    expect(agentTid("ag1")).toBeNull();
    expect(runTid("wfA")).toBeNull();
    expect(req("rq-1")).toEqual({ tid: null, attr: "none" });
  });

  test("spend MOVES between tasks when the binding says it should", () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "p1" });
    workflowRun(h.db, "wfA", { session: "sX", launchPrompt: null });
    alias(h.db, TID, "workflow_run", "", "wfA");
    agentRun(h.db, "ag1", { session: "sX", launchPrompt: null, runId: "wfA" });
    request(h.db, "rq-1", { session: "sX", prompt: null, origin: "subagent", agent: "ag1", run: "wfA", out: 100 });

    attributeTasks(h.db);
    expect(req("rq-1").tid).toBe(TID);

    // Re-point by removing the wrong binding and adding the right one — the shape a
    // corrected `est bind` leaves behind.
    turn(h.db, { session: "s1", prompt: "p2", at: "2026-02-01T10:01:00Z" });
    seedTask(h.db, TID2, { session: "s1", prompt: "p2" });
    h.db.query("DELETE FROM task_alias WHERE tid = ? AND id_kind = 'workflow_run'").run(TID);
    alias(h.db, TID2, "workflow_run", "", "wfA");

    attributeTasks(h.db);
    expect(req("rq-1").tid).toBe(TID2);
    expect(agentTid("ag1")).toBe(TID2);
    expect(runTid("wfA")).toBe(TID2);
  });

  test("idempotent: the second pass over unchanged inputs writes nothing", () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "p1" });
    agentRun(h.db, "ag1", { session: "s1", launchPrompt: "p1" });
    request(h.db, "rq-1", { session: "s1", prompt: "p1", ts: "2026-02-01T10:00:10Z", out: 10 });

    const first = attributeTasks(h.db);
    expect(first.requests_assigned).toBe(1);
    const second = attributeTasks(h.db);
    expect(second.requests_assigned).toBe(0);
    expect(second.turns_assigned).toBe(first.turns_assigned);
    expect(second.agents_assigned).toBe(first.agents_assigned);
    expect(second.runs_assigned).toBe(first.runs_assigned);
    expect(turnTid("s1", "p1")).toBe(TID);
  });

  /**
   * The half of F4 that the test above cannot see, because deleting the ONLY task's
   * alias takes the `aliases.length === 0` early return and `clearAllClaims`.
   *
   * With a SIBLING task still holding its own aliases the pass takes the main path,
   * and there the request SELECT used to be scoped to "bound sessions plus sessions
   * of agents that resolved a tid". Unbinding one task takes its session out of that
   * scope, so its request rows were never revisited: `turn`/`agent_run`/
   * `workflow_run` correctly went NULL, while `request` — the one table `v_wcet`,
   * `burn_cache` and `outcome` all read — kept `tid` and `attr='exclusive'` forever.
   */
  test("a session that LEAVES attribution scope loses its request claims too", () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "p1" });
    request(h.db, "rq-1", { session: "s1", prompt: "p1", ts: "2026-02-01T10:00:10Z", out: 10 });
    // The sibling: its aliases survive the unbind, so `clearAllClaims` is NOT reached.
    turn(h.db, { session: "s2", prompt: "p2", at: "2026-02-01T11:00:00Z" });
    seedTask(h.db, TID2, { session: "s2", prompt: "p2" });
    request(h.db, "rq-2", { session: "s2", prompt: "p2", ts: "2026-02-01T11:00:10Z", out: 10 });

    attributeTasks(h.db);
    expect(req("rq-1")).toEqual({ tid: TID, attr: "exclusive" });

    h.db.query("DELETE FROM task_alias WHERE tid = ?").run(TID);
    attributeTasks(h.db);

    expect(turnTid("s1", "p1")).toBeNull();
    expect(req("rq-1")).toEqual({ tid: null, attr: "none" });
    // The sibling is untouched — the widened SELECT re-evaluates, it does not clear.
    expect(req("rq-2")).toEqual({ tid: TID2, attr: "exclusive" });
    const booked = h.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM v_wcet WHERE tid = ?")
      .get(TID)!.n;
    expect(booked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F5 — a reused runId is not an identity, and a delegation bound elsewhere is
//      not evidence about the task that happened to launch it
// ---------------------------------------------------------------------------

describe("F5: relaunch and delegation ownership", () => {
  /**
   * `workflow_run`'s primary key is (run_id, wf_launch_id) precisely because the
   * harness REUSES a runId across relaunches. `task_alias` can only name the runId,
   * so an alias written for launch 1 used to swallow launch 2 whole — its agent, its
   * `workflow_run` row and its requests all booked `exclusive` to the first task,
   * even though launch 2's own launching turn resolved to the second task. `est bind`
   * could not undo it either: `--run` cannot name a launch and a competing bind is
   * refused outright.
   */
  test("a relaunch under a REUSED runId keeps its own task's spend", () => {
    turn(h.db, { session: "sA", prompt: "pA", at: "2026-03-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "sA", prompt: "pA" });
    turn(h.db, { session: "sB", prompt: "pB", at: "2026-03-01T12:00:00Z" });
    seedTask(h.db, TID2, { session: "sB", prompt: "pB" });

    // Launch 1: task A's, and the only thing the alias can name is the runId.
    workflowRun(h.db, "wfR", {
      launchId: "L1",
      session: "sA",
      launchPrompt: "pA",
      startedAt: "2026-03-01T10:00:30Z",
      endedAt: "2026-03-01T10:20:00Z",
    });
    alias(h.db, TID, "workflow_run", "sA", "wfR");
    agentRun(h.db, "ag-L1", {
      session: "sA",
      runId: "wfR",
      launchId: "L1",
      launchPrompt: "pA",
      startedAt: "2026-03-01T10:00:30Z",
      endedAt: "2026-03-01T10:20:00Z",
    });

    // Launch 2: the SAME runId, task B's, with its own launching turn.
    workflowRun(h.db, "wfR", {
      launchId: "L2",
      session: "sB",
      launchPrompt: "pB",
      startedAt: "2026-03-01T12:00:30Z",
      endedAt: "2026-03-01T12:20:00Z",
    });
    agentRun(h.db, "ag-L2", {
      session: "sB",
      runId: "wfR",
      launchId: "L2",
      launchPrompt: "pB",
      startedAt: "2026-03-01T12:00:30Z",
      endedAt: "2026-03-01T12:20:00Z",
    });
    request(h.db, "rq-L2", {
      session: "sB",
      prompt: null,
      origin: "subagent",
      agent: "ag-L2",
      run: "wfR",
      launchId: "L2",
      ts: "2026-03-01T12:05:00Z",
      out: 100,
    });

    attributeTasks(h.db);

    expect(turnTid("sB", "pB")).toBe(TID2);
    expect(agentTid("ag-L1")).toBe(TID);
    expect(agentTid("ag-L2")).toBe(TID2);
    expect(req("rq-L2").tid).toBe(TID2);
    const launchTid = (l: string): string | null =>
      h.db
        .query<{ tid: string | null }, [string, string]>(
          "SELECT tid FROM workflow_run WHERE run_id = ? AND wf_launch_id = ?",
        )
        .get("wfR", l)?.tid ?? null;
    expect(launchTid("L1")).toBe(TID);
    expect(launchTid("L2")).toBe(TID2);
  });

  /**
   * The majority vote, which used to pool every launch that ever used the runId while
   * writing its answer into a row keyed by (run, launch) — so the function contradicted
   * itself: a launch whose ONLY agent belonged to task B was stamped with task A on
   * the strength of an earlier launch's three agents.
   */
  test("the majority vote counts only the LAUNCH's own agents", () => {
    turn(h.db, { session: "sA", prompt: "pA", at: "2026-03-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "sA", prompt: "pA" });
    seedTask(h.db, TID2, { session: "sZ", prompt: "pZ", bindSession: false });

    // Launch 1: three agents, all inheriting task A from their launching turn.
    workflowRun(h.db, "wfR", { launchId: "L1", session: "sA", launchPrompt: "pA" });
    for (const id of ["ag-a", "ag-b", "ag-c"]) {
      agentRun(h.db, id, { session: "sA", runId: "wfR", launchId: "L1", launchPrompt: "pA" });
    }
    // Launch 2: no launching turn of its own, one agent explicitly bound to task B.
    workflowRun(h.db, "wfR", { launchId: "L2", session: "sA", launchPrompt: null });
    agentRun(h.db, "ag-d", { session: "sA", runId: "wfR", launchId: "L2", launchPrompt: null });
    alias(h.db, TID2, "agent", "sA", "ag-d");

    attributeTasks(h.db);

    const launchTid = (l: string): string | null =>
      h.db
        .query<{ tid: string | null }, [string, string]>(
          "SELECT tid FROM workflow_run WHERE run_id = ? AND wf_launch_id = ?",
        )
        .get("wfR", l)?.tid ?? null;
    expect(launchTid("L1")).toBe(TID);
    expect(launchTid("L2")).toBe(TID2);
  });

  /**
   * The delegation fold extends the chosen task's `lastTouch` to the END of what the
   * turn launched, which is right when the delegation is the task's own and wrong when
   * it is not: an agent bound to task B but launched by a turn that resolved to task A
   * pushed A's liveness hours into the future, and A then won every remaining turn on
   * the "most recently touched" tiebreak. The control is the same fixture with the
   * agent's `launch_prompt_id` set to NULL, which is what proves the fold is the cause.
   */
  test("a delegation bound to ANOTHER task does not extend this task's liveness", () => {
    const at = (mm: string): string => `2026-04-01T${mm}:00Z`;
    for (const [prompt, t] of [
      ["t0", "10:00"],
      ["t1", "10:05"],
      ["t2", "10:10"],
      ["t3", "10:20"],
      ["t4", "10:30"],
    ] as const) {
      turn(h.db, { session: "s1", prompt, at: at(t), durationMs: 1000 });
    }
    seedTask(h.db, TID, { session: "s1", prompt: "t0", createdAt: at("10:00") });
    seedTask(h.db, TID2, { session: "s1", prompt: "t1", createdAt: at("10:05") });
    // A `task_scope` write is a touch: it is what makes t2 resolve to TID rather than
    // to the newer TID2, so the fixture has a turn owned by the "wrong" task.
    h.db
      .query(
        `INSERT INTO task_scope (tid, seq, ts, subject, description, dod_json, scope_hash, source)
         VALUES (?, 1, ?, 'demo', NULL, '[]', 'h', 'est_scope')`,
      )
      .run(TID, at("10:09"));

    // The long-running delegation belongs to TID2, and t2 launched it.
    agentRun(h.db, "ag-bg", {
      session: "s1",
      launchPrompt: "t2",
      // Starts just AFTER t2, so t2 itself is decided by the `task_scope` touch and
      // the in-flight span only begins to speak from t3 onwards.
      startedAt: "2026-04-01T10:10:30Z",
      endedAt: "2026-04-01T14:00:00Z",
    });
    alias(h.db, TID2, "agent", "s1", "ag-bg");

    attributeTasks(h.db);

    expect(turnTid("s1", "t2")).toBe(TID);
    // Folded, these two went to TID on a touch that was really TID2's.
    expect(turnTid("s1", "t3")).toBe(TID2);
    expect(turnTid("s1", "t4")).toBe(TID2);
  });
});

// ---------------------------------------------------------------------------
// F6 — the ceremony bucket is the ceremony's own spend, not everything downstream
// ---------------------------------------------------------------------------

describe("F6: rule 1's `overhead` bucket is scoped to the MAIN chain", () => {
  /**
   * `attribution_skill` records the skill that was ACTIVE on the turn, and the
   * harness propagates it across agent boundaries: every subagent launched from an
   * anchoring turn inherits `estimating`. Rule 1 reads that tag to route the
   * ceremony's own spend to `overhead` (excluded from `actual_wcet`), so before the
   * `origin='main'` qualifier it also swallowed the delegated WORK — the exact shape
   * measured live, where 820 inherited-tag subagent requests left one task reading a
   * fraction of its true Work-CET.
   *
   * Synthetic figures throughout; what is pinned is the SPLIT, not the magnitudes.
   */
  test("a subagent request tagged `estimating` attributes to the task; the main-chain one is overhead", () => {
    turn(h.db, { session: "s1", prompt: "anchor", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "anchor", createdAt: "2026-02-01T10:00:00Z" });
    agentRun(h.db, "ag-work", {
      session: "s1",
      launchPrompt: "anchor",
      startedAt: "2026-02-01T10:00:30Z",
      endedAt: "2026-02-01T10:20:00Z",
    });

    // The ceremony itself: `est open` running on the anchor turn, main chain.
    request(h.db, "rq-ceremony", {
      session: "s1",
      prompt: "anchor",
      origin: "main",
      ts: "2026-02-01T10:00:10Z",
      out: 100,
      skill: "estimating",
    });
    // The delegated work, wearing the SAME tag purely because it descends from that
    // turn. `origin` is the only thing that tells the two apart.
    request(h.db, "rq-sub", {
      session: "s1",
      prompt: "anchor",
      origin: "subagent",
      agent: "ag-work",
      ts: "2026-02-01T10:10:00Z",
      out: 900,
      skill: "estimating",
    });

    attributeTasks(h.db);
    expect(req("rq-ceremony")).toEqual({ tid: TID, attr: "overhead" });
    expect(req("rq-sub")).toEqual({ tid: TID, attr: "exclusive" });

    // And the split is what `v_task_actual` reads: `overhead` is excluded from the
    // task's Work-CET, the inherited-tag subagent spend is not. Priced 1:1 by the
    // harness's test family, so 900 out-tokens is 900 Work-CET.
    const actual = h.db
      .query<{ wcet: number; wcet_task_effort: number; overhead_wcet: number }, [string]>(
        "SELECT wcet, wcet_task_effort, overhead_wcet FROM v_task_actual WHERE tid = ?",
      )
      .get(TID);
    expect(actual).toEqual({ wcet: 900, wcet_task_effort: 900, overhead_wcet: 100 });
  });

  test("an auxiliary request carrying the inherited tag is not booked to the ceremony either", () => {
    turn(h.db, { session: "s1", prompt: "anchor", at: "2026-02-01T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "anchor", createdAt: "2026-02-01T10:00:00Z" });
    request(h.db, "rq-aux", {
      session: "s1",
      prompt: "anchor",
      origin: "auxiliary",
      ts: "2026-02-01T10:02:00Z",
      out: 50,
      skill: "estimating",
    });

    attributeTasks(h.db);
    expect(req("rq-aux")).toEqual({ tid: TID, attr: "exclusive" });
  });
});

// ---------------------------------------------------------------------------
// The whole chain, through the real sweep, against the fixture corpus
// ---------------------------------------------------------------------------

/**
 * The regression the unit tests above cannot give: `est sweep` ingesting a corpus
 * off disk, attributing it, and materialising a burn row — which is the path a
 * statusline actually reads. The fixture session carries two turns, one workflow run
 * with two agents, one Agent-tool agent, and requests on all three, so "did the
 * sub-agent and workflow spend make it into the total" is answerable by arithmetic
 * rather than by inspection.
 */
describe("the full sweep path: bind -> sweep -> agent_run/workflow_run tids -> burn", () => {
  const CORPUS = join(import.meta.dir, "fixtures", "corpus", "projects");
  const SESSION = "11111111-1111-4111-8111-111111111111";

  function priceFixtureFamilies(db: Database): void {
    for (const f of ["claude-fable-5", "claude-sonnet-5", "claude-opus-5[1m]", "claude-opus-4-8"]) {
      price(db, f, { in: 1, out: 1, cw: 1, cr: 1 });
    }
  }

  test("agent_run and workflow_run inherit the tid, and burn counts sub-agent + workflow spend", async () => {
    priceFixtureFamilies(h.db);
    // Bound before the sweep, exactly as `est open` would leave it: the anchor turn
    // is the fixture's first turn, so the whole session is inside the window.
    seedTask(h.db, TID, { session: SESSION, prompt: "P1", createdAt: "2026-07-28T10:00:00Z" });

    const r = await h.cli("sweep", "--root", CORPUS, "--json");
    expect([0, 3]).toContain(r.code);
    const report = r.json<{ attribution: { turns: number; agents: number; runs: number } }>();

    // Two turns, three agents (two workflow + one Agent-tool), one workflow run.
    expect(report.attribution.turns).toBe(2);
    expect(report.attribution.agents).toBe(3);
    expect(report.attribution.runs).toBe(1);

    const boundAgents = h.db
      .query<{ agent_id: string }, [string]>("SELECT agent_id FROM agent_run WHERE tid = ? ORDER BY agent_id")
      .all(TID)
      .map((a) => a.agent_id);
    expect(boundAgents).toHaveLength(3);
    // `workflow_run.tid` was NULL on every row in the corpus before F3 — the column
    // had no writer at all, which is why `est block`'s phase-index guard could never
    // fire.
    expect(runTid("wf_demo0001-abc")).toBe(TID);

    const split = h.db
      .query<{ origin: string; n: number }, [string]>(
        "SELECT origin, COUNT(*) AS n FROM request WHERE tid = ? GROUP BY origin ORDER BY origin",
      )
      .all(TID);
    expect(split).toEqual([
      { origin: "main", n: 4 },
      { origin: "subagent", n: 5 },
    ]);

    const burn = h.db
      .query<
        { consumed_wcet: number; wcet_main: number; wcet_sub: number; n_agents_total: number },
        [string]
      >("SELECT consumed_wcet, wcet_main, wcet_sub, n_agents_total FROM burn_cache WHERE tid = ?")
      .get(TID)!;
    expect(burn.wcet_main).toBeGreaterThan(0);
    // The symptom the whole repair exists to fix: the burn bar read main-turn spend
    // only, because the sub-agents' launching turn had been refused.
    expect(burn.wcet_sub).toBeGreaterThan(0);
    expect(burn.consumed_wcet).toBe(burn.wcet_main + burn.wcet_sub);
    expect(burn.wcet_sub).toBeGreaterThan(burn.wcet_main);
    expect(burn.n_agents_total).toBe(3);

    // And the total is the whole session's, not a subset of it.
    const all = h.db
      .query<{ wcet: number }, []>("SELECT COALESCE(SUM(wcet), 0) AS wcet FROM v_wcet")
      .get()!.wcet;
    expect(Math.round(burn.consumed_wcet)).toBe(Math.round(all));
  });

  test("a second sweep re-attributes to the same answer and adds no anomaly rows", async () => {
    priceFixtureFamilies(h.db);
    seedTask(h.db, TID, { session: SESSION, prompt: "P1", createdAt: "2026-07-28T10:00:00Z" });

    await h.cli("sweep", "--root", CORPUS, "-q");
    const snapshot = () =>
      h.db
        .query<{ anomalies: number; bound_req: number; bound_agents: number; bound_runs: number }, [string]>(
          `SELECT (SELECT COUNT(*) FROM anomaly) AS anomalies,
                  (SELECT COUNT(*) FROM request WHERE tid = ?) AS bound_req,
                  (SELECT COUNT(*) FROM agent_run WHERE tid IS NOT NULL) AS bound_agents,
                  (SELECT COUNT(*) FROM workflow_run WHERE tid IS NOT NULL) AS bound_runs`,
        )
        .get(TID)!;
    const before = snapshot();
    await h.cli("sweep", "--root", CORPUS, "-q");
    expect(snapshot()).toEqual(before);
  });

  /**
   * The classifier's payoff at the sweep level: the fixture corpus's one journal
   * agent with no progress record and no transcript is benign, so a sweep of a
   * healthy corpus does not exit 3 on it.
   */
  test("the reclassified anomalies do not make a sweep exit 3", async () => {
    priceFixtureFamilies(h.db);
    const r = await h.cli("sweep", "--root", CORPUS, "--json");
    const report = r.json<{ anomalies: { by_kind: Record<string, number>; alerting: number } }>();
    expect(report.anomalies.by_kind.wf_record_mismatch ?? 0).toBe(0);
    expect(report.anomalies.by_kind.phase_unmapped ?? 0).toBe(0);
    expect(report.anomalies.by_kind.agent_never_returned).toBe(1);
  });
});

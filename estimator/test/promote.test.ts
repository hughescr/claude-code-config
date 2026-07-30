/**
 * src/promote.ts — P2.8 status promotion: `estimating -> in_progress` on the
 * task's first attributed request, with `started_at` pinned to the transcript's
 * own timestamp.
 *
 * Every test calls `attributeTasks` before `promoteStartedTasks` — the design's
 * own ordering requirement (promotion reads `request.tid`/`request.attr`, which
 * attribution just wrote) — and reads `task.status`/`task.started_at` directly
 * rather than through any read model, since P2.8 is the FIRST writer of
 * `task.started_at` and nothing else in the schema derives it.
 *
 * Fixtures are synthetic throughout (`test/support.ts`): no real id, path or
 * token figure may appear in a tracked file (§4).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, openArgs, request, seedPrices, turn, type Harness } from "./support.ts";
import { attributeTasks } from "../src/attribute.ts";
import { promoteStartedTasks } from "../src/promote.ts";

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-promote-");
  seedPrices(h.db);
});

afterEach(() => {
  h.close();
});

async function open(session: string, prompt: string, extra: string[] = []): Promise<string> {
  const r = await h.cli(...openArgs(), "--session", session, "--prompt", prompt, "--json", ...extra);
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

function taskRow(tid: string): { status: string; started_at: string | null } {
  return h.db
    .query<{ status: string; started_at: string | null }, [string]>(
      "SELECT status, started_at FROM task WHERE tid = ?",
    )
    .get(tid)!;
}

describe("promoteStartedTasks — the trigger", () => {
  test("estimating -> in_progress on the FIRST exclusive request, started_at from request.ts", async () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T00:00:00Z" });
    const tid = await open("s1", "p1");
    expect(taskRow(tid)).toMatchObject({ status: "estimating", started_at: null });

    request(h.db, "rq-1", { session: "s1", ts: "2026-02-01T00:05:00Z", out: 10 });
    attributeTasks(h.db);

    const result = promoteStartedTasks(h.db);
    expect(result.promoted).toBe(1);
    expect(result.started_at_set).toBe(1);
    expect(result.started_at_backdated).toBe(0);
    expect(result.anomalies).toEqual([]);
    expect(taskRow(tid)).toMatchObject({ status: "in_progress", started_at: "2026-02-01T00:05:00Z" });
  });

  test("a task with NO attributed request stays `estimating` with a NULL started_at", async () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T00:00:00Z" });
    const tid = await open("s1", "p1");

    const result = promoteStartedTasks(h.db);
    expect(result.promoted).toBe(0);
    expect(result.started_at_set).toBe(0);
    expect(taskRow(tid)).toMatchObject({ status: "estimating", started_at: null });
  });

  test("attr='overhead' never promotes — the ceremony must not start the clock it measures", async () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T00:00:00Z" });
    const tid = await open("s1", "p1");
    // The estimating skill's own request: attributeTasks (§5.4 rule 1) resolves a
    // tid for it but overrides attr to 'overhead' because attribution_skill is set.
    request(h.db, "rq-1", { session: "s1", ts: "2026-02-01T00:05:00Z", out: 10, skill: "estimating" });
    attributeTasks(h.db);
    expect(
      h.db.query<{ attr: string }, []>("SELECT attr FROM request WHERE request_id = 'rq-1'").get()?.attr,
    ).toBe("overhead");

    const result = promoteStartedTasks(h.db);
    expect(result.promoted).toBe(0);
    expect(taskRow(tid).status).toBe("estimating");
  });

  test("attr='pre_task' never promotes", async () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T00:10:00Z" });
    const tid = await open("s1", "p1");
    // No turn claims this request (prompt_id NULL, so it cannot join `turnTid`) in a
    // session that DOES carry a bound task: §5.4's residual class, `pre_task`.
    request(h.db, "rq-pre", { session: "s1", prompt: null, ts: "2026-02-01T00:00:00Z", out: 10 });
    attributeTasks(h.db);
    expect(
      h.db.query<{ attr: string }, []>("SELECT attr FROM request WHERE request_id = 'rq-pre'").get()?.attr,
    ).toBe("pre_task");

    const result = promoteStartedTasks(h.db);
    expect(result.promoted).toBe(0);
    expect(taskRow(tid).status).toBe("estimating");
  });

  test("idempotent: re-running over an unchanged corpus promotes nothing further", async () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T00:00:00Z" });
    const tid = await open("s1", "p1");
    request(h.db, "rq-1", { session: "s1", ts: "2026-02-01T00:05:00Z", out: 10 });
    attributeTasks(h.db);

    const first = promoteStartedTasks(h.db);
    expect(first.promoted).toBe(1);

    const second = promoteStartedTasks(h.db);
    expect(second.promoted).toBe(0);
    expect(second.started_at_set).toBe(0);
    expect(second.started_at_backdated).toBe(0);
    expect(second.anomalies).toEqual([]);
    expect(taskRow(tid)).toMatchObject({ status: "in_progress", started_at: "2026-02-01T00:05:00Z" });
  });

  test("promotion does not disturb a task already past `estimating`", async () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T00:00:00Z" });
    const tid = await open("s1", "p1");
    request(h.db, "rq-1", { session: "s1", ts: "2026-02-01T00:05:00Z", out: 10 });
    attributeTasks(h.db);
    promoteStartedTasks(h.db);
    expect(taskRow(tid).status).toBe("in_progress");

    // Move it on manually, the way `est close --force` would, and confirm a
    // second promotion pass leaves the FURTHER-ALONG status alone.
    h.db.query("UPDATE task SET status = 'pending_verification' WHERE tid = ?").run(tid);
    const result = promoteStartedTasks(h.db);
    expect(result.promoted).toBe(0);
    expect(taskRow(tid).status).toBe("pending_verification");
  });
});

describe("promoteStartedTasks — started_at is monotone-earliest", () => {
  test("a later sweep discovering an EARLIER attributed request moves started_at BACKWARD and raises promotion_backdated", async () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T00:00:00Z" });
    const tid = await open("s1", "p1");
    request(h.db, "rq-1", { session: "s1", ts: "2026-02-01T00:10:00Z", out: 10 });
    attributeTasks(h.db);
    const first = promoteStartedTasks(h.db);
    expect(first.started_at_set).toBe(1);
    expect(taskRow(tid).started_at).toBe("2026-02-01T00:10:00Z");

    // A fork/alias resolves later and an earlier request is discovered for the
    // SAME tid — simulate by inserting a request with an earlier ts and
    // re-attributing.
    request(h.db, "rq-0", { session: "s1", ts: "2026-02-01T00:02:00Z", out: 5 });
    attributeTasks(h.db);
    const second = promoteStartedTasks(h.db);
    expect(second.started_at_backdated).toBe(1);
    expect(second.started_at_set).toBe(0);
    expect(second.anomalies).toHaveLength(1);
    expect(second.anomalies[0]!.kind).toBe("promotion_backdated");
    expect(second.anomalies[0]!.detail).toContain(tid);
    expect(second.anomalies[0]!.detail).toContain("2026-02-01T00:10:00Z");
    expect(second.anomalies[0]!.detail).toContain("2026-02-01T00:02:00Z");
    expect(taskRow(tid).started_at).toBe("2026-02-01T00:02:00Z");
  });

  test("never moves started_at FORWARD", async () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T00:00:00Z" });
    const tid = await open("s1", "p1");
    request(h.db, "rq-early", { session: "s1", ts: "2026-02-01T00:01:00Z", out: 10 });
    attributeTasks(h.db);
    promoteStartedTasks(h.db);
    expect(taskRow(tid).started_at).toBe("2026-02-01T00:01:00Z");

    // A LATER request for the same task must never push started_at forward.
    request(h.db, "rq-later", { session: "s1", ts: "2026-02-01T00:20:00Z", out: 10 });
    attributeTasks(h.db);
    const result = promoteStartedTasks(h.db);
    expect(result.started_at_set).toBe(0);
    expect(result.started_at_backdated).toBe(0);
    expect(taskRow(tid).started_at).toBe("2026-02-01T00:01:00Z");
  });
});

/**
 * `sweep --json`'s `report.promotion` — the wiring inside `runSweep`, not just
 * the unit under test. Exercised through the real CLI so a future refactor of
 * the call site (ordering, field names) fails here rather than only in
 * `promote.test.ts`'s direct calls.
 */
describe("est sweep — P2.8 wiring", () => {
  test("report.promotion reflects a real sweep, and check-schema's append-only spine is untouched", async () => {
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-02-01T00:00:00Z" });
    const tid = await open("s1", "p1");
    request(h.db, "rq-1", { session: "s1", ts: "2026-02-01T00:05:00Z", out: 10 });

    const emptyRoot = join(h.dir, "projects");
    mkdirSync(emptyRoot, { recursive: true });
    const r = await h.cli("sweep", "--root", emptyRoot, "--json");
    const report = r.json<{ promotion: { promoted: number; started_at_set: number; started_at_backdated: number } }>();
    expect(report.promotion.promoted).toBe(1);
    expect(report.promotion.started_at_set).toBe(1);

    // …and then the SWEEPER CLOSE PASS finalizes it in the same sweep, which is correct
    // and worth pinning here rather than hiding behind a fresher fixture. The task's
    // only attributed request is months old and nothing signalled completion, so it is
    // exactly the population Craig's 2026-07-30 ruling calls abandoned: silence past
    // STALE_CLOSE_HOURS means the actual is a lower bound, not a measurement.
    //
    // The ORDER is the load-bearing part for this file: promotion runs first and
    // reports 1, so `est sweep`'s one status EDGE is still observed even when the close
    // pass ends the task in the same pass.
    expect(taskRow(tid).status).toBe("abandoned");
    expect(
      h.db
        .query<{ final_status: string; censored: number }, [string]>(
          "SELECT final_status, censored FROM v_outcome_current WHERE tid = ?",
        )
        .get(tid),
    ).toEqual({ final_status: "abandoned", censored: 1 });
  });
});

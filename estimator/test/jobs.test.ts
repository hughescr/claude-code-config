/**
 * src/jobs.ts — P2.9: the `~/.claude/jobs` reconcile, RECONCILE-ONLY.
 *
 * Every test builds a synthetic job directory under a fresh temp dir and passes
 * it EXPLICITLY as `jobsRoot` — never relying on `EST_JOBS`/`JOBS_ROOT` — so this
 * file never touches the real `~/.claude/jobs` on the machine running the suite
 * (see `test/preload.ts` for the belt-and-suspenders default that protects every
 * OTHER test too).
 *
 * No real job id, session id or transcript content appears here (§4): every
 * fixture below is invented, `job-a`/`s1`-shaped.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobsRetroPanel, reconcileJobs } from "../src/jobs.ts";
import { makeHarness, openArgs, type Harness } from "./support.ts";

let h: Harness;
let jobsRoot: string;

beforeEach(() => {
  h = makeHarness("est-jobs-");
  jobsRoot = mkdtempSync(join(tmpdir(), "est-jobs-fixture-"));
});

afterEach(() => {
  h.close();
  rmSync(jobsRoot, { recursive: true, force: true });
});

/** One `<jobsRoot>/<jobId>/state.json`, minimally shaped like the real file. */
function writeJob(
  jobId: string,
  state: Record<string, unknown>,
  timeline?: Array<{ at: string; state: string; detail?: string }>,
): void {
  const dir = join(jobsRoot, jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  if (timeline !== undefined) {
    writeFileSync(join(dir, "timeline.jsonl"), timeline.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
}

async function openTaskFor(session: string, prompt = "p1"): Promise<string> {
  h.db.query(
    "INSERT INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid) VALUES (?,?,?,?,NULL,NULL,NULL)",
  ).run(session, prompt, "2026-03-01T00:00:00Z", 1000);
  const r = await h.cli(...openArgs(), "--session", session, "--prompt", prompt, "--json");
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

describe("reconcileJobs — binding", () => {
  test("binds a job to the ONE task already aliased to its sessionId", async () => {
    const tid = await openTaskFor("s1");
    writeJob("job-a", { sessionId: "s1", name: "demo", state: "done", fan: [] });

    const result = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(result.dirs_read).toBe(1);
    expect(result.parsed).toBe(1);
    expect(result.bound).toBe(1);
    expect(result.unjoined).toBe(0);
    expect(result.anomalies).toEqual([]);

    const row = h.db
      .query<{ tid: string | null; session_id: string | null }, []>(
        "SELECT tid, session_id FROM job_run WHERE job_id = 'job-a'",
      )
      .get();
    expect(row).toMatchObject({ tid, session_id: "s1" });

    const alias = h.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM task_alias WHERE id_kind = 'job' AND local_id = ? AND tid = ?",
      )
      .get("job-a", tid);
    expect(alias?.n).toBe(1);
  });

  test("binds via resumeSessionId when sessionId itself has no alias", async () => {
    const tid = await openTaskFor("s-resume");
    writeJob("job-b", { sessionId: "s-unaliased", resumeSessionId: "s-resume", fan: [] });

    const result = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(result.bound).toBe(1);
    const row = h.db.query<{ tid: string | null }, []>("SELECT tid FROM job_run WHERE job_id = 'job-b'").get();
    expect(row?.tid).toBe(tid);
  });

  test("no match -> job_unjoined, no alias row, NO task minted", async () => {
    writeJob("job-c", { sessionId: "s-unknown", fan: [] });

    const result = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(result.bound).toBe(0);
    expect(result.unjoined).toBe(1);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ kind: "job_unjoined" });
    expect(result.anomalies[0]!.detail).toContain("job-c");

    const row = h.db.query<{ tid: string | null }, []>("SELECT tid FROM job_run WHERE job_id = 'job-c'").get();
    expect(row?.tid).toBeNull();
    const aliasCount = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_alias WHERE id_kind = 'job'").get();
    expect(aliasCount?.n).toBe(0);
    const taskCount = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task").get();
    expect(taskCount?.n).toBe(0);
  });

  test("more than one candidate tid -> job_unjoined (ambiguous), never invents a binding", async () => {
    const tidA = await openTaskFor("s-shared", "p1");
    const tidB = await openTaskFor("s-shared", "p2");
    expect(tidA).not.toBe(tidB);
    writeJob("job-d", { sessionId: "s-shared", fan: [] });

    const result = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(result.bound).toBe(0);
    expect(result.unjoined).toBe(1);
    expect(result.anomalies[0]!.detail).toContain("ambiguous");
    const row = h.db.query<{ tid: string | null }, []>("SELECT tid FROM job_run WHERE job_id = 'job-d'").get();
    expect(row?.tid).toBeNull();
  });

  test("a job with neither sessionId nor resumeSessionId -> job_unjoined", async () => {
    writeJob("job-e", { name: "no session at all", fan: [] });
    const result = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(result.unjoined).toBe(1);
    expect(result.anomalies[0]!.detail).toContain("no sessionId");
  });
});

describe("reconcileJobs — projection fields", () => {
  test("state.json fields land on job_run; tokens is stored, never summed anywhere", async () => {
    writeJob("job-f", {
      sessionId: "s-unbound",
      name: "widget pass",
      state: "blocked",
      backend: "daemon",
      template: "bg",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T01:00:00.000Z",
      firstTerminalAt: "2026-03-01T02:00:00.000Z",
      tokens: 123456,
      fan: [],
    });
    reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    const row = h.db
      .query<
        {
          name: string;
          state: string;
          backend: string;
          template: string;
          created_at: string;
          updated_at: string;
          first_terminal_at: string;
          reported_tokens: number;
        },
        []
      >(
        "SELECT name, state, backend, template, created_at, updated_at, first_terminal_at, reported_tokens FROM job_run WHERE job_id = 'job-f'",
      )
      .get();
    expect(row).toMatchObject({
      name: "widget pass",
      state: "blocked",
      backend: "daemon",
      template: "bg",
      created_at: "2026-03-01T00:00:00.000Z",
      updated_at: "2026-03-01T01:00:00.000Z",
      first_terminal_at: "2026-03-01T02:00:00.000Z",
      reported_tokens: 123456,
    });
  });

  test("fan[]: startedAt/doneAt of 0 -> NULL (unset, not the epoch); non-zero -> ISO", async () => {
    writeJob("job-g", {
      sessionId: "s-unbound2",
      fan: [
        { id: "todo:1", kind: "todo", label: "a", startedAt: 0, doneAt: 0 },
        { id: "todo:2", kind: "todo", label: "b", startedAt: 1_772_323_200_000, doneAt: 0 },
      ],
    });
    const result = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(result.n_items).toBe(2);
    expect(result.n_items_started).toBe(1);

    const items = h.db
      .query<{ item_id: string; started_at: string | null; done_at: string | null }, []>(
        "SELECT item_id, started_at, done_at FROM job_item WHERE job_id = 'job-g' ORDER BY item_id",
      )
      .all();
    expect(items[0]).toMatchObject({ item_id: "todo:1", started_at: null, done_at: null });
    expect(items[1]!.item_id).toBe("todo:2");
    expect(items[1]!.started_at).not.toBeNull();
    expect(items[1]!.done_at).toBeNull();
  });

  test("malformed state.json is counted, not thrown", async () => {
    mkdirSync(join(jobsRoot, "job-bad"), { recursive: true });
    writeFileSync(join(jobsRoot, "job-bad", "state.json"), "{ not json");
    const result = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(result.dirs_read).toBe(1);
    expect(result.malformed).toBe(1);
    expect(result.parsed).toBe(0);
  });

  test("a missing jobsRoot degrades to an empty result — the Phase 1 degrade shape", () => {
    const result = reconcileJobs(h.db, join(jobsRoot, "does-not-exist"), "2026-03-02T00:00:00Z");
    expect(result).toMatchObject({ dirs_read: 0, parsed: 0, bound: 0, unjoined: 0, anomalies: [] });
  });

  test("a non-directory sibling (e.g. pins.json) next to job dirs is ignored", async () => {
    writeFileSync(join(jobsRoot, "pins.json"), "{}");
    writeJob("job-h", { sessionId: "s-unbound3", fan: [] });
    const result = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(result.dirs_read).toBe(1);
    expect(result.parsed).toBe(1);
  });
});

describe("reconcileJobs — idempotence and the never-un-bind rule", () => {
  test("re-sweeping an unchanged job writes no new alias and no new anomaly", async () => {
    const tid = await openTaskFor("s-idem");
    writeJob("job-i", { sessionId: "s-idem", fan: [] });

    const first = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(first.bound).toBe(1);

    const second = reconcileJobs(h.db, jobsRoot, "2026-03-03T00:00:00Z");
    expect(second.bound).toBe(0);
    expect(second.already_bound).toBe(1);
    expect(second.anomalies).toEqual([]);

    const aliasCount = h.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM task_alias WHERE id_kind = 'job' AND local_id = ?")
      .get("job-i");
    expect(aliasCount?.n).toBe(1);
    const row = h.db.query<{ tid: string | null }, []>("SELECT tid FROM job_run WHERE job_id = 'job-i'").get();
    expect(row?.tid).toBe(tid);
  });

  test("a binding is never re-evaluated once made, even if the session later becomes ambiguous", async () => {
    const tid = await openTaskFor("s-lock-in");
    writeJob("job-j", { sessionId: "s-lock-in", fan: [] });
    reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");

    // A second task opens in the SAME session after the binding was made.
    await openTaskFor("s-lock-in", "p2");
    const second = reconcileJobs(h.db, jobsRoot, "2026-03-03T00:00:00Z");
    expect(second.already_bound).toBe(1);
    expect(second.unjoined).toBe(0);
    const row = h.db.query<{ tid: string | null }, []>("SELECT tid FROM job_run WHERE job_id = 'job-j'").get();
    expect(row?.tid).toBe(tid); // unchanged — still the FIRST task, never re-bound
  });

  test("a job unjoined on one sweep can bind on a LATER sweep once its session gets a task", async () => {
    writeJob("job-k", { sessionId: "s-late", fan: [] });
    const first = reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(first.unjoined).toBe(1);

    const tid = await openTaskFor("s-late");
    const second = reconcileJobs(h.db, jobsRoot, "2026-03-03T00:00:00Z");
    expect(second.bound).toBe(1);
    const row = h.db.query<{ tid: string | null }, []>("SELECT tid FROM job_run WHERE job_id = 'job-k'").get();
    expect(row?.tid).toBe(tid);
  });
});

describe("jobsRetroPanel — the comparison, reported never corrected", () => {
  test("returns nothing when no job is bound", () => {
    writeJob("job-l", { sessionId: "s-unbound4", fan: [] });
    reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");
    expect(jobsRetroPanel(h.db, jobsRoot)).toEqual([]);
  });

  test("computes jobs_span_s, our_active_s (from run_segment) and their delta for a bound job", async () => {
    const tid = await openTaskFor("s-panel");
    writeJob(
      "job-m",
      {
        sessionId: "s-panel",
        createdAt: "2026-03-01T00:00:00.000Z",
        firstTerminalAt: "2026-03-01T01:00:00.000Z", // 3600s jobs-reported span
        fan: [],
      },
      [
        { at: "2026-03-01T00:00:05.000Z", state: "working", detail: "start" },
        { at: "2026-03-01T00:50:00.000Z", state: "blocked", detail: "waiting" },
        { at: "2026-03-01T01:00:00.000Z", state: "done", detail: "finished" },
      ],
    );
    reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");

    h.db
      .query(
        `INSERT INTO run_segment (session_id, started_at, ended_at, active_s, busy_s, max_concurrency,
                                  n_turns, n_agents, terminator, gap_min, tid, first_seen, last_seen)
         VALUES ('s-panel', '2026-03-01T00:00:05Z', '2026-03-01T00:55:00Z', 3000, 3000, 1,
                 1, 0, 'session_end', 20, $tid, '2026-03-01T00:00:05Z', '2026-03-01T00:55:00Z')`,
      )
      .run({ $tid: tid } as never);

    const panel = jobsRetroPanel(h.db, jobsRoot);
    expect(panel).toHaveLength(1);
    const row = panel[0]!;
    expect(row.job_id).toBe("job-m");
    expect(row.tid).toBe(tid);
    expect(row.jobs_span_s).toBe(3600);
    expect(row.our_active_s).toBe(3000);
    expect(row.delta_span_s).toBe(600);
    expect(row.timeline_n_lines).toBe(3);
    expect(row.timeline_first_working_at).toBe("2026-03-01T00:00:05.000Z");
    expect(row.timeline_last_state).toBe("done");
    expect(row.timeline_last_at).toBe("2026-03-01T01:00:00.000Z");
  });

  test("a bound job with no timeline.jsonl on disk still reports the job_run/run_segment comparison", async () => {
    const tid = await openTaskFor("s-no-timeline");
    writeJob("job-n", { sessionId: "s-no-timeline", createdAt: "2026-03-01T00:00:00Z", fan: [] });
    reconcileJobs(h.db, jobsRoot, "2026-03-02T00:00:00Z");

    const panel = jobsRetroPanel(h.db, jobsRoot);
    expect(panel).toHaveLength(1);
    expect(panel[0]).toMatchObject({
      tid,
      timeline_n_lines: 0,
      timeline_first_working_at: null,
      jobs_first_terminal_at: null,
      jobs_span_s: null, // no firstTerminalAt: still open, span is unknowable
    });
  });
});

/**
 * `est sweep --json`'s `report.jobs` — the wiring inside `runSweep`, exercised
 * through the real CLI (passing `jobsRoot` is only possible via `runSweep`'s
 * options today, which the CLI does not yet expose as a flag — so this drives
 * `runSweep` directly rather than `h.cli(...)`, and stays honest about that).
 */
describe("runSweep — P2.9 wiring", () => {
  test("report.jobs reflects a real sweep's reconcile pass", async () => {
    const tid = await openTaskFor("s-wired");
    writeJob("job-o", { sessionId: "s-wired", fan: [{ id: "todo:1", startedAt: 0, doneAt: 0 }] });

    const { runSweep } = await import("../src/cli.ts");
    const emptyRoot = mkdtempSync(join(tmpdir(), "est-jobs-corpus-"));
    try {
      const report = await runSweep(h.db, { root: emptyRoot, jobsRoot });
      expect(report.jobs).toMatchObject({
        dirs_read: 1,
        parsed: 1,
        bound: 1,
        unjoined: 0,
        n_items: 1,
        n_items_started: 0,
      });
      const row = h.db.query<{ tid: string | null }, []>("SELECT tid FROM job_run WHERE job_id = 'job-o'").get();
      expect(row?.tid).toBe(tid);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

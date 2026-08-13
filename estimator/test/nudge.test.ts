/**
 * scripts/nudge.ts — PostToolUse hook body, matcher `Task|Workflow`
 * (design R4 §Phase 1 interfaces, P1.10).
 *
 * Runs the script as a REAL subprocess with synthesized stdin, exactly as
 * Claude Code's hook runner invokes it, and asserts exit code + side effects
 * (stdout payload, spool/compliance.jsonl line, throttle marker). This is
 * deliberately not an in-process `run()` test (cf. cli.test.ts) — the hook's
 * entire contract IS "a process fed JSON on stdin", so that is what is
 * exercised here.
 *
 * `EST_DISABLE_MICROSWEEP=1` is set in every case: job 3 spawns a real,
 * corpus-wide `est sweep`, which is unsuitable to actually exec from a unit
 * test. The throttle-marker mechanics get their own narrow test with it
 * unset.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { writeFocusMarker } from "../src/spool.ts";

const NUDGE_SCRIPT = join(import.meta.dir, "..", "scripts", "nudge.ts");

let dir: string;
let dbPath: string;
let spoolDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "est-nudge-"));
  dbPath = join(dir, "estimator.db");
  spoolDir = join(dir, "spool");
  mkdirSync(spoolDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runNudge(stdin: string, env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", NUDGE_SCRIPT], {
    stdin: Buffer.from(stdin, "utf8"),
    env: {
      ...process.env,
      EST_DB: dbPath,
      EST_SPOOL_DIR: spoolDir,
      EST_DISABLE_MICROSWEEP: "1",
      ...env,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  };
}

function complianceLines(): Array<Record<string, unknown>> {
  const path = join(spoolDir, "compliance.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Create an empty, initialised database. Several cases need "the hook CAN read the
 * database and found nothing bound", which is a different fact from "there is no
 * database" — the hook nudges on the first and stays silent on the second.
 */
function initDb(): void {
  openDb({ path: dbPath }).close();
}

function agentBindsLines(): Array<Record<string, unknown>> {
  const path = join(spoolDir, "agent-binds.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function setConfigValue(key: string, value: string): void {
  const db = openDb({ path: dbPath });
  try {
    db.run("UPDATE config SET v = ? WHERE k = ?", [value, key]);
  } finally {
    db.close();
  }
}

/** A minimal open task, aliased to `sessionId` (source='est_bind') — no estimate. */
function seedBoundTask(tid: string, sessionId: string): void {
  const db = openDb({ path: dbPath });
  const now = new Date().toISOString();
  try {
    db.run(
      "INSERT INTO task (tid,kind,status,created_at,anchor_session,anchor_prompt) VALUES (?,?,?,?,?,?)",
      [tid, "implement", "in_progress", now, sessionId, "p1"],
    );
    db.run(
      `INSERT INTO task_scope (tid,seq,ts,subject,description,dod_json,scope_hash,source)
       VALUES (?,1,?,?,?,?,?,?)`,
      [tid, now, "test task", null, "[]", "deadbeef", "est_open"],
    );
    db.run(
      "INSERT INTO task_alias (tid,id_kind,session_id,local_id,first_seen,source) VALUES (?,?,?,?,?,?)",
      [tid, "session", sessionId, sessionId, now, "est_bind"],
    );
  } finally {
    db.close();
  }
}

function seedTask(opts: {
  tid: string;
  sessionId: string;
  status?: string;
  calP90?: number;
  /** v15. `story_point` with `cal === raw` is the UNSCORABLE cold start — the band is
   *  in points and no rate converted it at `est open`. Defaults to the Work-CET band
   *  every test above this one assumes. */
  estimand?: string;
  rawP50?: number;
  calP50?: number;
}): void {
  const db = openDb({ path: dbPath });
  const now = new Date().toISOString();
  try {
    db.run(
      `INSERT INTO task (tid,kind,status,created_at,anchor_session,anchor_prompt) VALUES (?,?,?,?,?,?)`,
      [opts.tid, "implement", opts.status ?? "in_progress", now, opts.sessionId, "prompt-1"],
    );
    db.run(
      `INSERT INTO task_scope (tid,seq,ts,subject,description,dod_json,scope_hash,source) VALUES (?,1,?,?,?,?,?,?)`,
      [opts.tid, now, "test task", null, "[]", "deadbeef", "est_open"],
    );
    db.run(
      `INSERT INTO task_alias (tid,id_kind,session_id,local_id,first_seen,source) VALUES (?,?,?,?,?,?)`,
      [opts.tid, "session", opts.sessionId, opts.sessionId, now, "est_bind"],
    );
    if (opts.calP90 !== undefined) {
      db.run(
        `INSERT INTO estimate (tid,version,created_at,reason,scope_seq,raw_p50_wcet,raw_p90_wcet,
           exp_agents,exp_wf_phases,exp_files_write,exp_turns,exp_requests,bucket,bucket_n,shrink_w,
           cal_p50_wcet,cal_p90_wcet,price_epoch,ref_model,estimand,estimator_model)
         VALUES (?,1,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          opts.tid,
          now,
          "initial",
          opts.rawP50 ?? 1000,
          opts.calP90,
          1,
          0,
          1,
          2,
          5,
          "global",
          0,
          0,
          opts.calP50 ?? 1000,
          opts.calP90,
          now,
          "claude-sonnet-4-5",
          opts.estimand ?? "work_cet",
          "claude-sonnet-4-5",
        ],
      );
    }
  } finally {
    db.close();
  }
}

/** A later `est open --reason refinement`: a NEW estimate version, so a NEW band. */
function refineEstimate(tid: string, version: number, calP90: number): void {
  const db = openDb({ path: dbPath });
  const now = new Date().toISOString();
  try {
    db.run(
      `INSERT INTO estimate (tid,version,created_at,reason,scope_seq,raw_p50_wcet,raw_p90_wcet,
         exp_agents,exp_wf_phases,exp_files_write,exp_turns,exp_requests,bucket,bucket_n,shrink_w,
         cal_p50_wcet,cal_p90_wcet,price_epoch,ref_model,estimand,estimator_model)
       VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tid,
        version,
        now,
        "refinement",
        1000,
        calP90,
        1,
        0,
        1,
        2,
        5,
        "global",
        0,
        0,
        1000,
        calP90,
        now,
        "claude-sonnet-4-5",
        "work_cet",
        "claude-sonnet-4-5",
      ],
    );
  } finally {
    db.close();
  }
}

function setConsumed(tid: string, consumedWcet: number): void {
  const db = openDb({ path: dbPath });
  try {
    db.run("UPDATE burn_cache SET consumed_wcet = ?, proj_total_wcet = ? WHERE tid = ?", [
      consumedWcet,
      consumedWcet,
      tid,
    ]);
  } finally {
    db.close();
  }
}

function seedBurnCache(tid: string, consumedWcet: number): void {
  const db = openDb({ path: dbPath });
  const now = new Date().toISOString();
  try {
    db.run(
      `INSERT INTO burn_cache (tid,as_of,consumed_wcet,wcet_main,wcet_sub,wcet_aux,usd,n_req,
         n_agents_live,active_s,burn_wcet_per_min,proj_total_wcet)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tid, now, consumedWcet, consumedWcet, 0, 0, 1.0, 10, 1, 60, 1.0, consumedWcet],
    );
  } finally {
    db.close();
  }
}

describe("nudge.ts — P1.10 fail-open contract", () => {
  test("exits 0 with no output on unparseable stdin", () => {
    const r = runNudge("not json at all");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("exits 0 with no output on empty stdin", () => {
    const r = runNudge("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("exits 0 with no output when session_id is missing", () => {
    const r = runNudge(JSON.stringify({ tool_name: "Task", tool_input: {} }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(complianceLines()).toHaveLength(0); // nothing to log without a session id
  });

  test("exits 0 and stays SILENT when the database file does not exist", () => {
    // P1.10 fail-open: a missing database is "print nothing", not "nudge". Nudging
    // there nags Craig about an unbound estimate on evidence nothing could gather.
    const r = runNudge(
      JSON.stringify({ session_id: "s1", tool_name: "Workflow", tool_input: {} }),
      { EST_DB: join(dir, "does-not-exist.db") },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("an unreadable database is recorded as db_unavailable, never as a compliance miss", () => {
    const r = runNudge(
      JSON.stringify({ session_id: "s1", tool_name: "Workflow", tool_input: {} }),
      { EST_DB: join(dir, "does-not-exist.db") },
    );
    expect(r.exitCode).toBe(0);
    const lines = complianceLines();
    expect(lines).toHaveLength(1);
    // src/spool.ts drops these before the missed_estimate anomaly and the counters.
    expect(lines[0]).toMatchObject({
      bound_tid: null,
      nudged: false,
      nudge_kind: "none",
      db_unavailable: true,
    });
  });
});

describe("nudge.ts — P1.10 job 1: decide", () => {
  test("nudges (naming the estimating skill) when no task is bound to the session", () => {
    initDb();
    const r = runNudge(
      JSON.stringify({ session_id: "unbound-session", tool_name: "Task", tool_input: {} }),
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain("estimating");
    expect(payload.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(500);
    expect(payload.systemMessage).toBeTruthy();
  });

  test("stays silent (empty stdout) when the session has an open, non-terminal task", () => {
    seedTask({ tid: "t-bound", sessionId: "bound-session" });
    const r = runNudge(
      JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("nudges when the session's only task is terminal (completed)", () => {
    seedTask({ tid: "t-done", sessionId: "done-session", status: "completed" });
    const r = runNudge(
      JSON.stringify({ session_id: "done-session", tool_name: "Task", tool_input: {} }),
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain("estimating");
  });
});

describe("nudge.ts — P1.10 job 2: compliance recording", () => {
  test("appends exactly one line per invocation with the expected shape", () => {
    seedTask({ tid: "t-bound", sessionId: "bound-session" });
    runNudge(
      JSON.stringify({
        session_id: "bound-session",
        tool_name: "Task",
        tool_input: { a: 1 },
      }),
    );
    const lines = complianceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      session_id: "bound-session",
      tool_name: "Task",
      bound_tid: "t-bound",
      nudged: false,
    });
    expect(typeof lines[0]!.ts).toBe("string");
    expect(typeof lines[0]!.tool_input_sha256).toBe("string");
    expect((lines[0]!.tool_input_sha256 as string)).toHaveLength(64); // sha256 hex
  });

  test("records nudged:true and bound_tid:null when unbound", () => {
    initDb();
    runNudge(
      JSON.stringify({ session_id: "unbound-session", tool_name: "Workflow", tool_input: {} }),
    );
    const lines = complianceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ bound_tid: null, nudged: true, nudge_kind: "no_estimate" });
    expect(lines[0]!.db_unavailable).toBeUndefined();
  });

  test("appends, never overwrites, across repeated invocations", () => {
    initDb();
    runNudge(JSON.stringify({ session_id: "s1", tool_name: "Task", tool_input: {} }));
    runNudge(JSON.stringify({ session_id: "s1", tool_name: "Task", tool_input: {} }));
    runNudge(JSON.stringify({ session_id: "s1", tool_name: "Task", tool_input: {} }));
    expect(complianceLines()).toHaveLength(3);
  });
});

describe("nudge.ts — P1.10 job 4: overrun nudge (burn_cache, schema v5)", () => {
  test("no-ops gracefully when burn_cache does not exist (pre-migration / schema v4 shape)", () => {
    seedTask({ tid: "t-bound", sessionId: "bound-session", calP90: 3000 });
    const db = openDb({ path: dbPath });
    db.run("DROP TABLE burn_cache");
    db.close();

    const r = runNudge(
      JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(""); // bound, and the overrun check fails closed to "nothing to report"
  });

  test("stays silent when consumed is under cal_p90", () => {
    seedTask({ tid: "t-bound", sessionId: "bound-session", calP90: 3000 });
    seedBurnCache("t-bound", 1000);
    const r = runNudge(
      JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("nudges once when consumed crosses cal_p90, then stays silent on repeat", () => {
    seedTask({ tid: "t-bound", sessionId: "bound-session", calP90: 3000 });
    seedBurnCache("t-bound", 3500);

    const first = runNudge(
      JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }),
    );
    expect(first.exitCode).toBe(0);
    const payload = JSON.parse(first.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain("t-bound");
    expect(payload.hookSpecificOutput.additionalContext).toContain("refinement");
    expect(payload.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(300);

    const second = runNudge(
      JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }),
    );
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(""); // once per threshold crossing per task
  });

  test("re-arms when a refinement mints a NEW band, then goes quiet inside that one", () => {
    // "Once per threshold crossing", not "once per task ever": a task that
    // re-estimates and then blows the wider band has crossed a second threshold.
    const fire = (): RunResult =>
      runNudge(JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }));

    seedTask({ tid: "t-bound", sessionId: "bound-session", calP90: 3000 });
    seedBurnCache("t-bound", 3500);
    expect(JSON.parse(fire().stdout).systemMessage).toContain("3000");
    expect(fire().stdout).toBe(""); // same band

    refineEstimate("t-bound", 2, 20000);
    setConsumed("t-bound", 25000);
    const third = fire();
    expect(third.exitCode).toBe(0);
    expect(JSON.parse(third.stdout).systemMessage).toContain("20000");

    expect(fire().stdout).toBe(""); // and quiet again inside the new band
  });

  test("a refinement that widens the band past the burn nudges nothing at all", () => {
    seedTask({ tid: "t-bound", sessionId: "bound-session", calP90: 3000 });
    seedBurnCache("t-bound", 3500);
    const fire = (): RunResult =>
      runNudge(JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }));
    expect(fire().stdout).not.toBe("");

    refineEstimate("t-bound", 2, 50000); // now comfortably inside the band
    expect(fire().stdout).toBe("");
  });

  test("an emitted overrun nudge is visible in the compliance spool", () => {
    // `nudged` used to be "was there no binding", which made every overrun nudge
    // invisible to the spool — the one thing the spool adds over v_missed_estimate.
    seedTask({ tid: "t-bound", sessionId: "bound-session", calP90: 3000 });
    seedBurnCache("t-bound", 3500);
    runNudge(JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }));

    const lines = complianceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      bound_tid: "t-bound",
      nudged: true,
      nudge_kind: "overrun",
    });
    expect(existsSync(join(spoolDir, ".overrun-notified.t-bound"))).toBe(true);
  });

  // v15, and the reason this hook now consults the shared unit guard. `burn_cache
  // .consumed_wcet` is Work-CET; a story-point band with no rate at `est open` leaves
  // `cal_p90_wcet` holding POINTS. Comparing them fired a live, user-facing warning
  // that "consumed 14 vs p90 13 Work-CET" for a THIRTEEN-POINT band — a false alarm on
  // a wired PostToolUse hook, which is a wrong number that looks right on the surface
  // Craig cannot opt out of reading.
  test("never fires an overrun on an unscorable points band, however far consumed runs past it", () => {
    seedTask({
      tid: "t-points",
      sessionId: "bound-session",
      estimand: "story_point",
      rawP50: 8,
      calP50: 8, // cal === raw: nothing converted it, so these are POINTS
      calP90: 13,
    });
    seedBurnCache("t-points", 14); // Codex's repro exactly: 14 Work-CET against 13 points

    const r = runNudge(
      JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    // Not merely quiet: nothing was recorded as a fired threshold either, so the day a
    // rate exists the first real crossing still nudges.
    expect(existsSync(join(spoolDir, ".overrun-notified.t-points"))).toBe(false);
  });

  test("and not at 100x either — the refusal is about the unit, not about the margin", () => {
    seedTask({
      tid: "t-points",
      sessionId: "bound-session",
      estimand: "story_point",
      rawP50: 8,
      calP50: 8,
      calP90: 13,
    });
    seedBurnCache("t-points", 1_300_000);
    expect(runNudge(
      JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }),
    ).stdout).toBe("");
  });

  test("a points band that WAS converted at `est open` is scorable and still nudges", () => {
    // The guard must not swallow every points task: `cal !== raw` means a rate was
    // applied at issue time, so `cal_p90_wcet` really is Work-CET and the comparison is
    // defined. Refusing here would be the opposite failure — a real overrun going unsaid.
    seedTask({
      tid: "t-converted",
      sessionId: "bound-session",
      estimand: "story_point",
      rawP50: 8,
      calP50: 24_000, // 3000 Work-CET/point applied at open
      calP90: 39_000,
    });
    seedBurnCache("t-converted", 45_000);

    const r = runNudge(
      JSON.stringify({ session_id: "bound-session", tool_name: "Task", tool_input: {} }),
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("t-converted");
  });
});

describe("nudge.ts — P1.10 job 3: EST_DISABLE_MICROSWEEP escape hatch", () => {
  // job 3's real path spawns a corpus-wide `est sweep` and takes the production
  // sweep lock (§2, P1.10) — deliberately NOT exercised end-to-end here; that
  // was verified by hand against the real corpus during this change (see
  // conversation notes), and every test above depends on the disable flag
  // actually suppressing it. This confirms the flag itself does that.
  test("no throttle marker is created when the microsweep is disabled", () => {
    runNudge(JSON.stringify({ session_id: "no-marker-session", tool_name: "Task", tool_input: {} }));
    expect(existsSync(join(spoolDir, ".microsweep"))).toBe(false);
    expect(existsSync(join(spoolDir, ".microsweep.no-marker-session"))).toBe(false);
  });

  test("the throttle is GLOBAL: a fresh marker suppresses every session's sweep", () => {
    // The marker is checked (and honoured) before anything is spawned, so a
    // pre-touched one lets this exercise the real job-3 path without exec'ing a
    // corpus-wide sweep. The property under test is that a SECOND session sees the
    // same marker: a per-session marker gave each concurrent session its own window,
    // which is the N-sweep fan-out the throttle exists to collapse.
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, ".microsweep"), String(Date.now()));
    const before = readFileSync(join(spoolDir, ".microsweep"), "utf8");

    for (const sid of ["session-a", "session-b", "session-c"]) {
      const r = runNudge(JSON.stringify({ session_id: sid, tool_name: "Task", tool_input: {} }), {
        EST_DISABLE_MICROSWEEP: "",
        EST_MICROSWEEP_MIN_INTERVAL_S: "3600",
      });
      expect(r.exitCode).toBe(0);
    }

    // Throttled: the marker was not re-touched, and no per-session marker exists.
    expect(readFileSync(join(spoolDir, ".microsweep"), "utf8")).toBe(before);
    expect(readdirSync(spoolDir).filter((f) => f.startsWith(".microsweep"))).toEqual([
      ".microsweep",
    ]);
  });
});

// ---------------------------------------------------------------------------
// HOOK-BINDING-SPEC.md — job 0: spawn-time attribution binding
// ---------------------------------------------------------------------------

describe("nudge.ts — job 0: spawn-time attribution binding", () => {
  /** VERIFIED shapes (spec §2.2): async Agent, sync Agent, Workflow. */
  const asyncAgentResponse = (agentId: string): Record<string, unknown> => ({
    isAsync: true,
    status: "async_launched",
    agentId,
    description: "do a thing",
    resolvedModel: "claude-test-1",
    prompt: "...",
  });
  const syncAgentResponse = (agentId: string, totalDurationMs: number): Record<string, unknown> => ({
    status: "completed",
    agentId,
    agentType: "general-purpose",
    resolvedModel: "claude-test-1",
    totalDurationMs,
    totalTokens: 100,
  });
  const workflowResponse = (runId: string, taskId: string): Record<string, unknown> => ({
    status: "async_launched",
    taskId,
    taskType: "workflow",
    workflowName: "demo",
    runId,
    transcriptDir: "/tmp/x",
    scriptPath: "/tmp/x.sh",
  });

  test("rung 5 (sole_active): the only bound task in the session wins, source will be 'hook'", () => {
    initDb();
    seedBoundTask("t-sole", "sess-sole");
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-sole",
        tool_name: "Agent",
        tool_use_id: "toolu_1",
        tool_input: { description: "spawn one" },
        tool_response: asyncAgentResponse("agent-sole"),
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(""); // job 0 is silent — never a hookSpecificOutput contributor
    const lines = agentBindsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tid: "t-sole", basis: "sole_active", kind: "agent", local_id: "agent-sole" });
  });

  test("rung 6 (multi_active): two active tasks in the session -> witness, no tid", () => {
    initDb();
    seedBoundTask("t-a", "sess-multi");
    seedBoundTask("t-b", "sess-multi");
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-multi",
        tool_name: "Agent",
        tool_use_id: "toolu_2",
        tool_input: {},
        tool_response: asyncAgentResponse("agent-multi"),
      }),
    );
    expect(r.exitCode).toBe(0);
    const lines = agentBindsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tid: null, basis: "multi_active" });
  });

  test("rung 8 (no_bound): nothing aliased to this session at all -> witness, no anomaly path", () => {
    initDb();
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-nobound",
        tool_name: "Agent",
        tool_use_id: "toolu_3",
        tool_input: {},
        tool_response: asyncAgentResponse("agent-nobound"),
      }),
    );
    expect(r.exitCode).toBe(0);
    const lines = agentBindsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tid: null, basis: "no_bound" });
  });

  test("rung 9 (db_unavailable): no database on disk at all -> witness, exit 0, no stdout", () => {
    // Deliberately no initDb() call.
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-nodb",
        tool_name: "Agent",
        tool_use_id: "toolu_4",
        tool_input: {},
        tool_response: asyncAgentResponse("agent-nodb"),
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    const lines = agentBindsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tid: null, basis: "db_unavailable" });
  });

  test("rung 9 (no_identity): tool_response absent entirely -> witness, no database ever opened", () => {
    // No initDb() either — if this rung opened the database it would ALSO report
    // db_unavailable, not no_identity, so a no_identity result is itself evidence the
    // identity check ran (and short-circuited) before any DB access was attempted.
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-noident",
        tool_name: "Agent",
        tool_use_id: "toolu_5",
        tool_input: {},
      }),
    );
    expect(r.exitCode).toBe(0);
    const lines = agentBindsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tid: null, basis: "no_identity" });
  });

  test("rung 0 (nested): payload.agent_id present -> witness with parent_agent, no database required", () => {
    // No initDb(): the design's own claim is that a nested spawn's hook fire performs
    // ZERO database queries, so it must resolve identically whether or not one exists.
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-nested",
        agent_id: "parent-agent-1",
        agent_type: "general-purpose",
        tool_name: "Agent",
        tool_use_id: "toolu_6",
        tool_input: {},
        tool_response: asyncAgentResponse("child-agent-1"),
      }),
    );
    expect(r.exitCode).toBe(0);
    const lines = agentBindsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tid: null,
      basis: "nested",
      parent_agent: "parent-agent-1",
      kind: "agent",
      local_id: "child-agent-1",
      agent_type: "general-purpose",
    });
  });

  test("a Workflow launch resolves kind='workflow_run', local_id=runId, wf_launch_id carried for audit", () => {
    initDb();
    seedBoundTask("t-wf", "sess-wf");
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-wf",
        tool_name: "Workflow",
        tool_use_id: "toolu_7",
        tool_input: { script: "..." },
        tool_response: workflowResponse("run-1", "launch-1"),
      }),
    );
    expect(r.exitCode).toBe(0);
    const lines = agentBindsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tid: "t-wf",
      basis: "sole_active",
      kind: "workflow_run",
      local_id: "run-1",
      wf_launch_id: "launch-1",
    });
  });

  test("t_spawn correction: a SYNCHRONOUS Agent call still binds a task that has since retired", () => {
    // PostToolUse fires at COMPLETION for a sync call. Backdating the clock by
    // totalDurationMs is what lets a task that was active AT THE SPAWN still bind,
    // even though the session has gone quiet by the time this hook fires.
    initDb();
    seedBoundTask("t-sync", "sess-sync");
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-sync",
        tool_name: "Agent",
        tool_use_id: "toolu_8",
        tool_input: {},
        tool_response: syncAgentResponse("agent-sync", twoHoursMs),
      }),
    );
    expect(r.exitCode).toBe(0);
    const lines = agentBindsLines();
    expect(lines).toHaveLength(1);
    // Whether this lands on sole_active or a later rung, it must not be db_unavailable
    // / no_identity — the point under test is that IDENTITY resolution ran at all.
    expect(lines[0]!.basis).not.toBe("db_unavailable");
    expect(lines[0]!.basis).not.toBe("no_identity");
  });

  test("hook_bind_enabled=0: the ROOT ladder writes nothing, not even a witness", () => {
    initDb();
    seedBoundTask("t-off", "sess-off");
    setConfigValue("hook_bind_enabled", "0");
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-off",
        tool_name: "Agent",
        tool_use_id: "toolu_9",
        tool_input: {},
        tool_response: asyncAgentResponse("agent-off"),
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(agentBindsLines()).toHaveLength(0);
  });

  test("hook_bind_enabled=0: the NESTED path still appends a witness (§7.1 exemption — no DB read on this path at all, so the switch cannot gate it hook-side; enforced at drain time instead)", () => {
    // No initDb(): same claim as the rung-0 test above — a nested spawn's hook fire
    // performs ZERO database queries, so `hook_bind_enabled` (a DB config row) cannot
    // be consulted here even in principle. This is deliberate, not a gap: the master
    // switch is enforced by `drainAgentBinds` discarding the whole batch unread.
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-nested-off",
        agent_id: "parent-agent-off",
        tool_name: "Agent",
        tool_use_id: "toolu_9b",
        tool_input: {},
        tool_response: asyncAgentResponse("child-agent-off"),
      }),
    );
    expect(r.exitCode).toBe(0);
    const lines = agentBindsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tid: null, basis: "nested", parent_agent: "parent-agent-off" });
  });

  test("a non-spawn tool name (e.g. Task/TaskUpdate) never reaches job 0 at all", () => {
    initDb();
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-notaspawn",
        tool_name: "TaskUpdate",
        tool_use_id: "toolu_10",
        tool_input: {},
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(agentBindsLines()).toHaveLength(0);
  });

  test("a payload with no tool_use_id writes nothing — no safe dedup key to group on", () => {
    initDb();
    seedBoundTask("t-notuid", "sess-notuid");
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-notuid",
        tool_name: "Agent",
        tool_input: {},
        tool_response: asyncAgentResponse("agent-notuid"),
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(agentBindsLines()).toHaveLength(0);
  });

  test("job 0 never contributes to stdout — job 1's nudge payload (if any) is unaffected", () => {
    initDb();
    // Unbound session: job 1 should still nudge, and job 0 should still spool a
    // witness line — the two jobs are independent and neither suppresses the other.
    const r = runNudge(
      JSON.stringify({
        session_id: "sess-both",
        tool_name: "Agent",
        tool_use_id: "toolu_11",
        tool_input: {},
        tool_response: asyncAgentResponse("agent-both"),
      }),
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(payload.hookSpecificOutput.additionalContext).toContain("est:");
    expect(agentBindsLines()).toHaveLength(1);
    expect(complianceLines()).toHaveLength(1);
  });

  describe("the [est:<tid8>] description marker (hook_bind_marker=1)", () => {
    // The marker regex is `[0-9a-f]{8,36}` — hex only, no hyphens — matching a
    // uuidv7 tid's own alphabet, so the fixture tids below are pure hex.
    test("resolves to exactly one candidate -> rung 1 bind, basis='marker'", () => {
      initDb();
      seedBoundTask("0123abcd", "sess-marker");
      seedBoundTask("9876fedc", "sess-marker");
      setConfigValue("hook_bind_marker", "1");
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-marker",
          tool_name: "Agent",
          tool_use_id: "toolu_12",
          tool_input: { description: "do the thing [est:0123abcd] please" },
          tool_response: asyncAgentResponse("agent-marker"),
        }),
      );
      expect(r.exitCode).toBe(0);
      const lines = agentBindsLines();
      expect(lines[0]).toMatchObject({ tid: "0123abcd", basis: "marker" });
    });

    test("default OFF: the same description does NOT bind via the marker", () => {
      initDb();
      seedBoundTask("0123abcd", "sess-marker-off");
      seedBoundTask("9876fedc", "sess-marker-off");
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-marker-off",
          tool_name: "Agent",
          tool_use_id: "toolu_13",
          tool_input: { description: "do the thing [est:0123abcd] please" },
          tool_response: asyncAgentResponse("agent-marker-off"),
        }),
      );
      expect(r.exitCode).toBe(0);
      const lines = agentBindsLines();
      // Falls through to the session-wide ladder instead — two active candidates.
      expect(lines[0]).toMatchObject({ tid: null, basis: "multi_active" });
    });
  });

  describe("the est focus pointer (§3.2a) — rungs 2-4", () => {
    test("rung 2: focus names an ACTIVE task -> bind, basis='focus'", () => {
      initDb();
      seedBoundTask("t-f1", "sess-focus2");
      seedBoundTask("t-f2", "sess-focus2");
      writeFocusMarker("sess-focus2", "t-f1", "est_focus", spoolDir);
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-focus2",
          tool_name: "Agent",
          tool_use_id: "toolu_14",
          tool_input: {},
          tool_response: asyncAgentResponse("agent-f1"),
        }),
      );
      expect(r.exitCode).toBe(0);
      expect(agentBindsLines()[0]).toMatchObject({ tid: "t-f1", basis: "focus" });
    });

    test("a focus marker OLDER than hook_focus_ttl_min, on an already-quiet task, is ignored", () => {
      // §3.2a/§8.1's fixed-from-set TTL: age is measured from the marker's OWN
      // timestamp, never renewed by the named task's own activity. This test backdates
      // the task's touch too so it is unambiguous that the TASK's quietness, not just
      // the marker's age, puts it past the ladder's focus rungs.
      initDb();
      seedBoundTask("t-fstale", "sess-focus-stale");
      const staleTs = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h old, > default 120 min
      const db = openDb({ path: dbPath });
      try {
        db.run("UPDATE task SET created_at = ? WHERE tid = ?", [staleTs.toISOString(), "t-fstale"]);
      } finally {
        db.close();
      }
      writeFocusMarker("sess-focus-stale", "t-fstale", "est_focus", spoolDir, staleTs);
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-focus-stale",
          tool_name: "Agent",
          tool_use_id: "toolu_15",
          tool_input: {},
          tool_response: asyncAgentResponse("agent-fstale"),
        }),
      );
      expect(r.exitCode).toBe(0);
      // Falls through past the (ignored) stale marker to the session-wide ladder:
      // exactly one bound task, quiet or not, resolves via rung 5/7 rather than focus.
      expect(agentBindsLines()[0]!.basis).not.toBe("focus");
      expect(agentBindsLines()[0]!.basis).not.toBe("focus_quiet");
    });

    test("a focus marker older than hook_focus_ttl_min is ignored EVEN WHILE its task is still absorbing work", () => {
      // §3.2a/§8.1: the TTL is fixed from the marker's OWN timestamp. Both tasks here
      // are freshly minted (created_at == "now", no backdating), so `touched` is fresh
      // and both are `active` — the case the rev-3 idle-based reading would have kept
      // believing the marker forever. A second active task forces real ambiguity: if
      // the marker were wrongly still believed, this would resolve `focus`/`t-hot`
      // instead of falling through to the session-wide ladder.
      initDb();
      seedBoundTask("t-hot", "sess-focus-hot");
      seedBoundTask("t-hot2", "sess-focus-hot");
      const staleTs = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h old, > default 120 min
      writeFocusMarker("sess-focus-hot", "t-hot", "est_focus", spoolDir, staleTs);
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-focus-hot",
          tool_name: "Agent",
          tool_use_id: "toolu_16",
          tool_input: {},
          tool_response: asyncAgentResponse("agent-hot"),
        }),
      );
      expect(r.exitCode).toBe(0);
      const basis = agentBindsLines()[0]!.basis;
      expect(basis).not.toBe("focus");
      expect(basis).not.toBe("focus_quiet");
      expect(basis).toBe("multi_active");
    });

    test("companion: a focus marker set 10 minutes ago on the same still-fresh-touch fixture still yields 'focus'", () => {
      initDb();
      seedBoundTask("t-hot3", "sess-focus-hot2");
      seedBoundTask("t-hot4", "sess-focus-hot2");
      const freshTs = new Date(Date.now() - 10 * 60 * 1000); // 10 min old, well within TTL
      writeFocusMarker("sess-focus-hot2", "t-hot3", "est_focus", spoolDir, freshTs);
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-focus-hot2",
          tool_name: "Agent",
          tool_use_id: "toolu_17",
          tool_input: {},
          tool_response: asyncAgentResponse("agent-hot2"),
        }),
      );
      expect(r.exitCode).toBe(0);
      expect(agentBindsLines()[0]).toMatchObject({ tid: "t-hot3", basis: "focus" });
    });
  });
});

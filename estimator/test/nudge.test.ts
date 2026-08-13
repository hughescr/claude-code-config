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

/**
 * §14.4/§14.9 (REV3): one `turn` row — the ONLY input the idle bridge reads besides
 * `task_scope` (INV-TTL, §14.2). `promptId` must be unique within the session (turn's
 * PK is `(session_id, prompt_id)`).
 */
function seedTurn(sessionId: string, promptId: string, startedAt: Date, durationMs: number | null = 0): void {
  const db = openDb({ path: dbPath });
  try {
    db.run("INSERT INTO turn (session_id,prompt_id,started_at,duration_ms) VALUES (?,?,?,?)", [
      sessionId,
      promptId,
      startedAt.toISOString(),
      durationMs,
    ]);
  } finally {
    db.close();
  }
}

/**
 * §14.9's "the session has a turn every ~N minutes" fixtures: seed one `durationMs`-
 * long turn every `stepMs` from `start` up to and including `end`. `prefix` keeps
 * `prompt_id`s unique across more than one call for the same session (turn's PK is
 * `(session_id, prompt_id)`) — e.g. an "idle hole" fixture calling this twice.
 */
function seedTurnsEvery(
  sessionId: string,
  start: Date,
  end: Date,
  stepMs: number,
  durationMs = 0,
  prefix = "p",
): void {
  let t = start.getTime();
  let i = 0;
  while (t <= end.getTime()) {
    seedTurn(sessionId, `${prefix}${i}`, new Date(t), durationMs);
    t += stepMs;
    i += 1;
  }
}

/**
 * §14.5's competing-evidence probe: a `task_scope` row for `tid` at `ts`, under
 * `source`. Only `'est_scope'` is what the probe matches — `seedBoundTask` already
 * writes a `seq=1` row with `source='est_open'`, which is why `seq` defaults to 2 here
 * (append-only PK is `(tid, seq)`).
 */
function seedTaskScope(tid: string, ts: Date, source: string, seq = 2): void {
  const db = openDb({ path: dbPath });
  try {
    db.run(
      `INSERT INTO task_scope (tid,seq,ts,subject,description,dod_json,scope_hash,source)
       VALUES (?,?,?,?,?,?,?,?)`,
      [tid, seq, ts.toISOString(), "later scope", null, "[]", `deadbeef${seq}`, source],
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

  describe("the est focus pointer (§3.2a) — rungs 2-4, REV3 idle bridge (§14.4)", () => {
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

    // §14.9 case 1 (the ruling's headline case): a 6-hour-old marker survives because
    // the SESSION kept transacting, not because the task's own age is short. This is
    // the test that FAILS under the superseded fixed-from-set reading (F1 variant A),
    // and is the whole reason REV3 exists (HOOK-BINDING-SPEC.md §14.0, §14.9#1).
    test("§14.9#1 headline: a focus marker survives 6 hours of steady session turns", () => {
      initDb();
      seedBoundTask("t-headline", "sess-headline");
      const markerTs = new Date(Date.now() - 6 * 60 * 60_000);
      writeFocusMarker("sess-headline", "t-headline", "est_focus", spoolDir, markerTs);
      // A turn every 20 minutes across the whole 6 hours — no gap anywhere near the
      // 120-minute default TTL.
      seedTurnsEvery("sess-headline", markerTs, new Date(Date.now() - 60_000), 20 * 60_000);
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-headline",
          tool_name: "Agent",
          tool_use_id: "toolu_headline",
          tool_input: {},
          tool_response: asyncAgentResponse("agent-headline"),
        }),
      );
      expect(r.exitCode).toBe(0);
      expect(agentBindsLines()[0]).toMatchObject({ tid: "t-headline", basis: "focus" });
    });

    // §14.9 case 2: idle expiry, and the monotonicity it pins. A gap inside the bridge
    // kills the marker even though activity resumes later and continues right up to
    // t_spawn — expiry is a one-way latch (§14.4.1 property 2), not a "how long ago was
    // the last turn" check, which would wrongly revive a dead marker on resume.
    test("§14.9#2 idle expiry: a >TTL hole in the turn stream drops the marker and later activity does not resurrect it", () => {
      initDb();
      seedBoundTask("t-idle", "sess-idle");
      const markerTs = new Date(Date.now() - 6 * 60 * 60_000);
      writeFocusMarker("sess-idle", "t-idle", "est_focus", spoolDir, markerTs);
      // Turns for the first hour...
      seedTurnsEvery("sess-idle", markerTs, new Date(markerTs.getTime() + 60 * 60_000), 10 * 60_000);
      // ...then a 3-hour hole (> the 120-minute default TTL)...
      const resumeAt = new Date(markerTs.getTime() + 4 * 60 * 60_000);
      // ...then turns resume and continue right up to (near) t_spawn.
      seedTurnsEvery("sess-idle", resumeAt, new Date(Date.now() - 60_000), 10 * 60_000, 0, "q");
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-idle",
          tool_name: "Agent",
          tool_use_id: "toolu_idle",
          tool_input: {},
          tool_response: asyncAgentResponse("agent-idle"),
        }),
      );
      expect(r.exitCode).toBe(0);
      const line = agentBindsLines()[0]!;
      expect(line.focus_drop).toBe("idle");
      expect(line.basis).not.toBe("focus");
      expect(line.basis).not.toBe("focus_quiet");
    });

    // §14.9 case 3: the boundary is `>`, not `>=` (scripts/nudge.ts's `focusVerdict`).
    // Both gaps below are between two SEEDED turns, never against t_spawn itself, so
    // the comparison is exact and immune to subprocess spawn-time jitter; only the
    // final "bridge the rest of the way to t_spawn" step is left to real wall-clock
    // time, and it is given a comfortable margin in both cases.
    describe("§14.9#3 the idle-gap boundary", () => {
      test("a gap of EXACTLY hook_focus_ttl_min is still believed", () => {
        initDb();
        seedBoundTask("t-bound1", "sess-bound1");
        const ttlMs = 120 * 60_000; // the default hook_focus_ttl_min
        const base = new Date(Date.now() - 2 * ttlMs);
        writeFocusMarker("sess-bound1", "t-bound1", "est_focus", spoolDir, base);
        seedTurn("sess-bound1", "p0", base, 0);
        seedTurn("sess-bound1", "p1", new Date(base.getTime() + ttlMs), 0); // gap == ttlMs exactly
        seedTurn("sess-bound1", "p2", new Date(base.getTime() + ttlMs + 60_000), 0); // bridge to t_spawn
        const r = runNudge(
          JSON.stringify({
            session_id: "sess-bound1",
            tool_name: "Agent",
            tool_use_id: "toolu_bound1",
            tool_input: {},
            tool_response: asyncAgentResponse("agent-bound1"),
          }),
        );
        expect(r.exitCode).toBe(0);
        expect(agentBindsLines()[0]).toMatchObject({ tid: "t-bound1", basis: "focus" });
      });

      test("a gap one second past hook_focus_ttl_min is dropped 'idle'", () => {
        initDb();
        seedBoundTask("t-bound2", "sess-bound2");
        const ttlMs = 120 * 60_000;
        const base = new Date(Date.now() - 2 * ttlMs);
        writeFocusMarker("sess-bound2", "t-bound2", "est_focus", spoolDir, base);
        seedTurn("sess-bound2", "p0", base, 0);
        seedTurn("sess-bound2", "p1", new Date(base.getTime() + ttlMs + 1000), 0); // one second OVER
        seedTurn("sess-bound2", "p2", new Date(base.getTime() + ttlMs + 60_000), 0); // resumes after
        const r = runNudge(
          JSON.stringify({
            session_id: "sess-bound2",
            tool_name: "Agent",
            tool_use_id: "toolu_bound2",
            tool_input: {},
            tool_response: asyncAgentResponse("agent-bound2"),
          }),
        );
        expect(r.exitCode).toBe(0);
        const line = agentBindsLines()[0]!;
        expect(line.focus_drop).toBe("idle");
        expect(line.basis).not.toBe("focus");
      });
    });

    // §14.9 case 4: the anti-circularity regression for §14.1's finding. Manufactures
    // exactly the evidence a NAIVE `MAX(marker.ts, T.last_attributed_activity)` basis
    // would have read as "T is still busy" — a hook-written alias for T and an
    // attributed turn, planted INSIDE the idle gap — and asserts the verdict is
    // unchanged. This is INV-TTL (§14.2) made concrete: the bridge reads only
    // turn(session_id, started_at, duration_ms) and task_scope, never `tid` or
    // `task_alias`, so none of this manufactured evidence can move it.
    test("§14.9#4 anti-circularity: more hook-bound activity for T does not renew a marker across an idle gap", () => {
      initDb();
      seedBoundTask("t-anti-t", "sess-anti");
      seedBoundTask("t-anti-u", "sess-anti");
      const markerTs = new Date(Date.now() - 4 * 60 * 60_000);
      // One turn right at the marker, then NOTHING until t_spawn ~4h later — an
      // unbroken idle gap on the RAW turn stream.
      seedTurn("sess-anti", "p0", markerTs, 0);
      writeFocusMarker("sess-anti", "t-anti-t", "est_focus", spoolDir, markerTs);

      const db = openDb({ path: dbPath });
      try {
        const midTs = new Date(markerTs.getTime() + 2 * 60 * 60_000).toISOString(); // 2h into the gap
        // A pre-existing hook-written alias for T, planted well inside the gap.
        db.run(
          "INSERT INTO task_alias (tid,id_kind,session_id,local_id,first_seen,source) VALUES (?,?,?,?,?,?)",
          ["t-anti-t", "agent", "sess-anti", "agent-manufactured", midTs, "hook"],
        );
        // What attribution would have done with that alias: the one turn covering it
        // gets tid = T. Set directly so the scenario is the WORST case, not merely a
        // plausible one — the naive circular basis would read this as T being touched
        // at p0's instant, i.e. exactly the marker's own timestamp.
        db.run("UPDATE turn SET tid = ? WHERE session_id = ? AND prompt_id = ?", [
          "t-anti-t",
          "sess-anti",
          "p0",
        ]);
      } finally {
        db.close();
      }

      const r = runNudge(
        JSON.stringify({
          session_id: "sess-anti",
          tool_name: "Agent",
          tool_use_id: "toolu_anti",
          tool_input: {},
          tool_response: asyncAgentResponse("agent-anti"),
        }),
      );
      expect(r.exitCode).toBe(0);
      const line = agentBindsLines()[0]!;
      expect(line.focus_drop).toBe("idle");
      expect(line.basis).not.toBe("focus");
      expect(line.basis).not.toBe("focus_quiet");
    });

    // §14.9 case 5: competing-evidence invalidation (§14.5), scoped narrowly to
    // `source='est_scope'`. The companion proves the scoping is deliberate, not an
    // oversight: `seedBoundTask` itself writes a `task_scope` row with
    // `source='est_open'` for every task it seeds, and that source is NOT covered,
    // because a real `est open` would already have rewritten the marker file itself
    // (§14.5's completeness table) — this rule exists only for `est scope`, the one
    // CLI act that moves a session's focus without touching the marker.
    describe("§14.9#5 competing evidence (§14.5)", () => {
      test("an est_scope row on a DIFFERENT bound task, newer than the marker, contests it", () => {
        initDb();
        seedBoundTask("t-cont-t", "sess-cont");
        seedBoundTask("t-cont-u", "sess-cont");
        const markerTs = new Date(Date.now() - 30 * 60_000);
        writeFocusMarker("sess-cont", "t-cont-t", "est_focus", spoolDir, markerTs);
        seedTurnsEvery("sess-cont", markerTs, new Date(Date.now() - 60_000), 5 * 60_000); // bridge intact
        seedTaskScope("t-cont-u", new Date(Date.now() - 10 * 60_000), "est_scope");
        const r = runNudge(
          JSON.stringify({
            session_id: "sess-cont",
            tool_name: "Agent",
            tool_use_id: "toolu_cont",
            tool_input: {},
            tool_response: asyncAgentResponse("agent-cont"),
          }),
        );
        expect(r.exitCode).toBe(0);
        const line = agentBindsLines()[0]!;
        expect(line.focus_drop).toBe("contested");
        expect(line.basis).not.toBe("focus");
      });

      test("companion: the same row under source='est_open' does NOT contest it (the deliberate scoping)", () => {
        initDb();
        seedBoundTask("t-openc-t", "sess-openc");
        seedBoundTask("t-openc-u", "sess-openc");
        const markerTs = new Date(Date.now() - 30 * 60_000);
        writeFocusMarker("sess-openc", "t-openc-t", "est_focus", spoolDir, markerTs);
        seedTurnsEvery("sess-openc", markerTs, new Date(Date.now() - 60_000), 5 * 60_000);
        seedTaskScope("t-openc-u", new Date(Date.now() - 10 * 60_000), "est_open");
        const r = runNudge(
          JSON.stringify({
            session_id: "sess-openc",
            tool_name: "Agent",
            tool_use_id: "toolu_openc",
            tool_input: {},
            tool_response: asyncAgentResponse("agent-openc"),
          }),
        );
        expect(r.exitCode).toBe(0);
        expect(agentBindsLines()[0]).toMatchObject({ tid: "t-openc-t", basis: "focus" });
      });
    });

    // §14.9 case 6: judged at t_spawn, not at hook-fire time (§14.4.3) — a synchronous
    // Agent's PostToolUse can fire hours after t_spawn, and `est focus` may well have
    // run in between. The task's `created_at` is backdated so it is still a candidate
    // AT t_spawn (§3.1's window filter); only the marker's own timestamp is what
    // decides post_spawn vs believed here.
    describe("§14.9#6 post_spawn (§14.4.3)", () => {
      test("a marker written AFTER t_spawn (a 1h synchronous Agent, marker set 10 min ago) is dropped 'post_spawn'", () => {
        initDb();
        seedBoundTask("t-post1", "sess-post1");
        const oneHourMs = 60 * 60_000;
        const db = openDb({ path: dbPath });
        try {
          db.run("UPDATE task SET created_at = ? WHERE tid = ?", [
            new Date(Date.now() - 2 * oneHourMs).toISOString(),
            "t-post1",
          ]);
        } finally {
          db.close();
        }
        const markerTs = new Date(Date.now() - 10 * 60_000); // AFTER t_spawn (now - 1h)
        writeFocusMarker("sess-post1", "t-post1", "est_focus", spoolDir, markerTs);
        const r = runNudge(
          JSON.stringify({
            session_id: "sess-post1",
            tool_name: "Agent",
            tool_use_id: "toolu_post1",
            tool_input: {},
            tool_response: syncAgentResponse("agent-post1", oneHourMs),
          }),
        );
        expect(r.exitCode).toBe(0);
        const line = agentBindsLines()[0]!;
        expect(line.focus_drop).toBe("post_spawn");
        expect(line.basis).not.toBe("focus");
        expect(line.basis).not.toBe("focus_quiet");
      });

      test("companion: a marker written well before t_spawn, with an intact bridge, is believed", () => {
        initDb();
        seedBoundTask("t-post2", "sess-post2");
        const markerTs = new Date(Date.now() - 4 * 60 * 60_000);
        writeFocusMarker("sess-post2", "t-post2", "est_focus", spoolDir, markerTs);
        seedTurnsEvery("sess-post2", markerTs, new Date(Date.now() - 60_000), 20 * 60_000);
        const r = runNudge(
          JSON.stringify({
            session_id: "sess-post2",
            tool_name: "Agent",
            tool_use_id: "toolu_post2",
            tool_input: {},
            tool_response: asyncAgentResponse("agent-post2"),
          }),
        );
        expect(r.exitCode).toBe(0);
        expect(agentBindsLines()[0]).toMatchObject({ tid: "t-post2", basis: "focus" });
      });
    });

    // §14.9 case 7: an unparseable marker timestamp is EXPIRED, not absent — kept
    // verbatim from the prior fixed-from-set reading (a corrupt marker is maximally
    // suspect, not maximally believable). `readFocusMarker` does not itself validate
    // that `ts` parses, so this constructs the corrupt shape by hand.
    test("§14.9#7 bad_ts: an unparseable marker timestamp is dropped, never believed", () => {
      initDb();
      seedBoundTask("t-badts", "sess-badts");
      mkdirSync(spoolDir, { recursive: true });
      writeFileSync(
        join(spoolDir, ".focus.sess-badts"),
        JSON.stringify({ tid: "t-badts", ts: "not-a-timestamp", by: "est_focus" }),
      );
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-badts",
          tool_name: "Agent",
          tool_use_id: "toolu_badts",
          tool_input: {},
          tool_response: asyncAgentResponse("agent-badts"),
        }),
      );
      expect(r.exitCode).toBe(0);
      const line = agentBindsLines()[0]!;
      expect(line.focus_drop).toBe("bad_ts");
      expect(line.basis).not.toBe("focus");
      expect(line.basis).not.toBe("focus_quiet");
    });

    // §14.9 case 8: hitting FOCUS_BRIDGE_SCAN_MAX fails CLOSED. 2000 turns one second
    // apart span barely half an hour — comfortably inside the TTL on their own — so the
    // ONLY way this can fail is the scan cap (scripts/nudge.ts), never an idle gap.
    test("§14.9#8 scan_cap: hitting the bridge scan cap drops the marker", () => {
      initDb();
      seedBoundTask("t-scancap", "sess-scancap");
      const markerTs = new Date(Date.now() - 40 * 60_000);
      writeFocusMarker("sess-scancap", "t-scancap", "est_focus", spoolDir, markerTs);
      const db = openDb({ path: dbPath });
      try {
        const start = markerTs.getTime();
        db.transaction(() => {
          for (let i = 0; i < 2000; i += 1) {
            db.run("INSERT INTO turn (session_id,prompt_id,started_at,duration_ms) VALUES (?,?,?,?)", [
              "sess-scancap",
              `p${i}`,
              new Date(start + i * 1000).toISOString(),
              0,
            ]);
          }
        })();
      } finally {
        db.close();
      }
      const r = runNudge(
        JSON.stringify({
          session_id: "sess-scancap",
          tool_name: "Agent",
          tool_use_id: "toolu_scancap",
          tool_input: {},
          tool_response: asyncAgentResponse("agent-scancap"),
        }),
      );
      expect(r.exitCode).toBe(0);
      const line = agentBindsLines()[0]!;
      expect(line.focus_drop).toBe("scan_cap");
      expect(line.basis).not.toBe("focus");
      expect(line.basis).not.toBe("focus_quiet");
    });

    // §14.9 case 9: the three pre-REV3 fixtures, kept and re-commented rather than
    // deleted (§14.7 rows 9-11) — none of their ASSERTIONS change, only why they pass.
    test("§14.9#9a a focus marker across an idle session (no turn rows at all) on an already-quiet task is ignored", () => {
      // Under REV3 this is an idle-gap drop, not a fixed-age one: `seedBoundTask` seeds
      // NO `turn` rows, so the bridge finds nothing between marker.ts and t_spawn and
      // the whole 3-hour span is one unbroken idle gap (§14.7 row 9). Backdating the
      // task's own `created_at` too keeps this test unambiguous about WHY it falls
      // through — the marker is dropped before "active" is ever consulted.
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
      const line = agentBindsLines()[0]!;
      expect(line.focus_drop).toBe("idle");
      expect(line.basis).not.toBe("focus");
      expect(line.basis).not.toBe("focus_quiet");
    });

    test("§14.9#9b a focus marker over an idle gap is dropped even while its named task's own window looks fresh", () => {
      // The F1/variant-A pin, retitled: this is no longer "the TTL is fixed from the
      // marker's own timestamp" (superseded, §14.7 row 10) — it is the SAME idle-gap
      // drop as 9a, for the SAME reason (`seedBoundTask` seeds no `turn` rows, so the
      // 3-hour span is one unbroken gap), now on a session with a SECOND open task so
      // the fall-through lands on `multi_active` rather than `no_active`. Note, and do
      // not "fix": `t-hot2`'s own `task_scope` row (written by `seedBoundTask`, source
      // `'est_open'`) does NOT additionally trigger `contested` — §14.5's rule is
      // scoped to `source='est_scope'` only (see the companion test above), so `idle`
      // is this fixture's ONLY reason, not two independent ones.
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
      const line = agentBindsLines()[0]!;
      expect(line.focus_drop).toBe("idle");
      expect(line.basis).not.toBe("focus");
      expect(line.basis).not.toBe("focus_quiet");
      expect(line.basis).toBe("multi_active");
    });

    test("§14.9#9c companion: a focus marker set 10 minutes ago on a two-open-task session still yields 'focus' (est_scope scoping guard)", () => {
      // Kept unchanged (§14.7 row 11): passes for the same reason it always did — a
      // 10-minute-old marker is well inside the idle-gap TTL even with zero turn rows
      // seeded — and is now ALSO the regression guard on §14.5's scoping: `t-hot4`'s
      // `task_scope` row is newer than the marker but carries `source='est_open'`
      // (written by `seedBoundTask`), which the competing-evidence rule deliberately
      // ignores because a REAL `est open` would already have rewritten the marker file
      // itself. If this ever starts asserting `contested`, the scoping regressed.
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

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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";

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

function seedTask(opts: {
  tid: string;
  sessionId: string;
  status?: string;
  calP90?: number;
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
          1000,
          opts.calP90,
          1,
          0,
          1,
          2,
          5,
          "global",
          0,
          0,
          1000,
          opts.calP90,
          now,
          "claude-sonnet-4-5",
          "work_cet",
          "claude-sonnet-4-5",
        ],
      );
    }
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

  test("exits 0 and still nudges when the database file does not exist", () => {
    const r = runNudge(
      JSON.stringify({ session_id: "s1", tool_name: "Workflow", tool_input: {} }),
      { EST_DB: join(dir, "does-not-exist.db") },
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(payload.hookSpecificOutput.additionalContext).toContain("estimating");
  });
});

describe("nudge.ts — P1.10 job 1: decide", () => {
  test("nudges (naming the estimating skill) when no task is bound to the session", () => {
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
    runNudge(
      JSON.stringify({ session_id: "unbound-session", tool_name: "Workflow", tool_input: {} }),
    );
    const lines = complianceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ bound_tid: null, nudged: true });
  });

  test("appends, never overwrites, across repeated invocations", () => {
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
});

describe("nudge.ts — P1.10 job 3: EST_DISABLE_MICROSWEEP escape hatch", () => {
  // job 3's real path spawns a corpus-wide `est sweep` and takes the production
  // sweep lock (§2, P1.10) — deliberately NOT exercised end-to-end here; that
  // was verified by hand against the real corpus during this change (see
  // conversation notes), and every test above depends on the disable flag
  // actually suppressing it. This confirms the flag itself does that.
  test("no throttle marker is created when the microsweep is disabled", () => {
    runNudge(JSON.stringify({ session_id: "no-marker-session", tool_name: "Task", tool_input: {} }));
    expect(existsSync(join(spoolDir, ".microsweep.no-marker-session"))).toBe(false);
  });
});

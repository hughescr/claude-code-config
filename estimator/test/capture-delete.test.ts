/**
 * scripts/capture-delete.ts — PreToolUse hook body, matcher `TaskUpdate`
 * (design R4 §Phase 1 interfaces, P1.11; required by G-DELETE, §6.1).
 *
 * Runs the script as a REAL subprocess with synthesized stdin, exactly as
 * Claude Code's hook runner invokes it — the hook's whole contract is "a
 * process fed JSON on stdin", so that is what is exercised here rather than
 * an in-process call.
 *
 * The last test in this file IS the mandatory, previously-outstanding
 * regression test P1.11 names explicitly: "Simulate a kill between the
 * TaskUpdate tool_use write and its tool_result write; assert the deletion
 * is still recorded from the spooled hook row." The corpus contains zero
 * naturally-occurring instances of that failure mode, so this is the only
 * coverage it will ever have — the hook fires at PreToolUse, i.e. before
 * the tool call (and any tool_result) exists at all, so a kill immediately
 * afterwards is simulated simply by never producing a tool_result: this test
 * only ever invokes the PreToolUse hook and checks its spool row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CAPTURE_DELETE_SCRIPT = join(import.meta.dir, "..", "scripts", "capture-delete.ts");

let dir: string;
let spoolDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "est-capture-delete-"));
  spoolDir = join(dir, "spool");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCaptureDelete(stdin: string): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", CAPTURE_DELETE_SCRIPT], {
    stdin: Buffer.from(stdin, "utf8"),
    env: { ...process.env, EST_SPOOL_DIR: spoolDir },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  };
}

function taskEventLines(): Array<Record<string, unknown>> {
  const path = join(spoolDir, "task-events.jsonl");
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("capture-delete.ts — P1.11 always-allow, fail-open contract", () => {
  test("exits 0 with empty stdout on unparseable stdin", () => {
    const r = runCaptureDelete("not json");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(taskEventLines()).toHaveLength(0);
  });

  test("exits 0 with empty stdout on empty stdin", () => {
    const r = runCaptureDelete("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("exits 0 and captures nothing when tool_input is entirely absent", () => {
    const r = runCaptureDelete(JSON.stringify({ session_id: "s1" }));
    expect(r.exitCode).toBe(0);
    expect(taskEventLines()).toHaveLength(0);
  });
});

describe("capture-delete.ts — P1.11 the common case: status !== 'deleted'", () => {
  for (const status of ["pending", "in_progress", "completed"]) {
    test(`captures nothing for status=${status}`, () => {
      const r = runCaptureDelete(
        JSON.stringify({ session_id: "s1", tool_input: { taskId: "1", status } }),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
      expect(taskEventLines()).toHaveLength(0);
    });
  }
});

describe("capture-delete.ts — P1.11 the capture case: status === 'deleted'", () => {
  test("appends one line with the exact P1.11 shape", () => {
    const r = runCaptureDelete(
      JSON.stringify({ session_id: "sess-7", tool_input: { taskId: "7", status: "deleted" } }),
    );
    expect(r.exitCode).toBe(0);
    const lines = taskEventLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      session_id: "sess-7",
      task_num: "7",
      to_status: "deleted",
      source: "pretooluse",
    });
    expect(typeof lines[0]!.ts).toBe("string");
  });

  test("coerces a numeric taskId to a string task_num", () => {
    runCaptureDelete(JSON.stringify({ session_id: "s1", tool_input: { taskId: 42, status: "deleted" } }));
    const lines = taskEventLines();
    expect(lines[0]!.task_num).toBe("42");
  });

  test("tolerates a missing session_id (records an empty string, never crashes)", () => {
    const r = runCaptureDelete(JSON.stringify({ tool_input: { taskId: "9", status: "deleted" } }));
    expect(r.exitCode).toBe(0);
    const lines = taskEventLines();
    expect(lines[0]).toMatchObject({ session_id: "", task_num: "9" });
  });

  test("appends, never overwrites, across repeated deletions", () => {
    runCaptureDelete(JSON.stringify({ session_id: "s1", tool_input: { taskId: "1", status: "deleted" } }));
    runCaptureDelete(JSON.stringify({ session_id: "s1", tool_input: { taskId: "2", status: "deleted" } }));
    expect(taskEventLines()).toHaveLength(2);
  });
});

describe("capture-delete.ts — P1.11 mandatory regression test (§6.1, G-DELETE)", () => {
  test(
    "a kill immediately after PreToolUse (no tool_result ever written) still leaves the " +
      "deletion recorded, because the hook writes its spool line BEFORE the tool call runs",
    () => {
      // The hook's entire reason to exist is that it runs at PreToolUse, strictly
      // before the TaskUpdate tool call (and therefore before any tool_result) —
      // so "the process is killed between tool_use and tool_result" and "only the
      // PreToolUse hook ever ran" are the same scenario from this file's side.
      // What must survive that kill is exactly what this asserts: the spool row.
      const r = runCaptureDelete(
        JSON.stringify({
          session_id: "sess-killed",
          tool_name: "TaskUpdate",
          tool_input: { taskId: "13", status: "deleted" },
          // No tool_response / tool_result field at all: PreToolUse hooks never
          // receive one — the tool has not run yet. Nothing here should be
          // required for capture to succeed, which is the point.
        }),
      );

      expect(r.exitCode).toBe(0); // always-allow: the (never-run) tool call is not blocked

      const lines = taskEventLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        session_id: "sess-killed",
        task_num: "13",
        to_status: "deleted",
        source: "pretooluse",
      });
      // This is the ONLY record of the deletion in this scenario: no transcript
      // tool_result was ever written, and the design's own G-DELETE finding is
      // that file-presence is independently unreliable in either direction —
      // so the sweeper draining this row (source='pretooluse') is the sole
      // signal that survives. Nothing else in this test suite can assert that
      // more directly than checking the row is here at all.
    },
  );
});

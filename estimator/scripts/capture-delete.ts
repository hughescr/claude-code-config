#!/usr/bin/env bun
/**
 * scripts/capture-delete.ts — PreToolUse hook body for matcher `TaskUpdate`
 * (design R4 §Phase 1 interfaces, P1.11; required by G-DELETE, §6.1).
 *
 * ALWAYS ALLOWS. Never denies the tool call, for any reason, including this
 * script throwing. This hook has exactly one job: if `tool_input.status ===
 * 'deleted'`, append one atomic line to spool/task-events.jsonl BEFORE the
 * tool call completes — the one signal that survives a process death between
 * the `TaskUpdate` tool_use write and its tool_result write (§6.1). Every
 * other status is a silent no-op.
 *
 * Why a spool append and not a `task_event` insert: this fires on the hot
 * path, and a `BEGIN IMMEDIATE` here could queue behind a running sweep. The
 * spool write is a single O_APPEND of one short line — no lock, no failure
 * mode, and it survives the process dying immediately afterwards, which is
 * the exact scenario this hook exists for. The next sweep drains it into
 * `task_event(source='pretooluse')`.
 *
 * The hook row is a REDUNDANT WITNESS, not a deduplicated one. `task_event`'s
 * UNIQUE key includes `ts`, and the two timestamps cannot match: this hook
 * stamps its own wall clock at PreToolUse (below), while the transcript row
 * carries the tool-completion instant from the JSONL record. A normally
 * completing deletion therefore leaves TWO rows, one per source. Every
 * consumer today folds them (`COUNT(*) > 0`, set-like status folding), so the
 * duplicate is inert — but any future consumer that COUNTS task_event rows
 * must group by `source` or it will double-count this case.
 *
 * Budget: <=20ms of actual work (bun's own cold start is separate).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT } from "../src/db.ts";

// Mirrors db.ts's EST_DB override for the same reason: tests should never
// have to touch the real spool/ under estimator-data/. Unset in production, so
// behaviour there is unchanged.
const SPOOL_DIR = process.env.EST_SPOOL_DIR ?? join(DATA_ROOT, "spool");
const TASK_EVENTS_LOG = join(SPOOL_DIR, "task-events.jsonl");

interface ToolUpdateInput {
  taskId?: unknown;
  status?: unknown;
}

interface HookInput {
  session_id?: unknown;
  tool_input?: ToolUpdateInput;
}

function readStdin(): string {
  try {
    return require("node:fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function taskNumOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return "";
}

function main(): void {
  const raw = readStdin();
  if (raw.trim().length === 0) process.exit(0);

  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.exit(0); // unparseable stdin: always allow, do nothing
  }

  const status = input.tool_input?.status;
  if (status !== "deleted") process.exit(0); // the common case: nothing to capture

  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const taskNum = taskNumOf(input.tool_input?.taskId);

  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: sessionId,
      task_num: taskNum,
      to_status: "deleted",
      source: "pretooluse",
    });
    mkdirSync(SPOOL_DIR, { recursive: true });
    appendFileSync(TASK_EVENTS_LOG, `${line}\n`, { flag: "a" });
  } catch {
    // Fail open: never deny, never crash the hot path over a lost spool line.
  }

  process.exit(0);
}

if (import.meta.main) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

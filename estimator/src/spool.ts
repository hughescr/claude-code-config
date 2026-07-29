/**
 * src/spool.ts — the INGESTION side of the hook spool (P1.10, P1.11).
 *
 * The hooks themselves are shell/TS entry points that live elsewhere; this file is
 * the reader, and it exists because of one constraint the hooks cannot negotiate:
 * **they run on Craig's hot path and must not write to the database.** A
 * `BEGIN IMMEDIATE` in a `PostToolUse(Task|Workflow)` handler queues behind exactly
 * the sweeps that a fan-out triggers, which is the moment the hook fires. So each
 * hook makes a single `O_APPEND` write, sized under `PIPE_BUF` so it is atomic
 * without a lock, and the next sweep drains it.
 *
 * The property that actually matters for the delete-capture hook is the second one:
 * **an appended line survives the process dying immediately afterwards**, which is
 * the exact scenario the hook exists for (§6.1, G-DELETE). A session that dies
 * between the `TaskUpdate` `tool_use` and its `tool_result` leaves NO transcript
 * record, and the fallback signal — the task file's absence — is independently
 * unreliable: the gate found 9 session task-dirs that lost every file with no
 * deletion ever requested. This spool is the only mechanism that captures the
 * abandonment record before either half can be lost.
 *
 * **Drain is crash-safe by rename.** The live file is renamed to `<name>.draining`
 * before it is read, so a hook's next append creates a fresh file and nothing written
 * during the drain is lost to a truncate. If the process dies mid-drain the
 * `.draining` file survives and is picked up first on the next sweep. Deduplication
 * is free: `task_event`'s `UNIQUE (session_id, task_num, ts, to_status, kind)`
 * collapses the hook row and the later transcript row when both land, which is the
 * common case since most deletions complete normally.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./db.ts";
import type { IngestAnomaly } from "./ingest.ts";

/**
 * Where the hooks write and this reader reads. The directory is gitignored like the
 * database itself.
 *
 * **`EST_SPOOL_DIR` is the name the hooks use and therefore the name that wins.**
 * `scripts/nudge.ts` and `scripts/capture-delete.ts` both resolve their spool as
 * `process.env.EST_SPOOL_DIR ?? join(ROOT, "spool")`; if this reader honoured only its
 * own `EST_SPOOL`, setting either variable alone would give the writers and the reader
 * two different directories — hooks appending to a spool no sweep ever drains, which
 * loses exactly the delete-capture records P1.11 exists to preserve, silently and with
 * a passing test suite on both sides. Both names are accepted so neither half can be
 * configured out from under the other; `spoolDirFrom` is exported so the agreement is
 * testable rather than assumed.
 */
export function spoolDirFrom(env: Record<string, string | undefined>, root: string = ROOT): string {
  const explicit = env.EST_SPOOL_DIR ?? env.EST_SPOOL;
  return explicit !== undefined && explicit !== "" ? explicit : join(root, "spool");
}

export const SPOOL_DIR: string = spoolDirFrom(process.env);

export const COMPLIANCE_FILE = "compliance.jsonl";
export const TASK_EVENTS_FILE = "task-events.jsonl";
const DRAINING_SUFFIX = ".draining";

/**
 * One `PostToolUse` observation (P1.10 job 2). Written for EVERY matched call,
 * nudged or not, because a compliance rate needs a denominator.
 */
export interface ComplianceRecord {
  ts: string;
  session_id: string;
  tool_name: string;
  tool_input_sha256: string;
  bound_tid: string | null;
  nudged: boolean;
}

/** One `PreToolUse(TaskUpdate)` delete capture (P1.11). */
export interface TaskEventRecord {
  ts: string;
  session_id: string;
  task_num: string;
  to_status: string;
  source: "pretooluse";
}

export interface SpoolRead<T> {
  rows: T[];
  /** Lines that parsed as JSON but did not match the record shape. */
  malformed: number;
  /** A final line with no terminating newline — a hook killed mid-append. */
  truncatedTail: number;
}

function parseLines(text: string): { values: unknown[]; malformed: number; truncatedTail: number } {
  const values: unknown[] = [];
  let malformed = 0;
  let truncatedTail = 0;
  if (text.length === 0) return { values, malformed, truncatedTail };
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (endsWithNewline) lines.pop();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // The LAST line of a file with no trailing newline is a torn append, not
      // corruption — the hook was killed between `write` and the newline. Counted
      // separately so a genuine malformed line still reads as one.
      if (!endsWithNewline && i === lines.length - 1) truncatedTail += 1;
      else malformed += 1;
    }
  }
  return { values, malformed, truncatedTail };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function parseComplianceLines(text: string): SpoolRead<ComplianceRecord> {
  const { values, malformed, truncatedTail } = parseLines(text);
  const rows: ComplianceRecord[] = [];
  let bad = malformed;
  for (const v of values) {
    if (v === null || typeof v !== "object") {
      bad += 1;
      continue;
    }
    const o = v as Record<string, unknown>;
    const ts = str(o.ts);
    const session = str(o.session_id) ?? str(o.sessionId);
    const tool = str(o.tool_name) ?? str(o.toolName);
    if (ts === null || session === null || tool === null) {
      bad += 1;
      continue;
    }
    rows.push({
      ts,
      session_id: session,
      tool_name: tool,
      tool_input_sha256: str(o.tool_input_sha256) ?? "",
      bound_tid: str(o.bound_tid),
      nudged: o.nudged === true,
    });
  }
  return { rows, malformed: bad, truncatedTail };
}

export function parseTaskEventLines(text: string): SpoolRead<TaskEventRecord> {
  const { values, malformed, truncatedTail } = parseLines(text);
  const rows: TaskEventRecord[] = [];
  let bad = malformed;
  for (const v of values) {
    if (v === null || typeof v !== "object") {
      bad += 1;
      continue;
    }
    const o = v as Record<string, unknown>;
    const ts = str(o.ts);
    const session = str(o.session_id) ?? str(o.sessionId);
    const taskNum = str(o.task_num) ?? str(o.taskId) ?? str(o.taskNum);
    const to = str(o.to_status) ?? str(o.status);
    if (ts === null || session === null || taskNum === null || to === null) {
      bad += 1;
      continue;
    }
    rows.push({ ts, session_id: session, task_num: taskNum, to_status: to, source: "pretooluse" });
  }
  return { rows, malformed: bad, truncatedTail };
}

export interface DrainResult {
  task_events: { read: number; inserted: number; malformed: number; truncated: number };
  compliance: { read: number; nudged: number; unbound: number; malformed: number; truncated: number };
  anomalies: IngestAnomaly[];
  /**
   * Delete the claimed `.draining` files. **Call this only AFTER the surrounding
   * transaction commits.** Deleting inside the transaction would lose every spooled
   * record if the commit then failed — which is the one failure mode the
   * delete-capture hook exists to survive.
   */
  cleanup: () => void;
}

export function emptyDrain(): DrainResult {
  return {
    task_events: { read: 0, inserted: 0, malformed: 0, truncated: 0 },
    compliance: { read: 0, nudged: 0, unbound: 0, malformed: 0, truncated: 0 },
    anomalies: [],
    cleanup: () => {},
  };
}

const INSERT_HOOK_EVENT_SQL = `
INSERT INTO task_event (session_id, task_num, ts, kind, from_status, to_status, source)
VALUES ($session_id, $task_num, $ts, 'status', NULL, $to_status, 'pretooluse')
ON CONFLICT(session_id, task_num, ts, to_status, kind) DO NOTHING
`;

/**
 * Take ownership of a spool file for reading, crash-safely.
 *
 * The live file is RENAMED rather than truncated, so a hook appending concurrently
 * lands in a fresh file and nothing written during the drain is lost. The renamed
 * file is left on disk for the caller's `cleanup()`; if the process dies before that
 * runs, the next sweep finds the `.draining` file and merges it back in. Losing it
 * would lose exactly the records the hook exists to preserve.
 */
function claim(dir: string, name: string): { text: string; claimed: string | null } {
  const live = join(dir, name);
  const draining = join(dir, `${name}${DRAINING_SUFFIX}`);

  // A `.draining` file is the residue of a drain that died before its cleanup. It is
  // finished FIRST, on its own, and the live file waits for the next sweep — merging
  // the two would either double-count the recovered lines or need a second staging
  // name, and one sweep of latency is a much cheaper price than either.
  if (existsSync(draining)) {
    try {
      return { text: readFileSync(draining, "utf8"), claimed: draining };
    } catch {
      return { text: "", claimed: draining };
    }
  }
  if (!existsSync(live)) return { text: "", claimed: null };
  try {
    renameSync(live, draining);
  } catch {
    return { text: "", claimed: null };
  }
  try {
    return { text: readFileSync(draining, "utf8"), claimed: draining };
  } catch {
    return { text: "", claimed: draining };
  }
}

/**
 * Drain both spool files into the database. Call INSIDE the sweep's transaction.
 *
 * Compliance records do NOT get a table of their own, deliberately: Phase 1's schema
 * delta is `burn_cache` and two config rows and nothing else (P1.0), and the exact
 * compliance metric the retro publishes — `compliance_t1t2` — is computed from
 * `v_missed_estimate` over `turn`/`agent_run`, not from this spool (§3.3). What the
 * spool adds is the thing the view cannot reconstruct: whether a nudge was actually
 * emitted at the time. A record showing a matched delegation with NO bound task is a
 * real compliance miss, so it lands in the anomaly ledger where it is visible; the
 * compliant ones are counted into the sweep report and discarded, because keeping
 * them would only duplicate what `v_missed_estimate` already answers exactly.
 */
export function drainSpool(db: Database, dir: string = SPOOL_DIR): DrainResult {
  const result = emptyDrain();
  if (!existsSync(dir)) return result;

  const claimed: string[] = [];
  result.cleanup = (): void => {
    for (const p of claimed) rmSync(p, { force: true });
  };

  const events = claim(dir, TASK_EVENTS_FILE);
  if (events.claimed !== null) claimed.push(events.claimed);
  if (events.text !== "") {
    const parsed = parseTaskEventLines(events.text);
    result.task_events.read = parsed.rows.length;
    result.task_events.malformed = parsed.malformed;
    result.task_events.truncated = parsed.truncatedTail;
    const stmt = db.prepare(INSERT_HOOK_EVENT_SQL);
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()?.n ?? 0;
    for (const row of parsed.rows) {
      stmt.run({
        $session_id: row.session_id,
        $task_num: row.task_num,
        $ts: row.ts,
        $to_status: row.to_status,
      } as never);
    }
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()?.n ?? 0;
    result.task_events.inserted = after - before;
    if (parsed.malformed > 0) {
      result.anomalies.push({
        kind: "malformed_line",
        detail: `${parsed.malformed} unparseable line(s) in ${TASK_EVENTS_FILE}; the delete-capture hook wrote something this reader does not understand`,
      });
    }
  }

  const compliance = claim(dir, COMPLIANCE_FILE);
  if (compliance.claimed !== null) claimed.push(compliance.claimed);
  if (compliance.text !== "") {
    const parsed = parseComplianceLines(compliance.text);
    result.compliance.read = parsed.rows.length;
    result.compliance.malformed = parsed.malformed;
    result.compliance.truncated = parsed.truncatedTail;
    for (const row of parsed.rows) {
      if (row.nudged) result.compliance.nudged += 1;
      if (row.bound_tid === null) {
        result.compliance.unbound += 1;
        result.anomalies.push({
          kind: "missed_estimate",
          detail:
            `${row.tool_name} launched in session ${row.session_id} at ${row.ts} with no open estimate bound to it` +
            (row.nudged ? " (nudged)" : " (no nudge emitted)"),
        });
      }
    }
    if (parsed.malformed > 0) {
      result.anomalies.push({
        kind: "malformed_line",
        detail: `${parsed.malformed} unparseable line(s) in ${COMPLIANCE_FILE}`,
      });
    }
  }

  return result;
}

/** Create the spool directory. Hooks assume it exists; `est init` makes sure. */
export function ensureSpool(dir: string = SPOOL_DIR): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

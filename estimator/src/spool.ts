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
 * `.draining` file survives and is picked up first on the next sweep.
 *
 * **The drained hook row is a redundant witness, not a deduplicated one.**
 * `task_event`'s `UNIQUE (session_id, task_num, ts, to_status, kind)` includes `ts`,
 * and the two sources cannot agree on it: the hook stamps its own wall clock at
 * PreToolUse, the transcript row carries the tool-completion instant from the JSONL
 * record. A normally completing deletion therefore lands TWO rows, one per `source`.
 * That is inert for every consumer today — all of them fold (`COUNT(*) > 0`, or
 * set-like status folding) rather than count — but a consumer that ever COUNTS
 * `task_event` rows must group by `source` or it will double-count the common case.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
 * Hook marker files (P1.10 jobs 3 and 4) live in the spool directory too, and the
 * names are declared HERE rather than in `scripts/nudge.ts` because two other places
 * have to recognise them: `pruneMarkers` below, and `est close` (`clearOverrunMarker`).
 * A name that drifts between writer and pruner is an unbounded leak nothing notices.
 *
 * `.microsweep` is deliberately ONE file, not one per session: the throttle exists to
 * stop a fan-out from launching N corpus-wide sweeps, and N concurrent sessions each
 * with their own marker is exactly the fan-out it is supposed to collapse (§6.3).
 */
export const MICROSWEEP_MARKER = ".microsweep";
export const OVERRUN_MARKER_PREFIX = ".overrun-notified.";
/**
 * P2.7's board-regeneration throttle marker, declared here for the reason stated
 * above: `pruneMarkers` has to recognise every name written into this directory, and a
 * marker the pruner does not know is a file nothing ever reaps. `src/board-render.ts`
 * writes and stats it; it re-exports this constant rather than declaring a second one.
 */
export const BOARD_MARKER = ".board";
/**
 * P1.7's sweeper close-pass throttle marker (Craig 2026-07-30), declared here for the
 * same reason `.board` is: `pruneMarkers` has to recognise every name written into this
 * directory. `src/autoclose.ts` writes and stats it; it re-exports this constant rather
 * than declaring a second one.
 *
 * ONE file, like `.microsweep` and for the same reason: every hook fire in the machine
 * spawns the SAME `est sweep`, so a per-session window would let N sessions run N close
 * passes inside one interval — the fan-out the throttle exists to collapse.
 */
export const CLOSE_PASS_MARKER = ".closepass";

/** Filesystem-safe form of an id used inside a marker filename. */
export function sanitizeForFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
}

/** Marker filename (not path) recording that `tid` has been nudged about its band. */
export function overrunMarkerFile(tid: string): string {
  return `${OVERRUN_MARKER_PREFIX}${sanitizeForFilename(tid)}`;
}

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
  /** Which nudge the hook actually emitted; `"none"` when it stayed silent. */
  nudge_kind: NudgeKind;
  /**
   * The hook could not READ the database (missing, locked, schema mismatch). Such a
   * line carries no evidence either way about compliance — `bound_tid` is null because
   * nothing could be looked up, not because nothing was bound — so it is excluded from
   * both the counters and the `missed_estimate` anomaly below.
   */
  db_unavailable: boolean;
}

/** P1.10: which of the hook's two nudges fired. */
export type NudgeKind = "none" | "no_estimate" | "overrun";

function nudgeKind(v: unknown): NudgeKind {
  return v === "no_estimate" || v === "overrun" || v === "none" ? v : "none";
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
    const boundTid = str(o.bound_tid);
    const nudged = o.nudged === true;
    // A line written before `nudge_kind` existed still says WHICH nudge it was, by
    // construction: the only nudge a bound task could have got is the overrun one.
    const kind: NudgeKind =
      o.nudge_kind === undefined
        ? nudged
          ? boundTid === null
            ? "no_estimate"
            : "overrun"
          : "none"
        : nudgeKind(o.nudge_kind);
    rows.push({
      ts,
      session_id: session,
      tool_name: tool,
      tool_input_sha256: str(o.tool_input_sha256) ?? "",
      bound_tid: boundTid,
      nudged,
      nudge_kind: kind,
      db_unavailable: o.db_unavailable === true,
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
  compliance: {
    read: number;
    nudged: number;
    unbound: number;
    /** Lines the hook wrote with no readable database — evidence-free, counted apart. */
    db_unavailable: number;
    malformed: number;
    truncated: number;
  };
  /** Stale hook marker files removed this drain (P1.10 jobs 3/4 leave them behind). */
  markers_pruned: number;
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
    compliance: { read: 0, nudged: 0, unbound: 0, db_unavailable: 0, malformed: 0, truncated: 0 },
    markers_pruned: 0,
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

  // Marker files are the hooks' other residue: nothing else enumerates this directory,
  // so without this every sweep leaves them and `ls spool/` stops being diagnostic.
  result.markers_pruned = pruneMarkers(dir);

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
    // `changes` from the statement itself, NOT a COUNT(*) either side of the loop: the
    // INSERT is `ON CONFLICT … DO NOTHING`, so a suppressed duplicate reports 0 changes
    // and the sum is exactly the delta the two scans used to compute — minus two full
    // table reads per drain, inside the sweep's write transaction.
    let inserted = 0;
    for (const row of parsed.rows) {
      inserted += Number(
        stmt.run({
          $session_id: row.session_id,
          $task_num: row.task_num,
          $ts: row.ts,
          $to_status: row.to_status,
        } as never).changes ?? 0,
      );
    }
    result.task_events.inserted = inserted;
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
      // "The hook could not open the database" is not a compliance fact. Counting it
      // as one turns a missing/locked/unmigrated database into a permanent
      // `missed_estimate` anomaly and poisons the denominator §3.3 actually enforces.
      if (row.db_unavailable) {
        result.compliance.db_unavailable += 1;
        continue;
      }
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

/** A `.microsweep` marker older than this is dead weight (the throttle window is ~20 s). */
export const MICROSWEEP_MARKER_TTL_MS = 60 * 60 * 1000;
/**
 * An `.overrun-notified.<tid>` marker is armed for as long as its task can plausibly
 * still be open. The primary reclaim is `est close` (`clearOverrunMarker`); this is the
 * backstop for tasks that were never closed, and it is deliberately long because
 * deleting a live one re-arms a nudge Craig has already been shown.
 */
export const OVERRUN_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * The `.board` throttle marker is re-stamped by every regeneration, so one older than
 * this belongs to a board nobody has rendered in a day — the estimator is not running,
 * or the board was turned off. Reaping it costs exactly one un-throttled render on the
 * next sweep, which is the cheapest possible way to be wrong.
 */
export const BOARD_MARKER_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The `.closepass` marker is re-stamped by every close pass that actually ran, so one
 * older than this belongs to an estimator nobody has swept in a day. Reaping it costs
 * exactly one un-throttled candidate query on the next sweep — the same "cheapest
 * possible way to be wrong" the board marker is reaped by, and the query is one indexed
 * read per open task.
 */
export const CLOSE_PASS_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete stale hook marker files. Called from `drainSpool`, so it runs on every sweep
 * and every cron leg without a scheduler entry of its own.
 *
 * Only files this module NAMES are considered — the two spool files, their `.draining`
 * staging copies and anything a future hook drops in here are untouched, because a
 * pruner that guesses at ownership is how a crash-safety mechanism loses its records.
 */
export function pruneMarkers(dir: string = SPOOL_DIR, now: Date = new Date()): number {
  let pruned = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // no directory, no markers; a sweep never fails over housekeeping
  }
  for (const name of entries) {
    let ttl: number;
    if (name === MICROSWEEP_MARKER || name.startsWith(`${MICROSWEEP_MARKER}.`)) {
      ttl = MICROSWEEP_MARKER_TTL_MS; // `.microsweep.<sid>` = a pre-global-throttle leftover
    } else if (name.startsWith(OVERRUN_MARKER_PREFIX)) {
      ttl = OVERRUN_MARKER_TTL_MS;
    } else if (name === BOARD_MARKER || name.startsWith(`${BOARD_MARKER}.tmp.`)) {
      // P2.7 requires the pruner to learn this name "so it cannot leak". The `.tmp.`
      // form is `writeAtomic`'s staging file for the marker itself, left behind only by
      // a crash between the write and the rename.
      ttl = BOARD_MARKER_TTL_MS;
    } else if (name === CLOSE_PASS_MARKER) {
      // Same contract as `.board` above: the pruner learns the name so the marker
      // cannot leak. No `.tmp.` sibling — only the mtime is ever read, so the writer
      // is a plain `writeFileSync` and there is no staging file to reap.
      ttl = CLOSE_PASS_MARKER_TTL_MS;
    } else {
      continue;
    }
    const path = join(dir, name);
    try {
      if (now.getTime() - statSync(path).mtimeMs < ttl) continue;
      rmSync(path, { force: true });
      pruned += 1;
    } catch {
      // Raced with another sweep or the hook itself; the next sweep tries again.
    }
  }
  return pruned;
}

/**
 * Disarm the overrun nudge for `tid`. Called by `est close`: a finalized task cannot
 * overrun again, and leaving the marker would both leak a file and (after a reopen)
 * suppress the first legitimate nudge of the new run.
 */
export function clearOverrunMarker(tid: string, dir: string = SPOOL_DIR): void {
  try {
    rmSync(join(dir, overrunMarkerFile(tid)), { force: true });
  } catch {
    // Never fail a close over a marker file.
  }
}

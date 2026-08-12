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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, getConfig } from "./db.ts";
import type { IngestAnomaly } from "./ingest.ts";
import { UPSERT_ALIAS_SQL } from "./tasks.ts";

/**
 * Where the hooks write and this reader reads. The directory lives under DATA_ROOT,
 * outside the public checkout, like the database itself.
 *
 * **`EST_SPOOL_DIR` is the name the hooks use and therefore the name that wins.**
 * `scripts/nudge.ts` and `scripts/capture-delete.ts` both resolve their spool as
 * `process.env.EST_SPOOL_DIR ?? join(DATA_ROOT, "spool")`; if this reader honoured only
 * its own `EST_SPOOL`, setting either variable alone would give the writers and the
 * reader two different directories — hooks appending to a spool no sweep ever drains,
 * which loses exactly the delete-capture records P1.11 exists to preserve, silently and
 * with a passing test suite on both sides. Both names are accepted so neither half can
 * be configured out from under the other; `spoolDirFrom` is exported so the agreement
 * is testable rather than assumed.
 */
export function spoolDirFrom(env: Record<string, string | undefined>, root: string = DATA_ROOT): string {
  const explicit = env.EST_SPOOL_DIR ?? env.EST_SPOOL;
  return explicit !== undefined && explicit !== "" ? explicit : join(root, "spool");
}

export const SPOOL_DIR: string = spoolDirFrom(process.env);

export const COMPLIANCE_FILE = "compliance.jsonl";
export const TASK_EVENTS_FILE = "task-events.jsonl";
/**
 * HOOK-BINDING-SPEC.md (v21): spawn-time attribution bindings, one JSONL line per
 * `PostToolUse(Agent|Workflow)` fire in the PARENT session (`scripts/nudge.ts` job 0).
 * Same crash-safety contract as the two files above — `O_APPEND` under `PIPE_BUF`,
 * claimed by rename, drained inside the sweep's own transaction, never written to by
 * a hook holding the writer lock.
 *
 * **`task_alias.source = 'hook'`, the only new value of an existing, unchecked column**
 * (`schema.sql:86` — `source TEXT NOT NULL DEFAULT 'sweeper'`, no CHECK; the comment
 * beside it is inside a `CREATE TABLE` body and is therefore NOT edited here — doing so
 * would be a schema change under `test/schema.test.ts`'s byte-identity assertion, §8.2).
 * `'hook'` means: *the parent session, at the instant of the spawn, had exactly one
 * thing this delegation could belong to (evaluated against the set that was open and
 * live at that instant), or was explicitly told which one by a human pointer, or
 * inherited it from a parent agent that already carried an exact-grade alias.* Evidence
 * of the same grade as a human `est bind`, gathered without a human — and the only grade
 * this hook is permitted to write, because `ambiguous` attribution is NOT excluded from
 * the calibration corpus (see the note beside `src/attribute.ts:527`), so a guess-grade
 * alias would be silent, durable corpus poison rather than a labelled guess.
 *
 * **New `anomaly.kind` values** this drain and `src/attribute.ts` can write are
 * documented in full in `src/ingest.ts`'s `IngestAnomaly` union (the writer's parameter
 * type) rather than repeated here; the short version: every kind below `BENIGN` in
 * `src/cli.ts`'s `BENIGN_ANOMALY_KINDS` describes a WITNESS or a STAND-DOWN (no alias
 * written, or deferred to a more authoritative source), never a wrong write. Only
 * `hook_bind_conflict` and `alias_split_identity` are ALERTING — either being nonzero
 * means one identity is claimed by two different tids through two different
 * mechanisms, which the design's whole safety story says should never happen.
 */
export const AGENT_BINDS_FILE = "agent-binds.jsonl";
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
 * HOOK-BINDING-SPEC.md §3.2a: `est focus`'s session-scoped pointer, one file per
 * session — `.focus.<sanitizeForFilename(session_id)>`. Declared here for the same
 * reason every marker above is: `pruneMarkers` has to recognise the name so a marker
 * for a session that never comes back cannot leak forever. The REAPER's ceiling
 * ({@link FOCUS_MARKER_TTL_MS}, 7 days) is deliberately much longer than the
 * BELIEVABILITY window (`hook_focus_ttl_min`, default 120 — see the ladder in
 * `scripts/nudge.ts`): a marker can sit on disk, unbelieved, for a week before this
 * pruner ever touches it. The two are different questions — "may this file still be
 * read" vs "may what it says still be trusted" — and conflating them was rev 1's bug.
 */
export const FOCUS_MARKER_PREFIX = ".focus.";
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
 * directory. `src/autoclose.ts` writes and stats it; it re-exports this prefix and
 * {@link closePassMarkerFile} rather than declaring a second copy.
 *
 * **Per DATABASE, not per directory** — the suffix is what makes that true, and it is
 * the one place this marker differs from `.microsweep` and `.board`. One file per
 * session would be the fan-out the throttle exists to collapse (every hook fire spawns
 * the SAME `est sweep`), but one file per DIRECTORY is worse in the other direction:
 * `EST_SPOOL_DIR` is per-installation, so a live `estimator.db` and a `copy.db` someone
 * is poking at share a spool, and sweeping the copy would silence the live database's
 * close pass for the whole window — leaving real tasks open with nothing saying why.
 * `.board` gets away with a bare name only because `runSweep` hands it a db-relative
 * directory computed WITHOUT the environment; this marker carries its identity in the
 * filename so it is correct no matter which directory it lands in.
 */
export const CLOSE_PASS_MARKER = ".closepass";

/**
 * The marker filename (not path) for one database: `.closepass.<8 hex of the db path>`.
 *
 * A hash rather than the path itself because a path is not a filename — it has
 * separators, it is long, and two of them can differ only past `NAME_MAX`.
 * `Bun.hash` is not cryptographic and does not need to be: the only property required
 * is that two DIFFERENT databases get different names, and a 32-bit prefix over the
 * handful of database files that ever coexist on one machine is far past sufficient.
 * The input is the caller's already-resolved path, so a caller that wants two spellings
 * of one file to agree must resolve it (`runSweep` uses `db.filename`, which SQLite
 * itself canonicalises).
 */
export function closePassMarkerFile(dbPath: string): string {
  const h = (BigInt(Bun.hash(dbPath)) & 0xffffffffn).toString(16).padStart(8, "0");
  return `${CLOSE_PASS_MARKER}.${h}`;
}

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

/**
 * One `PostToolUse(Agent|Workflow)` spawn-time resolution (HOOK-BINDING-SPEC.md §4).
 * `v: 2` names the line format so a future revision can tell old lines apart without
 * guessing from field presence.
 *
 * `local_id` is nullable: rung 9's `no_identity` witness (`tool_response` absent or an
 * unrecognised shape) has no spawned identity to name. `wf_launch_id` is populated only
 * for `kind: "workflow_run"`, recorded for audit and the drain report but written
 * nowhere in v1 (§6.1, §8.3 phase 2). `parent_agent` is populated only for
 * `basis: "nested"` (§7.1) — the id of the sidechain agent THIS process is, whose own
 * alias the drain resolves the child against.
 */
export type SpawnBindKind = "agent" | "workflow_run";

/**
 * The resolution ladder's rung (§3.3), recorded so the drain and `est sweep --json`
 * can build the `binds_basis` histogram — the first measurement this project has ever
 * had for "how often is the active set genuinely ambiguous at the instant of a spawn"
 * (§7.3). `"parent_agent"` is not a ladder rung — it is the basis a nested record's
 * alias is written under, AFTER the drain resolves rung 0 against the parent's own
 * alias (§4.1 step 5, §3.3 rung 0's `basis` column).
 */
export type SpawnBindBasis =
  | "marker"
  | "focus"
  | "focus_quiet"
  | "focus_disagrees"
  | "sole_active"
  | "multi_active"
  | "no_active"
  | "no_bound"
  | "db_unavailable"
  | "no_identity"
  | "nested"
  | "parent_agent";

export interface SpawnBindRecord {
  ts: string;
  v: 2;
  src: "posttooluse";
  /** `payload.session_id` — the canonical session for a hook-written alias (§6.1),
   *  always, including for a workflow run whose OWN state lives under a different one. */
  sid: string;
  /** The harness's own per-call id — the dedup key (§7.2 layer 1). */
  tuid: string;
  tool: "Agent" | "Workflow";
  /** `t_spawn`, ISO (§3.1) — `now - (duration_ms ?? totalDurationMs ?? 0)`. */
  spawn_at: string;
  kind: SpawnBindKind;
  /** The SPAWNED identity's own id (`agentId` or `runId`) — null only for `no_identity`. */
  local_id: string | null;
  wf_launch_id: string | null;
  /** `payload.agent_id` when non-null (§7.1) — null for every non-nested record. */
  parent_agent: string | null;
  /** Nested-resolution attempt counter (§4.1 step 5): 0 at first write, incremented
   *  each time the drain re-appends an unresolved nested record; capped at 3 retries. */
  att: number;
  tid: string | null;
  basis: SpawnBindBasis;
  /** Active / bound candidate counts at resolution time — diagnostic only. */
  na?: number;
  nb?: number;
  /** Top-level payload key NAMES only, never values (§4, §9.1 privacy rule). */
  k?: string[];
  agent_type?: string;
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

const SPAWN_BIND_BASES: ReadonlySet<string> = new Set([
  "marker",
  "focus",
  "focus_quiet",
  "focus_disagrees",
  "sole_active",
  "multi_active",
  "no_active",
  "no_bound",
  "db_unavailable",
  "no_identity",
  "nested",
  "parent_agent",
]);

export function parseSpawnBindLines(text: string): SpoolRead<SpawnBindRecord> {
  const { values, malformed, truncatedTail } = parseLines(text);
  const rows: SpawnBindRecord[] = [];
  let bad = malformed;
  for (const v of values) {
    if (v === null || typeof v !== "object") {
      bad += 1;
      continue;
    }
    const o = v as Record<string, unknown>;
    const ts = str(o.ts);
    const sid = str(o.sid);
    const tuid = str(o.tuid);
    const tool = o.tool === "Agent" || o.tool === "Workflow" ? o.tool : null;
    const spawnAt = str(o.spawn_at);
    const kind = o.kind === "agent" || o.kind === "workflow_run" ? o.kind : null;
    const basis = typeof o.basis === "string" && SPAWN_BIND_BASES.has(o.basis) ? (o.basis as SpawnBindBasis) : null;
    if (ts === null || sid === null || tuid === null || tool === null || spawnAt === null || kind === null || basis === null) {
      bad += 1;
      continue;
    }
    const att = typeof o.att === "number" && Number.isFinite(o.att) ? Math.max(0, Math.trunc(o.att)) : 0;
    rows.push({
      ts,
      v: 2,
      src: "posttooluse",
      sid,
      tuid,
      tool,
      spawn_at: spawnAt,
      kind,
      local_id: str(o.local_id),
      wf_launch_id: str(o.wf_launch_id),
      parent_agent: str(o.parent_agent),
      att,
      tid: str(o.tid),
      basis,
      na: typeof o.na === "number" ? o.na : undefined,
      nb: typeof o.nb === "number" ? o.nb : undefined,
      k: Array.isArray(o.k) && o.k.every((x) => typeof x === "string") ? (o.k as string[]) : undefined,
      agent_type: str(o.agent_type) ?? undefined,
    });
  }
  return { rows, malformed: bad, truncatedTail };
}

/**
 * Serialize one {@link SpawnBindRecord}, honoring the hard 512-byte `PIPE_BUF` budget
 * (§4): if the full line exceeds 511 bytes, drop `k`, then `basis`/`na`/`nb`,
 * re-serializing after each drop; if it is STILL over, return null (write nothing —
 * fail open, same discipline as every other hot-path failure in this file). In
 * practice this only bites on an unusually long `local_id`/`tid`, since every other
 * field is bounded by construction.
 */
export function serializeSpawnBindLine(rec: SpawnBindRecord): string | null {
  // A plain mutable bag rather than the typed record past this point: the assembly
  // rule (§4) drops fields the TYPE otherwise requires (`basis`), so the budget
  // fallback is deliberately untyped — it only ever runs on the pathological case of
  // an unusually long id, and the drain's parser (`parseSpawnBindLines`) tolerates a
  // missing `basis` by falling back through `str()`/the `SPAWN_BIND_BASES` guard.
  const full: Record<string, unknown> = { ...rec };
  const attempts: Array<() => void> = [
    () => {}, // attempt 0: the full record, as given
    () => {
      delete full.k;
    },
    () => {
      delete full.basis;
      delete full.na;
      delete full.nb;
    },
  ];
  for (const drop of attempts) {
    drop();
    const line = JSON.stringify(full);
    if (Buffer.byteLength(line) <= 511) return line;
  }
  return null;
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
  /** HOOK-BINDING-SPEC.md §4.1 step 6: the agent-binds drain's own report. */
  binds: SpawnBindDrainResult;
  anomalies: IngestAnomaly[];
  /**
   * Delete the claimed `.draining` files. **Call this only AFTER the surrounding
   * transaction commits.** Deleting inside the transaction would lose every spooled
   * record if the commit then failed — which is the one failure mode the
   * delete-capture hook exists to survive.
   */
  cleanup: () => void;
}

/**
 * HOOK-BINDING-SPEC.md §4.1 step 6. Field names match the spec's `binds_*` naming
 * exactly (minus the `binds_` prefix, which `report.spool` in `src/cli.ts` restores —
 * the same relationship `task_events`/`compliance` above already have to their
 * `report.spool.task_events_*` / `compliance_*` fields).
 *
 *   - `bound`           non-nested aliases newly written this drain (rungs 1/2/3/5).
 *   - `nested_bound`    nested (`basis:"nested"`) records resolved against a parent's
 *                       alias and written this drain (§4.1 step 5).
 *   - `nested_deferred` nested records that found no parent alias yet and were
 *                       re-appended to the LIVE spool with `att+1` for a later sweep.
 *   - `conflict`        `hook_bind_conflict` (ALERTING) — a different mechanism
 *                       already owns the identity under a different tid.
 *   - `superseded`      `hook_bind_superseded` (BENIGN) — a different hook alias
 *                       already owns the identity; first writer keeps it.
 *   - `deferred_human`  `hook_bind_deferred_to_human` (BENIGN) — an `est_bind` row
 *                       already owns the identity; the hook stood down.
 *   - `unbound`         `hook_bind_orphan_tid` (BENIGN) — the named tid no longer
 *                       has a `task` row by the time the drain ran.
 *   - `dup`             the identity already carries this SAME (id_kind, tid) pair —
 *                       `already_bound`, an idempotent no-op, no anomaly.
 *   - `dropped`         `tuid` groups dropped for disagreeing on `tid` within one
 *                       batch (`hook_bind_conflict`, counted once per group here, not
 *                       once per record) plus unparseable lines.
 *   - `basis`           `{basis: count}` over EVERY surviving record (witnesses and
 *                       binds alike) — the §9 denominator for "how often is the
 *                       active set genuinely ambiguous at the instant of a spawn".
 */
export interface SpawnBindDrainResult {
  read: number;
  bound: number;
  nested_bound: number;
  nested_deferred: number;
  conflict: number;
  superseded: number;
  deferred_human: number;
  unbound: number;
  dup: number;
  dropped: number;
  basis: Record<string, number>;
}

function emptySpawnBindDrain(): SpawnBindDrainResult {
  return {
    read: 0,
    bound: 0,
    nested_bound: 0,
    nested_deferred: 0,
    conflict: 0,
    superseded: 0,
    deferred_human: 0,
    unbound: 0,
    dup: 0,
    dropped: 0,
    basis: {},
  };
}

export function emptyDrain(): DrainResult {
  return {
    task_events: { read: 0, inserted: 0, malformed: 0, truncated: 0 },
    compliance: { read: 0, nudged: 0, unbound: 0, db_unavailable: 0, malformed: 0, truncated: 0 },
    markers_pruned: 0,
    binds: emptySpawnBindDrain(),
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
      // HOOK-BINDING-SPEC.md §4.2 / §10 step 1a: a read failure here must NOT report
      // `claimed: draining`. The caller's `cleanup()` unconditionally `rmSync`s every
      // path in `claimed`, so returning the path here would delete a `.draining` file
      // this call never actually read — a genuine data-loss path, pre-existing and
      // shared by `compliance.jsonl` and `task-events.jsonl`. Returning `claimed: null`
      // leaves the file exactly where the recovery branch above finds it next sweep.
      return { text: "", claimed: null };
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
    // Same reasoning as the recovery-branch catch above: the rename succeeded (the
    // live file is already gone) but the read did not, so the caller must not delete
    // it. `claimed: null` means this drain's `cleanup()` will not touch it, and the
    // next sweep's recovery branch (the `existsSync(draining)` arm above) picks it up.
    return { text: "", claimed: null };
  }
}

/** The 4 MiB per-sweep cap on the agent-binds batch (§4.2), independent of the
 *  `hook_bind_batch_max` record-count cap — whichever bound is hit first wins. */
const BIND_BATCH_MAX_BYTES = 4 * 1024 * 1024;

/** One row's outcome against the identity-wide owner pre-check (§4.1 step 3). */
type BindOutcome =
  | "bound"
  | "dup"
  | "deferred_human"
  | "superseded"
  | "conflict"
  | "split_identity";

/**
 * Apply {@link UPSERT_ALIAS_SQL} for one `source='hook'` alias, after the
 * IDENTITY-WIDE owner pre-check (§4.1 step 3) — no `session_id` filter, unlike
 * `bindTask`'s own session-scoped check, because `ux_alias_exclusive` is
 * session-scoped (`schema.sql:104-105`) and a query that were not identity-wide would
 * make `hook_bind_conflict` blind to exactly the case it exists to catch (§5.2).
 *
 * Never throws on a `ux_alias_exclusive` violation: every branch below either writes
 * an INSERT the pre-check has already proven cannot conflict, or skips the INSERT
 * entirely. A throw here would roll back the whole drain transaction (§4.1 step 3).
 */
function bindAliasWithOwnerCheck(
  db: Database,
  args: { tid: string; idKind: "agent" | "workflow_run"; sessionId: string; localId: string; ts: string },
): BindOutcome {
  const rows = db
    .query<{ tid: string; session_id: string; source: string }, [string, string]>(
      "SELECT tid, session_id, source FROM task_alias WHERE id_kind = ? AND local_id = ?",
    )
    .all(args.idKind, args.localId);

  if (rows.length > 1) return "split_identity";

  if (rows.length === 1) {
    const existing = rows[0]!;
    if (existing.tid === args.tid) return "dup"; // already_bound, idempotent no-op
    if (existing.source === "est_bind") return "deferred_human";
    if (existing.source === "hook") return "superseded";
    return "conflict";
  }

  db.query(UPSERT_ALIAS_SQL).run({
    $tid: args.tid,
    $id_kind: args.idKind,
    $session_id: args.sessionId,
    $local_id: args.localId,
    $first_seen: args.ts,
    $source: "hook",
  } as never);
  return "bound";
}

/**
 * The agent-binds drain (HOOK-BINDING-SPEC.md §4.1). Call INSIDE the sweep's write
 * transaction, before `attributeTasks` — same discipline as `drainSpool`'s other two
 * files, and required here too: a bind written after attribution has already run for
 * this pass is picked up on the NEXT pass, not this one (§4).
 *
 * Returns the report plus TWO deferred side effects the caller must apply AFTER the
 * transaction commits, exactly like `DrainResult.cleanup`: `claimed` (the `.draining`
 * path to delete) and `reappend` (raw JSONL lines — the batch-bound overflow and any
 * nested records still waiting on their parent's alias — to append back to the LIVE
 * file). Both are deferred for the same reason `cleanup()` is: acting on either
 * inside the transaction would lose records if the commit then failed.
 */
function drainAgentBinds(
  db: Database,
  dir: string,
  now: Date,
): { binds: SpawnBindDrainResult; anomalies: IngestAnomaly[]; claimed: string | null; reappend: string[] } {
  const out = emptySpawnBindDrain();
  const anomalies: IngestAnomaly[] = [];
  const reappend: string[] = [];

  const claimedFile = claim(dir, AGENT_BINDS_FILE);
  if (claimedFile.text === "") {
    return { binds: out, anomalies, claimed: claimedFile.claimed, reappend };
  }

  const batchMaxRaw = Number.parseInt(getConfig(db, "hook_bind_batch_max") ?? "5000", 10);
  const batchMax = Number.isFinite(batchMaxRaw) && batchMaxRaw > 0 ? batchMaxRaw : 5000;

  // Physical lines, oldest first (append order == file order), so the batch bound and
  // the byte cap operate on the same units re-appended to the live file verbatim — a
  // line this pass never even parsed must survive unchanged for the next one.
  const rawLines = (claimedFile.text.endsWith("\n") ? claimedFile.text.slice(0, -1) : claimedFile.text)
    .split("\n")
    .filter((l) => l.trim() !== "");

  let takenBytes = 0;
  let takeCount = 0;
  for (; takeCount < rawLines.length && takeCount < batchMax; takeCount += 1) {
    const bytes = Buffer.byteLength(rawLines[takeCount]!) + 1;
    if (takeCount > 0 && takenBytes + bytes > BIND_BATCH_MAX_BYTES) break;
    takenBytes += bytes;
  }
  const thisBatchText = rawLines.slice(0, takeCount).join("\n") + (takeCount > 0 ? "\n" : "");
  for (const line of rawLines.slice(takeCount)) reappend.push(line);

  const parsed = parseSpawnBindLines(thisBatchText);
  out.read = parsed.rows.length;
  if (parsed.malformed > 0) {
    out.dropped += parsed.malformed;
    anomalies.push({
      kind: "malformed_line",
      detail: `${parsed.malformed} unparseable line(s) in ${AGENT_BINDS_FILE}`,
    });
  }

  // --- §4.1 step 2 / §7.2 layer 1: group by tuid, resolve within-batch disagreement ---
  const groups = new Map<string, SpawnBindRecord[]>();
  for (const r of parsed.rows) {
    const g = groups.get(r.tuid);
    if (g !== undefined) g.push(r);
    else groups.set(r.tuid, [r]);
  }

  const earliest = (a: SpawnBindRecord, b: SpawnBindRecord): SpawnBindRecord => (a.ts <= b.ts ? a : b);
  const survivors: SpawnBindRecord[] = [];
  for (const recs of groups.values()) {
    const withTid = recs.filter((r) => r.tid !== null);
    if (new Set(withTid.map((r) => r.tid)).size > 1) {
      out.dropped += 1;
      anomalies.push({
        kind: "hook_bind_conflict",
        detail: "hook drain: one tool_use_id resolved to more than one tid within a single batch",
      });
      continue;
    }
    survivors.push(withTid.length > 0 ? withTid.reduce(earliest) : recs.reduce(earliest));
  }

  const ts = now.toISOString();

  for (const r of survivors) {
    out.basis[r.basis] = (out.basis[r.basis] ?? 0) + 1;

    // --- §4.1 step 5: nested resolution, against THIS BATCH's own aliases too ---
    if (r.basis === "nested") {
      if (r.parent_agent === null || r.local_id === null) {
        out.dropped += 1; // malformed nested record — should not happen, guarded anyway
        continue;
      }
      const parentRows = db
        .query<{ tid: string }, [string]>(
          "SELECT DISTINCT tid FROM task_alias WHERE id_kind = 'agent' AND local_id = ? ORDER BY tid",
        )
        .all(r.parent_agent);
      if (parentRows.length >= 1) {
        // A parent with more than one tid (split identity) is the PARENT's problem,
        // already surfaced by `alias_split_identity` when ITS alias was written; the
        // deterministic lowest-tid choice here mirrors `src/attribute.ts`'s own
        // tie-break so the child never disagrees with how the parent itself resolves.
        const outcome = bindAliasWithOwnerCheck(db, {
          tid: parentRows[0]!.tid,
          idKind: r.kind,
          sessionId: r.sid,
          localId: r.local_id,
          ts,
        });
        applyBindOutcome(outcome, out, anomalies);
        if (outcome === "bound") out.nested_bound += 1;
      } else if (r.att < 3) {
        out.nested_deferred += 1;
        const line = serializeSpawnBindLine({ ...r, att: r.att + 1 });
        if (line !== null) reappend.push(line); // fail open: budget overflow just drops it
      } else {
        anomalies.push({
          kind: "hook_spawn_depth_unbound",
          detail: "hook drain: a nested spawn's parent agent still has no bound alias after 3 deferrals",
        });
      }
      continue;
    }

    // --- witnesses: tid === null, no alias, §3.3 rungs 4/6/7/8/9 ---
    if (r.tid === null) {
      if (r.basis === "multi_active") {
        anomalies.push({
          kind: "hook_bind_multi_active",
          detail: "hook: more than one task was active in this session at the instant of a spawn; no alias written",
        });
      } else if (r.basis === "no_active") {
        anomalies.push({
          kind: "hook_bind_no_active",
          detail: "hook: every task bound to this session had gone quiet at the instant of a spawn; no alias written",
        });
      } else if (r.basis === "focus_disagrees") {
        anomalies.push({
          kind: "hook_focus_disagrees",
          detail: "hook: est focus named a quiet task while a different task was active; no alias written",
        });
      }
      // `no_bound`: no anomaly — `missed_estimate` already reports it (§3.3 rung 8).
      // `db_unavailable` / `no_identity`: never an anomaly (§3.3 rung 9, §7.4).
      continue;
    }

    // --- §4.1 step 3: a direct bind ---
    if (r.local_id === null) {
      out.dropped += 1; // tid set but no identity — malformed, should not happen
      continue;
    }
    const task = db.query<{ n: number }, [string]>("SELECT 1 AS n FROM task WHERE tid = ?").get(r.tid);
    if (task === null || task === undefined) {
      out.unbound += 1;
      anomalies.push({
        kind: "hook_bind_orphan_tid",
        detail: "hook drain: a spawn's bound tid no longer has a task row",
      });
      continue;
    }
    const outcome = bindAliasWithOwnerCheck(db, {
      tid: r.tid,
      idKind: r.kind,
      sessionId: r.sid,
      localId: r.local_id,
      ts,
    });
    applyBindOutcome(outcome, out, anomalies);
    if (outcome === "bound") out.bound += 1;
  }

  return { binds: out, anomalies, claimed: claimedFile.claimed, reappend };
}

function applyBindOutcome(outcome: BindOutcome, out: SpawnBindDrainResult, anomalies: IngestAnomaly[]): void {
  switch (outcome) {
    case "bound":
    case "dup":
      if (outcome === "dup") out.dup += 1;
      return;
    case "deferred_human":
      out.deferred_human += 1;
      anomalies.push({
        kind: "hook_bind_deferred_to_human",
        detail: "hook drain: an est_bind row already owns this identity (identity-wide check); the hook stood down",
      });
      return;
    case "superseded":
      out.superseded += 1;
      anomalies.push({
        kind: "hook_bind_superseded",
        detail: "hook drain: a different hook-written alias already owns this identity (cross-drain ladder drift); first writer keeps it",
      });
      return;
    case "conflict":
      out.conflict += 1;
      anomalies.push({
        kind: "hook_bind_conflict",
        detail: "hook drain: this identity is already owned by a different tid through a non-hook, non-est_bind mechanism (identity-wide check)",
      });
      return;
    case "split_identity":
      out.dropped += 1;
      anomalies.push({
        kind: "alias_split_identity",
        detail: "hook drain: one (id_kind, local_id) identity holds rows under more than one session_id (identity-wide check)",
      });
      return;
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
  let bindsReappend: string[] = [];
  result.cleanup = (): void => {
    for (const p of claimed) rmSync(p, { force: true });
    // HOOK-BINDING-SPEC.md §4.1 step 5 / §4.2: batch overflow and deferred nested
    // records go back onto the LIVE file, and only AFTER the `.draining` copies are
    // gone — otherwise a crash between the two could leave one copy in each and the
    // next drain would process it twice (harmless, since binding is idempotent, but
    // needless). A single append, same O_APPEND discipline the hook itself uses.
    if (bindsReappend.length > 0) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, AGENT_BINDS_FILE), `${bindsReappend.join("\n")}\n`, { flag: "a" });
      } catch {
        // A lost re-append degrades to turn inference for those spawns — the same
        // fallback every other failure in this design has.
      }
    }
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

  const binds = drainAgentBinds(db, dir, new Date());
  if (binds.claimed !== null) claimed.push(binds.claimed);
  bindsReappend = binds.reappend;
  result.binds = binds.binds;
  result.anomalies.push(...binds.anomalies);

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
 * A `.closepass.<db>` marker is re-stamped by every close pass that actually ran, so one
 * older than this belongs to a database nobody has swept in a day — most often a
 * throwaway copy whose marker would otherwise sit in the spool forever, since the name
 * carries a hash nothing else will ever reuse. Reaping it costs exactly one un-throttled
 * candidate query on the next sweep of that database, which is the cheapest possible way
 * to be wrong.
 *
 * NOTE ON WHO REAPS IT: `pruneMarkers` runs against the sweep's HOOK spool
 * (`drainSpool`), while `runSweep` writes this marker into the per-database directory
 * `<dirname(db.filename)>/spool`. In production those are the same directory and the
 * marker is reaped normally; where `EST_SPOOL_DIR` points elsewhere they diverge, and a
 * stale marker for an abandoned database is then left behind. That is stated rather than
 * papered over: it is one ~10-byte file per database that stopped being swept, and
 * teaching the pruner to walk a second directory would give it two owners.
 */
export const CLOSE_PASS_MARKER_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The REAPER's ceiling for a `.focus.<sid>` marker (§3.2a) — a filesystem-hygiene
 * bound, not the believability window. A marker this old is almost certainly a
 * finished or abandoned session's leftover; `est close` reclaims it far sooner in the
 * ordinary case, so 7 days is a backstop for a session that never closed at all.
 */
export const FOCUS_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    } else if (name === CLOSE_PASS_MARKER || name.startsWith(`${CLOSE_PASS_MARKER}.`)) {
      // Same contract as `.board` above: the pruner learns the name so the marker cannot
      // leak. The `.` form is the per-database suffix (`closePassMarkerFile`); the bare
      // form is a pre-suffix leftover. No `.tmp.` sibling — only the mtime is ever read,
      // so the writer is a plain `writeFileSync` and there is no staging file to reap.
      ttl = CLOSE_PASS_MARKER_TTL_MS;
    } else if (name.startsWith(FOCUS_MARKER_PREFIX)) {
      // Covers both `.focus.<sid>` itself and `.focus.<sid>.tmp.<pid>` — the atomic
      // write's staging file, left behind only by a crash between the write and the
      // rename, same reasoning as `.board`'s own `.tmp.` arm above.
      ttl = FOCUS_MARKER_TTL_MS;
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

/** Who wrote a focus marker — carried for audit, never branched on by a reader. */
export type FocusMarkerWriter = "est_open" | "est_focus" | "est_bind";

export interface FocusMarker {
  tid: string;
  ts: string;
  by: FocusMarkerWriter;
}

/** Marker filename (not path) for `est focus`'s session-scoped pointer (§3.2a). */
export function focusMarkerFile(sessionId: string): string {
  return `${FOCUS_MARKER_PREFIX}${sanitizeForFilename(sessionId)}`;
}

/**
 * Write (or overwrite) the focus marker for `sessionId`, atomically: `<name>.tmp.<pid>`
 * then `renameSync` (§3.2a), so two processes writing one resumed session's marker
 * cannot interleave a half-written file — last writer wins, which is the intent.
 * Never throws: a lost focus write degrades to the ladder's later rungs, exactly like
 * every other best-effort marker in this file.
 */
export function writeFocusMarker(
  sessionId: string,
  tid: string,
  by: FocusMarkerWriter,
  dir: string = SPOOL_DIR,
  now: Date = new Date(),
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, focusMarkerFile(sessionId));
    const tmp = `${path}.tmp.${process.pid}`;
    const marker: FocusMarker = { tid, ts: now.toISOString(), by };
    writeFileSync(tmp, JSON.stringify(marker));
    renameSync(tmp, path);
  } catch {
    // Best-effort, like every other marker write in this file.
  }
}

/**
 * Read `sessionId`'s focus marker, or null when there is none / it is unreadable /
 * malformed. Returns the marker AS WRITTEN — the ladder (`scripts/nudge.ts`) is the
 * one place that decides whether it is still believable (§3.2a's idle-based TTL); this
 * function makes no freshness judgement of its own.
 */
export function readFocusMarker(sessionId: string, dir: string = SPOOL_DIR): FocusMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, focusMarkerFile(sessionId)), "utf8")) as Record<
      string,
      unknown
    >;
    const tid = str(parsed.tid);
    const ts = str(parsed.ts);
    const by = parsed.by;
    if (tid === null || ts === null || (by !== "est_open" && by !== "est_focus" && by !== "est_bind")) {
      return null;
    }
    return { tid, ts, by };
  } catch {
    return null;
  }
}

/**
 * Disarm the focus marker for `sessionId`. Called by `est close` for the tid it
 * closed — exactly the `clearOverrunMarker` discipline above — so a marker naming a
 * now-finalized task cannot go on granting `exclusive`-grade bindings, and a reopen
 * does not inherit a stale pointer. Only clears when the marker actually names `tid`:
 * a session can host several tasks (schema v6), and closing one must not blow away a
 * DIFFERENT task's live focus.
 */
export function clearFocusMarker(sessionId: string, tid: string, dir: string = SPOOL_DIR): void {
  try {
    const current = readFocusMarker(sessionId, dir);
    if (current !== null && current.tid === tid) {
      rmSync(join(dir, focusMarkerFile(sessionId)), { force: true });
    }
  } catch {
    // Never fail a close over a marker file.
  }
}

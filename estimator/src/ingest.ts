/**
 * Transcript ingest — token-estimation-design-r3.md §5.2, §5.3, §5.6, §4.6.
 *
 * Turns JSONL transcripts into `request`, `turn`, `agent_run`, `workflow_run` and
 * `workflow_phase` rows. Two rules carry the whole reliability story:
 *
 *  1. **MAX per (request_id, counter), as an upsert.** Usage lines are *cumulative
 *     streaming snapshots*: the same requestId appears many times with the same
 *     message id and a growing `output_tokens` (verified on this machine — one
 *     agent emits 36 assistant lines across a handful of requestIds). Taking the
 *     first or any line undercounts sub-agent output by 88% corpus-wide, up to
 *     690x per agent [A][B][CA][CB], and [FS] agrees. Upsert-with-MAX is also what
 *     kills the watermark trap: a partial read of a live file can only ever
 *     under-report, and the next sweep raises it — **provided the next sweep
 *     actually re-reads the file**. It only does when the watermark stayed
 *     behind the bytes that were parsed, which is why `readJsonl` reports
 *     `complete` and `IngestBatch.incompleteFiles` vetoes the `sweep_state`
 *     write for any file whose read aborted (a torn tail is fine — the file
 *     grows, so the byte check re-opens it; a read ERROR is not).
 *
 *  2. **Never crash on bad input.** A transcript being appended to right now has a
 *     torn final line; a killed process leaves one mid-object. Those are counted
 *     and reported (`anomaly`), never thrown and never silently dropped (§2 loud
 *     failures).
 *
 * Batch-first per Craig's doctrine: parsing produces buffered row arrays and the
 * write helpers are prepared-statement loops meant to run inside ONE transaction
 * per sweep, not one per file [CA]. Nothing here opens a transaction itself — the
 * sweeper owns that, because a sweep is one atomic snapshot.
 *
 * Zero npm dependencies: bun:sqlite + node:fs only.
 */

import type { Database } from "bun:sqlite";
import {
  sessionIdFromPath,
  type AgentTranscript,
  type AnomalyKind,
  type Corpus,
  type DiscoveryAnomaly,
  type SessionCorpus,
  type WorkflowPlanPhase,
  type WorkflowState,
} from "./discover.ts";
import { priceFamily } from "./prices.ts";
import {
  TurnSegmenter,
  UPSERT_TURN_SQL,
  type CompactionEvent,
  type TranscriptLine,
  type TurnRow,
} from "./segment.ts";

// ---------------------------------------------------------------------------
// row shapes
// ---------------------------------------------------------------------------

export type Origin = "main" | "subagent" | "auxiliary";
export type IntervalSrc = "workflow_progress" | "transcript" | "none";
export type PhaseConf = "exact" | "inferred" | "unmapped";

/** One `request` row — the atomic fact (§4.2). */
export interface RequestRow {
  request_id: string;
  message_id: string | null;
  is_sidechain: number;
  session_id: string;
  prompt_id: string | null;
  origin: Origin;
  agent_id: string | null;
  run_id: string | null;
  wf_launch_id: string | null;
  model: string;
  model_family: string;
  attribution_agent: string | null;
  attribution_skill: string | null;
  ts: string;
  in_tok: number;
  out_tok: number;
  cw_tok: number;
  cr_tok: number;
}

export interface AgentRunRow {
  agent_id: string;
  session_id: string;
  run_id: string | null;
  wf_launch_id: string | null;
  agent_type: string | null;
  spawn_depth: number;
  launch_prompt_id: string | null;
  transcript_path: string | null;
  status: string | null;
  label: string | null;
  started_at: string | null;
  ended_at: string | null;
  interval_src: IntervalSrc;
  queued_at: string | null;
  attempt: number | null;
  /** workflowProgress[].tokens — AUDIT ONLY, never summed (§5.6). */
  reported_tokens: number | null;
  phase_idx: number | null;
  phase_title: string | null;
  phase_conf: PhaseConf;
}

export interface WorkflowRunRow {
  run_id: string;
  wf_launch_id: string;
  session_id: string;
  workflow_name: string | null;
  transcript_dir: string | null;
  default_model: string | null;
  launch_prompt_id: string | null;
  n_phases_planned: number | null;
  /** DERIVED from agent intervals — never from wf_*.json (§5.6). */
  started_at: string | null;
  ended_at: string | null;
}

export interface WorkflowPhaseRow {
  run_id: string;
  wf_launch_id: string;
  phase_idx: number;
  title: string;
  detail: string | null;
  model: string | null;
}

/**
 * A `Workflow` tool launch seen in a main transcript (§5.3 join graph).
 *
 * Structural fields only, and only the ones a caller reads. `toolUseResult` also
 * carries `scriptPath` and `status`; neither is kept — `status` is on the §5.6 ban
 * list (it said "killed" while a run was still running), and the authored script is
 * never read by Phase 0.
 */
export interface WorkflowLaunch {
  run_id: string;
  /** `toolUseResult.taskId` — discriminates relaunches sharing one runId. */
  wf_launch_id: string;
  session_id: string;
  prompt_id: string | null;
  ts: string;
  workflow_name: string | null;
  transcript_dir: string | null;
}

/**
 * One `task_event` row (§6.1), from either Task tool the harness writes:
 *
 *   TaskCreate → `toolUseResult.task = {id, subject}`, no `statusChange`
 *   TaskUpdate → `toolUseResult = {taskId, updatedFields, statusChange:{from,to}}`
 *
 * BOTH are needed. §5.4 defines a turn as "touching" a task if it did either, and
 * gates/g-attr.ts measured attribution against exactly that definition — an ingest
 * that kept only `statusChange` cannot reproduce the gate's numbers, because a task
 * created and worked in one turn would have no event at all. `kind` is what tells
 * the two apart once they are rows: a create is reported as `to_status='pending'`
 * (the state TaskCreate leaves a task in), which is otherwise indistinguishable
 * from a transition back to pending.
 */
export interface TaskEventRow {
  session_id: string;
  task_num: string | null;
  ts: string;
  kind: "create" | "status";
  from_status: string | null;
  to_status: string | null;
}

/**
 * A PLANTED `est_tid` (§3.2 step 6) — the link between a harness task number and the
 * logical task, and the row that makes `task_alias(id_kind='session_task')` exist.
 *
 * **It lives in the tool_use INPUT, not in `toolUseResult`.** The ceremony's
 * `EST_PLANT` line is `TaskUpdate({ taskId: "<n>", metadata: { est_tid: "<uuidv7>" } })`,
 * and the harness's tool_result reports only `updatedFields: ["metadata", ...]` — the
 * VALUE never appears on the result side. An ingest that watched `toolUseResult` alone
 * therefore saw every plant as "some metadata changed" and minted nothing, which is why
 * the live corpus held zero `session_task` aliases and the §6.2 completion-signal arm
 * (src/close.ts) could never fire: it looks up `task_event` BY that alias.
 *
 * `TaskCreate` is covered too, and needs the pairing `TaskUpdate` does not: its input
 * carries no task number (the harness assigns one), so a plant on a create is held by
 * `tool_use` id until the matching tool_result names `task.id`.
 */
export interface TaskPlantRow {
  session_id: string;
  /** The harness task number — `task_alias.local_id`, and `task_event.task_num`. */
  task_num: string;
  /** The planted `est_tid`. Written ONLY if a `task` row already carries it. */
  tid: string;
  ts: string;
}

export interface ParseStats {
  lines: number;
  blank: number;
  parsed: number;
  /** JSON.parse failed on a newline-terminated line — a real corruption. */
  malformed: number;
  /** The file's final line had no terminating newline and did not parse: a live
   *  write or a killed process. Skipped, counted, never fatal. 0 or 1. */
  truncatedTail: number;
}

export interface IngestAnomaly {
  kind:
    | "malformed_line"
    | "truncated_tail"
    | "read_error"
    | "sidechain_replay"
    | "rid_collision"
    | "unusable_usage_line"
    | "wf_record_mismatch"
    | "phase_unmapped"
    // §5.6 [R4] promotion condition (ii): the in-flight and never-returned
    // populations are CLASSIFIED, not counted as join failures. All three are
    // benign (src/cli.ts `BENIGN_ANOMALY_KINDS`) — they are what a corpus of
    // relaunched and killed workflow agents LOOKS like, not damage taken by one —
    // and every one of their details is free of a count that moves between sweeps,
    // so `insertAnomalies`' (kind, detail) dedup actually holds.
    | "agent_never_returned"
    | "wf_relaunch_orphan"
    | "wf_relaunch_detected"
    | "orphan_turn_duration"
    // The three duplicate-producing mechanisms G-FORK found on disk (§7 recs 2,4,5).
    | "fork_replay"
    | "symlink_alias"
    | "compaction_continuation"
    // Sweep-level, raised by src/cli.ts once the WHOLE corpus is in hand. They go
    // through the same `insertAnomalies` writer as everything above, so this type
    // has to name them: the LEDGER's vocabulary is open by design (schema.sql
    // keeps `kind` free of a CHECK), but the writer's parameter type is not, and
    // casting them in one by one just moved the vocabulary out of the type.
    | "corpus_shrink"
    | "sweep_budget_exceeded"
    | "unpriced_model"
    // Phase 1, raised by src/spool.ts when the sweep drains the hook spool: a
    // matched `Task`/`Workflow` launch that no open estimate was bound to.
    | "missed_estimate"
    // §3.2 step 6: a planted `est_tid` naming a tid with no `task` row, so no
    // `session_task` alias could be minted. BENIGN (src/cli.ts) — a transcript is
    // untrusted input and refusing the alias is the correct outcome — but reported,
    // because a silent drop looks exactly like the ingest bug this pass fixed.
    | "plant_unlinked"
    // Phase 2 (P2.3/P2.4/P2.6), raised by src/otel.ts and src/recon.ts. Same reason
    // the sweep-level kinds are named above: the ledger's vocabulary is open, the
    // writer's parameter type is not, and casting them in one by one would just move
    // the vocabulary out of the type.
    | "otel_unjoined"
    | "otel_counter_mismatch"
    | "otel_prompt_mismatch"
    | "otel_reject"
    | "otel_receiver_down"
    | "recon_mismatch"
    // P2.5, raised by src/eta.ts when a re-cut RESTATES or REMOVES a terminal
    // `run_segment` row. A closed segment is a corpus observation, so the fitting
    // population moving is a fact the ledger has to carry — the alternative, freezing
    // the row, left the table holding a stale partition and its successor at once.
    | "segment_recut"
    // P2.8, raised by src/promote.ts when a later sweep discovers an EARLIER
    // attributed request than the one `started_at` already recorded (a fork/alias
    // resolving after the fact). Reported, never suppressed: §5.4's monotone-earliest
    // rule means this can fire long after a task looks finished.
    | "promotion_backdated"
    // P2.9, raised by src/jobs.ts: a `~/.claude/jobs/<id>` directory whose
    // `sessionId`/`resumeSessionId` matches zero, or more than one, task_alias-bound
    // tid. The reconcile never invents a binding, so this is the counted complement
    // rather than a guess (§P2.9's "no match -> anomaly, no row").
    | "job_unjoined"
    // P2.7, raised by src/board-render.ts. Never alerting and never counted against
    // `--strict` (BENIGN_ANOMALY_KINDS, src/cli.ts) — the board is a convenience and
    // the sweep is the system; a bad render leaves the previous file intact.
    | "board_render_failed"
    // P2.12, raised by src/audit.ts: `est audit --fix` deleted one untraceable row from
    // a derived/ledger table, and `detail` carries that row verbatim as JSON. Recorded
    // because a cleanup that leaves no trace is the same class of thing as the rows it
    // removes — the ledger has to be able to answer "what did the audit take?".
    | "audit_removed"
    // Discovery-level, passed through unchanged by {@link toIngestAnomalies}.
    | AnomalyKind;
  detail: string;
  path?: string;
}

export interface TranscriptIngest {
  path: string;
  requests: RequestRow[];
  /** First/last line timestamps — the §5.3 transcript-fallback agent interval. */
  firstTs: string | null;
  lastTs: string | null;
  /**
   * Every line `uuid` in the file, in file order — the input to the D3 fork
   * detector ({@link detectForkReplays}). Gathered on the pass the sweeper is
   * already making, which is the whole reason G-FORK could recommend D3: it needs
   * no pairwise file comparison, only one hash pass over data already streaming.
   */
  uuids: string[];
  stats: ParseStats;
  anomalies: IngestAnomaly[];
  /** False when the read aborted before EOF — see {@link readJsonl}. The file's
   *  `sweep_state` watermark must not advance. */
  complete: boolean;
}

export interface MainIngest extends TranscriptIngest {
  sessionId: string;
  turns: TurnRow[];
  launches: WorkflowLaunch[];
  taskEvents: TaskEventRow[];
  /** Planted `est_tid`s — see {@link TaskPlantRow}. */
  taskPlants: TaskPlantRow[];
  /** `toolUseId` -> promptId, for Agent/Task/Workflow launches. Resolves
   *  `agent-<id>.meta.json`'s `toolUseId` to its launching turn (§5.3). */
  toolUsePrompts: Map<string, string>;
  /** `/compact` boundaries — persisted as anomalies; see {@link compactionAnomalies}. */
  compactions: CompactionEvent[];
  /** turn_duration records that preceded every prompt — counted, never dropped. */
  orphanTurnDurations: number;
}

/**
 * One transcript's contribution to the corpus-wide D3 fork index (G-FORK §5, §7
 * rec 2). Deliberately tiny: a path, its owning session, and the two id sets the
 * detector compares. Everything else about the file is already row shaped.
 */
export interface TranscriptIndexEntry {
  path: string;
  sessionId: string;
  uuids: string[];
  requestIds: string[];
}

/** Everything one sweep wants to write, buffered. */
export interface IngestBatch {
  requests: RequestRow[];
  turns: TurnRow[];
  agentRuns: AgentRunRow[];
  workflowRuns: WorkflowRunRow[];
  workflowPhases: WorkflowPhaseRow[];
  taskEvents: TaskEventRow[];
  taskPlants: TaskPlantRow[];
  anomalies: IngestAnomaly[];
  /** Per-file id sets for {@link detectForkReplays}. Not rows — never written. */
  files: TranscriptIndexEntry[];
  stats: ParseStats;
  /**
   * Paths whose read aborted before EOF. The sweeper must NOT write a
   * `sweep_state` row for these: a watermark covering unread bytes freezes the
   * file's remaining contribution out of every future incremental sweep.
   */
  incompleteFiles: string[];
  /**
   * Paths this session enumerated but ANOTHER session owns (see {@link CorpusPlan}),
   * so this session never opened them. Same watermark veto as `incompleteFiles`,
   * for the same reason and a different cause: if the owning session is cut off by
   * the sweep budget, a watermark written by a session that did not read the file
   * makes the next incremental sweep compute "unchanged" and skip it — forever.
   */
  skippedFiles: string[];
}

// ---------------------------------------------------------------------------
// streaming JSONL reader
// ---------------------------------------------------------------------------

const TRAILING_CR = /\r$/;

/**
 * Stream a JSONL file line by line.
 *
 * `onLine(raw, isUnterminatedTail)` may throw — that is how a line reports itself
 * unparseable, and it becomes stats plus an anomaly rather than an exception.
 * `isUnterminatedTail` is true only for a final line with no terminating newline,
 * the exact signature of a live append or a killed writer; consumers that
 * prefilter lines must always attempt a full parse when it is set, or a tail torn
 * before the prefilter's marker would vanish without a trace.
 *
 * `complete` is false when the file could not be read to its end — the stream
 * errored, or it vanished mid-walk. The caller MUST NOT advance a byte watermark
 * for such a file: the watermark would then cover bytes nobody ever parsed, and
 * the next incremental sweep would compute "unchanged" and skip the file forever
 * (see `sweep_state` in src/cli.ts). Upsert-with-MAX makes watermarks pure
 * performance ONLY for bytes that were actually read.
 */
export async function readJsonl(
  path: string,
  onLine: (line: string, isUnterminatedTail: boolean) => void,
): Promise<{ stats: ParseStats; anomalies: IngestAnomaly[]; complete: boolean }> {
  const stats: ParseStats = { lines: 0, blank: 0, parsed: 0, malformed: 0, truncatedTail: 0 };
  const anomalies: IngestAnomaly[] = [];

  const decoder = new TextDecoder();
  let buf = "";

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = Bun.file(path).stream();
  } catch (err) {
    // The stream could not even be OPENED (an unrepresentable path, a permission
    // failure, a file that vanished between discovery and ingest — the §3.4 GC
    // race). Not fatal, and the watermark must not move; but it is exactly as
    // silent as the `read_error` path below unless it says so, and a file that
    // never opens contributes zero rows forever. Same kind, same loudness.
    anomalies.push({
      kind: "read_error",
      detail: `could not be opened for reading: ${(err as Error).message} — 0 lines parsed; watermark NOT advanced, so the next sweep retries this file`,
      path,
    });
    return { stats, anomalies, complete: false };
  }

  /**
   * Hand one line to the consumer. JSON.parse happens inside `onLine`, so a
   * throw from there is what a malformed line looks like from here — caught,
   * counted, and turned into an anomaly rather than an exception.
   */
  const push = (raw: string, isUnterminatedTail: boolean): void => {
    const line = raw.replace(TRAILING_CR, "");
    if (line.length === 0) {
      stats.blank += 1;
      return;
    }
    stats.lines += 1;
    try {
      onLine(line, isUnterminatedTail);
    } catch {
      if (isUnterminatedTail) {
        stats.truncatedTail = 1;
        anomalies.push({
          kind: "truncated_tail",
          detail: `final line (${line.length} bytes) is not valid JSON — the file is being appended to, or its writer died`,
          path,
        });
      } else {
        stats.malformed += 1;
        anomalies.push({
          kind: "malformed_line",
          detail: `line ${stats.lines}: not valid JSON (${line.slice(0, 120)})`,
          path,
        });
      }
    }
  };

  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      // Scan with a moving offset and re-slice the buffer ONCE per chunk. Slicing
      // per line instead is quadratic in chunk size — and chunks here are 64 KB of
      // 4 KB transcript lines, so that costs real seconds over a 669 MB corpus.
      let start = 0;
      let nl = buf.indexOf("\n", start);
      while (nl >= 0) {
        push(buf.slice(start, nl), false);
        start = nl + 1;
        nl = buf.indexOf("\n", start);
      }
      if (start > 0) buf = buf.slice(start);
    }
    buf += decoder.decode();
  } catch (err) {
    // Partial read. The rows gathered so far are kept (upsert-with-MAX can only
    // ever under-report, never over-report), but `complete: false` tells the
    // sweeper the tail was never seen, so the watermark stays where it was.
    anomalies.push({
      kind: "read_error",
      detail: `read aborted after ${stats.lines} lines: ${(err as Error).message} — watermark NOT advanced; the next sweep re-reads this file`,
      path,
    });
    stats.parsed = stats.lines - stats.malformed - stats.truncatedTail;
    return { stats, anomalies, complete: false };
  }

  if (buf.length > 0) push(buf, true); // unterminated tail
  stats.parsed = stats.lines - stats.malformed - stats.truncatedTail;
  return { stats, anomalies, complete: true };
}

// ---------------------------------------------------------------------------
// field extraction
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

/**
 * Collapse a model id to its pricing family — `request.model_family`, the left
 * side of `v_priced`'s INNER JOIN.
 *
 * It delegates to `prices.priceFamily()` ON PURPOSE: the two normalisers used to
 * be written twice and disagreed on the `[...]` suffix, so a bracketed id could
 * never join a price row and 100% of its spend vanished from every USD figure
 * with no residue. One definition, both sides of the join. The suffix is still
 * preserved (`claude-opus-5[1m]` is not `claude-opus-5`); a routing prefix and a
 * trailing `-YYYYMMDD` are still stripped.
 */
export function modelFamily(model: string): string {
  return priceFamily(model);
}

/** Sentinel model on harness-generated lines that never hit the API (§5.2). */
export const SYNTHETIC_MODEL = "<synthetic>";

interface Usage {
  in_tok: number;
  out_tok: number;
  cw_tok: number;
  cr_tok: number;
}

function extractUsage(line: TranscriptLine): Usage | null {
  const message = (line.message ?? null) as Record<string, unknown> | null;
  const raw = (message?.usage ?? line.usage ?? null) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") return null;
  return {
    in_tok: int(raw.input_tokens),
    out_tok: int(raw.output_tokens),
    cw_tok: int(raw.cache_creation_input_tokens),
    cr_tok: int(raw.cache_read_input_tokens),
  };
}

export interface RequestContext {
  origin: Origin;
  sessionId: string;
  /** Turn the request belongs to. For sub-agents this is the LAUNCHING turn's
   *  promptId — a sub-agent inherits its launcher's attribution, never its own
   *  timestamps (§5.3). */
  promptId: string | null;
  agentId?: string | null;
  runId?: string | null;
  wfLaunchId?: string | null;
}

/**
 * Build a `request` row from one transcript line, or null when the line carries
 * no usable usage. Returns a reason string on rejection so the caller can log a
 * loud failure rather than dropping a paid request silently.
 */
export function extractRequest(
  line: TranscriptLine,
  ctx: RequestContext,
): { row: RequestRow } | { row: null; reason: string | null } {
  const usage = extractUsage(line);
  if (usage === null) return { row: null, reason: null }; // not a usage line at all

  const message = (line.message ?? null) as Record<string, unknown> | null;
  const model = str(message?.model);
  if (model === null) return { row: null, reason: "usage line with no message.model" };
  if (model === SYNTHETIC_MODEL) return { row: null, reason: null }; // never billed

  // Fallback chain per schema.sql: requestId, then message.id, then uuid.
  const requestId = str(line.requestId) ?? str(message?.id) ?? str(line.uuid);
  if (requestId === null) {
    return { row: null, reason: "usage line with no requestId, message.id or uuid" };
  }

  const ts = str(line.timestamp);
  if (ts === null) return { row: null, reason: `request ${requestId} has no timestamp` };

  const sessionId = str(line.sessionId) ?? ctx.sessionId;

  // Deterministic regardless of which file the sweeper reads first: a sidechain
  // line replayed into the main transcript is sub-agent spend either way (§4.6).
  const isSidechain = line.isSidechain === true;
  const origin: Origin = isSidechain && ctx.origin === "main" ? "subagent" : ctx.origin;

  return {
    row: {
      request_id: requestId,
      message_id: str(message?.id),
      is_sidechain: isSidechain ? 1 : 0,
      session_id: sessionId,
      prompt_id: ctx.promptId,
      origin,
      agent_id: str(line.agentId) ?? ctx.agentId ?? null,
      run_id: ctx.runId ?? null,
      wf_launch_id: ctx.wfLaunchId ?? null,
      model,
      model_family: modelFamily(model),
      attribution_agent: str(line.attributionAgent),
      attribution_skill: str(line.attributionSkill),
      ts,
      ...usage,
    },
  };
}

// ---------------------------------------------------------------------------
// transcript ingest
// ---------------------------------------------------------------------------

/** Cheap prefilter: only usage-bearing lines are worth a full JSON.parse [B]. */
const USAGE_HINT = '"output_tokens"';
const TS_RE = /"timestamp":"([^"]+)"/;
/** Same trick as TS_RE, for the D3 fork detector's `uuid -> file[]` index. */
const UUID_RE = /"uuid":"([^"]+)"/;

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/**
 * O(1) structural sanity check for a line the usage prefilter is about to skip.
 *
 * Every transcript line is one JSON object, so a line that does not open with `{`
 * and close with `}` is torn — a killed writer, or a usage line cut BEFORE
 * `"output_tokens"`, which the prefilter would otherwise wave through as clean.
 * The prefilter exists because a full JSON.parse of every line of a 669 MB corpus
 * is real seconds, so this is deliberately two char reads, not a parse.
 *
 * Residual, stated rather than hidden: a line severed exactly at a `}` still looks
 * complete here. Detecting that needs the parse the prefilter exists to avoid; the
 * tail case (the common one) is already parsed unconditionally.
 */
function looksLikeWholeObject(line: string): boolean {
  return (
    line.charCodeAt(0) === OPEN_BRACE && line.charCodeAt(line.length - 1) === CLOSE_BRACE
  );
}

/**
 * Ingest a sub-agent transcript (`agent-<id>.jsonl`, Agent-tool or workflow).
 *
 * Only usage lines are parsed; every other line contributes just its timestamp,
 * pulled with a regex, because first/last line timestamps are the §5.3 fallback
 * agent interval and a full parse of 79%-of-cost worth of transcripts to get them
 * would be waste.
 */
export async function ingestAgentTranscript(
  path: string,
  ctx: RequestContext,
): Promise<TranscriptIngest> {
  const requests: RequestRow[] = [];
  const anomalies: IngestAnomaly[] = [];
  const uuids: string[] = [];
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  const noteTs = (ts: string | null): void => {
    if (ts === null) return;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
  };
  const noteUuid = (uuid: string | null | undefined): void => {
    if (uuid !== null && uuid !== undefined) uuids.push(uuid);
  };

  const { stats, anomalies: readAnomalies, complete } = await readJsonl(path, (line, isTail) => {
    // The tail is always fully parsed: a torn line cut BEFORE `"output_tokens"`
    // would otherwise slip past the prefilter and be reported as clean.
    if (!isTail && !line.includes(USAGE_HINT)) {
      // A MID-FILE line can be torn too (a killed writer, then a later append),
      // and it is not the tail, so nothing else parses it. Skipping it silently
      // makes the sweep report a clean parse while a paid request went missing —
      // the §2 failure this whole module is written against. Parsing it here is
      // what turns it into `malformed` + an anomaly, exactly as a main transcript
      // would; `looksLikeWholeObject` keeps that off the hot path.
      if (!looksLikeWholeObject(line)) {
        const torn = JSON.parse(line) as TranscriptLine; // throws -> counted by readJsonl
        noteTs(str(torn.timestamp));
        noteUuid(str(torn.uuid));
        return;
      }
      noteTs(TS_RE.exec(line)?.[1] ?? null);
      noteUuid(UUID_RE.exec(line)?.[1]);
      return;
    }
    const parsed = JSON.parse(line) as TranscriptLine; // may throw -> counted by readJsonl
    noteTs(str(parsed.timestamp));
    noteUuid(str(parsed.uuid));
    const result = extractRequest(parsed, ctx);
    if (result.row !== null) {
      requests.push(result.row);
      return;
    }
    if (result.reason !== null) {
      anomalies.push({ kind: "unusable_usage_line", detail: result.reason, path });
    }
  });

  return {
    path,
    requests,
    firstTs,
    lastTs,
    uuids,
    stats,
    anomalies: [...readAnomalies, ...anomalies],
    complete,
  };
}

const LAUNCH_TOOLS = new Set(["Agent", "Task", "Workflow"]);
/** The two tools that can carry a planted `est_tid` — see {@link TaskPlantRow}. */
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);

/**
 * EVERY `tool_result` block on a user line, with its error flag.
 *
 * All of them, not the first: a turn that issues parallel tool calls can have its
 * results batched onto one line, and taking `content[0]` would tie a plant to whichever
 * call happened to be printed first. `task_alias` is first-plant-wins and physically
 * exclusive (`ux_alias_exclusive`), so that mistake is PERMANENT — one wrong task
 * number silently books another task's whole stream of spend, and no re-sweep can
 * correct it.
 *
 * `is_error` travels with the block because a plant must not survive a call that
 * failed: `TaskUpdate` on a task id that does not exist comes back as an error result,
 * and minting the alias from the attempt would freeze the corpus onto a task number the
 * harness never accepted.
 */
function toolResultBlocks(line: Record<string, unknown>): Array<{ id: string; isError: boolean }> {
  const content = (line.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; isError: boolean }> = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_result") continue;
    const id = str(b.tool_use_id);
    if (id !== null) out.push({ id, isError: b.is_error === true });
  }
  return out;
}

/**
 * `metadata.est_tid` out of a `TaskCreate`/`TaskUpdate` payload, from either side of
 * the call: the tool_use INPUT (where the ceremony actually puts it) or a
 * `toolUseResult` that echoes the metadata back (which no harness version observed so
 * far does — read defensively rather than betting on the shape).
 */
function plantedTid(v: unknown): string | null {
  if (v === null || typeof v !== "object") return null;
  const meta = (v as Record<string, unknown>).metadata;
  if (meta === null || typeof meta !== "object") return null;
  return str((meta as Record<string, unknown>).est_tid);
}

/**
 * Ingest a main transcript in ONE pass: turn segmentation, request extraction,
 * workflow-launch and task-event joins.
 *
 * Every line is parsed here (unlike agent transcripts): the turn segmenter needs
 * user lines, `turn_duration` needs system lines, and the join graph needs
 * `toolUseResult`. Main transcripts are the small half of the corpus.
 */
export async function ingestMainTranscript(
  path: string,
  sessionId: string,
): Promise<MainIngest> {
  const requests: RequestRow[] = [];
  const launches: WorkflowLaunch[] = [];
  const taskEvents: TaskEventRow[] = [];
  const taskPlants: TaskPlantRow[] = [];
  /**
   * `tool_use` id -> the plant that call made, held until its RESULT arrives.
   *
   * Every plant waits, `TaskUpdate`'s included even though its input already names the
   * task number: the result is the only evidence the harness ACCEPTED the call, and an
   * alias minted from a rejected attempt cannot be taken back (see
   * {@link toolResultBlocks}). `task_num` is null for a `TaskCreate`, whose number the
   * harness assigns in the result.
   */
  const pendingPlants = new Map<string, { tid: string; task_num: string | null }>();
  const toolUsePrompts = new Map<string, string>();
  const anomalies: IngestAnomaly[] = [];
  const uuids: string[] = [];
  const segmenter = new TurnSegmenter(sessionId);
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  const noteTs = (ts: string | null): void => {
    if (ts === null) return;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
  };

  const { stats, anomalies: readAnomalies, complete } = await readJsonl(path, (raw) => {
    const line = JSON.parse(raw) as TranscriptLine; // may throw -> counted
    const ts = str(line.timestamp);
    noteTs(ts);
    const uuid = str(line.uuid);
    if (uuid !== null) uuids.push(uuid);

    segmenter.push(line);
    const promptId = segmenter.currentPromptId;

    // --- requests -----------------------------------------------------------
    if (line.type === "assistant") {
      const result = extractRequest(line, {
        origin: "main",
        sessionId,
        promptId,
      });
      if (result.row !== null) requests.push(result.row);
      else if (result.reason !== null) {
        anomalies.push({ kind: "unusable_usage_line", detail: result.reason, path });
      }

      // --- launch tool_use ids -> launching turn, and planted est_tids -------
      const content = (line.message as Record<string, unknown> | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type !== "tool_use") continue;
          const name = str(b.name);
          const id = str(b.id);
          if (id !== null && name !== null && promptId !== null && LAUNCH_TOOLS.has(name)) {
            toolUsePrompts.set(id, promptId);
          }
          if (name === null || id === null || !TASK_TOOLS.has(name)) continue;
          const tid = plantedTid(b.input);
          if (tid === null) continue;
          pendingPlants.set(id, {
            tid,
            task_num: str((b.input as Record<string, unknown> | undefined)?.taskId),
          });
        }
      }
      return;
    }

    // --- tool_result payloads ------------------------------------------------
    const tur = line.toolUseResult;
    if (tur === null || typeof tur !== "object") return;
    const r = tur as Record<string, unknown>;

    const runId = str(r.runId);
    const taskId = str(r.taskId);
    if (runId !== null && taskId !== null && ts !== null) {
      launches.push({
        run_id: runId,
        wf_launch_id: taskId,
        session_id: sessionId,
        prompt_id: promptId,
        ts,
        workflow_name: str(r.workflowName),
        transcript_dir: str(r.transcriptDir),
      });
      return;
    }

    if (ts === null) return;

    // --- planted est_tids, resolved against THIS result ----------------------
    // Matched by `tool_use_id` against the plants still in flight, never by position
    // (see {@link toolResultBlocks}). A matched call is retired from `pendingPlants`
    // either way: a plant whose call failed is dropped, not carried forward to be
    // resolved by some later result that happens to arrive.
    const results = toolResultBlocks(line);
    const matched = results.filter((b) => pendingPlants.has(b.id));
    for (const m of matched) {
      const pend = pendingPlants.get(m.id);
      pendingPlants.delete(m.id);
      if (pend === undefined) continue;
      // `success: false` is the WHOLE line's verdict, so it is only readable when one
      // call is on it; `is_error` is per block and always is.
      if (m.isError || (matched.length === 1 && r.success === false)) continue;
      // A `TaskCreate` plant needs the number out of the result, and only an
      // unambiguous line can say which result is its own.
      const num =
        pend.task_num ??
        (matched.length === 1
          ? str((r.task as Record<string, unknown> | undefined)?.id) ?? str(r.taskId)
          : null);
      if (num !== null) taskPlants.push({ session_id: sessionId, task_num: num, tid: pend.tid, ts });
    }

    // --- task lifecycle ------------------------------------------------------
    // Same shapes, same order as gates/g-attr.ts:readTaskStream(), because the
    // gate's attribution measurement is the thing this pipeline has to be able to
    // reproduce. TaskCreate first: it carries `task`, never `statusChange`.
    const task = r.task;
    if (task !== null && typeof task === "object") {
      const id = str((task as Record<string, unknown>).id);
      if (id !== null) {
        // Defensive, and separate from the `tool_use` path above: no harness version
        // observed so far echoes the metadata back on the result, and a shape change
        // that started to should not need an ingest change to be seen. Gated on the
        // same error check — an echo from a failed call is not a plant.
        const echoed = results.some((b) => b.isError) || r.success === false
          ? null
          : plantedTid(task) ?? plantedTid(r);
        if (echoed !== null) taskPlants.push({ session_id: sessionId, task_num: id, tid: echoed, ts });
        taskEvents.push({
          session_id: sessionId,
          task_num: id,
          ts,
          kind: "create",
          from_status: null,
          // TaskCreate leaves the task pending; g-attr records the same target so
          // the two agree on what a create means without a second vocabulary.
          to_status: "pending",
        });
        return;
      }
    }

    const statusChange = r.statusChange;
    if (statusChange !== null && typeof statusChange === "object") {
      const sc = statusChange as Record<string, unknown>;
      const num = str(r.taskId) ?? str(sc.taskId);
      // Same defensive echo as the create branch above, and gated the same way.
      const echoed = results.some((b) => b.isError) || r.success === false ? null : plantedTid(r);
      if (echoed !== null && num !== null) {
        taskPlants.push({ session_id: sessionId, task_num: num, tid: echoed, ts });
      }
      taskEvents.push({
        session_id: sessionId,
        task_num: num,
        ts,
        kind: "status",
        from_status: str(sc.from) ?? str(sc.fromStatus),
        to_status: str(sc.to) ?? str(sc.toStatus) ?? str(sc.status),
      });
    }
  });

  // A plant whose tool_result never arrived. The ordinary cause is the one P1.11 exists
  // for: the session died between the `tool_use` line and its result, so the harness's
  // verdict on that call is not on disk and never will be. Dropping it is right — an
  // alias minted from a call nobody saw succeed is permanent (§ `INSERT_TASK_ALIAS_SQL`)
  // — but dropping it SILENTLY leaves "the plant was never made" and "the plant was made
  // and lost" looking identical, which is the same blindness `plant_unlinked` was added
  // to remove. A torn tail also lands here and self-heals: the file is still growing, so
  // the next sweep re-reads it in full and the pair resolves.
  for (const [toolUseId, pend] of pendingPlants) {
    anomalies.push({
      kind: "plant_unlinked",
      detail:
        `a planted est_tid was never confirmed: ${toolUseId} carried the plant and no tool_result ` +
        `for it appears in the transcript (session ${sessionId}` +
        `${pend.task_num === null ? "" : `, harness task ${pend.task_num}`}), so no session_task ` +
        `alias was minted. A call the harness never acknowledged is not evidence it succeeded. ` +
        `If the file is still being written this resolves itself on the next sweep`,
      path,
    });
  }

  const segmented = segmenter.result();

  // A turn_duration record that precedes every prompt in the file cannot be
  // attributed to a turn — it belongs to a turn that opened in an EARLIER file
  // (a resumed or forked session), so `turn.duration_ms` for that turn is short
  // by exactly this much. The segmenter has always counted them; dropping the
  // count here made "counted, not dropped" false in the only place it is visible.
  if (segmented.orphanTurnDurations > 0) {
    anomalies.push({
      kind: "orphan_turn_duration",
      detail:
        `${segmented.orphanTurnDurations} turn_duration record(s) arrived before any prompt ` +
        `and could not be attributed to a turn — the wall clock of the turn they belong to is ` +
        `under-reported by that many records (a resumed or forked session opens its turn in ` +
        `another file)`,
      path,
    });
  }

  return {
    path,
    sessionId,
    requests,
    turns: segmented.turns,
    launches,
    taskEvents,
    taskPlants,
    toolUsePrompts,
    compactions: segmented.compactions,
    orphanTurnDurations: segmented.orphanTurnDurations,
    firstTs,
    lastTs,
    uuids,
    stats,
    anomalies: [
      ...readAnomalies,
      ...anomalies,
      ...compactionAnomalies(sessionId, segmented.compactions, path),
    ],
    complete,
  };
}

/**
 * Persist every `/compact` boundary as `anomaly(compaction_continuation)`.
 *
 * WHY AN ANOMALY ROW AND NOT A COLUMN. Two mechanisms were on the table for the
 * Phase 1 `outcome.compactions` feed: a counter on `sweep_census`, or a row per
 * boundary in the ledger that already exists. The counter is lighter to write and
 * useless to read — it is corpus-wide, so it cannot answer "which session, and at
 * what token depth", which is exactly what §5.5 wants compactions FOR (they are
 * the proxy for spend the transcript never shows). It would also need a schema
 * change. The ledger costs one row per compaction, needs no DDL, and carries the
 * session, the boundary timestamp and `compactMetadata.preTokens` in a detail
 * string that is STABLE — so `insertAnomalies`' (kind, detail) de-duplication
 * makes a re-sweep a no-op, and Phase 1 reads its feed with
 * `SELECT … FROM anomaly WHERE kind='compaction_continuation'`.
 *
 * G-FORK §3.3 is why the kind is named after the mechanism rather than the event:
 * `/compact` ENDS a session and replays the surviving context window — the
 * parent's tail — into a NEW session's head, requestIds intact. The boundary
 * recorded here is the parent side of that pair; the child side shows up as
 * `fork_replay` from the D3 detector, and the two together explain a duplicate
 * that no leading-prefix test can see.
 *
 * Compactions are NORMAL, not failures, so `BENIGN_ANOMALY_KINDS` (src/cli.ts)
 * keeps them out of the alerting count.
 */
export function compactionAnomalies(
  sessionId: string,
  compactions: readonly CompactionEvent[],
  path?: string,
): IngestAnomaly[] {
  return compactions.map((c) => ({
    kind: "compaction_continuation" as const,
    detail:
      `session ${sessionId}: /compact boundary at ${c.ts}` +
      (c.preTokens === null ? " (compactMetadata carried no preTokens)" : `, preTokens=${c.preTokens}`) +
      ` — the surviving context window is replayed into the NEXT session's head, so its ` +
      `requestIds legitimately appear in two files (G-FORK §3.3)`,
    ...(path === undefined ? {} : { path }),
  }));
}

// ---------------------------------------------------------------------------
// agent_run / workflow_run / workflow_phase assembly (§5.3, §5.6)
// ---------------------------------------------------------------------------

/**
 * §5.6 fallback: cluster agents into waves by interval overlap and, when the wave
 * count equals the planned phase count, map wave i -> phase i.
 *
 * Only reached for agents with no `workflowProgress` record (a killed or crashed
 * run whose state file was never finalised). Clustering runs over ALL of the run's
 * agents — the waves are a property of the run, not of the unmapped subset — but
 * an inferred phase is only ever applied to an agent that has no exact one.
 */
export function clusterAgentsIntoWaves(
  agents: { agentId: string; startedAt: string | null; endedAt: string | null }[],
): string[][] {
  const usable = agents
    .filter((a): a is { agentId: string; startedAt: string; endedAt: string | null } =>
      a.startedAt !== null,
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (usable.length === 0) return [];

  const waves: string[][] = [];
  let current: string[] = [];
  let waveEnd = "";

  for (const a of usable) {
    const end = a.endedAt ?? a.startedAt;
    if (current.length === 0 || a.startedAt <= waveEnd) {
      current.push(a.agentId);
      if (end > waveEnd) waveEnd = end;
    } else {
      waves.push(current);
      current = [a.agentId];
      waveEnd = end;
    }
  }
  if (current.length > 0) waves.push(current);
  return waves;
}

export interface AgentIntervalFromTranscript {
  agentId: string;
  firstTs: string | null;
  lastTs: string | null;
}

export interface BuildAgentRunsInput {
  sessionId: string;
  /** Agent transcripts on disk for this run (or session, for Agent-tool agents). */
  agents: AgentTranscript[];
  /** First/last line timestamps per agentId — the transcript fallback interval. */
  intervals: Map<string, AgentIntervalFromTranscript>;
  /** The run's state file, when one exists. */
  state?: WorkflowState | null;
  runId?: string | null;
  wfLaunchId?: string | null;
  launchPromptId?: string | null;
  /** meta.toolUseId -> promptId, from the main transcript (Agent-tool agents). */
  toolUsePrompts?: Map<string, string>;
  /**
   * agentIds with a `type:"result"` record in the run's `journal.jsonl` — the
   * agents that RETURNED. Undefined means "no journal was read", which suppresses
   * the never-returned branch of the classifier rather than guessing with it.
   */
  journalResultAgentIds?: readonly string[];
  /** Injected clock, for the in-flight age guard. Defaults to now. */
  now?: Date;
}

/**
 * Why a workflow agent has no `workflowProgress[]` record. §5.6 `[R4]`.
 *
 * Three of the four are structural facts about the corpus and carry no blame; only
 * `unexplained` is the residual an operator should look at, and it is the only one
 * that still raises an alerting anomaly.
 */
export type UnmappedReason = "in_flight" | "never_returned" | "relaunch_orphan" | "unexplained";

/**
 * How long an agent in a run with NO state file may stay `in_flight` before it is
 * reclassified as never-returned.
 *
 * Without a bound, `in_flight` is a silent drain: a workflow abandoned mid-run
 * leaves a directory, agents and a journal on disk and never writes a state file,
 * so it would produce no anomaly at all, forever. A day is comfortably longer than
 * any observed run and short enough that an abandonment surfaces the next day.
 */
const IN_FLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface BuildAgentRunsResult {
  rows: AgentRunRow[];
  anomalies: IngestAnomaly[];
  /** agentId -> why it is `phase_conf='unmapped'`. Only unmapped agents appear. */
  unmappedReasons: Map<string, UnmappedReason>;
}

export function buildAgentRuns(input: BuildAgentRunsInput): BuildAgentRunsResult {
  const anomalies: IngestAnomaly[] = [];
  const state = input.state ?? null;
  const progress = new Map(state?.progressAgents.map((p) => [p.agentId, p]) ?? []);
  const nPlanned = state?.phases.length ?? 0;
  const nowMs = (input.now ?? new Date()).getTime();
  const returned = input.journalResultAgentIds === undefined
    ? null
    : new Set(input.journalResultAgentIds);
  // The earliest startedAt the state file knows about. An agent on disk that
  // started BEFORE it cannot belong to the launch this file describes.
  let firstProgressStart: string | null = null;
  for (const p of state?.progressAgents ?? []) {
    if (p.startedAt === null) continue;
    if (firstProgressStart === null || p.startedAt < firstProgressStart) firstProgressStart = p.startedAt;
  }
  /** Agents whose `workflowProgress[]` record exists but omits `label` (§3.2). */
  const labelViolations: string[] = [];

  const rows: AgentRunRow[] = input.agents.map((agent) => {
    const p = progress.get(agent.agentId) ?? null;
    const interval = input.intervals.get(agent.agentId) ?? null;

    // §5.3 SOURCE ORDER: workflowProgress startedAt + durationMs is PRIMARY for
    // workflow agents (scheduler intervals, free of the time-to-first-token bias);
    // transcript first/last line is the fallback and the only rule elsewhere.
    let started: string | null = null;
    let ended: string | null = null;
    let intervalSrc: IntervalSrc = "none";
    if (p !== null && p.startedAt !== null) {
      started = p.startedAt;
      ended = p.endedAt;
      intervalSrc = "workflow_progress";
    } else if (interval !== null && interval.firstTs !== null) {
      started = interval.firstTs;
      ended = interval.lastTs;
      intervalSrc = "transcript";
    }

    // The launching turn: the Agent-tool `tool_use` this agent's meta names, else
    // the run's own launch prompt. Hoisted into two names rather than one nested
    // ternary — the inline form is also what tsc reads as "always nullish"
    // (TS2871), because a parenthesised conditional feeding `??` defeats its
    // narrowing.
    const toolUseId = agent.meta?.toolUseId ?? null;
    const fromToolUse = toolUseId === null ? null : (input.toolUsePrompts?.get(toolUseId) ?? null);
    const launchPromptId = fromToolUse ?? input.launchPromptId ?? null;

    return {
      agent_id: agent.agentId,
      session_id: input.sessionId,
      run_id: agent.runId ?? input.runId ?? null,
      wf_launch_id: input.wfLaunchId ?? state?.taskId ?? null,
      agent_type: p?.agentType ?? agent.meta?.agentType ?? null,
      spawn_depth: agent.meta?.spawnDepth ?? 1,
      launch_prompt_id: launchPromptId,
      transcript_path: agent.transcriptPath,
      status: p?.state ?? null,
      // NULL label on a workflow agent means the §3.2 authoring rule (every
      // agent() carries label + phase) was violated — but ONLY when a progress
      // record exists and omits it. "No record at all" is a different fact with a
      // different cause, and reporting it as an authoring violation was false in
      // 100% of the live corpus's 194 such rows: not one `workflowProgress` record
      // on the machine had a null label.
      label: p?.label ?? null,
      started_at: started,
      ended_at: ended,
      interval_src: intervalSrc,
      queued_at: p?.queuedAt ?? null,
      attempt: p?.attempt ?? null,
      // AUDIT ONLY — never summed (§5.6).
      reported_tokens: p?.reportedTokensAuditOnly ?? null,
      phase_idx: p?.phaseIdx ?? null,
      phase_title: p?.phaseTitle ?? null,
      phase_conf: p !== null && p.phaseIdx !== null ? "exact" : "unmapped",
    };
  });
  for (const agent of input.agents) {
    const p = progress.get(agent.agentId) ?? null;
    if (p !== null && p.label === null) labelViolations.push(agent.agentId);
  }

  // ---- fallback: interval clustering for anything not mapped exactly --------
  const unmapped = rows.filter((r) => r.phase_conf !== "exact");
  if (unmapped.length > 0 && input.runId !== null && input.runId !== undefined) {
    const waves = clusterAgentsIntoWaves(
      rows.map((r) => ({ agentId: r.agent_id, startedAt: r.started_at, endedAt: r.ended_at })),
    );
    if (nPlanned > 0 && waves.length === nPlanned) {
      const waveOf = new Map<string, number>();
      waves.forEach((wave, i) => wave.forEach((id) => waveOf.set(id, i)));
      for (const row of unmapped) {
        const idx = waveOf.get(row.agent_id);
        if (idx === undefined) continue;
        row.phase_idx = idx;
        row.phase_title = state?.phases[idx]?.title ?? null;
        row.phase_conf = "inferred";
      }
    }
  }

  // ---- classify, do not blame ------------------------------------------------
  // §5.6 [R4] promotion condition (ii). An agent with no `workflowProgress[]`
  // record used to raise up to THREE anomaly rows — a `phase_unmapped` carrying a
  // wave count that changed between sweeps (so the (kind, detail) dedup never
  // matched and the same agent was re-logged up to four times), a
  // `wf_record_mismatch` claiming an authoring violation that had not happened, and
  // a second `wf_record_mismatch` from the discovery cross-check naming the same
  // agent again. On the live corpus that produced 609 rows, of which 14 were real.
  //
  // The reason a record is missing is knowable, and each reason has a different
  // remedy — or none:
  //
  //   in_flight       the run has not written a state file yet. There IS no state
  //                   file until the run completes (§5.6 [R4]); the statusline's
  //                   own live path depends on this being normal. No anomaly.
  //   never_returned  the run terminated and the journal has no `result` for this
  //                   agent: killed, or crashed. Benign, counted.
  //   relaunch_orphan the agent started before the earliest record in the state
  //                   file — it belongs to an EARLIER launch under the same runId,
  //                   which the harness overwrote when it rewrote wf_<runId>.json.
  //                   Benign, counted. (On the live corpus, of 21 runs with both
  //                   mapped and unmapped agents, 16 have every unmapped agent
  //                   strictly preceding every mapped one.)
  //   unexplained     none of the above. THIS is the residual worth an alert, and
  //                   the only one of the four that still raises one.
  const unmappedReasons = new Map<string, UnmappedReason>();
  for (const row of rows) {
    if (row.phase_conf !== "unmapped" || row.run_id === null) continue;
    const lastSeen = Date.parse(row.ended_at ?? row.started_at ?? "");
    let reason: UnmappedReason;
    if (state === null) {
      reason =
        Number.isFinite(lastSeen) && nowMs - lastSeen > IN_FLIGHT_MAX_AGE_MS
          ? "never_returned"
          : "in_flight";
    } else if (returned !== null && !returned.has(row.agent_id)) {
      reason = "never_returned";
    } else if (
      row.started_at !== null &&
      firstProgressStart !== null &&
      row.started_at < firstProgressStart
    ) {
      reason = "relaunch_orphan";
    } else {
      reason = "unexplained";
    }
    unmappedReasons.set(row.agent_id, reason);

    if (reason === "in_flight") continue;
    if (reason === "never_returned") {
      anomalies.push({
        kind: "agent_never_returned",
        detail: `run ${row.run_id}: agent ${row.agent_id} never returned — no result record in journal.jsonl; its tokens are counted, its phase is not`,
      });
    } else if (reason === "relaunch_orphan") {
      anomalies.push({
        kind: "wf_relaunch_orphan",
        detail: `run ${row.run_id}: agent ${row.agent_id} started before the earliest workflowProgress[] record — it belongs to an earlier launch under the same runId, whose progress the state file overwrote`,
      });
    } else {
      // Deliberately free of the wave count: it moves as agents land, which is
      // exactly what defeated `insertAnomalies`' dedup. `nPlanned` comes from the
      // static plan and does not.
      anomalies.push({
        kind: "phase_unmapped",
        detail: `run ${row.run_id}: agent ${row.agent_id} has no workflowProgress record and no relaunch or never-returned explanation (${nPlanned} planned phase(s))`,
      });
    }
  }

  for (const agentId of labelViolations) {
    anomalies.push({
      kind: "wf_record_mismatch",
      detail: `run ${input.runId ?? "?"}: workflow agent ${agentId} has a workflowProgress record with no label — the §3.2 authoring rule (label + phase on every agent()) was not followed`,
    });
  }

  return { rows, anomalies, unmappedReasons };
}

export function buildWorkflowPhases(
  runId: string,
  wfLaunchId: string,
  phases: WorkflowPlanPhase[],
  defaultModel: string | null,
): WorkflowPhaseRow[] {
  return phases.map((p) => ({
    run_id: runId,
    wf_launch_id: wfLaunchId,
    phase_idx: p.phaseIdx,
    title: p.title,
    detail: p.detail,
    model: p.model ?? defaultModel,
  }));
}

/** `workflow_run.started_at`/`ended_at` are DERIVED from agent intervals (§4.2). */
export function deriveRunInterval(
  agentRuns: AgentRunRow[],
): { started_at: string | null; ended_at: string | null } {
  let started: string | null = null;
  let ended: string | null = null;
  for (const a of agentRuns) {
    if (a.started_at !== null && (started === null || a.started_at < started)) started = a.started_at;
    if (a.ended_at !== null && (ended === null || a.ended_at > ended)) ended = a.ended_at;
  }
  return { started_at: started, ended_at: ended };
}

const totalTokens = (r: RequestRow): number => r.in_tok + r.out_tok + r.cw_tok + r.cr_tok;

/**
 * Resolve requestId collisions — the same requestId carrying two DIFFERENT models
 * (~1 in 16k [CA]) — into one coherent row, and report every one.
 *
 * Why this is not just an anomaly. MAX-per-counter is right for rows that share a
 * model: those are cumulative streaming snapshots of ONE call, and the last
 * snapshot is the truth. It is wrong across models, because those are two REAL
 * calls that collided on one id. Taking MAX of each counter independently then
 * builds a row that never happened — `in_tok` from one call, `out_tok` from the
 * other, priced at whichever model happened to be read first. That chimera is
 * worse than either call: it over-counts, and it over-counts silently.
 *
 * So the row is decided whole. Rows are grouped by (request_id, model), each group
 * collapsed by MAX per counter (the legitimate rule, applied only where it holds),
 * and the groups ranked by ccusage's tie-break — larger total wins, model id ASC
 * breaks an exact tie so the answer does not depend on file read order. The winner
 * is the only row emitted for that requestId; the losers are dropped, and each one
 * is named in a `rid_collision` anomaly with its counters, so "dropped" is a fact
 * in the ledger rather than a hole in a sum.
 *
 * Cross-sweep collisions (the two calls arriving in different sweeps) cannot be
 * seen from here at all — `UPSERT_REQUEST_SQL` applies the same rule in SQL.
 */
export function resolveRidCollisions(
  requests: RequestRow[],
): { requests: RequestRow[]; anomalies: IngestAnomaly[] } {
  // Group by request_id, then by model, preserving first-seen order throughout so
  // the output of a collision-free batch is byte-identical to its input.
  const byRid = new Map<string, Map<string, RequestRow[]>>();
  for (const r of requests) {
    let models = byRid.get(r.request_id);
    if (models === undefined) {
      models = new Map();
      byRid.set(r.request_id, models);
    }
    const group = models.get(r.model);
    if (group === undefined) models.set(r.model, [r]);
    else group.push(r);
  }

  const anomalies: IngestAnomaly[] = [];
  let contested = false;
  for (const models of byRid.values()) {
    if (models.size > 1) {
      contested = true;
      break;
    }
  }
  if (!contested) return { requests, anomalies };

  const out: RequestRow[] = [];
  for (const [requestId, models] of byRid) {
    if (models.size === 1) {
      out.push(...models.values().next().value!);
      continue;
    }

    // One coherent candidate per model: MAX per counter WITHIN the model, which is
    // the streaming-snapshot rule applied where it is actually true.
    const candidates = [...models.entries()].map(([model, rows]) => {
      const merged: RequestRow = { ...rows[0]! };
      for (const r of rows) {
        merged.in_tok = Math.max(merged.in_tok, r.in_tok);
        merged.out_tok = Math.max(merged.out_tok, r.out_tok);
        merged.cw_tok = Math.max(merged.cw_tok, r.cw_tok);
        merged.cr_tok = Math.max(merged.cr_tok, r.cr_tok);
      }
      return { model, row: merged };
    });
    candidates.sort((a, b) => totalTokens(b.row) - totalTokens(a.row) || a.model.localeCompare(b.model));

    const [winner, ...losers] = candidates as [
      { model: string; row: RequestRow },
      ...{ model: string; row: RequestRow }[],
    ];
    out.push(winner.row);
    anomalies.push({
      kind: "rid_collision",
      detail:
        `request ${requestId}: ${candidates.length} models share one requestId — ` +
        `kept ${winner.model} whole (${totalTokens(winner.row)} tok); dropped ${losers
          .map((l) => `${l.model} (${totalTokens(l.row)} tok)`)
          .join(", ")}. Counters are NEVER blended across models: MAX per counter ` +
        `would price a row that no call ever produced.`,
    });
  }
  return { requests: out, anomalies };
}

/**
 * The anomalies {@link resolveRidCollisions} would raise, without the rewrite.
 * Kept as its own export because "how many collisions are in this batch" is a
 * question worth asking on its own (gates, ad-hoc corpus checks).
 */
export function detectRidCollisions(requests: RequestRow[]): IngestAnomaly[] {
  return resolveRidCollisions(requests).anomalies;
}

// ---------------------------------------------------------------------------
// corpus-level plan — the two questions a single session CANNOT answer
// ---------------------------------------------------------------------------

/**
 * Decisions that must be made over the WHOLE corpus before any session is ingested.
 *
 * Both of the things it settles were order-dependent bugs, not missing features:
 *
 *  1. **Who owns a physically-shared transcript** (G-FORK §3.4, §7 recs 3+4). A
 *     session that forks while a sub-agent is in flight gets a SYMLINK to the
 *     parent's still-open `agent-<id>.jsonl`. `discoverCorpus` realpaths it, so
 *     both sessions enumerate the same canonical path — and `agent_run.session_id`
 *     went to whichever session the sweeper happened to reach first, silently
 *     re-attributing 256 requests and 1.97M tokens on this machine depending on
 *     directory order. Ownership now goes to the session that owns the link
 *     TARGET (the launcher, per `sessionIdFromPath`), the file is ingested exactly
 *     ONCE, and every losing claim is written as `anomaly(symlink_alias)`.
 *
 *  2. **Which state file describes a run** (G-PHASE §2b). `wf_<runId>.json` and
 *     `subagents/workflows/<runId>/` land under DIFFERENT sessions whenever a run
 *     outlives the session that launched it: the resumed session keeps the state
 *     file, the original keeps the transcripts. Pairing them per session — which
 *     is all `ingestSession` could do — degraded 3 runs / 46 agents to
 *     `phase_conf='unmapped'` on this corpus even though both halves were on disk.
 *     Keyed by runId across every session, the exact phase join applies wherever
 *     both halves exist anywhere.
 */
export interface CorpusPlan {
  /** canonical transcript path -> the ONE session that ingests it. */
  owner: Map<string, string>;
  /** runId -> its state file, from whichever session happens to hold it. */
  stateByRun: Map<string, WorkflowState>;
  /** `symlink_alias` rows for every losing claim. */
  anomalies: IngestAnomaly[];
}

/** Fewest `workflow_agent` records loses; path breaks an exact tie, so the choice
 *  never depends on session iteration order. */
function betterState(a: WorkflowState, b: WorkflowState): WorkflowState {
  if (a.progressAgents.length !== b.progressAgents.length) {
    return a.progressAgents.length > b.progressAgents.length ? a : b;
  }
  return a.path <= b.path ? a : b;
}

/** Build the {@link CorpusPlan} for a discovered corpus. Pure; no IO. */
export function planCorpus(corpus: Corpus): CorpusPlan {
  const claims = new Map<string, Set<string>>();
  const claim = (path: string, sessionId: string): void => {
    const set = claims.get(path);
    if (set === undefined) claims.set(path, new Set([sessionId]));
    else set.add(sessionId);
  };

  const stateByRun = new Map<string, WorkflowState>();
  for (const session of corpus.sessions) {
    for (const p of session.mainTranscripts) claim(p, session.sessionId);
    for (const a of session.agents) claim(a.transcriptPath, session.sessionId);
    for (const wf of session.workflows) {
      for (const a of wf.agents) claim(a.transcriptPath, session.sessionId);
    }
    for (const state of session.states) {
      const seen = stateByRun.get(state.runId);
      stateByRun.set(state.runId, seen === undefined ? state : betterState(seen, state));
    }
  }

  const owner = new Map<string, string>();
  const anomalies: IngestAnomaly[] = [];
  for (const [path, claimants] of claims) {
    const sessions = [...claimants].sort();
    const target = sessionIdFromPath(path);
    // The link target's session owns the file — unless it is not in this corpus at
    // all (its project dir pruned, or a --root that only covers part of the tree),
    // in which case the lowest claimant owns it: still deterministic, still one.
    const winner = target !== null && claimants.has(target) ? target : sessions[0]!;
    owner.set(path, winner);
    if (sessions.length === 1) continue;
    anomalies.push({
      kind: "symlink_alias",
      detail:
        `one physical transcript is claimed by ${sessions.length} sessions (${sessions.join(", ")}) — ` +
        `it is a symlink shared by a fork, not a copy. Attributed to ${winner}` +
        (winner === target
          ? " (the session owning the link target, i.e. the agent's launcher)"
          : " (the link target's session is not in this corpus; lowest session id wins)") +
        `; losing claim(s) ${sessions.filter((s) => s !== winner).join(", ")} ingest it zero times`,
      path,
    });
  }

  return { owner, stateByRun, anomalies };
}

// ---------------------------------------------------------------------------
// D3 fork detector — G-FORK §5: precision 1.00, recall 1.00 on the live corpus
// ---------------------------------------------------------------------------

/**
 * Flag every pair of DISTINCT transcript files, belonging to DIFFERENT sessions,
 * that share at least one line `uuid`.
 *
 * This is detector **D3**, and it replaces the leading-uuid-prefix test R3 §5.2
 * proposed (D1) — which was never validated, and when G-FORK finally validated it
 * scored **0.357 recall** on the measure that matters (duplicated requests). D1
 * assumes a fork replays the parent's history from its FIRST line. Two of the
 * three mechanisms on disk do not:
 *
 *   - a `/compact` continuation replays the parent's TAIL into the child's HEAD,
 *     giving a strict leading prefix of ZERO across 249 shared requestIds — 64% of
 *     all replayed duplicates in the corpus, invisible to D1 by construction;
 *   - even a genuine rewind fork can reorder two adjacent lines, which breaks a
 *     positional prefix comparison at index 17 of a 300-uuid replay.
 *
 * D3 is blind to shape because it never compares positions: one hash pass over
 * `uuid -> file[]`, on data the sweeper is already streaming. On the live corpus
 * the set of file pairs sharing a uuid was IDENTICAL to the set sharing a
 * requestId — 5 and 5, precision 1.00, recall 1.00 — so it costs less than D1 and
 * survives replay mechanisms nobody has observed yet.
 *
 * Same physical file under two sessions is NOT a fork and is deliberately not
 * flagged here: that is the symlink alias {@link planCorpus} owns, and pairing is
 * by distinct `path`, so an aliased file cannot pair with itself.
 *
 * INCREMENTAL SWEEP CAVEAT, stated rather than hidden: the index only holds files
 * the sweep actually READ, so an incremental sweep sees an overlap only when both
 * sides changed. `est backfill` re-reads everything and is therefore the complete
 * pass. Under-reporting, never over-reporting — and the ledger accumulates.
 */
export function detectForkReplays(files: readonly TranscriptIndexEntry[]): IngestAnomaly[] {
  // One pass: uuid -> the indices of the files carrying it.
  const uuidToFiles = new Map<string, number[]>();
  for (let i = 0; i < files.length; i += 1) {
    for (const uuid of new Set(files[i]!.uuids)) {
      const seen = uuidToFiles.get(uuid);
      if (seen === undefined) uuidToFiles.set(uuid, [i]);
      else seen.push(i);
    }
  }

  // Second pass: accumulate shared-uuid counts per cross-session file pair.
  const shared = new Map<string, { a: number; b: number; uuids: number }>();
  for (const idxs of uuidToFiles.values()) {
    if (idxs.length < 2) continue;
    for (let x = 0; x < idxs.length; x += 1) {
      for (let y = x + 1; y < idxs.length; y += 1) {
        const fa = files[idxs[x]!]!;
        const fb = files[idxs[y]!]!;
        if (fa.path === fb.path) continue; // one physical file: symlink_alias, not a fork
        if (fa.sessionId === fb.sessionId) continue; // same session: a resume append
        const [lo, hi] = idxs[x]! < idxs[y]! ? [idxs[x]!, idxs[y]!] : [idxs[y]!, idxs[x]!];
        const key = `${lo} ${hi}`;
        const entry = shared.get(key);
        if (entry === undefined) shared.set(key, { a: lo, b: hi, uuids: 1 });
        else entry.uuids += 1;
      }
    }
  }
  if (shared.size === 0) return [];

  // Third pass, only over the handful of flagged pairs: the shared REQUEST count,
  // which is what a narrow (session_id, request_id) key would have double-counted.
  const out: IngestAnomaly[] = [];
  for (const { a, b, uuids } of shared.values()) {
    const fa = files[a]!;
    const fb = files[b]!;
    const ridsB = new Set(fb.requestIds);
    let sharedRids = 0;
    for (const rid of new Set(fa.requestIds)) if (ridsB.has(rid)) sharedRids += 1;
    // Sorted so the detail string is identical whichever order the sweep read the
    // two files in — src/cli.ts de-duplicates the ledger on (kind, detail).
    const [pa, pb] = fa.path <= fb.path ? [fa, fb] : [fb, fa];
    out.push({
      kind: "fork_replay",
      detail:
        `sessions ${pa.sessionId} and ${pb.sessionId} share ${uuids} line uuid(s) across two ` +
        `distinct files (${sharedRids} shared requestId(s)) — the child replays the parent's ` +
        `history, so the same billed call is on disk twice. Collapsed by the global request_id ` +
        `primary key; a (session_id, request_id) key would count it twice. Files: ${pa.path} | ${pb.path}`,
    });
  }
  out.sort((x, y) => x.detail.localeCompare(y.detail));
  return out;
}

// ---------------------------------------------------------------------------
// session-level driver
// ---------------------------------------------------------------------------

/**
 * Ingest one session's whole artefact set into a buffered batch.
 *
 * Ordering matters: main transcripts first (they produce the turn timeline, the
 * workflow launches and the tool_use -> promptId map that sub-agents inherit),
 * then workflow agents, then Agent-tool agents.
 *
 * `plan` carries the two corpus-wide decisions a single session cannot make (see
 * {@link CorpusPlan}). It is optional so a test can drive one session standalone;
 * omitted, the session owns every file it enumerates and pairs runs with its own
 * state files only — the pre-plan behaviour.
 */
export async function ingestSession(
  session: SessionCorpus,
  plan?: CorpusPlan,
  /** Injected clock — only the §5.6 in-flight age guard reads it. Defaults to now. */
  now?: Date,
): Promise<IngestBatch> {
  const batch: IngestBatch = {
    requests: [],
    turns: [],
    agentRuns: [],
    workflowRuns: [],
    workflowPhases: [],
    taskEvents: [],
    taskPlants: [],
    anomalies: [],
    files: [],
    stats: { lines: 0, blank: 0, parsed: 0, malformed: 0, truncatedTail: 0 },
    incompleteFiles: [],
    skippedFiles: [],
  };

  /** Does THIS session ingest that path? False => another session owns it, and
   *  the path is recorded so the sweeper withholds its watermark here. */
  const owns = (path: string): boolean => {
    if ((plan?.owner.get(path) ?? session.sessionId) === session.sessionId) return true;
    batch.skippedFiles.push(path);
    return false;
  };

  const addStats = (s: ParseStats): void => {
    batch.stats.lines += s.lines;
    batch.stats.blank += s.blank;
    batch.stats.parsed += s.parsed;
    batch.stats.malformed += s.malformed;
    batch.stats.truncatedTail += s.truncatedTail;
  };

  /** Stats + the watermark veto + the fork index, so no call site can forget one. */
  const absorb = (ing: TranscriptIngest): void => {
    addStats(ing.stats);
    if (!ing.complete) batch.incompleteFiles.push(ing.path);
    batch.files.push({
      path: ing.path,
      sessionId: session.sessionId,
      uuids: ing.uuids,
      requestIds: ing.requests.map((r) => r.request_id),
    });
  };

  // --- main transcripts -----------------------------------------------------
  const toolUsePrompts = new Map<string, string>();
  const launchesByRun = new Map<string, WorkflowLaunch[]>();

  for (const path of session.mainTranscripts) {
    if (!owns(path)) continue;
    const main = await ingestMainTranscript(path, session.sessionId);
    batch.requests.push(...main.requests);
    batch.turns.push(...main.turns);
    batch.taskEvents.push(...main.taskEvents);
    batch.taskPlants.push(...main.taskPlants);
    batch.anomalies.push(...main.anomalies);
    absorb(main);
    for (const [k, v] of main.toolUsePrompts) toolUsePrompts.set(k, v);
    for (const l of main.launches) {
      const list = launchesByRun.get(l.run_id);
      if (list === undefined) launchesByRun.set(l.run_id, [l]);
      else list.push(l);
    }
  }

  // Corpus-wide when a plan is supplied: a run's state file and its transcript
  // directory routinely live under DIFFERENT sessions (G-PHASE §2b).
  const stateByRun = plan?.stateByRun ?? new Map(session.states.map((s) => [s.runId, s]));

  // --- workflow agents ------------------------------------------------------
  for (const wf of session.workflows) {
    // A symlinked run directory is enumerated under every session that links it;
    // exactly one of them ingests it, so the rest skip the whole run rather than
    // re-reading its agents and racing for `agent_run.session_id`.
    const agents = wf.agents.filter((a) => owns(a.transcriptPath));
    if (wf.agents.length > 0 && agents.length === 0) continue;
    const state = stateByRun.get(wf.runId) ?? null;
    const launches = launchesByRun.get(wf.runId) ?? [];
    // The state file records only the MOST RECENT launch's taskId, and
    // workflowProgress[] describes only that launch. Agents on disk from an
    // earlier relaunch cannot be told apart, so they attribute to the same
    // wf_launch_id. Recorded here rather than pretended away.
    const latest = launches.at(-1) ?? null;
    const wfLaunchId = state?.taskId ?? latest?.wf_launch_id ?? wf.runId;
    if (launches.length > 1) {
      // A relaunch under one runId is a FACT about how workflows are driven, not a
      // record mismatch, and it is what makes `wf_relaunch_orphan` possible below.
      // The detail deliberately names neither the launch count nor the winning
      // wf_launch_id: both move between sweeps, and a detail that moves defeats the
      // (kind, detail) dedup that keeps a nightly cron from growing the ledger —
      // which is how 25 rows accumulated for 22 runs.
      batch.anomalies.push({
        kind: "wf_relaunch_detected",
        detail: `run ${wf.runId}: relaunched under the same runId; wf_<runId>.json describes only the last launch, so earlier agents cannot be told apart`,
      });
    }

    const intervals = new Map<string, AgentIntervalFromTranscript>();
    for (const agent of agents) {
      const ing = await ingestAgentTranscript(agent.transcriptPath, {
        origin: "subagent",
        sessionId: session.sessionId,
        promptId: latest?.prompt_id ?? null,
        agentId: agent.agentId,
        runId: wf.runId,
        wfLaunchId,
      });
      batch.requests.push(...ing.requests);
      batch.anomalies.push(...ing.anomalies);
      absorb(ing);
      intervals.set(agent.agentId, {
        agentId: agent.agentId,
        firstTs: ing.firstTs,
        lastTs: ing.lastTs,
      });
    }

    const built = buildAgentRuns({
      sessionId: session.sessionId,
      agents,
      intervals,
      state,
      runId: wf.runId,
      wfLaunchId,
      launchPromptId: latest?.prompt_id ?? null,
      toolUsePrompts,
      journalResultAgentIds: wf.journalResultAgentIds,
      now,
    });
    batch.agentRuns.push(...built.rows);
    batch.anomalies.push(...built.anomalies);

    const { started_at, ended_at } = deriveRunInterval(built.rows);
    batch.workflowRuns.push({
      run_id: wf.runId,
      wf_launch_id: wfLaunchId,
      session_id: session.sessionId,
      workflow_name: state?.workflowName ?? latest?.workflow_name ?? null,
      transcript_dir: state?.transcriptDir ?? latest?.transcript_dir ?? wf.dir,
      default_model: state?.defaultModel ?? null,
      launch_prompt_id: latest?.prompt_id ?? null,
      n_phases_planned: state?.phases.length ?? null,
      started_at,
      ended_at,
    });
    if (state !== null) {
      batch.workflowPhases.push(
        ...buildWorkflowPhases(wf.runId, wfLaunchId, state.phases, state.defaultModel),
      );
    }
  }

  // --- Agent-tool sub-agents ------------------------------------------------
  // The G-FORK §3.4 alias is exactly this shape: a fork's `subagents/` holds a
  // SYMLINK to the parent's still-open transcript, so the file is enumerated twice
  // and `agent_run.session_id` used to go to whichever session was walked first.
  const ownAgents = session.agents.filter((a) => owns(a.transcriptPath));
  const intervals = new Map<string, AgentIntervalFromTranscript>();
  for (const agent of ownAgents) {
    const launchPromptId =
      agent.meta?.toolUseId !== null && agent.meta?.toolUseId !== undefined
        ? (toolUsePrompts.get(agent.meta.toolUseId) ?? null)
        : null;
    const ing = await ingestAgentTranscript(agent.transcriptPath, {
      origin: "subagent",
      sessionId: session.sessionId,
      promptId: launchPromptId,
      agentId: agent.agentId,
    });
    batch.requests.push(...ing.requests);
    batch.anomalies.push(...ing.anomalies);
    absorb(ing);
    intervals.set(agent.agentId, {
      agentId: agent.agentId,
      firstTs: ing.firstTs,
      lastTs: ing.lastTs,
    });
  }
  if (ownAgents.length > 0) {
    const built = buildAgentRuns({
      sessionId: session.sessionId,
      agents: ownAgents,
      intervals,
      toolUsePrompts,
    });
    batch.agentRuns.push(...built.rows);
    batch.anomalies.push(...built.anomalies);
  }

  // Last, over the whole session: a requestId collision routinely straddles two
  // files (a sidechain replay of a main-transcript line), so it is only visible
  // once every file's rows are in one array. The batch that leaves here carries
  // ONE row per (request_id, winning model) — never a blend of two.
  const resolved = resolveRidCollisions(batch.requests);
  batch.requests = resolved.requests;
  batch.anomalies.push(...resolved.anomalies);
  return batch;
}

// ---------------------------------------------------------------------------
// writers — prepared-statement loops, meant to run inside ONE sweep transaction
// ---------------------------------------------------------------------------

/** Same total the in-code resolver ranks on, spelled for SQLite. */
const EXCLUDED_TOTAL = "(excluded.in_tok + excluded.out_tok + excluded.cw_tok + excluded.cr_tok)";
const CURRENT_TOTAL = "(request.in_tok + request.out_tok + request.cw_tok + request.cr_tok)";

/** The incoming row belongs to a DIFFERENT call than the stored one. */
const RID_CONTESTED = "excluded.model <> request.model";

/**
 * ...and it wins: larger total takes the row, model id ASC breaks an exact tie.
 * Identical to {@link resolveRidCollisions}'s ranking, deliberately — one rule,
 * both places a collision can appear.
 */
const RID_TAKEOVER = `${RID_CONTESTED} AND (${EXCLUDED_TOTAL} > ${CURRENT_TOTAL}
        OR (${EXCLUDED_TOTAL} = ${CURRENT_TOTAL} AND excluded.model < request.model))`;

/** MAX only within one model; across models the whole row moves together. */
const counter = (col: string): string =>
  `${col} = CASE WHEN ${RID_CONTESTED} THEN (CASE WHEN ${RID_TAKEOVER} THEN excluded.${col} ELSE request.${col} END)
                 ELSE MAX(request.${col}, excluded.${col}) END`;

/**
 * THE statement (§5.2). MAX per counter per requestId; `session_id` is never
 * re-attributed (first-seen owns a fork replay); `tid`/`attr` are COALESCE'd so
 * an attribution pass that already ran is not undone by a re-sweep.
 *
 * The one exception to MAX is a MODEL DISAGREEMENT. Rows sharing a model are
 * cumulative snapshots of one call and MAX is their truth; rows carrying different
 * models are two different calls that collided on one requestId (~1 in 16k [CA]),
 * and MAX-ing each counter independently across them builds a row that never
 * happened — `in_tok` from one call, `out_tok` from the other, priced at whichever
 * arrived first. So the row is taken whole or not at all: counters, model,
 * model_family, ts and message_id move together with the winner.
 *
 * `resolveRidCollisions` already does this for rows inside one sweep. This is the
 * case it cannot see: the two calls arriving in DIFFERENT sweeps, where the loser
 * is already committed. Same tie-break, so both agree on the winner.
 */
export const UPSERT_REQUEST_SQL = `
INSERT INTO request (
  request_id, message_id, is_sidechain, session_id, prompt_id, origin,
  agent_id, run_id, wf_launch_id, model, model_family,
  attribution_agent, attribution_skill, ts,
  in_tok, out_tok, cw_tok, cr_tok
) VALUES (
  $request_id, $message_id, $is_sidechain, $session_id, $prompt_id, $origin,
  $agent_id, $run_id, $wf_launch_id, $model, $model_family,
  $attribution_agent, $attribution_skill, $ts,
  $in_tok, $out_tok, $cw_tok, $cr_tok
)
ON CONFLICT(request_id) DO UPDATE SET
  ${counter("out_tok")},
  ${counter("in_tok")},
  ${counter("cw_tok")},
  ${counter("cr_tok")},
  model        = CASE WHEN ${RID_TAKEOVER} THEN excluded.model        ELSE request.model        END,
  model_family = CASE WHEN ${RID_TAKEOVER} THEN excluded.model_family ELSE request.model_family END,
  ts           = CASE WHEN ${RID_TAKEOVER} THEN excluded.ts           ELSE request.ts           END,
  message_id   = CASE WHEN ${RID_TAKEOVER} THEN excluded.message_id
                      ELSE COALESCE(request.message_id, excluded.message_id) END,
  prompt_id    = COALESCE(request.prompt_id,    excluded.prompt_id),
  agent_id     = COALESCE(request.agent_id,     excluded.agent_id),
  run_id       = COALESCE(request.run_id,       excluded.run_id),
  wf_launch_id = COALESCE(request.wf_launch_id, excluded.wf_launch_id),
  attribution_agent = COALESCE(request.attribution_agent, excluded.attribution_agent),
  attribution_skill = COALESCE(request.attribution_skill, excluded.attribution_skill)
`;

// ---------------------------------------------------------------------------
// §5.2 SECOND dedup pass — ccusage's message_id fallback
// ---------------------------------------------------------------------------

/**
 * The two dedup passes are complementary, not redundant:
 *
 *   pass 1 (the `request_id` PK + MAX upsert) collapses the SAME request id seen
 *          in more than one file — the fork/resume replay;
 *   pass 2 (this one) collapses DIFFERENT request ids carrying the same
 *          `message.id` — the sidechain replay, where a sub-agent line re-emits a
 *          parent message under a NEW requestId and so slips straight past the PK.
 *
 * [FS][TESTED] is why ccusage keys on `hash(message_id, request_id)` with an
 * explicit message_id-only fallback; skipping it double-counts in the sub-agent
 * path that is 79.2% of cost.
 *
 * Losers are KEPT (never deleted) and demoted to `attr='replay'`, which is what
 * `v_request_live` filters at the base of the view stack — auditable, and
 * idempotent because the winner is recomputed from the same inputs every sweep.
 */
const REPLAY_RANKED_CTE = `
WITH ranked AS (
  SELECT r.request_id, r.message_id,
         ROW_NUMBER() OVER (
           PARTITION BY r.message_id
           ORDER BY r.is_sidechain ASC,                                  -- (1) main beats sidechain
                    (r.in_tok + r.out_tok + r.cw_tok + r.cr_tok) DESC,   -- (2) larger total wins
                    r.request_id ASC                                     -- (3) stable tie-break
         ) AS rn
    FROM request r
    JOIN (SELECT message_id FROM request
           WHERE message_id IS NOT NULL
           GROUP BY message_id HAVING COUNT(*) > 1) g ON g.message_id = r.message_id
)`;

/**
 * One row per contested message_id, for the anomaly ledger.
 *
 * The `ORDER BY` inside GROUP_CONCAT is load-bearing, not cosmetic. `loser_ids`
 * goes verbatim into the anomaly detail, and src/cli.ts de-duplicates the ledger
 * on (kind, detail) — so an unordered concat re-logs the SAME collapse as a new
 * anomaly whenever SQLite happens to visit the rows in a different order, and a
 * daily cron grows the ledger forever. (SQLite has supported ordered aggregates
 * since 3.44; bun ships 3.51.)
 */
export const SELECT_REPLAY_GROUPS_SQL = `${REPLAY_RANKED_CTE}
SELECT w.message_id AS message_id,
       w.request_id AS winner_id,
       (SELECT COUNT(*)              FROM ranked l
         WHERE l.message_id = w.message_id AND l.rn > 1) AS n_losers,
       (SELECT GROUP_CONCAT(l.request_id ORDER BY l.request_id) FROM ranked l
         WHERE l.message_id = w.message_id AND l.rn > 1) AS loser_ids
  FROM ranked w WHERE w.rn = 1`;

export const MARK_REPLAYS_SQL = `${REPLAY_RANKED_CTE}
UPDATE request SET attr = 'replay'
 WHERE attr <> 'replay'
   AND request_id IN (SELECT request_id FROM ranked WHERE rn > 1)`;

/**
 * The inverse, so the pass is genuinely idempotent rather than merely repeatable:
 * a row that was a loser on an earlier sweep and is the winner now (its counters
 * grew past the incumbent's on a later read) must come back out of `replay`.
 * It returns to `'none'`; the §5.4 attribution pass re-derives the real class.
 */
export const UNMARK_REPLAYS_SQL = `${REPLAY_RANKED_CTE}
UPDATE request SET attr = 'none'
 WHERE attr = 'replay'
   AND request_id NOT IN (SELECT request_id FROM ranked WHERE rn > 1)`;

export interface ReplayGroup {
  message_id: string;
  winner_id: string;
  n_losers: number;
  loser_ids: string | null;
}

/**
 * Run the §5.2 second dedup pass over the whole `request` table.
 *
 * Whole-table rather than per-batch on purpose: the two rows sharing a
 * `message.id` routinely arrive from different files, and on an incremental
 * sweep from different sweeps entirely. Cheap — `ix_req_msg` covers the grouping.
 *
 * Caller supplies the transaction (the sweeper owns it, §5.2).
 */
export function markSidechainReplays(db: Database): ReplayGroup[] {
  const groups = db.query<ReplayGroup, []>(SELECT_REPLAY_GROUPS_SQL).all();
  db.query(MARK_REPLAYS_SQL).run();
  db.query(UNMARK_REPLAYS_SQL).run();
  return groups.filter((g) => g.n_losers > 0);
}

/** `anomaly` rows for a replay pass — loud, per §5.2, never a silent collapse. */
export function replayAnomalies(groups: ReplayGroup[]): IngestAnomaly[] {
  return groups.map((g) => ({
    kind: "sidechain_replay" as const,
    detail:
      `message ${g.message_id}: ${g.n_losers} request(s) replay an already-counted message ` +
      `under a new request_id — kept for audit as attr='replay' and excluded from every sum ` +
      `(winner ${g.winner_id}; replays ${g.loser_ids ?? ""})`,
  }));
}

const INTERVAL_RANK = `CASE excluded.interval_src WHEN 'workflow_progress' THEN 2 WHEN 'transcript' THEN 1 ELSE 0 END
   >= CASE agent_run.interval_src WHEN 'workflow_progress' THEN 2 WHEN 'transcript' THEN 1 ELSE 0 END`;

const PHASE_RANK = `CASE excluded.phase_conf WHEN 'exact' THEN 2 WHEN 'inferred' THEN 1 ELSE 0 END
   >= CASE agent_run.phase_conf WHEN 'exact' THEN 2 WHEN 'inferred' THEN 1 ELSE 0 END`;

/**
 * `agent_run` upsert with SOURCE PRECEDENCE, so a re-sweep can never downgrade a
 * row: a transcript-derived interval never overwrites a `workflow_progress` one,
 * and an inferred phase never overwrites an exact one. Everything else is
 * COALESCE (first non-null wins) except `ended_at`, which must stay refreshable —
 * a live agent's last line moves forward on every sweep (§5.3).
 */
export const UPSERT_AGENT_RUN_SQL = `
INSERT INTO agent_run (
  agent_id, session_id, run_id, wf_launch_id, agent_type, spawn_depth,
  launch_prompt_id, transcript_path, status, label,
  started_at, ended_at, interval_src, queued_at, attempt, reported_tokens,
  phase_idx, phase_title, phase_conf
) VALUES (
  $agent_id, $session_id, $run_id, $wf_launch_id, $agent_type, $spawn_depth,
  $launch_prompt_id, $transcript_path, $status, $label,
  $started_at, $ended_at, $interval_src, $queued_at, $attempt, $reported_tokens,
  $phase_idx, $phase_title, $phase_conf
)
ON CONFLICT(agent_id) DO UPDATE SET
  run_id       = COALESCE(agent_run.run_id,       excluded.run_id),
  wf_launch_id = COALESCE(agent_run.wf_launch_id, excluded.wf_launch_id),
  agent_type   = COALESCE(excluded.agent_type,    agent_run.agent_type),
  spawn_depth  = MAX(agent_run.spawn_depth, excluded.spawn_depth),
  launch_prompt_id = COALESCE(agent_run.launch_prompt_id, excluded.launch_prompt_id),
  transcript_path  = COALESCE(excluded.transcript_path, agent_run.transcript_path),
  status       = COALESCE(excluded.status, agent_run.status),
  label        = COALESCE(excluded.label,  agent_run.label),
  queued_at    = COALESCE(excluded.queued_at, agent_run.queued_at),
  attempt      = COALESCE(excluded.attempt,   agent_run.attempt),
  reported_tokens = COALESCE(excluded.reported_tokens, agent_run.reported_tokens),
  started_at   = CASE WHEN ${INTERVAL_RANK}
                      THEN COALESCE(excluded.started_at, agent_run.started_at)
                      ELSE agent_run.started_at END,
  ended_at     = CASE WHEN ${INTERVAL_RANK}
                      THEN COALESCE(excluded.ended_at, agent_run.ended_at)
                      ELSE agent_run.ended_at END,
  interval_src = CASE WHEN ${INTERVAL_RANK} THEN excluded.interval_src ELSE agent_run.interval_src END,
  phase_idx    = CASE WHEN ${PHASE_RANK} THEN excluded.phase_idx   ELSE agent_run.phase_idx   END,
  phase_title  = CASE WHEN ${PHASE_RANK} THEN excluded.phase_title ELSE agent_run.phase_title END,
  phase_conf   = CASE WHEN ${PHASE_RANK} THEN excluded.phase_conf  ELSE agent_run.phase_conf  END
`;

export const UPSERT_WORKFLOW_RUN_SQL = `
INSERT INTO workflow_run (
  run_id, wf_launch_id, session_id, workflow_name, transcript_dir, default_model,
  launch_prompt_id, n_phases_planned, started_at, ended_at
) VALUES (
  $run_id, $wf_launch_id, $session_id, $workflow_name, $transcript_dir, $default_model,
  $launch_prompt_id, $n_phases_planned, $started_at, $ended_at
)
ON CONFLICT(run_id, wf_launch_id) DO UPDATE SET
  workflow_name    = COALESCE(excluded.workflow_name,  workflow_run.workflow_name),
  transcript_dir   = COALESCE(excluded.transcript_dir, workflow_run.transcript_dir),
  default_model    = COALESCE(excluded.default_model,  workflow_run.default_model),
  launch_prompt_id = COALESCE(workflow_run.launch_prompt_id, excluded.launch_prompt_id),
  n_phases_planned = COALESCE(excluded.n_phases_planned, workflow_run.n_phases_planned),
  started_at = CASE WHEN workflow_run.started_at IS NULL THEN excluded.started_at
                    WHEN excluded.started_at IS NULL     THEN workflow_run.started_at
                    ELSE MIN(workflow_run.started_at, excluded.started_at) END,
  ended_at   = CASE WHEN workflow_run.ended_at IS NULL THEN excluded.ended_at
                    WHEN excluded.ended_at IS NULL     THEN workflow_run.ended_at
                    ELSE MAX(workflow_run.ended_at, excluded.ended_at) END
`;

export const UPSERT_WORKFLOW_PHASE_SQL = `
INSERT INTO workflow_phase (run_id, wf_launch_id, phase_idx, title, detail, model)
VALUES ($run_id, $wf_launch_id, $phase_idx, $title, $detail, $model)
ON CONFLICT(run_id, wf_launch_id, phase_idx) DO UPDATE SET
  title  = excluded.title,
  detail = COALESCE(excluded.detail, workflow_phase.detail),
  model  = COALESCE(excluded.model,  workflow_phase.model)
`;

export const INSERT_TASK_EVENT_SQL = `
INSERT INTO task_event (session_id, task_num, ts, kind, from_status, to_status, source)
VALUES ($session_id, $task_num, $ts, $kind, $from_status, $to_status, 'transcript')
ON CONFLICT(session_id, task_num, ts, to_status, kind) DO NOTHING
`;

/**
 * Mint the `session_task` alias a planted `est_tid` names (§3.2 step 6).
 *
 * Two properties, both deliberate:
 *
 *  - **`WHERE EXISTS` on `task`, not a bare INSERT.** `task_alias.tid` is a foreign
 *    key and `est audit` treats an alias pointing at nothing as damage; a transcript
 *    is untrusted input, so a plant naming a tid this database has never minted (a
 *    typo, a tid from another machine, a `task` row since deleted) is DROPPED rather
 *    than written — and REPORTED, as `anomaly(plant_unlinked)`, because a silent drop
 *    is indistinguishable from the ingest bug this whole pass exists to fix.
 *
 *    **A drop DOES self-heal, on the next sweep that re-reads the file.** `readJsonl`
 *    streams every transcript from byte zero; `sweep_state.bytes_read` is only the
 *    "unchanged, skip it" comparison, never a seek offset. So a session that is still
 *    being written is re-read in full on the next sweep and the plant is retried then,
 *    by which time the `task` row it names normally exists. The only case that does not
 *    retry by itself is a SETTLED file — byte-identical, so the sweep skips it — and
 *    `est backfill` re-reads those. The anomaly detail says exactly this.
 *  - **`OR IGNORE`, not an upsert.** Re-sweeping the same transcript must be a no-op
 *    (§5.8), and `ux_alias_exclusive` also makes a task number that was re-planted at
 *    a SECOND tid a conflict — which is exactly right. First plant wins, and the
 *    second is not silently re-pointed at another task's actual.
 */
export const INSERT_TASK_ALIAS_SQL = `
INSERT OR IGNORE INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
SELECT $tid, 'session_task', $session_id, $task_num, $ts, 'sweeper'
 WHERE EXISTS (SELECT 1 FROM task WHERE tid = $tid)
`;

/**
 * Point every unlinked `task_event` at the task its `session_task` alias names.
 *
 * A targeted UPDATE, which `task_event` permits — unlike `estimate`/`outcome`/
 * `task_scope`, it carries no append-only trigger, because it is a DERIVED record of
 * the harness's own lifecycle stream rather than a claim anyone is scored against.
 * It has to be an update rather than a wider insert: the alias is planted at
 * `TaskUpdate` time, so the create event that precedes it — and every event swept
 * before the plant landed — was necessarily written with a NULL tid.
 *
 * `ux_alias_exclusive` guarantees at most one `session_task` alias per
 * (session_id, local_id), so the correlated subquery can never pick between two tids.
 *
 * **The WHERE clause is written to match `ix_task_event_unlinked` (schema v13) exactly.**
 * `tid IS NULL` alone is unindexable, so this statement used to re-scan every lifecycle
 * row in the database on every sweep to find the few that had just become linkable. The
 * partial index covers precisely the unlinked rows and shrinks as they are linked —
 * which only holds while both predicates here stay verbatim identical to the index's.
 */
export const BACKFILL_TASK_EVENT_TID_SQL = `
UPDATE task_event SET tid = (
  SELECT a.tid FROM task_alias a
   WHERE a.id_kind = 'session_task'
     AND a.session_id = task_event.session_id
     AND a.local_id = task_event.task_num)
 WHERE tid IS NULL
   AND task_num <> ''
   AND EXISTS (
     SELECT 1 FROM task_alias a
      WHERE a.id_kind = 'session_task'
        AND a.session_id = task_event.session_id
        AND a.local_id = task_event.task_num)
`;

/**
 * Link the lifecycle stream to the tasks the aliases name, and report how many rows
 * moved. Call it INSIDE the sweep's transaction, AFTER every batch has been written
 * and after the hook spool has drained — both of those are `task_event` writers, and
 * a plant seen in one file routinely links events written from another.
 */
export function backfillTaskEventTids(db: Database): number {
  db.prepare(BACKFILL_TASK_EVENT_TID_SQL).run();
  return Number(db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0);
}

export const INSERT_ANOMALY_SQL = `
INSERT INTO anomaly (ts, kind, detail) VALUES ($ts, $kind, $detail)
`;

function bind<T extends object>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[`$${k}`] = v;
  return out;
}

/**
 * Write a buffered batch's ROWS. Call this INSIDE the sweep's single transaction:
 *
 *   db.transaction(() => writeBatch(db, batch))();
 *
 * Every statement is idempotent, so a re-sweep of an unchanged corpus is a no-op
 * and a re-sweep of a grown corpus only ever raises counters (§2 recoverability).
 *
 * `batch.anomalies` is deliberately NOT written here. It used to be, and the sweeper
 * still could not use that path: `anomaly` has no natural key, so a plain INSERT
 * per sweep grows the ledger by a copy a day and breaks "a re-sweep is a no-op".
 * `insertAnomalies` (src/cli.ts) is the one writer, de-duplicating on
 * (kind, detail) — and two writers for one table, only one of them idempotent, is
 * how a caller ends up choosing the wrong one.
 */
export function writeBatch(db: Database, batch: IngestBatch): { anomalies: IngestAnomaly[] } {
  const requestStmt = db.prepare(UPSERT_REQUEST_SQL);
  for (const row of batch.requests) requestStmt.run(bind(row) as never);

  const turnStmt = db.prepare(UPSERT_TURN_SQL);
  for (const row of batch.turns) turnStmt.run(bind(row) as never);

  // workflow_run before agent_run/workflow_phase: both reference it.
  const runStmt = db.prepare(UPSERT_WORKFLOW_RUN_SQL);
  for (const row of batch.workflowRuns) runStmt.run(bind(row) as never);

  const phaseStmt = db.prepare(UPSERT_WORKFLOW_PHASE_SQL);
  for (const row of batch.workflowPhases) phaseStmt.run(bind(row) as never);

  const agentStmt = db.prepare(UPSERT_AGENT_RUN_SQL);
  for (const row of batch.agentRuns) agentStmt.run(bind(row) as never);

  const eventStmt = db.prepare(INSERT_TASK_EVENT_SQL);
  for (const row of batch.taskEvents) eventStmt.run(bind(row) as never);

  // Aliases AFTER the events, so a plant and the events it links can arrive in one
  // batch; the linking UPDATE itself is a sweep-level pass (`backfillTaskEventTids`),
  // not a per-batch one, because the two halves routinely land in different chunks.
  const aliasStmt = db.prepare(INSERT_TASK_ALIAS_SQL);
  const knownTid = db.prepare<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM task WHERE tid = ?",
  );
  const anomalies: IngestAnomaly[] = [];
  for (const row of batch.taskPlants) {
    // Asked BEFORE the insert, so the report can name what the statement's own
    // existence guard would otherwise swallow. One indexed PK probe per plant, and a
    // sweep sees a handful of plants at most.
    if ((knownTid.get(row.tid)?.n ?? 0) === 0) {
      anomalies.push({
        kind: "plant_unlinked",
        detail:
          `a planted est_tid names a task this database has no row for (session ${row.session_id}, ` +
          `harness task ${row.task_num}) — no session_task alias was minted, so this task's ` +
          `lifecycle events stay unlinked and §6.2's completion signal cannot fire for it. ` +
          `Retried automatically on the next sweep that re-reads the transcript (every sweep ` +
          `reads a growing file in full); a SETTLED file is skipped as unchanged, so run ` +
          `\`est backfill\` if the tid has since appeared`,
      });
      continue;
    }
    aliasStmt.run(bind(row) as never);
  }
  return { anomalies };
}

/**
 * Discovery anomalies carry kinds `anomaly.kind` already documents
 * (`dangling_symlink`, `spawn_depth_gt1`, `wf_record_mismatch`, ...), so they pass
 * through unchanged — the ledger is deliberately open-vocabulary (§2), and
 * `IngestAnomaly["kind"]` includes `AnomalyKind` so no cast is needed to say so.
 */
export function toIngestAnomalies(anomalies: DiscoveryAnomaly[]): IngestAnomaly[] {
  return anomalies.map((a) => ({
    kind: a.kind,
    detail: a.detail,
    ...(a.path === undefined ? {} : { path: a.path }),
  }));
}

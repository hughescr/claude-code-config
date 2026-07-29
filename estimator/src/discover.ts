/**
 * Corpus discovery — token-estimation-design-r3.md §5.1, §5.6.
 *
 * Enumerates the transcript corpus that is ground truth for everything else, and
 * parses `wf_<runId>.json` for the *structure* of a workflow run. It reads files;
 * it never touches the database and never computes a token number.
 *
 * Layout, verified against files on this machine [R2][R3]:
 *
 *   ~/.claude/projects/<munged-cwd>/
 *     <sessionId>.jsonl                                  main transcript
 *     <sessionId>/
 *       workflows/wf_<runId>.json                        workflow state file
 *       workflows/scripts/*.js                           authored script (not read here)
 *       subagents/agent-<agentId>.jsonl                  Agent-tool subagent
 *       subagents/agent-<agentId>.meta.json              {agentType,description?,toolUseId?,spawnDepth,model?}
 *       subagents/workflows/<runId>/journal.jsonl        {type,key,agentId} — NO timestamps
 *       subagents/workflows/<runId>/agent-<agentId>.jsonl
 *       subagents/workflows/<runId>/agent-<agentId>.meta.json
 *
 * One session can write under up to four munged project dirs [FS], so sessions are
 * keyed by sessionId and merged across project dirs rather than nested under one.
 *
 * **Every path here is realpath'd, DIRECTORIES INCLUDED.** `Dirent.isDirectory()`
 * reports the link's own type, not the target's, so a walk that tests it alone
 * silently drops a symlinked directory — and on this machine a resumed session
 * links `subagents/workflows/<runId>` back at the original session's directory
 * instead of copying it. `resolveDir`/`entryDir` follow those links and a dead
 * one becomes an anomaly. Following them means one physical artefact set is
 * legitimately enumerated under several sessions; rows dedup on their own primary
 * keys and `countFile` keeps the census honest. WHICH of those sessions owns the
 * rows is decided once, corpus-wide, by `sessionIdFromPath` + `planCorpus`
 * (src/ingest.ts) — never by whichever session the walk reached first.
 *
 * ===========================================================================
 * THE BAN LIST — §5.6, enforced by construction below, not by good intentions
 * ===========================================================================
 * `wf_<runId>.json` carries harness *aggregates* that are measurably wrong:
 * `totalTokens` was 5.2x low and `agentCount` 2.4x low on runs that were
 * demonstrably live [A][B], `status` said "killed" while the run was running, and
 * the per-agent `workflowProgress[].tokens` read only ~0.73x of the true Work-CET
 * on a verified agent — it appears to track `cache_creation` alone [R3].
 *
 *   NEVER READ (run level):  agentCount · status · totalTokens · durationMs ·
 *                            result · totalToolCalls · summary · logs
 *   NEVER SUMMED (agent):    workflowProgress[].tokens — surfaced ONLY as
 *                            `reportedTokensAuditOnly`, whose name is the guard,
 *                            and stored in agent_run.reported_tokens for audit.
 *
 *   SANCTIONED (static plan):     runId · taskId · workflowName · transcriptDir ·
 *                                 defaultModel · phases[]
 *   SANCTIONED (workflowProgress structural): agentId · index · label · phaseIndex ·
 *                                 phaseTitle · model · state · startedAt · queuedAt ·
 *                                 attempt · durationMs
 *
 * `readWorkflowState` builds its result field-by-field from those allowlists, so a
 * banned key cannot reach a caller even by accident. `BANNED_WF_RUN_FIELDS` exists
 * so a test can assert that.
 *
 *   >>> Structure from the state file; numbers ALWAYS recomputed from transcripts.
 *
 * Zero npm dependencies: node:fs only.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";

/** Corpus root. `EST_PROJECTS` overrides it (tests, alternate corpora). */
export const PROJECTS_ROOT: string =
  process.env.EST_PROJECTS ?? join(homedir(), ".claude", "projects");

/** `~/.claude/tasks/<session>/<taskId>.json` — the §5.7 cross-session identity read path. */
export const TASKS_ROOT: string = process.env.EST_TASKS ?? join(homedir(), ".claude", "tasks");

/**
 * Run-level fields of wf_<runId>.json that must never be read. Exported so the
 * ban is testable rather than merely documented (§5.6).
 */
export const BANNED_WF_RUN_FIELDS = [
  "agentCount",
  "status",
  "totalTokens",
  "durationMs",
  "result",
  "totalToolCalls",
  "summary",
  "logs",
] as const;

/**
 * The one per-agent field that is read but must never be summed. It is exposed
 * under a deliberately unusable name (`reportedTokensAuditOnly`) so no aggregate
 * can pick it up by pattern.
 */
export const NEVER_SUMMED_WF_AGENT_FIELDS = ["tokens"] as const;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_JSONL_RE = /^agent-(.+)\.jsonl$/;
const AGENT_META_RE = /^agent-(.+)\.meta\.json$/;
const WF_STATE_RE = /^(wf_.+)\.json$/;

export type AnomalyKind =
  | "dangling_symlink"
  | "wf_record_mismatch"
  | "spawn_depth_gt1"
  | "wf_state_unparseable"
  | "agent_meta_unparseable"
  | "orphan_agent_transcript";

export interface DiscoveryAnomaly {
  kind: AnomalyKind;
  detail: string;
  path?: string;
}

/** `agent-<id>.meta.json`. Every field is optional: the fact sheet's shape is not
 *  what workflow agents actually get — theirs is `{agentType, spawnDepth, model}`
 *  with no `description`/`toolUseId` [R2]. */
export interface AgentMeta {
  agentType: string | null;
  description: string | null;
  /** The parent's `Agent` tool_use id — resolves the launching turn (§5.3). */
  toolUseId: string | null;
  spawnDepth: number;
  /** Alias as written in meta (`opus`), not the resolved id. */
  model: string | null;
}

export interface AgentTranscript {
  agentId: string;
  /** realpath-canonicalised (agent_run.transcript_path). */
  transcriptPath: string;
  metaPath: string | null;
  meta: AgentMeta | null;
  /** Set for agents living under subagents/workflows/<runId>/; null for Agent-tool ones. */
  runId: string | null;
}

export interface WorkflowDir {
  runId: string;
  dir: string;
  /** agentIds listed in journal.jsonl — the cross-check for workflowProgress (§5.1). */
  journalAgentIds: string[];
  agents: AgentTranscript[];
}

/** A `phases[]` entry of the authored script's `meta.phases`. Static plan (§5.6). */
export interface WorkflowPlanPhase {
  /** 0-based array index — the `workflow_phase.phase_idx` written to the DB. */
  phaseIdx: number;
  title: string;
  detail: string | null;
  model: string | null;
}

/**
 * One `workflowProgress[]` record of `type:"workflow_agent"`, structural fields only.
 *
 * PHASE INDEX BASE — a spec deviation, deliberate and verified. §5.6 asserts
 * "the declared meta.phases index == workflowProgress.phaseIndex". On this machine
 * that is off by one: `phases[]` is 0-based (`phases[0].title === "Research"`) while
 * `workflowProgress[].phaseIndex` is 1-based (`phaseIndex: 1` <-> "Research"),
 * confirmed on every run in two state files. Taking §5.6 literally would shift every
 * `v_phase_actual` / `v_block_accuracy` join by one phase. `phaseIdx` is therefore
 * NORMALISED to the 0-based `phases[]` index and cross-checked against
 * `phases[phaseIdx].title`; `rawPhaseIndex` preserves what was written.
 */
export interface WorkflowProgressAgent {
  agentId: string;
  index: number | null;
  label: string | null;
  /** 0-based, normalised, title-validated. NULL when it could not be resolved. */
  phaseIdx: number | null;
  /** Exactly as written in the file (1-based on this machine). */
  rawPhaseIndex: number | null;
  phaseTitle: string | null;
  agentType: string | null;
  /** Resolved full model id, e.g. "claude-opus-5[1m]" — not an alias. */
  model: string | null;
  state: string | null;
  /** ISO-8601, converted from epoch ms. */
  startedAt: string | null;
  queuedAt: string | null;
  attempt: number | null;
  durationMs: number | null;
  /** Derived: startedAt + durationMs. The §5.3 primary agent interval. */
  endedAt: string | null;
  /**
   * workflowProgress[].tokens. AUDIT ONLY — NEVER SUMMED (§5.6). Measured at
   * ~0.73x of the true Work-CET for one verified agent; it tracks
   * cache_creation alone. Goes to agent_run.reported_tokens and nowhere else.
   */
  reportedTokensAuditOnly: number | null;
}

export interface WorkflowState {
  path: string;
  runId: string;
  /** Top-level `taskId` — the relaunch discriminator (`wf_launch_id`). */
  taskId: string | null;
  workflowName: string | null;
  transcriptDir: string | null;
  defaultModel: string | null;
  phases: WorkflowPlanPhase[];
  progressAgents: WorkflowProgressAgent[];
}

export interface SessionCorpus {
  sessionId: string;
  /** Every munged project dir this session appears under (up to four [FS]). */
  projectDirs: string[];
  mainTranscripts: string[];
  agents: AgentTranscript[];
  workflows: WorkflowDir[];
  states: WorkflowState[];
}

export interface Corpus {
  root: string;
  sessions: SessionCorpus[];
  anomalies: DiscoveryAnomaly[];
  /** Census inputs for `sweep_census` (§5.8). */
  census: { files: number; bytes: number; sessions: number; oldestMtime: string | null };
}

// ---------------------------------------------------------------------------
// small fs helpers — every one of them non-throwing: discovery must survive a
// corpus that is being written to and pruned underneath it.
// ---------------------------------------------------------------------------

function readDirSafe(dir: string): { name: string; isDir: boolean; isLink: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
      isLink: e.isSymbolicLink(),
    }));
  } catch {
    return [];
  }
}

/** realpath + stat. Returns null for a dangling symlink or a vanished file. */
function resolveFile(path: string): { real: string; bytes: number; mtimeMs: number } | null {
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    if (!st.isFile()) return null;
    return { real, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * The directory counterpart of {@link resolveFile}, and the reason it exists:
 * `Dirent.isDirectory()` reports the **link's** own type, so a SYMLINKED
 * directory answers `false` and a walk that tests `isDir` alone drops it —
 * silently, which §2 forbids. Resumed sessions link their run directory back to
 * the original session's rather than copying it (contrast §5.7's tasks dir, which
 * IS copied), so this is the normal case, not an exotic one.
 *
 * Returns the canonical path, or null when the link dangles or names a non-dir.
 */
function resolveDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Canonical directory for a `readDirSafe` entry, following a directory symlink.
 * Null means "not a directory" — either a plain file, or a link that dangles or
 * points at a file. `wasLink` lets the caller tell a dangling link (loud) from a
 * plain file (skip quietly).
 */
function entryDir(
  parent: string,
  e: { name: string; isDir: boolean; isLink: boolean },
): { dir: string | null; wasLink: boolean } {
  const path = join(parent, e.name);
  if (e.isDir) return { dir: path, wasLink: false };
  if (!e.isLink) return { dir: null, wasLink: false };
  return { dir: resolveDir(path), wasLink: true };
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function epochToIso(v: unknown): string | null {
  const ms = num(v);
  if (ms === null || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// agent meta
// ---------------------------------------------------------------------------

export function parseAgentMeta(path: string): { meta: AgentMeta | null; anomaly?: DiscoveryAnomaly } {
  const raw = readJsonSafe(path);
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return {
      meta: null,
      anomaly: { kind: "agent_meta_unparseable", detail: "not a JSON object", path },
    };
  }
  const o = raw as Record<string, unknown>;
  return {
    meta: {
      agentType: str(o.agentType),
      description: str(o.description),
      toolUseId: str(o.toolUseId),
      spawnDepth: num(o.spawnDepth) ?? 1,
      model: str(o.model),
    },
  };
}

// ---------------------------------------------------------------------------
// wf_<runId>.json — allowlist parsing (the ban list is enforced HERE)
// ---------------------------------------------------------------------------

function parsePlanPhases(raw: unknown): WorkflowPlanPhase[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      phaseIdx: i, // 0-based array index — the canonical phase key
      title: str(o.title) ?? `phase ${i}`,
      detail: str(o.detail),
      model: str(o.model),
    };
  });
}

/**
 * Resolve a 1-based `phaseIndex` onto the 0-based `phases[]` array, validating by
 * title. Returns the 0-based index, or null when nothing lines up (caller logs
 * `wf_record_mismatch`).
 */
function normalisePhaseIdx(
  rawPhaseIndex: number | null,
  phaseTitle: string | null,
  phases: WorkflowPlanPhase[],
): { phaseIdx: number | null; mismatch: string | null } {
  if (phases.length === 0) {
    // No declared plan to align against: trust the 1-based convention observed
    // corpus-wide and record it, rather than dropping the phase entirely.
    return rawPhaseIndex === null
      ? { phaseIdx: null, mismatch: null }
      : { phaseIdx: rawPhaseIndex - 1, mismatch: null };
  }

  if (rawPhaseIndex !== null) {
    const zero = rawPhaseIndex - 1;
    if (zero >= 0 && zero < phases.length) {
      if (phaseTitle === null || phases[zero]!.title === phaseTitle) {
        return { phaseIdx: zero, mismatch: null };
      }
    }
  }

  // The 1-based reading failed. Fall back to a title lookup before giving up.
  if (phaseTitle !== null) {
    const byTitle = phases.findIndex((p) => p.title === phaseTitle);
    if (byTitle >= 0) {
      return {
        phaseIdx: byTitle,
        mismatch: `phaseIndex=${rawPhaseIndex} does not resolve to phaseTitle=${JSON.stringify(phaseTitle)}; matched by title at phases[${byTitle}]`,
      };
    }
  }

  return {
    phaseIdx: null,
    mismatch: `phaseIndex=${rawPhaseIndex} / phaseTitle=${JSON.stringify(phaseTitle)} matches no entry in phases[] (n=${phases.length})`,
  };
}

/**
 * Parse a workflow state file for STRUCTURE ONLY. Builds its result from the
 * sanctioned-field allowlists; banned run-level aggregates are never touched.
 */
export function readWorkflowState(
  path: string,
  runIdHint?: string,
): { state: WorkflowState | null; anomalies: DiscoveryAnomaly[] } {
  const anomalies: DiscoveryAnomaly[] = [];
  const raw = readJsonSafe(path);
  if (raw === undefined || raw === null || typeof raw !== "object") {
    anomalies.push({ kind: "wf_state_unparseable", detail: "not a JSON object", path });
    return { state: null, anomalies };
  }
  const o = raw as Record<string, unknown>;

  const phases = parsePlanPhases(o.phases);
  const progressAgents: WorkflowProgressAgent[] = [];

  const progress = Array.isArray(o.workflowProgress) ? o.workflowProgress : [];
  for (const entry of progress) {
    if (entry === null || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;

    // `type:"workflow_phase"` records are a second view of the same static plan
    // `phases[]` already carries; nothing downstream ever needed both, so they are
    // skipped rather than parsed into a map no reader consumed.
    if (p.type !== "workflow_agent") continue;

    const agentId = str(p.agentId);
    if (agentId === null) {
      anomalies.push({
        kind: "wf_record_mismatch",
        detail: "workflowProgress workflow_agent record has no agentId",
        path,
      });
      continue;
    }

    const rawPhaseIndex = num(p.phaseIndex);
    const phaseTitle = str(p.phaseTitle);
    const { phaseIdx, mismatch } = normalisePhaseIdx(rawPhaseIndex, phaseTitle, phases);
    if (mismatch !== null) {
      anomalies.push({ kind: "wf_record_mismatch", detail: `${agentId}: ${mismatch}`, path });
    }

    const startedAt = epochToIso(p.startedAt);
    const durationMs = num(p.durationMs);
    const endedAt =
      startedAt !== null && durationMs !== null && durationMs >= 0
        ? new Date(Date.parse(startedAt) + durationMs).toISOString()
        : null;

    progressAgents.push({
      agentId,
      index: num(p.index),
      label: str(p.label),
      phaseIdx,
      rawPhaseIndex,
      phaseTitle,
      agentType: str(p.agentType),
      model: str(p.model),
      state: str(p.state),
      startedAt,
      queuedAt: epochToIso(p.queuedAt),
      attempt: num(p.attempt),
      durationMs,
      endedAt,
      // AUDIT ONLY. Never summed — see the field's doc comment.
      reportedTokensAuditOnly: num(p.tokens),
    });
  }

  const runId = str(o.runId) ?? runIdHint ?? basename(path).replace(/\.json$/, "");

  return {
    state: {
      path,
      runId,
      taskId: str(o.taskId),
      workflowName: str(o.workflowName),
      transcriptDir: str(o.transcriptDir),
      defaultModel: str(o.defaultModel),
      phases,
      progressAgents,
    },
    anomalies,
  };
}

// ---------------------------------------------------------------------------
// journal.jsonl — agentId cross-check only (no timestamps, no phases in it [R2])
// ---------------------------------------------------------------------------

export function readJournalAgentIds(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const id = str(o.agentId);
      if (id !== null) ids.add(id);
    } catch {
      // A journal line torn by a live write is not worth failing discovery over.
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// directory walks
// ---------------------------------------------------------------------------

interface Census {
  files: number;
  bytes: number;
  oldestMtime: number;
  /** Canonical paths already counted — see {@link countFile}. */
  seen: Set<string>;
}

/**
 * Count one resolved file into the census, ONCE per canonical path.
 *
 * Following directory symlinks (see `resolveDir`) means the same physical run
 * directory is legitimately enumerated under both the original session and the
 * session that resumed it. The rows dedup downstream on their own primary keys,
 * but the §5.8 census is a raw file/byte count and would double it — turning a
 * corpus that merely gained a resume into one that looks like it grew.
 */
function countFile(
  census: Census,
  resolved: { real: string; bytes: number; mtimeMs: number },
): void {
  if (census.seen.has(resolved.real)) return;
  census.seen.add(resolved.real);
  census.files += 1;
  census.bytes += resolved.bytes;
  census.oldestMtime = Math.min(census.oldestMtime, resolved.mtimeMs);
}

function collectAgents(
  dir: string,
  runId: string | null,
  anomalies: DiscoveryAnomaly[],
  census: Census,
): AgentTranscript[] {
  const entries = readDirSafe(dir);
  const metas = new Map<string, string>();
  for (const e of entries) {
    const m = AGENT_META_RE.exec(e.name);
    if (m !== null) metas.set(m[1]!, join(dir, e.name));
  }

  const agents: AgentTranscript[] = [];
  for (const e of entries) {
    const m = AGENT_JSONL_RE.exec(e.name);
    if (m === null) continue;
    const agentId = m[1]!;
    const path = join(dir, e.name);
    const resolved = resolveFile(path);
    if (resolved === null) {
      // Dangling symlink or a file pruned mid-walk: real, 3 in one session [FS].
      anomalies.push({
        kind: "dangling_symlink",
        detail: `agent ${agentId}: transcript unreadable`,
        path,
      });
      continue;
    }
    countFile(census, resolved);

    const metaPath = metas.get(agentId) ?? null;
    let meta: AgentMeta | null = null;
    if (metaPath !== null) {
      const parsed = parseAgentMeta(metaPath);
      meta = parsed.meta;
      if (parsed.anomaly !== undefined) anomalies.push(parsed.anomaly);
    }
    if (meta !== null && meta.spawnDepth > 1) {
      // Unobserved to date — §5.1 says log it if it ever appears.
      anomalies.push({
        kind: "spawn_depth_gt1",
        detail: `agent ${agentId}: spawnDepth=${meta.spawnDepth}`,
        path,
      });
    }

    agents.push({ agentId, transcriptPath: resolved.real, metaPath, meta, runId });
  }
  return agents;
}

function collectWorkflowDirs(
  subagentsDir: string,
  anomalies: DiscoveryAnomaly[],
  census: Census,
): WorkflowDir[] {
  const wfRoot = join(subagentsDir, "workflows");
  const out: WorkflowDir[] = [];
  for (const e of readDirSafe(wfRoot)) {
    // A resumed session links <runId> at the original session's directory, so a
    // raw `isDir` test would drop the whole run — every agent, every token —
    // without so much as an anomaly. Follow the link; a dead one is LOUD.
    const { dir: resolvedDir, wasLink } = entryDir(wfRoot, e);
    if (resolvedDir === null) {
      if (wasLink) {
        anomalies.push({
          kind: "dangling_symlink",
          detail: `workflow run ${e.name}: run directory unreadable (link target gone or not a directory)`,
          path: join(wfRoot, e.name),
        });
      }
      continue;
    }
    const runId = e.name;
    const dir = resolvedDir;
    const journalPath = join(dir, "journal.jsonl");
    out.push({
      runId,
      dir,
      journalAgentIds:
        resolveFile(journalPath) === null ? [] : readJournalAgentIds(journalPath),
      agents: collectAgents(dir, runId, anomalies, census),
    });
  }
  return out;
}

function collectStates(
  sessionDir: string,
  anomalies: DiscoveryAnomaly[],
  census: Census,
): WorkflowState[] {
  const wfDir = join(sessionDir, "workflows");
  const out: WorkflowState[] = [];
  for (const e of readDirSafe(wfDir)) {
    if (e.isDir) continue;
    const m = WF_STATE_RE.exec(e.name);
    if (m === null) continue;
    const path = join(wfDir, e.name);
    const resolved = resolveFile(path);
    if (resolved === null) {
      anomalies.push({ kind: "dangling_symlink", detail: "workflow state unreadable", path });
      continue;
    }
    countFile(census, resolved);

    const { state, anomalies: stateAnomalies } = readWorkflowState(resolved.real, m[1]!);
    anomalies.push(...stateAnomalies);
    if (state !== null) out.push(state);
  }
  return out;
}

/**
 * Cross-check workflowProgress against journal.jsonl (§5.1): a disagreement
 * writes `wf_record_mismatch` and **the journal wins** — it is written per agent
 * as the agent starts, where the state file can be stale on a killed run.
 */
export function crossCheckWorkflowAgents(
  session: SessionCorpus,
): { anomalies: DiscoveryAnomaly[] } {
  const anomalies: DiscoveryAnomaly[] = [];
  const stateByRun = new Map<string, WorkflowState>();
  for (const s of session.states) stateByRun.set(s.runId, s);

  for (const wf of session.workflows) {
    const state = stateByRun.get(wf.runId);
    if (state === undefined) continue;

    const onDisk = new Set(wf.agents.map((a) => a.agentId));
    const inJournal = new Set(wf.journalAgentIds);
    const inProgress = new Set(state.progressAgents.map((a) => a.agentId));

    // Journal wins: anything the journal lists but workflowProgress omits is a
    // stale state file, and its agents fall back to interval clustering (§5.6).
    for (const id of inJournal) {
      if (!inProgress.has(id)) {
        anomalies.push({
          kind: "wf_record_mismatch",
          detail: `run ${wf.runId}: agent ${id} in journal.jsonl but absent from workflowProgress[] (journal wins; agent falls back to interval clustering)`,
          path: state.path,
        });
      }
    }
    for (const id of inProgress) {
      if (!onDisk.has(id)) {
        anomalies.push({
          kind: "orphan_agent_transcript",
          detail: `run ${wf.runId}: workflowProgress[] names agent ${id} with no agent-${id}.jsonl on disk`,
          path: wf.dir,
        });
      }
    }
  }
  return { anomalies };
}

// ---------------------------------------------------------------------------
// top-level discovery
// ---------------------------------------------------------------------------

/** Enumerate the whole corpus. Pure read; safe to run against a live corpus. */
export function discoverCorpus(root: string = PROJECTS_ROOT): Corpus {
  const anomalies: DiscoveryAnomaly[] = [];
  const census: Census = {
    files: 0,
    bytes: 0,
    oldestMtime: Number.POSITIVE_INFINITY,
    seen: new Set<string>(),
  };
  const sessions = new Map<string, SessionCorpus>();

  const ensure = (sessionId: string, projectDir: string): SessionCorpus => {
    let s = sessions.get(sessionId);
    if (s === undefined) {
      s = {
        sessionId,
        projectDirs: [],
        mainTranscripts: [],
        agents: [],
        workflows: [],
        states: [],
      };
      sessions.set(sessionId, s);
    }
    if (!s.projectDirs.includes(projectDir)) s.projectDirs.push(projectDir);
    return s;
  };

  for (const projectEntry of readDirSafe(root)) {
    // Symlinked project dirs resolve like any other (see `resolveDir`).
    const { dir: projectDir, wasLink: projectWasLink } = entryDir(root, projectEntry);
    if (projectDir === null) {
      if (projectWasLink) {
        anomalies.push({
          kind: "dangling_symlink",
          detail: "project directory unreadable (link target gone or not a directory)",
          path: join(root, projectEntry.name),
        });
      }
      continue;
    }

    for (const entry of readDirSafe(projectDir)) {
      const path = join(projectDir, entry.name);
      // `isDir` is false for a symlinked <sessionId>/ dir, and falling through to
      // the `.jsonl` test below would drop that session's ENTIRE subagents +
      // workflows + states set. Resolve first, decide after.
      const { dir: sessionDir, wasLink } = entryDir(projectDir, entry);

      if (sessionDir === null) {
        // <sessionId>.jsonl — and nothing else. `.jsonl.wakatime` sidecars and
        // sessions-index.json are not transcripts.
        if (!entry.name.endsWith(".jsonl")) {
          if (wasLink && SESSION_ID_RE.test(entry.name)) {
            anomalies.push({
              kind: "dangling_symlink",
              detail: "session artefact directory unreadable (link target gone or not a directory)",
              path,
            });
          }
          continue;
        }
        const sessionId = entry.name.slice(0, -".jsonl".length);
        if (!SESSION_ID_RE.test(sessionId)) continue;
        const resolved = resolveFile(path);
        if (resolved === null) {
          anomalies.push({ kind: "dangling_symlink", detail: "main transcript unreadable", path });
          continue;
        }
        countFile(census, resolved);
        ensure(sessionId, projectDir).mainTranscripts.push(resolved.real);
        continue;
      }

      // <sessionId>/ — the per-session artefact dir.
      if (!SESSION_ID_RE.test(entry.name)) continue;
      const session = ensure(entry.name, projectDir);
      const subagentsDir = join(sessionDir, "subagents");

      session.agents.push(...collectAgents(subagentsDir, null, anomalies, census));
      session.workflows.push(...collectWorkflowDirs(subagentsDir, anomalies, census));
      session.states.push(...collectStates(sessionDir, anomalies, census));
    }
  }

  for (const session of sessions.values()) {
    anomalies.push(...crossCheckWorkflowAgents(session).anomalies);
  }

  return {
    root,
    sessions: [...sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    anomalies,
    census: {
      files: census.files,
      bytes: census.bytes,
      sessions: sessions.size,
      oldestMtime: Number.isFinite(census.oldestMtime)
        ? new Date(census.oldestMtime).toISOString()
        : null,
    },
  };
}

/**
 * Every on-disk artefact one session's ingest reads: transcripts AND state files.
 *
 * ONE definition, because there used to be two — an `allTranscriptPaths(corpus)`
 * here and a private `sessionFiles(session)` in the sweeper — and they disagreed
 * about state files. A watermark set is only correct if it covers exactly what was
 * read, so the set the sweeper fingerprints and the set anything else enumerates
 * must be the same function, not two that happen to agree today.
 */
export function sessionFiles(session: SessionCorpus): string[] {
  const out: string[] = [...session.mainTranscripts];
  for (const a of session.agents) out.push(a.transcriptPath);
  for (const wf of session.workflows) for (const a of wf.agents) out.push(a.transcriptPath);
  for (const st of session.states) out.push(st.path);
  return out;
}

/**
 * The session that OWNS a canonical artefact path — i.e. the session named by the
 * path itself, which for a symlinked transcript is the session the link points AT.
 *
 * This is the tie-break for G-FORK §3.4's second aliasing mechanism: when a session
 * forks while a sub-agent is in flight, the child's `subagents/` gets a SYMLINK to
 * the parent's still-open transcript, so one physical file is enumerated under two
 * sessions and whichever the sweeper reached first used to win `agent_run.session_id`.
 * The link target's session is the one that actually launched the agent, so it owns
 * the row; the losing claim becomes `anomaly(symlink_alias)` (see `planCorpus`).
 *
 * Deepest-first, because an agent transcript's path contains its session id as a
 * DIRECTORY (`…/<sessionId>/subagents/…`) while a main transcript carries it in the
 * basename (`…/<sessionId>.jsonl`) — and a project dir munged from a cwd could in
 * principle contain a uuid-shaped segment of its own.
 */
export function sessionIdFromPath(path: string): string | null {
  const parts = path.split(sep);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]!;
    if (SESSION_ID_RE.test(part)) return part;
    if (part.endsWith(".jsonl")) {
      const stem = part.slice(0, -".jsonl".length);
      if (SESSION_ID_RE.test(stem)) return stem;
    }
  }
  return null;
}

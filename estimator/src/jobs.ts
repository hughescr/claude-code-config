/**
 * src/jobs.ts — P2.9: the `~/.claude/jobs` reconcile, RECONCILE-ONLY.
 *
 * "Reconcile, never replace" (§7.1's disposition, upheld). The jobs feed is a
 * SECOND OPINION on timing — never a source of truth for a token, a status or a
 * task. Two things live here:
 *
 *  1. {@link reconcileJobs} — the sweep-time ingest. Globs `~/.claude/jobs/*\/state.json`,
 *     upserts one `job_run` row and its `job_item` children per job directory, and
 *     binds a job to the task ALREADY aliased to its `sessionId`/`resumeSessionId`
 *     (never mints one). No match, or more than one candidate task, writes
 *     `anomaly(kind='job_unjoined')` and NO alias row — the reconcile never invents
 *     a binding. Once bound, a binding is never re-evaluated or withdrawn: it is
 *     enforced physically by `ux_alias_exclusive` and the point of a reconcile-only
 *     feed is that later ambiguity in the corpus does not erase evidence already
 *     recorded.
 *  2. {@link jobsRetroPanel} — the retro-time comparison. For every BOUND job, reads
 *     the sibling `timeline.jsonl` fresh (it is not stored: no schema surface for
 *     it exists, and re-parsing ~100 lines for a handful of bound jobs at retro
 *     cadence costs nothing) and reports the jobs-reported span
 *     (`firstTerminalAt - createdAt`, plus the timeline's own state trace) beside
 *     our derived `run_segment`/`task.started_at` numbers for the SAME task. A
 *     disagreement is reported, never corrected (§7.1) — it is evidence about our
 *     interval model, which is exactly the check this section exists for.
 *
 * `state.json.tokens` is a HARNESS AGGREGATE, stored in `job_run.reported_tokens`
 * for audit and NEVER summed — same ban as `wf_*.json.totalTokens` and
 * `workflowProgress[].tokens` (§1, §5.6).
 *
 * Grain: job, not item. An earlier spec draft assumed item grain from a partial
 * population of `fan[].startedAt`; re-measured against the corpus, population was
 * far below the activation threshold (`job_item_min_pop` in `config`). `job_item`
 * rows are still populated (so the population fraction is a query, not a
 * re-measurement) but nothing in Phase 2 branches on it.
 *
 * The estimator never writes to `~/.claude/jobs/`. Read-only, always.
 *
 * Zero npm dependencies: bun:sqlite + node builtins only.
 */

import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IngestAnomaly } from "./ingest.ts";

/** `~/.claude/jobs`. `EST_JOBS` overrides it (tests, alternate corpora). */
export const JOBS_ROOT: string = process.env.EST_JOBS ?? join(homedir(), ".claude", "jobs");

// ---------------------------------------------------------------------------
// parsing — small, LOCAL helpers rather than importing discover.ts's private
// ones: this module owns a different file shape and should not couple its
// parsing to the transcript corpus reader's internals.
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `0` is "unset" in this feed, never the epoch (state.json's own convention). */
function epochToIso(v: number | undefined): string | null {
  if (v === undefined || v <= 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

interface FanItem {
  id: string;
  kind: string | null;
  label: string | null;
  startedAt: number;
  doneAt: number;
}

function parseFan(raw: unknown): FanItem[] {
  if (!Array.isArray(raw)) return [];
  const out: FanItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const f = entry as Record<string, unknown>;
    const id = str(f.id);
    if (id === null) continue;
    out.push({
      id,
      kind: str(f.kind),
      label: str(f.label),
      startedAt: num(f.startedAt) ?? 0,
      doneAt: num(f.doneAt) ?? 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// P2.9 — sweep-time reconcile
// ---------------------------------------------------------------------------

export interface JobsReconcileResult {
  dirs_read: number;
  parsed: number;
  malformed: number;
  /** Newly bound this sweep. */
  bound: number;
  /** Already bound from a prior sweep — not re-evaluated (see module doc). */
  already_bound: number;
  /** No candidate task, or more than one — `job_unjoined`, no alias row. */
  unjoined: number;
  n_items: number;
  n_items_started: number;
  anomalies: IngestAnomaly[];
}

/**
 * The zero result — exported so the sweep can declare `let jobs = emptyJobsResult()`
 * outside the `db.transaction(...)` that assigns it, the same shape `drainSpool`'s
 * `emptyDrain()` and `drainOtel`'s `emptyOtelIngest()` already have.
 */
export function emptyJobsResult(): JobsReconcileResult {
  return {
    dirs_read: 0,
    parsed: 0,
    malformed: 0,
    bound: 0,
    already_bound: 0,
    unjoined: 0,
    n_items: 0,
    n_items_started: 0,
    anomalies: [],
  };
}

const UPSERT_JOB_RUN_SQL = `
INSERT INTO job_run (job_id, session_id, resume_session_id, name, state, backend, template,
                      created_at, updated_at, first_terminal_at, reported_tokens,
                      n_items, n_items_started, tid)
VALUES ($job_id, $session_id, $resume_session_id, $name, $state, $backend, $template,
        $created_at, $updated_at, $first_terminal_at, $reported_tokens,
        $n_items, $n_items_started, $tid)
ON CONFLICT(job_id) DO UPDATE SET
  session_id = excluded.session_id, resume_session_id = excluded.resume_session_id,
  name = excluded.name, state = excluded.state, backend = excluded.backend,
  template = excluded.template, created_at = excluded.created_at,
  updated_at = excluded.updated_at, first_terminal_at = excluded.first_terminal_at,
  reported_tokens = excluded.reported_tokens, n_items = excluded.n_items,
  n_items_started = excluded.n_items_started,
  -- Never un-bind: a tid resolved on an earlier sweep is evidence, and a later
  -- sweep that (for whatever reason) recomputed NULL must not erase it.
  tid = COALESCE(job_run.tid, excluded.tid)
`;

const UPSERT_JOB_ITEM_SQL = `
INSERT INTO job_item (job_id, item_id, kind, label, started_at, done_at)
VALUES ($job_id, $item_id, $kind, $label, $started_at, $done_at)
ON CONFLICT(job_id, item_id) DO UPDATE SET
  kind = excluded.kind, label = excluded.label,
  -- Ratchet, like the counters in src/ingest.ts: a real timestamp never regresses
  -- to NULL because a later read of the SAME fan entry happened to show 0.
  started_at = COALESCE(job_item.started_at, excluded.started_at),
  done_at = COALESCE(job_item.done_at, excluded.done_at)
`;

const INSERT_JOB_ALIAS_SQL = `
INSERT INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
VALUES ($tid, 'job', $session_id, $local_id, $first_seen, 'sweeper')
ON CONFLICT(id_kind, session_id, local_id, tid) DO NOTHING
`;

/**
 * Read `<jobsRoot>/<id>/state.json` for every job directory and upsert `job_run`
 * / `job_item`, binding to a tid only when EXACTLY one task is already aliased to
 * the job's `sessionId` or `resumeSessionId` (§P2.9). Call INSIDE the sweep's
 * transaction, same discipline as `drainSpool`/`drainOtel` — this function opens none
 * of its own, so a bare call runs one commit per upsert and a crash mid-loop leaves a
 * tid bound to a partially written `job_run`/`job_item` set.
 *
 * A missing `jobsRoot` (no `~/.claude/jobs` at all) is the same "not configured"
 * degrade as OTEL with no receiver: an empty result, no anomaly, nothing blocks.
 */
export function reconcileJobs(db: Database, jobsRoot: string, nowIso: string): JobsReconcileResult {
  const result = emptyJobsResult();

  let dirs: string[];
  try {
    dirs = readdirSync(jobsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result;
  }

  const alreadyBound = new Set<string>(
    db
      .query<{ local_id: string }, []>("SELECT local_id FROM task_alias WHERE id_kind = 'job'")
      .all()
      .map((r) => r.local_id),
  );

  const jobRunStmt = db.prepare(UPSERT_JOB_RUN_SQL);
  const jobItemStmt = db.prepare(UPSERT_JOB_ITEM_SQL);
  const aliasStmt = db.prepare(INSERT_JOB_ALIAS_SQL);
  const findTidStmt = db.prepare<{ tid: string }, [string, string]>(
    "SELECT DISTINCT tid FROM task_alias WHERE session_id IN (?, ?) AND session_id <> ''",
  );

  for (const jobId of dirs) {
    result.dirs_read += 1;
    const raw = readJsonSafe(join(jobsRoot, jobId, "state.json"));
    if (typeof raw !== "object" || raw === null) {
      result.malformed += 1;
      continue;
    }
    const s = raw as Record<string, unknown>;
    const sessionId = str(s.sessionId);
    const resumeSessionId = str(s.resumeSessionId);
    const fan = parseFan(s.fan);
    const nStarted = fan.filter((f) => f.startedAt > 0).length;

    result.parsed += 1;
    result.n_items += fan.length;
    result.n_items_started += nStarted;

    let tid: string | null = null;
    if (alreadyBound.has(jobId)) {
      result.already_bound += 1;
    } else if (sessionId !== null || resumeSessionId !== null) {
      const candidates = new Set<string>(
        findTidStmt.all(sessionId ?? "", resumeSessionId ?? "").map((r) => r.tid),
      );
      if (candidates.size === 1) {
        tid = [...candidates][0]!;
        aliasStmt.run({
          $tid: tid,
          $session_id: sessionId ?? resumeSessionId,
          $local_id: jobId,
          $first_seen: nowIso,
        } as never);
        result.bound += 1;
      } else {
        result.unjoined += 1;
        result.anomalies.push({
          kind: "job_unjoined",
          detail:
            candidates.size === 0
              ? `job ${jobId} (session ${sessionId ?? resumeSessionId ?? "?"}) matches no tracked task`
              : `job ${jobId} (session ${sessionId ?? resumeSessionId ?? "?"}) matches ${candidates.size} tracked tasks — ambiguous`,
        });
      }
    } else {
      result.unjoined += 1;
      result.anomalies.push({
        kind: "job_unjoined",
        detail: `job ${jobId} carries no sessionId/resumeSessionId to bind on`,
      });
    }

    jobRunStmt.run({
      $job_id: jobId,
      $session_id: sessionId,
      $resume_session_id: resumeSessionId,
      $name: str(s.name),
      $state: str(s.state),
      $backend: str(s.backend),
      $template: str(s.template),
      $created_at: str(s.createdAt),
      $updated_at: str(s.updatedAt),
      $first_terminal_at: str(s.firstTerminalAt),
      $reported_tokens: num(s.tokens),
      $n_items: fan.length,
      $n_items_started: nStarted,
      $tid: tid,
    } as never);

    for (const f of fan) {
      jobItemStmt.run({
        $job_id: jobId,
        $item_id: f.id,
        $kind: f.kind,
        $label: f.label,
        $started_at: epochToIso(f.startedAt),
        $done_at: epochToIso(f.doneAt),
      } as never);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// P2.9 — retro-time comparison
// ---------------------------------------------------------------------------

interface TimelineLine {
  at: string;
  state: string;
  detail: string | null;
}

/** `{at, state, detail, text}` lines. Malformed lines are skipped, not raised —
 *  this is a read-only comparison feed, not the ledger, and a torn tail here is
 *  nothing like a torn transcript. */
function readTimeline(jobsRoot: string, jobId: string): TimelineLine[] {
  let text: string;
  try {
    text = readFileSync(join(jobsRoot, jobId, "timeline.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: TimelineLine[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      const at = str(o.at);
      const state = str(o.state);
      if (at !== null && state !== null) out.push({ at, state, detail: str(o.detail) });
    } catch {
      // one torn/malformed line; the rest of the trace is still useful
    }
  }
  return out;
}

function spanSeconds(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 1000);
}

export interface JobsPanelRow {
  job_id: string;
  tid: string;
  name: string | null;
  /** jobs-reported span: `firstTerminalAt - createdAt`. NULL if either is absent
   *  (a job still open has no `firstTerminalAt`). */
  jobs_created_at: string | null;
  jobs_first_terminal_at: string | null;
  jobs_span_s: number | null;
  /** ours: P2.8's `task.started_at`, and the union of `run_segment` for this tid. */
  our_started_at: string | null;
  our_segment_start: string | null;
  our_segment_end: string | null;
  our_active_s: number | null;
  /** `jobs_span_s - our_active_s`. Positive: the job's wall-clock span exceeds our
   *  active time (idle/blocked gaps, expected). Negative is the interesting case —
   *  it means we measured MORE active time than the job's own span admits. */
  delta_span_s: number | null;
  timeline_n_lines: number;
  timeline_first_working_at: string | null;
  timeline_last_state: string | null;
  timeline_last_at: string | null;
}

/**
 * The retro-time comparison, over every BOUND job. Reported, never corrected
 * (§7.1) — nothing here writes back to `task`, `run_segment` or `job_run`.
 */
export function jobsRetroPanel(db: Database, jobsRoot: string): JobsPanelRow[] {
  const jobs = db
    .query<
      { job_id: string; tid: string; name: string | null; created_at: string | null; first_terminal_at: string | null },
      []
    >("SELECT job_id, tid, name, created_at, first_terminal_at FROM job_run WHERE tid IS NOT NULL")
    .all();
  if (jobs.length === 0) return [];

  const segStmt = db.prepare<
    { min_start: string | null; max_end: string | null; sum_active: number | null },
    [string]
  >("SELECT MIN(started_at) AS min_start, MAX(ended_at) AS max_end, SUM(active_s) AS sum_active FROM run_segment WHERE tid = ?");
  const taskStmt = db.prepare<{ started_at: string | null }, [string]>(
    "SELECT started_at FROM task WHERE tid = ?",
  );

  const rows: JobsPanelRow[] = [];
  for (const j of jobs) {
    const seg = segStmt.get(j.tid);
    const task = taskStmt.get(j.tid);
    const jobsSpan = spanSeconds(j.created_at, j.first_terminal_at);
    const ourActive = seg?.sum_active ?? null;

    const timeline = readTimeline(jobsRoot, j.job_id);
    const firstWorking = timeline.find((t) => t.state === "working")?.at ?? null;
    const last = timeline.length > 0 ? timeline[timeline.length - 1]! : null;

    rows.push({
      job_id: j.job_id,
      tid: j.tid,
      name: j.name,
      jobs_created_at: j.created_at,
      jobs_first_terminal_at: j.first_terminal_at,
      jobs_span_s: jobsSpan,
      our_started_at: task?.started_at ?? null,
      our_segment_start: seg?.min_start ?? null,
      our_segment_end: seg?.max_end ?? null,
      our_active_s: ourActive,
      delta_span_s: jobsSpan !== null && ourActive !== null ? jobsSpan - ourActive : null,
      timeline_n_lines: timeline.length,
      timeline_first_working_at: firstWorking,
      timeline_last_state: last?.state ?? null,
      timeline_last_at: last?.at ?? null,
    });
  }
  return rows;
}

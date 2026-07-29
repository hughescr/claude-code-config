/**
 * src/close.ts — `est close`: finalize a task, BY ARITHMETIC (P1.7, §6.2).
 *
 * **There is no flag that accepts a token count, a cost, or a velocity, and there
 * never will be.** No agent grades its own work and Claude never self-reports
 * tokens; every number written to `outcome` here is deterministic SQL over harness
 * logs. That is the whole anti-Goodhart argument, and this file is where it either
 * holds or quietly stops holding.
 *
 * Two further invariants live here:
 *
 *  - **First-estimate-wins.** `outcome.eid_at_start = MIN(eid)`. Accuracy is judged
 *    against that estimate, always, no matter how many refinements followed. An
 *    estimator that could re-point mid-task would converge on the actual by
 *    construction and measure nothing.
 *  - **Reopen is a revision, never an edit.** A later `est close` appends
 *    `revision + 1`; `v_outcome_current` and `v_velocity` read only the latest.
 *    Premature finalization is therefore self-healing rather than fatal — late
 *    tokens produce a new revision, and nothing is ever overwritten.
 */

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attributeTasks } from "./attribute.ts";
import { intervalUnion, taskIntervals } from "./burn.ts";
import { getConfig } from "./db.ts";
import { InvariantError, isoNow } from "./tasks.ts";

/** Where the harness records live sessions (`<pid>.json`); `EST_SESSIONS` overrides. */
export const SESSIONS_ROOT: string =
  process.env.EST_SESSIONS ?? join(homedir(), ".claude", "sessions");

/** §6.2: a task with no completion signal is still closeable once this stale. */
export const STALE_CLOSE_HOURS = 48;

export type FinalStatus = "completed" | "abandoned" | "deleted" | "reopened";

export interface QuiescenceReport {
  ok: boolean;
  /** Human-readable conditions that FAILED. Empty when `ok`. */
  failing: string[];
  completion_signal: boolean;
  stale_hours: number | null;
  quiet_minutes: number | null;
  open_turns: number;
  live_pids: number[];
  nonterminal_agents: number;
}

function parseMs(ts: string | null | undefined): number {
  if (ts === null || ts === undefined) return Number.NaN;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : Number.NaN;
}

/** `parseMs`, with a missing or unreadable timestamp reading as "infinitely long ago". */
function seenMs(ts: string | null | undefined): number {
  const t = parseMs(ts);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Sessions with a live process, from `~/.claude/sessions/<pid>.json`. */
export function livePidsForSessions(sessionIds: readonly string[], root = SESSIONS_ROOT): number[] {
  if (sessionIds.length === 0) return [];
  const wanted = new Set(sessionIds);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    // No sessions directory is not "no live sessions proven" — but it is the only
    // answer available, and the other four quiescence conditions are the teeth.
    return [];
  }
  const live: number[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pid = Number.parseInt(name.slice(0, -5), 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(root, name), "utf8"));
    } catch {
      continue;
    }
    if (doc === null || typeof doc !== "object") continue;
    const o = doc as Record<string, unknown>;
    const sid =
      typeof o.sessionId === "string"
        ? o.sessionId
        : typeof o.session_id === "string"
          ? o.session_id
          : null;
    if (sid === null || !wanted.has(sid)) continue;
    try {
      process.kill(pid, 0);
      live.push(pid);
    } catch {
      // ESRCH: an orphaned session file whose process is gone — §6.1's crash signal.
    }
  }
  return live;
}

/**
 * The §6.2 finalization gate, evaluated in full so a failure can NAME the condition
 * that blocked it rather than saying "not quiet yet".
 *
 * The condition that actually discriminates is **no open turn** — §6.2's definition,
 * implemented literally: the session's LAST turn has no `turn_duration` record, and
 * the session has been active inside the quiet window. R1 justified a 60-minute quiet
 * period against a p99 inter-message gap of 49 min, which does not reconcile with the
 * turn-duration distribution (p99 3.06 h, max 20.9 h `[FS]`); a 60-minute gate alone
 * still finalizes INSIDE live long-running turns. Rather than inflate the threshold to
 * 4+ hours and delay every ordinary close to protect the 1% case, the open-turn test
 * protects a 20.9-hour turn by construction. The quiet period survives as a secondary
 * guard between turns of an ongoing cluster.
 */
export function quiescence(db: Database, tid: string, now: Date = new Date()): QuiescenceReport {
  const failing: string[] = [];
  const quietMin = Number.parseInt(getConfig(db, "quiesce_main_min") ?? "60", 10);
  const quiesceMin = Number.isFinite(quietMin) ? quietMin : 60;

  const task = db
    .query<{ status: string; created_at: string; anchor_session: string }, [string]>(
      "SELECT status, created_at, anchor_session FROM task WHERE tid = ?",
    )
    .get(tid);
  if (task === null || task === undefined) {
    throw new InvariantError(`unknown tid: ${tid}`, "run `est open` to mint a task first");
  }

  const sessions = db
    .query<{ session_id: string }, [string]>(
      "SELECT DISTINCT session_id FROM task_alias WHERE tid = ? AND session_id <> ''",
    )
    .all(tid)
    .map((r) => r.session_id);
  if (!sessions.includes(task.anchor_session)) sessions.push(task.anchor_session);

  // 1. completion signal OR stale > 48 h.
  const boundTaskNums = db
    .query<{ session_id: string; local_id: string }, [string]>(
      "SELECT session_id, local_id FROM task_alias WHERE tid = ? AND id_kind = 'session_task'",
    )
    .all(tid);
  let completionSignal = task.status === "pending_verification" || task.status === "completed";
  for (const b of boundTaskNums) {
    const ev = db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM task_event WHERE session_id = ? AND task_num = ? AND to_status IN ('completed','deleted')",
      )
      .get(b.session_id, b.local_id);
    if ((ev?.n ?? 0) > 0) completionSignal = true;
  }
  const lastActivity = db
    .query<{ ts: string | null }, [string]>("SELECT MAX(ts) AS ts FROM request WHERE tid = ?")
    .get(tid)?.ts ?? null;
  const lastMs = Number.isFinite(parseMs(lastActivity)) ? parseMs(lastActivity) : parseMs(task.created_at);
  const staleHours = Number.isFinite(lastMs) ? (now.getTime() - lastMs) / 3_600_000 : null;
  if (!completionSignal && !(staleHours !== null && staleHours > STALE_CLOSE_HOURS)) {
    failing.push(
      `no completion signal, and the task is only ${staleHours === null ? "?" : staleHours.toFixed(1)}h stale (needs > ${STALE_CLOSE_HOURS}h)`,
    );
  }

  // 2. no attributable request in the last `quiesce_main_min` minutes.
  const quietMinutes = Number.isFinite(lastMs) ? (now.getTime() - lastMs) / 60_000 : null;
  if (quietMinutes !== null && quietMinutes < quiesceMin) {
    failing.push(`last attributed request was ${quietMinutes.toFixed(1)}m ago (needs >= ${quiesceMin}m)`);
  }

  // 3. no open turn in any bound session. All three clauses below are load-bearing.
  //    `duration_ms IS NULL` on its own does NOT mean "still running": it means no
  //    `turn_duration` record was ever seen for that turn, which is also what a session
  //    that was quit or lost leaves behind — permanently, since nothing backfills it,
  //    and that is how most sessions end. A lifetime count of NULLs is therefore a
  //    condition that holds forever and blocks the close in almost every session:
  //    `--force` for everything, `anomaly(forced_close)` on everything, no corpus.
  //    A LIVE turn, by contrast, is necessarily its session's newest (the next user
  //    line cannot arrive until it ends) and its session is necessarily still emitting
  //    requests, so those two clauses keep the 20.9-hour case protected while letting a
  //    dead session's unterminated last turn go. A turn that is live but has been
  //    silent longer than the quiet window falls to the pid and agent conditions —
  //    and, failing those, to the fact that a premature close is a revision and the
  //    late tokens produce another one (see this file's header).
  let openTurns = 0;
  const newestTurn = db.prepare<{ started_at: string; duration_ms: number | null }, [string]>(
    "SELECT started_at, duration_ms FROM turn WHERE session_id = ? ORDER BY started_at DESC, prompt_id DESC LIMIT 1",
  );
  const lastSessionRequest = db.prepare<{ ts: string | null }, [string]>(
    "SELECT MAX(ts) AS ts FROM request WHERE session_id = ?",
  );
  for (const s of sessions) {
    const newest = newestTurn.get(s);
    if (newest === null || newest === undefined || newest.duration_ms !== null) continue;
    const seen = Math.max(seenMs(newest.started_at), seenMs(lastSessionRequest.get(s)?.ts));
    if (Number.isFinite(seen) && (now.getTime() - seen) / 60_000 < quiesceMin) openTurns += 1;
  }
  if (openTurns > 0) {
    failing.push(
      `${openTurns} open turn(s) in bound sessions (newest turn has no turn_duration record and the session is still active)`,
    );
  }

  // 4. no live pid among bound sessions.
  const livePids = livePidsForSessions(sessions);
  if (livePids.length > 0) failing.push(`live session process(es): ${livePids.join(", ")}`);

  // 5. every bound agent_run terminal.
  const nonterminal =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM agent_run WHERE tid = ? AND started_at IS NOT NULL AND ended_at IS NULL",
      )
      .get(tid)?.n ?? 0;
  if (nonterminal > 0) failing.push(`${nonterminal} bound agent_run(s) have not ended`);

  return {
    ok: failing.length === 0,
    failing,
    completion_signal: completionSignal,
    stale_hours: staleHours,
    quiet_minutes: quietMinutes,
    open_turns: openTurns,
    live_pids: livePids,
    nonterminal_agents: nonterminal,
  };
}

export interface CloseInput {
  tid: string;
  status?: FinalStatus;
  force?: boolean;
  now?: Date;
}

export interface CloseResult {
  tid: string;
  revision: number;
  final_status: FinalStatus;
  censored: boolean;
  eid_at_start: number;
  eid_final: number;
  actual_wcet: number;
  actual_wcet_at_epoch: number | null;
  wcet_main: number;
  wcet_sub: number;
  wcet_aux: number;
  overhead_wcet: number;
  n_requests: number;
  n_agents: number;
  active_s: number;
  busy_s: number;
  max_concurrency: number;
  parallelism_factor: number | null;
  velocity_raw: number | null;
  velocity_cal: number | null;
  in_band: boolean | null;
  scope_changed: boolean;
  scope_declared: boolean;
  tid_planted: number | null;
  unpriced_share: number;
  price_provisional: boolean;
  dangling_agents: number;
  phase_unmapped_agents: number;
  compactions: number;
  fork_replays: number;
  sidechain_replays: number;
  ambiguous_share: number | null;
  unattrib_share: number | null;
  forced: boolean;
  quiescence: QuiescenceReport;
  /** Non-empty => the CLI exits 3: finalized, with alerting conditions recorded. */
  alerts: string[];
}

const INSERT_OUTCOME_SQL = `
INSERT INTO outcome (
  tid, revision, finalized_at, final_status, censored, eid_at_start, eid_final,
  actual_wcet, actual_wcet_at_epoch, actual_scet, actual_in, actual_out, actual_cw, actual_cr,
  wcet_main, wcet_sub, wcet_aux, n_req_main, n_req_sub, n_req_aux, n_requests, n_agents,
  active_s, busy_s, max_concurrency, parallelism_factor, compute_s, wall_s,
  overhead_wcet, unattrib_share, ambiguous_share, unpriced_share, price_provisional,
  dangling_agents, compactions, fork_replays, sidechain_replays, phase_unmapped_agents,
  tid_planted, scope_changed, scope_changed_at, scope_seq_at_start, scope_seq_final,
  scope_declared, velocity_raw, velocity_cal, in_band
) VALUES (
  $tid, $revision, $finalized_at, $final_status, $censored, $eid_at_start, $eid_final,
  $actual_wcet, $actual_wcet_at_epoch, $actual_scet, $actual_in, $actual_out, $actual_cw, $actual_cr,
  $wcet_main, $wcet_sub, $wcet_aux, $n_req_main, $n_req_sub, $n_req_aux, $n_requests, $n_agents,
  $active_s, $busy_s, $max_concurrency, $parallelism_factor, $compute_s, $wall_s,
  $overhead_wcet, $unattrib_share, $ambiguous_share, $unpriced_share, $price_provisional,
  $dangling_agents, $compactions, $fork_replays, $sidechain_replays, $phase_unmapped_agents,
  $tid_planted, $scope_changed, $scope_changed_at, $scope_seq_at_start, $scope_seq_final,
  $scope_declared, $velocity_raw, $velocity_cal, $in_band
)
`;

/**
 * Finalize `tid`, appending one `outcome` revision.
 *
 * The attribution pass runs first: `est close` is the moment the actual is fixed, and
 * computing it over requests the sweeper has not yet claimed would systematically
 * under-count the last few minutes of every task. It is idempotent, so running it
 * here and in the sweeper is not a conflict — and it runs over EVERY task, never
 * narrowed to this one. Attribution resolves whole sessions, so a pass that could see
 * only the closing task's aliases would re-point its siblings' requests at it and
 * write that inflation into an append-only `outcome` (see `attribute.ts`).
 *
 * The caller holds the sweep lock.
 */
export function closeTask(db: Database, input: CloseInput): CloseResult {
  const now = input.now ?? new Date();
  const ts = isoNow(now);
  const status: FinalStatus = input.status ?? "completed";
  const forced = input.force === true;

  const task = db
    .query<{ status: string; anchor_session: string }, [string]>(
      "SELECT status, anchor_session FROM task WHERE tid = ?",
    )
    .get(input.tid);
  if (task === null || task === undefined) {
    throw new InvariantError(`unknown tid: ${input.tid}`, "run `est open` to mint a task first");
  }

  attributeTasks(db);

  const gate = quiescence(db, input.tid, now);
  if (!gate.ok && !forced) {
    throw new InvariantError(
      `quiescence gate not met for ${input.tid}: ${gate.failing.join("; ")}`,
      "wait for the task to go quiet, or pass --force (which records anomaly(forced_close)) — --force is for Craig, not for Claude",
    );
  }

  const bounds = db
    .query<{ first_eid: number | null; last_eid: number | null }, [string]>(
      "SELECT MIN(eid) AS first_eid, MAX(eid) AS last_eid FROM estimate WHERE tid = ?",
    )
    .get(input.tid);
  if (bounds === null || bounds === undefined || bounds.first_eid === null || bounds.last_eid === null) {
    throw new InvariantError(
      `tid ${input.tid} has no estimate; there is no baseline to judge an actual against`,
      "run `est open` before `est close` — an outcome without an `eid_at_start` is not a measurement",
    );
  }
  const eidAtStart = bounds.first_eid;
  const eidFinal = bounds.last_eid;

  const baseline = db
    .query<
      {
        raw_p50_wcet: number;
        cal_p50_wcet: number;
        cal_p90_wcet: number;
        scope_seq: number;
        price_epoch: string;
      },
      [number]
    >("SELECT raw_p50_wcet, cal_p50_wcet, cal_p90_wcet, scope_seq, price_epoch FROM estimate WHERE eid = ?")
    .get(eidAtStart)!;

  const actual = db
    .query<
      {
        wcet: number | null;
        wcet_task_effort: number | null;
        overhead_wcet: number | null;
        scet: number | null;
        wcet_main: number | null;
        wcet_sub: number | null;
        wcet_aux: number | null;
        n_req_main: number | null;
        n_req_sub: number | null;
        n_req_aux: number | null;
        in_tok: number | null;
        out_tok: number | null;
        cw_tok: number | null;
        cr_tok: number | null;
        n_req: number | null;
        n_agents: number | null;
        first_ts: string | null;
        last_ts: string | null;
      },
      [string]
    >("SELECT * FROM v_task_actual WHERE tid = ?")
    .get(input.tid);

  const epochRow = db
    .query<{ wcet_at_epoch: number | null }, [string]>(
      "SELECT wcet_at_epoch FROM v_task_actual_epoch WHERE tid = ?",
    )
    .get(input.tid);
  const actualAtEpoch = epochRow?.wcet_at_epoch ?? null;

  const union = intervalUnion(taskIntervals(db, input.tid));
  const computeRow = db
    .query<{ ms: number | null; n: number }, [string]>(
      "SELECT SUM(duration_ms) AS ms, COUNT(duration_ms) AS n FROM request WHERE tid = ? AND attr <> 'replay'",
    )
    .get(input.tid);
  const computeS =
    computeRow !== null && computeRow !== undefined && computeRow.n > 0 && computeRow.ms !== null
      ? Math.round(computeRow.ms / 1000)
      : null;
  const wallS =
    actual?.first_ts != null && actual.last_ts != null
      ? Math.max(0, Math.round((Date.parse(actual.last_ts) - Date.parse(actual.first_ts)) / 1000))
      : null;

  // --- honesty columns -----------------------------------------------------
  const sessions = db
    .query<{ session_id: string }, [string]>(
      "SELECT DISTINCT session_id FROM task_alias WHERE tid = ? AND session_id <> ''",
    )
    .all(input.tid)
    .map((r) => r.session_id);

  const ambiguousWcet =
    db
      .query<{ w: number | null }, [string]>(
        "SELECT SUM(wcet) AS w FROM v_wcet WHERE tid = ? AND attr = 'ambiguous'",
      )
      .get(input.tid)?.w ?? 0;
  const totalWcet = actual?.wcet ?? 0;
  const ambiguousShare = totalWcet > 0 ? (ambiguousWcet ?? 0) / totalWcet : null;

  // Unattributed share is measured over the SESSIONS this task was bound to: the
  // residual is only meaningful relative to the spend that could plausibly have
  // been the task's, not relative to the whole corpus.
  let unattribShare: number | null = null;
  if (sessions.length > 0) {
    const holes = new Array(sessions.length).fill("?").join(",");
    const row = db
      .query<{ unattributed: number | null; total: number | null }, string[]>(
        `SELECT SUM(CASE WHEN tid IS NULL THEN wcet ELSE 0 END) AS unattributed, SUM(wcet) AS total
           FROM v_wcet WHERE session_id IN (${holes})`,
      )
      .get(...sessions);
    const total = row?.total ?? 0;
    unattribShare = total > 0 ? (row?.unattributed ?? 0) / total : null;
  }

  const priced =
    db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM v_priced WHERE tid = ?").get(input.tid)?.n ??
    0;
  const unpriced =
    db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM v_unpriced WHERE tid = ?").get(input.tid)
      ?.n ?? 0;
  const unpricedShare = priced + unpriced > 0 ? unpriced / (priced + unpriced) : 0;
  const provisional =
    (db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM v_priced WHERE tid = ? AND provisional = 1")
      .get(input.tid)?.n ?? 0) > 0;

  const danglingAgents =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM agent_run WHERE tid = ? AND started_at IS NOT NULL AND ended_at IS NULL",
      )
      .get(input.tid)?.n ?? 0;
  const phaseUnmapped =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM agent_run WHERE tid = ? AND run_id IS NOT NULL AND (phase_conf IS NULL OR phase_conf = 'unmapped')",
      )
      .get(input.tid)?.n ?? 0;
  const sidechainReplays =
    sessions.length === 0
      ? 0
      : (db
          .query<{ n: number }, string[]>(
            `SELECT COUNT(*) AS n FROM request WHERE attr = 'replay' AND session_id IN (${new Array(sessions.length).fill("?").join(",")})`,
          )
          .get(...sessions)?.n ?? 0);
  const compactions = countSessionAnomalies(db, "compaction_continuation", sessions);
  const forkReplays = countSessionAnomalies(db, "fork_replay", sessions);

  // --- identity planting (§3.2 step 6) -------------------------------------
  // NULL means "no Task-tool task was available", which is a different fact from
  // "one was available and the tid was never planted" — and only the second is a
  // compliance failure worth reporting.
  const taskToolAvailable =
    (db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM task_event WHERE session_id = ?")
      .get(task.anchor_session)?.n ?? 0) > 0;
  const planted =
    (db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM task_alias WHERE tid = ? AND id_kind = 'session_task'",
      )
      .get(input.tid)?.n ?? 0) > 0;
  const tidPlanted = taskToolAvailable ? (planted ? 1 : 0) : null;

  // --- scope history -------------------------------------------------------
  const scopeFinal =
    db.query<{ seq: number }, [string]>("SELECT MAX(seq) AS seq FROM task_scope WHERE tid = ?").get(input.tid)
      ?.seq ?? baseline.scope_seq;
  const revisions = db
    .query<{ seq: number; ts: string; source: string }, [string, number]>(
      "SELECT seq, ts, source FROM task_scope WHERE tid = ? AND seq > ? ORDER BY seq ASC",
    )
    .all(input.tid, baseline.scope_seq);
  const scopeChanged = revisions.length > 0;
  const scopeChangedAt = revisions[0]?.ts ?? null;
  const scopeDeclared = revisions.some((r) => r.source === "est_scope");

  // --- velocity ------------------------------------------------------------
  // §4.4: velocity derives from `actual_wcet_at_epoch` ONLY, never from
  // `actual_wcet` — the estimate and its actual must be computed under ONE price
  // vintage, or a ref-model price change mid-task appears as a velocity shift with
  // no cause.
  const velocityRaw =
    actualAtEpoch !== null && baseline.raw_p50_wcet > 0 ? actualAtEpoch / baseline.raw_p50_wcet : null;
  const velocityCal =
    actualAtEpoch !== null && baseline.cal_p50_wcet > 0 ? actualAtEpoch / baseline.cal_p50_wcet : null;
  const inBand =
    actualAtEpoch === null ? null : actualAtEpoch <= baseline.cal_p90_wcet ? 1 : 0;

  const censored = status === "abandoned" || status === "deleted" ? 1 : 0;
  const revision =
    (db
      .query<{ r: number | null }, [string]>("SELECT MAX(revision) AS r FROM outcome WHERE tid = ?")
      .get(input.tid)?.r ?? 0) + 1;

  db.transaction(() => {
    db.query(INSERT_OUTCOME_SQL).run({
      $tid: input.tid,
      $revision: revision,
      $finalized_at: ts,
      $final_status: status,
      $censored: censored,
      $eid_at_start: eidAtStart,
      $eid_final: eidFinal,
      $actual_wcet: Math.max(0, Math.round(actual?.wcet ?? 0)),
      $actual_wcet_at_epoch: actualAtEpoch === null ? null : Math.max(0, Math.round(actualAtEpoch)),
      $actual_scet: Math.max(0, Math.round(actual?.scet ?? 0)),
      $actual_in: Math.max(0, actual?.in_tok ?? 0),
      $actual_out: Math.max(0, actual?.out_tok ?? 0),
      $actual_cw: Math.max(0, actual?.cw_tok ?? 0),
      $actual_cr: Math.max(0, actual?.cr_tok ?? 0),
      $wcet_main: Math.max(0, Math.round(actual?.wcet_main ?? 0)),
      $wcet_sub: Math.max(0, Math.round(actual?.wcet_sub ?? 0)),
      $wcet_aux: Math.max(0, Math.round(actual?.wcet_aux ?? 0)),
      $n_req_main: Math.max(0, actual?.n_req_main ?? 0),
      $n_req_sub: Math.max(0, actual?.n_req_sub ?? 0),
      $n_req_aux: Math.max(0, actual?.n_req_aux ?? 0),
      $n_requests: Math.max(0, actual?.n_req ?? 0),
      $n_agents: Math.max(0, actual?.n_agents ?? 0),
      $active_s: union.activeS,
      $busy_s: union.busyS,
      $max_concurrency: union.maxConcurrency,
      $parallelism_factor: union.activeS > 0 ? union.busyS / union.activeS : null,
      $compute_s: computeS,
      $wall_s: wallS,
      $overhead_wcet: Math.max(0, Math.round(actual?.overhead_wcet ?? 0)),
      $unattrib_share: unattribShare,
      $ambiguous_share: ambiguousShare,
      $unpriced_share: unpricedShare,
      $price_provisional: provisional ? 1 : 0,
      $dangling_agents: danglingAgents,
      $compactions: compactions,
      $fork_replays: forkReplays,
      $sidechain_replays: sidechainReplays,
      $phase_unmapped_agents: phaseUnmapped,
      $tid_planted: tidPlanted,
      $scope_changed: scopeChanged ? 1 : 0,
      $scope_changed_at: scopeChangedAt,
      $scope_seq_at_start: baseline.scope_seq,
      $scope_seq_final: scopeFinal,
      $scope_declared: scopeDeclared ? 1 : 0,
      $velocity_raw: velocityRaw,
      $velocity_cal: velocityCal,
      $in_band: inBand,
    } as never);

    const taskStatus = status === "reopened" ? "in_progress" : status;
    db.query("UPDATE task SET status = ?, ended_at = ? WHERE tid = ?").run(
      taskStatus,
      status === "reopened" ? null : ts,
      input.tid,
    );
    db.query("DELETE FROM burn_cache WHERE tid = ?").run(input.tid);

    if (forced && !gate.ok) {
      db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES (?, 'forced_close', ?, ?)").run(
        ts,
        `est close --force overrode the quiescence gate: ${gate.failing.join("; ")}`,
        input.tid,
      );
    }
    if (scopeChanged && !scopeDeclared) {
      db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES (?, 'scope_undeclared', ?, ?)").run(
        ts,
        `scope moved from seq ${baseline.scope_seq} to ${scopeFinal} with no \`est scope\` revision — the drift was detected, not declared`,
        input.tid,
      );
    }
    if (tidPlanted === 0) {
      db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES (?, 'tid_unplanted', ?, ?)").run(
        ts,
        "a Task-tool task existed in the anchor session but no task file carried this est_tid; cross-session stitching is not working for this task",
        input.tid,
      );
    }
  }).immediate();

  const alerts: string[] = [];
  if (unpricedShare > 0) alerts.push(`unpriced_share=${(unpricedShare * 100).toFixed(1)}%`);
  if (danglingAgents > 0) alerts.push(`dangling_agents=${danglingAgents}`);
  if (phaseUnmapped > 0) alerts.push(`phase_unmapped_agents=${phaseUnmapped}`);

  return {
    tid: input.tid,
    revision,
    final_status: status,
    censored: censored === 1,
    eid_at_start: eidAtStart,
    eid_final: eidFinal,
    actual_wcet: Math.round(actual?.wcet ?? 0),
    actual_wcet_at_epoch: actualAtEpoch === null ? null : Math.round(actualAtEpoch),
    wcet_main: Math.round(actual?.wcet_main ?? 0),
    wcet_sub: Math.round(actual?.wcet_sub ?? 0),
    wcet_aux: Math.round(actual?.wcet_aux ?? 0),
    overhead_wcet: Math.round(actual?.overhead_wcet ?? 0),
    n_requests: actual?.n_req ?? 0,
    n_agents: actual?.n_agents ?? 0,
    active_s: union.activeS,
    busy_s: union.busyS,
    max_concurrency: union.maxConcurrency,
    parallelism_factor: union.activeS > 0 ? union.busyS / union.activeS : null,
    velocity_raw: velocityRaw,
    velocity_cal: velocityCal,
    in_band: inBand === null ? null : inBand === 1,
    scope_changed: scopeChanged,
    scope_declared: scopeDeclared,
    tid_planted: tidPlanted,
    unpriced_share: unpricedShare,
    price_provisional: provisional,
    dangling_agents: danglingAgents,
    phase_unmapped_agents: phaseUnmapped,
    compactions,
    fork_replays: forkReplays,
    sidechain_replays: sidechainReplays,
    ambiguous_share: ambiguousShare,
    unattrib_share: unattribShare,
    forced: forced && !gate.ok,
    quiescence: gate,
    alerts,
  };
}

/**
 * Corpus-wide anomalies (fork replays, `/compact` boundaries) carry no `tid` — they
 * are facts about FILES, found before any task exists. They name their sessions in
 * `detail`, so a substring match is the only available join. It over-counts if two
 * sessions share a prefix, which is why the count is reported as a diagnostic rather
 * than consumed by any calculation.
 */
function countSessionAnomalies(db: Database, kind: string, sessions: readonly string[]): number {
  if (sessions.length === 0) return 0;
  let n = 0;
  const stmt = db.prepare<{ n: number }, [string, string]>(
    "SELECT COUNT(*) AS n FROM anomaly WHERE kind = ? AND detail LIKE '%' || ? || '%'",
  );
  for (const s of sessions) n += stmt.get(kind, s)?.n ?? 0;
  return n;
}

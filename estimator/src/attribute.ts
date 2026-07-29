/**
 * src/attribute.ts — §5.4 attribution, over `est`-opened tasks only.
 *
 * This is the step that turns "the sweeper knows what every request cost" into "the
 * sweeper knows which TASK every request belongs to", and it is the one part of the
 * pipeline a gate has already fired on, so it is worth being precise about what it
 * does and does not claim.
 *
 * **What G-ATTR settled (DECISIONS.md §1, §5.4).** Measured on the historical
 * corpus, `exclusive ∪ sticky` coverage was **18.7%** against a 70% bar. Three
 * structural causes, and only one is about the rule: harness todos are never closed
 * (42.9% never reach a terminal status, peak 25 open at once), most sessions never
 * touch a task at all, and the ceremony did not exist when that corpus was written.
 * Two consequences are implemented here:
 *
 *  1. **"Tracked task" means an `est`-opened tid — NEVER every harness `TaskCreate`.**
 *     `task_alias` is the only route by which a harness identity becomes a tid. This
 *     is what stops the implementation inheriting the todo-list grain that produced
 *     the 18.7%.
 *  2. **Staleness closure.** Sticky attribution is bounded by a configured quiet
 *     period (`attr_stale_turns` / `attr_stale_minutes`). A task with no bound
 *     activity inside the window stops absorbing later turns — for attribution only,
 *     never on the board — and those tokens fall to the residual class rather than
 *     inflating a task nobody is working on any more.
 *
 * **Residuals are counted, never hidden.** A request that no task can claim is
 * marked `attr='pre_task'` (spend in a task-bearing session before that task's
 * window opened) or left `attr='none'` (a session with no tracked task at all).
 * §5.4 describes the first as booking to a per-session `__session_overhead__`
 * pseudo-task; a label on the request carries the same information — the residual is
 * visible and countable in `est retro` — without conjuring task rows that would then
 * appear on the board as work nobody ever asked for.
 *
 * **Idempotent by construction, and GLOBAL by construction.** Every run recomputes
 * every bound task from scratch and writes the same answer, which is what lets the
 * sweeper, `est close` and a test all call it without coordinating. There is
 * deliberately no way to ask for one task: attribution resolves whole SESSIONS (a
 * turn belongs to whichever open task claims it, an agent to its launching turn, a
 * request to its agent or its turn), so a pass that could see only one task's aliases
 * would hand that task every request its siblings had already won — silently
 * re-pointing spend between actuals, which is exactly what `est bind` refuses to do
 * explicitly.
 */

import type { Database } from "bun:sqlite";
import { getConfig } from "./db.ts";

export interface AttributionResult {
  tasks: number;
  turns_assigned: number;
  agents_assigned: number;
  requests_assigned: number;
  by_attr: Record<string, number>;
}

interface TaskRow {
  tid: string;
  status: string;
  created_at: string;
  anchor_session: string;
  anchor_prompt: string;
}

interface AliasRow {
  tid: string;
  id_kind: string;
  session_id: string;
  local_id: string;
}

interface TurnRow {
  session_id: string;
  prompt_id: string;
  started_at: string;
  duration_ms: number | null;
}

interface AgentRow {
  agent_id: string;
  session_id: string;
  run_id: string | null;
  launch_prompt_id: string | null;
  started_at: string | null;
}

interface ReqRow {
  request_id: string;
  session_id: string;
  prompt_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  ts: string;
  attr: string;
  tid: string | null;
  attribution_skill: string | null;
}

type Attr = "exclusive" | "sticky" | "ambiguous" | "overhead" | "pre_task" | "none";

const MINUTE_MS = 60_000;

function ms(ts: string | null): number {
  if (ts === null) return Number.NaN;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : Number.NaN;
}

/**
 * Assign `tid`/`attr` across `turn`, `agent_run` and `request`.
 *
 * Order matters and is the design's, not a convenience: turns first, then agents
 * (which "take their launching turn's assignment", §5.4), then requests (which take
 * their agent's or their turn's). Doing it the other way round would attribute a
 * sub-agent's spend by timestamp containment — the exact matching rule `[FS]`
 * rejected, because background agents routinely outlive their launching turn by
 * hours.
 */
export function attributeTasks(db: Database): AttributionResult {
  const staleTurns = Number.parseInt(getConfig(db, "attr_stale_turns") ?? "5", 10);
  const staleMinutes = Number.parseInt(getConfig(db, "attr_stale_minutes") ?? "120", 10);
  const staleMs = (Number.isFinite(staleMinutes) ? staleMinutes : 120) * MINUTE_MS;
  const maxQuietTurns = Number.isFinite(staleTurns) ? staleTurns : 5;

  const tasks = db
    .query<TaskRow, []>("SELECT tid, status, created_at, anchor_session, anchor_prompt FROM task")
    .all()
    .filter((t) => t.tid !== "");
  if (tasks.length === 0) {
    return { tasks: 0, turns_assigned: 0, agents_assigned: 0, requests_assigned: 0, by_attr: {} };
  }
  const taskById = new Map(tasks.map((t) => [t.tid, t]));

  const aliases = db
    .query<AliasRow, []>("SELECT tid, id_kind, session_id, local_id FROM task_alias")
    .all()
    .filter((a) => taskById.has(a.tid));
  if (aliases.length === 0) {
    return { tasks: tasks.length, turns_assigned: 0, agents_assigned: 0, requests_assigned: 0, by_attr: {} };
  }

  // --- windows -------------------------------------------------------------
  // A task's attribution window OPENS at its anchor turn, not at its first tool
  // launch: the orchestrator's planning and reading spend belongs inside the
  // estimate's coverage (§3.1), and gating at the launch is what made R1's actuals
  // systematically low `[CB]`. It CLOSES at finalization, so a re-opened task does
  // not retroactively swallow the next task's turns.
  const windowStart = new Map<string, number>();
  const windowEnd = new Map<string, number>();
  const anchorTurn = db.prepare<{ started_at: string }, [string, string]>(
    "SELECT started_at FROM turn WHERE session_id = ? AND prompt_id = ?",
  );
  const finalized = db.prepare<{ finalized_at: string; final_status: string }, [string]>(
    "SELECT finalized_at, final_status FROM v_outcome_current WHERE tid = ?",
  );
  for (const t of tasks) {
    const at = anchorTurn.get(t.anchor_session, t.anchor_prompt);
    const start = ms(at?.started_at ?? t.created_at);
    windowStart.set(t.tid, Number.isFinite(start) ? start : ms(t.created_at));
    const fin = finalized.get(t.tid);
    windowEnd.set(
      t.tid,
      fin !== null && fin !== undefined && fin.final_status !== "reopened"
        ? ms(fin.finalized_at)
        : Number.POSITIVE_INFINITY,
    );
  }

  // --- explicit touches ----------------------------------------------------
  // §5.4: a task is "touched" by a turn containing its TaskUpdate/TaskCreate, an
  // `est` CLI call for its tid, or a delegation attributed to it. The first two are
  // gathered here; the third falls out of the turn loop below.
  const touches = new Map<string, number[]>();
  const addTouch = (tid: string, at: number): void => {
    if (!Number.isFinite(at)) return;
    const list = touches.get(tid);
    if (list === undefined) touches.set(tid, [at]);
    else list.push(at);
  };
  for (const t of tasks) addTouch(t.tid, windowStart.get(t.tid) ?? ms(t.created_at));
  for (const r of db.query<{ tid: string; created_at: string }, []>(
    "SELECT tid, created_at FROM estimate",
  ).all()) {
    if (taskById.has(r.tid)) addTouch(r.tid, ms(r.created_at));
  }
  for (const r of db.query<{ tid: string; ts: string }, []>("SELECT tid, ts FROM task_scope").all()) {
    if (taskById.has(r.tid)) addTouch(r.tid, ms(r.ts));
  }
  const taskNumAlias = new Map<string, string>();
  for (const a of aliases) {
    if (a.id_kind === "session_task") taskNumAlias.set(`${a.session_id}\u0000${a.local_id}`, a.tid);
  }
  if (taskNumAlias.size > 0) {
    for (const e of db
      .query<{ session_id: string; task_num: string; ts: string }, []>(
        "SELECT session_id, task_num, ts FROM task_event",
      )
      .all()) {
      const tid = taskNumAlias.get(`${e.session_id}\u0000${e.task_num}`);
      if (tid !== undefined) addTouch(tid, ms(e.ts));
    }
  }
  for (const list of touches.values()) list.sort((a, b) => a - b);

  // --- direct bindings -----------------------------------------------------
  const agentBinding = new Map<string, string>();
  const runBinding = new Map<string, string>();
  const sessionTasks = new Map<string, string[]>();
  for (const a of aliases) {
    if (a.id_kind === "agent") agentBinding.set(a.local_id, a.tid);
    else if (a.id_kind === "workflow_run") runBinding.set(a.local_id, a.tid);
    else if (a.id_kind === "session") {
      const list = sessionTasks.get(a.session_id);
      if (list === undefined) sessionTasks.set(a.session_id, [a.tid]);
      else if (!list.includes(a.tid)) list.push(a.tid);
    }
  }

  const boundSessions = [...sessionTasks.keys()];
  const placeholders = (n: number): string => new Array(n).fill("?").join(",");

  // --- turns ---------------------------------------------------------------
  const turnTid = new Map<string, { tid: string; attr: Attr }>();
  let turnsAssigned = 0;
  for (const session of boundSessions) {
    const candidates = (sessionTasks.get(session) ?? []).filter((tid) => taskById.has(tid));
    if (candidates.length === 0) continue;
    const turns = db
      .query<TurnRow, [string]>(
        "SELECT session_id, prompt_id, started_at, duration_ms FROM turn WHERE session_id = ? ORDER BY started_at ASC",
      )
      .all(session);

    // Per-task staleness state, carried across the session's turns in order.
    const lastTouch = new Map<string, number>();
    const quietTurns = new Map<string, number>();
    for (const tid of candidates) {
      lastTouch.set(tid, windowStart.get(tid) ?? Number.NEGATIVE_INFINITY);
      quietTurns.set(tid, 0);
    }

    for (const turn of turns) {
      const at = ms(turn.started_at);
      // Fold in every explicit touch that happened at or before this turn.
      for (const tid of candidates) {
        const list = touches.get(tid);
        if (list === undefined) continue;
        let newest = Number.NEGATIVE_INFINITY;
        for (const t of list) {
          if (t <= at && t > newest) newest = t;
        }
        if (newest > (lastTouch.get(tid) ?? Number.NEGATIVE_INFINITY)) {
          lastTouch.set(tid, newest);
          quietTurns.set(tid, 0);
        }
      }

      const open = candidates.filter((tid) => {
        const start = windowStart.get(tid) ?? Number.POSITIVE_INFINITY;
        const end = windowEnd.get(tid) ?? Number.POSITIVE_INFINITY;
        if (!(at >= start && at <= end)) return false;
        const last = lastTouch.get(tid) ?? Number.NEGATIVE_INFINITY;
        if (Number.isFinite(last) && at - last > staleMs) return false;
        if ((quietTurns.get(tid) ?? 0) >= maxQuietTurns) return false;
        return true;
      });

      let chosen: { tid: string; attr: Attr } | null = null;
      if (open.length === 1) chosen = { tid: open[0]!, attr: "exclusive" };
      else if (open.length > 1) {
        // Most-recently-touched wins, and the row SAYS it was ambiguous. `ambiguous`
        // is excluded from the calibration corpus and reported as a share, so this
        // is a counted cost rather than a silent guess (§5.4).
        const best = open.reduce((a, b) =>
          (lastTouch.get(b) ?? -Infinity) > (lastTouch.get(a) ?? -Infinity) ? b : a,
        );
        chosen = { tid: best, attr: "ambiguous" };
      }

      if (chosen !== null) {
        turnTid.set(`${session}\u0000${turn.prompt_id}`, chosen);
        turnsAssigned += 1;
        const end = at + (turn.duration_ms ?? 0);
        lastTouch.set(chosen.tid, Math.max(lastTouch.get(chosen.tid) ?? -Infinity, end));
        for (const tid of candidates) {
          if (tid === chosen.tid) quietTurns.set(tid, 0);
          else quietTurns.set(tid, (quietTurns.get(tid) ?? 0) + 1);
        }
      } else {
        for (const tid of candidates) quietTurns.set(tid, (quietTurns.get(tid) ?? 0) + 1);
      }
    }
  }

  // --- agents --------------------------------------------------------------
  const agents =
    boundSessions.length === 0 && agentBinding.size === 0 && runBinding.size === 0
      ? []
      : db
          .query<AgentRow, []>(
            "SELECT agent_id, session_id, run_id, launch_prompt_id, started_at FROM agent_run",
          )
          .all();
  const agentTid = new Map<string, { tid: string; attr: Attr }>();
  for (const a of agents) {
    const direct = agentBinding.get(a.agent_id) ?? (a.run_id === null ? undefined : runBinding.get(a.run_id));
    if (direct !== undefined && taskById.has(direct)) {
      agentTid.set(a.agent_id, { tid: direct, attr: "exclusive" });
      continue;
    }
    if (a.launch_prompt_id !== null) {
      const parent = turnTid.get(`${a.session_id}\u0000${a.launch_prompt_id}`);
      if (parent !== undefined) agentTid.set(a.agent_id, parent);
    }
  }

  // --- requests ------------------------------------------------------------
  const scopeSessions = new Set<string>(boundSessions);
  for (const a of agents) if (agentTid.has(a.agent_id)) scopeSessions.add(a.session_id);
  const sessionList = [...scopeSessions];
  const requests: ReqRow[] =
    sessionList.length === 0
      ? []
      : db
          .query<ReqRow, string[]>(
            `SELECT request_id, session_id, prompt_id, agent_id, run_id, ts, attr, tid, attribution_skill
               FROM request WHERE session_id IN (${placeholders(sessionList.length)})`,
          )
          .all(...sessionList);

  const updates: Array<{ request_id: string; tid: string | null; attr: Attr }> = [];
  const byAttr: Record<string, number> = {};
  for (const r of requests) {
    // `replay` rows are a sidechain re-emission of an already-counted message. They
    // are kept for audit and excluded from EVERY sum (§5.2), so re-labelling one
    // would be the one edit that could double-count.
    if (r.attr === "replay") continue;

    let assign: { tid: string | null; attr: Attr } = { tid: null, attr: "none" };
    const viaAgent = r.agent_id === null ? undefined : agentTid.get(r.agent_id);
    const viaRun = r.run_id === null ? undefined : runBinding.get(r.run_id);
    const viaTurn = r.prompt_id === null ? undefined : turnTid.get(`${r.session_id}\u0000${r.prompt_id}`);
    if (viaAgent !== undefined) assign = viaAgent;
    else if (viaRun !== undefined && taskById.has(viaRun)) assign = { tid: viaRun, attr: "exclusive" };
    else if (viaTurn !== undefined) assign = viaTurn;
    else if (sessionTasks.has(r.session_id)) {
      // In a task-bearing session but claimed by nothing: either before the first
      // task's window opened, or after staleness closed it. Both are the residual
      // class, and it is LABELLED rather than left indistinguishable from a request
      // in a session this system has never heard of.
      assign = { tid: null, attr: "pre_task" };
    }

    // Rule 1 of §5.4, applied last because it OVERRIDES the others: the ceremony's
    // own spend books to `overhead` and is excluded from `actual_wcet`, otherwise
    // improving the ceremony worsens the numbers it produces.
    if (r.attribution_skill === "estimating" && assign.tid !== null) {
      assign = { tid: assign.tid, attr: "overhead" };
    }

    byAttr[assign.attr] = (byAttr[assign.attr] ?? 0) + 1;
    if (r.tid !== assign.tid || r.attr !== assign.attr) {
      updates.push({ request_id: r.request_id, tid: assign.tid, attr: assign.attr });
    }
  }

  // --- write, batched ------------------------------------------------------
  db.transaction(() => {
    const turnStmt = db.prepare(
      "UPDATE turn SET tid = $tid WHERE session_id = $session_id AND prompt_id = $prompt_id",
    );
    for (const [key, v] of turnTid) {
      const sep = key.indexOf("\u0000");
      turnStmt.run({
        $tid: v.tid,
        $session_id: key.slice(0, sep),
        $prompt_id: key.slice(sep + 1),
      } as never);
    }
    const agentStmt = db.prepare("UPDATE agent_run SET tid = $tid WHERE agent_id = $agent_id");
    for (const [agentId, v] of agentTid) agentStmt.run({ $tid: v.tid, $agent_id: agentId } as never);

    const reqStmt = db.prepare("UPDATE request SET tid = $tid, attr = $attr WHERE request_id = $rid");
    for (const u of updates) reqStmt.run({ $tid: u.tid, $attr: u.attr, $rid: u.request_id } as never);
  }).immediate();

  return {
    tasks: tasks.length,
    turns_assigned: turnsAssigned,
    agents_assigned: agentTid.size,
    requests_assigned: updates.length,
    by_attr: byAttr,
  };
}

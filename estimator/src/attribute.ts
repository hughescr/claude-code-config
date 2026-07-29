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
  /** `workflow_run` rows that resolved a tid (F3). Zero for every pre-repair sweep. */
  runs_assigned: number;
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
  /** The RELAUNCH discriminator. `run_id` alone is not an identity — see `runKey`. */
  wf_launch_id: string | null;
  launch_prompt_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface WorkflowRunRow {
  run_id: string;
  wf_launch_id: string;
  session_id: string;
  launch_prompt_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface ReqRow {
  request_id: string;
  session_id: string;
  prompt_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  wf_launch_id: string | null;
  ts: string;
  attr: string;
  tid: string | null;
  origin: string;
  attribution_skill: string | null;
}

type Attr = "exclusive" | "sticky" | "ambiguous" | "overhead" | "pre_task" | "none";

/**
 * The composite-key separator. NUL cannot occur in a session id, a prompt id, a run
 * id or a tid, so it is the one byte that can join them without an escaping rule.
 */
const SEP = "\u0000";

const MINUTE_MS = 60_000;

function ms(ts: string | null): number {
  if (ts === null) return Number.NaN;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : Number.NaN;
}

/**
 * The composite identity of a workflow LAUNCH: `(run_id, wf_launch_id)`.
 *
 * `run_id` is a directory name the harness REUSES across relaunches — schema.sql
 * says so on `workflow_run` ("runId reused across relaunches"), which is why that
 * table's primary key is the pair and why `agent_run` and `request` both carry
 * `wf_launch_id`. Anything in this pass that resolves a run on `run_id` alone
 * therefore pools every launch that ever used that directory, and if two of those
 * launches belong to two different tasks it hands one of them the other's spend.
 */
function runKey(runId: string, launchId: string | null): string {
  return `${runId}${SEP}${launchId ?? ""}`;
}

/**
 * Drop every attribution claim in the derived tables.
 *
 * Used on the two paths where the pass has nothing to write — no tasks, or no
 * aliases — because "nothing is attributed" is an ANSWER, and a pass that computes
 * every claim from scratch has to be able to write that one too. Without it,
 * deleting the last alias for a task left its old tids on `turn`/`agent_run`/
 * `workflow_run`/`request` permanently, which is the same SET-only defect the main
 * path's clear-then-write fixes.
 *
 * `replay` rows are excluded for the reason they are excluded everywhere: they are a
 * sidechain re-emission of an already-counted message and re-labelling one is the
 * single edit that could double-count (§5.2).
 */
function clearAllClaims(db: Database): void {
  db.transaction(() => {
    db.query("UPDATE turn SET tid = NULL WHERE tid IS NOT NULL").run();
    db.query("UPDATE agent_run SET tid = NULL WHERE tid IS NOT NULL").run();
    db.query("UPDATE workflow_run SET tid = NULL WHERE tid IS NOT NULL").run();
    db.query(
      `UPDATE request SET tid = NULL, attr = 'none'
        WHERE attr <> 'replay' AND (tid IS NOT NULL OR attr = 'pre_task')`,
    ).run();
  }).immediate();
}

/**
 * Assign `tid`/`attr` across `turn`, `agent_run`, `workflow_run` and `request`.
 *
 * Order matters and is the design's, not a convenience: turns first, then agents
 * (which "take their launching turn's assignment", §5.4), then workflow runs (which
 * take their launching turn's, or failing that a majority vote of their own agents),
 * then requests (which take their agent's or their turn's). Doing it the other way
 * round would attribute a sub-agent's spend by timestamp containment — the exact
 * matching rule `[FS]` rejected, because background agents routinely outlive their
 * launching turn by hours.
 *
 * **Why the turn step is where this used to break.** The chain is
 * `est bind` → `task_alias` → this pass → `turn.tid` → `agent_run.tid` (inherited
 * from the launching turn) → `request.tid` → `v_wcet WHERE tid = ?` → `burn_cache`.
 * Every link but one worked. The staleness counter was incremented for every
 * candidate task on every turn of a bound session INCLUDING the turns that predate
 * the task's own window, so in a long-lived session a task arrived at its own anchor
 * turn already "5 turns quiet" and the anchor turn — and the turn that launched its
 * agents — were refused. Because a sub-agent inherits from `turnTid`, one refused
 * launching turn orphaned every agent and every request beneath it: measured on a
 * live snapshot, ~10% of a task's real spend was visible. The guard is in the quiet
 * loop at the bottom of the turn walk; the delegation touch beside it is the other
 * half (§5.4's third touch, which the comment claimed and the code never did).
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
    clearAllClaims(db);
    return {
      tasks: 0,
      turns_assigned: 0,
      agents_assigned: 0,
      runs_assigned: 0,
      requests_assigned: 0,
      by_attr: {},
    };
  }
  const taskById = new Map(tasks.map((t) => [t.tid, t]));

  const aliases = db
    .query<AliasRow, []>("SELECT tid, id_kind, session_id, local_id FROM task_alias")
    .all()
    .filter((a) => taskById.has(a.tid));
  if (aliases.length === 0) {
    clearAllClaims(db);
    return {
      tasks: tasks.length,
      turns_assigned: 0,
      agents_assigned: 0,
      runs_assigned: 0,
      requests_assigned: 0,
      by_attr: {},
    };
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

  // --- delegations ---------------------------------------------------------
  // Read BEFORE the turn loop, because §5.4's third touch ("a delegation attributed
  // to the task") is a fact about agents and runs, and the turn loop needs it while
  // it walks. A 30-second orchestrator turn that launches a two-hour background
  // workflow must not leave its task wall-clock-stale at `attr_stale_minutes` while
  // the delegation it started is still burning tokens — that punishes precisely the
  // background-orchestration pattern this system exists to measure.
  const haveBindings = boundSessions.length > 0 || agentBinding.size > 0 || runBinding.size > 0;
  const agents = !haveBindings
    ? []
    : db
        .query<AgentRow, []>(
          "SELECT agent_id, session_id, run_id, wf_launch_id, launch_prompt_id, started_at, ended_at FROM agent_run",
        )
        .all();
  const workflowRuns = !haveBindings
    ? []
    : db
        .query<WorkflowRunRow, []>(
          "SELECT run_id, wf_launch_id, session_id, launch_prompt_id, started_at, ended_at FROM workflow_run",
        )
        .all();

  /**
   * `session | launch_prompt_id | owner` -> the latest end of anything that turn
   * launched, where `owner` is the tid the delegation is EXPLICITLY bound to, or `*`
   * when it is bound to nothing.
   *
   * The owner is IN THE KEY because folding a delegation's end into the chosen task's
   * `lastTouch` extends that task's liveness INTO THE FUTURE, and the turn loop's
   * tiebreak is "most recently touched wins". A background agent bound to task B but
   * launched by a turn that resolved to task A therefore stamped A with B's end time —
   * hours ahead — and every later turn in the session went to A on a touch that was
   * really B's. Measured on a matched pair of fixtures differing in nothing but the
   * agent's `launch_prompt_id`, the fold turned the sequence `A B A B B` into
   * `A B A A A`; and the `ambiguous` label those turns carry does not contain the
   * damage, because `v_task_actual` sums every attr except `overhead` — so A's actual
   * inflates by exactly what B's loses.
   *
   * A delegation bound elsewhere needs no fold anyway: it already keeps its own task
   * alive through `boundSpans`/`addTouch` below, which is the mechanism built for
   * precisely that. So the turn loop reads the `*` bucket plus the chosen task's own.
   */
  const delegationEnd = new Map<string, number>();
  /** `run_id | wf_launch_id` -> that LAUNCH's agents. Never `run_id` alone: see `runKey`. */
  const agentsByRun = new Map<string, AgentRow[]>();
  const foldDelegation = (
    session: string,
    prompt: string,
    owner: string | undefined,
    end: number,
  ): void => {
    if (!Number.isFinite(end)) return;
    const key = `${session}${SEP}${prompt}${SEP}${owner ?? "*"}`;
    const cur = delegationEnd.get(key);
    if (cur === undefined || end > cur) delegationEnd.set(key, end);
  };
  for (const a of agents) {
    if (a.run_id !== null) {
      const key = runKey(a.run_id, a.wf_launch_id);
      const list = agentsByRun.get(key);
      if (list === undefined) agentsByRun.set(key, [a]);
      else list.push(a);
    }
    if (a.launch_prompt_id === null) continue;
    // Launch-agnostic on purpose: this is only the bucket LABEL, and a delegation
    // whose ownership is ambiguous at run grain is precisely one that must not be
    // folded into a single task's liveness. Any binding naming a task is enough to
    // keep it out of the `*` bucket.
    const owner =
      agentBinding.get(a.agent_id) ?? (a.run_id === null ? undefined : runBinding.get(a.run_id));
    foldDelegation(a.session_id, a.launch_prompt_id, owner, ms(a.ended_at ?? a.started_at));
  }
  for (const w of workflowRuns) {
    if (w.launch_prompt_id === null) continue;
    foldDelegation(
      w.session_id,
      w.launch_prompt_id,
      runBinding.get(w.run_id),
      ms(w.ended_at ?? w.started_at),
    );
  }

  // --- explicit touches ----------------------------------------------------
  // §5.4: a task is "touched" by a turn containing its TaskUpdate/TaskCreate, an
  // `est` CLI call for its tid, or a delegation attributed to it. The first two are
  // gathered here; the third arrives two ways — an EXPLICITLY bound agent/run is a
  // touch in its own right (added below), and a delegation launched by a turn this
  // pass chooses is folded into `lastTouch` inside the turn loop.
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
    if (a.id_kind === "session_task") taskNumAlias.set(`${a.session_id}${SEP}${a.local_id}`, a.tid);
  }
  if (taskNumAlias.size > 0) {
    for (const e of db
      .query<{ session_id: string; task_num: string; ts: string }, []>(
        "SELECT session_id, task_num, ts FROM task_event",
      )
      .all()) {
      const tid = taskNumAlias.get(`${e.session_id}${SEP}${e.task_num}`);
      if (tid !== undefined) addTouch(tid, ms(e.ts));
    }
  }
  // The third touch, half one: an agent or run EXPLICITLY bound to a task
  // (`est bind --agent` / `--run`) keeps that task alive for as long as the
  // delegation RUNS, not merely at the instant it finishes.
  //
  // A point touch at the end is not enough, and the live corpus says so: a task
  // whose bound workflow ran until 20:03 was refused every turn from 19:53 onward
  // with `stale-minutes(143m)`, because the only touch newer than the launching turn
  // lay in the FUTURE relative to those turns and the fold only admits touches at or
  // before the turn. A span does the obvious right thing — a turn that happens while
  // the delegation is in flight is evidence the task is alive — and it is the case
  // this system exists to measure, since a background run is exactly the pattern
  // where the orchestrator's own session goes quiet for hours.
  const boundSpans = new Map<string, Array<[number, number]>>();
  const addSpan = (tid: string, from: number, to: number): void => {
    if (!Number.isFinite(from)) return;
    const end = Number.isFinite(to) ? to : from;
    const list = boundSpans.get(tid);
    if (list === undefined) boundSpans.set(tid, [[from, end]]);
    else list.push([from, end]);
  };
  for (const a of agents) {
    const bound = agentBinding.get(a.agent_id) ?? (a.run_id === null ? undefined : runBinding.get(a.run_id));
    if (bound === undefined || !taskById.has(bound)) continue;
    addSpan(bound, ms(a.started_at), ms(a.ended_at ?? a.started_at));
    addTouch(bound, ms(a.ended_at ?? a.started_at));
  }
  for (const w of workflowRuns) {
    const bound = runBinding.get(w.run_id);
    if (bound === undefined || !taskById.has(bound)) continue;
    addSpan(bound, ms(w.started_at), ms(w.ended_at ?? w.started_at));
    addTouch(bound, ms(w.ended_at ?? w.started_at));
  }
  for (const list of touches.values()) list.sort((a, b) => a - b);

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
      // A bound delegation that is IN FLIGHT right now touches its task right now.
      for (const tid of candidates) {
        const spans = boundSpans.get(tid);
        if (spans === undefined) continue;
        if (!spans.some(([from, to]) => at >= from && at <= to)) continue;
        if (at > (lastTouch.get(tid) ?? Number.NEGATIVE_INFINITY)) lastTouch.set(tid, at);
        quietTurns.set(tid, 0);
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
        turnTid.set(`${session}${SEP}${turn.prompt_id}`, chosen);
        turnsAssigned += 1;
        // §5.4's third touch, half two: the task stays touched until the LAST thing
        // this turn delegated has finished, not until the turn's own text stopped
        // streaming. Without this a 30s turn that launches a 2h background workflow
        // goes wall-clock-stale at `attr_stale_minutes` while its own agents are
        // still burning tokens, and every one of those tokens falls to the residual.
        //
        // TWO buckets, never the whole turn: the unbound delegations (`*`), plus the
        // ones bound to THIS task. A delegation explicitly bound to a DIFFERENT task
        // is deliberately not folded — see `delegationEnd` for what folding it did to
        // every subsequent turn in the session.
        const end = at + (turn.duration_ms ?? 0);
        const prefix = `${session}${SEP}${turn.prompt_id}${SEP}`;
        const delegated = Math.max(
          delegationEnd.get(`${prefix}*`) ?? Number.NEGATIVE_INFINITY,
          delegationEnd.get(`${prefix}${chosen.tid}`) ?? Number.NEGATIVE_INFINITY,
        );
        lastTouch.set(chosen.tid, Math.max(lastTouch.get(chosen.tid) ?? -Infinity, end, delegated));
      }

      // Staleness is evidence that a LIVE task went quiet, so only a turn INSIDE the
      // task's own window may count against it. Counting the turns that predate
      // `anchor_prompt` made a task in a long-lived session arrive at its own anchor
      // turn already past `attr_stale_turns`: the window opened on paper and was dead
      // on arrival, and the effective window started at the first `est open`-time
      // write instead — reintroducing exactly the systematic low bias `[CB]` that
      // anchoring at the TURN (rather than at the first tool launch) exists to remove.
      // One loop rather than a chosen/not-chosen pair, so the two paths cannot drift.
      for (const tid of candidates) {
        if (chosen !== null && tid === chosen.tid) {
          quietTurns.set(tid, 0);
          continue;
        }
        const start = windowStart.get(tid) ?? Number.POSITIVE_INFINITY;
        const stop = windowEnd.get(tid) ?? Number.POSITIVE_INFINITY;
        if (at < start || at > stop) continue;
        quietTurns.set(tid, (quietTurns.get(tid) ?? 0) + 1);
      }
    }
  }

  // --- run bindings, resolved to a LAUNCH ----------------------------------
  // `task_alias` names a run by `run_id`, but a `run_id` is a directory name the
  // harness reuses (`runKey`). When it has been reused, one alias covers several
  // launches, and if two of those launches belong to two tasks the alias hands one
  // task the other's entire relaunch: measured on a fixture, task B's agent, its
  // `workflow_run` row and its request all booked to task A as `exclusive`, and
  // `est bind` could not express the correction because a competing bind is refused
  // (`ux_alias_exclusive`) and `--run` cannot name a launch.
  //
  // So the alias resolves per LAUNCH, and only for the launches it can be shown to
  // own. A launch is claimed AWAY from the alias by evidence that is launch-specific
  // and therefore strictly better than a run-wide name:
  //   - its launching turn resolved to a different task, or
  //   - one of its agents is explicitly bound (`est bind --agent`) to a different task.
  // With no such evidence the alias keeps the launch, so the single-launch case —
  // every run that was never relaunched — behaves exactly as before.
  const launchesOfRun = new Map<string, Set<string>>();
  const noteLaunch = (runId: string, launchId: string | null): void => {
    if (launchId === null) return;
    const set = launchesOfRun.get(runId);
    if (set === undefined) launchesOfRun.set(runId, new Set([launchId]));
    else set.add(launchId);
  };
  for (const w of workflowRuns) noteLaunch(w.run_id, w.wf_launch_id);
  for (const a of agents) if (a.run_id !== null) noteLaunch(a.run_id, a.wf_launch_id);

  /**
   * The agents of ONE launch. A row whose `wf_launch_id` is NULL — a pre-`wf_launch_id`
   * ingest, or a harness that never wrote one — is not evidence about which launch it
   * belongs to, so it joins the run's only launch when the run has only one, and is
   * left out of the vote entirely when the run was relaunched and the question is
   * genuinely open.
   */
  const agentsForLaunch = (runId: string, launchId: string): AgentRow[] => {
    const own = agentsByRun.get(runKey(runId, launchId)) ?? [];
    if ((launchesOfRun.get(runId)?.size ?? 0) > 1) return own;
    return [...own, ...(agentsByRun.get(runKey(runId, null)) ?? [])];
  };

  const runLaunchTid = new Map<string, string>();
  /** Runs whose alias is unambiguous because the run holds at most one launch. */
  const wholeRunTid = new Map<string, string>();
  for (const [runId, tid] of runBinding) {
    if (!taskById.has(tid)) continue;
    const launches = launchesOfRun.get(runId);
    if (launches === undefined || launches.size <= 1) {
      wholeRunTid.set(runId, tid);
      if (launches !== undefined) for (const l of launches) runLaunchTid.set(runKey(runId, l), tid);
      continue;
    }
    for (const l of launches) {
      const w = workflowRuns.find((r) => r.run_id === runId && r.wf_launch_id === l);
      const viaTurn =
        w?.launch_prompt_id == null ? undefined : turnTid.get(`${w.session_id}${SEP}${w.launch_prompt_id}`);
      if (viaTurn !== undefined && viaTurn.tid !== tid) continue;
      const claimedByAgent = agentsForLaunch(runId, l).some((a) => {
        const bound = agentBinding.get(a.agent_id);
        return bound !== undefined && bound !== tid;
      });
      if (claimedByAgent) continue;
      runLaunchTid.set(runKey(runId, l), tid);
    }
  }

  /**
   * The tid an `est bind --run` gives a row, or `undefined` when the alias does not
   * reach that row's launch. A row that knows its launch is answered per launch; a
   * row that does NOT know it (`wf_launch_id IS NULL`) may fall back to the run-wide
   * answer, which exists only when the run holds at most one launch — so the fallback
   * can never be the ambiguity this map was introduced to remove.
   */
  const runBoundTid = (runId: string | null, launchId: string | null): string | undefined => {
    if (runId === null) return undefined;
    if (launchId !== null) {
      const viaLaunch = runLaunchTid.get(runKey(runId, launchId));
      if (viaLaunch !== undefined) return viaLaunch;
      // Known to have been relaunched, and this launch is not one the alias owns.
      // The alias stops here rather than guessing; the turn/agent routes still apply.
      if ((launchesOfRun.get(runId)?.size ?? 0) > 1) return undefined;
    }
    return wholeRunTid.get(runId);
  };

  // --- agents --------------------------------------------------------------
  const agentTid = new Map<string, { tid: string; attr: Attr }>();
  for (const a of agents) {
    const direct = agentBinding.get(a.agent_id) ?? runBoundTid(a.run_id, a.wf_launch_id);
    if (direct !== undefined && taskById.has(direct)) {
      agentTid.set(a.agent_id, { tid: direct, attr: "exclusive" });
      continue;
    }
    if (a.launch_prompt_id !== null) {
      const parent = turnTid.get(`${a.session_id}${SEP}${a.launch_prompt_id}`);
      if (parent !== undefined) agentTid.set(a.agent_id, parent);
    }
  }

  // --- workflow runs -------------------------------------------------------
  // `workflow_run.tid` had NO writer at all: the column existed, the schema
  // referenced it, and `est block`'s "phase 4 of a 3-phase workflow" guard read it —
  // against a table in which it was NULL on every row, so that guard has never once
  // fired. Resolution mirrors the agent rule exactly, and its last step is a
  // MAJORITY over the run's own agents so that a run whose launching turn was never
  // claimed still lands on the task its work actually belonged to.
  const runTid = new Map<string, string>();
  for (const w of workflowRuns) {
    const key = runKey(w.run_id, w.wf_launch_id);
    const direct = runBoundTid(w.run_id, w.wf_launch_id);
    if (direct !== undefined && taskById.has(direct)) {
      runTid.set(key, direct);
      continue;
    }
    if (w.launch_prompt_id !== null) {
      const parent = turnTid.get(`${w.session_id}${SEP}${w.launch_prompt_id}`);
      if (parent !== undefined) {
        runTid.set(key, parent.tid);
        continue;
      }
    }
    // The vote is over THIS LAUNCH's agents. Pooled by `run_id`, a relaunch under a
    // reused runId voted with its predecessor's agents and this row was stamped with
    // a task none of its own agents belonged to — while `runTid`'s key was already
    // the (run, launch) pair, so the function contradicted itself.
    const counts = new Map<string, number>();
    for (const a of agentsForLaunch(w.run_id, w.wf_launch_id)) {
      const t = agentTid.get(a.agent_id);
      if (t === undefined) continue;
      counts.set(t.tid, (counts.get(t.tid) ?? 0) + 1);
    }
    // Ties break on the tid string ASC — the same convention `src/eta.ts` uses for
    // `run_segment.tid`, and the reason a re-sweep of unchanged inputs is a no-op
    // rather than a coin flip that rewrites the column every night.
    let best: string | null = null;
    let bestN = 0;
    for (const tid of [...counts.keys()].sort()) {
      const n = counts.get(tid) ?? 0;
      if (n > bestN) {
        best = tid;
        bestN = n;
      }
    }
    if (best !== null) runTid.set(key, best);
  }

  // --- requests ------------------------------------------------------------
  // Two populations, and the second is what makes this pass able to REMOVE a claim.
  //
  //  1. Every request in a session attribution can reach — a bound session, or the
  //     session of an agent that resolved a tid. These are the rows that may WIN a
  //     claim this pass.
  //  2. Every request that still HOLDS a claim, wherever it lives. `turn`,
  //     `agent_run` and `workflow_run` are cleared globally in the write transaction
  //     below, so they lose a claim automatically; `request` is diffed against the
  //     computed assignment instead, which only reaches rows the SELECT returned.
  //     Scoped to (1) alone, unbinding one task while a sibling task kept its own
  //     aliases took that session out of scope, so its requests were never revisited
  //     and kept the dead task's `tid`/`attr='exclusive'` forever — permanently, on
  //     the one table `v_wcet`, `burn_cache` and `outcome` all read. Including them
  //     here means they are re-evaluated, find nothing that claims them, and are
  //     written back to `{tid: null, attr: 'none'}`.
  //
  // `replay` rows are excluded from (2) for the reason they are excluded everywhere
  // (§5.2), and they are skipped again in the loop.
  const scopeSessions = new Set<string>(boundSessions);
  for (const a of agents) if (agentTid.has(a.agent_id)) scopeSessions.add(a.session_id);
  const sessionList = [...scopeSessions];
  const claimHolders = `attr <> 'replay' AND (tid IS NOT NULL OR attr = 'pre_task')`;
  const requests: ReqRow[] = db
    .query<ReqRow, string[]>(
      `SELECT request_id, session_id, prompt_id, agent_id, run_id, wf_launch_id, ts, attr, tid,
              origin, attribution_skill
         FROM request
        WHERE (${claimHolders})${
          sessionList.length === 0 ? "" : ` OR session_id IN (${placeholders(sessionList.length)})`
        }`,
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
    const viaRun = runBoundTid(r.run_id, r.wf_launch_id);
    const viaTurn = r.prompt_id === null ? undefined : turnTid.get(`${r.session_id}${SEP}${r.prompt_id}`);
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
    //
    // MAIN-CHAIN ONLY. The rule's subject is the handful of requests the estimating
    // skill itself makes while anchoring a task, and those are by construction
    // `origin='main'`. `attribution_skill` is not scoped that way: the harness stamps
    // the ACTIVE skill onto every request that descends from the turn it was active
    // on, so a workflow launched from an anchoring turn hands the tag to every one of
    // its subagents. Without this qualifier those subagents — the delegated WORK, not
    // the ceremony — were booked to `overhead` and dropped out of `actual_wcet`,
    // which understated one live task by 3.4x (a majority of its Work-CET vanished
    // into the ceremony bucket; DECISIONS.md §8.7b). Narrowing here rather than at
    // ingest keeps `attribution_skill` an honest record of what the harness reported
    // and leaves the correction one idempotent re-attribution away.
    if (r.attribution_skill === "estimating" && r.origin === "main" && assign.tid !== null) {
      assign = { tid: assign.tid, attr: "overhead" };
    }

    byAttr[assign.attr] = (byAttr[assign.attr] ?? 0) + 1;
    if (r.tid !== assign.tid || r.attr !== assign.attr) {
      updates.push({ request_id: r.request_id, tid: assign.tid, attr: assign.attr });
    }
  }

  // --- write, batched ------------------------------------------------------
  db.transaction(() => {
    // CLEAR, then write. `turn`/`agent_run`/`workflow_run` were SET-only, so a row
    // that LOST its claim kept a stale tid forever and no amount of re-sweeping
    // could take it back — which is what made a mis-attribution permanent and a
    // repair a bespoke migration instead of a plain `est sweep`. `request` reaches
    // the same answer by a different route: it diffs against `assign.tid` (null
    // included) over a SELECT that now deliberately includes every claim-holding row
    // in the database, not just the in-scope sessions — see the requests block above
    // for what the narrower scope left stranded.
    //
    // The global scope is not a shortcut: this pass recomputes EVERY bound task from
    // scratch (see the module docstring), and the two early returns above happen
    // before this transaction opens, so there is no path on which the clear runs and
    // the rewrite does not. An exception between them rolls the whole thing back.
    db.query("UPDATE turn SET tid = NULL WHERE tid IS NOT NULL").run();
    db.query("UPDATE agent_run SET tid = NULL WHERE tid IS NOT NULL").run();
    db.query("UPDATE workflow_run SET tid = NULL WHERE tid IS NOT NULL").run();

    const turnStmt = db.prepare(
      "UPDATE turn SET tid = $tid WHERE session_id = $session_id AND prompt_id = $prompt_id",
    );
    for (const [key, v] of turnTid) {
      const sep = key.indexOf(SEP);
      turnStmt.run({
        $tid: v.tid,
        $session_id: key.slice(0, sep),
        $prompt_id: key.slice(sep + 1),
      } as never);
    }
    const agentStmt = db.prepare("UPDATE agent_run SET tid = $tid WHERE agent_id = $agent_id");
    for (const [agentId, v] of agentTid) agentStmt.run({ $tid: v.tid, $agent_id: agentId } as never);

    const runStmt = db.prepare(
      "UPDATE workflow_run SET tid = $tid WHERE run_id = $run_id AND wf_launch_id = $wf_launch_id",
    );
    for (const [key, tid] of runTid) {
      const sep = key.indexOf(SEP);
      runStmt.run({
        $tid: tid,
        $run_id: key.slice(0, sep),
        $wf_launch_id: key.slice(sep + 1),
      } as never);
    }

    const reqStmt = db.prepare("UPDATE request SET tid = $tid, attr = $attr WHERE request_id = $rid");
    for (const u of updates) reqStmt.run({ $tid: u.tid, $attr: u.attr, $rid: u.request_id } as never);
  }).immediate();

  return {
    tasks: tasks.length,
    turns_assigned: turnsAssigned,
    agents_assigned: agentTid.size,
    runs_assigned: runTid.size,
    requests_assigned: updates.length,
    by_attr: byAttr,
  };
}

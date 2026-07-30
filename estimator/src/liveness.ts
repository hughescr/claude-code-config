/**
 * src/liveness.ts — the ONE answer to "is this delegation still running", and the knob
 * that bounds it.
 *
 * **Why this is its own module.** The rule was born in `src/eta.ts` for P2.1's idle
 * suppression, and §6.2's quiescence gate needs exactly the same rule for its fifth arm
 * (Craig, 2026-07-30) — but `src/eta.ts` already imports `src/close.ts` (for
 * `liveSessionIds`), so having `close.ts` import `eta.ts` back would close an import
 * cycle. The alternative to moving it was a second copy of the predicate in `close.ts`,
 * which is precisely the failure this project keeps naming: two answers to one question,
 * drifting apart silently, with a passing suite on both sides.
 *
 * `src/eta.ts` re-exports every name below rather than redeclaring it, so existing
 * importers (`src/burn.ts`, `test/eta.test.ts`) are unchanged and there is still only
 * one definition.
 */

import type { Database } from "bun:sqlite";
import { getConfig } from "./db.ts";
import { isoNow } from "./tasks.ts";

/** A `config` row read as a number, with the seed as the floor of trust. */
export function configNum(db: Database, key: string, dflt: number): number {
  const raw = getConfig(db, key);
  if (raw === null) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * How long an unfinished `agent_run` keeps counting as work in flight, in minutes.
 *
 * `config.eta_live_agent_max_min`, seeded at **120** — the same wall clock
 * `attr_stale_minutes` uses to close a turn's attribution window (§5.4), and chosen to
 * match it rather than invented here: both answer "how long may something the transcript
 * never closed still be believed", and two different answers to that in one system is a
 * knob nobody can reason about. A `config` row rather than a code constant for the same
 * reason `attr_stale_minutes` is one: it is a belief about Craig's own working shape,
 * and the retro is expected to fit it.
 */
export const DEFAULT_ETA_LIVE_AGENT_MAX_MIN = 120;

export function liveAgentMaxMin(db: Database): number {
  const v = configNum(db, "eta_live_agent_max_min", DEFAULT_ETA_LIVE_AGENT_MAX_MIN);
  return v > 0 ? v : DEFAULT_ETA_LIVE_AGENT_MAX_MIN;
}

/**
 * Count the agents that are still plausibly RUNNING — the one liveness rule in the
 * system, called by the session-scoped idle predicate (`blockState`), the task-scoped
 * `agents.live` the statusline prints (`agentCounts` in src/burn.ts), and §6.2's
 * quiescence gate (`quiescence()` condition 5, src/close.ts).
 *
 * **Why an age bound exists at all (Craig, 2026-07-30).** "Started and never ended" is
 * what a live agent looks like — and also what an agent that DIED looks like. §5.6
 * already names that population (`agent_never_returned`) and it is not small: measured on
 * the live corpus, **54** unfinished `agent_run` rows, **49 of them started more than six
 * hours earlier**, across 9 sessions. Without a bound, one dead agent pins its session as
 * "busy" forever, so idle suppression could never fire for it — neutering the fix for
 * exactly the long-lived sessions it was built for.
 *
 * **And it pinned the quiescence gate the same way.** Arm 5 used a raw
 * `started_at IS NOT NULL AND ended_at IS NULL` count, so a single corpse blocked its
 * task from EVER being closeable — by a human or, since 2026-07-30, by the sweeper's
 * close pass. That is the exact population the close pass exists to reach (work that
 * finished, session gone, nothing left to end the run), so the unbounded arm made the
 * pass unable to close the tasks it was built for. One rule, one threshold, both callers.
 *
 * **The clock is `MAX(started_at, last request the agent made)`, not `started_at` alone.**
 * That distinction is the whole reason the bound is safe to apply. An agent that is
 * genuinely working emits requests, so its clock keeps advancing and a three-hour run is
 * never mistaken for a corpse; an agent that died stops emitting, and its clock freezes at
 * the moment it stopped. Bounding on `started_at` alone would have aged out real long
 * runs, which is the one direction this must not fail in — a false "awaiting input" while
 * Claude is mid-delegation is a wrong statement on screen, and a premature close is a
 * wrong number in the corpus. `request(agent_id)` is indexed (`ix_req_agent`), so the
 * signal costs an index probe per unfinished agent, and only unfinished agents are probed.
 *
 * **`julianday()` on both sides, never a string compare.** `agent_run.started_at` carries
 * milliseconds and `request.ts` is ISO seconds; at index 19 `'.' < 'Z'`, so a lexicographic
 * MAX would silently prefer the seconds-precision value at a shared second. Immaterial
 * against a 120-minute threshold and wrong on principle — and src/eta.ts has the
 * `run_segment.ended_at` scar to show where that reasoning ends up.
 */
export function countLiveAgents(
  db: Database,
  scope: { session: string } | { tid: string },
  now: Date,
  maxMin: number,
): number {
  const freshSince = isoNow(new Date(now.getTime() - maxMin * 60_000));
  const where = "session" in scope ? "a.session_id = ?1" : "a.tid = ?1";
  const key = "session" in scope ? scope.session : scope.tid;
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM agent_run a
          WHERE ${where} AND a.started_at IS NOT NULL AND a.ended_at IS NULL
            AND MAX(julianday(a.started_at),
                    COALESCE((SELECT MAX(julianday(r.ts)) FROM request r
                               WHERE r.agent_id = a.agent_id), 0)) >= julianday(?2)`,
      )
      .get(key, freshSince)?.n ?? 0
  );
}

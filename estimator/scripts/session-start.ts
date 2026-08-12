#!/usr/bin/env bun
/**
 * scripts/session-start.ts — SessionStart hook body: make the estimator's whole read
 * surface correct at the moment Craig arrives, instead of at the next cron.
 *
 * **What a session start is, and why it is the best trigger in the machine.** It is the
 * one event that marks a hard discontinuity: whatever was true when the last session
 * ended has had hours to rot, and Craig is about to look at a statusline built from it.
 * Three things are stale in exactly that window, and one micro-sweep fixes all three:
 *
 *   1. `burn_cache` — `scripts/statusline-burn.ts` refuses a row older than the P1.9
 *      staleness window, so the burn segment is BLANK on arrival until something sweeps.
 *      `prompt-sweep.ts` fixes that on the first prompt; this fixes it before it.
 *   2. Liveness — `run_segment`'s terminators and P2.1's idle suppression both answer
 *      from `~/.claude/sessions/<pid>.json`. Every session that died with the laptop
 *      left an orphan there, and the segments they pinned open stay open until a sweep
 *      re-cuts them.
 *   3. **Pending closes** — since 2026-07-30 the sweep runs the close pass
 *      (`src/autoclose.ts`), so the tasks that went quiet while Craig was away get
 *      finalized on arrival rather than lingering as `in_progress` on the board. This
 *      is the reason the hook exists at all: a resumed session that immediately shows
 *      four stale open tasks is the failure mode, and the close pass's own throttle
 *      (`close_pass_min_interval_min`) means asking for it here costs nothing when the
 *      answer is "already done".
 *
 * **Silence is a HARD requirement here, harder than for UserPromptSubmit.** A
 * SessionStart hook's stdout is injected into the model's context as ADDITIONAL CONTEXT
 * for the session — it is the documented mechanism for a hook to feed the model
 * something. Anything this script prints therefore becomes an unattributable preamble
 * on every single session, forever, and it would be read as instructions. So the
 * contract is: nothing on stdout, ever, on any path, and `session-start-hook.sh`
 * discards both streams as a second guard.
 *
 * **Fail-open, like every other estimator hook (P1.0).** Every path ends in
 * `process.exit(0)`; unparseable stdin, a missing session id and any thrown exception
 * are all "do nothing, quietly".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT } from "../src/db.ts";
import { maybeSpawnMicrosweep } from "../src/microsweep.ts";

// Same resolution as scripts/prompt-sweep.ts and scripts/nudge.ts, for the same reason:
// the throttle marker is only shared if every caller agrees where it lives.
const SPOOL_DIR = process.env.EST_SPOOL_DIR ?? join(DATA_ROOT, "spool");

/**
 * How recently another hook must have swept for a session start to decline, in seconds.
 *
 * The TIGHTEST preference in the machine — 5 s, against the nudge's 20 and the prompt
 * hook's 30 — because a session start is also the RAREST of the three and the one whose
 * caller has waited the longest for fresh numbers. The only thing 5 s declines is a
 * sweep that is still finishing, which is precisely when re-spawning would be wasteful.
 *
 * The marker is global (see src/microsweep.ts), so this is a preference rather than a
 * private window: starting a second session ten seconds after a first still sweeps,
 * and starting one during another hook's in-flight sweep correctly does not.
 */
const SESSION_START_MICROSWEEP_MIN_INTERVAL_S = 5;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(): void {
  let sessionId: string | null = null;
  try {
    const raw = readStdin();
    if (raw.trim().length > 0) {
      const input = JSON.parse(raw) as { session_id?: unknown };
      if (typeof input.session_id === "string" && input.session_id.length > 0) {
        sessionId = input.session_id;
      }
    }
  } catch {
    process.exit(0); // unparseable stdin: fail open, print nothing
  }

  // Validated, not used as a filter — `est sweep` still has no `--session` scope (see
  // src/microsweep.ts), and the corpus-wide sweep is what refreshes every open task's
  // row anyway. It is required as the one cheap signal that this really is a hook
  // payload: a stray invocation with no session id should not be spawning sweeps.
  //
  // `source` (startup | resume | clear | compact) is deliberately NOT branched on. All
  // four mean "a context boundary just happened and the read caches are older than it",
  // and a per-source rule would be a second throttle nobody can reason about.
  if (sessionId === null) process.exit(0);

  maybeSpawnMicrosweep(SPOOL_DIR, SESSION_START_MICROSWEEP_MIN_INTERVAL_S);
  process.exit(0);
}

if (import.meta.main) {
  try {
    main();
  } catch {
    // Exhaustive fail-open: any thrown exception -> print nothing, exit 0.
    process.exit(0);
  }
}

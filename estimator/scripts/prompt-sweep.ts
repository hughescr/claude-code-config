#!/usr/bin/env bun
/**
 * scripts/prompt-sweep.ts — UserPromptSubmit hook body: keep the statusline burn
 * segment from going blank while Craig is only talking.
 *
 * **The problem this exists for.** `scripts/statusline-burn.ts` refuses to render a
 * `burn_cache` row older than the staleness window (P1.9: "a statusline that shows a
 * wrong number is worse than one that shows nothing"). That row is only ever refreshed
 * by a sweep, and the only mid-session sweep trigger was P1.10 job 3 — the micro-sweep
 * on `PostToolUse(Task|Workflow)`. So the segment stayed correct during fan-out and
 * silently VANISHED during conversation-only stretches, which is exactly when a glance
 * at the burn is cheapest and most useful. A prompt submission is the one event that
 * reliably marks Craig as present, so it is the right thing to hang a refresh on.
 *
 * **This is the micro-sweep half of the nudge and NOTHING else.** No compliance line,
 * no binding lookup, no overrun check, no database read at all: the estimating-skill
 * nudge is about launches, and re-litigating it on every prompt would be nagging.
 *
 * **Silence is a hard requirement, not a style choice.** A UserPromptSubmit hook's
 * stdout is injected verbatim into the model's context on every single prompt. Anything
 * this script prints becomes a permanent tax on every turn of every session, so the
 * contract here is stricter than the nudge's: on success it writes NOTHING to stdout,
 * ever, and `prompt-sweep-hook.sh` discards both streams as a second guard.
 *
 * **Fail-open, like every other estimator hook (P1.0).** Every path ends in
 * `process.exit(0)`; unparseable stdin, a missing session id and any thrown exception
 * are all "do nothing, quietly".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/db.ts";
import { maybeSpawnMicrosweep } from "../src/microsweep.ts";

// Same resolution as scripts/nudge.ts, for the same reason: tests must be able to point
// the marker somewhere other than the deployed spool/, and the two hooks have to agree
// about where that is or the shared throttle is not shared.
const SPOOL_DIR = process.env.EST_SPOOL_DIR ?? join(ROOT, "spool");

/**
 * How often a prompt may trigger a sweep, in seconds.
 *
 * Looser than the nudge's 20 s (`DEFAULT_MICROSWEEP_MIN_INTERVAL_S`) because the two
 * events mean different things: a `Task`/`Workflow` fire says work is in flight and the
 * numbers are moving, whereas a burst of short prompts is Craig typing, during which
 * nothing has burned. 30 s is still far inside the statusline's staleness window, so a
 * refresh always lands before the segment would blank — while a rapid-fire exchange
 * collapses to one sweep instead of one per message.
 *
 * The marker is global (see src/microsweep.ts), so this is a preference rather than a
 * private window: a prompt arriving inside another hook's fresher window simply
 * declines, which is the correct outcome — the cache was just refreshed.
 */
const PROMPT_MICROSWEEP_MIN_INTERVAL_S = 30;

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

  // The id is validated but not used as a filter: `est sweep` still has no `--session`
  // scope (see src/microsweep.ts), so the sweep this spawns is corpus-wide and refreshes
  // every open task's row, this session's included. It is required anyway as the one
  // cheap signal that this really is a hook payload — a stray invocation with no session
  // id should not be spawning sweeps.
  if (sessionId === null) process.exit(0);

  maybeSpawnMicrosweep(SPOOL_DIR, PROMPT_MICROSWEEP_MIN_INTERVAL_S);
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

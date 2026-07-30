/**
 * src/microsweep.ts — the throttled, detached micro-sweep shared by every hook that
 * wants the read caches (`burn_cache` above all) to be fresher than the daily cron
 * makes them.
 *
 * This is job 3 of `scripts/nudge.ts` (P1.10), lifted out verbatim when a SECOND
 * caller appeared: `scripts/prompt-sweep.ts`, the UserPromptSubmit hook that keeps the
 * statusline burn segment alive during conversation-only stretches (the segment blanks
 * itself once `burn_cache.as_of` is >120 s old — P1.9's honesty rule — and before this
 * hook existed the only thing that ever refreshed it mid-session was a `Task`/`Workflow`
 * PostToolUse fire).
 *
 * It lives in `src/` rather than in one of the two scripts on purpose: the throttle is
 * only a throttle if every caller checks the SAME marker with the SAME semantics. Two
 * copies of this function would be two independent windows, which is exactly the
 * sweep pile-up the marker exists to prevent.
 *
 * Contract, unchanged from P1.10 job 3:
 *
 *  - **Never throws, never blocks.** Every failure path returns quietly; the child is
 *    `detached` with `stdio: "ignore"` and `unref`ed, so it cannot consume the calling
 *    hook's timeout and cannot write to the hook's stdout (which for UserPromptSubmit
 *    would be injected straight into Craig's context).
 *  - **Never writes to the database from the hook process.** The spawned `est sweep`
 *    takes the writer lock; this function only stats and touches a marker file.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./db.ts";
import { MICROSWEEP_MARKER } from "./spool.ts";

/**
 * The window `scripts/nudge.ts` has always used, and the floor for every caller: a
 * `Task`/`Workflow` fire is evidence that work is in flight, so it buys the tightest
 * refresh the throttle allows.
 */
export const DEFAULT_MICROSWEEP_MIN_INTERVAL_S = 20;

/**
 * `EST_MICROSWEEP_MIN_INTERVAL_S` overrides whatever the caller asked for — one knob
 * for the whole machine, because the marker is one file. A missing or unparseable
 * value falls back to the caller's default rather than to `NaN`: the original
 * `parseInt(env ?? "20")` turned a typo'd variable into "never throttle", which is the
 * one direction this function must not fail in.
 */
function resolveMinIntervalS(fallbackS: number): number {
  const raw = process.env.EST_MICROSWEEP_MIN_INTERVAL_S;
  if (raw === undefined || raw.trim() === "") return fallbackS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallbackS;
}

/** Where `bun` actually is: hook processes run with a PATH that has neither location. */
export function findBun(): string | null {
  const explicit = process.env.EST_BUN;
  if (explicit && existsSync(explicit)) return explicit;
  const onPath = Bun.which("bun");
  if (onPath) return onPath;
  for (const candidate of [
    join(homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Spawn a throttled, DETACHED sweep so the calling hook never waits on it.
 *
 * DESIGN.md P1.10 specifies `est sweep --session <sid> --since <watermark>` — a scoped
 * micro-sweep. Those flags still do not exist on `est sweep`; passing them would make
 * cli.ts's flag validator reject the call outright and do NO sweep at all, which is
 * worse than the corpus-wide fallback. So this spawns the existing, idempotent,
 * incremental `est sweep --quiet` — sub-second on a swept corpus, but corpus-wide in
 * its discovery walk and contending for the writer lock every time. When the scoped
 * flags land, the spawn line below is the only one to change.
 *
 * **The throttle marker is therefore GLOBAL, not per-session, and now also not
 * per-hook.** A per-session marker gives every concurrently active session its own
 * window, so N sessions fan out into N unscoped corpus sweeps — precisely the pile-up
 * the throttle exists to prevent, and unobservable because the child is detached. One
 * marker collapses the whole machine to one sweep per window, whichever hook got there
 * first. That is also why `minIntervalS` is a per-caller *preference*, not a per-caller
 * window: a prompt submitted 25 s after a `Task` fire's sweep sees a 5-second-old
 * marker and correctly declines to sweep again.
 *
 * @param spoolDir  The caller's already-resolved spool directory. Passed in rather than
 *                  recomputed here so a hook and its tests cannot end up disagreeing
 *                  about which directory the marker lives in.
 * @param minIntervalS  Caller's preferred minimum seconds between sweeps;
 *                  `EST_MICROSWEEP_MIN_INTERVAL_S` overrides it.
 */
export function maybeSpawnMicrosweep(
  spoolDir: string,
  minIntervalS: number = DEFAULT_MICROSWEEP_MIN_INTERVAL_S,
): void {
  // Test-only escape hatch: unset (the production default) leaves this fully active.
  // A real sweep is slow and corpus-wide (see above), which makes it unsuitable to
  // actually exec from most unit tests.
  if (process.env.EST_DISABLE_MICROSWEEP === "1") return;
  try {
    mkdirSync(spoolDir, { recursive: true });
    const marker = join(spoolDir, MICROSWEEP_MARKER);
    let lastMs = 0;
    try {
      lastMs = statSync(marker).mtimeMs;
    } catch {
      lastMs = 0;
    }
    if (Date.now() - lastMs < resolveMinIntervalS(minIntervalS) * 1000) return; // throttled

    // Touch the marker BEFORE spawning so a burst of hook fires within the window
    // collapses to at most one spawn even if the spawn itself is slow.
    writeFileSync(marker, String(Date.now()));

    const bun = findBun();
    if (bun === null) return;
    const cliPath = join(ROOT, "src", "cli.ts");
    const child = spawn(bun, ["run", cliPath, "sweep", "--quiet"], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Fail open: no sweep this time. The next hook fire, the daily cron, or a manual
    // `est sweep` catches it. Never let this block or throw.
  }
}

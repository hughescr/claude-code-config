/**
 * test/preload.ts — global `bun test` preload (wired via bunfig.toml `[test].preload`).
 *
 * P2.9 (`src/jobs.ts`) reads `~/.claude/jobs` by default (`JOBS_ROOT`, `EST_JOBS`
 * override). Without this preload, every EXISTING test that drives `est sweep` /
 * `est retro` through the CLI — none of which pass a jobs-root override, because
 * that override did not exist before P2.9 — would read the REAL `~/.claude/jobs`
 * on whatever machine runs the suite: nondeterministic, and a live-machine-state
 * leak into a test run of exactly the kind the design's own rule forbids for the
 * live database (P2.12: "no review, test or agent may point at the live
 * database"), extended here to the live jobs directory for the same reason.
 *
 * Fixed at process start, guaranteed not to exist (nobody creates it), so
 * `reconcileJobs`/`jobsRetroPanel` see an absent directory and degrade to the
 * documented empty result — the same "not configured" shape Phase 1 degrades to
 * when OTEL is unconfigured. A test that wants REAL job fixtures passes an
 * explicit `jobsRoot` to `reconcileJobs`/`jobsRetroPanel` directly, which always
 * wins over this default.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EST_JOBS ??= join(tmpdir(), `est-test-no-jobs-${process.pid}-${Date.now()}`);

/**
 * Same argument, same fix, for `~/.claude/sessions` (`SESSIONS_ROOT`, `EST_SESSIONS`
 * override). P2.1's segment terminator asks "is a harness process still holding this
 * session?" on every `refreshSegments`, and §6.2's quiescence check has always asked
 * it too. Both answer from a live directory of `<pid>.json` files on the machine
 * running the suite, so without this a test's classification of a segment as
 * `session_end` would depend on who happens to have Claude Code open. A test that
 * wants specific live sessions passes an explicit root to `livePidsForSessions` /
 * `liveSessionPids`, which always wins over this default.
 */
process.env.EST_SESSIONS ??= join(tmpdir(), `est-test-no-sessions-${process.pid}-${Date.now()}`);

/**
 * Same argument, sharper consequence, for the hook / OTEL spool (`SPOOL_DIR`,
 * `EST_SPOOL_DIR` / `EST_SPOOL` override).
 *
 * `drainSpool` and `drainOtel` do not merely READ the spool — they consume it: rename
 * the jsonl to `.draining`, then `rmSync` it once the transaction commits. `pruneMarkers`
 * deletes `.microsweep` and the overrun markers in the same pass. The spool is the ONLY
 * copy of those records until a sweep turns them into rows, so a test sweep that reached
 * the deployed spool would not just read live machine state, it would DESTROY it — and
 * because `SPOOL_DIR` is `spoolDirFrom(process.env)` evaluated at import, "the deployed
 * spool" is wherever the suite happens to be running from, which for this project is the
 * directory the receiver writes to.
 *
 * `runSweep` also derives its spool from the database's own directory now, so this is the
 * second of two independent guards rather than the only one. A test that wants a real
 * spool passes an explicit directory to `drainSpool` / `drainOtel` (they all do) or a
 * `spoolDir` to `runSweep`, either of which wins over this default.
 */
process.env.EST_SPOOL_DIR ??= join(tmpdir(), `est-test-no-spool-${process.pid}-${Date.now()}`);

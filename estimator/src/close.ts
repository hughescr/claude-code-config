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
import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attributeTasks } from "./attribute.ts";
import { intervalUnion, taskIntervals } from "./burn.ts";
import { getConfig } from "./db.ts";
import { PROJECTS_ROOT } from "./discover.ts";
import { countLiveAgents, liveAgentMaxMin } from "./liveness.ts";
import { clearOverrunMarker, SPOOL_DIR } from "./spool.ts";
import { bandUnscorable, InvariantError, isoNow, TERMINAL_TASK_STATUS } from "./tasks.ts";

/** Where the harness records live sessions (`<pid>.json`); `EST_SESSIONS` overrides. */
export const SESSIONS_ROOT: string =
  process.env.EST_SESSIONS ?? join(homedir(), ".claude", "sessions");

/** §6.2: a task with no completion signal is still closeable once this stale. */
export const STALE_CLOSE_HOURS = 48;

// ---------------------------------------------------------------------------
// `--accept`: consent has to be a FACT IN THE CORPUS, not an assertion
// ---------------------------------------------------------------------------

/**
 * Fold a quote to the form two records of the same sentence can be compared in:
 * case, run-length whitespace, and the quote glyphs a terminal and a chat client
 * disagree about (`'` vs `’`, `"` vs `“`).
 *
 * Nothing else is touched. Stripping punctuation or stemming would start matching
 * sentences the human did not say, and the entire value of this check is that the
 * match is of THEIR words.
 */
export function normalizeAcceptance(s: string): string {
  return s
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Shortest quote the verification will accept, in normalized characters.
 *
 * A bare substring test with no floor verifies `--accept "ok"` against the "ok" inside
 * "token", and against essentially any transcript ever written — which turns the check
 * back into the assertion it exists to replace. Two guards together fix that: this
 * floor, and whole-phrase matching below.
 *
 * **12 is chosen against the criterion the skill states, not against a corpus.** Every
 * acceptance SKILL.md §6 sanctions clears it comfortably — "i accept the task is done"
 * (25), "i approve this as complete" (26), "accepted, close it out" (22) — while the
 * phrases that are explicitly NOT acceptance fall under it: "ok" (2), "yes" (3), "done"
 * (4), "thanks" (6), "ship it" (7), "looks good" (10). A first-person acceptance of
 * completion is a sentence; it cannot be two syllables. If a legitimate shorter form
 * ever appears, the fix is to widen the criterion in SKILL.md and this constant
 * together, deliberately — not to let one word through.
 */
export const MIN_ACCEPTANCE_CHARS = 12;

/** Escape a normalized needle for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does the normalized haystack contain the needle as a WHOLE PHRASE?
 *
 * Bounded by non-word characters or the ends of the string, so "ok" no longer matches
 * inside "token" and "i accept" no longer matches inside "i accepted the risk". The
 * floor above stops the trivially-common needle; this stops the accidental one, and the
 * two failures are different enough that neither guard covers the other.
 */
function containsPhrase(haystack: string, needle: string): boolean {
  return new RegExp(`(?:^|[^\\w])${escapeRe(needle)}(?:$|[^\\w])`).test(haystack);
}

/** Human-authored text on one transcript line, or null when the line has none. */
function humanText(line: Record<string, unknown>): string | null {
  if (line.type !== "user" || line.isSidechain === true) return null;
  // A `tool_result` is a user-ROLE line the harness wrote, and one of the things it
  // routinely contains is this CLI's own stdout. Without this exclusion an agent could
  // manufacture its own evidence: print the sentence, let the transcript record the
  // print, then "verify" against it.
  if (line.toolUseResult !== undefined) return null;
  const content = (line.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "text") continue;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/**
 * Did a human actually say this, in one of the sessions bound to the task?
 *
 * **Why a check at all.** `--accept` is the one gate bypass an agent may reach for, and
 * an agent asserting "he accepted" is exactly the self-report the whole design refuses
 * everywhere else (§P1.12: no flag takes a number *because* the agent would be grading
 * its own work). The project already answers this shape of problem the same way for
 * scope: `sweeper_diff` detects undeclared drift from the corpus rather than trusting a
 * declaration. Consent gets the same treatment — the words have to be findable in the
 * transcript the harness wrote.
 *
 * **Three things a match must be**, because a bare substring test is not evidence:
 * long enough that a common word cannot serve ({@link MIN_ACCEPTANCE_CHARS}), a whole
 * phrase rather than a fragment inside a longer word ({@link containsPhrase}), and
 * SAID AFTER the task existed (`notBefore`). The last one matters as much as the
 * others: a session is long-lived and hosts many tasks, so without it one acceptance
 * typed in the morning would verify every task opened in that session for the rest of
 * the day — the consent would be real and its object would be a task that had not been
 * conceived of when it was given.
 *
 * **What it does NOT prove.** That the human MEANT it as acceptance of THIS task.
 * A verified quote can still be a fragment lifted out of context, or an acceptance of
 * another of the session's tasks. The check moves the failure mode from "an agent can
 * invent consent" to "an agent can misread consent that was given", which is a strictly
 * smaller and much noisier thing to get away with — and the `accepted_close` row keeps
 * the quote, so a human reading the ledger can see exactly what was relied on. SKILL.md
 * carries the other half: ask rather than construe.
 *
 * Reads each transcript as a stream (`scanLinesSync`, below) and stops at the first
 * matching line rather than loading the whole file and running to EOF (2026-07-30).
 */
/**
 * Sync line-by-line scan of one file, stopping — and closing the fd — the instant
 * `onLine` returns true, rather than reading to EOF and deciding after.
 *
 * `readJsonl` (src/ingest.ts) already streams JSONL, but it is async, and
 * `acceptanceInTranscript`'s caller `closeTask` has to stay synchronous: it is
 * called without `await` throughout test/close.test.ts's consent tests
 * (`expect(() => closeTask(...)).toThrow(...)`, bare `.revision`/`.quiescence.ok`
 * reads on the return value), and an async function that throws before its first
 * `await` yields a rejected Promise there instead of a synchronous throw. So this
 * is a small sync sibling, not a reuse — fixed 64 KB reads via
 * `openSync`/`readSync` instead of one `readFileSync` of the whole file, decoded
 * with `TextDecoder` in streaming mode so a multi-byte UTF-8 character split
 * across a chunk boundary decodes correctly (same trick `readJsonl` uses). Any
 * failure (missing file, permission, a read error mid-file) reads as "no match" —
 * the same fate the `readFileSync` catch it replaces gave an unreadable file.
 */
function scanLinesSync(path: string, onLine: (line: string) => boolean): boolean {
  const CHUNK_SIZE = 64 * 1024;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false; // this project dir does not host that session
  }
  try {
    const chunk = Buffer.alloc(CHUNK_SIZE);
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK_SIZE, null);
      if (n === 0) break;
      buf += decoder.decode(chunk.subarray(0, n), { stream: true });
      // Scan with a moving offset and re-slice the buffer once per chunk, not once
      // per line — see `readJsonl` for why (quadratic otherwise).
      let start = 0;
      let nl = buf.indexOf("\n", start);
      while (nl >= 0) {
        if (onLine(buf.slice(start, nl))) return true;
        start = nl + 1;
        nl = buf.indexOf("\n", start);
      }
      if (start > 0) buf = buf.slice(start);
    }
    buf += decoder.decode(); // flush any trailing partial character
    return buf.length > 0 && onLine(buf); // trailing line with no final newline
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

export function acceptanceInTranscript(
  sessions: readonly string[],
  quote: string,
  root: string = PROJECTS_ROOT,
  /** ISO instant the task was minted; earlier words are not about it. */
  notBefore: string | null = null,
): boolean {
  const needle = normalizeAcceptance(quote);
  if (needle.length < MIN_ACCEPTANCE_CHARS) return false;
  const wanted = new Set(sessions.filter((s) => s !== ""));
  if (wanted.size === 0) return false;
  const parsedFloor = notBefore === null ? Number.NaN : Date.parse(notBefore);
  const floorMs = Number.isFinite(parsedFloor) ? parsedFloor : null;

  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    // No corpus on disk at all: unverifiable, which is a refusal, never a pass.
    return false;
  }
  for (const project of projects) {
    for (const session of wanted) {
      const path = join(root, project, `${session}.jsonl`);
      const matched = scanLinesSync(path, (line) => {
        // Cheap prefilter: only human lines can carry the quote, and JSON.parse of a
        // whole transcript is the expensive part.
        if (line === "" || !line.includes('"type":"user"')) return false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return false; // a torn tail is not evidence either way
        }
        if (parsed === null || typeof parsed !== "object") return false;
        const o = parsed as Record<string, unknown>;
        // No timestamp means the line cannot be placed relative to the task, and an
        // unplaceable line is not evidence. Compared as INSTANTS, not as strings: the
        // harness writes milliseconds and `task.created_at` does not, and `"...00.000Z"`
        // sorts BEFORE `"...00Z"` lexicographically.
        if (floorMs !== null) {
          const at = o.timestamp;
          if (typeof at !== "string") return false;
          const atMs = Date.parse(at);
          if (!Number.isFinite(atMs) || atMs <= floorMs) return false;
        }
        const text = humanText(o);
        return text !== null && containsPhrase(normalizeAcceptance(text), needle);
      });
      if (matched) return true;
    }
  }
  return false;
}

export type FinalStatus = "completed" | "abandoned" | "deleted" | "reopened";

/**
 * The gate refused this close — exit `2`, same as its parent, but IDENTIFIABLE.
 *
 * A distinct class rather than a `message` a caller matches on. `src/autoclose.ts` has to
 * tell "the gate said no" (the DESIGNED outcome for a candidate whose session is still
 * live — counted `blocked`, retried next pass) from "something is actually wrong with
 * this task" (counted `failed`, and after three attempts alerting). A regex over the
 * message made that discrimination hostage to the wording of an error string, which is
 * exactly the kind of coupling that breaks silently the day someone improves the prose.
 */
export class QuiescenceError extends InvariantError {
  constructor(
    message: string,
    remedy: string,
    readonly report: QuiescenceReport,
  ) {
    super(message, remedy);
  }
}

export interface QuiescenceReport {
  ok: boolean;
  /** Human-readable conditions that FAILED. Empty when `ok`. */
  failing: string[];
  completion_signal: boolean;
  /**
   * WHICH terminal status the observed completion signal names, or `null` when there is
   * none. `'deleted'` is not a synonym for `'completed'`: P1.11's whole point is that a
   * `TaskUpdate status:"deleted"` is captured because a deleted task must be recorded as
   * such, and a close pass that folded it into `completed` would launder the one signal
   * the delete-capture hook exists to preserve into its opposite.
   *
   * `'completed'` wins a tie: a task that was completed and later deleted was still
   * completed, and the actual is a measurement either way.
   */
  completion_kind: "completed" | "deleted" | null;
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

/**
 * ONE scan of `~/.claude/sessions/`, returning session id -> live pids.
 *
 * Both callers want the same directory read: §6.2's quiescence check asks about one
 * task's bound sessions, and P2.1's segment terminator asks about every session in the
 * corpus at once. A per-session `readdirSync` + `kill(0)` per file is the same answer
 * recomputed N times, which is a measurable cost on a sweep that touches hundreds of
 * sessions and no more correct.
 */
export function liveSessionPids(root = SESSIONS_ROOT): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    // No sessions directory is not "no live sessions proven" — but it is the only
    // answer available, and the other four quiescence conditions are the teeth.
    return out;
  }
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
    if (sid === null) continue;
    try {
      process.kill(pid, 0);
      const prev = out.get(sid);
      if (prev === undefined) out.set(sid, [pid]);
      else prev.push(pid);
    } catch {
      // ESRCH: an orphaned session file whose process is gone — §6.1's crash signal.
    }
  }
  return out;
}

/** The set of session ids with a live process — P2.1's `session_end` discriminator. */
export function liveSessionIds(root = SESSIONS_ROOT): Set<string> {
  return new Set(liveSessionPids(root).keys());
}

/** Sessions with a live process, from `~/.claude/sessions/<pid>.json`. */
export function livePidsForSessions(sessionIds: readonly string[], root = SESSIONS_ROOT): number[] {
  if (sessionIds.length === 0) return [];
  const wanted = new Set(sessionIds);
  const live: number[] = [];
  for (const [sid, pids] of liveSessionPids(root)) {
    if (wanted.has(sid)) live.push(...pids);
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
export interface QuiescenceOptions {
  /**
   * A live-session map computed ONCE by the caller (`liveSessionPids`).
   *
   * Condition 4 asks "does any bound session still have a process". Answering it means
   * a `readdir` of `~/.claude/sessions/` plus a `JSON.parse` and a `kill(0)` per file —
   * and `src/autoclose.ts` evaluates this gate once per candidate, so an unshared map is
   * the same directory walk repeated N times per sweep. That is a per-item call in a hot
   * path, which is a defect rather than a style choice. Absent, the gate reads the
   * directory itself, so every existing caller is unchanged.
   */
  livePids?: Map<string, number[]>;
}
export function quiescence(
  db: Database,
  tid: string,
  now: Date = new Date(),
  opts: QuiescenceOptions = {},
): QuiescenceReport {
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
  //
  // **Every signal is bounded below by the latest REOPEN** (Craig, 2026-07-30). A reopen
  // says the work restarted, and `task_event` is append-only: without the floor, the
  // event that justified the FIRST close still satisfies arm 1 forever, so a reopened
  // task became closeable again the moment it went quiet — re-closed by the sweeper on
  // evidence about a run that had already been finalized once. The floor is
  // `MAX(finalized_at)` over `final_status='reopened'` revisions; a task that has never
  // been reopened has no floor and behaves exactly as before.
  const reopenedAt = db
    .query<{ ts: string | null }, [string]>(
      "SELECT MAX(finalized_at) AS ts FROM outcome WHERE tid = ? AND final_status = 'reopened'",
    )
    .get(tid)?.ts ?? null;
  const boundTaskNums = db
    .query<{ session_id: string; local_id: string }, [string]>(
      "SELECT session_id, local_id FROM task_alias WHERE tid = ? AND id_kind = 'session_task'",
    )
    .all(tid);
  // `pending_verification`/`completed` are STATUSES, not events, so they carry no
  // timestamp to bound — but `est close --status reopened` moves the status back to
  // `in_progress`, so a reopened task cannot be sitting in either of them anyway.
  let completionKind: "completed" | "deleted" | null =
    task.status === "pending_verification" || task.status === "completed" ? "completed" : null;
  const seenKind = (kind: string): void => {
    // 'completed' wins a tie: a task completed and later deleted was still completed.
    if (kind === "completed") completionKind = "completed";
    else if (completionKind === null && kind === "deleted") completionKind = "deleted";
  };
  // Both alias shapes, not one. The `session_task` alias is how a planted `est_tid`
  // links, and `task_event.tid` is how §3.2 step 6's backfill links the same event once
  // the alias exists — a task can carry either, and reading only one of them made the
  // gate's answer depend on which path happened to fire first.
  //
  // `julianday()` on both sides of the reopen floor, never a lexicographic compare.
  // `task_event.ts` comes from a transcript and carries milliseconds; `outcome.finalized_at`
  // is `isoNow`, seconds. At index 19 `'.' < 'Z'`, so a string compare would read an event
  // 500 ms AFTER the reopen as being before it — the exact scar src/eta.ts carries for
  // `run_segment.ended_at`. `COALESCE(…, 0)` is the never-reopened case: `julianday('')` is
  // NULL, and a NULL comparison would silently exclude every event instead of none.
  const REOPEN_FLOOR = "julianday(e.ts) > COALESCE(julianday(?), 0)";
  for (const b of boundTaskNums) {
    const ev = db
      .query<{ kind: string }, [string, string, string | null]>(
        `SELECT e.to_status AS kind FROM task_event e
          WHERE e.session_id = ? AND e.task_num = ? AND e.to_status IN ('completed','deleted')
            AND ${REOPEN_FLOOR}
          ORDER BY CASE e.to_status WHEN 'completed' THEN 0 ELSE 1 END LIMIT 1`,
      )
      .get(b.session_id, b.local_id, reopenedAt);
    if (ev !== null && ev !== undefined) seenKind(ev.kind);
  }
  const linked = db
    .query<{ kind: string }, [string, string | null]>(
      `SELECT e.to_status AS kind FROM task_event e
        WHERE e.tid = ? AND e.tid IS NOT NULL AND e.to_status IN ('completed','deleted')
          AND ${REOPEN_FLOOR}
        ORDER BY CASE e.to_status WHEN 'completed' THEN 0 ELSE 1 END LIMIT 1`,
    )
    .get(tid, reopenedAt);
  if (linked !== null && linked !== undefined) seenKind(linked.kind);
  const completionSignal = completionKind !== null;
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

  // 4. no live pid among bound sessions. `opts.livePids` lets a batch caller pay for the
  //    directory walk once instead of once per task — see `QuiescenceOptions`.
  const livePids =
    opts.livePids === undefined
      ? livePidsForSessions(sessions)
      : sessions.flatMap((s) => opts.livePids?.get(s) ?? []);
  if (livePids.length > 0) failing.push(`live session process(es): ${livePids.join(", ")}`);

  // 5. every bound agent_run terminal — bounded by the SAME activity clock P2.1's idle
  //    suppression uses (`countLiveAgents`, src/liveness.ts; `eta_live_agent_max_min`,
  //    default 120 min). The arm used to count any run with `started_at IS NOT NULL AND
  //    ended_at IS NULL`, which is what a live agent looks like AND what §5.6's
  //    `agent_never_returned` population looks like — 54 such rows on the live corpus,
  //    49 of them older than six hours. One corpse therefore blocked its task from ever
  //    being closeable, by a human or by the sweeper, which made the close pass unable
  //    to close precisely the tasks it exists for (work finished, session gone, nothing
  //    left to end the run). The clock is last-observed-activity, not `started_at`, so a
  //    genuinely long delegation is never aged out — only one that stopped emitting.
  const nonterminal = countLiveAgents(db, { tid }, now, liveAgentMaxMin(db));
  if (nonterminal > 0) failing.push(`${nonterminal} bound agent_run(s) are still live`);

  return {
    ok: failing.length === 0,
    failing,
    completion_signal: completionSignal,
    completion_kind: completionKind,
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
  /**
   * The human's VERBATIM acceptance that the work is done (Craig, 2026-07-30).
   *
   * `--force` was specified as "the user's tool, not Claude's" on the assumption that
   * Craig would run it from a terminal, and that assumption does not survive contact:
   * **the human does not know this CLI exists.** What actually happens is that the
   * human states acceptance in the conversation, and the agent relays those words —
   * only that explicit consent may put the agent's hand on the close.
   *
   * So this is a THIRD state, not a synonym for `force`: the gate is bypassed the same
   * way, but the ledger row says who decided and quotes them, and the quote is
   * mandatory. An empty one is a usage error rather than a silently unattributed
   * override — a bypass whose provenance is "someone passed a flag" is the thing
   * `--force`'s anomaly already covers.
   */
  accept?: string | null;
  now?: Date;
  /** Where the hook markers live; tests point this at a temp dir. Defaults to the spool. */
  spoolDir?: string;
  /** Corpus root the `--accept` verification reads; tests point it at a temp corpus. */
  projectsRoot?: string;
  /**
   * SWEEPER ONLY: append a corrective revision to an already-closed task.
   *
   * Not reachable from the CLI, and deliberately: it is not a third way for a human or
   * an agent to bypass the gate, it is the mechanism that makes "a close is a revision"
   * true instead of merely documented (see {@link healClosedOutcomes}). It bypasses the
   * gate — the task is already closed, so every arm is moot — and records NO anomaly,
   * because the sweeper correcting its own arithmetic is not an event anyone needs to
   * be told about.
   */
  heal?: boolean;
  /**
   * SWEEPER ONLY: the caller has just run `attributeTasks` over the WHOLE corpus and
   * nothing has been ingested since, so this close may skip its own pass.
   *
   * Not a shortcut and not reachable from the CLI: it changes no arithmetic, it removes
   * a repeat of arithmetic the caller provably already did. `src/autoclose.ts` closes a
   * batch of candidates inside one sweep, immediately after `runSweep`'s attribution
   * step; without this every candidate re-attributes the entire corpus, which is
   * O(candidates x corpus) for an answer that cannot have changed between them.
   *
   * The `heal` path skips attribution for exactly this reason already — see the call
   * site below. This is the same claim made by a different caller, so it is the same
   * flag family rather than a second mechanism.
   */
  attributed?: boolean;
  /** Shared live-session map — see {@link QuiescenceOptions.livePids}. */
  livePids?: Map<string, number[]>;
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
  /** The gate was bypassed on the human's recorded acceptance — see {@link CloseInput.accept}. */
  accepted: boolean;
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
  // Present-but-empty is refused HERE as well as at the CLI, because the quote is the
  // entire evidentiary content of this path: a caller that reaches the library with
  // `accept: ""` has an acceptance it cannot produce, which is indistinguishable from
  // not having one.
  const acceptance = input.accept === null || input.accept === undefined ? null : input.accept.trim();
  if (acceptance !== null && acceptance === "") {
    throw new InvariantError(
      "est close --accept: the human's acceptance must be quoted",
      'pass their words verbatim, e.g. --accept "I accept the task is done"',
    );
  }
  const withAcceptance = acceptance !== null;
  // Guarded at BOTH layers, here and in `cmdClose`: the CLI's job is a good message,
  // and the library's is that no caller — a future verb, a script, a test — can reach a
  // state the CLI would have refused.
  if (withAcceptance && forced) {
    throw new InvariantError(
      "est close: --accept and --force are two different claims about the same close",
      "--accept records WHO decided; --force records that nobody is named. Pass exactly one",
    );
  }
  if (withAcceptance && (status === "reopened" || status === "deleted")) {
    throw new InvariantError(
      `est close --accept: an acceptance asserts the work is COMPLETE, so it cannot close as '${status}'`,
      "use --status completed (or abandoned, if they accepted stopping rather than finishing)",
    );
  }

  const task = db
    .query<{ status: string; anchor_session: string; created_at: string }, [string]>(
      "SELECT status, anchor_session, created_at FROM task WHERE tid = ?",
    )
    .get(input.tid);
  if (task === null || task === undefined) {
    throw new InvariantError(`unknown tid: ${input.tid}`, "run `est open` to mint a task first");
  }

  if (withAcceptance) {
    // An already-finalized task cannot be accepted again: the close it would bypass the
    // gate for has already happened, and a second acceptance of the same words would be
    // a second outcome revision with no new decision behind it.
    if (TERMINAL_TASK_STATUS.has(task.status)) {
      throw new InvariantError(
        `est close --accept: ${input.tid} is already ${task.status}`,
        "reopen it first (`est close <tid> --status reopened`) if the work restarted — closing is a revision, never an edit",
      );
    }
    // §P1.12 applied to consent: the agent does not get to be the evidence. The words
    // have to be in a transcript the harness wrote — see `acceptanceInTranscript` for
    // what that does and does not prove.
    const sessions = db
      .query<{ session_id: string }, [string]>(
        "SELECT DISTINCT session_id FROM task_alias WHERE tid = ? AND session_id <> ''",
      )
      .all(input.tid)
      .map((r) => r.session_id);
    if (!sessions.includes(task.anchor_session)) sessions.push(task.anchor_session);
    // Resolved at CALL time, not at import: `EST_PROJECTS` is how every other corpus
    // reader is pointed at a fixture, and a constant captured at import cannot be
    // redirected by a test that drives the real CLI in-process.
    const root = input.projectsRoot ?? process.env.EST_PROJECTS ?? PROJECTS_ROOT;
    // `created_at` is the floor: words typed before the task existed cannot be about it.
    if (!acceptanceInTranscript(sessions, acceptance, root, task.created_at)) {
      throw new InvariantError(
        `est close --accept: those words appear in no bound session's transcript for ${input.tid}, after it was opened`,
        "quote the human's acceptance EXACTLY as they typed it, in full — never paraphrase it, and never supply one they did not give. " +
          `It must be at least ${MIN_ACCEPTANCE_CHARS} characters and match as a whole phrase, because a single common word is not consent. ` +
          'If they have not accepted, ask them ("do you accept this task as complete?") or leave the close to the sweeper',
      );
    }
  }

  // Skipped on the two SWEEPER paths alone (`heal`, and the close pass's `attributed`):
  // `runSweep` has just run this pass over the whole corpus, and re-running it once per
  // healed or swept task is O(corpus) work for an answer that cannot have changed since.
  if (input.heal !== true && input.attributed !== true) attributeTasks(db);

  const gate = quiescence(db, input.tid, now, input.livePids === undefined ? {} : { livePids: input.livePids });
  // The acceptance bypasses EVERY arm, the open-turn one included, and that is the
  // point rather than an oversight: consent arrives mid-conversation, so the turn in
  // which Craig says "this is done" is by construction open when the close runs.
  // Blocking on it would make the flag unreachable in the only situation it exists for.
  // The cost is bounded and already handled — the final turn's requests sweep in
  // afterwards, and a close is a REVISION, so the late tokens produce another one
  // (see this file's header) rather than being lost.
  // TRUE only when the acceptance actually overrode something, mirroring `forced` — a
  // close that would have passed the gate anyway was not bypassed by anyone.
  const accepted = withAcceptance && !gate.ok;
  if (!gate.ok && !forced && !withAcceptance && input.heal !== true) {
    // The remedy names what the SWEEPER will do, because since 2026-07-30 it actually
    // does it (src/autoclose.ts). The old text said "wait for the task to go quiet",
    // which read as an instruction to poll — and the design's own "leave it for the
    // sweeper" promise pointed at a component that did not exist. It also has to state
    // the CONSEQUENCE of doing nothing, or the advice is only half true: a task that
    // never gets a completion signal is eventually closed `abandoned`, which is
    // right-censored and therefore preserves no measurement. Relaying real consent is
    // what keeps the task in the calibration corpus.
    throw new QuiescenceError(
      `quiescence gate not met for ${input.tid}: ${gate.failing.join("; ")}`,
      "do nothing: the sweeper's close pass finalizes quiet tasks by itself, on every sweep, with this same gate — " +
        "it closes `completed` on a completion signal, or `abandoned` (right-censored, so the actual is only a lower " +
        'bound) after the no-signal window. If the human has explicitly accepted completion, relay it verbatim via --accept "<their words>" ' +
        "(records anomaly(accepted_close)) — that is what preserves a real measurement. --force is Craig's own override at a terminal, never Claude's",
      gate,
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
        raw_p90_wcet: number;
        cal_p50_wcet: number;
        cal_p90_wcet: number;
        estimand: string;
        scope_seq: number;
        price_epoch: string;
        // v19: `bandUnscorable` reads the STORED conversion fact, so the baseline SELECT
        // has to carry it. `BandUnitColumns` requires the column, which is what stops a
        // future edit dropping it and quietly restoring the `cal != raw` inference.
        wcet_rate_src: string;
      },
      [number]
    >(
      "SELECT raw_p50_wcet, raw_p90_wcet, cal_p50_wcet, cal_p90_wcet, estimand, scope_seq, price_epoch, wcet_rate_src FROM estimate WHERE eid = ?",
    )
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
  // The COUNT stays honest and unfiltered — `outcome.phase_unmapped_agents` records
  // how many of this task's workflow agents never joined a phase, whatever the
  // reason, and a closed task's row should not quietly shrink because the reason was
  // benign.
  const phaseUnmapped =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM agent_run WHERE tid = ? AND run_id IS NOT NULL AND (phase_conf IS NULL OR phase_conf = 'unmapped')",
      )
      .get(input.tid)?.n ?? 0;
  // The ALERT does not. §5.6 [R4]: an agent orphaned by a relaunch, or one that was
  // killed, is a classified fact about the corpus, not something the operator can
  // act on at close time — warning about it is the same cry-wolf failure that made
  // 83% of the anomaly ledger noise. Only the residual (`phase_unmapped`, the kind
  // the classifier reserves for "no explanation") is worth a line on the close
  // report. Read from the ledger rather than an `agent_run` column so this needs no
  // schema change; the classifier's per-agent detail strings are the join.
  const phaseUnmappedUnexplained =
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM agent_run ar
          WHERE ar.tid = ? AND ar.run_id IS NOT NULL
            AND (ar.phase_conf IS NULL OR ar.phase_conf = 'unmapped')
            AND NOT EXISTS (
              SELECT 1 FROM anomaly a
               WHERE a.kind IN ('wf_relaunch_orphan','agent_never_returned')
                 AND a.detail LIKE '%agent ' || ar.agent_id || '%')`,
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
  //
  // `velocity_raw` is the LEARNING SIGNAL and is always meaningful: under `work_cet`
  // it is a dimensionless over/under ratio, and under `story_point` — where raw_p50 is
  // a number of points — it is Work-CET PER POINT, which is exactly what `est retro`
  // fits into the multiplier `pointsToWcet` reads back. Nothing about it changes here.
  const velocityRaw =
    actualAtEpoch !== null && baseline.raw_p50_wcet > 0 ? actualAtEpoch / baseline.raw_p50_wcet : null;

  // `velocity_cal` and `in_band` are different: both compare the actual against the
  // CALIBRATED band, and that comparison is only legal when the calibrated band is in
  // Work-CET. Under `story_point` it usually is — `cal = raw × Work-CET-per-point` —
  // but when `est open` found no rate at all, from either the fitted path or the seed,
  // both multipliers were 1.0 and `cal_*` are still POINTS. Scoring 60,000 Work-CET
  // against a p90 of 13 would then record a wild overrun and a velocity in the
  // thousands for a task that may have landed exactly on its estimate, and the
  // coverage panel would read the early points corpus as a catastrophe. NULL is the
  // honest answer, and it is one the schema already admits: both columns are nullable
  // and every consumer already handles a missing value.
  //
  // The test itself lives in `src/tasks.ts` beside `pointsToWcet`, not here. Three
  // other scoring surfaces (`retro.ts`'s two panels and `v_block_accuracy`) had each
  // made this same mistake independently, which is the signal that it must be ONE
  // function a fourth consumer cannot fail to find.
  const bandInPoints = bandUnscorable(baseline);
  const velocityCal =
    !bandInPoints && actualAtEpoch !== null && baseline.cal_p50_wcet > 0
      ? actualAtEpoch / baseline.cal_p50_wcet
      : null;
  const inBand =
    bandInPoints || actualAtEpoch === null ? null : actualAtEpoch <= baseline.cal_p90_wcet ? 1 : 0;

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
    // Recorded whether or not the gate was failing — the provenance of a close is worth
    // the same row either way — and BENIGN (src/cli.ts `BENIGN_ANOMALY_KINDS`): a human
    // ending their own task is the system working, not damage taken by it. What the row
    // is for is provenance: the quote is the whole audit trail for a close no arithmetic
    // authorised, and it is stored verbatim. The database is local-only (§4), which is
    // what makes storing his words fine.
    //
    // De-duplicated on (kind, detail, tid) rather than inserted blindly. `est close`
    // exits 3 when it finalizes WITH alerts, and a caller that reads 3 as failure and
    // retries would otherwise append the same acceptance again — the ledger would then
    // show two consents where one was given. `insertAnomalies` (src/cli.ts) cannot be
    // reused for this: it drops the `tid` column and only de-duplicates against rows
    // where `tid IS NULL`, so a task-scoped row is outside its key.
    if (withAcceptance) {
      const detail =
        `est close --accept: the human accepted completion — "${acceptance}" ` +
        `(verified against a bound session's transcript)` +
        (gate.ok ? " (the quiescence gate was already met)" : ` (gate bypassed: ${gate.failing.join("; ")})`);
      db.query(
        `INSERT INTO anomaly (ts, kind, detail, tid)
         SELECT ?, 'accepted_close', ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM anomaly
                             WHERE kind = 'accepted_close' AND detail = ? AND tid = ?)`,
      ).run(ts, detail, input.tid, detail, input.tid);
    }
    // The two JUDGEMENT anomalies below are skipped entirely on the heal path, and
    // de-duplicated on the normal one.
    //
    // Skipped, because a heal is not a second close: it re-runs the arithmetic over the
    // same finished work, so re-raising "the scope drifted undeclared" or "nothing
    // planted the tid" says nothing that was not already said at the real close — and
    // `tid_unplanted` is ALERTING, so a nightly sweep that healed one task would exit 3
    // on a row the sweeper itself had just written, about a fact nobody could act on.
    //
    // De-duplicated, for the same reason `accepted_close` is (see above): `est close`
    // exits 3 when it finalizes with alerts, a caller may retry, and a reopen/re-close
    // cycle re-evaluates the same condition. Neither row carries a count or a timestamp
    // in its detail, so an identical row is the same observation restated.
    const anomalyOnce = (kind: string, detail: string): void => {
      db.query(
        `INSERT INTO anomaly (ts, kind, detail, tid)
         SELECT ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM anomaly WHERE kind = ? AND detail = ? AND tid = ?)`,
      ).run(ts, kind, detail, input.tid, kind, detail, input.tid);
    };
    if (input.heal !== true && scopeChanged && !scopeDeclared) {
      anomalyOnce(
        "scope_undeclared",
        `scope moved from seq ${baseline.scope_seq} to ${scopeFinal} with no \`est scope\` revision — the drift was detected, not declared`,
      );
    }
    if (input.heal !== true && tidPlanted === 0) {
      anomalyOnce(
        "tid_unplanted",
        "a Task-tool task existed in the anchor session but no task file carried this est_tid; cross-session stitching is not working for this task",
      );
    }
  }).immediate();

  // The overrun nudge arms a marker file per task (P1.10 job 4). This is the moment it
  // stops meaning anything: the band is closed out, and a marker left behind would both
  // leak a file the sweep can only reap on a 30-day timer and, after a reopen, swallow
  // the first legitimate nudge of the new run.
  clearOverrunMarker(input.tid, input.spoolDir ?? SPOOL_DIR);

  const alerts: string[] = [];
  if (unpricedShare > 0) alerts.push(`unpriced_share=${(unpricedShare * 100).toFixed(1)}%`);
  if (danglingAgents > 0) alerts.push(`dangling_agents=${danglingAgents}`);
  if (phaseUnmappedUnexplained > 0) {
    alerts.push(`phase_unmapped_agents=${phaseUnmappedUnexplained}`);
  }

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
    accepted,
    quiescence: gate,
    alerts,
  };
}

/** One corrective revision the sweeper appended — see {@link healClosedOutcomes}. */
export interface OutcomeHeal {
  tid: string;
  revision: number;
  from_wcet: number;
  to_wcet: number;
}

/**
 * Append a corrective `outcome` revision wherever a closed task's actual has MOVED.
 *
 * This is the working half of a promise this file's header has always made: "premature
 * finalization is self-healing rather than fatal — late tokens produce a new revision".
 * Nothing appended that revision. It was true that a human COULD close again; it was
 * not true that anything did, so every close taken before the last of its spend landed
 * left an `outcome` that under-reports — and `v_velocity` reads the latest revision, so
 * the under-report propagates straight into the calibrator.
 *
 * `est close --accept` turns that from an edge case into the ordinary one. Consent
 * arrives mid-turn, by construction: the accepting turn's own requests are still
 * streaming when the close runs, and its sub-agents may not have returned at all. So
 * the repair has to be automatic, and it belongs in the sweeper — the one component
 * that already re-reads the corpus, re-attributes it, and holds the write lock.
 *
 * Three properties keep it from becoming noise:
 *
 *  - **Only when the actual actually moved.** A candidate whose recomputed Work-CET
 *    equals the one on file is skipped, so a steady state appends nothing and the
 *    revision counter is a record of real corrections rather than of sweeps.
 *  - **No anomaly row.** The sweeper correcting its own arithmetic is the system
 *    working. `forced_close` and `accepted_close` record who overrode a gate; this
 *    overrides nothing.
 *  - **Idempotent.** The new revision is stamped `now`, so the "spend postdates the
 *    close" predicate that selected it is false on the next sweep unless yet more
 *    spend has landed — in which case it should fire again.
 *
 * Reopened tasks are excluded: `final_status = 'reopened'` means the task is live
 * again, and a live task's actual moving is not a correction, it is progress.
 */
export function healClosedOutcomes(
  db: Database,
  now: Date = new Date(),
  opts: { spoolDir?: string } = {},
): OutcomeHeal[] {
  const candidates = db
    .query<{ tid: string; final_status: string; actual_wcet: number }, []>(
      `SELECT o.tid, o.final_status, o.actual_wcet
         FROM v_outcome_current o
        WHERE o.final_status <> 'reopened'
          AND EXISTS (SELECT 1 FROM request r WHERE r.tid = o.tid AND r.ts > o.finalized_at)`,
    )
    .all();

  const healed: OutcomeHeal[] = [];
  for (const c of candidates) {
    const live = db
      .query<{ wcet: number | null }, [string]>("SELECT wcet FROM v_task_actual WHERE tid = ?")
      .get(c.tid);
    // Rounded the same way `closeTask` writes it, so the comparison is between two
    // numbers of the same kind rather than between a float and its own rounding.
    const to = Math.max(0, Math.round(live?.wcet ?? 0));
    if (to === c.actual_wcet) continue;
    const r = closeTask(db, {
      tid: c.tid,
      status: c.final_status as FinalStatus,
      heal: true,
      now,
      ...(opts.spoolDir === undefined ? {} : { spoolDir: opts.spoolDir }),
    });
    healed.push({ tid: c.tid, revision: r.revision, from_wcet: c.actual_wcet, to_wcet: r.actual_wcet });
  }
  return healed;
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

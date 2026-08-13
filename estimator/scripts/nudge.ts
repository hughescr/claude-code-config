#!/usr/bin/env bun
/**
 * scripts/nudge.ts — PostToolUse hook body for matcher `Task|Workflow`
 * (design R4 §Phase 1 interfaces, P1.10; enforcement rationale in §3.3).
 *
 * ADVISORY ONLY. Every path through this file ends in `process.exit(0)` — a
 * hook that fails Craig's hot path is strictly worse than one that does
 * nothing (P1.0: "Hooks never exit non-zero"). Nothing in here ever takes the
 * sweep lock or opens the database for write.
 *
 * Three jobs, deliberately split by cost:
 *
 *   1. Foreground, decide: one read-only indexed query — does an open,
 *      non-terminal task have a `task_alias` binding to this session? If not,
 *      emit a budgeted nudge naming the `estimating` skill.
 *   2. Foreground, record: append ONE line to spool/compliance.jsonl,
 *      regardless of the decision above. A single O_APPEND write, no lock,
 *      no DB. The next sweep drains it; a line that survives a crash is
 *      drained on the next sweep, which is the point.
 *   3. Background, micro-sweep: spawn a throttled, DETACHED `est sweep` so it
 *      cannot consume this hook's timeout. Throttled by an mtime check on a
 *      spool marker file — a filesystem stat, not a database read. The body of
 *      this job now lives in `src/microsweep.ts`, shared with the
 *      UserPromptSubmit hook (`scripts/prompt-sweep.ts`) so both hooks check
 *      the same marker; a second copy would be a second, independent window.
 *
 * A fourth, best-effort job piggybacks on job 1 when a task IS bound: the
 * overrun nudge against `burn_cache` (P1.9). `burn_cache` is schema v5 and
 * does not exist on a v4 database yet (built concurrently) — that lookup is
 * wrapped and treated as "nothing to report" on any failure, per the no-op
 * requirement this file is tested against.
 *
 * Every DB access opens **read-only**, with a 50 ms busy timeout, and is
 * independently wrapped: a missing database, a schema-version mismatch, a
 * locked file, or a missing table are never a crash. They are also never a
 * NUDGE — "the database could not be read" is recorded as `db_unavailable` and
 * stays silent, because claiming "no estimate is bound" on evidence nobody
 * could gather both nags Craig for a broken file and writes a permanent
 * `missed_estimate` anomaly into the compliance rate that is supposed to be
 * the enforcement (P1.10 fail-open, §3.3).
 */

import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DATA_ROOT, getConfig, openDb } from "../src/db.ts";
import { bandUnscorable } from "../src/tasks.ts";
import {
  AGENT_BINDS_FILE,
  overrunMarkerFile,
  readFocusMarker,
  serializeSpawnBindLine,
  type FocusMarker,
  type NudgeKind,
  type SpawnBindBasis,
  type SpawnBindFocusDrop,
  type SpawnBindKind,
  type SpawnBindRecord,
} from "../src/spool.ts";
import { activeTasks, type ActiveTask } from "../src/burn.ts";
import { maybeSpawnMicrosweep } from "../src/microsweep.ts";

// `EST_DB` already overrides the database path (db.ts); this mirrors that
// convention for the spool directory so tests never have to touch the real
// spool/ under estimator-data/ — production is unaffected since the var is unset.
const SPOOL_DIR = process.env.EST_SPOOL_DIR ?? join(DATA_ROOT, "spool");
const COMPLIANCE_LOG = join(SPOOL_DIR, "compliance.jsonl");
/** HOOK-BINDING-SPEC.md §4: job 0's spool, drained by `drainAgentBinds` (src/spool.ts). */
const AGENT_BINDS_LOG = join(SPOOL_DIR, AGENT_BINDS_FILE);
const NUDGE_BUDGET = 500; // P1.10 job 1: "budgeted to <=500 characters"
const OVERRUN_BUDGET = 300; // P1.10 job 4: "a <=300-character additionalContext"
/**
 * Every `openDb` here overrides the 5 000 ms default (src/db.ts) for the same reason
 * `est burn --json` does (src/burn.ts): this runs on Craig's hot path, and a hook that
 * can wait five seconds on a busy file is a hook that stalls a delegation. WAL readers
 * do not block on writers today, so this is a ceiling, not a hot code path.
 */
const BUSY_TIMEOUT_MS = 50;

const NUDGE_TEXT =
  "est: no open estimate is bound to this session. If this Task/Workflow launch is " +
  "substantial (T1-T4, see CLAUDE.md), run the `estimating` skill before continuing.";

interface HookInput {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  // HOOK-BINDING-SPEC.md §2.2, job 0. `tool_response` is the SPAWNED IDENTITY;
  // `tool_use_id` is the dedup key; `duration_ms` is the spawn-instant correction for
  // a synchronous Agent call (§3.1); `agent_id`/`agent_type` are the base payload's
  // nested-spawn detector (§7.1) and its diagnostic label — all VERIFIED present
  // against the installed harness binary, not merely hoped for.
  tool_response?: unknown;
  tool_use_id?: unknown;
  duration_ms?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
}

function readStdin(): string {
  try {
    return require("node:fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** `text` must already be budgeted by the caller (job 1: <=500 chars, job 4: <=300). */
function nudgePayload(text: string): Record<string, unknown> {
  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
    // Unverified whether additionalContext is honoured on PostToolUse (§3.3, P1.10) —
    // systemMessage rides alongside it as a documented-elsewhere fallback surface.
    systemMessage: text,
  };
}

/**
 * Three outcomes, and the third is the point: "the database could not be read" is NOT
 * "nothing is bound". Collapsing them nudges Craig about a missing estimate whenever
 * the file is missing, locked or a schema ahead of this script (P1.10 fail-open says
 * print nothing), and — worse — spools that guess as a permanent `missed_estimate`
 * anomaly against a compliance rate that is supposed to mean something (§3.3).
 */
type Binding =
  | { kind: "bound"; tid: string }
  | { kind: "unbound" }
  | { kind: "unavailable" };

/**
 * Does an open, non-terminal task have a task_alias binding to this session?
 * Read-only, and never throws. A session can host several (schema v6), so this picks
 * the newest — the same task `est burn --session` puts on the statusline, which is what
 * keeps the overrun nudge and the band it is nudging about about the same piece of work.
 */
function findBoundTid(sessionId: string): Binding {
  let db: Database;
  try {
    db = openDb({ readonly: true, busyTimeoutMs: BUSY_TIMEOUT_MS });
  } catch {
    return { kind: "unavailable" }; // missing, uninitialised, or a schema we do not know
  }
  try {
    const row = db
      .query<{ tid: string }, [string]>(
        `SELECT t.tid AS tid
           FROM task_alias a
           JOIN task t ON t.tid = a.tid
          WHERE a.session_id = ?
            AND t.status NOT IN ('completed','abandoned','deleted')
          ORDER BY a.first_seen DESC, a.tid DESC
          LIMIT 1`,
      )
      .get(sessionId);
    return row?.tid === undefined ? { kind: "unbound" } : { kind: "bound", tid: row.tid };
  } catch {
    return { kind: "unavailable" }; // locked, or a table this script expects and the file lacks
  } finally {
    db.close();
  }
}

/**
 * Best-effort overrun check against burn_cache (P1.9, schema v5). Returns the
 * nudge text once per threshold crossing per task, or null when there is
 * nothing to report — including "the table doesn't exist yet".
 *
 * UNIT-GUARDED (v15). `burn_cache.consumed_wcet` is log-derived Work-CET, always;
 * `estimate.cal_p90_wcet` is Work-CET only when {@link bandUnscorable} says so, and
 * under `estimand = 'story_point'` with no rate at `est open` it still holds POINTS.
 * Comparing the two produced a wired, user-facing FALSE ALARM — "consumed 14 vs p90 13
 * Work-CET" against a thirteen-POINT band — which is the one failure mode this project
 * refuses: a wrong number that looks right. There is no rate to convert through here
 * (that is the state), so the only honest answer is to fire NOTHING. The band is not
 * blown; whether it is blown is undefined, and a hook is not the surface on which to
 * explain that — `est burn` already says it in full, and this file's contract is
 * advisory-or-silent.
 */
function tryOverrunNudge(tid: string): string | null {
  try {
    const db = openDb({ readonly: true, busyTimeoutMs: BUSY_TIMEOUT_MS });
    try {
      const row = db
        .query<
          {
            consumed_wcet: number;
            cal_p90_wcet: number;
            version: number;
            estimand: string;
            raw_p50_wcet: number;
            cal_p50_wcet: number;
            /** v19: the STORED conversion fact `bandUnscorable` now reads. */
            wcet_rate_src: string;
          },
          [string]
        >(
          `SELECT bc.consumed_wcet AS consumed_wcet, e.cal_p90_wcet AS cal_p90_wcet, e.version AS version,
                  e.estimand AS estimand, e.raw_p50_wcet AS raw_p50_wcet, e.cal_p50_wcet AS cal_p50_wcet,
                  e.wcet_rate_src AS wcet_rate_src
             FROM burn_cache bc
             JOIN estimate e
               ON e.tid = bc.tid
              AND e.version = (SELECT MAX(version) FROM estimate WHERE tid = bc.tid)
            WHERE bc.tid = ?`,
        )
        .get(tid);
      if (!row || row.cal_p90_wcet <= 0) return null;
      // The refusal, BEFORE the comparison — not after it, and not as a re-labelling of
      // the message. `bandUnscorable` is the same predicate `est close` and both retro
      // scoring panels consult, so a band this hook declines to warn on is exactly a
      // band nothing else will score either.
      if (bandUnscorable(row)) return null;
      if (row.consumed_wcet < row.cal_p90_wcet) return null;

      // Once per threshold crossing per task (§6.3, P1.10 job 4) — and a `refinement`
      // or `scope_change` mints a NEW band, which is a new threshold. So the marker
      // records the band it fired against rather than merely "fired": a task that
      // re-estimates and then blows the wider band gets nudged again, while a task
      // sitting over the same band stays silent no matter how many times this runs.
      const band = `v${row.version}:${row.cal_p90_wcet}`;
      const marker = join(SPOOL_DIR, overrunMarkerFile(tid));
      if (readMarkerBand(marker) === band) return null;
      mkdirSync(SPOOL_DIR, { recursive: true });
      writeFileSync(marker, `${JSON.stringify({ band, ts: new Date().toISOString() })}\n`);

      return (
        `est: task ${tid} is over its p90 band ` +
        `(consumed ${row.consumed_wcet} vs p90 ${row.cal_p90_wcet} Work-CET). ` +
        "Run `est open --reason refinement` or `est scope` + `--reason scope_change`."
      );
    } finally {
      db.close();
    }
  } catch {
    // burn_cache absent (v4 db, schema v5 not yet migrated), db locked/missing,
    // or any other failure: no overrun feature yet. Fail open, report nothing.
    return null;
  }
}

/**
 * The band an existing overrun marker was written for, or null when there is no
 * marker / it is unreadable / it predates this format (in which case re-firing once is
 * the safe direction: a nudge Craig has seen before beats a band he has not).
 */
function readMarkerBand(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { band?: unknown };
    return typeof parsed.band === "string" ? parsed.band : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Job 0: spawn-time attribution binding (HOOK-BINDING-SPEC.md).
//
// ADVISORY-FREE, unlike jobs 1/2/4: this job never prints anything and never fails
// the hook. It resolves the spawn against §3.3's ladder and appends ONE spooled
// line; the next sweep's drain (`src/spool.ts` drainAgentBinds) turns a resolved
// line into a `task_alias` row. Rung 0 (a nested spawn, detected by `payload.agent_id`
// being non-null) is the one path that performs NO database query at all — the
// design's answer to "must not add worker latency" (§7.1).
// ---------------------------------------------------------------------------

const MARKER_RE = /\[est:([0-9a-f]{8,36})\]/i;

/** The spawned identity's own id, read from `tool_response` (§2.2, VERIFIED shapes). */
function extractIdentity(
  toolName: "Agent" | "Workflow",
  toolResponse: unknown,
): { kind: SpawnBindKind; localId: string | null; wfLaunchId: string | null } {
  const r = toolResponse !== null && typeof toolResponse === "object" ? (toolResponse as Record<string, unknown>) : null;
  if (toolName === "Agent") {
    const agentId = r?.agentId;
    return { kind: "agent", localId: typeof agentId === "string" && agentId !== "" ? agentId : null, wfLaunchId: null };
  }
  const runId = r?.runId;
  const taskId = r?.taskId;
  return {
    kind: "workflow_run",
    localId: typeof runId === "string" && runId !== "" ? runId : null,
    wfLaunchId: typeof taskId === "string" && taskId !== "" ? taskId : null,
  };
}

/**
 * `t_spawn` (§3.1): for an async launch `duration_ms` is ~0 and this is `now`; for a
 * SYNCHRONOUS `Agent` call PostToolUse fires at completion, potentially hours later,
 * and `duration_ms` (or the Agent-sync response's own `totalDurationMs`) backdates the
 * clock to the instant the spawn actually happened. Both sources optional; `0` is
 * exactly today's behaviour.
 */
function computeSpawnAt(now: Date, durationMs: unknown, toolResponse: unknown): Date {
  const r = toolResponse !== null && typeof toolResponse === "object" ? (toolResponse as Record<string, unknown>) : null;
  const totalDurationMs = r?.totalDurationMs;
  const d =
    typeof durationMs === "number" && Number.isFinite(durationMs)
      ? durationMs
      : typeof totalDurationMs === "number" && Number.isFinite(totalDurationMs)
        ? totalDurationMs
        : 0;
  return new Date(now.getTime() - Math.max(0, d));
}

/** §3.2b: the optional `[est:<tid8+>]` per-spawn override, off by default (`hook_bind_marker`). */
function extractMarkerTidPrefix(toolName: "Agent" | "Workflow", toolInput: unknown): string | null {
  const o = toolInput !== null && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : null;
  if (o === null) return null;
  const field = toolName === "Agent" ? o.description : o.script;
  if (typeof field !== "string") return null;
  // "the first 4 KiB" (§3.2b) — bounded so a multi-megabyte workflow script is never
  // scanned in full on the hot path.
  const m = MARKER_RE.exec(field.slice(0, 4096));
  return m?.[1]?.toLowerCase() ?? null;
}

interface LadderResult {
  tid: string | null;
  basis: SpawnBindBasis;
  na: number;
  nb: number;
  /** HOOK-BINDING-SPEC.md §14.4/§14.8 (REV3): set only when a focus marker was read
   *  and DROPPED by the idle bridge — see {@link focusVerdict}. */
  focusDrop?: SpawnBindFocusDrop;
}

/**
 * HOOK-BINDING-SPEC.md §14.4/§14.8 (REV3): the idle-bridge scan's PK-slice read is
 * bounded so an unbounded backlog cannot be walked in full on the hot path. A code
 * constant, not config (§14.4.2): 2000 turns inside one marker's lifetime is a shape
 * this corpus has never produced, and `binds_focus_drop.scan_cap` (§14.8) is the
 * observed counter that checks the assumption rather than assuming it. Hitting the
 * cap fails CLOSED (marker dropped) — every ambiguity in this design resolves toward
 * "write no alias".
 */
const FOCUS_BRIDGE_SCAN_MAX = 2000;

type FocusVerdict = { believed: true } | { believed: false; reason: SpawnBindFocusDrop };

/**
 * HOOK-BINDING-SPEC.md §14.5 (REV3), constraint (c): competing-evidence invalidation.
 * A believed marker naming `T` is killed when a DIFFERENT bound task `U` has a
 * label-free `est scope` row newer than the marker — the one CLI act that can move a
 * session's real focus onto `U` without also rewriting the marker file itself (every
 * other such act — `est open`, `est bind --session`, `est focus`, `est close` —
 * already rewrites or clears the pointer atomically; see §14.5's completeness table).
 * Label-free per INV-TTL (§14.2): `task_scope.source = 'est_scope'` is written only by
 * a human running `est scope`, never by this hook or by attribution, so this probe
 * cannot be moved by the marker's own writes either.
 */
function competingEvidence(db: Database, bound: ActiveTask[], marker: FocusMarker): boolean {
  for (const t of bound) {
    if (t.tid === marker.tid) continue;
    const row = db
      .query<{ n: number }, [string, string]>(
        "SELECT 1 AS n FROM task_scope WHERE tid = ? AND ts > ? AND source = 'est_scope' LIMIT 1",
      )
      .get(t.tid, marker.ts);
    if (row !== null && row !== undefined) return true;
  }
  return false;
}

/**
 * HOOK-BINDING-SPEC.md §14.4 (REV3): the idle bridge. A focus marker naming `T` is
 * BELIEVED at `spawnAt` (`t_spawn`) iff `bound` still carries `T` as a candidate, the
 * marker was not written after `t_spawn`, no competing evidence (§14.5) applies to a
 * different bound task, and the SESSION's own turn stream bridges
 * `[marker.ts, t_spawn]` with no gap of `ttlMs` or more.
 *
 * Marker-immune by construction (INV-TTL, §14.2): every input this function reads is
 * `turn(session_id, started_at, duration_ms)` or `task_scope` — rows no hook write and
 * no attribution pass ever touches — so the verdict is invariant under deleting every
 * `task_alias` row this marker has ever caused. It is the anti-circularity property
 * §14.1 names: `T`'s own ATTRIBUTED activity (which this marker's binds manufacture)
 * plays no part in the predicate, only the session's raw turn timeline does. Monotone
 * by construction too: once a gap exists inside `[marker.ts, t_spawn]` it exists for
 * every LATER `t_spawn` as well, so a dead marker can never be revived by resuming the
 * session — the bridge, not `now - last_turn <= TTL`, is what makes expiry a one-way
 * latch (§14.4.1 property 2).
 */
function focusVerdict(
  db: Database,
  marker: FocusMarker,
  bound: ActiveTask[],
  session: string,
  spawnAt: Date,
  ttlMs: number,
): FocusVerdict {
  const target = bound.find((t) => t.tid === marker.tid);
  if (target === undefined) return { believed: false, reason: "not_candidate" };

  const markerMs = Date.parse(marker.ts);
  // An unparseable timestamp is EXPIRED, not absent (kept verbatim from the prior
  // fixed-from-set reading, §14.7): a corrupt marker is maximally suspect, not
  // maximally believable.
  if (!Number.isFinite(markerMs)) return { believed: false, reason: "bad_ts" };

  const spawnMs = spawnAt.getTime();
  // §14.4.3: judged at t_spawn, not at fire time — the same anachronism §3.1 already
  // forecloses on the window filter. A synchronous Agent's PostToolUse can fire hours
  // after t_spawn, and `est focus` may well have run in between; a marker written
  // AFTER the spawn it would be judged against cannot have been what the human was
  // pointing at when the spawn happened.
  if (markerMs > spawnMs) return { believed: false, reason: "post_spawn" };

  if (competingEvidence(db, bound, marker)) return { believed: false, reason: "contested" };

  // The bridge itself: walk the session's turns forward from marker.ts, extending a
  // cursor by each turn's own span; a step that exceeds ttlMs — including the final
  // step to t_spawn — is an idle gap and the marker is dead. `LIMIT` at exactly the
  // scan cap (not cap+1): hitting it fails closed on the conservative assumption that
  // more rows exist beyond it, per §14.4.2's specification.
  const rows = db
    .query<{ started_at: string; duration_ms: number | null }, [string, string, string]>(
      `SELECT started_at, duration_ms FROM turn
        WHERE session_id = ? AND started_at >= ? AND started_at <= ?
        ORDER BY started_at ASC
        LIMIT ${FOCUS_BRIDGE_SCAN_MAX}`,
    )
    .all(session, marker.ts, spawnAt.toISOString());
  if (rows.length === FOCUS_BRIDGE_SCAN_MAX) return { believed: false, reason: "scan_cap" };

  let cursor = markerMs;
  for (const row of rows) {
    const s = Date.parse(row.started_at);
    if (!Number.isFinite(s)) continue; // a corrupt turn row: skip it, do not let it break the bridge
    if (s - cursor > ttlMs) return { believed: false, reason: "idle" };
    // A turn with duration_ms IS NULL contributes started_at alone (§14.4.2): treating
    // NULL as zero is the same conservative direction as skipping a corrupt row above.
    cursor = Math.max(cursor, s + (row.duration_ms ?? 0));
  }
  if (spawnMs - cursor > ttlMs) return { believed: false, reason: "idle" };
  return { believed: true };
}

/**
 * §3.3's resolution ladder, rungs 1-8 (rung 0 is handled by the caller without ever
 * reaching here; rung 9's `db_unavailable` is the caller's catch around the whole
 * transaction). Returns `null` when `hook_bind_enabled` reads `0` — the rollback
 * lever — meaning the caller writes NOTHING at all, not even a witness.
 *
 * Runs inside ONE deferred read transaction (§3.0): every read below shares a single
 * snapshot, so a sweep committing mid-resolution cannot hand the ladder two states
 * that never coexisted.
 */
function resolveLadder(
  db: Database,
  opts: { session: string; now: Date; spawnAt: Date; toolName: "Agent" | "Workflow"; toolInput: unknown },
): LadderResult | null {
  if ((getConfig(db, "hook_bind_enabled") ?? "1") === "0") return null;

  const bound = activeTasks(db, { session: opts.session, now: opts.now, live: "cache", openAt: opts.spawnAt });
  const active = bound.filter((t) => t.active);
  const na = active.length;
  const nb = bound.length;
  // Set at most once, by the focus block below, and carried onto every LATER return
  // (rungs 5-8) so a dropped marker's reason survives onto the spool line even when
  // the walk falls all the way through (§14.8: additive to `basis`, not exclusive).
  let focusDrop: SpawnBindFocusDrop | undefined;
  const R = (tid: string | null, basis: SpawnBindBasis): LadderResult => ({ tid, basis, na, nb, focusDrop });

  // Rung 1: the description marker, only when explicitly enabled (default off, §3.2b).
  if ((getConfig(db, "hook_bind_marker") ?? "0") === "1") {
    const prefix = extractMarkerTidPrefix(opts.toolName, opts.toolInput);
    if (prefix !== null) {
      const matches = bound.filter((t) => t.tid.toLowerCase().startsWith(prefix));
      if (matches.length === 1) return R(matches[0]!.tid, "marker");
      // Zero or many matches: the marker is IGNORED, not obeyed — falls through to the
      // rest of the ladder exactly as if it had never been present. (`hook_marker_unresolved`
      // is not raised from here: hooks never write to the database, §1 P1.10; see this
      // file's module doc for the deliberate scope cut.)
    }
  }

  // Rungs 2-4: the focus marker. REV3 (§14.4, HOOK-BINDING-SPEC.md — AUTHORITATIVE
  // over the prior fixed-from-set reading): believed while the SESSION's own turn
  // stream bridges [marker.ts, t_spawn] with no idle gap >= hook_focus_ttl_min and no
  // competing evidence (§14.5) — NOT a fixed age measured from the marker's own
  // timestamp. It is `T`'s own ATTRIBUTED activity that may never renew the marker's
  // believability (§14.1's circularity: a bound task's spans reset its own
  // `quietTurns`, so the marker would otherwise manufacture the very evidence that
  // keeps it alive) — the bridge reads only the session's raw turn timeline and
  // `task_scope`, which are label-free and immune to this marker's own writes by
  // construction (INV-TTL, §14.2), so it cannot renew its own believability by one
  // second no matter how much of `T`'s activity it caused.
  const marker = readFocusMarker(opts.session);
  if (marker !== null) {
    const focusTtlMinRaw = Number.parseInt(getConfig(db, "hook_focus_ttl_min") ?? "120", 10);
    const focusTtlMs = (Number.isFinite(focusTtlMinRaw) ? focusTtlMinRaw : 120) * 60_000;
    const verdict = focusVerdict(db, marker, bound, opts.session, opts.spawnAt, focusTtlMs);
    if (verdict.believed) {
      const target = bound.find((t) => t.tid === marker.tid)!;
      if (target.active) return R(target.tid, "focus");
      if (na === 0) return R(target.tid, "focus_quiet");
      return R(null, "focus_disagrees"); // stale pointer vs live evidence — not a drop, see §14.8
    }
    // Dropped: treated as ABSENT, never a witness on its own — falls through to the
    // rest of the ladder exactly as if there were no marker at all, carrying the
    // reason onto whichever rung ultimately answers (§3.3, §14.8's `focus_drop`).
    focusDrop = verdict.reason;
  }

  // Rungs 5-8: the session-wide active set.
  if (nb === 0) return R(null, "no_bound");
  if (na === 0) return R(null, "no_active");
  if (na === 1) return R(active[0]!.tid, "sole_active");
  return R(null, "multi_active");
}

/**
 * Job 0 itself: resolve the spawn and append one spooled line. Never throws past its
 * own boundary (the caller's `try`/`catch` in `main()` is the final backstop, but every
 * internal failure here already degrades to a witness or to writing nothing).
 */
function resolveAndAppendBind(
  now: Date,
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  toolUseId: string | null,
  durationMs: unknown,
  agentId: string | null,
  agentType: string | null,
  payloadKeys: string[],
): void {
  if (toolName !== "Agent" && toolName !== "Workflow") return; // not a spawn tool
  // The dedup key the drain groups on (§7.2 layer 1) is documented VERIFIED-present;
  // a payload missing it is a shape this design has never observed, and writing a
  // record the drain cannot safely group is worse than writing nothing.
  if (toolUseId === null || toolUseId === "") return;

  const tool = toolName as "Agent" | "Workflow";
  const spawnAt = computeSpawnAt(now, durationMs, toolResponse);
  const identity = extractIdentity(tool, toolResponse);

  const base = {
    ts: now.toISOString(),
    v: 2 as const,
    src: "posttooluse" as const,
    sid: sessionId,
    tuid: toolUseId,
    tool,
    spawn_at: spawnAt.toISOString(),
    kind: identity.kind,
    local_id: identity.localId,
    wf_launch_id: identity.wfLaunchId,
    att: 0,
    k: payloadKeys,
    agent_type: agentType ?? undefined,
  };

  let rec: SpawnBindRecord;
  if (agentId !== null && agentId !== "") {
    // Rung 0 (§7.1): this PROCESS is sidechain agent `agentId`. The drain resolves
    // this record against that agent's own alias, at a fixpoint, up to 3 sweeps later.
    // No database query — the direct answer to "must not add worker latency inside a
    // sidechain": a nested spawn's hook fire costs LESS than a root spawn's, not more.
    rec = { ...base, parent_agent: agentId, tid: null, basis: "nested" };
  } else if (identity.localId === null) {
    // Rung 9 (partial): no spawned identity at all — nothing this record could ever
    // be aliased to, so there is no reason to pay for a database round trip first.
    rec = { ...base, parent_agent: null, tid: null, basis: "no_identity" };
  } else {
    let ladder: LadderResult | null | undefined;
    try {
      const db = openDb({ readonly: true, busyTimeoutMs: BUSY_TIMEOUT_MS });
      try {
        db.exec("PRAGMA query_only = ON");
        ladder = db.transaction(() =>
          resolveLadder(db, { session: sessionId, now, spawnAt, toolName: tool, toolInput }),
        )();
      } finally {
        db.close();
      }
    } catch {
      ladder = undefined; // DB missing, locked, or a schema this script does not know
    }
    if (ladder === null) {
      return; // hook_bind_enabled=0: the rollback lever. Write NOTHING, not even a witness.
    }
    if (ladder === undefined) {
      rec = { ...base, parent_agent: null, tid: null, basis: "db_unavailable" };
    } else {
      rec = {
        ...base,
        parent_agent: null,
        tid: ladder.tid,
        basis: ladder.basis,
        na: ladder.na,
        nb: ladder.nb,
        focus_drop: ladder.focusDrop,
      };
    }
  }

  const line = serializeSpawnBindLine(rec);
  if (line === null) return; // over budget even after dropping optional fields: fail open
  try {
    mkdirSync(SPOOL_DIR, { recursive: true });
    appendFileSync(AGENT_BINDS_LOG, `${line}\n`, { flag: "a" });
  } catch {
    // A lost bind degrades to today's turn inference — the same fallback every other
    // failure in this design has.
  }
}

function recordCompliance(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  boundTid: string | null,
  nudgeKind: NudgeKind,
  dbUnavailable: boolean,
): void {
  try {
    const sha256 = createHash("sha256").update(JSON.stringify(toolInput ?? null)).digest("hex");
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool_name: toolName,
      tool_input_sha256: sha256,
      bound_tid: boundTid,
      // `nudged` is what was ACTUALLY emitted, overrun nudges included — computing it
      // from "no binding" made the overrun nudge invisible to the spool, which is the
      // one thing the spool adds over `v_missed_estimate` (P1.10 job 2).
      nudged: nudgeKind !== "none",
      nudge_kind: nudgeKind,
      // Only present when it is true: the reader excludes these lines from the
      // compliance counters and from the `missed_estimate` anomaly (src/spool.ts).
      ...(dbUnavailable ? { db_unavailable: true } : {}),
    });
    mkdirSync(SPOOL_DIR, { recursive: true });
    // Single O_APPEND write of one short line: atomic without a lock (§3.3, P1.10).
    appendFileSync(COMPLIANCE_LOG, `${line}\n`, { flag: "a" });
  } catch {
    // A lost compliance line is not worth failing the hook over.
  }
}

function main(): void {
  let input: HookInput = {};
  try {
    const raw = readStdin();
    if (raw.trim().length > 0) input = JSON.parse(raw) as HookInput;
  } catch {
    process.exit(0); // unparseable stdin: fail open, print nothing
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id : null;
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = input.tool_input;

  if (sessionId === null || sessionId.length === 0) {
    process.exit(0); // nothing to check, nothing to log
  }

  // Job 0, BEFORE the existing jobs (§10 step 4): spawn-time attribution binding.
  // Locally wrapped, deliberately separate from the outer `import.meta.main` catch —
  // a failure in job 0 must degrade to "no bind, turn inference decides as today", not
  // prevent jobs 1/2 (the nudge and the compliance record) from running at all.
  try {
    resolveAndAppendBind(
      new Date(),
      sessionId,
      toolName,
      toolInput,
      input.tool_response,
      typeof input.tool_use_id === "string" ? input.tool_use_id : null,
      input.duration_ms,
      typeof input.agent_id === "string" && input.agent_id !== "" ? input.agent_id : null,
      typeof input.agent_type === "string" ? input.agent_type : null,
      Object.keys(input),
    );
  } catch {
    // Fail open: see the module doc's ADVISORY ONLY rule.
  }

  const binding = findBoundTid(sessionId);

  // Decide FIRST, record second: the spool line has to say which nudge was emitted,
  // and "unbound" is not the same question as "was anything printed" (P1.10 job 2).
  let payload: Record<string, unknown> | null = null;
  let kind: NudgeKind = "none";
  if (binding.kind === "unbound") {
    payload = nudgePayload(truncate(NUDGE_TEXT, NUDGE_BUDGET));
    kind = "no_estimate";
  } else if (binding.kind === "bound") {
    const overrun = tryOverrunNudge(binding.tid);
    if (overrun !== null) {
      payload = nudgePayload(truncate(overrun, OVERRUN_BUDGET));
      kind = "overrun";
    }
  }
  // binding.kind === "unavailable": nothing was looked up, so nothing is claimed —
  // print nothing (P1.10 fail-open) and mark the line so the reader ignores it.

  recordCompliance(
    sessionId,
    toolName,
    toolInput,
    binding.kind === "bound" ? binding.tid : null,
    kind,
    binding.kind === "unavailable",
  );

  if (payload !== null) {
    process.stdout.write(JSON.stringify(payload));
  }

  maybeSpawnMicrosweep(SPOOL_DIR);

  process.exit(0);
}

if (import.meta.main) {
  try {
    main();
  } catch {
    // Exhaustive fail-open (P1.10): any thrown exception -> print nothing, exit 0.
    process.exit(0);
  }
}

/**
 * src/tasks.ts — the write verbs of the estimation loop: `est open`, `est block`,
 * `est bind`, `est scope`, plus the read-only `est refclass` (§Phase 1 interfaces
 * P1.1–P1.5).
 *
 * The one property everything in this file exists to preserve is the anti-Goodhart
 * spine (§4.2, P1.12): `task_scope`, `estimate`, `estimate_block`, `outcome` and
 * `refclass` are append-only, PHYSICALLY — five pairs of `BEFORE UPDATE`/`BEFORE
 * DELETE` triggers that `RAISE(ABORT,'append-only')`. This module's job is to never
 * fight that, and to translate its refusals into something a caller can act on:
 *
 *   - there is no `--amend`, no `--fix`, no `--force-overwrite`, no `est delete`;
 *   - a wrong estimate is corrected by appending a better one, and the wrong one
 *     stays visible, because it is the record of what was believed at the time;
 *   - a rejection is exit code **2** with a message naming the append path that IS
 *     allowed, never a raw SQLite error and never a retry.
 *
 * `est open` in particular must never TRIP an ABORT trigger: it is a live path on
 * Craig's hot path, and a caller should never see `SQLITE_CONSTRAINT`. Every
 * invariant it can check itself, it checks itself, and exits 2 (P1.12).
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getConfig } from "./db.ts";
import { priceFamily } from "./prices.ts";
import { resolveEstimatorIdentity, type EstimatorIdentity } from "./identity.ts";
import {
  bootstrapQuantileCI,
  multipliers,
  quantileOf,
  type WeightedSample,
} from "./calibrate.ts";
import { unifiedDiff } from "./textdiff.ts";

// ---------------------------------------------------------------------------
// errors — the exit-code contract, as types
// ---------------------------------------------------------------------------

/** Exit 1: the command was malformed, or the anchor could not be resolved. */
export class UsageError extends Error {
  readonly exitCode = 1;
}

/**
 * Exit 2: the command was well-formed and the operation is NOT PERMITTED.
 *
 * "Exit 2 is the anti-Goodhart code and it must never be retried, worked around, or
 * downgraded to a warning" (P1.0). Its message names the append path that is
 * allowed, so `remedy` is not optional prose — it is the payload.
 */
export class InvariantError extends Error {
  readonly exitCode = 2;
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}

export const TASK_KINDS = [
  "research",
  "design",
  "implement",
  "refactor",
  "debug",
  "review",
  "ops",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const ESTIMATE_REASONS = ["initial", "refinement", "scope_change", "recalibration"] as const;
export type EstimateReason = (typeof ESTIMATE_REASONS)[number];

export const TERMINAL_TASK_STATUS: ReadonlySet<string> = new Set([
  "completed",
  "abandoned",
  "deleted",
]);

/** ISO instant to the second — the format every `ts` column in this schema uses. */
export function isoNow(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

export interface DodItem {
  readonly item: string;
  readonly kind: "deterministic" | "human";
  /** For `deterministic` items: the command that machine-checks it. */
  readonly check?: string;
}

/**
 * Parse `--dod <json|@file>` into a normalised checklist.
 *
 * The DoD is captured at estimate time and written into `task_scope` **so "done"
 * cannot be renegotiated later to fit what got built** (§3.2 step 5). Each item is
 * tagged `deterministic` (machine-checkable) or `human` (Craig judges); a bare
 * string is taken as `human`, because assuming a claim is machine-checkable when
 * nobody said how is exactly the renegotiation this is meant to prevent.
 */
export function parseDod(raw: string | null): DodItem[] {
  if (raw === null || raw.trim() === "") return [];
  let text = raw.trim();
  if (text.startsWith("@")) {
    const path = text.slice(1);
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new UsageError(`--dod: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("--dod: expected a JSON array (or @file containing one)");
  }
  if (!Array.isArray(parsed)) throw new UsageError("--dod: expected a JSON array of checklist items");
  return parsed.map((entry, i): DodItem => {
    if (typeof entry === "string") return { item: entry, kind: "human" };
    if (entry === null || typeof entry !== "object") {
      throw new UsageError(`--dod[${i}]: expected a string or an object with {item, kind}`);
    }
    const o = entry as Record<string, unknown>;
    const item = typeof o.item === "string" ? o.item : typeof o.text === "string" ? o.text : null;
    if (item === null) throw new UsageError(`--dod[${i}]: missing "item"`);
    const kind = o.kind === "deterministic" ? "deterministic" : "human";
    const check = typeof o.check === "string" ? o.check : undefined;
    return check === undefined ? { item, kind } : { item, kind, check };
  });
}

/** sha256(subject || description || dod_json) — the schema's stated definition. */
export function scopeHash(subject: string, description: string | null, dodJson: string): string {
  return createHash("sha256")
    .update(subject)
    .update(description ?? "")
    .update(dodJson)
    .digest("hex");
}

/** The renderable form a scope diff is taken over. */
export function scopeText(subject: string, description: string | null, dodJson: string): string {
  const dod = JSON.parse(dodJson) as DodItem[];
  return [
    `subject: ${subject}`,
    `description: ${description ?? ""}`,
    ...dod.map((d) => `dod[${d.kind}]: ${d.item}${d.check === undefined ? "" : ` (${d.check})`}`),
  ].join("\n");
}

export interface ScopeRow {
  tid: string;
  seq: number;
  ts: string;
  subject: string;
  description: string | null;
  dod_json: string;
  scope_hash: string;
  source: string;
  reason: string | null;
  diff_summary: string | null;
}

export function currentScope(db: Database, tid: string): ScopeRow | null {
  return (
    db
      .query<ScopeRow, [string]>("SELECT * FROM v_scope_current WHERE tid = ?")
      .get(tid) ?? null
  );
}

// ---------------------------------------------------------------------------
// anchor resolution (P1.0)
// ---------------------------------------------------------------------------

export interface Anchor {
  readonly sessionId: string;
  readonly promptId: string;
  /** True when either half was inferred rather than given; drives `anchor_inferred`. */
  readonly inferred: boolean;
  readonly note: string | null;
}

export interface AnchorOptions {
  session?: string | null;
  prompt?: string | null;
  now?: Date;
  /** Two sessions whose newest turns are this close are AMBIGUOUS, seconds. */
  ambiguityWindowS?: number;
}

/**
 * "Which session/turn is this?", resolved in the strict order P1.0 specifies:
 * explicit flags -> the harness environment -> the most recently active session.
 *
 * The third path is a GUESS, and it says so: the caller writes
 * `anomaly(kind='anchor_inferred')` so a wrong guess is visible rather than silent.
 * When two sessions were both active inside the ambiguity window the resolver
 * REFUSES — `est open` exits 1 and asks for `--session` rather than attributing a
 * whole task's spend to a coin flip.
 *
 * P1.0 flags this as "the one piece of this section that must be verified against
 * the real hook/env surface before it is built". The env leg reads
 * `EST_SESSION_ID` / `CLAUDE_SESSION_ID` / `EST_PROMPT_ID`; if the harness turns out
 * to expose different names, this function is the only place that changes.
 */
export function resolveAnchor(db: Database, opts: AnchorOptions = {}): Anchor {
  const now = opts.now ?? new Date();
  const explicitSession = opts.session ?? null;
  const explicitPrompt = opts.prompt ?? null;
  const envSession = process.env.EST_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? null;
  const envPrompt = process.env.EST_PROMPT_ID ?? null;

  const session = explicitSession ?? envSession;
  let inferred = explicitSession === null;
  let note: string | null = null;

  let sessionId: string;
  if (session !== null && session.trim() !== "") {
    sessionId = session.trim();
    if (explicitSession === null) note = "session from environment";
  } else {
    const recent = db
      .query<{ session_id: string; started_at: string }, []>(
        "SELECT session_id, MAX(started_at) AS started_at FROM turn GROUP BY session_id ORDER BY started_at DESC LIMIT 2",
      )
      .all();
    const top = recent[0];
    if (top === undefined) {
      throw new UsageError(
        "cannot resolve the anchor session: no turns have been swept yet. Pass --session <sid> (and --prompt <promptId> if you have it).",
      );
    }
    const second = recent[1];
    if (second !== undefined) {
      const gapS = Math.abs(Date.parse(top.started_at) - Date.parse(second.started_at)) / 1000;
      const window = opts.ambiguityWindowS ?? 120;
      if (Number.isFinite(gapS) && gapS <= window) {
        throw new UsageError(
          `anchor is ambiguous: sessions ${top.session_id} and ${second.session_id} were both active within ${window}s. Pass --session <sid>.`,
        );
      }
    }
    sessionId = top.session_id;
    note = "session inferred from the most recently active turn";
  }

  const prompt = explicitPrompt ?? envPrompt;
  let promptId: string;
  if (prompt !== null && prompt.trim() !== "") {
    promptId = prompt.trim();
    if (explicitPrompt === null) {
      inferred = true;
      note = note === null ? "prompt from environment" : `${note}; prompt from environment`;
    }
  } else {
    const turn = db
      .query<{ prompt_id: string }, [string]>(
        "SELECT prompt_id FROM turn WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(sessionId);
    inferred = true;
    if (turn !== null && turn !== undefined) {
      promptId = turn.prompt_id;
      note = note === null ? "prompt inferred from the session's newest turn" : `${note}; prompt inferred`;
    } else {
      // A brand-new session that no sweep has seen yet still has to be able to open a
      // task — refusing here would make the ceremony impossible at exactly the moment
      // §3.1 says to run it (prompt read, plan formed, nothing launched). The
      // synthetic anchor is loud rather than silent: `anchor_inferred` is written and
      // the attribution window simply opens at this instant instead of at the turn.
      promptId = `est-anchor:${isoNow(now)}`;
      note = note === null ? "no turn on disk yet; synthetic anchor" : `${note}; synthetic anchor`;
    }
  }

  return { sessionId, promptId, inferred, note };
}

// ---------------------------------------------------------------------------
// calibration lookup (P1.1's "calibration, at write time")
// ---------------------------------------------------------------------------

export interface RefclassSnapshot {
  as_of: string;
  bucket: string;
  estimator_family: string;
  n: number;
  n_eff: number;
  med_log_v: number;
  iqr_log_v: number;
  shrink_w: number;
  shrink_k: number;
  half_life_days: number;
  mult_p50: number;
  mult_p90: number;
  boot_lo_p50: number | null;
  boot_hi_p50: number | null;
  boot_lo_p90: number | null;
  boot_hi_p90: number | null;
  method: string;
  ref_model: string;
  estimand: string;
  params_json: string;
}

/**
 * Newest `refclass` snapshot for a bucket **in this unit**, preferring the caller's
 * own estimator family and falling back to the pooled `'*'` row.
 *
 * Velocity history is keyed by estimator model family with an exponential half-life
 * so **model churn ages out instead of poisoning the history** `[CB]` — but a brand
 * new family has no history of its own, and refusing to calibrate it at all would
 * mean every model release resets the system to cold start. The pooled row is the
 * compromise, and `estimator_family` on the snapshot records which one was used.
 *
 * `(refModel, estimand)` is NOT a nicety on top of that: the multipliers are ratios
 * of Work-CETs, so they are denominated in the unit they were fitted in (§4.1). The
 * pooled `'*'` fallback pools across ESTIMATOR families — never across units. Without
 * this filter, one `est config set ref_model` handed the newest sonnet-denominated
 * snapshot to an opus-denominated band: `uncalibrated: false`, `bucket_n` inherited
 * from a class with zero comparable tasks in the new unit, and nothing anywhere
 * saying the multiplier meant something else. A unit with no snapshot of its own is
 * a cold start, which is a thing this system already knows how to say out loud.
 */
export function newestRefclass(
  db: Database,
  bucket: string,
  estimatorFamily: string,
  refModel: string,
  estimand: string,
): RefclassSnapshot | null {
  return (
    db
      .query<RefclassSnapshot, [string, string, string, string]>(
        `SELECT * FROM refclass WHERE bucket = ? AND estimator_family IN (?, '*')
            AND ref_model = ? AND estimand = ?
          ORDER BY as_of DESC, (estimator_family = '*') ASC LIMIT 1`,
      )
      .get(bucket, estimatorFamily, refModel, estimand) ?? null
  );
}

/** Below this many comparable completed tasks, `est open` does NOT pretend. */
export const COLD_START_N = 10;

export interface CalibrationResult {
  bucket: string;
  bucketN: number;
  refclassAsOf: string | null;
  shrinkW: number;
  multP50: number;
  multP90: number;
  uncalibrated: boolean;
}

/**
 * Turn a raw band into a calibrated one, or refuse and say so.
 *
 * **Cold start is explicit, not faked** (P1.1): below `bucket_n = 10` this writes
 * `shrink_w = 0`, `refclass_as_of = NULL`, multipliers of 1.0, and the band is
 * labelled `uncalibrated` in both output modes. That label is load-bearing — an
 * uncalibrated band that looked calibrated would be the first thing to teach Craig
 * to distrust the whole system.
 *
 * `liveN` is the caller's unit-filtered count and is what a missing snapshot falls
 * back to. `snap.n` may stand in for it only because the snapshot is now selected in
 * the same unit: before that, a snapshot from another denomination overwrote a live
 * count of zero with a class size of twelve, and the cold-start guard never fired.
 */
export function calibrationFor(
  db: Database,
  bucket: string,
  estimatorFamily: string,
  refModel: string,
  estimand: string,
  liveN: number,
): CalibrationResult {
  const snap = newestRefclass(db, bucket, estimatorFamily, refModel, estimand);
  const bucketN = snap?.n ?? liveN;
  if (snap === null || bucketN < COLD_START_N) {
    return {
      bucket,
      bucketN,
      refclassAsOf: null,
      shrinkW: 0,
      multP50: 1,
      multP90: 1,
      uncalibrated: true,
    };
  }
  return {
    bucket,
    bucketN,
    refclassAsOf: snap.as_of,
    shrinkW: snap.shrink_w,
    multP50: snap.mult_p50,
    multP90: snap.mult_p90,
    uncalibrated: false,
  };
}

/** Comparable completed tasks in this bucket, at THIS unit — the honest `bucket_n`. */
export function liveBucketN(
  db: Database,
  bucket: string,
  refModel: string,
  estimand: string,
): number {
  return (
    db
      .query<{ n: number }, [string, string, string]>(
        "SELECT COUNT(*) AS n FROM v_velocity WHERE bucket = ? AND ref_model = ? AND estimand = ?",
      )
      .get(bucket, refModel, estimand)?.n ?? 0
  );
}

// ---------------------------------------------------------------------------
// `est open`
// ---------------------------------------------------------------------------

export interface OpenInput {
  kind: TaskKind;
  subject: string;
  description?: string | null;
  dod?: DodItem[];
  rawP50: number;
  rawP90: number;
  expAgents: number;
  expWfPhases: number;
  expFilesWrite: number;
  expTurns: number;
  expRequests: number;
  tid?: string | null;
  reason?: EstimateReason | null;
  session?: string | null;
  prompt?: string | null;
  now?: Date;
}

export interface Band {
  p50: number;
  p90: number;
  /** Both ends or neither: an uncalibrated request band is the raw guess, labelled. */
  reqP50: number;
  reqP90: number;
  activeP50S: number | null;
  activeP90S: number | null;
  spendUsdP50: number | null;
  spendUsdP90: number | null;
}

export interface OpenResult {
  tid: string;
  eid: number;
  version: number;
  reason: EstimateReason;
  minted: boolean;
  scopeSeq: number;
  raw: { p50: number; p90: number };
  band: Band;
  uncalibrated: boolean;
  bucket: string;
  bucketN: number;
  refModel: string;
  estimand: string;
  estimatorModel: string;
  /**
   * WHICH leg of the resolution order named the estimator (src/identity.ts). Projected
   * because a `config`-pinned identity and a transcript-derived one are very different
   * claims, and `'pending'` says out loud that the band is filed under the repairable
   * `'unknown'` sentinel rather than under a model.
   */
  estimatorMethod: string;
  priceEpoch: string;
  refclassAsOf: string | null;
  anchor: Anchor;
  plant: { marker: string; call: string };
  /**
   * OPEN tasks in the SAME anchor session whose subject overlaps this one — see
   * {@link findNearDuplicates}. Always empty on a re-estimate (`--tid`): appending to an
   * existing task is the very thing the warning asks for, so warning about it would be
   * telling the caller to do what they just did. Advisory: nothing about the mint,
   * the band or the exit code depends on it.
   */
  nearDuplicates: NearDuplicate[];
}

export const PLANT_MARKER = "EST_PLANT:";

// ---------------------------------------------------------------------------
// near-duplicate detection at mint (P1.0, Craig 2026-07-30)
// ---------------------------------------------------------------------------

/**
 * Tokens too common to be evidence that two subjects are about the same work. Kept
 * deliberately tiny: this is a WARNING heuristic, and a long stopword list is a second
 * thing to be wrong about. Every entry is a word that appears in the framing of an
 * estimate rather than in its subject.
 */
const SUBJECT_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "then",
  "add", "new", "use", "via", "per", "its", "not", "all", "any", "out",
  "est", "task", "work", "make", "fix",
]);

/**
 * Normalised content tokens of a subject: lowercased, split on anything that is not a
 * letter or a digit, and stripped of one- and two-character fragments and the stopwords
 * above. Exported because the test suite asserts on the OVERLAP rule rather than on a
 * warning string, and the rule is only meaningful if both sides tokenise identically.
 */
export function subjectTokens(subject: string): Set<string> {
  const out = new Set<string>();
  for (const raw of subject.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (SUBJECT_STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Overlap coefficient: |A ∩ B| / min(|A|, |B|), 0 when either side is empty.
 *
 * NOT Jaccard, on purpose. Jaccard punishes a long subject for being long, so
 * "sweeper close pass" vs "sweeper close pass, cron recon, SessionStart hook and the
 * near-duplicate warning" scores ~0.3 and slips under any threshold worth having —
 * and that pair is precisely the incident this exists for (an estimate refined into a
 * bigger goal, re-opened instead of `--reason refinement`).
 */
export function subjectOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * The overlap at which two subjects in ONE session are worth a warning.
 *
 * Half the shorter subject's content words in common. Low enough to catch a re-phrased
 * restatement of the same goal, high enough that two genuinely different tasks in one
 * session — the ordinary shape of a working day, and the case schema v6 exists to
 * support — do not trip it. It is a warning either way: the doctrine here is
 * observe-first, so the cost of a false positive is one line of stderr.
 */
export const NEAR_DUPLICATE_MIN_OVERLAP = 0.5;

/** An OPEN task in this session whose subject overlaps the one being minted. */
export interface NearDuplicate {
  tid: string;
  subject: string;
  status: string;
  overlap: number;
}

/**
 * OPEN tasks anchored to `sessionId` whose subject overlaps `subject` (P1.0, Craig
 * 2026-07-30).
 *
 * **Two real incidents, both on 2026-07-30, both silent.** A session RE-OPENED for work
 * it was already tracking instead of appending `est open --tid <existing> --reason
 * refinement`, and a sub-agent minted its own tid for work its orchestrator had already
 * estimated instead of `est bind`. Both produce the same corpus damage and it is not
 * cosmetic: two tasks share one session, §5.4's staleness closure splits the session's
 * spend between them by recency, and BOTH actuals are wrong — the first is truncated,
 * the second never had a baseline for what it actually did. Neither task is detectably
 * broken afterwards; they just quietly calibrate on halves.
 *
 * **A warning, and only ever a warning.** It never blocks the mint, never changes an
 * exit code and never writes a row. A duplicate-looking subject is EVIDENCE, not proof:
 * two phases of one project legitimately share most of their words, and refusing the
 * second would be the estimator overruling the human about what their own work is.
 * Observe-first — the same doctrine that keeps `anchor_inferred` a ledger row rather
 * than a refusal.
 *
 * Scoped to `anchor_session` rather than to every alias: an alias is how a task ABSORBS
 * a session, so matching on aliases would warn about every task a long-lived session has
 * ever touched. The anchor is where a task was minted, and minting twice in one place is
 * the shape of both incidents.
 */
export function findNearDuplicates(
  db: Database,
  sessionId: string,
  subject: string,
): NearDuplicate[] {
  const mine = subjectTokens(subject);
  if (mine.size === 0) return [];
  return db
    .query<{ tid: string; subject: string; status: string }, [string]>(
      `SELECT t.tid AS tid, s.subject AS subject, t.status AS status
         FROM task t JOIN v_scope_current s ON s.tid = t.tid
        WHERE t.anchor_session = ?
          AND t.status IN ('estimating','in_progress','pending_verification')`,
    )
    .all(sessionId)
    .map((r) => ({ ...r, overlap: subjectOverlap(mine, subjectTokens(r.subject)) }))
    .filter((r) => r.overlap >= NEAR_DUPLICATE_MIN_OVERLAP)
    .sort((a, b) => b.overlap - a.overlap);
}

/**
 * The estimator model family velocity history is keyed by, for ONE ceremony.
 *
 * Thin wrapper over {@link resolveEstimatorIdentity}, which owns the documented
 * resolution order (src/identity.ts). It exists so `est open` (step 7) and
 * `est refclass` (step 1) provably resolve the SAME identity from the SAME anchor:
 * both call this, both pass the anchor they resolved, and there is no second
 * derivation anywhere for the two to drift apart in.
 *
 * `at` is the estimate's own `created_at`, which bounds the fallback leg above. An
 * unbounded "newest main request" — what this used to be — is a function of the clock
 * rather than of the row, so a `/model` switch after the ceremony retroactively
 * changed what the same `est open` would have recorded.
 */
export function estimatorIdentity(
  db: Database,
  opts: { session?: string | null; prompt?: string | null; at?: string | null } = {},
): EstimatorIdentity {
  return resolveEstimatorIdentity(db, {
    session:
      opts.session ?? process.env.EST_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? null,
    promptId: opts.prompt ?? process.env.EST_PROMPT_ID ?? null,
    at: opts.at ?? null,
  });
}

/** The newest successful price sync — the vintage this band is denominated in. */
export function currentPriceEpoch(db: Database, now: Date): string {
  const row = db
    .query<{ price_epoch: string }, []>(
      "SELECT price_epoch FROM price_sync WHERE ok = 1 ORDER BY price_epoch DESC LIMIT 1",
    )
    .get();
  // No sync has ever succeeded. The band still has to be issued — nothing blocks on
  // missing reference data (§2) — so it is stamped with this instant, and
  // `v_task_actual_epoch` will simply find no price rows at that vintage and leave
  // `actual_wcet_at_epoch` NULL, which keeps the task out of `v_velocity` rather
  // than admitting it under a vintage that never existed.
  return row?.price_epoch ?? isoNow(now);
}

const INSERT_TASK_SQL = `
INSERT INTO task (tid, kind, status, created_at, anchor_session, anchor_prompt)
VALUES ($tid, $kind, 'estimating', $created_at, $anchor_session, $anchor_prompt)
`;

const INSERT_SCOPE_SQL = `
INSERT INTO task_scope (tid, seq, ts, subject, description, dod_json, scope_hash, source, reason, diff_summary)
VALUES ($tid, $seq, $ts, $subject, $description, $dod_json, $scope_hash, $source, $reason, $diff_summary)
`;

const INSERT_ESTIMATE_SQL = `
INSERT INTO estimate (
  tid, version, created_at, reason, scope_seq,
  raw_p50_wcet, raw_p90_wcet,
  exp_agents, exp_wf_phases, exp_files_write, exp_turns, exp_requests,
  bucket, bucket_n, refclass_as_of, shrink_w,
  cal_p50_wcet, cal_p90_wcet, cal_req_p50, cal_req_p90,
  active_p50_s, active_p90_s, active_model,
  price_epoch, ref_model, estimand, estimator_model
) VALUES (
  $tid, $version, $created_at, $reason, $scope_seq,
  $raw_p50, $raw_p90,
  $exp_agents, $exp_wf_phases, $exp_files_write, $exp_turns, $exp_requests,
  $bucket, $bucket_n, $refclass_as_of, $shrink_w,
  $cal_p50, $cal_p90, $cal_req_p50, $cal_req_p90,
  NULL, NULL, NULL,
  $price_epoch, $ref_model, $estimand, $estimator_model
)
`;

/**
 * Idempotent alias write. The conflict target is the FULL primary key including
 * `tid` (schema v6), so "already written" means *this* task already holds *this*
 * identity — a re-run, a re-bind, the same task file resurfacing under ~189 resumed
 * session dirs. It deliberately does NOT swallow a `ux_alias_exclusive` violation:
 * a second task claiming one agent, run or Task-tool number is a real conflict and
 * must surface, not vanish into a DO NOTHING.
 */
const UPSERT_ALIAS_SQL = `
INSERT INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
VALUES ($tid, $id_kind, $session_id, $local_id, $first_seen, $source)
ON CONFLICT(id_kind, session_id, local_id, tid) DO NOTHING
`;

const INSERT_ANOMALY_SQL = `INSERT INTO anomaly (ts, kind, detail, tid) VALUES ($ts, $kind, $detail, $tid)`;

function writeAnomaly(db: Database, ts: string, kind: string, detail: string, tid: string | null): void {
  db.query(INSERT_ANOMALY_SQL).run({ $ts: ts, $kind: kind, $detail: detail, $tid: tid } as never);
}

/** Replace the task's FTS row — the reference class is only as good as its index. */
function reindexFts(db: Database, tid: string, subject: string, description: string | null): void {
  db.query("DELETE FROM task_fts WHERE tid = ?").run(tid);
  db.query("INSERT INTO task_fts (tid, subject, description) VALUES (?, ?, ?)").run(
    tid,
    subject,
    description ?? "",
  );
}

/**
 * Mint a task and its first estimate, or append a re-estimate to an existing one.
 *
 * Everything below happens in ONE `BEGIN IMMEDIATE` transaction: a task with no
 * scope row, or a scope row with no estimate, is not a state this system has any
 * meaning for, and half of it landing would corrupt `eid_at_start` — the baseline
 * every accuracy number in the design is judged against.
 *
 * The caller holds the sweep lock. This function does not take it.
 */
export function openTask(db: Database, input: OpenInput): OpenResult {
  const now = input.now ?? new Date();
  const ts = isoNow(now);
  const dod = input.dod ?? [];
  const dodJson = JSON.stringify(dod);
  const description = input.description ?? null;

  // Before anything is resolved, minted or written: an inverted band is not an
  // uncertainty band. `estimate` is append-only (est_ro_u / est_ro_d), so a row
  // whose p90 sits below its p50 could never be corrected in place — it would sit
  // in the corpus forever, scored against an actual by a coverage check that reads
  // p90 as the upper edge. The only guards here used to be `Math.max(0, …)`.
  if (input.rawP90 < input.rawP50) {
    throw new UsageError(
      `--raw-p90 (${input.rawP90}) must be >= --raw-p50 (${input.rawP50}): a p90 below the p50 is not an uncertainty band, ` +
        "and `estimate` is append-only, so the row could never be corrected",
    );
  }

  const refModel = getConfig(db, "ref_model") ?? "claude-sonnet-4-5";
  const estimand = getConfig(db, "estimand") ?? "work_cet";
  const priceEpoch = currentPriceEpoch(db, now);

  const existingTid = input.tid ?? null;
  let anchor: Anchor;
  let tid: string;
  let scopeSeq: number;
  let version: number;
  let reason: EstimateReason;

  if (existingTid === null) {
    if (input.reason !== null && input.reason !== undefined && input.reason !== "initial") {
      throw new InvariantError(
        `--reason ${input.reason} needs a --tid: there is nothing to re-estimate`,
        "drop --reason to mint a new task, or pass --tid <tid> to append to an existing one",
      );
    }
    anchor = resolveAnchor(db, { session: input.session, prompt: input.prompt, now });
    tid = Bun.randomUUIDv7();
    scopeSeq = 1;
    version = 1;
    reason = "initial";
  } else {
    const task = db
      .query<{ tid: string; status: string; anchor_session: string; anchor_prompt: string }, [string]>(
        "SELECT tid, status, anchor_session, anchor_prompt FROM task WHERE tid = ?",
      )
      .get(existingTid);
    if (task === null || task === undefined) {
      throw new InvariantError(
        `unknown tid: ${existingTid}`,
        "run `est open` without --tid to mint a new task",
      );
    }
    if (input.reason === null || input.reason === undefined) {
      throw new UsageError(
        "--tid requires an explicit --reason (refinement | scope_change | recalibration)",
      );
    }
    if (input.reason === "initial") {
      throw new InvariantError(
        "--reason initial is not appendable: exactly one initial estimate exists per task, and it is the accuracy baseline",
        "use --reason refinement (the work is bigger), --reason scope_change (the goal moved; run `est scope` first), or --reason recalibration",
      );
    }
    reason = input.reason;
    tid = task.tid;

    const terminal = db
      .query<{ final_status: string }, [string]>(
        "SELECT final_status FROM v_outcome_current WHERE tid = ?",
      )
      .get(tid);
    if (
      terminal !== null &&
      terminal !== undefined &&
      terminal.final_status !== "reopened" &&
      TERMINAL_TASK_STATUS.has(terminal.final_status)
    ) {
      throw new InvariantError(
        `tid ${tid} is finalized (${terminal.final_status}); estimates cannot be appended to a closed task`,
        "reopen it first with `est close <tid> --status reopened`, which appends a new outcome revision rather than editing the old one",
      );
    }

    const scope = currentScope(db, tid);
    if (scope === null) {
      throw new InvariantError(
        `tid ${tid} has no scope history`,
        "this database is inconsistent; re-open the task with `est open`",
      );
    }
    scopeSeq = scope.seq;

    if (reason === "scope_change") {
      const baseline = db
        .query<{ scope_seq: number }, [string]>(
          "SELECT scope_seq FROM estimate WHERE tid = ? ORDER BY eid ASC LIMIT 1",
        )
        .get(tid);
      const baselineSeq = baseline?.scope_seq ?? 0;
      if (!(scopeSeq > baselineSeq)) {
        // The load-bearing precondition, and the reason exit 2 exists (P1.12).
        // `scope_change` is the ONLY reason that removes a task from the calibration
        // corpus, which makes it the one lever an estimator could pull to make a bad
        // estimate disappear. So it is not available by assertion.
        throw new InvariantError(
          `--reason scope_change requires a scope revision appended since the baseline estimate (baseline scope_seq=${baselineSeq}, current=${scopeSeq})`,
          "run `est scope <tid> --reason \"<what moved>\" [--subject …] [--description …] [--dod …]` first — a scope change is a fact in the scope history, or it is not a scope change",
        );
      }
    }

    version =
      (db
        .query<{ v: number }, [string]>("SELECT MAX(version) AS v FROM estimate WHERE tid = ?")
        .get(tid)?.v ?? 0) + 1;
    anchor = {
      sessionId: input.session ?? task.anchor_session,
      promptId: input.prompt ?? task.anchor_prompt,
      inferred: false,
      note: null,
    };
  }

  // Computed BEFORE the mint transaction, and only on the mint path. After the INSERT
  // the new task is itself an open task anchored to this session with this exact
  // subject, so the same query would score it at 1.0 against itself.
  const nearDuplicates =
    existingTid === null ? findNearDuplicates(db, anchor.sessionId, input.subject) : [];

  // Resolved from the ANCHOR — session AND prompt — and bounded above by this
  // estimate's own timestamp, so the answer is a function of the row rather than of
  // when the question is asked. `est refclass` resolves it the same way from the same
  // anchor, which is what makes step 1 and step 7 of the ceremony agree.
  const identity = estimatorIdentity(db, {
    session: anchor.sessionId,
    prompt: anchor.promptId,
    at: ts,
  });
  const estModel = identity.model;
  const estFamily = identity.family;

  const bucket = "global";
  const liveN = liveBucketN(db, bucket, refModel, estimand);
  const cal = calibrationFor(db, bucket, estFamily, refModel, estimand, liveN);

  const calP50 = Math.max(0, Math.round(input.rawP50 * cal.multP50));
  const calP90 = Math.max(0, Math.round(input.rawP90 * cal.multP90));
  // The request band is calibrated exactly like the WCET band, including when there
  // is no reference class: `calibrationFor` returns multipliers of 1.0 for a cold
  // start, so both ends are then the raw guess and the `uncalibrated` flag carries
  // the caveat. It used to write the raw guess into p50 and NULL into p90, which
  // handed P1.9's `requests: {n, p50, p90}` contract a half-populated band — an
  // asymmetry no consumer could render and the WCET band never had.
  const calReqP50 = Math.max(0, Math.round(input.expRequests * cal.multP50));
  const calReqP90 = Math.max(0, Math.round(input.expRequests * cal.multP90));

  db.transaction(() => {
    if (existingTid === null) {
      db.query(INSERT_TASK_SQL).run({
        $tid: tid,
        $kind: input.kind,
        $created_at: ts,
        $anchor_session: anchor.sessionId,
        $anchor_prompt: anchor.promptId,
      } as never);
      db.query(INSERT_SCOPE_SQL).run({
        $tid: tid,
        $seq: 1,
        $ts: ts,
        $subject: input.subject,
        $description: description,
        $dod_json: dodJson,
        $scope_hash: scopeHash(input.subject, description, dodJson),
        $source: "est_open",
        $reason: null,
        $diff_summary: null,
      } as never);
      reindexFts(db, tid, input.subject, description);
      // The anchor binding. A session that already hosts an open task gets a SECOND
      // row here rather than losing this one (schema v6): sequential tasks in one
      // session are the ordinary shape of a working day, and §5.4's staleness closure
      // is what decides which of them a later turn belongs to. Under the v5 key this
      // insert silently did nothing and the new task's spend went to the old one.
      db.query(UPSERT_ALIAS_SQL).run({
        $tid: tid,
        $id_kind: "session",
        $session_id: anchor.sessionId,
        $local_id: anchor.sessionId,
        $first_seen: ts,
        $source: "est_bind",
      } as never);
      if (anchor.inferred) {
        writeAnomaly(
          db,
          ts,
          "anchor_inferred",
          `est open resolved its anchor without an explicit --session/--prompt (${anchor.note ?? "inferred"}): session=${anchor.sessionId} prompt=${anchor.promptId}`,
          tid,
        );
      }
    }

    db.query(INSERT_ESTIMATE_SQL).run({
      $tid: tid,
      $version: version,
      $created_at: ts,
      $reason: reason,
      $scope_seq: scopeSeq,
      $raw_p50: Math.max(0, Math.round(input.rawP50)),
      $raw_p90: Math.max(0, Math.round(input.rawP90)),
      $exp_agents: input.expAgents,
      $exp_wf_phases: input.expWfPhases,
      $exp_files_write: input.expFilesWrite,
      $exp_turns: input.expTurns,
      $exp_requests: input.expRequests,
      $bucket: cal.bucket,
      $bucket_n: cal.bucketN,
      $refclass_as_of: cal.refclassAsOf,
      $shrink_w: cal.shrinkW,
      $cal_p50: calP50,
      $cal_p90: calP90,
      $cal_req_p50: calReqP50,
      $cal_req_p90: calReqP90,
      $price_epoch: priceEpoch,
      $ref_model: refModel,
      $estimand: estimand,
      $estimator_model: estModel,
    } as never);

    // `est open --continue <tid> --session <sid>`: bind the resumed or forked session
    // to this task. Additive, like the mint path — the session may already be hosting
    // another task and that is not this verb's business to refuse.
    if (existingTid !== null && input.session !== null && input.session !== undefined) {
      db.query(UPSERT_ALIAS_SQL).run({
        $tid: tid,
        $id_kind: "session",
        $session_id: input.session,
        $local_id: input.session,
        $first_seen: ts,
        $source: "est_bind",
      } as never);
    }
  }).immediate();

  const eid = db.query<{ eid: number }, [string, number]>(
    "SELECT eid FROM estimate WHERE tid = ? AND version = ?",
  ).get(tid, version)!.eid;

  return {
    tid,
    eid,
    version,
    reason,
    minted: existingTid === null,
    scopeSeq,
    raw: { p50: Math.round(input.rawP50), p90: Math.round(input.rawP90) },
    band: {
      p50: calP50,
      p90: calP90,
      reqP50: calReqP50,
      reqP90: calReqP90,
      // §7.3: the three-clock model issues no active-time band until the candidate
      // beats its fact-sheet-backed baseline. Until then these are NULL and the CLI
      // reports consumption, never time remaining — it does not fabricate a minutes
      // figure from tokens, which is the refuted chain this whole design replaced.
      activeP50S: null,
      activeP90S: null,
      spendUsdP50: spendForecast(db, calP50, refModel, priceEpoch),
      spendUsdP90: spendForecast(db, calP90, refModel, priceEpoch),
    },
    uncalibrated: cal.uncalibrated,
    bucket: cal.bucket,
    bucketN: cal.bucketN,
    refModel,
    estimand,
    estimatorModel: estModel,
    estimatorMethod: identity.method,
    priceEpoch,
    refclassAsOf: cal.refclassAsOf,
    anchor,
    plant: {
      marker: PLANT_MARKER,
      call: `TaskUpdate({ taskId: "<n>", metadata: { est_tid: "${tid}" } })`,
    },
    nearDuplicates,
  };
}

/**
 * Work-CET -> a USD figure, for the Spend-CET line of the band (§3.2 step 7).
 *
 * Work-CET is denominated in ref-model output tokens, so the forecast is simply the
 * band times the ref model's output price at the estimate's own vintage. It is a
 * LOWER bound on the bill — Spend-CET also carries `input` and `cache_read`, which
 * are 55-57% of list cost — and the CLI labels it as such rather than implying the
 * band predicts the invoice.
 */
export function spendForecast(
  db: Database,
  wcet: number,
  refModel: string,
  priceEpoch: string,
): number | null {
  const row = db
    .query<{ usd_out: number }, [string, string]>(
      `SELECT usd_out FROM model_price WHERE family = ? AND effective_from <= ?
        ORDER BY effective_from DESC LIMIT 1`,
    )
    .get(refModel, priceEpoch);
  if (row === null || row === undefined) return null;
  return (wcet * row.usd_out) / 1_000_000;
}

// ---------------------------------------------------------------------------
// `est block` (P1.2)
// ---------------------------------------------------------------------------

export interface BlockInput {
  tid: string;
  phaseIdx: number;
  title: string;
  p50: number;
  p90: number;
  expAgents?: number;
  model?: string | null;
  now?: Date;
}

export interface BlockResult {
  tid: string;
  eid: number;
  phaseIdx: number;
  title: string;
  p50: number;
  p90: number;
  declaredPhases: number | null;
  blocksSoFar: number;
}

export const MAX_PHASE_IDX = 64;

/**
 * Append one `estimate_block` row against the task's CURRENT maximum `eid`.
 *
 * **`--phase` is 0-BASED — it is the `phases[]` array index, not
 * `workflowProgress[].phaseIndex`.** The harness writes `phaseIndex` 1-based and
 * `discover.ts` normalises it on the way in (§5.6), so the database's convention
 * throughout is 0-based. Passing the 1-based value silently mis-joins every block
 * estimate to the wrong phase, and "silently" is the operative word: there is no
 * error, just a systematically wrong per-phase accuracy table. It is the single
 * easiest thing to get wrong in the whole ceremony, which is why it is validated
 * against the declared phase list whenever a `workflow_run` is already bound.
 */
export function addBlock(db: Database, input: BlockInput): BlockResult {
  const ts = isoNow(input.now ?? new Date());
  if (!Number.isInteger(input.phaseIdx) || input.phaseIdx < 0 || input.phaseIdx >= MAX_PHASE_IDX) {
    throw new UsageError(`--phase must be an integer in [0, ${MAX_PHASE_IDX}); got ${input.phaseIdx}`);
  }
  // Same rule as the task band, and for the same reason: `estimate_block` carries
  // estb_ro_u / estb_ro_d, so an inverted phase band is permanent.
  if (input.p90 < input.p50) {
    throw new UsageError(
      `--p90 (${input.p90}) must be >= --p50 (${input.p50}): a p90 below the p50 is not an uncertainty band, ` +
        "and `estimate_block` is append-only, so the row could never be corrected",
    );
  }
  const est = db
    .query<{ eid: number }, [string]>("SELECT MAX(eid) AS eid FROM estimate WHERE tid = ?")
    .get(input.tid);
  const eid = est?.eid ?? null;
  if (eid === null) {
    throw new InvariantError(
      `tid ${input.tid} has no estimate to block against`,
      "run `est open` first — block estimates roll up to a task band, they never replace one",
    );
  }

  // When the run is already bound, the declared plan is the authority on which
  // phase indices exist. Reporting "phase 4 of a 3-phase workflow" as accepted would
  // put a block estimate somewhere no actual can ever join it.
  const run = db
    .query<{ run_id: string; wf_launch_id: string; n_phases_planned: number | null }, [string]>(
      "SELECT run_id, wf_launch_id, n_phases_planned FROM workflow_run WHERE tid = ? ORDER BY started_at DESC LIMIT 1",
    )
    .get(input.tid);
  let declaredPhases: number | null = null;
  if (run !== null && run !== undefined) {
    const declared = db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM workflow_phase WHERE run_id = ? AND wf_launch_id = ?",
      )
      .get(run.run_id, run.wf_launch_id)?.n ?? 0;
    declaredPhases = declared > 0 ? declared : run.n_phases_planned;
    if (declaredPhases !== null && declaredPhases > 0 && input.phaseIdx >= declaredPhases) {
      throw new UsageError(
        `--phase ${input.phaseIdx} is outside the ${declaredPhases} declared phase(s) of the bound workflow run. ` +
          "Remember --phase is 0-BASED (the phases[] index), not the 1-based workflowProgress phaseIndex.",
      );
    }
  }

  const dup = db
    .query<{ n: number }, [number, number]>(
      "SELECT COUNT(*) AS n FROM estimate_block WHERE eid = ? AND phase_idx = ?",
    )
    .get(eid, input.phaseIdx)?.n ?? 0;
  if (dup > 0) {
    throw new InvariantError(
      `estimate_block (eid=${eid}, phase=${input.phaseIdx}) already exists; estimate_block is append-only`,
      "re-estimating a block means issuing a NEW estimate (`est open --tid <tid> --reason refinement`) and blocking against that",
    );
  }

  db.transaction(() => {
    db.query(
      `INSERT INTO estimate_block (eid, phase_idx, created_at, title, p50_wcet, p90_wcet, exp_agents, model)
       VALUES ($eid, $phase_idx, $created_at, $title, $p50, $p90, $exp_agents, $model)`,
    ).run({
      $eid: eid,
      $phase_idx: input.phaseIdx,
      $created_at: ts,
      $title: input.title,
      $p50: Math.max(0, Math.round(input.p50)),
      $p90: Math.max(0, Math.round(input.p90)),
      $exp_agents: input.expAgents ?? 1,
      $model: input.model ?? null,
    } as never);
  }).immediate();

  const blocksSoFar =
    db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM estimate_block WHERE eid = ?").get(eid)
      ?.n ?? 0;

  return {
    tid: input.tid,
    eid,
    phaseIdx: input.phaseIdx,
    title: input.title,
    p50: Math.round(input.p50),
    p90: Math.round(input.p90),
    declaredPhases,
    blocksSoFar,
  };
}

// ---------------------------------------------------------------------------
// `est bind` (P1.3)
// ---------------------------------------------------------------------------

export type AliasKind = "session" | "session_task" | "workflow_run" | "agent" | "job";

export interface BindInput {
  tid: string;
  session?: string | null;
  task?: string | null;
  run?: string | null;
  agent?: string | null;
  now?: Date;
}

export interface BindResult {
  tid: string;
  written: Array<{ id_kind: AliasKind; session_id: string; local_id: string; existed: boolean }>;
}

/**
 * Attach harness identities to a tid — the manual counterpart to the sweeper's
 * automatic `est_tid` harvest (§5.7), covering the fork case and retroactive
 * stitching.
 *
 * Idempotent by primary key, and the key includes `tid` (schema v6), so what counts
 * as a conflict depends on whether the identity is shared or exclusive:
 *
 *  - **`--session` is shared.** A session hosts many tasks across a working day;
 *    binding a second tid to one adds a row and lets §5.4 decide, by staleness
 *    closure, which task a later turn belongs to. Refusing here is what made a
 *    second `est open` in a session unrecoverable.
 *  - **`--task` / `--run` / `--agent` are exclusive.** One Task-tool number, one
 *    workflow run, one agent is exactly one task's. A different owner exits 2:
 *    silently re-pointing it would move that stream's spend from one task's actual
 *    to another's, after the fact, with no record. `ux_alias_exclusive` enforces the
 *    same rule physically; this check exists to say so in words.
 */
export function bindTask(db: Database, input: BindInput): BindResult {
  const ts = isoNow(input.now ?? new Date());
  const task = db.query<{ tid: string }, [string]>("SELECT tid FROM task WHERE tid = ?").get(input.tid);
  if (task === null || task === undefined) {
    throw new InvariantError(`unknown tid: ${input.tid}`, "run `est open` to mint a task first");
  }

  const targets: Array<{ id_kind: AliasKind; session_id: string; local_id: string }> = [];
  const session = input.session ?? null;
  if (session !== null) targets.push({ id_kind: "session", session_id: session, local_id: session });
  if (input.task !== null && input.task !== undefined) {
    if (session === null) {
      throw new UsageError("--task <n> needs --session <sid>: a Task-tool number is session-scoped");
    }
    targets.push({ id_kind: "session_task", session_id: session, local_id: input.task });
  }
  if (input.run !== null && input.run !== undefined) {
    // A run's transcripts routinely live under a DIFFERENT session from its state
    // file (G-PHASE promotion condition 1), so the run id is the identity and the
    // session is context. Binding under the anchor session is correct and the
    // sweeper resolves the run by `run_id` regardless.
    targets.push({
      id_kind: "workflow_run",
      session_id: session ?? runSession(db, input.run) ?? "",
      local_id: input.run,
    });
  }
  if (input.agent !== null && input.agent !== undefined) {
    targets.push({
      id_kind: "agent",
      session_id: session ?? agentSession(db, input.agent) ?? "",
      local_id: input.agent,
    });
  }
  if (targets.length === 0) {
    throw new UsageError("est bind: give at least one identity — --session, --task, --run or --agent");
  }

  const written: BindResult["written"] = [];
  db.transaction(() => {
    for (const t of targets) {
      // A session is SHARED — many tasks over its life, told apart by §5.4's
      // staleness closure — so the only question there is "does this tid already
      // hold it", i.e. idempotence. Every other identity is EXCLUSIVE: one agent,
      // run or Task-tool number is one task's, and any other owner is the conflict
      // P1.3 refuses.
      const existing =
        t.id_kind === "session"
          ? db
              .query<{ tid: string }, [string, string, string, string]>(
                "SELECT tid FROM task_alias WHERE id_kind = ? AND session_id = ? AND local_id = ? AND tid = ?",
              )
              .get(t.id_kind, t.session_id, t.local_id, input.tid)
          : db
              .query<{ tid: string }, [string, string, string]>(
                "SELECT tid FROM task_alias WHERE id_kind = ? AND session_id = ? AND local_id = ?",
              )
              .get(t.id_kind, t.session_id, t.local_id);
      if (existing !== null && existing !== undefined) {
        if (existing.tid !== input.tid) {
          throw new InvariantError(
            `${t.id_kind} ${t.local_id} (session ${t.session_id}) is already bound to tid ${existing.tid}`,
            "aliases are never silently re-pointed — close or correct the other task first; re-pointing would move spend between actuals after the fact",
          );
        }
        written.push({ ...t, existed: true });
        continue;
      }
      db.query(UPSERT_ALIAS_SQL).run({
        $tid: input.tid,
        $id_kind: t.id_kind,
        $session_id: t.session_id,
        $local_id: t.local_id,
        $first_seen: ts,
        $source: "est_bind",
      } as never);
      written.push({ ...t, existed: false });
    }
  }).immediate();

  return { tid: input.tid, written };
}

function runSession(db: Database, runId: string): string | null {
  return (
    db
      .query<{ session_id: string }, [string]>(
        "SELECT session_id FROM workflow_run WHERE run_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(runId)?.session_id ?? null
  );
}

function agentSession(db: Database, agentId: string): string | null {
  return (
    db
      .query<{ session_id: string }, [string]>("SELECT session_id FROM agent_run WHERE agent_id = ?")
      .get(agentId)?.session_id ?? null
  );
}

// ---------------------------------------------------------------------------
// `est scope` (P1.5)
// ---------------------------------------------------------------------------

export interface ScopeInput {
  tid: string;
  reason: string;
  subject?: string | null;
  description?: string | null;
  dod?: DodItem[] | null;
  now?: Date;
}

export interface ScopeResult {
  tid: string;
  seq: number;
  scopeHash: string;
  diffSummary: string;
  subject: string;
}

/**
 * Append a scope revision at `seq + 1`, with a recomputed hash and a stored diff.
 *
 * Refusing a NO-OP revision (exit 2) is not tidiness — it is the other half of the
 * `scope_change` precondition (P1.12). `est open --reason scope_change` requires a
 * scope revision appended since the baseline; if this verb accepted a revision that
 * changed nothing, a caller could manufacture that precondition by re-submitting the
 * same subject and remove any task it liked from the calibration corpus.
 */
export function appendScope(db: Database, input: ScopeInput): ScopeResult {
  const ts = isoNow(input.now ?? new Date());
  const prev = currentScope(db, input.tid);
  if (prev === null) {
    throw new InvariantError(
      `unknown tid: ${input.tid}`,
      "run `est open` to mint a task before revising its scope",
    );
  }
  const subject = input.subject ?? prev.subject;
  const description = input.description === undefined ? prev.description : input.description;
  const dodJson = input.dod === undefined || input.dod === null ? prev.dod_json : JSON.stringify(input.dod);
  const hash = scopeHash(subject, description, dodJson);

  if (hash === prev.scope_hash) {
    throw new InvariantError(
      "this revision changes nothing: the recomputed scope_hash equals the current one",
      "an empty scope revision is not a scope change — pass a --subject, --description or --dod that actually differs",
    );
  }

  const diff = unifiedDiff(
    scopeText(prev.subject, prev.description, prev.dod_json),
    scopeText(subject, description, dodJson),
    { fromLabel: `scope seq ${prev.seq}`, toLabel: `scope seq ${prev.seq + 1}`, maxBytes: 2048 },
  );
  const seq = prev.seq + 1;

  db.transaction(() => {
    db.query(INSERT_SCOPE_SQL).run({
      $tid: input.tid,
      $seq: seq,
      $ts: ts,
      $subject: subject,
      $description: description,
      $dod_json: dodJson,
      $scope_hash: hash,
      $source: "est_scope",
      $reason: input.reason,
      $diff_summary: diff,
    } as never);
    reindexFts(db, input.tid, subject, description);
  }).immediate();

  return { tid: input.tid, seq, scopeHash: hash, diffSummary: diff, subject };
}

// ---------------------------------------------------------------------------
// `est refclass` (P1.4)
// ---------------------------------------------------------------------------

export interface RefclassMatch {
  tid: string;
  subject: string;
  kind: string;
  fanout: number;
  raw_p50: number;
  raw_p90: number;
  cal_p50: number;
  cal_p90: number;
  actual_wcet: number;
  velocity: number | null;
  excerpt: string;
  finalized_at: string;
}

export interface RefclassBucketLine {
  bucket: string;
  n: number;
  n_eff: number | null;
  mult_p50: number | null;
  mult_p90: number | null;
  boot_p50: { lo: number; hi: number } | null;
  boot_p90: { lo: number; hi: number } | null;
  as_of: string | null;
  uncalibrated: boolean;
  estimator_family: string;
}

export interface RefclassResult {
  query: string;
  kind: string | null;
  fanout: number | null;
  /** The `--fanout` tolerance band actually applied, or null when none was asked for. */
  fanout_band: { lo: number; hi: number } | null;
  /**
   * True when `--fanout` matched nothing and the UNFILTERED class is shown instead.
   * The flag must never manufacture an empty reference class, and it must never
   * quietly widen one either — so the fallback is reported, not just taken.
   */
  fanout_relaxed: boolean;
  matches: RefclassMatch[];
  bucket: RefclassBucketLine;
  /** Cold start: the raw actual-cost distribution, since no multiplier is honest. */
  cold_distribution: { n: number; p10: number | null; p50: number | null; p90: number | null } | null;
  ref_model: string;
  estimand: string;
  /**
   * The estimator identity this bucket line was looked up under, and WHICH leg of the
   * resolution order produced it. `est open` a moment later must report the same pair —
   * a test pins exactly that, because the two disagreeing is the failure this whole
   * mechanism exists to make impossible.
   */
  estimator_model: string;
  estimator_method: string;
}

/** P1.4's hard budget: 8,000 chars against the 10,000-char hook cap. */
export const REFCLASS_BUDGET_CHARS = 8000;
export const EXCERPT_CHARS = 200;

/**
 * The `--fanout n` neighbourhood: half to double, with a floor of +2 so small
 * fan-outs still have a band (`--fanout 1` is 0..3, not 0..2).
 *
 * `outcome.n_agents` is a realized count, not a label, so equality is the wrong
 * comparison: two agents and three agents are the same shape of work and the corpus
 * is far too small to spend a whole reference class on the difference. Half-to-double
 * is the same order-of-magnitude reading the rest of the design uses for velocity.
 */
export function fanoutBand(fanout: number): { lo: number; hi: number } {
  const f = Math.max(0, Math.trunc(fanout));
  return { lo: Math.floor(f / 2), hi: Math.max(2 * f, f + 2) };
}

/**
 * FTS5 MATCH strings are a query language, so raw user text is not merely unsafe,
 * it is frequently a syntax error (`est refclass --text "fix: the C++ parser"`).
 * Every token is quoted and OR-joined, which is the broadest sensible reading of
 * "find me work like this" and cannot throw.
 */
export function ftsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * The reference class, shown BEFORE the estimator states a number (§3.2 step 1).
 *
 * Read-only: writes nothing, takes no lock, and exits 0 even with no matches — an
 * empty reference class is a valid, informative answer and must not look like a
 * failure.
 *
 * **Cold-start honesty:** below `bucket_n = 10` this returns the raw actual-cost
 * distribution for similar work and NO velocity multiplier. Pretending to a
 * multiplier at n = 3 is how a backfill-seeded reference class overclaims `[CA]`.
 *
 * **`--fanout` is a TOLERANCE, not an equality.** `o.n_agents` is a realized count,
 * so "the same fan-out" is a neighbourhood — {@link fanoutBand} — and never `= n`,
 * which at this corpus size would empty the class for almost every value. And a
 * filter that empties the class is worse than no filter, so when the band matches
 * nothing the unfiltered class is returned with `fanout_relaxed: true` rather than
 * an empty reference class manufactured by the flag. Until this landed the flag was
 * accepted, echoed, documented in README.md and instructed by the estimating skill,
 * and filtered exactly nothing.
 */
export function refclass(
  db: Database,
  opts: {
    kind?: string | null;
    fanout?: number | null;
    text: string;
    limit?: number;
    /** The anchor `est open` will use. Pass the SAME `--session`/`--prompt`. */
    session?: string | null;
    prompt?: string | null;
  },
): RefclassResult {
  const refModel = getConfig(db, "ref_model") ?? "claude-sonnet-4-5";
  const estimand = getConfig(db, "estimand") ?? "work_cet";
  // The SAME identity `est open` will stamp on the band a moment later, resolved by
  // the SAME function from the SAME anchor: step 1 and step 7 of the ceremony have to
  // agree about whose history is on screen, or the bucket line shown before the number
  // is a different family's calibration.
  //
  // This used to resolve the session by its own rule (env, else the newest turn in the
  // whole database) while `openTask` used `resolveAnchor` — so `est open --session X`
  // with a bare `est refclass` genuinely printed one family's history and stamped
  // another's. The session/prompt now come from the caller; `cmdRefclass` forwards
  // `--session`/`--prompt`, and the fallbacks below are `resolveAnchor`'s own, minus
  // its refusals: `est refclass` never fails, and an unresolved anchor simply reads
  // the repairable 'unknown' sentinel.
  const session =
    opts.session ??
    process.env.EST_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID ??
    db
      .query<{ session_id: string }, []>(
        "SELECT session_id FROM turn ORDER BY started_at DESC LIMIT 1",
      )
      .get()?.session_id ??
    null;
  const prompt =
    opts.prompt ??
    process.env.EST_PROMPT_ID ??
    (session === null
      ? null
      : (db
          .query<{ prompt_id: string }, [string]>(
            "SELECT prompt_id FROM turn WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
          )
          .get(session)?.prompt_id ?? null));
  const identity = resolveEstimatorIdentity(db, {
    session,
    promptId: prompt,
    // Bounded above by NOW, exactly as `openTask` bounds it by the estimate's
    // `created_at`. The two calls are seconds apart, so the same window is examined.
    at: isoNow(new Date()),
  });
  const estFamily = identity.family;
  const bucket = "global";
  const limit = opts.limit ?? 5;

  const fanout =
    opts.fanout === null || opts.fanout === undefined || !Number.isFinite(opts.fanout)
      ? null
      : Math.max(0, Math.trunc(opts.fanout));
  const band = fanout === null ? null : fanoutBand(fanout);

  const q = ftsQuery(opts.text);
  const baseParams: Array<string | number> = [];
  let sql = `
    SELECT t.tid AS tid, s.subject AS subject, t.kind AS kind,
           o.n_agents AS fanout,
           e.raw_p50_wcet AS raw_p50, e.raw_p90_wcet AS raw_p90,
           e.cal_p50_wcet AS cal_p50, e.cal_p90_wcet AS cal_p90,
           COALESCE(o.actual_wcet_at_epoch, o.actual_wcet) AS actual_wcet,
           o.velocity_raw AS velocity,
           COALESCE(s.description, '') AS excerpt,
           o.finalized_at AS finalized_at
      FROM v_outcome_current o
      JOIN task t         ON t.tid = o.tid
      JOIN v_scope_current s ON s.tid = o.tid
      JOIN estimate e     ON e.eid = o.eid_at_start
     WHERE o.final_status = 'completed'
       AND e.ref_model = ? AND e.estimand = ?`;
  baseParams.push(refModel, estimand);
  if (q !== null) {
    sql += " AND t.tid IN (SELECT tid FROM task_fts WHERE task_fts MATCH ?)";
    baseParams.push(q);
  }
  if (opts.kind !== null && opts.kind !== undefined) {
    sql += " AND t.kind = ?";
    baseParams.push(opts.kind);
  }

  const runMatches = (within: { lo: number; hi: number } | null): RefclassMatch[] => {
    let q2 = sql;
    const params = [...baseParams];
    if (within !== null && fanout !== null) {
      q2 += " AND o.n_agents BETWEEN ? AND ?";
      params.push(within.lo, within.hi);
      // Nearest fan-out first WITHIN the band, then newest: at five rows, recency is
      // the tie-break, not the ranking.
      q2 += " ORDER BY ABS(o.n_agents - ?) ASC, o.finalized_at DESC LIMIT ?";
      params.push(fanout, limit);
    } else {
      q2 += " ORDER BY o.finalized_at DESC LIMIT ?";
      params.push(limit);
    }
    try {
      return db.query<RefclassMatch, Array<string | number>>(q2).all(...params);
    } catch {
      // A malformed MATCH must degrade to "no matches", never to a stack trace on the
      // ceremony's first step.
      return [];
    }
  };

  let rows = runMatches(band);
  let fanoutRelaxed = false;
  if (band !== null && rows.length === 0) {
    rows = runMatches(null);
    fanoutRelaxed = rows.length > 0;
  }
  const matches = rows.map((r) => ({
    ...r,
    excerpt: r.excerpt.length > EXCERPT_CHARS ? `${r.excerpt.slice(0, EXCERPT_CHARS - 1)}…` : r.excerpt,
  }));

  const snap = newestRefclass(db, bucket, estFamily, refModel, estimand);
  const liveN = liveBucketN(db, bucket, refModel, estimand);
  const n = snap?.n ?? liveN;
  const uncalibrated = snap === null || n < COLD_START_N;

  const bucketLine: RefclassBucketLine = {
    bucket,
    n,
    n_eff: snap?.n_eff ?? null,
    mult_p50: uncalibrated ? null : (snap?.mult_p50 ?? null),
    mult_p90: uncalibrated ? null : (snap?.mult_p90 ?? null),
    boot_p50:
      !uncalibrated && snap?.boot_lo_p50 !== null && snap?.boot_lo_p50 !== undefined && snap.boot_hi_p50 !== null
        ? { lo: snap.boot_lo_p50, hi: snap.boot_hi_p50 }
        : null,
    boot_p90:
      !uncalibrated && snap?.boot_lo_p90 !== null && snap?.boot_lo_p90 !== undefined && snap.boot_hi_p90 !== null
        ? { lo: snap.boot_lo_p90, hi: snap.boot_hi_p90 }
        : null,
    as_of: uncalibrated ? null : (snap?.as_of ?? null),
    uncalibrated,
    estimator_family: snap?.estimator_family ?? estFamily,
  };

  let cold: RefclassResult["cold_distribution"] = null;
  if (uncalibrated) {
    const actuals = db
      .query<{ w: number }, [string, string]>(
        `SELECT COALESCE(o.actual_wcet_at_epoch, o.actual_wcet) AS w
           FROM v_outcome_current o JOIN estimate e ON e.eid = o.eid_at_start
          WHERE o.final_status = 'completed' AND e.ref_model = ? AND e.estimand = ?`,
      )
      .all(refModel, estimand)
      .map((r) => r.w);
    cold = {
      n: actuals.length,
      p10: quantileOf(actuals, 0.1),
      p50: quantileOf(actuals, 0.5),
      p90: quantileOf(actuals, 0.9),
    };
  }

  return {
    query: opts.text,
    kind: opts.kind ?? null,
    fanout,
    fanout_band: band,
    fanout_relaxed: fanoutRelaxed,
    matches,
    bucket: bucketLine,
    cold_distribution: cold,
    ref_model: refModel,
    estimand,
    estimator_model: identity.model,
    estimator_method: identity.method,
  };
}

/**
 * Re-derive a bootstrap CI for a bucket's multiplier straight from `v_velocity`.
 * `est retro` stores these on the snapshot; this exists so a caller can ask the
 * question between retros without pretending the snapshot has moved.
 */
export function liveBootstrap(
  db: Database,
  bucket: string,
  refModel: string,
  estimand: string,
  resamples: number,
): { p50: { lo: number; hi: number } | null } {
  const rows = db
    .query<{ velocity_raw: number | null }, [string, string, string]>(
      "SELECT velocity_raw FROM v_velocity WHERE bucket = ? AND ref_model = ? AND estimand = ?",
    )
    .all(bucket, refModel, estimand);
  const samples: WeightedSample[] = rows
    .filter((r): r is { velocity_raw: number } => r.velocity_raw !== null && r.velocity_raw > 0)
    .map((r) => ({ value: r.velocity_raw, weight: 1 }));
  const ci = bootstrapQuantileCI(samples, 0.5, { resamples });
  return { p50: ci };
}

/** Re-export so the CLI can render a band without importing calibrate.ts directly. */
export { multipliers };

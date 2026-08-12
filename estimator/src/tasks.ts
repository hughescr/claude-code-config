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
import { ANCHOR_ID_KEY, ANCHOR_TEXT_KEY, getConfig } from "./db.ts";
import { InvariantError, UsageError } from "./errors.ts";
import { priceFamily } from "./prices.ts";
import { resolveEstimatorIdentity, type EstimatorIdentity } from "./identity.ts";
import {
  assertSameUnit,
  BandIdentity,
  isPointsEstimand,
  POINTS_ESTIMAND,
  storyPointAnchor,
  type AnchorFilter,
  type EstimateUnitColumns,
  type StoryPointAnchor,
  type UnitRefusalContext,
} from "./unit.ts";
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

/**
 * Defined in `src/errors.ts` and re-exported here, because `src/db.ts` and
 * `src/unit.ts` both throw them and both are imported BY this module. There is one
 * definition of each class, so `instanceof` in `src/cli.ts` is unaffected — see the
 * header of `src/errors.ts` for why the move was forced.
 */
export { InvariantError, UsageError } from "./errors.ts";

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
 *
 * **This is the one unit-ish lookup that is deliberately NOT a {@link BandIdentity}
 * query, and the reason is `refclass`'s key rather than an oversight.** `refclass` is
 * keyed `(as_of, bucket, estimator_family, ref_model, estimand)` — no anchor — so it has
 * nowhere to put a per-anchor snapshot, and asking for one here would silently return
 * nothing. The anchor is enforced against the SNAPSHOT instead, in `pointsToWcet`, by
 * counting the rows it was fitted from; that guard releases on its own the day `refclass`
 * carries `sp_anchor_id` in its key.
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
  /**
   * WHICH estimator family the snapshot behind these multipliers was fitted over, or
   * `null` when it is the pooled `'*'` row (or when there is no snapshot).
   *
   * Projected because a guard on the snapshot has to count the SAME rows the snapshot
   * was fitted from, and `newestRefclass` may legitimately answer with a family other
   * than the caller's. `foreignAnchorSamples` counting across every family was a
   * refusal for a reason that had nothing to do with the band being priced: one v1
   * sample from an unrelated model family suppressed a homogeneous ten-sample v2 rate.
   */
  snapshotFamily: string | null;
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
      snapshotFamily: null,
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
    // `'*'` is the POOLED row — it was fitted across families, so a guard on it must
    // count across families too. `null` means exactly that here.
    snapshotFamily: snap.estimator_family === "*" ? null : snap.estimator_family,
  };
}

/**
 * Comparable completed tasks in this bucket — the honest `bucket_n`.
 *
 * `anchor` is `"any"` for the unit-wide count every Work-CET caller has always wanted,
 * and `"this"` for the points bridge's question: how much completed work is denominated
 * the way THIS band is, down to the anchor. Which rows either answer admits is
 * {@link BandIdentity}'s to decide, not this function's — that is the whole point of
 * routing it through the identity rather than through four string parameters.
 */
export function liveBucketN(
  db: Database,
  identity: BandIdentity,
  bucket: string,
  anchor: AnchorFilter = "any",
): number {
  // `asOf: null` = no upper bound, and the asymmetry with the FITTED path is deliberate.
  // This is "how much comparable completed work exists NOW" — the cold-start denominator
  // — and bounding it by some snapshot's `as_of` would make a band opened today ignore
  // work that finished since the last retro: a refusal caused by the calendar rather than
  // by the corpus. The window belongs where a SNAPSHOT is being defended, and here there
  // is no snapshot.
  return identity.samples({ asOf: null, bucket }).count(db, anchor);
}

// ---------------------------------------------------------------------------
// story points (v15) — the RELATIVE estimand, and the bridge back to Work-CET
// ---------------------------------------------------------------------------

/**
 * The unit vocabulary moved to `src/unit.ts` in v18, where the identity value that
 * compares two units also lives, and is re-exported here so every existing importer
 * (`src/burn.ts`, `src/close.ts`, `scripts/nudge.ts`, the tests) is unaffected. There
 * is one definition of each name.
 */
export {
  ANCHOR_UNDEFINED_TEXT,
  BandIdentity,
  IDENTITY_COMPONENTS,
  isPointsEstimand,
  POINTS_ESTIMAND,
  storyPointAnchor,
  type EstimateUnitColumns,
  type IdentityComponent,
  type SampleScope,
  type StoryPointAnchor,
  type VelocitySample,
} from "./unit.ts";

/** Fallback ceiling when `config.sp_max_points` is missing or unreadable. */
export const DEFAULT_MAX_POINTS = 1000;

/** `config.sp_max_points`, or {@link DEFAULT_MAX_POINTS}. Always >= 1. */
export function maxPoints(db: Database): number {
  const raw = getConfig(db, "sp_max_points");
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : DEFAULT_MAX_POINTS;
}

/**
 * Reject a points quantile that is not a points quantile.
 *
 * The failure this exists for is exact and it is the likeliest way the cutover
 * corrupts the new corpus: an estimator that has not noticed the estimand moved types
 * `--raw-p50 2400000`, which is a plausible Work-CET number and an absurd number of
 * points. `estimate` is append-only, so the row could never be corrected — the whole
 * bucket's fitted rate would be dragged three orders of magnitude off by one row that
 * nobody could delete.
 *
 * Exit **1**, not 2: this is a malformed command line — a flag value outside the range
 * the active unit admits — and not an operation the system refuses to perform. Exit 2
 * stays reserved for the invariant refusals (P1.0), which must never be retried; this
 * one is fixed by retyping the number.
 */
export function assertPointsQuantile(db: Database, flag: string, value: number): void {
  const cap = maxPoints(db);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > cap) {
    throw new UsageError(
      `${flag} must be a whole number of story points in [1, ${cap}]; got ${value}. ` +
        `config.estimand is '${POINTS_ESTIMAND}', so this flag is a SIZE RELATIVE TO THE ANCHOR ` +
        `("${storyPointAnchor(db).text}" = 1 point) — not a token count. ` +
        (value > cap
          ? "A value this large is almost certainly a Work-CET figure typed under the wrong estimand; " +
            "`estimate` is append-only, so it is refused rather than stored. " +
            "Raise `est config set sp_max_points <n>` only if the work really is that many times the anchor."
          : "A band of zero points is not a size."),
    );
  }
}

/** What {@link pointsToWcet} knows about the points -> Work-CET conversion. */
export interface PointsRate {
  /** Work-CET per point, or `null` when there is no honest basis for one. */
  readonly rate: number | null;
  /** Where `rate` came from. `null` exactly when `rate` is null. */
  readonly source: "fitted" | "seed" | null;
  /**
   * Completed comparable tasks BEHIND the rate. Non-zero only for `"fitted"` — a seed
   * is a convention reasoned to, backed by no observations, and reporting a sample
   * size for it would be the exact overclaim the two sources exist to distinguish.
   */
  readonly n: number;
}

export interface PointsRateKey {
  readonly bucket: string;
  readonly estimatorFamily: string;
  readonly refModel: string;
  readonly estimand: string;
  /**
   * The ANCHOR the band being priced is denominated in — `estimate.sp_anchor_id` for a
   * band already on disk (v17). Part of the key, not decoration: a rate is Work-CET per
   * point OF SOME ANCHOR, so asking for one without saying which point is asking an
   * ill-formed question.
   *
   * OMIT it for a band being issued NOW: the answer is then the anchor in force, which
   * is the only anchor a band opened this instant can carry. Pass `null` explicitly for
   * a row whose `sp_anchor_id` is NULL (pre-v15); that is an unknown denomination and
   * gets no rate at all.
   */
  readonly anchorId?: string | null;
}

/**
 * The ONE bridge from a story-point band to Work-CET. Every consumer uses this.
 *
 * Two sources, in order, and never a third:
 *
 *  1. **`"fitted"`** — the normal path, and not a new calibrator. `velocity_raw` is
 *     already `actual_wcet_at_epoch / raw_p50` (src/close.ts), so the instant
 *     `raw_p50` is denominated in points that ratio IS Work-CET per point; the retro
 *     fits its decayed, shrunk median into `refclass.mult_p50` exactly as before, and
 *     this function reads that snapshot through {@link calibrationFor}. Which means
 *     the cold-start rule is inherited rather than reinvented: below
 *     {@link COLD_START_N} completed points tasks there is no fitted rate, for the
 *     same reason there is no multiplier.
 *  2. **`"seed"`** — the bootstrap, from `config.sp_seed_wcet_per_point`. Available
 *     only while (1) is not, and only when `config.sp_seed_anchor_id` matches the
 *     BAND's anchor: a rate per point of the v1 anchor says nothing about a point of
 *     the v2 anchor.
 *
 * **Both sources are gated on the anchor, and that symmetry is the v17 fix.** The seed
 * path has always checked it; the fitted path did not, so ten tasks fitted at ~2000
 * Work-CET/point under the v1 anchor kept being handed out — `source: "fitted"`,
 * `n: 10` — the moment `est config set sp_anchor_id v2` redefined what a point was. A
 * v2 estimate has to COLD-START, exactly as the first ten v1 estimates did, and
 * symmetrically a v1 band must not be rendered at a v2 rate. Two conditions now stand
 * between a `refclass` multiplier and a caller:
 *
 *  - at least {@link COLD_START_N} completed tasks at THIS band's anchor
 *    ({@link liveBucketN} with `"this"`) — the same threshold every other multiplier
 *    obeys, applied to the sample that is actually comparable; and
 *  - no foreign-anchor sample inside the snapshot's own row set — because `refclass` is
 *    not keyed on the anchor and a snapshot fitted across a bump is a median of two
 *    different units.
 *
 * **That second condition is scoped to the snapshot, not to the corpus (v18).** It counts
 * the rows the snapshot could actually have been fitted from: `cal.snapshotFamily`
 * (pooled `'*'` widens to every family) and `cal.refclassAsOf` as the window. Counting
 * across every family instead made an unrelated model's single v1 sample suppress a
 * homogeneous ten-sample v2 rate — a refusal justified by a row that was never in the
 * fit, which is a wrong refusal rather than a conservative one.
 *
 * The consequence of the remaining refusal is deliberate and worth stating: **an anchor
 * bump is a cold start for the whole bucket**, not just for bands issued after it, and it
 * stays one until `src/retro.ts` can fit a snapshot per anchor. That is the same trade the
 * rest of this file makes — a refused number rather than a wrong one — and the escape is
 * the one cold starts have always had: `est config set sp_seed_wcet_per_point <n>`
 * together with `est config set sp_seed_anchor_id <new anchor>`.
 *
 * Otherwise `{ rate: null, source: null }`. **A rate is never invented** — the caller's
 * obligation is to print no Work-CET figure at all, not to fall back to 1.0, because a
 * band of "8" rendered as 8 Work-CET is a number derived from nothing wearing the
 * units of a measurement.
 *
 * Returns `rate: null` for a non-points estimand too. Under `work_cet` the band is
 * already Work-CET and there is nothing to convert; a caller that got a number back
 * would double-apply the multipliers.
 */
export function pointsToWcet(db: Database, key: PointsRateKey): PointsRate {
  if (!isPointsEstimand(key.estimand)) return { rate: null, source: null, n: 0 };

  // Omitted means "a band being issued now", whose anchor can only be the one in force.
  // An explicit `null` is a stored row that records no anchor: an unknown denomination,
  // and there is no honest rate for one.
  const bandAnchor = key.anchorId === undefined ? storyPointAnchor(db).id : key.anchorId;
  if (bandAnchor === null) return { rate: null, source: null, n: 0 };

  // The band's OWN identity, not the ambient one: this may be pricing a v1 row while v2
  // is in force. Built once here and used for both the count and the guard, so the two
  // cannot drift apart the way `liveBucketN` and `foreignAnchorSamples` did.
  const identity = BandIdentity.ofEstimate(db, {
    ref_model: key.refModel,
    estimand: key.estimand,
    sp_anchor_id: bandAnchor,
  });

  const anchorN = liveBucketN(db, identity, key.bucket, "this");
  if (anchorN >= COLD_START_N) {
    const cal = calibrationFor(
      db,
      key.bucket,
      key.estimatorFamily,
      key.refModel,
      key.estimand,
      anchorN,
    );
    if (
      !cal.uncalibrated &&
      cal.multP50 > 0 &&
      Number.isFinite(cal.multP50) &&
      cal.refclassAsOf !== null &&
      identity
        .samples({
          asOf: cal.refclassAsOf,
          bucket: key.bucket,
          estimatorFamily: cal.snapshotFamily,
        })
        .count(db, "foreign") === 0
    ) {
      return { rate: cal.multP50, source: "fitted", n: cal.bucketN };
    }
  }

  const seedAnchor = getConfig(db, "sp_seed_anchor_id") ?? "";
  if (seedAnchor !== bandAnchor) return { rate: null, source: null, n: 0 };
  const raw = getConfig(db, "sp_seed_wcet_per_point") ?? "";
  if (raw.trim() === "") return { rate: null, source: null, n: 0 };
  const seed = Number(raw);
  if (!Number.isFinite(seed) || seed <= 0) return { rate: null, source: null, n: 0 };
  return { rate: seed, source: "seed", n: 0 };
}

/**
 * The columns needed to decide what unit an `estimate` row's numbers are in. Every
 * band-carrying row satisfies it: `close.ts`'s baseline, the board's estimate row,
 * `burn.ts`'s {@link BandUnitRow}, and the retro's scoring joins.
 */
export interface BandUnitColumns {
  readonly estimand: string;
  readonly raw_p50_wcet: number;
  readonly cal_p50_wcet: number;
  /**
   * `estimate.wcet_rate_src` (v19) — the STORED answer to "was a points -> Work-CET
   * conversion applied to `cal_*`". Required, and that is the load-bearing part of this
   * interface: a `SELECT estimand, raw_p50_wcet, cal_p50_wcet` no longer typechecks, so
   * a consumer cannot re-derive the answer from two numbers by accident.
   */
  readonly wcet_rate_src: string;
}

/** `estimate.wcet_rate_src`'s value set. See the schema.sql column comment. */
export type WcetRateSource = "n/a" | "fitted" | "seed" | "none" | "unrecorded";

/**
 * THE rule for whether `estimate.cal_p50_wcet` / `cal_p90_wcet` are Work-CET.
 *
 * **A stored fact since v19, and it had to become one.** The rule used to be an
 * inference over two columns — `cal_p50 !== raw_p50` was read as proof that a rate had
 * converted the band — justified on the grounds that it degrades to the honest side. It
 * does not, and the counter-example is not exotic: fit a rate under anchor v1, bump to
 * v2, and the FIRST v2 estimate reports `wcet_rate=null` (the anchor-aware bridge
 * correctly refuses) and then multiplies the band by the v1 snapshot's multiplier anyway
 * (the anchor-blind calibrator, which `est open` fell through to). `cal` differed from
 * `raw`, this predicate said "converted", and `est close` scored a `velocity_cal` and an
 * `in_band` off a rate the system had explicitly refused to issue. An inference over two
 * numbers cannot distinguish a conversion from a mistake; a recorded value can.
 *
 * So the row says which happened:
 *
 *  1. **Not `story_point`** — the band has always been absolute Work-CET. True, without
 *     reading anything else. (`'n/a'` is what the column stores for these rows; the
 *     estimand is checked first so a mislabelled column cannot override it.)
 *  2. **`'fitted'` / `'seed'`** — a rate was applied, `estimate.wcet_rate` names it.
 *  3. **`'none'`** — a points band for which no rate existed. `cal_* = raw_*`, still
 *     POINTS, unscorable. The refusal IS the stored value.
 *  4. **`'unrecorded'`** — issued before v19. The old inference is consulted here and
 *     ONLY here, because for those rows nothing better was ever written down. Rows the
 *     v18 defect mis-stamped are in this population and cannot be separated from it;
 *     that history is not repairable and is not pretended otherwise.
 */
export function bandInWcet(band: BandUnitColumns): boolean {
  if (!isPointsEstimand(band.estimand)) return true;
  if (band.wcet_rate_src === "fitted" || band.wcet_rate_src === "seed") return true;
  if (band.wcet_rate_src === "unrecorded") {
    // Pre-v19 only. A fitted `mult_p50` of exactly 1.0 reads as unconverted and so
    // returns false — the SAFE direction, and the same trade `bandUnit` documents: one
    // Work-CET per point is not a number this system can produce, and the cost of being
    // wrong is a refused score rather than a wrong one.
    return band.raw_p50_wcet > 0 && band.cal_p50_wcet !== band.raw_p50_wcet;
  }
  return false;
}

/**
 * The REFUSAL, and the reason this is one shared function rather than four copies.
 *
 * True when scoring a Work-CET actual against this band's `cal_*` would cross units:
 * the band is in story points and no conversion was applied at `est open`. Every
 * consumer that pinballs, log-scores, ratios or coverage-tests an actual against
 * `cal_p50_wcet` / `cal_p90_wcet` must consult this first and emit **NULL** when it
 * holds — never a converted number.
 *
 * Converting here instead would mean choosing between the rate pinned at issue time
 * (there is none — that is the state) and whatever rate exists today, which is a
 * modelling decision nobody has made; and the output would wear the units of a
 * measurement while being neither. NULL is a state the schema already admits
 * (`outcome.velocity_cal` and `outcome.in_band` are both nullable) and every consumer
 * already handles.
 *
 * Call sites: `close.ts` (`velocity_cal` / `in_band`), `retro.ts` `scorePanel` and
 * `blockPanel`, and `v_block_accuracy`'s SQL equivalent in `schema.sql`.
 */
export function bandUnscorable(band: BandUnitColumns): boolean {
  return !bandInWcet(band);
}

/**
 * Whether this estimate's BLOCK quantiles (`estimate_block.p50_wcet` / `p90_wcet`) are
 * Work-CET — a strictly stronger condition than {@link bandInWcet}, and deliberately a
 * second function rather than a reuse of it.
 *
 * `est block` stores what it was given, in the unit in force at the time, and nothing
 * ever converts an `estimate_block` row: `estimate_block` has no `cal_*` pair and its
 * append-only triggers mean it could not acquire one retroactively. So under
 * `story_point` the block side is points FOREVER, including for a task whose own band
 * a rate converted at `est open` — that conversion touched `estimate`, not the blocks
 * hanging off it. A roll-up pinballed against a Work-CET actual is therefore
 * cross-unit whenever the estimand is points, cold start or not.
 */
export function blocksInWcet(estimand: string): boolean {
  return !isPointsEstimand(estimand);
}

/**
 * The unit an existing `estimate` row is denominated in, with its eid — the answer both
 * write paths that hang a row off an estimate have to honour.
 *
 * `which` is the whole reason this is one function rather than two inline SELECTs:
 *
 *  - **`"baseline"`** (`MIN(eid)`) is what a RE-ESTIMATE must match. `est close` scores
 *    `MIN(eid)` and `v_velocity` joins on `eid_at_start`, so the baseline is what fixes
 *    the task's denomination for every measurement ever made of it.
 *  - **`"latest"`** (`MAX(eid)`) is what a BLOCK must match, because `addBlock` hangs the
 *    row off `MAX(eid)`.
 *
 * The SELECT names all three unit columns because {@link EstimateUnitColumns} requires
 * all three. That is the type doing the work: the version of this lookup that shipped
 * selected `estimand, sp_anchor_id` and silently let a `ref_model` flip through.
 */
export function recordedUnitOf(
  db: Database,
  tid: string,
  which: "baseline" | "latest",
): { eid: number; identity: BandIdentity } | null {
  const row = db
    .query<{ eid: number } & EstimateUnitColumns, [string]>(
      `SELECT eid, ref_model, estimand, sp_anchor_id FROM estimate WHERE tid = ?
        ORDER BY eid ${which === "baseline" ? "ASC" : "DESC"} LIMIT 1`,
    )
    .get(tid);
  if (row === null || row === undefined) return null;
  return { eid: row.eid, identity: BandIdentity.ofEstimate(db, row) };
}

/**
 * REFUSE to write a row into an estimate whose unit the ambient config no longer agrees
 * with (v17; whole-identity since v18).
 *
 * The rule and its justification live on {@link assertSameUnit} in `src/unit.ts`. This is
 * the two-argument convenience every caller in this file wants: resolve the ambient
 * identity, compare it to the recorded one, WHOLE.
 */
export function assertAmbientUnitMatches(
  db: Database,
  recorded: BandIdentity,
  ctx: UnitRefusalContext,
): void {
  assertSameUnit(recorded, BandIdentity.ambient(db), ctx);
}

// ---------------------------------------------------------------------------
// `est open`
// ---------------------------------------------------------------------------

export interface OpenInput {
  kind: TaskKind;
  subject: string;
  description?: string | null;
  dod?: DodItem[];
  /** Under `estimand = 'story_point'` these are POINTS; otherwise Work-CET. */
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
  /**
   * Take the raw band from the SUM of this task's block estimates instead of from
   * `rawP50`/`rawP90` (P1.2 promoted, v15). Requires `tid` — blocks hang off an
   * estimate, so there has to be one to roll up. See {@link blockRollup}.
   *
   * Because it requires `tid` it can only ever land as a RE-ESTIMATE, which is why it
   * is not how decomposed work should be opened: `est close` fits the baseline (and
   * `velocity_raw`, and therefore the points -> Work-CET rate) from `MIN(eid)`, so a
   * coarse opening guess followed by a `--from-blocks` refinement leaves the coarse
   * guess as both the scored baseline and the fitting sample. Sum the blocks yourself
   * and `est open` ONCE with that sum; use this flag when you genuinely re-sized the
   * phases mid-task.
   */
  fromBlocks?: boolean;
}

/**
 * The roll-up of a task's block estimates against its CURRENT estimate.
 *
 * For work big enough to be decomposed, the decomposition IS the estimate: summing
 * per-phase sizes is the thing agents do 1.96x-consistently, and a separate
 * whole-task number issued beside it is a second, worse guess that then disagrees with
 * its own parts. `est retro`'s block panel has always compared the task band against
 * `SUM(estimate_block.p50_wcet)`.
 *
 * Which is why the CANONICAL order puts the sum in the FIRST estimate: size the phases,
 * add them up, `est open` once with the total, then `est block` per phase to record the
 * decomposition for per-phase attribution. `est close` scores `MIN(eid)`
 * (`first-estimate-wins`, src/close.ts) and that rule is load-bearing — it is what makes
 * baseline accuracy a real measurement — so the band it scores has to be the decomposed
 * number from the outset. `--from-blocks` then means what a refinement should mean: the
 * phases were re-sized because something was learned.
 *
 * p90 is summed too, not root-sum-squared. Summing p90s assumes the phases overrun
 * together, which is pessimistic if they are independent — and they are not: the
 * things that blow a phase (the codebase is bigger than it looked, the approach was
 * wrong) blow the next one as well. It is also the only choice that stays honest under
 * calibration, since the multipliers are fitted to whatever rule produced the raw
 * band; a rule that varied per task would be unfittable.
 */
export function blockRollup(
  db: Database,
  tid: string,
): { p50: number; p90: number; blocks: number; eid: number } | null {
  const eid = db
    .query<{ eid: number | null }, [string]>("SELECT MAX(eid) AS eid FROM estimate WHERE tid = ?")
    .get(tid)?.eid ?? null;
  if (eid === null) return null;
  const agg = db
    .query<{ n: number; p50: number | null; p90: number | null }, [number]>(
      "SELECT COUNT(*) AS n, SUM(p50_wcet) AS p50, SUM(p90_wcet) AS p90 FROM estimate_block WHERE eid = ?",
    )
    .get(eid);
  if (agg === null || agg === undefined || agg.n === 0) return null;
  return { p50: agg.p50 ?? 0, p90: agg.p90 ?? 0, blocks: agg.n, eid };
}

export interface Band {
  /**
   * The calibrated band, in Work-CET — EXCEPT under `story_point` with no available
   * rate, where it is the raw points band unchanged (multipliers of 1.0, exactly as a
   * Work-CET cold start) and `wcetAvailable` is false. A renderer must not print these
   * as tokens without checking that flag.
   */
  p50: number;
  p90: number;
  /** Both ends or neither: an uncalibrated request band is the raw guess, labelled. */
  reqP50: number;
  reqP90: number;
  activeP50S: number | null;
  activeP90S: number | null;
  spendUsdP50: number | null;
  spendUsdP90: number | null;
  /**
   * False only under `story_point` when {@link pointsToWcet} found no rate. Then
   * `p50`/`p90` are still points, `spendUsd*` are null, and the honest output is to say
   * there is no Work-CET forecast — not to print one derived from nothing.
   */
  wcetAvailable: boolean;
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
  /**
   * The STORY-POINT anchor pinned onto this band, or null for a Work-CET band. Not to
   * be confused with `anchor` above, which is the session/prompt the estimate was
   * issued from — an unrelated, older use of the word that this field deliberately
   * does not shadow.
   */
  spAnchor: StoryPointAnchor | null;
  /**
   * `config.procedure_version` pinned onto this band (v17) — WHICH instruction produced
   * the raw quantiles. NULL only when the key is unset. Not a calibration key today; it
   * is recorded so a future retro can partition a pooled corpus by procedure vintage.
   */
  procedureVersion: string | null;
  /** The raw band restated as points, or null when the estimand is not `story_point`. */
  points: { p50: number; p90: number } | null;
  /** What the points -> Work-CET bridge had to offer. All-null for a Work-CET band. */
  wcetRate: PointsRate;
  /** Set when `--from-blocks` produced the raw band: how many blocks were summed. */
  rolledUpFromBlocks: number | null;
  /**
   * ADVISORY (v18): the `--from-blocks` roll-up summed blocks hanging off this task's
   * FIRST estimate, which is the "opened coarse, then decomposed" shape the canonical
   * order exists to replace. Null otherwise.
   *
   * Not an error and not a refusal — `est close` scores `MIN(eid)`, so a refinement was
   * never the measured band and this one is not either. It is recorded because the shape
   * says someone followed guidance that has since been withdrawn. Also written to
   * `anomaly(kind='from_blocks_on_baseline')`, which is what makes it visible in
   * `est census` without any renderer having to cooperate.
   */
  rollupNotice: string | null;
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
/**
 * A subject reduced to what two people would call "the same words": lowercased, with
 * every run of non-alphanumerics collapsed to one space and the ends trimmed.
 *
 * Deliberately much weaker than {@link subjectTokens} — it drops nothing. It exists for
 * the one case the token rule structurally cannot see: a subject made entirely of short
 * or common words tokenises to the empty set, so its overlap with anything (including an
 * identical copy of itself) is 0. Those are precisely the terse subjects a resubmission
 * repeats verbatim.
 */
export function normalizeSubject(subject: string): string {
  return subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

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
  const mineExact = normalizeSubject(subject);
  // An empty token set is NOT "nothing to compare": a terse subject ("fix it", "ship
  // the CI job") tokenises to nothing after the stopword and length filters, and those
  // are exactly the subjects a resubmission repeats VERBATIM. The exact-match arm below
  // is what covers them, so the early return is on having neither signal available.
  if (mine.size === 0 && mineExact === "") return [];
  return db
    .query<{ tid: string; subject: string; status: string }, [string]>(
      `SELECT t.tid AS tid, s.subject AS subject, t.status AS status
         FROM task t JOIN v_scope_current s ON s.tid = t.tid
        WHERE t.anchor_session = ?
          AND t.status IN ('estimating','in_progress','pending_verification')`,
    )
    .all(sessionId)
    .map((r) => ({
      ...r,
      // An identical normalized subject is 1.0 BY DEFINITION, whatever the tokeniser
      // makes of it. Two open tasks in one session with the same subject is the least
      // ambiguous form of the incident this warning exists for, and it was the one case
      // the token rule could not see.
      overlap:
        normalizeSubject(r.subject) === mineExact && mineExact !== ""
          ? 1
          : subjectOverlap(mine, subjectTokens(r.subject)),
    }))
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
  price_epoch, ref_model, estimand, estimator_model, sp_anchor_id, procedure_version,
  wcet_rate, wcet_rate_src
) VALUES (
  $tid, $version, $created_at, $reason, $scope_seq,
  $raw_p50, $raw_p90,
  $exp_agents, $exp_wf_phases, $exp_files_write, $exp_turns, $exp_requests,
  $bucket, $bucket_n, $refclass_as_of, $shrink_w,
  $cal_p50, $cal_p90, $cal_req_p50, $cal_req_p90,
  NULL, NULL, NULL,
  $price_epoch, $ref_model, $estimand, $estimator_model, $sp_anchor_id, $procedure_version,
  $wcet_rate, $wcet_rate_src
)
`;

/**
 * Idempotent alias write. The conflict target is the FULL primary key including
 * `tid` (schema v6), so "already written" means *this* task already holds *this*
 * identity — a re-run, a re-bind, the same task file resurfacing under ~189 resumed
 * session dirs. It deliberately does NOT swallow a `ux_alias_exclusive` violation:
 * a second task claiming one agent, run or Task-tool number is a real conflict and
 * must surface, not vanish into a DO NOTHING.
 *
 * EXPORTED (HOOK-BINDING-SPEC.md §4.1 step 3): `src/spool.ts`'s agent-binds drain is
 * a second writer of `source='hook'` rows, and it performs its OWN identity-wide
 * owner pre-check first (unlike `bindTask`'s session-scoped one, see that function's
 * doc comment) — so by the time it reaches this statement a conflict is structurally
 * impossible and `DO NOTHING` only ever fires on a genuine idempotent re-drain.
 */
export const UPSERT_ALIAS_SQL = `
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

  // The unit this band is being issued in, as ONE value. `refModel` / `estimand` /
  // `spAnchor` below are the same three facts spelled out for the report and the
  // messages; the row's columns are written from `unit` itself ({@link
  // BandIdentity.bindEstimate}), so what is stored and what is compared cannot diverge.
  const unit = BandIdentity.ambient(db);
  const refModel = getConfig(db, "ref_model") ?? "claude-sonnet-4-5";
  const estimand = getConfig(db, "estimand") ?? "work_cet";
  const points = isPointsEstimand(estimand);
  const spAnchor = points ? storyPointAnchor(db) : null;
  const priceEpoch = currentPriceEpoch(db, now);
  // The instruction that produced the numbers below, snapshotted exactly as the anchor
  // is (v17). Empty reads as unset and stores NULL: "no procedure recorded" is a state
  // the column already has to represent for every pre-v17 row, and inventing a vintage
  // for a band whose vintage nobody stated would defeat the whole column.
  const procedureRaw = (getConfig(db, "procedure_version") ?? "").trim();
  const procedureVersion = procedureRaw === "" ? null : procedureRaw;

  // v19: a points band whose anchor has NO recorded definition is refused, before
  // anything is minted or written.
  //
  // `est config set sp_anchor_id v2` deliberately points at an id nobody has defined yet
  // — the id-then-text order is the supported one — and `est config set sp_anchor_text
  // "…"` closes the gap. But nothing stood in the gap: a band could be issued against
  // `v2`, stamped `sp_anchor_id = 'v2'`, and the definition of what its points MEANT
  // could then be supplied afterwards, chosen with the band already on disk. `estimate`
  // is append-only, so the band cannot be corrected; the registry is append-only, so the
  // retroactive definition cannot be corrected either. "8 points against a scale that
  // did not exist yet" is not a size, and the whole argument for pinning `sp_anchor_id`
  // onto every band was that a points value without its anchor means nothing.
  //
  // Scoped to the BAND being issued, which is always denominated in the ambient anchor:
  // a re-estimate is held to its baseline's unit by `assertAmbientUnitMatches` above, so
  // ambient and recorded agree by the time control reaches here. An UNVERIFIED
  // definition (the v18 migration's reading of the config pair) passes — it is a
  // definition, recorded, and holding work hostage to a confirmation would be a wrong
  // refusal in place of a wrong number.
  if (spAnchor !== null && !spAnchor.defined) {
    throw new InvariantError(
      `story-point anchor '${spAnchor.id}' has no recorded definition, so a band sized against it is not a size: ` +
        "`estimate` is append-only, so the row could never be corrected, and defining the anchor after the band " +
        "is issued chooses what those points meant with the number already committed",
      `state the definition first: \`est config set ${ANCHOR_TEXT_KEY} "<what one point is>"\` ` +
        `(or \`est anchor define ${spAnchor.id} "<what one point is>"\`). ` +
        `\`est config set ${ANCHOR_ID_KEY} <id>\` deliberately leaves the new id undefined until you do — ` +
        "that gap is the id-then-text order working, not a bug, and this is the guard that keeps a band out of it",
    );
  }

  // A RE-ESTIMATE inherits its task's unit; it does not get to restate it from ambient
  // config (v17). Checked FIRST — before the roll-up, before the band bounds, before the
  // task is even resolved — because every path below reads numbers whose meaning depends
  // on the answer: `--continue` copies the previous band's raw quantiles verbatim and
  // re-issues them, and `--from-blocks` sums block rows stored in the parent's unit.
  // Both would otherwise relabel those numbers into whatever `config.estimand` says
  // today, which at cutover is a different unit entirely.
  //
  // The BASELINE (`MIN(eid)`) is what is honoured, not the newest estimate: `est close`
  // scores `MIN(eid)` and `v_velocity` joins on `eid_at_start`, so the baseline is what
  // fixes the task's denomination for every measurement made of it.
  if (input.tid !== null && input.tid !== undefined) {
    const baseline = recordedUnitOf(db, input.tid, "baseline");
    // An unknown tid is not this guard's refusal to make: the resolution below says so
    // with the remedy that fits.
    if (baseline !== null) {
      assertAmbientUnitMatches(db, baseline.identity, {
        what: `task ${input.tid}'s baseline estimate (eid=${baseline.eid})`,
        verb: "est open --tid",
      });
    }
  }

  // `--from-blocks`: the band IS the decomposition. Resolved before every band check
  // below, so a rolled-up band is validated exactly as a typed one is.
  let rawP50 = input.rawP50;
  let rawP90 = input.rawP90;
  let rolledUpFromBlocks: number | null = null;
  let rollupNotice: string | null = null;
  if (input.fromBlocks === true) {
    if (input.tid === null || input.tid === undefined) {
      throw new UsageError(
        "--from-blocks requires --tid: block estimates hang off an estimate, so there has to be one to roll up. " +
          "It is a REFINEMENT lever — for when you have re-sized the phases mid-task — not the way to open. " +
          "The canonical order is: size each phase, SUM them yourself, `est open` ONCE with that sum, then " +
          "`est block` per phase for per-phase attribution. `est close` scores the FIRST estimate, so opening " +
          "with a coarse whole-task guess and rolling up afterwards leaves the coarse guess as the baseline.",
      );
    }
    const rollup = blockRollup(db, input.tid);
    if (rollup === null) {
      throw new UsageError(
        `--from-blocks: tid ${input.tid} has no block estimates to roll up; run \`est block ${input.tid} --phase <i> --title … --p50 … --p90 …\` first`,
      );
    }
    // A NOTICE, not a refusal, and the v17 guard that stood here is deleted rather than
    // repaired (v18). It rejected when `rollup.eid === MIN(eid)`, and it was wrong in
    // BOTH directions:
    //
    //  - it fired on a legitimately newly-discovered phase blocked onto the first
    //    estimate, which is a real refinement and the one shape `--from-blocks` is FOR;
    //  - and it missed the shape it was written for. An ordinary `est open --continue`
    //    creates eid2, so a task's first-ever blocks attach to `MAX(eid)` = eid2, sail
    //    past a `MAX != MIN` test, and `est close` still scores the coarse eid1 baseline.
    //
    // The premise was mistaken too. `--from-blocks` requires `--tid`, so it can only ever
    // land as a REFINEMENT, and a refinement is by design never the scored baseline —
    // `est close` fits from `MIN(eid)` and that is deliberate ("first-estimate-wins" is
    // what makes baseline accuracy a real measurement). A roll-up landing as a refinement
    // was therefore never going to be the baseline and was never supposed to be. The
    // actual defect was the CLI ADVERTISING open-coarse-then-roll-up as the way to
    // decompose, and that was fixed where it belonged: in the guidance.
    //
    // What survives is the observation itself, because blocks sitting on `MIN(eid)` does
    // indicate someone followed the old advice — recorded as an anomaly (visible in
    // `est census`) and returned on {@link OpenResult.rollupNotice}. Nothing about the
    // band, the write or the exit code depends on it.
    const baselineEid =
      db
        .query<{ eid: number | null }, [string]>("SELECT MIN(eid) AS eid FROM estimate WHERE tid = ?")
        .get(input.tid)?.eid ?? null;
    if (rollup.eid === baselineEid) {
      rollupNotice =
        `--from-blocks rolled up ${rollup.blocks} block(s) hanging off this task's FIRST estimate (eid=${rollup.eid}). ` +
        "`est close` scores the first estimate, so this refinement's " +
        `${rollup.p50}/${rollup.p90} sum is recorded but is not the band accuracy is measured against. ` +
        "The canonical order is: size each phase, SUM them yourself, `est open` ONCE with that sum, then `est block` per phase.";
    }
    rawP50 = rollup.p50;
    rawP90 = rollup.p90;
    rolledUpFromBlocks = rollup.blocks;
  }

  // Before anything is resolved, minted or written: an inverted band is not an
  // uncertainty band. `estimate` is append-only (est_ro_u / est_ro_d), so a row
  // whose p90 sits below its p50 could never be corrected in place — it would sit
  // in the corpus forever, scored against an actual by a coverage check that reads
  // p90 as the upper edge. The only guards here used to be `Math.max(0, …)`.
  if (rawP90 < rawP50) {
    throw new UsageError(
      `--raw-p90 (${rawP90}) must be >= --raw-p50 (${rawP50}): a p90 below the p50 is not an uncertainty band, ` +
        "and `estimate` is append-only, so the row could never be corrected",
    );
  }

  // The unit sanity bound (v15). Only under `story_point`, because only there is the
  // magnitude of the number itself evidence about which unit the estimator was in.
  if (points) {
    assertPointsQuantile(db, "--raw-p50", Math.round(rawP50));
    assertPointsQuantile(db, "--raw-p90", Math.round(rawP90));
  }

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
        // The remedy names the exact command, because since 2026-07-30 the SWEEPER can
        // be what closed it — `abandoned` after a week of silence, with nobody present
        // to remember doing it. Someone resuming that work meets this refusal with no
        // idea why the task is closed, and the road back has to be signposted rather
        // than inferred: until the reopen lands, the resumed work attributes to nothing.
        `run \`est close ${tid} --status reopened\` first — that APPENDS a new outcome revision (nothing is edited or lost) and re-opens the task's attribution window, so the resumed work is metered. ` +
          `If the sweeper closed it as abandoned after a week of silence, this is exactly the intended way back; \`est census\` shows the anomaly(swept_abandon) row that recorded it`,
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
  const liveN = liveBucketN(db, unit, bucket);
  const cal = calibrationFor(db, bucket, estFamily, refModel, estimand, liveN);

  // The points -> Work-CET bridge, resolved once and used by everything below.
  //
  // Under `work_cet` this is all-null and NOTHING changes: `cal.multP50` has always
  // been the ratio that turns a raw band into a calibrated one, and it still is.
  //
  // Under `story_point` the SAME multiplier is already the rate — `velocity_raw` is
  // `actual_wcet / raw_p50`, so with `raw_p50` in points its shrunk median is
  // Work-CET per point — which is why the fitted path needs no new arithmetic at all:
  // `raw * multP50` is exactly "points times Work-CET-per-point". The one addition is
  // the SEED: when the bucket is too cold for a fitted rate but a bootstrapped one
  // exists, it stands in for both multipliers rather than letting the 1.0 cold-start
  // identity silently emit a points number labelled Work-CET.
  const wcetRate = pointsToWcet(db, {
    bucket,
    estimatorFamily: estFamily,
    refModel,
    estimand,
  });
  const seeded = wcetRate.source === "seed" && wcetRate.rate !== null;
  // False ONLY under story points with no rate from either source. Then the two
  // numbers below are the raw points, unconverted, and every renderer must say so
  // instead of printing them as tokens.
  const wcetAvailable = !points || wcetRate.rate !== null;
  // THE REFUSAL, made structural (v19). `pointsToWcet` is anchor-aware and `cal` is
  // not: `calibrationFor` matches on (bucket, family, ref_model, estimand) and has no
  // anchor leg, so on the FIRST band under a new anchor the bridge correctly returns no
  // rate and `cal.multP50` is still the PREVIOUS anchor's fitted multiplier. Falling
  // through to it — which this code did — stored a converted-looking `cal_*` pair and
  // the old snapshot's `refclass_as_of` / `shrink_w` / `bucket_n` beneath a band whose
  // rate the system had just refused, and every scoring surface then read `cal != raw`
  // as licence to score it.
  //
  // So the refusal is written down instead of being left to be inferred: multipliers of
  // exactly 1.0 (`cal = raw`, the band stays POINTS), NO refclass provenance — which is
  // the cold-start state `refclass_as_of IS NULL` / `shrink_w = 0` already means
  // everywhere else — and `wcet_rate_src = 'none'` on the row, which is what
  // {@link bandInWcet} reads and what makes the row unscorable without inferring
  // anything.
  const rateRefused = points && wcetRate.rate === null;
  const multP50 = rateRefused ? 1 : seeded ? wcetRate.rate! : cal.multP50;
  // The seed is a single rate, not a distribution, so it converts BOTH ends: the band
  // width then comes from the estimator's own points spread, unwidened. That is the
  // honest reading of a bootstrap — it says how big a point is, and nothing about how
  // wrong estimators are — and the `source: "seed"` label is what stops it being read
  // as a calibrated envelope.
  const multP90 = rateRefused ? 1 : seeded ? wcetRate.rate! : cal.multP90;
  // What the ROW records about the conversion. `wcetRateApplied` is non-null exactly
  // when `wcetRateSrc` is 'fitted' or 'seed', which is the invariant `bandInWcet` and
  // `bandUnit` both lean on.
  const wcetRateSrc: WcetRateSource = !points
    ? "n/a"
    : rateRefused
      ? "none"
      : seeded
        ? "seed"
        : "fitted";
  const wcetRateApplied = points && !rateRefused ? multP50 : null;

  const calP50 = Math.max(0, Math.round(rawP50 * multP50));
  const calP90 = Math.max(0, Math.round(rawP90 * multP90));
  // The request band is calibrated exactly like the WCET band, including when there
  // is no reference class: `calibrationFor` returns multipliers of 1.0 for a cold
  // start, so both ends are then the raw guess and the `uncalibrated` flag carries
  // the caveat. It used to write the raw guess into p50 and NULL into p90, which
  // handed P1.9's `requests: {n, p50, p90}` contract a half-populated band — an
  // asymmetry no consumer could render and the WCET band never had.
  //
  // NOT under story points, though. `expRequests` is an absolute count of API calls in
  // any estimand, but under `story_point` the multiplier it was being scaled by has
  // become Work-CET-PER-POINT — a number in the tens of thousands — so applying it
  // here would turn "about 5 requests" into a forecast of 75,000. The request band is
  // therefore the raw driver, unscaled, until a request-specific calibration exists.
  const reqMult50 = points ? 1 : cal.multP50;
  const reqMult90 = points ? 1 : cal.multP90;
  const calReqP50 = Math.max(0, Math.round(input.expRequests * reqMult50));
  const calReqP90 = Math.max(0, Math.round(input.expRequests * reqMult90));

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

    const estimateParams: Record<string, unknown> = {
      $tid: tid,
      $version: version,
      $created_at: ts,
      $reason: reason,
      $scope_seq: scopeSeq,
      $raw_p50: Math.max(0, Math.round(rawP50)),
      $raw_p90: Math.max(0, Math.round(rawP90)),
      $exp_agents: input.expAgents,
      $exp_wf_phases: input.expWfPhases,
      $exp_files_write: input.expFilesWrite,
      $exp_turns: input.expTurns,
      $exp_requests: input.expRequests,
      $bucket: cal.bucket,
      // NO refclass provenance when the rate was refused (v19). `cal.*` here belongs to a
      // snapshot fitted at some OTHER anchor — that is precisely why the bridge refused
      // it — so recording its `as_of`, its shrinkage and its sample count under this band
      // would be attributing a number to a reference class that did not produce it, and
      // `est burn` reads `refclass_as_of IS NULL` as "seed, not fitted". NULL / 0 is the
      // cold-start state every other uncalibrated band already carries, and it is what
      // this one is. `bucket_n` becomes the honest count at THIS band's own anchor.
      $bucket_n: rateRefused ? liveBucketN(db, unit, bucket, "this") : cal.bucketN,
      $refclass_as_of: rateRefused ? null : cal.refclassAsOf,
      $shrink_w: rateRefused ? 0 : cal.shrinkW,
      $cal_p50: calP50,
      $cal_p90: calP90,
      $cal_req_p50: calReqP50,
      $cal_req_p90: calReqP90,
      $price_epoch: priceEpoch,
      $estimator_model: estModel,
      // Pinned for EVERY estimand, unlike the anchor: the procedure that produced a
      // Work-CET band is exactly as much a part of what that band means as the procedure
      // behind a points band. NULL only when nobody has stated one.
      $procedure_version: procedureVersion,
      // v19: whether a conversion happened, and at what rate — the STORED fact that
      // replaced `cal != raw`. See {@link bandInWcet}.
      $wcet_rate: wcetRateApplied,
      $wcet_rate_src: wcetRateSrc,
    };
    // `$ref_model`, `$estimand` and `$sp_anchor_id` come from the identity rather than
    // from three separate locals, so the row is stamped with exactly the value the
    // comparison will later read. `sp_anchor_id` is NULL for a Work-CET band because
    // `BandIdentity.ambient` carries no anchor for one: no anchor was involved, and
    // writing the current one anyway would claim a denomination this row does not have.
    unit.bindEstimate(estimateParams);
    db.query(INSERT_ESTIMATE_SQL).run(estimateParams as never);

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

    // Inside the same transaction as the estimate it describes: an advisory that
    // outlived a rolled-back write would point at a band that does not exist.
    if (rollupNotice !== null) writeAnomaly(db, ts, "from_blocks_on_baseline", rollupNotice, tid);
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
    raw: { p50: Math.round(rawP50), p90: Math.round(rawP90) },
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
      // Spend-CET is a price applied to a TOKEN count. With no rate, calP50/calP90 are
      // points, and pricing them would produce a confident dollar figure for a quantity
      // that is not money-shaped at all — the exact "token figure derived from nothing"
      // this estimand switch exists to stop.
      spendUsdP50: wcetAvailable ? spendForecast(db, calP50, refModel, priceEpoch) : null,
      spendUsdP90: wcetAvailable ? spendForecast(db, calP90, refModel, priceEpoch) : null,
      wcetAvailable,
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
    spAnchor,
    procedureVersion,
    points: points ? { p50: Math.round(rawP50), p90: Math.round(rawP90) } : null,
    wcetRate,
    rolledUpFromBlocks,
    rollupNotice,
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
  /** The unit these block quantiles are in — `estimand` as of this call. */
  estimand: string;
  /** The story-point anchor in force, or null under a Work-CET estimand. */
  spAnchor: StoryPointAnchor | null;
  /**
   * The sum of this estimate's blocks so far. Shown after every block so the total is
   * visible while it is being built — under the canonical order it should converge on
   * the band `est open` was already given, and a divergence is the signal to re-estimate
   * deliberately rather than something to commit silently.
   */
  rollup: { p50: number; p90: number; blocks: number };
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
  // A block is denominated in whatever the task band is denominated in — it rolls UP
  // into it — so it takes the same unit and the same sanity bound (v15). The unit comes
  // FROM THAT BAND, not from ambient config (v17), and the parent row is therefore
  // fetched before anything is validated rather than after.
  //
  // The bug this replaces fires at CUTOVER and only at cutover, which is why it was
  // invisible: `est block` read `config.estimand` for its validation and its label, and
  // `estimate_block` stores neither unit nor anchor, so a task opened in Work-CET and
  // blocked after `est config set estimand story_point` accepted an 8/13-POINT block
  // under a Work-CET parent — and `v_block_accuracy` (schema.sql), which reads the unit
  // off `estimate.estimand`, then treated it as scorable Work-CET. The shared guard
  // could not see the mismatch because nothing on the block row recorded one.
  const parent = recordedUnitOf(db, input.tid, "latest");
  if (parent === null) {
    throw new InvariantError(
      `tid ${input.tid} has no estimate to block against`,
      "run `est open` first — block estimates roll up to a task band, they never replace one",
    );
  }
  const eid = parent.eid;
  assertAmbientUnitMatches(db, parent.identity, {
    what: `estimate eid=${eid} (tid ${input.tid})`,
    verb: "est block",
  });
  // Only reachable once the identities agree WHOLE, so reading the estimand back off
  // config here is not a second source of truth — it is the same one, checked.
  const estimand = getConfig(db, "estimand") ?? "work_cet";
  const points = isPointsEstimand(estimand);
  const spAnchor = points ? storyPointAnchor(db) : null;
  if (points) {
    assertPointsQuantile(db, "--p50", Math.round(input.p50));
    assertPointsQuantile(db, "--p90", Math.round(input.p90));
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
  const rollup = blockRollup(db, input.tid);

  return {
    tid: input.tid,
    eid,
    phaseIdx: input.phaseIdx,
    title: input.title,
    p50: Math.round(input.p50),
    p90: Math.round(input.p90),
    declaredPhases,
    blocksSoFar,
    estimand,
    spAnchor,
    rollup: { p50: rollup?.p50 ?? 0, p90: rollup?.p90 ?? 0, blocks: rollup?.blocks ?? blocksSoFar },
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
   * Under `story_point`, the anchor the estimator is being asked to size against —
   * step 1 of the ceremony is where "1 point = this" has to be on screen, or the
   * number typed at step 7 is relative to nothing. Null under a Work-CET estimand.
   */
  sp_anchor: StoryPointAnchor | null;
  /**
   * What a points band would be converted at, if anything. Shown here because the
   * honest answer at cold start is "there is no rate yet", and an estimator should
   * learn that BEFORE it commits a number rather than from the absence of a line in
   * the output afterwards. All-null under a Work-CET estimand.
   */
  wcet_rate: PointsRate;
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
  // v19: the ANCHOR is part of the filter under points, and its absence is defect 3.
  //
  // Every column in this projection is denominated in the anchor the band was issued
  // against: `raw_p50` is a number of points OF SOME ANCHOR, and `velocity` is
  // `actual_wcet / raw_p50`, i.e. Work-CET PER POINT of that anchor. Without this clause
  // `est refclass` listed v1 rows — "raw p50 (pts) 8, velocity 2000×" — under a header
  // reading `anchor v2`, in the one output the ceremony requires an agent to read BEFORE
  // stating any number. A v1 point and a v2 point are different sizes by construction;
  // that is what bumping the id means.
  //
  // `IS ?` rather than `= ?`, matching `SampleScopeImpl.where`: the parameter is NULL for
  // a Work-CET band and SQLite's `=` never matches NULL. Not applied at all outside
  // points, where `sp_anchor_id` is NULL on every row and carries no meaning.
  if (isPointsEstimand(estimand)) {
    sql += " AND e.sp_anchor_id IS ?";
    baseParams.push(storyPointAnchor(db).id);
  }
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
  const points = isPointsEstimand(estimand);
  const ambient = BandIdentity.ambient(db);
  // Anchor-aware under points, for the same reason the match filter above is: `n` is the
  // size of the reference class the multiplier beside it speaks for, and pooling two
  // anchors' completed work into one count is the same category error as pooling their
  // points.
  const liveN = liveBucketN(db, ambient, bucket, points ? "this" : "any");
  // `refclass` is not keyed on the anchor (`(as_of, bucket, estimator_family, ref_model,
  // estimand)`), so `snap.n` is a count across every anchor in the unit and cannot stand
  // in for the anchor-local one. Under points the live count is the only honest answer.
  const n = points ? liveN : (snap?.n ?? liveN);
  // v19, defect 3: under points the multiplier IS the Work-CET-per-point rate, so it is
  // shown only when `pointsToWcet` — the anchor-aware bridge `est open` will consult a
  // moment later, with this same anchor — is willing to hand that rate out. Before this,
  // the two lines were computed by different rules and printed side by side: `est
  // refclass` under `anchor v2` rendered `points→Work-CET: NO RATE YET` and, three lines
  // down, `×2000.00 p50 · snapshot <as_of>` off the v1 snapshot. That is one anchor's
  // number beside another anchor's label, in the output the ceremony mandates an agent
  // read BEFORE stating any figure — so the stale multiplier anchors the estimate
  // directly, which is exactly how a refused rate still moves a number.
  //
  // The SMALLER of the two available fixes, chosen deliberately over adding the anchor to
  // `refclass`'s primary key. Re-keying the snapshot would change what `est retro` FITS,
  // not merely what this verb renders: the retro deliberately fits across every anchor in
  // the unit (see `AnchorFilter`'s `"any"`), and a per-anchor key makes every anchor bump
  // empty its own reference class on day one. That is a calibration-model decision, not a
  // rendering fix, and it is not this change's to make. Suppression makes `est refclass`
  // agree with `est open` — which is the property that was missing — and leaves the
  // snapshot exactly where the retro put it.
  const rateForAnchor = pointsToWcet(db, {
    bucket,
    estimatorFamily: estFamily,
    refModel,
    estimand,
  });
  const multiplierSuppressed = points && rateForAnchor.source !== "fitted";
  const uncalibrated = snap === null || n < COLD_START_N || multiplierSuppressed;

  const bucketLine: RefclassBucketLine = {
    bucket,
    n,
    // Suppressed with the multiplier it describes: `n_eff` is the decayed sample count
    // BEHIND that multiplier, so leaving it standing beside a withheld number would print
    // the weight of a fit whose result is not shown.
    n_eff: uncalibrated ? null : (snap?.n_eff ?? null),
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
    // Anchor-scoped under points, exactly like the match list and `n` above. The actuals
    // themselves are Work-CET whatever the anchor, but this distribution is offered as
    // "what work in THIS reference class has cost", and a reference class that spans an
    // anchor bump is two classes.
    const coldParams: Array<string | null> = [refModel, estimand];
    let coldSql = `SELECT COALESCE(o.actual_wcet_at_epoch, o.actual_wcet) AS w
           FROM v_outcome_current o JOIN estimate e ON e.eid = o.eid_at_start
          WHERE o.final_status = 'completed' AND e.ref_model = ? AND e.estimand = ?`;
    if (points) {
      coldSql += " AND e.sp_anchor_id IS ?";
      coldParams.push(storyPointAnchor(db).id);
    }
    const actuals = db
      .query<{ w: number }, Array<string | null>>(coldSql)
      .all(...coldParams)
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
    sp_anchor: points ? storyPointAnchor(db) : null,
    // The SAME resolution the bucket line above is suppressed by, not a second call: one
    // answer to "is there a rate for this anchor", rendered twice, so the two lines
    // cannot disagree the way they did.
    wcet_rate: rateForAnchor,
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

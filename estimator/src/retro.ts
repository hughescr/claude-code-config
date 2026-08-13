/**
 * src/retro.ts — `est retro` and `est board` (P1.8).
 *
 * `est retro` is the step that makes the ceremony non-inert. Without the write-back
 * into `refclass` the whole protocol is theatre: estimates get recorded, actuals get
 * computed, and nothing ever changes the next band. So this file does two things,
 * and the second is the point:
 *
 *  1. compute the §7.4 panel — loss, coverage with its Jeffreys interval, bias vs
 *     noise separately, raw vs calibrated velocity separately, block-vs-task
 *     accuracy, refinement skill, origin decomposition, and the data-quality panel;
 *  2. **write back** one `refclass` snapshot per `(bucket, estimator_family)` plus one
 *     `calib_run` row, so the next `est open` issues a band a measurement produced.
 *
 * Two rules govern every number in here, and both were silently violable before:
 *
 *  - **Like units only.** Everything groups by `(ref_model, estimand)`. A velocity
 *    ratio built from two denominations is a category error, not an outlier, and
 *    `est config set ref_model` is a one-line change that redenominates everything
 *    issued afterwards (§4.2 delta 3).
 *  - **Task effort only.** Calibration consumes `wcet_task_effort` (main + sub) and
 *    `actual_wcet_at_epoch`. `auxiliary` spend is real money with no relationship to
 *    task size and no way to anticipate it at `est open`; folding it in teaches the
 *    multipliers a bias no estimate could ever have matched (§4.6, §4.4).
 *
 * **Attribution coverage is the HEADLINE of the panel, not a line in it**, until the
 * live G-ATTR re-gate clears 70% — it is the number that licenses calibration at all.
 */

import type { Database } from "bun:sqlite";
import {
  bootstrapQuantileCI,
  decayWeight,
  hashSeed,
  jeffreysInterval,
  logScore,
  logVelocityStats,
  meanOf,
  mulberry32,
  multipliers,
  pinball,
  shrinkWeight,
  type WeightedSample,
} from "./calibrate.ts";
import { getConfig } from "./db.ts";
// The one rule for reading a band's unit (v15 story points) lives with the statusline
// contract, and the board reads it rather than owning a second copy: `est burn` and a
// board card that disagreed about whether a band is Work-CET would be the same defect
// on two screens. No cycle — src/burn.ts does not import this file.
import { bandUnit, type BandPoints, type BandUnit } from "./burn.ts";
import {
  bandUnscorable,
  blocksInWcet,
  COLD_START_N,
  InvariantError,
  isoNow,
  pointsToWcet,
  type PointsRate,
  type PointsRateKey,
} from "./tasks.ts";
import { BandIdentity, type VelocitySample } from "./unit.ts";
import { priceFamily } from "./prices.ts";
import { scoreEtaModels, writeEtaRuns, type EtaScore } from "./eta.ts";
import { JOBS_ROOT, jobsRetroPanel, type JobsPanelRow } from "./jobs.ts";

/** The G-ATTR bar. Below this, the historical corpus is not calibration-grade. */
export const ATTR_COVERAGE_GATE = 0.7;

/** Classes counted as attributed for calibration purposes (design/GATE-LIVE-SEMANTICS.md
 *  D3). `sticky` has no writer in `src/attribute.ts` today (D1's rewrite rationale) and
 *  is carried here only so a future writer does not have to touch this predicate too. */
export const ATTR_COVERAGE_CLASSES = ["exclusive", "sticky"] as const;

/** The live "which sessions are tracked" predicate — `attrBaseFilter`'s default, and
 *  `gates/g-attr.ts`'s L1 tracked-session cut. Exported so a caller that must pin this
 *  set to a snapshot taken BEFORE a mutating recompute (see `attrBaseFilter`'s `opts`
 *  below) can quote the same subquery shape rather than hand-copying it. */
export const LIVE_TRACKED_SESSIONS_SQL =
  "SELECT DISTINCT session_id FROM task_alias WHERE session_id <> ''";

/**
 * D3 (design/GATE-LIVE-SEMANTICS.md) — the base population the live G-ATTR headline
 * and this file's coverage numbers must share, so the number that licenses
 * calibration is defined once. Two definitions of it is the July failure (a
 * `sticky`-inclusive number nobody's code ever computed) repeating itself in a new
 * column.
 *
 * Returned as `{sql, params}` — a WHERE-clause fragment over `v_wcet` — rather than
 * executed here, because the gate runs it against database copies (the `source='hook'`
 * shadow, the staleness sensitivity grid) this file never opens. `until` is exclusive,
 * matching half-open epoch windows (`[cutover, hook-merge)`, `[hook-merge, now]`).
 *
 * `opts.trackedSessionsSql` overrides the tracked-session subquery (default
 * `LIVE_TRACKED_SESSIONS_SQL`, read fresh off `task_alias` in whatever DB this SQL runs
 * against). GLS D9's ex-hook counterfactual needs this: it deletes `source='hook'`
 * rows and re-attributes on a throwaway copy, and a session whose ONLY alias was that
 * hook binding must stay IN the denominator as now-uncovered spend, not fall out of it
 * along with the row that used to name it — the population may only be fixed BEFORE the
 * delete, or the shadow run answers a smaller question than the live one and the
 * subtraction between them is meaningless. Callers computing a live-only number should
 * omit `opts` and get the default.
 */
export function attrBaseFilter(
  w: { since: string; until?: string },
  opts: { trackedSessionsSql?: string } = {},
): {
  sql: string;
  params: string[];
} {
  const trackedSessionsSql = opts.trackedSessionsSql ?? LIVE_TRACKED_SESSIONS_SQL;
  const params: string[] = [w.since];
  let sql = `ts >= ?
    AND origin IN ('main','subagent')
    AND attr <> 'replay'
    AND attr <> 'overhead'
    AND session_id IN (${trackedSessionsSql})`;
  if (w.until !== undefined) {
    sql += ` AND ts < ?`;
    params.push(w.until);
  }
  return { sql, params };
}

/**
 * The decomposition mandate's threshold, in STORY POINTS — the "~40" that
 * `skills/estimating/SKILL.md` and `CLAUDE.md` state as a rule.
 *
 * Deliberately a constant here and NOT a `config` key. §1.1 puts every tunable in
 * `config`, but this is not a tunable: it is the *observed* threshold in an
 * instrument that exists to tell Craig whether the prose rule is being followed. A
 * config key would let the measurement be moved to meet the corpus, which is the
 * failure mode the whole retro is built against; and unlike `sp_max_points` (a REFUSAL
 * bound, which has to be raisable) nothing is refused on the strength of this number.
 * If the rule's threshold changes, the rule and this constant move together in one
 * commit — which is exactly the coupling that keeps them from drifting apart.
 */
export const DECOMPOSITION_POINTS = 40;

export interface BucketFit {
  bucket: string;
  estimator_family: string;
  ref_model: string;
  estimand: string;
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
  method: "plugin" | "bootstrap";
  /** Median velocity in LINEAR space — the "your p50 runs 2.9x low" number. */
  median_velocity: number;
}

export interface ScoringPanel {
  /**
   * Outcomes that entered the `cal_*`-derived numbers below. Rows the unit guard
   * refused are NOT in here — see {@link ScoringPanel.unscorable}.
   */
  n_scored: number;
  pinball_p50: number | null;
  pinball_p90: number | null;
  log_score: number | null;
  coverage_p50: number | null;
  coverage_p90: number | null;
  cov_lo: number | null;
  cov_hi: number | null;
  /** Scored SEPARATELY, never blended into the baseline (§3.2 R3 rule ii). */
  refinement: { n: number; pinball_p50: number | null; moved_toward_actual_pct: number | null };
  /** The "smaller items estimate better" test (§3.2, §7.4). */
  blocks: {
    n_tasks: number;
    rollup_pinball_p50: number | null;
    task_pinball_p50: number | null;
    per_block_pinball_p50: number | null;
    verdict: "blocks_better" | "task_better" | "insufficient_data";
  };
  origin: {
    velocity_main: number | null;
    velocity_sub: number | null;
    exp_agents_residual: number | null;
    parallelism_p50: number | null;
  };
  /**
   * What this panel REFUSED to score, and why — the counterpart to every `null` above
   * that is a refusal rather than an empty corpus.
   *
   * A story-point band whose `est open` found no points -> Work-CET rate is still
   * denominated in POINTS, and the actual it would be scored against is Work-CET, so
   * pinball loss, log score and coverage are undefined for it (`bandUnscorable`,
   * src/tasks.ts). Block quantiles are stricter still: `est block` stores the unit in
   * force and nothing ever converts an `estimate_block` row, so under `story_point`
   * the roll-up is points even for a task whose own band WAS converted at open
   * (`blocksInWcet`).
   *
   * All four counters are 0 for a Work-CET corpus, which is every corpus that predates
   * v15. A non-zero value is not a data-quality problem — it is the cold start being
   * honest — but it IS why `n_scored` can sit below `n_outcomes`, so it is reported
   * rather than silently subtracted.
   */
  unscorable: {
    /** Completed outcomes dropped from the baseline scores. */
    baseline: number;
    /** Refinement pairs dropped from the refinement scores. */
    refinement: number;
    /** Tasks dropped from the roll-up-vs-task comparison. */
    block_tasks: number;
    /** Individual `v_block_accuracy` rows with no scorable actual, for unit reasons. */
    blocks: number;
  };
}

export interface DataQualityPanel {
  /** HEADLINE. Over the WHOLE corpus, which is the denominator G-ATTR measured. */
  coverage_all: number | null;
  /** Over sessions that actually carry a bound task — what the live re-gate is about. */
  coverage_tracked: number | null;
  ambiguous_share: number | null;
  pre_task_share: number | null;
  /** Tokens the staleness rule moved out of `ambiguous` — how its window gets tuned. */
  stale_closed_share: number | null;
  compliance_t1t2: number | null;
  t3_candidates: number;
  /**
   * The DECOMPOSITION MANDATE, measured — tasks whose band was issued above
   * {@link DECOMPOSITION_POINTS} points and which carry no `estimate_block` row at all.
   *
   * The rule ("above ~40 points, or across more than one phase, decompose and size the
   * pieces") arrived stated in five prose places and instrumented in none. This project
   * already made the opposite choice once, for the same shape of rule: `compliance_t1t2`
   * exists precisely so a mandate can be WATCHED rather than repeated, and the doctrine
   * that follows from watching it is to sharpen the wording rather than to gate — which
   * is a decision the number licenses and prose cannot.
   *
   * `decomposition_due` is the denominator (how many bands were even large enough for
   * the rule to bite) and `decomposition_undecomposed` the violations, because a bare
   * count answers neither "is this getting worse" nor "is anyone hitting this rule at
   * all". Both are 0 on a Work-CET corpus: the threshold is in POINTS and only a
   * `story_point` band is measured against it.
   */
  decomposition_due: number;
  decomposition_undecomposed: number;
  t4_note: string;
  scope_declared_pct: number | null;
  identity_planted_pct: number | null;
  /**
   * The two gate bypasses, and how much of the corpus came through one.
   *
   * `est close --accept` (Craig, 2026-07-30) lets an agent close on the human's recorded
   * consent, and a lever that changes what enters the calibration corpus has to be
   * self-reporting or it is invisible until someone goes looking. `bypass_share` is over
   * the CURRENT outcome of every closed task: a rising share means quiescence is
   * finalizing less and less of the corpus on its own, which is a finding about the
   * gate, not about any one close. Counts are of ledger ROWS, so a task closed under
   * both (reopened, re-closed differently) contributes to both.
   */
  forced_closes: number;
  accepted_closes: number;
  /**
   * The SWEEPER's two close arms (P1.7 close pass, Craig 2026-07-30), counted apart
   * because they are opposite epistemic events. `swept_closes` gained the corpus a
   * measurement; `swept_abandons` gained it a right-censored LOWER BOUND and sealed a
   * task's attribution window on no evidence either way.
   *
   * The abandoned share is DECISIONS §12's own re-open trigger: past roughly half of
   * swept closes, the finding is not about any one task but about the SIGNAL — the
   * harness's terminal `task_event` is not reaching the tasks it should, which is a
   * §3.2 step 6 problem wearing a §6.2 costume. Without this pair there was no
   * instrument to read that trigger off.
   */
  swept_closes: number;
  swept_abandons: number;
  bypass_share: number | null;
  overhead_share: number | null;
  unpriced_share: number | null;
  provisional_share: number | null;
  cross_epoch_tasks: number;
  fork_replays: number;
  sidechain_replays: number;
  phase_unmapped_agents: number;
  dangling_agents: number;
  spawn_depth_gt1: number;
  compactions: number;
  censored_outcomes: number;
  corpus_shrink_events: number;
  /** §5.8 v9: the cumulative `corpus_loss` ledger, which survives past whatever
   *  window `sweep_census --limit N` happens to scroll to. `_total` unresolved
   *  rows; `_unexplained` is the subset that is neither `expected` (past
   *  `retention_days`) nor `resolved_at` (the file came back) — the durable
   *  count `corpus_shrink_events` (a per-anomaly-row count that dedups on
   *  (kind, detail) and can therefore UNDERcount real losses) does not carry. */
  corpus_loss_total: number;
  corpus_loss_unexplained: number;
  /** Over COMPLETED runs only — folding in-flight runs in makes this a function of
   *  when the retro ran rather than of the data (§7.4 R4 correction ii). */
  wf_progress_completeness: number | null;
  wf_in_flight_agents: number;
  unlabeled_wf_agents: number;
  block_complete_tasks: number;
  block_incomplete_tasks: number;
  recon: Array<{ as_of: string; source: string; delta_pct: number }>;
}

export interface RetroReport {
  as_of: string;
  dry_run: boolean;
  ref_model: string;
  estimand: string;
  n_outcomes: number;
  buckets: BucketFit[];
  scoring: ScoringPanel;
  quality: DataQualityPanel;
  splits: Array<{ dimension: string; level: string; n: number; pinball_delta: number }>;
  alerts: string[];
  /**
   * P2.1: the check-back models, scored against each other and against the floor.
   * `null` when the corpus is too thin to fit — an honest gap, not a zero.
   */
  eta: EtaScore[];
  /**
   * P2.9: the `~/.claude/jobs` reconcile, over every BOUND job — jobs-reported
   * span and timeline transitions beside our `run_segment`/`task.started_at`
   * derivation for the SAME task. Reported, never corrected (§7.1): nothing here
   * writes back to `task`, `run_segment` or `job_run`. `[]` when no job is bound.
   */
  jobs_reconcile: JobsPanelRow[];
  written: { refclass: number; calib_run: number; eta_run: number };
}

/**
 * The `v_velocity` projection, defined once in `src/unit.ts` beside the scope that
 * selects it. It used to be re-declared here with a narrower column list, which is a
 * small symptom of the same cause as the window bug below: the fitted row set was
 * something this file described for itself rather than something it asked for.
 */
type VelocityRow = VelocitySample;

function num(db: Database, sql: string, params: string[] = []): number {
  const row = db.query<{ v: number | null }, string[]>(sql).get(...params);
  return row?.v ?? 0;
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/**
 * The weekly retro. `--dry-run` computes and prints without writing — **and is the
 * right default habit while n is small**, because a snapshot fitted to six points is
 * a number the next six estimates will inherit.
 */
export function retro(
  db: Database,
  opts: { asOf?: Date; dryRun?: boolean; jobsRoot?: string } = {},
): RetroReport {
  const jobsRoot = opts.jobsRoot ?? JOBS_ROOT;
  const now = opts.asOf ?? new Date();
  const asOf = isoNow(now);
  const dryRun = opts.dryRun === true;
  const refModel = getConfig(db, "ref_model") ?? "claude-sonnet-4-5";
  const estimand = getConfig(db, "estimand") ?? "work_cet";
  const shrinkK = Number.parseFloat(getConfig(db, "shrink_k") ?? "10");
  const halfLife = Number.parseFloat(getConfig(db, "velocity_half_life_days") ?? "30");
  const resamples = Number.parseInt(getConfig(db, "boot_resamples") ?? "200", 10);
  const splitGate = Number.parseFloat(getConfig(db, "split_min_pinball_gain") ?? "0.02");

  // THE row set, and it is the same expression the guard on this snapshot's output uses
  // (`src/unit.ts` `SampleScope`, `src/tasks.ts` `pointsToWcet`). Two things changed here
  // and they are the same change:
  //
  //  - `asOf` is now a BOUND. This query used to fit every row in the unit regardless of
  //    `--as-of`, while `pointsToWcet`'s anchor guard counted only rows finalized before
  //    the snapshot's own `as_of`. `est retro --as-of 2000-01-01` over ten v1 samples at
  //    2,000/point and ten v2 at 6,000 — all finalized in 2026 — therefore wrote a mixed
  //    `n=20` snapshot stamped for the year 2000, and the guard, asking what a year-2000
  //    snapshot could have seen, correctly found zero foreign samples below it and handed
  //    the mixture out as a v2 rate. The RETRO was the wrong one: `--as-of T` names the
  //    instant a snapshot speaks for, `refclass.as_of` is what every consumer reads the
  //    window off, and a snapshot cannot be fitted on outcomes that had not happened yet.
  //  - the unit filter is the identity's, not two hand-written equalities.
  //
  // `anchor: "any"` is deliberate and unchanged: `refclass` is keyed on
  // `(as_of, bucket, estimator_family, ref_model, estimand)` and has nowhere to put a
  // per-anchor snapshot, so the fit still pools anchors and `pointsToWcet` still refuses
  // to read a pooled snapshot back as a per-anchor rate. The two now disagree about
  // nothing except that one deliberate thing.
  const scope = BandIdentity.ambient(db).samples({ asOf });
  const rows = scope.rows(db, "any");

  const ageDays = (ts: string): number =>
    Math.max(0, (now.getTime() - Date.parse(ts)) / 86_400_000);

  // --- fits ----------------------------------------------------------------
  const globalStats = logVelocityStats(
    rows.map((r) => ({ velocity: r.velocity_raw ?? 0, ageDays: ageDays(r.finalized_at) })),
    halfLife,
  );
  const groups = new Map<string, VelocityRow[]>();
  for (const r of rows) {
    const key = `${r.bucket}\u0000${priceFamily(r.estimator_model)}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [r]);
    else list.push(r);
  }

  const buckets: BucketFit[] = [];
  for (const [key, group] of groups) {
    const sep = key.indexOf("\u0000");
    const bucket = key.slice(0, sep);
    const family = key.slice(sep + 1);
    const stats = logVelocityStats(
      group.map((r) => ({ velocity: r.velocity_raw ?? 0, ageDays: ageDays(r.finalized_at) })),
      halfLife,
    );
    if (stats === null || globalStats === null) continue;
    const shrinkW = shrinkWeight(stats.n, shrinkK);
    // §3.2: band width comes from the GLOBAL log-velocity IQR until bucket_n >= 20.
    // An order statistic over eight points is not a spread.
    const iqr = stats.n >= 20 ? stats.iqrLogV : globalStats.iqrLogV;
    const m = multipliers({
      medLogV: stats.medLogV,
      iqrLogV: iqr,
      globalMedLogV: globalStats.medLogV,
      shrinkW,
    });
    const samples: WeightedSample[] = group
      .filter((r): r is VelocityRow & { velocity_raw: number } => (r.velocity_raw ?? 0) > 0)
      .map((r) => ({
        value: Math.log(r.velocity_raw),
        weight: decayWeight(ageDays(r.finalized_at), halfLife),
      }));
    const rng = mulberry32(hashSeed(`${asOf}|${key}`));
    const ci50 = bootstrapQuantileCI(samples, 0.5, { resamples, rng });
    const ci90 = bootstrapQuantileCI(samples, 0.9, { resamples, rng });
    buckets.push({
      bucket,
      estimator_family: family,
      ref_model: refModel,
      estimand,
      n: stats.n,
      n_eff: stats.nEff,
      med_log_v: stats.medLogV,
      iqr_log_v: iqr,
      shrink_w: shrinkW,
      shrink_k: shrinkK,
      half_life_days: halfLife,
      mult_p50: m.multP50,
      mult_p90: m.multP90,
      boot_lo_p50: ci50 === null ? null : Math.exp(ci50.lo),
      boot_hi_p50: ci50 === null ? null : Math.exp(ci50.hi),
      boot_lo_p90: ci90 === null ? null : Math.exp(ci90.lo),
      boot_hi_p90: ci90 === null ? null : Math.exp(ci90.hi),
      method: samples.length >= 2 ? "bootstrap" : "plugin",
      median_velocity: Math.exp(stats.medLogV),
    });
  }

  const scoring = scorePanel(db, refModel, estimand);
  const quality = qualityPanel(db);
  const splits = splitCandidates(db, refModel, estimand, splitGate);

  const alerts: string[] = [];
  if (quality.coverage_tracked !== null && quality.coverage_tracked < ATTR_COVERAGE_GATE) {
    alerts.push(
      `attribution coverage ${(quality.coverage_tracked * 100).toFixed(1)}% is below the ${(ATTR_COVERAGE_GATE * 100).toFixed(0)}% G-ATTR gate — calibration is not licensed yet`,
    );
  }
  for (const r of quality.recon) {
    if (Math.abs(r.delta_pct) > 5) alerts.push(`recon_mismatch: ${r.source} ${r.delta_pct.toFixed(1)}%`);
  }
  if (quality.corpus_shrink_events > 0) {
    alerts.push(`${quality.corpus_shrink_events} corpus_shrink event(s) — §5.8 expects ZERO`);
  }
  // The refusal, said out loud. Not an anomaly and not a data-quality failure — it is
  // the story-point cold start behaving correctly — but a `n_scored` that silently sat
  // below `n_outcomes` would look like missing data rather than like an undefined
  // comparison, which is the misreading the whole guard exists to prevent.
  const u = scoring.unscorable;
  if (u.baseline + u.refinement + u.block_tasks + u.blocks > 0) {
    alerts.push(
      `unit_refusal: ${u.baseline} baseline, ${u.refinement} refinement, ${u.block_tasks} block-task and ` +
        `${u.blocks} per-block comparison(s) are UNDEFINED, not missing — the band is in story points, ` +
        "the actual is in Work-CET, and no conversion was applied at `est open`. " +
        // Same shape as `est close`'s exit-2 remedy and `est burn`'s band note: "do
        // nothing" first, with its consequence, and the seed named as the decided-against
        // lever it is rather than as a co-equal fix.
        "Do nothing: closing points tasks fits a rate by itself, and bands issued from then on score " +
        "normally (`estimate` is append-only, so these never will). No seed is set DELIBERATELY " +
        "(DECISIONS.md §13.1); `sp_seed_wcet_per_point` + `sp_seed_anchor_id` clear the bar only on " +
        "ρ(actual, rate) ≈ 0 and rate CV < 0.3 over ≥10 real completed tasks — not on impatience.",
    );
  }

  // CACHE-TTL-PRICING.md D8/D9: `cw_ttl_price_fix_at` is stamped once by `est prices
  // --fill-cw-1h` (src/prices.ts) and marks the boundary where cw5m/cw1h-aware
  // pricing became available. healClosedOutcomes' candidate filter only re-fires on
  // outcomes whose `request` rows moved AFTER `finalized_at` (src/close.ts) — a pure
  // repricing event moves no request row, so outcomes finalized before the fix are
  // never restated and stay in the ledger measured under the old, coarser rate.
  // Fitting velocity across that boundary with no signal at all is exactly the
  // forward-only hazard D9 rejected; this says the refusal out loud instead, the
  // same pattern the G-ATTR and unit_refusal alerts above already establish.
  const fixAt = getConfig(db, "cw_ttl_price_fix_at");
  if (fixAt !== null) {
    const nStale = num(
      db,
      `SELECT COUNT(*) AS v FROM v_outcome_current
        WHERE final_status <> 'reopened' AND finalized_at < ?`,
      [fixAt],
    );
    if (nStale > 0) {
      alerts.push(
        `cw_ttl_repricing_boundary: ${nStale} closed outcome(s) were finalized before the ` +
          `${fixAt} cache-TTL repricing fix and carry actuals measured under the old, coarser ` +
          "rate, while outcomes finalized after it do not — this fit pools both without " +
          "distinction. Remedy: D8's re-heal (rerun the close pass over the stale outcomes so " +
          "their actuals are restated at the corrected rate), not a hand edit.",
      );
    }
  }

  // The check-back panel. Scored on EVERY retro, dry-run included: the comparison is
  // what licenses the shipped model to keep issuing bands, and a `--dry-run` that
  // skipped it would hide the one number that says whether the `?` is coming off.
  const eta = scoreEtaModels(db, { asOf: new Date(asOf) });
  const shippedEta = eta.find((e) => e.eta_model === "residual_life");
  if (shippedEta !== undefined && shippedEta.n_seg > 0 && !shippedEta.won) {
    alerts.push(
      `check-back model residual_life has not beaten const_median over ${shippedEta.n_seg} closed segment(s) — the ETA stays on probation and keeps its \`?\``,
    );
  }

  let written = { refclass: 0, calib_run: 0, eta_run: 0 };
  if (!dryRun) {
    written = { ...writeBack(db, asOf, buckets, scoring, splits, estimand, alerts), eta_run: 0 };
    db.transaction(() => {
      written.eta_run = writeEtaRuns(db, eta, new Date(asOf));
    }).immediate();
  }

  // P2.9: the jobs reconcile panel. Read-only against `job_run`/`run_segment`/
  // `task` and the bound jobs' own `timeline.jsonl` — nothing here is written
  // back, dry-run or not, because "reported, never corrected" (§7.1) applies to
  // every retro, not just the ones that skip the write-back above.
  const jobsReconcile = jobsRetroPanel(db, jobsRoot);

  return {
    as_of: asOf,
    dry_run: dryRun,
    ref_model: refModel,
    estimand,
    n_outcomes: rows.length,
    buckets,
    scoring,
    quality,
    splits,
    alerts,
    eta,
    jobs_reconcile: jobsReconcile,
    written,
  };
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

interface ScoredOutcome {
  tid: string;
  actual: number;
  raw_p50: number;
  cal_p50: number;
  cal_p90: number;
  wcet_main: number;
  wcet_sub: number;
  exp_agents: number;
  n_agents: number;
  parallelism_factor: number | null;
  /** The columns {@link bandUnscorable} reads, under the names it expects. */
  estimand: string;
  raw_p50_wcet: number;
  cal_p50_wcet: number;
  /** v19: the STORED conversion fact; `cal != raw` is no longer the test. */
  wcet_rate_src: string;
}

function scorePanel(db: Database, refModel: string, estimand: string): ScoringPanel {
  const all = db
    .query<ScoredOutcome, [string, string]>(
      `SELECT o.tid AS tid, o.actual_wcet_at_epoch AS actual,
              e.raw_p50_wcet AS raw_p50, e.cal_p50_wcet AS cal_p50, e.cal_p90_wcet AS cal_p90,
              o.wcet_main AS wcet_main, o.wcet_sub AS wcet_sub,
              e.exp_agents AS exp_agents, o.n_agents AS n_agents,
              o.parallelism_factor AS parallelism_factor,
              e.estimand AS estimand,
              e.raw_p50_wcet AS raw_p50_wcet, e.cal_p50_wcet AS cal_p50_wcet,
              e.wcet_rate_src AS wcet_rate_src
         FROM v_outcome_current o
         JOIN estimate e ON e.eid = o.eid_at_start
        WHERE o.final_status = 'completed' AND o.censored = 0
          AND o.actual_wcet_at_epoch IS NOT NULL
          AND e.ref_model = ? AND e.estimand = ?`,
    )
    .all(refModel, estimand);

  // THE guard, and the reason it is imported rather than written here: `actual` is
  // Work-CET off the logs, and `cal_p50`/`cal_p90` are Work-CET only when the band was
  // not left in story points by an `est open` that had no rate. Pinball loss, log score
  // and coverage over a mixed-unit pair are not weak measurements — they are not
  // measurements — so the rows leave the sample entirely and are counted out loud.
  const scored = all.filter((s) => !bandUnscorable(s));
  const unscorableBaseline = all.length - scored.length;

  const p50Loss = scored.map((s) => pinball(s.actual, s.cal_p50, 0.5));
  const p90Loss = scored.map((s) => pinball(s.actual, s.cal_p90, 0.9));
  const logs = scored.map((s) => logScore(s.actual, s.cal_p50, s.cal_p90));
  const under50 = scored.filter((s) => s.actual <= s.cal_p50).length;
  const under90 = scored.filter((s) => s.actual <= s.cal_p90).length;
  const cov = scored.length > 0 ? jeffreysInterval(under90, scored.length, 0.9) : null;

  // Refinements: mid-task predictive skill, reported BESIDE — never blended into —
  // baseline calibration. This is where "the cone of uncertainty narrows" becomes a
  // measurement instead of a slogan.
  const refinementRows = db
    .query<
      {
        tid: string;
        actual: number;
        cal_p50: number;
        base_p50: number;
        estimand: string;
        raw_p50_wcet: number;
        cal_p50_wcet: number;
        wcet_rate_src: string;
        base_estimand: string;
        base_raw_p50_wcet: number;
        base_cal_p50_wcet: number;
        base_wcet_rate_src: string;
      },
      [string, string]
    >(
      `SELECT o.tid AS tid, o.actual_wcet_at_epoch AS actual,
              e.cal_p50_wcet AS cal_p50, b.cal_p50_wcet AS base_p50,
              e.estimand AS estimand,
              e.raw_p50_wcet AS raw_p50_wcet, e.cal_p50_wcet AS cal_p50_wcet,
              e.wcet_rate_src AS wcet_rate_src,
              b.estimand AS base_estimand,
              b.raw_p50_wcet AS base_raw_p50_wcet, b.cal_p50_wcet AS base_cal_p50_wcet,
              b.wcet_rate_src AS base_wcet_rate_src
         FROM v_outcome_current o
         JOIN estimate b ON b.eid = o.eid_at_start
         JOIN estimate e ON e.tid = o.tid AND e.reason = 'refinement'
        WHERE o.final_status = 'completed' AND o.actual_wcet_at_epoch IS NOT NULL
          AND b.ref_model = ? AND b.estimand = ?`,
    )
    .all(refModel, estimand);
  // BOTH ends of the pair are guarded: `pinball` reads the refinement's band and
  // `moved_toward_actual` reads the baseline's, so one unconverted points band on
  // either side makes the whole comparison cross-unit.
  const refinements = refinementRows.filter(
    (r) =>
      !bandUnscorable(r) &&
      !bandUnscorable({
        estimand: r.base_estimand,
        raw_p50_wcet: r.base_raw_p50_wcet,
        cal_p50_wcet: r.base_cal_p50_wcet,
        wcet_rate_src: r.base_wcet_rate_src,
      }),
  );
  const unscorableRefinement = refinementRows.length - refinements.length;
  const refPinball = refinements.map((r) => pinball(r.actual, r.cal_p50, 0.5));
  const moved = refinements.filter(
    (r) => Math.abs(r.cal_p50 - r.actual) < Math.abs(r.base_p50 - r.actual),
  ).length;

  const blocks = blockPanel(db, refModel, estimand);

  return {
    n_scored: scored.length,
    pinball_p50: meanOf(p50Loss),
    pinball_p90: meanOf(p90Loss),
    log_score: meanOf(logs),
    coverage_p50: ratio(under50, scored.length),
    coverage_p90: ratio(under90, scored.length),
    cov_lo: cov?.lo ?? null,
    cov_hi: cov?.hi ?? null,
    refinement: {
      n: refinements.length,
      pinball_p50: meanOf(refPinball),
      moved_toward_actual_pct: ratio(moved, refinements.length),
    },
    blocks: blocks.panel,
    // `origin` is deliberately over `all`, not `scored`. Every ratio here divides by
    // `raw_p50`, and under `story_point` that is Work-CET PER POINT — the learning
    // signal `est close` records as `velocity_raw` and keeps under points for exactly
    // this reason. It is the CALIBRATED band that is in the wrong unit, and nothing in
    // this object touches it.
    origin: {
      velocity_main: meanOf(all.map((s) => (s.raw_p50 > 0 ? s.wcet_main / s.raw_p50 : null))),
      velocity_sub: meanOf(all.map((s) => (s.raw_p50 > 0 ? s.wcet_sub / s.raw_p50 : null))),
      exp_agents_residual: meanOf(all.map((s) => s.n_agents - s.exp_agents)),
      parallelism_p50: meanOf(all.map((s) => s.parallelism_factor)),
    },
    unscorable: {
      baseline: unscorableBaseline,
      refinement: unscorableRefinement,
      block_tasks: blocks.unscorableTasks,
      blocks: blocks.unscorableBlocks,
    },
  };
}

/**
 * Block-level vs task-level accuracy — the hypothesis that motivated per-block
 * estimating, TESTED against Craig's own data rather than assumed. If the roll-up
 * does not beat the task band after enough workflow tasks, that is reportable and
 * the requirement can be revisited on evidence (§3.2, §7.4).
 *
 * The UNIT guard here is `blocksInWcet`, not `bandUnscorable`, and the difference is
 * the point: this panel pinballs a Work-CET actual against `SUM(estimate_block.p50_wcet)`,
 * and a block row is stored in the unit in force at `est block` and is never converted
 * by anything. So under `story_point` the roll-up is points even for a task whose own
 * band a rate DID convert at `est open` — the conversion happened on `estimate`, not on
 * the blocks hanging off it. Refusing the whole comparison is the honest answer: with
 * `rollup_pinball_p50` null the verdict falls through to the `insufficient_data` arm
 * that already existed, which is exactly what "we cannot tell" means here.
 */
function blockPanel(
  db: Database,
  refModel: string,
  estimand: string,
): { panel: ScoringPanel["blocks"]; unscorableTasks: number; unscorableBlocks: number } {
  const rows = db
    .query<
      { tid: string; actual: number; task_p50: number; rollup_p50: number },
      [string, string]
    >(
      `SELECT o.tid AS tid, o.actual_wcet_at_epoch AS actual, e.cal_p50_wcet AS task_p50,
              (SELECT COALESCE(SUM(p50_wcet),0) FROM estimate_block WHERE eid = e.eid) AS rollup_p50
         FROM v_outcome_current o
         JOIN estimate e ON e.eid = o.eid_at_start
        WHERE o.final_status = 'completed' AND o.actual_wcet_at_epoch IS NOT NULL
          AND e.ref_model = ? AND e.estimand = ?
          AND EXISTS (SELECT 1 FROM estimate_block WHERE eid = e.eid)`,
    )
    .all(refModel, estimand);
  const scorable = blocksInWcet(estimand);

  // The per-block leg reads its refusal from the VIEW rather than repeating it: the
  // same rule is expressed once in SQL (`v_block_accuracy.unit_mismatch`, which also
  // nulls `actual_wcet`) so a caller reaching for the view directly cannot get a
  // cross-unit pair either.
  const perBlock = db
    .query<{ p50: number; actual: number | null }, []>(
      "SELECT p50_wcet AS p50, actual_wcet AS actual FROM v_block_accuracy WHERE actual_wcet IS NOT NULL",
    )
    .all();
  const unscorableBlocks =
    db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_block_accuracy WHERE unit_mismatch = 1")
      .get()?.n ?? 0;

  const rollup = scorable ? meanOf(rows.map((r) => pinball(r.actual, r.rollup_p50, 0.5))) : null;
  const task = scorable ? meanOf(rows.map((r) => pinball(r.actual, r.task_p50, 0.5))) : null;
  return {
    panel: {
      n_tasks: scorable ? rows.length : 0,
      rollup_pinball_p50: rollup,
      task_pinball_p50: task,
      per_block_pinball_p50: meanOf(
        perBlock.map((b) => (b.actual === null ? null : pinball(b.actual, b.p50, 0.5))),
      ),
      verdict:
        rollup === null || task === null || rows.length < 3
          ? "insufficient_data"
          : rollup < task
            ? "blocks_better"
            : "task_better",
    },
    unscorableTasks: scorable ? 0 : rows.length,
    unscorableBlocks,
  };
}

// ---------------------------------------------------------------------------
// data quality
// ---------------------------------------------------------------------------

function qualityPanel(db: Database): DataQualityPanel {
  const totalWcet = num(db, "SELECT SUM(wcet) AS v FROM v_wcet");
  const coveredAll = num(db, "SELECT SUM(wcet) AS v FROM v_wcet WHERE attr IN ('exclusive','sticky')");

  // The "tracked" denominator: sessions that carry at least one bound task. This is
  // the population the live G-ATTR re-gate is about — a corpus where tasks were
  // opened before the work and closed after it.
  const trackedTotal = num(
    db,
    "SELECT SUM(wcet) AS v FROM v_wcet WHERE session_id IN (SELECT DISTINCT session_id FROM task_alias WHERE session_id <> '')",
  );
  const trackedCovered = num(
    db,
    `SELECT SUM(wcet) AS v FROM v_wcet WHERE attr IN ('exclusive','sticky')
       AND session_id IN (SELECT DISTINCT session_id FROM task_alias WHERE session_id <> '')`,
  );
  const ambiguous = num(
    db,
    `SELECT SUM(wcet) AS v FROM v_wcet WHERE attr = 'ambiguous'
       AND session_id IN (SELECT DISTINCT session_id FROM task_alias WHERE session_id <> '')`,
  );
  const preTask = num(
    db,
    `SELECT SUM(wcet) AS v FROM v_wcet WHERE attr = 'pre_task'
       AND session_id IN (SELECT DISTINCT session_id FROM task_alias WHERE session_id <> '')`,
  );
  // `pre_task` spend that falls INSIDE some bound task's window is spend the
  // staleness rule closed off; `pre_task` before any window opened is genuinely
  // pre-task. Splitting them is what lets the retro tune the window by evidence.
  const staleClosed = num(
    db,
    `SELECT SUM(w.wcet) AS v FROM v_wcet w
      WHERE w.attr = 'pre_task'
        AND EXISTS (SELECT 1 FROM task t
                     JOIN task_alias a ON a.tid = t.tid AND a.session_id = w.session_id
                    WHERE w.ts >= t.created_at)`,
  );
  const overhead = num(db, "SELECT SUM(wcet) AS v FROM v_wcet WHERE attr = 'overhead'");

  // Compliance: EXACT for T1/T2 and nothing else. Do not read this as a compliance
  // percentage; read it as "compliance on the mechanically-detectable subset" (§3.3).
  const t1t2 = num(
    db,
    `SELECT COUNT(*) AS v FROM (
       SELECT t.session_id, t.prompt_id
         FROM turn t JOIN agent_run a ON a.launch_prompt_id = t.prompt_id AND a.session_id = t.session_id
        GROUP BY t.session_id, t.prompt_id
       HAVING SUM(CASE WHEN a.run_id IS NOT NULL THEN 1 ELSE 0 END) >= 1
           OR COUNT(DISTINCT a.agent_id) >= 2)`,
  );
  const missed = num(db, "SELECT COUNT(*) AS v FROM v_missed_estimate");

  const anomalyCount = (kind: string): number =>
    num(db, "SELECT COUNT(*) AS v FROM anomaly WHERE kind = ?", [kind]);

  const scopeChanged = db
    .query<{ declared: number; total: number }, []>(
      `SELECT SUM(scope_declared) AS declared, COUNT(*) AS total
         FROM v_outcome_current WHERE scope_seq_final > scope_seq_at_start`,
    )
    .get();
  const planted = db
    .query<{ planted: number; total: number }, []>(
      "SELECT SUM(tid_planted) AS planted, COUNT(*) AS total FROM v_outcome_current WHERE tid_planted IS NOT NULL",
    )
    .get();

  const priced = num(db, "SELECT COUNT(*) AS v FROM v_priced");
  const unpriced = num(db, "SELECT COUNT(*) AS v FROM v_unpriced");
  const provisional = num(db, "SELECT COUNT(*) AS v FROM v_priced WHERE provisional = 1");

  const crossEpoch = num(
    db,
    `SELECT COUNT(*) AS v FROM (
       SELECT tid FROM (
         SELECT p.tid AS tid, p.price_family AS fam,
                (SELECT MAX(effective_from) FROM model_price
                  WHERE family = p.price_family AND effective_from <= p.ts) AS ef
           FROM v_priced p WHERE p.tid IS NOT NULL)
       GROUP BY tid, fam HAVING COUNT(DISTINCT ef) > 1)`,
  );

  const wfCompleted = db
    .query<{ exact: number; total: number }, []>(
      `SELECT SUM(CASE WHEN a.phase_conf = 'exact' THEN 1 ELSE 0 END) AS exact, COUNT(*) AS total
         FROM agent_run a JOIN workflow_run r ON r.run_id = a.run_id AND r.wf_launch_id = a.wf_launch_id
        WHERE r.ended_at IS NOT NULL`,
    )
    .get();
  const wfInFlight = num(
    db,
    `SELECT COUNT(*) AS v FROM agent_run a
       JOIN workflow_run r ON r.run_id = a.run_id AND r.wf_launch_id = a.wf_launch_id
      WHERE r.ended_at IS NULL`,
  );

  // The decomposition mandate, counted. ONE query, two numbers: how many story-point
  // bands landed above the threshold, and how many of those hung no block off the
  // estimate they were issued as.
  //
  // Measured on the estimate's OWN raw p50 — the band as issued, in points — rather
  // than on p90 or on a converted figure. The rule is about the size the estimator
  // committed to at `est open`, and p50 is the number the ladder produces; a p90 test
  // would fire on any band with a wide tail, which is a different (and unstated) rule.
  // Blocks are counted against `b.eid`, so a task that was re-estimated and blocked
  // under an earlier version reads as undecomposed for the CURRENT band — correctly:
  // `estimate_block` is append-only per eid and a refinement that widened past the
  // threshold has not been decomposed.
  const decomp = db
    .query<{ due: number; missing: number }, [number]>(
      `SELECT COUNT(*) AS due,
              SUM(CASE WHEN (SELECT COUNT(*) FROM estimate_block b WHERE b.eid = e.eid) = 0
                       THEN 1 ELSE 0 END) AS missing
         FROM estimate e
        WHERE e.estimand = 'story_point'
          AND e.raw_p50_wcet > ?
          AND e.eid = (SELECT MAX(eid) FROM estimate WHERE tid = e.tid)`,
    )
    .get(DECOMPOSITION_POINTS);

  // Block completeness: a T1 task whose declared phases are all blocked.
  const blockRows = db
    .query<{ tid: string; declared: number; blocked: number }, []>(
      `SELECT e.tid AS tid,
              (SELECT COUNT(*) FROM workflow_phase p
                WHERE p.run_id = r.run_id AND p.wf_launch_id = r.wf_launch_id) AS declared,
              (SELECT COUNT(*) FROM estimate_block b WHERE b.eid = e.eid) AS blocked
         FROM workflow_run r
         JOIN estimate e ON e.tid = r.tid
        WHERE e.eid = (SELECT MAX(eid) FROM estimate WHERE tid = r.tid)`,
    )
    .all();

  return {
    coverage_all: ratio(coveredAll, totalWcet),
    coverage_tracked: ratio(trackedCovered, trackedTotal),
    ambiguous_share: ratio(ambiguous, trackedTotal),
    pre_task_share: ratio(preTask, trackedTotal),
    stale_closed_share: ratio(staleClosed, trackedTotal),
    compliance_t1t2: t1t2 > 0 ? 1 - missed / t1t2 : null,
    t3_candidates: countT3Candidates(db),
    decomposition_due: decomp?.due ?? 0,
    decomposition_undecomposed: decomp?.missing ?? 0,
    t4_note:
      "T4 (the user asked for a budget) is undetectable without a prompt classifier — a known blind spot, stated (§3.3)",
    scope_declared_pct: ratio(scopeChanged?.declared ?? 0, scopeChanged?.total ?? 0),
    identity_planted_pct: ratio(planted?.planted ?? 0, planted?.total ?? 0),
    forced_closes: anomalyCount("forced_close"),
    accepted_closes: anomalyCount("accepted_close"),
    swept_closes: anomalyCount("swept_close"),
    swept_abandons: anomalyCount("swept_abandon"),
    // DISTINCT tid, over closed tasks: the question is what share of the corpus was
    // finalized by something other than a human running `est close` on a quiet task,
    // and two rows against one task is still one task. The two SWEPT kinds belong in
    // here beside the two bypasses: a swept close bypasses no gate, but it is equally
    // "the corpus closed itself", which is the thing this share exists to watch.
    bypass_share: ratio(
      num(
        db,
        `SELECT COUNT(DISTINCT a.tid) AS v FROM anomaly a
          WHERE a.kind IN ('forced_close','accepted_close','swept_close','swept_abandon')
            AND a.tid IS NOT NULL
            AND a.tid IN (SELECT tid FROM v_outcome_current WHERE final_status <> 'reopened')`,
      ),
      num(db, "SELECT COUNT(*) AS v FROM v_outcome_current WHERE final_status <> 'reopened'"),
    ),
    overhead_share: ratio(overhead, totalWcet),
    unpriced_share: ratio(unpriced, priced + unpriced),
    provisional_share: ratio(provisional, priced),
    cross_epoch_tasks: crossEpoch,
    fork_replays: anomalyCount("fork_replay"),
    sidechain_replays: num(db, "SELECT COUNT(*) AS v FROM request WHERE attr = 'replay'"),
    phase_unmapped_agents: num(
      db,
      "SELECT COUNT(*) AS v FROM agent_run WHERE run_id IS NOT NULL AND (phase_conf IS NULL OR phase_conf = 'unmapped')",
    ),
    dangling_agents: num(
      db,
      "SELECT COUNT(*) AS v FROM agent_run WHERE started_at IS NOT NULL AND ended_at IS NULL",
    ),
    spawn_depth_gt1: anomalyCount("spawn_depth_gt1"),
    compactions: anomalyCount("compaction_continuation"),
    censored_outcomes: num(db, "SELECT COUNT(*) AS v FROM v_outcome_current WHERE censored = 1"),
    corpus_shrink_events: anomalyCount("corpus_shrink"),
    corpus_loss_total: num(db, "SELECT COUNT(*) AS v FROM corpus_loss WHERE resolved_at IS NULL"),
    corpus_loss_unexplained: num(
      db,
      "SELECT COUNT(*) AS v FROM corpus_loss WHERE resolved_at IS NULL AND expected = 0",
    ),
    wf_progress_completeness: ratio(wfCompleted?.exact ?? 0, wfCompleted?.total ?? 0),
    wf_in_flight_agents: wfInFlight,
    unlabeled_wf_agents: num(
      db,
      "SELECT COUNT(*) AS v FROM agent_run WHERE run_id IS NOT NULL AND (label IS NULL OR phase_idx IS NULL)",
    ),
    block_complete_tasks: blockRows.filter((r) => r.declared > 0 && r.blocked >= r.declared).length,
    block_incomplete_tasks: blockRows.filter((r) => r.declared > 0 && r.blocked < r.declared).length,
    recon: db
      .query<{ as_of: string; source: string; delta_pct: number }, []>(
        "SELECT as_of, source, delta_pct FROM recon ORDER BY as_of DESC LIMIT 5",
      )
      .all(),
  };
}

/**
 * An UPPER BOUND on T3 misses, not a miss count: a long single-goal debugging run
 * and three unrelated one-off turns look identical in the log. Reported as a
 * diagnostic trend, never as a gate input (§3.3).
 */
function countT3Candidates(db: Database): number {
  const turns = db
    .query<{ session_id: string; started_at: string; tid: string | null }, []>(
      "SELECT session_id, started_at, tid FROM turn ORDER BY session_id, started_at",
    )
    .all();
  let candidates = 0;
  let run = 0;
  let session = "";
  for (const t of turns) {
    if (t.session_id !== session) {
      session = t.session_id;
      run = 0;
    }
    if (t.tid === null) {
      run += 1;
      if (run === 3) candidates += 1;
    } else run = 0;
  }
  return candidates;
}

/**
 * Candidate bucket splits with their leave-one-out pinball deltas.
 *
 * Splits are RECORDED, not applied: `bucket_def` gains a row only when a
 * cross-validated test shows the split reduces predictive loss, and at Phase 1's
 * sample sizes that test cannot pass honestly. Recording the deltas is what makes
 * the eventual decision evidence-driven rather than a guess about which dimension
 * "obviously" matters.
 *
 * UNIT-GUARDED (v15), on the same rule as every other scoring surface. The baseline
 * loss below is `pinball(actual, cal_p50)` — a Work-CET actual against the band's
 * `cal_*` — so it is defined only where {@link bandUnscorable} says `cal_*` really is
 * Work-CET. Unguarded, a corpus of unconverted story-point tasks produced a *global*
 * loss inflated by pure unit confusion and a *split* loss that was not (the
 * leave-one-out leg refits `actual / raw_p50`, i.e. Work-CET-per-point, and multiplies
 * it back through `raw_p50`, so it stays in one unit whatever the estimand). The ratio
 * of the two then read as a near-perfect `pinball_delta` — a confident recommendation
 * to split a calibration bucket on the strength of nothing at all.
 *
 * Dropped rows are dropped BEFORE the `n >= 20` floor, so a corpus that is entirely
 * unconvertible yields no candidates rather than candidates from a thinner sample: the
 * floor exists to say "not enough evidence", and unit-confused rows are not evidence.
 */
function splitCandidates(
  db: Database,
  refModel: string,
  estimand: string,
  gate: number,
): RetroReport["splits"] {
  const rows = db
    .query<
      { kind: string; actual: number; cal_p50: number; raw_p50: number; estimand: string; cal_p50_wcet: number; raw_p50_wcet: number; wcet_rate_src: string },
      [string, string]
    >(
      `SELECT t.kind AS kind, o.actual_wcet_at_epoch AS actual,
              e.cal_p50_wcet AS cal_p50, e.raw_p50_wcet AS raw_p50,
              e.estimand AS estimand, e.cal_p50_wcet AS cal_p50_wcet, e.raw_p50_wcet AS raw_p50_wcet,
              e.wcet_rate_src AS wcet_rate_src
         FROM v_outcome_current o
         JOIN estimate e ON e.eid = o.eid_at_start
         JOIN task t ON t.tid = o.tid
        WHERE o.final_status = 'completed' AND o.actual_wcet_at_epoch IS NOT NULL
          AND e.ref_model = ? AND e.estimand = ? AND e.raw_p50_wcet > 0`,
    )
    .all(refModel, estimand)
    .filter((r) => !bandUnscorable(r));
  if (rows.length < 20) return [];

  const globalLoss = meanOf(rows.map((r) => pinball(r.actual, r.cal_p50, 0.5))) ?? 0;
  const byKind = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byKind.get(r.kind);
    if (list === undefined) byKind.set(r.kind, [r]);
    else list.push(r);
  }
  const out: RetroReport["splits"] = [];
  for (const [kind, group] of byKind) {
    if (group.length < 5) continue;
    // Leave-one-out: refit the level's median velocity without the held-out row and
    // score it. Nothing subtler is warranted at n ~ 20.
    const losses: number[] = [];
    for (let i = 0; i < group.length; i += 1) {
      const held = group[i]!;
      const rest = group.filter((_, j) => j !== i).map((r) => r.actual / r.raw_p50);
      if (rest.length === 0) continue;
      rest.sort((a, b) => a - b);
      const med = rest[Math.floor(rest.length / 2)]!;
      losses.push(pinball(held.actual, held.raw_p50 * med, 0.5));
    }
    const splitLoss = meanOf(losses);
    if (splitLoss === null) continue;
    const delta = globalLoss > 0 ? (globalLoss - splitLoss) / globalLoss : 0;
    if (Math.abs(delta) >= gate) out.push({ dimension: "kind", level: kind, n: group.length, pinball_delta: delta });
  }
  return out;
}

// ---------------------------------------------------------------------------
// write-back
// ---------------------------------------------------------------------------

function writeBack(
  db: Database,
  asOf: string,
  buckets: readonly BucketFit[],
  scoring: ScoringPanel,
  splits: RetroReport["splits"],
  estimand: string,
  alerts: readonly string[],
): { refclass: number; calib_run: number } {
  let refclassRows = 0;
  // `refclass` is append-only and keyed on (as_of, bucket, estimator_family, ref_model,
  // estimand), and `isoNow` truncates to the second — so two retros at the same `as_of`
  // (trivially: `--as-of` twice, or two unflagged runs inside one second) collide. Left
  // to the driver that surfaces as a raw SQLITE_CONSTRAINT, which `verb()` now maps to
  // exit 2 but with the driver's message and no useful remedy. Say it ourselves, with
  // the append path named, and say it BEFORE the transaction so nothing is half-written.
  // Deliberately NOT an upsert, unlike the `calib_run` row below: a snapshot is
  // evidence of what the multipliers were at an instant, and overwriting one rewrites
  // history that `est open` has already issued bands against.
  // The check is on the FULL key, not on `as_of` alone: re-running a retro at the same
  // instant under a different `ref_model` or `estimand` writes a different snapshot and
  // has always been legal (§4.2 delta 3), and rejecting that would be a new refusal
  // rather than a clearer one.
  const clash = db.query<{ n: number }, [string, string, string, string, string]>(
    `SELECT COUNT(*) AS n FROM refclass
      WHERE as_of = ? AND bucket = ? AND estimator_family = ? AND ref_model = ? AND estimand = ?`,
  );
  for (const b of buckets) {
    const n = clash.get(asOf, b.bucket, b.estimator_family, b.ref_model, b.estimand)?.n ?? 0;
    if (n > 0) {
      throw new InvariantError(
        `a refclass snapshot already exists at as_of ${asOf} for bucket ${b.bucket} ` +
          `(${b.estimator_family}, ${b.ref_model}, ${b.estimand})`,
        "pass a later `--as-of`, or run `est retro --dry-run` to recompute the panel without writing",
      );
    }
  }
  db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO refclass (as_of, bucket, estimator_family, n, n_eff, med_log_v, iqr_log_v,
                             shrink_w, shrink_k, half_life_days, mult_p50, mult_p90,
                             boot_lo_p50, boot_hi_p50, boot_lo_p90, boot_hi_p90,
                             method, ref_model, estimand, params_json)
       VALUES ($as_of, $bucket, $family, $n, $n_eff, $med, $iqr, $shrink_w, $shrink_k, $hl,
               $m50, $m90, $bl50, $bh50, $bl90, $bh90, $method, $ref_model, $estimand, $params)`,
    );
    for (const b of buckets) {
      stmt.run({
        $as_of: asOf,
        $bucket: b.bucket,
        $family: b.estimator_family,
        $n: b.n,
        $n_eff: b.n_eff,
        $med: b.med_log_v,
        $iqr: b.iqr_log_v,
        $shrink_w: b.shrink_w,
        $shrink_k: b.shrink_k,
        $hl: b.half_life_days,
        $m50: b.mult_p50,
        $m90: b.mult_p90,
        $bl50: b.boot_lo_p50,
        $bh50: b.boot_hi_p50,
        $bl90: b.boot_lo_p90,
        $bh90: b.boot_hi_p90,
        $method: b.method,
        // The UNIT, and it is in the KEY (schema v6): a snapshot read back against a
        // different normaliser silently means something else (§4.2 delta 3), so
        // `newestRefclass` filters on this pair rather than trusting the newest row.
        // It stays in params_json too — that is where pre-v6 snapshots kept it, and
        // where the v5 -> v6 migration backfills the column from.
        $ref_model: b.ref_model,
        $estimand: b.estimand,
        $params: JSON.stringify({ ref_model: b.ref_model, cold_start_n: COLD_START_N }),
      } as never);
      refclassRows += 1;
    }
    db.query(
      `INSERT INTO calib_run (as_of, n_outcomes, estimand, pinball_p50, pinball_p90, log_score,
                              coverage_p50, coverage_p90, cov_lo, cov_hi,
                              baseline_pinball, active_model_won, splits_json, notes)
       VALUES ($as_of, $n, $estimand, $p50, $p90, $ls, $c50, $c90, $lo, $hi,
               NULL, NULL, $splits, $notes)
       ON CONFLICT(as_of) DO UPDATE SET
         n_outcomes = excluded.n_outcomes, pinball_p50 = excluded.pinball_p50,
         pinball_p90 = excluded.pinball_p90, log_score = excluded.log_score,
         coverage_p50 = excluded.coverage_p50, coverage_p90 = excluded.coverage_p90,
         cov_lo = excluded.cov_lo, cov_hi = excluded.cov_hi,
         splits_json = excluded.splits_json, notes = excluded.notes`,
    ).run({
      $as_of: asOf,
      $n: scoring.n_scored,
      $estimand: estimand,
      $p50: scoring.pinball_p50,
      $p90: scoring.pinball_p90,
      $ls: scoring.log_score,
      $c50: scoring.coverage_p50,
      $c90: scoring.coverage_p90,
      $lo: scoring.cov_lo,
      $hi: scoring.cov_hi,
      // baseline_pinball / active_model_won stay NULL: the three-clock model issues
      // NO active-time band in Phase 1 (§7.3), so there is nothing to compare and a
      // fabricated comparison would be worse than an honest gap.
      $splits: JSON.stringify({ candidates: splits, applied: [], note: "splits are recorded, never auto-applied (§4.5)" }),
      $notes: alerts.length === 0 ? null : alerts.join("; "),
    } as never);
  }).immediate();
  return { refclass: refclassRows, calib_run: 1 };
}

// ---------------------------------------------------------------------------
// `est board`
// ---------------------------------------------------------------------------

export const BOARD_COLUMNS = [
  "Estimating",
  "In Progress",
  "Pending Verification",
  "Done (7d)",
  "Abandoned",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/**
 * One entry of a workflow task's per-phase strip (P2.7, §7.1). `v_phase_actual`
 * supplies the EXECUTION side (which agents actually ran, how much they cost, and
 * the worst-wins `phase_conf` badge); `v_block_accuracy` supplies the ESTIMATE side
 * (the per-block band from `est block`, if one was declared). A phase can appear
 * from either source alone — an agent ran with no declared block, or a block was
 * declared for a phase nothing has reached yet — so both are optional and merged by
 * `phase_idx`.
 */
export interface BoardPhase {
  phase_idx: number;
  title: string;
  /** Worst-wins across the phase's agents; null = no agent has run yet. */
  phase_conf: "exact" | "inferred" | "unmapped" | null;
  actual_wcet: number | null;
  n_agents: number;
  /**
   * From `est block`, if one was declared for this phase **and it is in Work-CET**;
   * null otherwise — including when a block WAS declared but in story points, which is
   * what {@link BoardPhase.blocks_in_points} distinguishes from "none declared".
   */
  block_p50: number | null;
  block_p90: number | null;
  /**
   * The declared block band as AUTHORED, in story points, when
   * {@link BoardPhase.blocks_in_points}; null for a Work-CET block band, which lives in
   * `block_p50`/`block_p90` instead.
   *
   * Two fields rather than one pair reused, for the reason `wcet` and `points` are two
   * objects in {@link import("./burn.ts").BurnActive}: a points figure in a field named
   * after Work-CET is an `8` that reads as eight tokens beside an actual in the
   * hundreds. Naming the unit in the key is what makes that impossible.
   */
  block_points_p50: number | null;
  block_points_p90: number | null;
  /**
   * `estimate_block` rows for this phase are in STORY POINTS, so `actual_wcet` (always
   * Work-CET) and the declared block band are in different units and NO comparison
   * between them is defined — no ratio, no delta, no "over/under".
   *
   * This is `blocksInWcet(estimand)` inverted, and deliberately the estimand rather
   * than `v_block_accuracy.unit_mismatch`: the view's column is 1 only once an actual
   * has arrived (`estimand = 'story_point' AND pa.wcet IS NOT NULL`), which is the
   * right refusal for the view's own `actual_wcet` column but would leave a declared
   * points block sitting in `block_p50` — a Work-CET-named field — for every phase
   * nothing has run in yet. `est block` stores what it was given and nothing ever
   * converts an `estimate_block` row, so under points the block side is points
   * forever, actual or no actual.
   */
  blocks_in_points: boolean;
  block_exp_agents: number | null;
}

/** P2.2's check-back forecast, carried on In Progress cards only (§7.1's one exception
 *  to "the statusline is where check-back lives" — the board has room for the p90). */
export interface BoardCheckBack {
  p50_s: number;
  p90_s: number;
  eta_model: string | null;
  /** True while the model has not yet cleared `eta_min_pinball_gain` (§7.3) — the
   *  board's `?` marker, same rule as the statusline's. */
  probation: boolean;
}

export interface BoardCard {
  tid: string;
  subject: string;
  kind: string;
  status: string;
  /**
   * The band in WORK-CET, the same unit as `consumed_wcet` — and **0 when there is
   * none**, which since v15 covers two cases: no estimate at all, and a band issued in
   * story points that no points→Work-CET rate can convert (see `points` below). Both
   * are "absent", and 0 has always rendered as absent here; what these two fields must
   * never hold is a POINTS figure, because every renderer divides `consumed_wcet` by
   * them and a bar drawn across two units is a picture of nothing.
   */
  cal_p50: number;
  cal_p90: number;
  uncalibrated: boolean;
  /** Non-null EXACTLY for a band issued under `config.estimand = 'story_point'`:
   *  the points band, and whatever the bridge back to Work-CET had to offer
   *  ({@link bandUnit}). Null for every Work-CET band. */
  points: BandPoints | null;
  consumed_wcet: number;
  wcet_main: number;
  wcet_sub: number;
  phase_conf: string | null;
  finalized_at: string | null;
  started_at: string | null;
  /** UNION-derived active seconds (§7.3 clock 2): `outcome.active_s` once finalized,
   *  `burn_cache.active_s` while open, null when neither has a figure yet. */
  active_s: number | null;
  /** Elapsed wall-clock seconds: `outcome.wall_s` once finalized, `now - started_at`
   *  while open (null before the task has started). Never blended with `active_s`
   *  (§7.3's "three clocks, never blended"). */
  wall_s: number | null;
  /** `burn_cache.proj_total_wcet` — the crude ccusage-pattern linear projection.
   *  Null once a task leaves `burn_cache` (terminal) or before the first sweep. */
  proj_total_wcet: number | null;
  /** Populated ONLY for `status === 'in_progress'` cards with a fitted forecast. */
  check_back: BoardCheckBack | null;
  /** Empty for a non-workflow task. Ordered by `phase_idx`. */
  phases: BoardPhase[];
}

export interface BoardReport {
  as_of: string;
  columns: Array<{ column: BoardColumn; cards: BoardCard[] }>;
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

interface PhaseActualRow {
  tid: string;
  phase_idx: number;
  title: string | null;
  phase_conf: "exact" | "inferred" | "unmapped" | null;
  wcet: number | null;
  n_agents: number;
}

interface BlockAccuracyRow {
  tid: string;
  phase_idx: number;
  title: string;
  p50_wcet: number;
  p90_wcet: number;
  exp_agents: number;
  /** `estimate.estimand`, joined in: `v_block_accuracy` does not project it, and the
   *  strip cannot decide what unit `p50_wcet`/`p90_wcet` are in without it. */
  estimand: string;
  /** The view's OWN refusal, carried rather than recomputed — 1 when it declined to
   *  publish an actual for this block row on unit grounds. {@link phaseStrips} honours
   *  it directly: the strip must never render a comparison the view nulled. */
  unit_mismatch: number;
}

/**
 * Bound on the tids bound into one `IN (...)`. See {@link phaseStrips}.
 *
 * Comfortably under every ceiling in the stack — SQLite's own
 * `SQLITE_MAX_VARIABLE_NUMBER` (32,766 on a modern build) and the higher limit
 * bun:sqlite enforces — because the point is not to sit just inside the limit but to
 * make the query's cost independent of how many tasks the corpus has accumulated.
 */
const PHASE_STRIP_CHUNK = 500;

/**
 * Batched, NOT per-card: one query each for `v_phase_actual` and `v_block_accuracy`
 * over every tid the board is about to render, merged by `(tid, phase_idx)` in JS. A
 * per-card query here would be an N+1 over a view stack several joins deep — cheap
 * once, not cheap 20-200 times per render (P2.7's throttle exists for the render as a
 * whole, not to license doing this the expensive way inside it).
 *
 * **Batched in CHUNKS, though, not in one unbounded `IN (...)`.** The tid list is the
 * board's pre-limit row set — `opts.limit` is applied later, per column, at card
 * assembly — so it grows with the corpus rather than with what is rendered. One
 * parameter per tid means that at some corpus size both queries start THROWING, and
 * the failure mode is not a slow board: it is every render turning into
 * `board_render_failed`, permanently, the moment the corpus crosses a line nothing
 * warns about.
 */
function phaseStrips(db: Database, tids: readonly string[]): Map<string, BoardPhase[]> {
  const out = new Map<string, BoardPhase[]>();
  if (tids.length === 0) return out;

  const byTid = new Map<string, Map<number, BoardPhase>>();
  const get = (tid: string, idx: number): BoardPhase => {
    let forTid = byTid.get(tid);
    if (forTid === undefined) {
      forTid = new Map();
      byTid.set(tid, forTid);
    }
    let entry = forTid.get(idx);
    if (entry === undefined) {
      entry = {
        phase_idx: idx,
        title: `phase ${idx}`,
        phase_conf: null,
        actual_wcet: null,
        n_agents: 0,
        block_p50: null,
        block_p90: null,
        block_points_p50: null,
        block_points_p90: null,
        blocks_in_points: false,
        block_exp_agents: null,
      };
      forTid.set(idx, entry);
    }
    return entry;
  };

  for (let i = 0; i < tids.length; i += PHASE_STRIP_CHUNK) {
    const chunk = tids.slice(i, i + PHASE_STRIP_CHUNK);
    for (const r of db
      .query<PhaseActualRow, string[]>(
        `SELECT tid, phase_idx, title, phase_conf, wcet, n_agents
           FROM v_phase_actual WHERE tid IN (${placeholders(chunk.length)})`,
      )
      .all(...chunk)) {
      if (r.tid === null) continue;
      const p = get(r.tid, r.phase_idx);
      if (r.title !== null) p.title = r.title;
      // WORST-WINS on collision, not last-wins. `v_phase_actual` groups by
      // `(run_id, wf_launch_id, phase_idx)`, so a task that launched the SAME workflow
      // twice contributes two rows for one `phase_idx` and they merge here. The view's
      // own aggregate is `MAX(phase_conf)` for the stated reason — "a phase is only as
      // trustworthy as its least-trustworthy agent" — and an overwrite would let the
      // second run's `exact` erase the first's `unmapped`. The card's `phase_conf` is
      // read off this strip, so the two can never disagree either.
      if (r.phase_conf !== null && (p.phase_conf === null || r.phase_conf > p.phase_conf)) {
        p.phase_conf = r.phase_conf;
      }
      p.actual_wcet = r.wcet;
      p.n_agents = r.n_agents;
    }

    for (const r of db
      .query<BlockAccuracyRow, string[]>(
        // `estimand` is joined in because `v_block_accuracy` does not project it and the
        // strip cannot route `p50_wcet`/`p90_wcet` to the right field without it;
        // `unit_mismatch` comes along so the refusal the view already made is CARRIED
        // rather than re-derived and possibly disagreed with.
        `SELECT ba.tid AS tid, ba.phase_idx AS phase_idx, ba.title AS title,
                ba.p50_wcet AS p50_wcet, ba.p90_wcet AS p90_wcet, ba.exp_agents AS exp_agents,
                ba.unit_mismatch AS unit_mismatch, e.estimand AS estimand
           FROM v_block_accuracy ba
           JOIN estimate e ON e.eid = ba.eid
          WHERE ba.tid IN (${placeholders(chunk.length)})`,
      )
      .all(...chunk)) {
      const p = get(r.tid, r.phase_idx);
      // A declared block's title is the authored one; prefer it only when execution
      // hasn't already supplied `workflow_phase.title` (the two should agree, but the
      // authored title is available even before any agent for this phase has run).
      if (p.actual_wcet === null && p.n_agents === 0) p.title = r.title;
      // THE UNIT FORK, and the reason this is not a straight assignment. The board was
      // reading Work-CET actuals from `v_phase_actual` and raw block quantiles from
      // `v_block_accuracy` and merging them into one entry — which REASSEMBLED, out of
      // two halves, exactly the comparison `v_block_accuracy` had refused to publish
      // (it nulls its own `actual_wcet` and raises `unit_mismatch` under points). The
      // view's null is not an omission to be routed around; it is the answer.
      //
      // BOTH conditions, not either: `blocksInWcet` is the shared rule and covers the
      // phase nothing has run in yet, while `unit_mismatch` is the view's own verdict on
      // this exact row. If the view ever refuses for a reason the estimand alone does not
      // capture, the board follows it instead of arguing with it.
      p.block_exp_agents = r.exp_agents;
      if (blocksInWcet(r.estimand) && r.unit_mismatch === 0) {
        p.block_p50 = r.p50_wcet;
        p.block_p90 = r.p90_wcet;
      } else {
        p.blocks_in_points = true;
        p.block_points_p50 = r.p50_wcet;
        p.block_points_p90 = r.p90_wcet;
        p.block_p50 = null;
        p.block_p90 = null;
      }
    }
  }

  for (const [tid, forTid] of byTid) {
    out.set(
      tid,
      [...forTid.values()].sort((a, b) => a.phase_idx - b.phase_idx),
    );
  }
  return out;
}

/** Step one of the board read: identity, placement and the two clocks that live on
 *  `task`/`outcome`. Everything priced or aggregated arrives in step two, for the
 *  bounded tid set only — see {@link board}. */
interface PlacedRow {
  tid: string;
  subject: string;
  kind: string;
  status: string;
  column_name: BoardColumn;
  finalized_at: string | null;
  started_at: string | null;
  outcome_active_s: number | null;
  outcome_wall_s: number | null;
}

interface EstimateRow {
  tid: string;
  cal_p50: number;
  cal_p90: number;
  uncalibrated: number;
  // v15: the unit the two columns above are actually in. `cal_*` hold POINTS for a
  // band opened while no points→Work-CET rate existed, so {@link bandUnit} — the one
  // rule `est burn` and the statusline also read — needs the raw band, the anchor and
  // the calibration keys to say which. Projected here rather than re-queried per card.
  estimand: string;
  raw_p50_wcet: number;
  raw_p90_wcet: number;
  sp_anchor_id: string | null;
  refclass_as_of: string | null;
  ref_model: string;
  estimator_model: string;
  /** v19: the STORED conversion fact {@link bandUnit} reads instead of `cal != raw`. */
  wcet_rate: number | null;
  wcet_rate_src: string;
}

interface ActualRow {
  tid: string;
  consumed_wcet: number;
  wcet_main: number;
  wcet_sub: number;
}

interface BurnRow {
  tid: string;
  live_active_s: number | null;
  proj_total_wcet: number | null;
  check_back_p50_s: number | null;
  check_back_p90_s: number | null;
  eta_model: string | null;
  eta_probation: number | null;
}

/**
 * Placement and ranking, over `task` + `task_scope` + `outcome` and NOTHING ELSE.
 *
 * The column rule lives HERE rather than in TypeScript because it is what bounds the
 * query: `ROW_NUMBER()` can only cut each column at `limit` if it knows which column a
 * task is in, and cutting before the expensive joins is the entire point. It is the
 * same rule the previous JS pass applied, expressed once — a status a column does not
 * name yields NULL and drops out, exactly as `col === null` used to.
 *
 * `Done (7d)` is the only column with a recency clause. `Abandoned` deliberately keeps
 * none: it shows the `limit` most recent abandonments however old they are, and adding
 * a seven-day filter there would silently empty a column that is supposed to be a
 * standing record.
 */
function boardCardsSql(nColumns: number): string {
  return `
WITH placed AS (
  SELECT t.tid AS tid, s.subject AS subject, t.kind AS kind, t.status AS status,
         t.started_at AS started_at, o.finalized_at AS finalized_at,
         o.active_s AS outcome_active_s, o.wall_s AS outcome_wall_s,
         CASE
           WHEN t.status = 'completed' AND o.finalized_at >= ?  THEN 'Done (7d)'
           WHEN t.status IN ('abandoned','deleted')             THEN 'Abandoned'
           WHEN t.status = 'pending_verification'               THEN 'Pending Verification'
           WHEN t.status = 'in_progress'                        THEN 'In Progress'
           WHEN t.status = 'estimating'                         THEN 'Estimating'
         END AS column_name,
         COALESCE(o.finalized_at, t.created_at) AS sort_key
    FROM task t
    JOIN v_scope_current s ON s.tid = t.tid
    LEFT JOIN v_outcome_current o ON o.tid = t.tid
)
SELECT tid, subject, kind, status, column_name, finalized_at, started_at,
       outcome_active_s, outcome_wall_s
  FROM (SELECT placed.*,
               ROW_NUMBER() OVER (PARTITION BY column_name
                                  ORDER BY sort_key DESC, tid DESC) AS rn
          FROM placed
         WHERE column_name IS NOT NULL
           AND column_name IN (${placeholders(nColumns)}))
 WHERE rn <= ?
 ORDER BY sort_key DESC, tid DESC`;
}

/**
 * The Phase 1 board: terminal/JSON read model (P1.8), extended in Phase 2 (P2.7)
 * with everything `board.html`/`board.md` render — the per-phase strip, the
 * block-vs-actual figures and the check-back forecast — so that `--json` prints
 * EXACTLY the view model the file renderer draws from (P2.7: "which is what makes
 * the renderer testable without parsing HTML"). Every field added here is additive;
 * no P1.8 field changed shape, so existing `--json` consumers see only new keys.
 *
 * **BOUNDED FIRST, then priced.** The read runs in two steps and the order is the whole
 * performance story. Step one places and ranks every task over `task` + `task_scope` +
 * `outcome` alone and cuts each column at `limit` in SQL; step two fetches the priced
 * and aggregated columns — `v_task_actual` (a GROUP BY over the priced request join),
 * `v_phase_actual`, `estimate`, `burn_cache` — for the ≤ `limit` × 5 tids that survived.
 *
 * The other order was what P1.9 measured at 126 ms and created `burn_cache` to abolish,
 * reintroduced on the WRITER side: since P2.7 this runs at the tail of every sweep,
 * including the PostToolUse micro-sweep, so its cost is paid on Craig's hot path at
 * whatever the corpus has grown to — and it was linear in every request ever recorded,
 * for a page that displays a few dozen cards. The bounded form is linear in TASKS over
 * three small tables and constant in the aggregates.
 */
export function board(
  db: Database,
  opts: { column?: string | null; limit?: number; now?: Date } = {},
): BoardReport {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 20;
  const sevenDaysAgo = isoNow(new Date(now.getTime() - 7 * 86_400_000));

  // The column filter is pushed into SQL rather than applied to the finished report:
  // `est board --column "In Progress"` should not rank, fetch and price the other four.
  const wanted = opts.column ?? null;
  const columns = BOARD_COLUMNS.filter(
    (c) => wanted === null || c.toLowerCase().startsWith(wanted.toLowerCase()),
  );
  if (columns.length === 0) return { as_of: isoNow(now), columns: [] };

  const rows = db
    .query<PlacedRow, (string | number)[]>(boardCardsSql(columns.length))
    .all(sevenDaysAgo, ...columns, limit);

  const tids = rows.map((r) => r.tid);
  const strips = phaseStrips(db, tids);
  const estimates = new Map<string, EstimateRow>();
  const actuals = new Map<string, ActualRow>();
  const burns = new Map<string, BurnRow>();
  for (const chunk of chunked(tids, PHASE_STRIP_CHUNK)) {
    const q = placeholders(chunk.length);
    for (const r of db
      .query<EstimateRow, string[]>(
        `SELECT tid,
                COALESCE(cal_p50_wcet, 0) AS cal_p50, COALESCE(cal_p90_wcet, 0) AS cal_p90,
                CASE WHEN refclass_as_of IS NULL THEN 1 ELSE 0 END AS uncalibrated,
                estimand, raw_p50_wcet, raw_p90_wcet, sp_anchor_id, refclass_as_of,
                ref_model, estimator_model, wcet_rate, wcet_rate_src
           FROM estimate
          WHERE eid IN (SELECT MAX(eid) FROM estimate WHERE tid IN (${q}) GROUP BY tid)`,
      )
      .all(...chunk)) {
      estimates.set(r.tid, r);
    }
    for (const r of db
      .query<ActualRow, string[]>(
        `SELECT tid, COALESCE(wcet, 0) AS consumed_wcet,
                COALESCE(wcet_main, 0) AS wcet_main, COALESCE(wcet_sub, 0) AS wcet_sub
           FROM v_task_actual WHERE tid IN (${q})`,
      )
      .all(...chunk)) {
      actuals.set(r.tid, r);
    }
    for (const r of db
      .query<BurnRow, string[]>(
        `SELECT tid, active_s AS live_active_s, proj_total_wcet,
                check_back_p50_s, check_back_p90_s, eta_model, eta_probation
           FROM burn_cache WHERE tid IN (${q})`,
      )
      .all(...chunk)) {
      burns.set(r.tid, r);
    }
  }

  const byColumn = new Map<BoardColumn, BoardCard[]>();
  for (const col of columns) byColumn.set(col, []);
  // ONE bridge lookup per (bucket, estimator family, ref_model, estimand) across the
  // whole board, not one per card. `pointsToWcet` costs a `COUNT(*)` over `v_velocity`,
  // and the file renderer draws up to 200 cards per column at the tail of every sweep —
  // including the PostToolUse micro-sweep, on Craig's hot path. The rate does not vary
  // per card; only the band it is applied to does, which is why `bandUnit` takes the
  // resolver rather than the answer.
  const rateCache = new Map<string, PointsRate>();
  const resolveRate = (k: PointsRateKey): PointsRate => {
    // The ANCHOR is in the cache key because it is in `PointsRateKey`. A board mixing
    // v1 and v2 cards would otherwise serve whichever anchor's rate was resolved first
    // to every card after it — the memo turning a per-band question into a per-board
    // answer, which is the one thing a cache must not do. `undefined` cannot occur here
    // (`bandUnit` always passes the stored `sp_anchor_id`), so `??` only distinguishes
    // the NULL-anchor rows, which resolve to no rate anyway.
    const ck = `${k.bucket}|${k.estimatorFamily}|${k.refModel}|${k.estimand}|${k.anchorId ?? " "}`;
    let hit = rateCache.get(ck);
    if (hit === undefined) {
      hit = pointsToWcet(db, k);
      rateCache.set(ck, hit);
    }
    return hit;
  };
  const unitOf = (est: EstimateRow): BandUnit =>
    bandUnit(
      db,
      {
        estimand: est.estimand,
        raw_p50_wcet: est.raw_p50_wcet,
        raw_p90_wcet: est.raw_p90_wcet,
        cal_p50_wcet: est.cal_p50,
        cal_p90_wcet: est.cal_p90,
        sp_anchor_id: est.sp_anchor_id,
        refclass_as_of: est.refclass_as_of,
        ref_model: est.ref_model,
        estimator_model: est.estimator_model,
        wcet_rate: est.wcet_rate,
        wcet_rate_src: est.wcet_rate_src,
      },
      resolveRate,
    );
  for (const r of rows) {
    const burn = burns.get(r.tid);
    const est = estimates.get(r.tid);
    const actual = actuals.get(r.tid);
    const phases = strips.get(r.tid) ?? [];
    const activeS = r.outcome_active_s ?? burn?.live_active_s ?? null;
    let wallS: number | null = r.outcome_wall_s ?? null;
    if (wallS === null && r.started_at !== null) {
      const started = Date.parse(r.started_at);
      if (Number.isFinite(started)) wallS = Math.max(0, Math.round((now.getTime() - started) / 1000));
    }
    const checkBack: BoardCheckBack | null =
      r.status === "in_progress" &&
      burn !== undefined &&
      burn.check_back_p50_s !== null &&
      burn.check_back_p90_s !== null
        ? {
            p50_s: burn.check_back_p50_s,
            p90_s: burn.check_back_p90_s,
            eta_model: burn.eta_model,
            probation: burn.eta_probation !== 0,
          }
        : null;
    const unit = est === undefined ? null : unitOf(est);
    byColumn.get(r.column_name)!.push({
      tid: r.tid,
      subject: r.subject,
      kind: r.kind,
      status: r.status,
      // `?? 0` twice over: no estimate, or a points band with no conversion. Both mean
      // "no Work-CET band", and `burnZone`'s `> 0` guards already read 0 as no claim.
      cal_p50: unit?.p50 ?? 0,
      cal_p90: unit?.p90 ?? 0,
      uncalibrated: est === undefined || Boolean(est.uncalibrated),
      points: unit?.points ?? null,
      consumed_wcet: actual?.consumed_wcet ?? 0,
      wcet_main: actual?.wcet_main ?? 0,
      wcet_sub: actual?.wcet_sub ?? 0,
      // Worst-wins across the task's phases, read off the strip that was just fetched
      // rather than from a correlated `MAX(phase_conf)` per task. Same aggregate, same
      // source view, one query instead of one per card — and it cannot drift from what
      // the chips render, because it IS what the chips render.
      phase_conf: worstPhaseConf(phases),
      finalized_at: r.finalized_at,
      started_at: r.started_at,
      active_s: activeS,
      wall_s: wallS,
      proj_total_wcet: burn?.proj_total_wcet ?? null,
      check_back: checkBack,
      phases,
    });
  }

  return {
    as_of: isoNow(now),
    columns: columns.map((column) => ({ column, cards: byColumn.get(column)! })),
  };
}

/** `MAX(phase_conf)` over a task's phases: the three labels sort 'exact' < 'inferred' <
 *  'unmapped', so the lexical maximum is the CONSERVATIVE one (see `v_phase_actual`). */
function worstPhaseConf(phases: readonly BoardPhase[]): string | null {
  let worst: string | null = null;
  for (const p of phases) {
    if (p.phase_conf === null) continue;
    if (worst === null || p.phase_conf > worst) worst = p.phase_conf;
  }
  return worst;
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

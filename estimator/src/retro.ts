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
import { COLD_START_N, InvariantError, isoNow } from "./tasks.ts";
import { priceFamily } from "./prices.ts";

/** The G-ATTR bar. Below this, the historical corpus is not calibration-grade. */
export const ATTR_COVERAGE_GATE = 0.7;

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
  t4_note: string;
  scope_declared_pct: number | null;
  identity_planted_pct: number | null;
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
  written: { refclass: number; calib_run: number };
}

interface VelocityRow {
  bucket: string;
  estimator_model: string;
  ref_model: string;
  estimand: string;
  velocity_raw: number | null;
  velocity_cal: number | null;
  finalized_at: string;
  wcet_main: number;
  wcet_sub: number;
  wcet_aux: number;
  wcet_task_effort: number;
  exp_agents: number;
  n_agents: number;
}

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
  opts: { asOf?: Date; dryRun?: boolean } = {},
): RetroReport {
  const now = opts.asOf ?? new Date();
  const asOf = isoNow(now);
  const dryRun = opts.dryRun === true;
  const refModel = getConfig(db, "ref_model") ?? "claude-sonnet-4-5";
  const estimand = getConfig(db, "estimand") ?? "work_cet";
  const shrinkK = Number.parseFloat(getConfig(db, "shrink_k") ?? "10");
  const halfLife = Number.parseFloat(getConfig(db, "velocity_half_life_days") ?? "30");
  const resamples = Number.parseInt(getConfig(db, "boot_resamples") ?? "200", 10);
  const splitGate = Number.parseFloat(getConfig(db, "split_min_pinball_gain") ?? "0.02");

  const rows = db
    .query<VelocityRow, [string, string]>(
      "SELECT * FROM v_velocity WHERE ref_model = ? AND estimand = ?",
    )
    .all(refModel, estimand);

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

  let written = { refclass: 0, calib_run: 0 };
  if (!dryRun) {
    written = writeBack(db, asOf, buckets, scoring, splits, estimand, alerts);
  }

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
}

function scorePanel(db: Database, refModel: string, estimand: string): ScoringPanel {
  const scored = db
    .query<ScoredOutcome, [string, string]>(
      `SELECT o.tid AS tid, o.actual_wcet_at_epoch AS actual,
              e.raw_p50_wcet AS raw_p50, e.cal_p50_wcet AS cal_p50, e.cal_p90_wcet AS cal_p90,
              o.wcet_main AS wcet_main, o.wcet_sub AS wcet_sub,
              e.exp_agents AS exp_agents, o.n_agents AS n_agents,
              o.parallelism_factor AS parallelism_factor
         FROM v_outcome_current o
         JOIN estimate e ON e.eid = o.eid_at_start
        WHERE o.final_status = 'completed' AND o.censored = 0
          AND o.actual_wcet_at_epoch IS NOT NULL
          AND e.ref_model = ? AND e.estimand = ?`,
    )
    .all(refModel, estimand);

  const p50Loss = scored.map((s) => pinball(s.actual, s.cal_p50, 0.5));
  const p90Loss = scored.map((s) => pinball(s.actual, s.cal_p90, 0.9));
  const logs = scored.map((s) => logScore(s.actual, s.cal_p50, s.cal_p90));
  const under50 = scored.filter((s) => s.actual <= s.cal_p50).length;
  const under90 = scored.filter((s) => s.actual <= s.cal_p90).length;
  const cov = scored.length > 0 ? jeffreysInterval(under90, scored.length, 0.9) : null;

  // Refinements: mid-task predictive skill, reported BESIDE — never blended into —
  // baseline calibration. This is where "the cone of uncertainty narrows" becomes a
  // measurement instead of a slogan.
  const refinements = db
    .query<
      { tid: string; actual: number; cal_p50: number; base_p50: number },
      [string, string]
    >(
      `SELECT o.tid AS tid, o.actual_wcet_at_epoch AS actual,
              e.cal_p50_wcet AS cal_p50, b.cal_p50_wcet AS base_p50
         FROM v_outcome_current o
         JOIN estimate b ON b.eid = o.eid_at_start
         JOIN estimate e ON e.tid = o.tid AND e.reason = 'refinement'
        WHERE o.final_status = 'completed' AND o.actual_wcet_at_epoch IS NOT NULL
          AND b.ref_model = ? AND b.estimand = ?`,
    )
    .all(refModel, estimand);
  const refPinball = refinements.map((r) => pinball(r.actual, r.cal_p50, 0.5));
  const moved = refinements.filter(
    (r) => Math.abs(r.cal_p50 - r.actual) < Math.abs(r.base_p50 - r.actual),
  ).length;

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
    blocks: blockPanel(db, refModel, estimand),
    origin: {
      velocity_main: meanOf(
        scored.map((s) => (s.raw_p50 > 0 ? s.wcet_main / s.raw_p50 : null)),
      ),
      velocity_sub: meanOf(scored.map((s) => (s.raw_p50 > 0 ? s.wcet_sub / s.raw_p50 : null))),
      exp_agents_residual: meanOf(scored.map((s) => s.n_agents - s.exp_agents)),
      parallelism_p50: meanOf(scored.map((s) => s.parallelism_factor)),
    },
  };
}

/**
 * Block-level vs task-level accuracy — the hypothesis that motivated per-block
 * estimating, TESTED against Craig's own data rather than assumed. If the roll-up
 * does not beat the task band after enough workflow tasks, that is reportable and
 * the requirement can be revisited on evidence (§3.2, §7.4).
 */
function blockPanel(db: Database, refModel: string, estimand: string): ScoringPanel["blocks"] {
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

  const perBlock = db
    .query<{ p50: number; actual: number | null }, []>(
      "SELECT p50_wcet AS p50, actual_wcet AS actual FROM v_block_accuracy WHERE actual_wcet IS NOT NULL",
    )
    .all();

  const rollup = meanOf(rows.map((r) => pinball(r.actual, r.rollup_p50, 0.5)));
  const task = meanOf(rows.map((r) => pinball(r.actual, r.task_p50, 0.5)));
  return {
    n_tasks: rows.length,
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
    t4_note:
      "T4 (the user asked for a budget) is undetectable without a prompt classifier — a known blind spot, stated (§3.3)",
    scope_declared_pct: ratio(scopeChanged?.declared ?? 0, scopeChanged?.total ?? 0),
    identity_planted_pct: ratio(planted?.planted ?? 0, planted?.total ?? 0),
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
 */
function splitCandidates(
  db: Database,
  refModel: string,
  estimand: string,
  gate: number,
): RetroReport["splits"] {
  const rows = db
    .query<{ kind: string; actual: number; cal_p50: number; raw_p50: number }, [string, string]>(
      `SELECT t.kind AS kind, o.actual_wcet_at_epoch AS actual,
              e.cal_p50_wcet AS cal_p50, e.raw_p50_wcet AS raw_p50
         FROM v_outcome_current o
         JOIN estimate e ON e.eid = o.eid_at_start
         JOIN task t ON t.tid = o.tid
        WHERE o.final_status = 'completed' AND o.actual_wcet_at_epoch IS NOT NULL
          AND e.ref_model = ? AND e.estimand = ? AND e.raw_p50_wcet > 0`,
    )
    .all(refModel, estimand);
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

export interface BoardCard {
  tid: string;
  subject: string;
  kind: string;
  status: string;
  cal_p50: number;
  cal_p90: number;
  uncalibrated: boolean;
  consumed_wcet: number;
  wcet_main: number;
  wcet_sub: number;
  phase_conf: string | null;
  finalized_at: string | null;
}

export interface BoardReport {
  as_of: string;
  columns: Array<{ column: BoardColumn; cards: BoardCard[] }>;
}

/**
 * The Phase 1 board: terminal/JSON read model only. The `board.html`/`board.md`
 * renderer stays in Phase 2 as decided (§7.1, §10 Q9); `--html` is the flag it will
 * land under. This verb is a projection over views that already exist, which is why
 * it costs almost nothing to ship with the read path it shares with `est burn`.
 */
export function board(
  db: Database,
  opts: { column?: string | null; limit?: number; now?: Date } = {},
): BoardReport {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 20;
  const sevenDaysAgo = isoNow(new Date(now.getTime() - 7 * 86_400_000));

  const cards = db
    .query<BoardCard & { outcome_status: string | null }, []>(
      `SELECT t.tid AS tid, s.subject AS subject, t.kind AS kind, t.status AS status,
              COALESCE(e.cal_p50_wcet, 0) AS cal_p50, COALESCE(e.cal_p90_wcet, 0) AS cal_p90,
              CASE WHEN e.refclass_as_of IS NULL THEN 1 ELSE 0 END AS uncalibrated,
              COALESCE(a.wcet, 0) AS consumed_wcet,
              COALESCE(a.wcet_main, 0) AS wcet_main, COALESCE(a.wcet_sub, 0) AS wcet_sub,
              (SELECT MAX(phase_conf) FROM v_phase_actual p WHERE p.tid = t.tid) AS phase_conf,
              o.finalized_at AS finalized_at, o.final_status AS outcome_status
         FROM task t
         JOIN v_scope_current s ON s.tid = t.tid
         LEFT JOIN estimate e ON e.eid = (SELECT MAX(eid) FROM estimate WHERE tid = t.tid)
         LEFT JOIN v_task_actual a ON a.tid = t.tid
         LEFT JOIN v_outcome_current o ON o.tid = t.tid
        ORDER BY COALESCE(o.finalized_at, t.created_at) DESC`,
    )
    .all()
    .map((c) => ({ ...c, uncalibrated: Boolean(c.uncalibrated) }));

  const byColumn = new Map<BoardColumn, BoardCard[]>();
  for (const col of BOARD_COLUMNS) byColumn.set(col, []);
  for (const c of cards) {
    let col: BoardColumn | null = null;
    if (c.status === "completed") {
      col = c.finalized_at !== null && c.finalized_at >= sevenDaysAgo ? "Done (7d)" : null;
    } else if (c.status === "abandoned" || c.status === "deleted") col = "Abandoned";
    else if (c.status === "pending_verification") col = "Pending Verification";
    else if (c.status === "in_progress") col = "In Progress";
    else if (c.status === "estimating") col = "Estimating";
    if (col === null) continue;
    const list = byColumn.get(col)!;
    if (list.length < limit) list.push(c);
  }

  const wanted = opts.column ?? null;
  const columns = BOARD_COLUMNS.filter(
    (c) => wanted === null || c.toLowerCase().startsWith(wanted.toLowerCase()),
  ).map((column) => ({ column, cards: byColumn.get(column)! }));

  return { as_of: isoNow(now), columns };
}

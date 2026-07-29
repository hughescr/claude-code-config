/**
 * src/calibrate.ts — the estimation statistics, as pure functions.
 *
 * Nothing here touches the database, the clock or the filesystem: every function
 * takes numbers and returns numbers, which is the only reason the calibrator is
 * testable at all. `src/tasks.ts` calls it at `est open` (apply the multipliers);
 * `src/retro.ts` calls it at `est retro` (fit them, score them, write them back).
 *
 * Three warnings travel with this file, all of them from the design (§1.1, §3.2):
 *
 *  1. **None of the constants below are empirically backed.** `k = 10`, the 30-day
 *     half-life, the Jeffreys prior and the pinball split threshold are conventional
 *     defaults. They live in `config` rows, not here, and the retro tunes them by
 *     cross-validation once n >= 20. This file only implements the arithmetic.
 *  2. **Parameter uncertainty dominates at n ~ 10**, which is the regime this system
 *     lives in for its first month. The plug-in quantile is therefore NOT enough —
 *     {@link bootstrapQuantileCI} resamples the velocity sample and reports the
 *     envelope, and `refclass` stores it so the retro can watch the band tighten.
 *  3. **Velocity is a ratio of like units.** Every sample fed in here must already
 *     have been filtered to one `(ref_model, estimand)` pair; a ratio built across
 *     two denominations is a category error, not an outlier (§4.2 delta 3). This
 *     file cannot check that, so its callers must.
 */

/** z at the 90th percentile of the standard normal — the p90 band's half-width. */
export const Z_P90 = 1.2815515655446004;

/** IQR -> sigma for a normal: IQR = 2 * 0.6745 * sigma. */
export const IQR_TO_SIGMA = 1 / 1.3489795003921634;

// ---------------------------------------------------------------------------
// quantiles
// ---------------------------------------------------------------------------

/**
 * Linear-interpolation quantile over an ASCENDING array. Empty input is `null`
 * rather than 0 — "no data" and "zero" are different answers and conflating them
 * is how an empty reference class silently becomes a confident one.
 */
export function quantile(sortedAsc: readonly number[], q: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0]!;
  const clamped = Math.min(1, Math.max(0, q));
  const pos = clamped * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (pos - lo) * (sortedAsc[hi]! - sortedAsc[lo]!);
}

/** Convenience: sorts a copy, so callers need not care about input order. */
export function quantileOf(values: readonly number[], q: number): number | null {
  return quantile([...values].sort((a, b) => a - b), q);
}

export interface WeightedSample {
  readonly value: number;
  readonly weight: number;
}

/**
 * Weighted quantile by cumulative weight, with the same linear interpolation.
 * Used for the half-life-decayed velocity sample: a task finished 60 days ago under
 * a model family that no longer exists must not carry the same vote as yesterday's.
 */
export function weightedQuantile(samples: readonly WeightedSample[], q: number): number | null {
  const kept = samples.filter((s) => s.weight > 0 && Number.isFinite(s.value));
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!.value;
  const sorted = [...kept].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((t, s) => t + s.weight, 0);
  if (total <= 0) return null;
  const target = Math.min(1, Math.max(0, q)) * total;
  let acc = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const s = sorted[i]!;
    const next = acc + s.weight;
    if (next >= target) {
      const prev = sorted[i - 1];
      if (prev === undefined || s.weight === 0) return s.value;
      const within = (target - acc) / s.weight;
      return prev.value + within * (s.value - prev.value);
    }
    acc = next;
  }
  return sorted[sorted.length - 1]!.value;
}

// ---------------------------------------------------------------------------
// decay, shrinkage, multipliers
// ---------------------------------------------------------------------------

/** Exponential half-life weight. `halfLifeDays <= 0` disables decay (weight 1). */
export function decayWeight(ageDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) return 1;
  const age = Math.max(0, ageDays);
  return Math.pow(0.5, age / halfLifeDays);
}

/**
 * Shrinkage weight `n / (n + k)` — how much of the bucket's own median survives
 * versus the global median it is shrunk toward. At n = 0 this is 0, which is
 * exactly the cold start: the bucket contributes nothing and says so.
 */
export function shrinkWeight(n: number, k: number): number {
  if (n <= 0) return 0;
  if (!(k >= 0)) return 1;
  return n / (n + k);
}

export interface VelocitySample {
  /** actual / raw_p50 — the ratio the multipliers are fitted to. */
  readonly velocity: number;
  /** Age at the retro's `as_of`, in days. Drives the half-life weight. */
  readonly ageDays: number;
}

export interface LogVelocityStats {
  readonly n: number;
  /** Sum of decay weights — the sample size the bucket actually has. */
  readonly nEff: number;
  readonly medLogV: number;
  readonly iqrLogV: number;
}

/**
 * Median and IQR of LOG velocity, decay-weighted.
 *
 * Log space, not linear, for the reason every ratio distribution is analysed in log
 * space: a 3x overrun and a 3x underrun are the same magnitude of miss, and a linear
 * median treats the first as 2.0 away from 1.0 and the second as 0.67 away.
 * Non-positive velocities cannot be logged and are dropped — an actual of zero is a
 * task with no attributable spend, which is a data-quality fact, not a velocity.
 */
export function logVelocityStats(
  samples: readonly VelocitySample[],
  halfLifeDays: number,
): LogVelocityStats | null {
  const weighted: WeightedSample[] = [];
  for (const s of samples) {
    if (!(s.velocity > 0) || !Number.isFinite(s.velocity)) continue;
    weighted.push({ value: Math.log(s.velocity), weight: decayWeight(s.ageDays, halfLifeDays) });
  }
  if (weighted.length === 0) return null;
  const med = weightedQuantile(weighted, 0.5);
  const q1 = weightedQuantile(weighted, 0.25);
  const q3 = weightedQuantile(weighted, 0.75);
  if (med === null || q1 === null || q3 === null) return null;
  return {
    n: weighted.length,
    nEff: weighted.reduce((t, w) => t + w.weight, 0),
    medLogV: med,
    iqrLogV: Math.max(0, q3 - q1),
  };
}

export interface MultiplierInput {
  /** The bucket's own decayed log-velocity median. */
  readonly medLogV: number;
  /**
   * Log-velocity IQR the BAND WIDTH comes from. §3.2: use the GLOBAL IQR until
   * `bucket_n >= 20` — an order statistic over eight points is not a spread, it is
   * a rumour, and R1's tiny-n use of one is exactly what `[CA][CB]` shot down.
   */
  readonly iqrLogV: number;
  /** The median the bucket is shrunk toward. Equals `medLogV` for the global bucket. */
  readonly globalMedLogV: number;
  readonly shrinkW: number;
}

export interface Multipliers {
  /** raw_p50 -> cal_p50. The shrunk median velocity. */
  readonly multP50: number;
  /** raw_p90 -> cal_p90. The p90 of the velocity distribution. */
  readonly multP90: number;
}

/**
 * The two numbers `est open` multiplies the raw band by.
 *
 * `multP50` is the shrunk median velocity: history says your p50 runs this much low.
 * `multP90` is the p90 of the same log-normal velocity distribution — so the
 * calibrated p90 widens with the observed NOISE rather than with the estimator's own
 * guess about its own spread. The two are reported separately in the retro for the
 * reason §7.4 insists on: bias and noise need opposite fixes (shift the reference
 * class vs widen the band) and a single blended multiplier hides which one moved.
 */
export function multipliers(input: MultiplierInput): Multipliers {
  const shrunk = input.shrinkW * input.medLogV + (1 - input.shrinkW) * input.globalMedLogV;
  const sigma = Math.max(0, input.iqrLogV) * IQR_TO_SIGMA;
  return { multP50: Math.exp(shrunk), multP90: Math.exp(shrunk + Z_P90 * sigma) };
}

// ---------------------------------------------------------------------------
// bootstrap — parameter uncertainty, which R1's plug-in argument discarded
// ---------------------------------------------------------------------------

/** mulberry32: 32-bit, seedable, ~10 lines. Determinism is the point — a retro that
 *  reported a different CI on a re-run of the same inputs would be unauditable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string — turns an `as_of` timestamp into a stable PRNG seed. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Bootstrap CI for a quantile of a weighted sample (Spolsky's EBS method minus the
 * multi-task schedule summation, which is Phase 3 and which Craig has not asked for).
 *
 * `resamples` draws with replacement from the sample, recomputes the quantile in
 * each, and returns the requested credible envelope of the resulting distribution.
 * At n ~ 10-50 this costs microseconds and it is the only thing that distinguishes
 * "the median velocity is 2.9" from "the median velocity is somewhere in 1.4-6.2,
 * and we have ten data points".
 */
export function bootstrapQuantileCI(
  samples: readonly WeightedSample[],
  q: number,
  opts: { resamples?: number; level?: number; rng?: () => number } = {},
): Interval | null {
  const kept = samples.filter((s) => s.weight > 0 && Number.isFinite(s.value));
  if (kept.length < 2) return null;
  const resamples = Math.max(2, Math.trunc(opts.resamples ?? 200));
  const level = Math.min(0.999, Math.max(0.5, opts.level ?? 0.9));
  const rng = opts.rng ?? mulberry32(0x5eed);
  const draws: number[] = [];
  const n = kept.length;
  for (let r = 0; r < resamples; r += 1) {
    const boot: WeightedSample[] = new Array<WeightedSample>(n);
    for (let i = 0; i < n; i += 1) boot[i] = kept[Math.min(n - 1, Math.floor(rng() * n))]!;
    const v = weightedQuantile(boot, q);
    if (v !== null) draws.push(v);
  }
  if (draws.length === 0) return null;
  draws.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  const lo = quantile(draws, tail);
  const hi = quantile(draws, 1 - tail);
  return lo === null || hi === null ? null : { lo, hi };
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

/**
 * Pinball (quantile) loss. The headline metric because it has power at small n and
 * because it scores a BAND rather than a point — which is the only kind of output
 * this system produces.
 */
export function pinball(actual: number, predicted: number, q: number): number {
  const d = actual - predicted;
  return d >= 0 ? q * d : (q - 1) * d;
}

/**
 * Negative log predictive density of `actual` under the log-normal implied by the
 * issued band: mu = ln(p50), sigma = (ln(p90) - ln(p50)) / z90.
 *
 * Reported beside pinball because the two disagree in a useful way — pinball is
 * insensitive to how badly a miss missed once it is outside the band, log-score is
 * not. A degenerate band (p90 <= p50) has no density and returns null rather than
 * Infinity, so one malformed row cannot poison the mean.
 */
export function logScore(actual: number, p50: number, p90: number): number | null {
  if (!(actual > 0) || !(p50 > 0) || !(p90 > p50)) return null;
  const mu = Math.log(p50);
  const sigma = (Math.log(p90) - mu) / Z_P90;
  if (!(sigma > 0)) return null;
  const z = (Math.log(actual) - mu) / sigma;
  return 0.5 * z * z + Math.log(sigma * Math.sqrt(2 * Math.PI)) + Math.log(actual);
}

// ---------------------------------------------------------------------------
// Jeffreys interval for coverage
// ---------------------------------------------------------------------------

/** Lanczos log-gamma; enough precision for a Beta CDF at these sample sizes. */
function lnGamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i += 1) a += g[i]! / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued-fraction leg of the regularized incomplete beta (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b) — the Beta CDF. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Inverse Beta CDF by bisection. 60 iterations is ~1e-18 on [0,1]. */
export function betaInv(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Jeffreys credible interval for a binomial proportion — the coverage interval §7.4
 * requires, and the reason it requires one: coverage at n = 30 carries a ~7-point
 * standard error, so a raw reading of 0.73 against a 0.90 target must NOT trigger
 * band-widening. The interval is what stops the calibrator chasing its own noise.
 */
export function jeffreysInterval(k: number, n: number, level = 0.9): Interval | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const tail = (1 - Math.min(0.999, Math.max(0.5, level))) / 2;
  const a = k + 0.5;
  const b = n - k + 0.5;
  // The one-sided degenerate cases: at k = 0 the lower bound is 0 by construction,
  // at k = n the upper bound is 1. Reporting the Beta quantile there instead would
  // claim information the data does not contain.
  return {
    lo: k === 0 ? 0 : betaInv(tail, a, b),
    hi: k === n ? 1 : betaInv(1 - tail, a, b),
  };
}

/** Arithmetic mean, or null on an empty sample. `null` entries are skipped. */
export function meanOf(values: readonly (number | null)[]): number | null {
  const kept = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (kept.length === 0) return null;
  return kept.reduce((t, v) => t + v, 0) / kept.length;
}

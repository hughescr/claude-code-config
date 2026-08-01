# Reference: the unit, and why calibration is shaped this way

Covers what Work-CET is arithmetically, how the calibration pipeline reads your raw band, why
nothing gates, why this skill's own spend is excluded, and one open design question. `est --help`
and the code win any disagreement with this file.

## Work-CET, arithmetically

Per request, at the estimate's own price vintage:

```
work_cet = (out_tok * usd_out(model) + cw_tok * usd_cw(model)) / usd_out(ref_model)
```

(`src/db.ts`, view `v_task_actual_epoch`.) A task's actual is the sum over every attributable,
non-replay request — orchestrator, sub-agents and auxiliary spend together (`wcet_main`,
`wcet_sub`, `wcet_aux` in `src/close.ts`).

Three consequences:

- **Input and cache_read are absent.** They are the majority of list cost, which is why the CLI
  labels the Spend-CET forecast a LOWER bound rather than a bill prediction (`src/tasks.ts`,
  `spendForecast`). Two local corpus measurements put `cache_read` alone at 55.3% and 56.6% of list
  cost, with `input` a further ~0.6%; those are measurements of one machine's corpus in one window,
  not a universal constant, and the design records them as the weakest definitional evidence it
  rests on.
- **It is price-weighted, not a token count.** An expensive model's output token is worth more
  than one Work-CET; the cheap tier's is worth less. Fan out to Haiku and the Work-CET grows more
  slowly than the raw token count does.
- **It is pinned to a vintage.** `estimate.ref_model`, `estimate.estimand` and
  `estimate.price_epoch` are snapshotted at open, and the actual is computed under the same
  snapshot — so a price change mid-task cannot appear as a velocity shift with no cause
  (`src/close.ts`, the velocity block).

Current settings live in `est config`: `ref_model` (today `claude-sonnet-4-5`) and `estimand`
(today `work_cet`). Read them rather than assuming; the `refclass` footer prints both.

The other estimands the schema supports — `out` (output tokens only) and `out_cw_in` (adds input)
— are not in use. Velocity ratios are never pooled across `(ref_model, estimand)` pairs, because a
ratio built from two denominations is a category error rather than an outlier.

## What the raw band is for

The raw band is the estimator's own uncorrected judgement, stored as a **feature** and used as the
denominator of everything downstream. The whole point of the corpus is to find out, by measurement,
how raw estimates relate to actuals — so the raw number has to be given straight.

The pipeline:

1. `est close` computes `velocity_raw = actual / raw_p50` of the **baseline** (first) estimate.
2. `est retro` fits, per bucket, the decay-weighted median of `log(velocity_raw)`, shrinks it
   toward the global median by `n / (n + shrink_k)`, and writes back `mult_p50` / `mult_p90`.
   Band width comes from the **global** log-velocity IQR until the bucket reaches n = 20.
3. `est open` computes `cal_p50 = raw_p50 * mult_p50` and `cal_p90 = raw_p90 * mult_p90`
   (`src/tasks.ts`, the `calP50` / `calP90` block).

So any correction is applied downstream, once, from measured history. Padding your raw number
deflates every velocity sample you contribute, moving the multiplier for everyone, *and* gets the
correction applied to you twice in the band you are shown. Consistency across estimates is what
makes the fit possible; accuracy on any single estimate is not required and is not the goal.

If estimates and actuals converged, velocity would settle on 1.0 and the multipliers would retire
themselves. That is the intended end state, not a failure mode.

## Open question: is p90 widened twice?

`mult_p90` is fitted from the p90 of the historical velocity distribution (`src/calibrate.ts`, the
`multipliers()` block: `exp(shrunk + Z_P90 * sigma)`), and `est open` then multiplies the
estimator's **already-widened** `raw_p90` by it. That appears to count run-to-run uncertainty
twice. During cold start both multipliers are exactly 1.0 (`COLD_START_N`, `src/tasks.ts`), so the
widening has to live entirely in the raw number — the opposite regime, with no stated transition
rule between them.

**Unresolved; a design decision, possibly a code change.** Until it is settled, write `raw_p90` as
your own honest bad case and let the pipeline do whatever it does with it.

## Cold start is explicit

Below `COLD_START_N` completed tasks in the bucket, `est open` labels the band `uncalibrated` and
the calibrated band **equals** the raw band — multipliers of 1.0, no invented correction.
`refclass` refuses to show a multiplier below the same threshold, for the same reason: an order
statistic over eight points is a rumour, not a measurement.

Two constants are easy to confuse, and they are not the same thing:

| | what it is | where |
|---|---|---|
| `COLD_START_N` | **Hardcoded 10.** The threshold below which `est open` and `est refclass` refuse to calibrate at all. Not config-tunable. | `src/tasks.ts`, `export const COLD_START_N = 10`, applied in `calibrationFor()` and in `refclass()` |
| `shrink_k` | **Config, default 10.** The `k` in the shrinkage weight `n / (n + k)` — how much of a calibrated bucket's own median survives versus the global median it is shrunk toward. | `src/calibrate.ts` `shrinkWeight()`, read by `src/retro.ts` from `est config` |

They both equal 10 today by coincidence. `est config set shrink_k 5` would change the shrinkage
weight and would **not** move the cold-start threshold.

What the count counts is also narrower than it sounds. The bucket is `global` — a single bucket, for
both `est open` and `est refclass` — and its `n` is a count of completed tasks in `v_velocity`
filtered only by `(bucket, ref_model, estimand)`. It ignores your `--text`, your `--kind` and your
`--fanout` entirely, so "10 comparable completed tasks" overstates the comparability: it is ten
completed tasks in the same denomination, full stop.

## Nothing gates

No command refuses to run because an estimate is missing, and none is planned. The standing
response to falling compliance is to sharpen the wording of the rule, not to install a blocker on
the hot path. That is a constraint on how you run the ceremony: be fast, produce one useful line,
get out of the way. If `est` errors or is unavailable, say so in one clause and carry on with the
work — never fabricate a band to satisfy the ceremony.

It also means T3 and T4 are self-policed. T1 (a `Workflow` launch) and T2 (≥2 agent launches) are
mechanically detectable after the fact; "three orchestrator turns toward one goal" is a semantic
judgement no log records, and a verbal request for a budget is not distinguishable from other
prose. Skipping the ceremony on a T3 task is invisible to every compliance metric.

## This skill's own cost is excluded

Requests made on the **main chain** while the `estimating` skill is the active skill are booked to
`overhead` and excluded from the task's `actual_wcet` — improving the ceremony must not worsen the
numbers the ceremony produces (`src/attribute.ts`, the rule that overrides the others).

The `origin = 'main'` qualifier matters and is not a detail: the harness stamps the active skill
onto every request descending from the turn it was active on, so a workflow launched from an
anchoring turn hands the `estimating` tag to all of its subagents. Those are the delegated **work**,
not the ceremony, and they stay in the actual. Without the qualifier one live task was understated
by 3.4×.

Keep the ceremony under a minute anyway. That is the constraint that makes it survivable, not a
budget to spend up to.

# Reference: the unit, and why calibration is shaped this way

Covers what Work-CET is arithmetically, the evidence behind the calibration design, why the raw
band is a floor, why nothing gates, and why this skill's own spend is excluded. `est --help` and
the code win any disagreement with this file.

## Work-CET, arithmetically

Per request, at the estimate's own price vintage:

```
work_cet = (out_tok * usd_out(model) + cw_tok * usd_cw(model)) / usd_out(ref_model)
```

(`src/db.ts`, view `v_task_actual_epoch`.) A task's actual is the sum over every attributable,
non-replay request.

Three consequences:

- **Input and cache_read are absent.** They are 55–57% of list cost, which is why the CLI labels
  the Spend-CET forecast a LOWER bound rather than a bill prediction (`src/tasks.ts`,
  `spendForecast`).
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

## The evidence

Frontier models self-predicting token usage correlate 0.2–0.39 with actuals and are
systematically biased low; identical tasks vary up to ~30× run to run. The design absorbs that
rather than pretending to fix it:

- raw self-estimates are stored as **features** and treated as **floors**, never as means;
- calibration is mandatory;
- every output is a p50/p90 band, never a point;
- raw and calibrated velocity are tracked **separately**, so it stays visible whether the
  calibrator is actually earning its keep.

Early bands are wide and humbling. That is the system working.

## Raw as a floor — what that does and does not license

"Floor" is a statement about how the **system** reads your number, not an instruction to pad it.
The pipeline is:

1. `est close` computes `velocity_raw = actual / raw_p50` of the **baseline** (first) estimate.
2. `est retro` fits, per bucket, the decay-weighted median of `log(velocity_raw)`, shrinks it
   toward the global median by `n / (n + shrink_k)`, and writes back `mult_p50` / `mult_p90`.
   Band width comes from the **global** log-velocity IQR until the bucket reaches n = 20.
3. `est open` computes `cal_p50 = raw_p50 * mult_p50`.

So the correction is applied downstream, once, from measured history. Padding your raw number
deflates every velocity sample you contribute, shrinking the multiplier for everyone, and applies
the correction to you twice in the band you are shown.

Anchoring on the reference class is not padding. Replacing a gut number with the corpus's observed
actuals for comparable work is *estimating better*; multiplying a gut number by a fudge factor is
pre-empting the calibrator. If everyone anchored perfectly, velocity would converge on 1.0 and the
multipliers would retire themselves — that is the intended end state, not a failure mode.

## Cold start is explicit

Below `shrink_k` (10) comparable completed tasks, `est open` labels the band `uncalibrated` and
the calibrated band **equals** the raw band — multipliers of 1.0, no invented correction. In that
regime the reference class's own actual-cost distribution is the only correction available, which
is precisely why the procedure in SKILL.md makes you read it before you speak.

`refclass` refuses to show a multiplier below the same threshold, for the same reason: an order
statistic over eight points is a rumour, not a measurement.

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

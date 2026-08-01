# Reference: the unit, the anchor, and why calibration is shaped this way

Covers what a story point is and how it is anchored, what Work-CET is arithmetically now that it is
only ever the *actual*, how the calibration pipeline reads your raw band, why the estimand changed,
why nothing gates, why this skill's own spend is excluded, and one open design question. `est --help`
and the code win any disagreement with this file.

## The story point, and its anchor

`--raw-p50` and `--raw-p90` are positive integers on a relative scale. The scale has exactly one
fixed definition:

> **1 story point = rename a single variable across 3 files in a TypeScript codebase, with no tests
> to update.**

Everything else is placed by comparison — against the anchor, and against blocks already sized.
Estimators pick a rung from `1 · 2 · 3 · 5 · 8 · 13 · 20 · 40` rather than computing a value; the
widening gaps are the point, because interpolation between rungs is precision nobody has.

**The anchor is versioned.** `anchor_id` is snapshotted onto every estimate at `est open`, exactly
as `ref_model` and `price_epoch` are, and for the same reason: the unit has to be pinned or the
history is meaningless. If the anchor is ever redefined — a different task, a different codebase, a
different "no tests to update" — then points minted before and after mean different things. Old
points do not become wrong; they become a different denomination, and the corpus must keep them
apart rather than pool them.

## Work-CET, arithmetically — the actual, not the estimate

Work-CET has not gone away. It is what the harness's logs are reduced to, per request, at the
estimate's own price vintage:

```
work_cet = (out_tok * usd_out(model) + cw_tok * usd_cw(model)) / usd_out(ref_model)
```

(`src/db.ts`, view `v_task_actual_epoch`.) A task's actual is the sum over every attributable,
non-replay request — orchestrator, sub-agents and auxiliary spend together (`wcet_main`,
`wcet_sub`, `wcet_aux` in `src/close.ts`).

Three properties still matter, all of them on the *measurement* side:

- **Input and cache_read are absent.** They are the majority of list cost, which is why the CLI
  labels any Spend-CET figure a LOWER bound rather than a bill prediction (`src/tasks.ts`,
  `spendForecast`). Two local corpus measurements put `cache_read` alone at 55.3% and 56.6% of list
  cost, with `input` a further ~0.6%; those are measurements of one machine's corpus in one window,
  not a universal constant, and the design records them as the weakest definitional evidence it
  rests on.
- **It is price-weighted, not a token count.** An expensive model's output token is worth more than
  one Work-CET; the cheap tier's is worth less. Fanning out to Haiku grows the actual more slowly
  than it grows the raw token count.
- **It is pinned to a vintage.** `estimate.ref_model`, `estimate.estimand` and
  `estimate.price_epoch` are snapshotted at open, and the actual is computed under the same
  snapshot — so a price change mid-task cannot appear as a velocity shift with no cause
  (`src/close.ts`, the velocity block).

No agent ever predicts this number. It is derived, on close, by deterministic SQL.

## Points → Work-CET: what velocity means now

`est close` computes `velocity_raw = actual_wcet / raw_p50` of the **baseline** estimate. Under the
old unit that ratio was dimensionless — a correction factor on an estimate denominated in the same
thing as the actual. Under points it is a **rate with units: Work-CET per story point.**

That changes what a converged system looks like. The old design said velocity would settle on 1.0
and the multipliers would retire themselves. That end state does not carry over. A point costs
whatever a point costs on this machine, the fitted rate settles there, and it stays — the multiplier
is doing *conversion*, not *correction*, and it is permanent infrastructure rather than a
scaffold. What convergence looks like now is a **stable** rate with a narrow spread, not a rate
of 1.

Two consequences for what gets shown:

- A Work-CET or spend figure can only be produced once a rate exists for the bucket. Below that,
  `est open` shows points alone — a cold-start multiplier of 1.0 would assert "one Work-CET per
  point", which is not a humble default but a wrong one.
- Points and Work-CET are never added, averaged, or compared. They are on opposite sides of the
  conversion.

## The old corpus is kept, and never pooled

Estimates minted under the Work-CET estimand are still in the database and still readable. They will
never mix with story-point estimates, because `v_velocity` — and every consumer of it — groups by
`(ref_model, estimand)` (`src/db.ts` around the velocity view; `src/retro.ts` filters on both).
A velocity built across two denominations is a category error, not an outlier, so the corpus does
not average it away; it partitions.

The practical effect is a fresh cold start for the story-point estimand. That is the correct price
for changing the unit, and it was paid deliberately.

## Why the estimand changed

The old ceremony asked the estimator to predict Work-CET directly, deriving it bottom-up from
expected output tokens and cache creation, weighted by model tier. It was replaced after a
280-call study — the same tasks, put to fable-5, opus-5, sonnet-5 and haiku-4.5 as isolated
single-turn questions, varying only the framing.

**Absolute units did not survive contact with more than one model.** Asked for a Work-CET number,
cross-model medians on a single task spanned **109×**; on another, **61.9×**. Asked to size the same
tasks in story points against a fixed anchor, the same models spanned **1.0×** and **1.63×**. A unit
that four models cannot agree on to within two orders of magnitude is not measuring the work; it is
measuring each model's private notion of how big a number should be.

**Absolute units failed silently and catastrophically.** Work-CET answers included `40` where the
cell median was 8,000, and `100` and `150` where the medians were six figures — off by orders of
magnitude, stated with no less confidence than a good answer. Story points produced nothing of that
class. This is the failure that matters most: a band that is 200× low still prints, still gets
shown to the user, and still poisons the velocity sample fitted from it.

**Absolute units were unstable within a single model.** Opus was flatly bimodal in Work-CET —
either ~8k or ~10.5M, with nothing in between — and the same model in story points returned
`2,2,2,2,2` on one task and `8,13,8,8,8` on another. Sizing is a judgement models can make
consistently; denominating it in tokens is not.

**Whole-task sizing of large work was poor in both framings — decomposition is what fixed it.**
Splitting into phase-sized blocks and summing cut cross-model spread from 7.7× to **1.96×** and cut
within-model coefficient of variation roughly 4–5× (fable: 1.44 → 0.17). It also repaired a hard
failure: sonnet sized a 60-file migration at 13 points as a whole and at 135 points decomposed. The
whole-task number did not misjudge the work by a little — it failed to grasp its scale at all.
(That pair is evidence about *method*, not a reference size; do not carry 135 around as the price of
a migration.) This is why decomposition above ~40 points is written as a rule rather than a
suggestion.

**And the estimator is never told about the correction.** A prompt that told the model its
self-estimates ran low by a stated factor produced answers scaled by very close to that factor. The
model does not hold the correction and the raw band separately; it just multiplies. So the agent-
facing path names no multiplier, no historical bias, and no direction of error — not out of
politeness, but because saying it destroys the measurement the system exists to take. Correction
belongs downstream, applied once, by the pipeline below.

## What the raw band is for

The raw band is the estimator's own uncorrected judgement, stored as a **feature** and used as the
denominator of everything downstream. The whole point of the corpus is to find out, by measurement,
how sized work relates to actual cost — so the raw number has to be given straight.

The pipeline:

1. `est close` computes `velocity_raw = actual / raw_p50` of the **baseline** (first) estimate.
2. `est retro` fits, per bucket, the decay-weighted median of `log(velocity_raw)`, shrinks it
   toward the global median by `n / (n + shrink_k)`, and writes back `mult_p50` / `mult_p90`.
   Band width comes from the **global** log-velocity IQR until the bucket reaches n = 20.
3. `est open` applies those multipliers to the raw band (`src/tasks.ts`, the `calP50` / `calP90`
   block) — which, under points, is the points→Work-CET conversion.

So any correction is applied downstream, once, from measured history. Padding your raw number
distorts every velocity sample you contribute, moving the fitted rate for everyone, *and* gets the
correction applied to you twice in the band you are shown. Consistency across estimates is what
makes the fit possible; accuracy on any single estimate is not required and is not the goal.

## Open question: is p90 widened twice?

`mult_p90` is fitted from the p90 of the historical velocity distribution (`src/calibrate.ts`, the
`multipliers()` block: `exp(shrunk + Z_P90 * sigma)`), and `est open` then multiplies the
estimator's **already-widened** `raw_p90` by it. That appears to count run-to-run uncertainty
twice. During cold start both multipliers are exactly 1.0 (`COLD_START_N`, `src/tasks.ts`), so the
widening has to live entirely in the raw number — the opposite regime, with no stated transition
rule between them.

**Unresolved; a design decision, possibly a code change.** Until it is settled, write `raw_p90` as
your own honest bad case in points and let the pipeline do whatever it does with it.

## Cold start is explicit

Below `COLD_START_N` completed tasks in the bucket, `est open` labels the band `uncalibrated` and
the calibrated band **equals** the raw band — multipliers of 1.0, no invented correction.
`refclass` refuses to show a multiplier below the same threshold, for the same reason: an order
statistic over eight points is a rumour, not a measurement. Under the story-point estimand this is
also exactly the regime in which no Work-CET conversion can honestly be shown.

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

---
name: estimating
description: Record a calibrated token estimate before starting substantial work, using the `est` CLI. Use at the start of the anchoring turn — prompt read, plan formed, nothing launched — whenever the planned work involves a Workflow launch, two or more Task/agent launches, three or more orchestrator turns toward one goal, or the user asked for an estimate or a budget. Also use to add per-phase workflow block estimates before launching, to re-estimate by refinement or scope change, and to close and score a task on completion. Not for lookups, single-file edits, or one background agent on an errand.
---

# Estimating

Record a band **before** starting substantial work, then let the system score it against what
actually happened. Under a minute of friction. Nothing here blocks anything.

**`est` means `bun run ~/.claude/estimator/src/cli.ts`**, run from `~/.claude/estimator`. If
`which est` comes back empty, use the long form rather than skipping the step.

## What you are estimating

`--raw-p50` and `--raw-p90` are **Work-CET**: price-weighted `output + cache_creation` tokens,
normalised by a reference model's output price. Confirm the current reference model and estimand
from `est config` (`ref_model`, `estimand`) or from the `unit:` line `est refclass` prints — as of
this writing, `work_cet` normalised by `claude-sonnet-4-5` output tokens.

- **Output on the reference model is 1:1.** One Work-CET ≈ one output token on the reference model,
  so you can reason straight from the tokens you expect to produce. Work on a pricier model counts
  for more per token, a cheaper one less — so fanning out to a cheap tier grows Work-CET more slowly
  than it grows raw tokens.
- **Cache creation counts; input and cache_read do not.** Genuinely-new context entering an agent's
  window is work; re-reading context it already holds is not. So this is not "total tokens" and not
  the bill — the Spend-CET forecast `est open` prints is explicitly a **lower bound**.
  [The formula, and why those counters →](references/unit-and-calibration.md)

> **`--raw-p50` and `--raw-p90` are your own honest judgement, handed over uncorrected.** Treat them
> as story points: you say what the work looks like from here, the system measures `actual /
> raw_p50` and learns the scaling. Learning that scaling is its job and not yours. So **never pad,
> shade, or round toward a number that looks better** — a padded raw number is not a safer estimate,
> it is a corrupted measurement, and it corrupts the multiplier fitted from it for every future
> estimate too. Being consistent across estimates matters more than being right about any one of
> them.

## When this applies

Required before starting work when the planned goal involves **ANY** of: **T1** a `Workflow` launch
· **T2** ≥ 2 `Task`/agent launches · **T3** ≥ 3 orchestrator turns of coordinated work toward one
goal · **T4** the user asked for an estimate or a budget.

**Exempt:** lookups, single-file edits, one background agent on a trivial errand.

**The moment** is the start of the anchoring turn: prompt read, plan formed, **nothing launched**.
Estimating later biases the actual low, because the attribution window opens at the anchoring turn
— your planning and reading spend is inside the estimate's coverage by design.

T1 and T2 are mechanically detectable after the fact; **T3 and T4 are not**, so skipping the
ceremony on a three-turn task is invisible to every compliance metric — which is why this is a
standing rule you keep rather than something a backstop will catch.

**Delegated work is presumed already estimated.** If an orchestrator handed you a slice, do not open
a task for it even if your slice alone meets T1–T3. If your prompt names a tid, `est bind` attaches
your identity to it; `est open` does not. If you genuinely believe your slice is covered by no
existing estimate, ask your orchestrator rather than minting a tid yourself.

## How to arrive at a number

Derive it from the unit, bottom-up. Work-CET is `output + cache_creation`, price-weighted — both of
those are quantities you can reason about directly from the plan you just formed, without consulting
anything.

**1. List the work units.** Every sub-agent you plan to launch, every workflow phase, and the
orchestrator itself — your own reading, planning and between-phase review turns are real spend
inside the window. This list is also your `exp_*` drivers, so write it down once and reuse it.

**2. Per unit, how many output tokens?** What will this agent actually emit — tool calls, edits,
reasoning, its final report? A tightly-scoped agent that reads three files and returns a short
verdict emits a few thousand; one that writes several files and iterates emits tens of thousands.

**3. Per unit, how much cache creation?** Cache creation is context entering that agent's window for
the first time: the prompt you hand it, the files it reads, the tool results it accumulates.
Re-reads of context it already holds are `cache_read` and cost nothing here. A fresh agent creates
roughly its peak context once; a long agent that keeps opening new files creates more.

**4. Weight each unit by its model tier.** `weight_out = usd_out(model) / usd_out(ref_model)` and
`weight_cw = usd_cw(model) / usd_out(ref_model)`. The reference tier's output weight is 1.0 by
definition; a top-tier model's is several times that, a cheap tier's a fraction. Cache creation is
priced off the input side, so its weight is a small fraction of the same model's output weight.

**5. Sum. That sum is your `--raw-p50`.**

**6. `--raw-p90` is your own honest bad case, priced the same way.** Not p50 times a habitual
constant. Name what actually goes wrong on work of this shape — an agent needs a second pass, a
phase gets re-run, the search is wider than anyone thought — and cost that world with the same
arithmetic. During cold start the calibrator's multipliers are exactly 1.0, so the number you write
is the number that is shown; do not narrow it because it looks embarrassing.

**7. Reconcile with the drivers you are about to commit.** State `exp_agents`, `exp_wf_phases`,
`exp_files_write`, `exp_turns`, `exp_requests` as numbers and check they tell the same story as the
band — 12 agents against a 200k p50 is a contradiction, and the retro will find it. These are
audited against actuals, and they are what let a miss be *diagnosed* (orchestrator vs sub-agent)
rather than merely recorded.

**8. Watch it.** `est burn` mid-task is the feedback loop: consumption against the band, as a share
of p50 and p90. Blowing past p50 while the work is visibly half-done means `est open --tid <tid>
--reason refinement`, not silence.

### Worked example — illustrative numbers, not corpus data

A diff review: three reviewer agents on the reference tier, one judge on a top tier, plus the
orchestrator. Suppose the price table gives output weights 1.0 (reference tier) and 5.0 (top tier),
and cache-creation weights 0.25 and 1.25 respectively.

| unit | output | cache creation | Work-CET |
|---|---|---|---|
| reviewer × 3 | 6,000 each | 40,000 each | 3 × (6,000·1.0 + 40,000·0.25) = 48,000 |
| judge × 1 | 8,000 | 60,000 | 8,000·5.0 + 60,000·1.25 = 115,000 |
| orchestrator, 6 turns | 12,000 total | 90,000 total | 12,000·1.0 + 90,000·0.25 = 34,500 |

`--raw-p50 200000` (rounded from 197,500). For p90: the bad case here is one reviewer round
repeated and the judge needing a second pass — another 48,000 + 115,000 — so `--raw-p90 360000`.

### What `est refclass` is for, and what it is not

Run it first, every time, and read it. It confirms the unit, it frames your `--kind` and `--fanout`,
and if your number lands an order of magnitude away from everything it shows, that is worth a second
look at your decomposition.

**It is a sanity check, not an anchor. Do not replace your number with one derived from its rows.**
Two reasons, and the second is the one that matters: the `actual` in a row is the **whole task** —
orchestrator, sub-agents and auxiliary spend together — so `actual / fanout` is not a cost per agent
and adding orchestrator turns on top of it double-counts them; and an estimate copied out of
observed actuals is no longer an independent reading of your own judgement, which is the only thing
this system exists to collect. This is deliberate. Do not restore the anchoring.

Three regimes, none of them a number to copy:

- **No matching rows.** It says so and exits 0 — an empty reference class is a valid answer. Your
  decomposition stands on its own.
- **Rows with the `these matches are the UNFILTERED class` note.** No completed task ran at a
  comparable fan-out, so those rows are explicitly *not* comparable on the dimension you asked
  about. Read them as background, not as evidence.
- **A calibrated bucket.** You get a multiplier line and no actual-cost distribution — the
  distribution is printed only during global cold start.

[Flags, tolerance bands and the rest of the surface →](references/cli-surface.md)

## The ceremony

1. **`est refclass`** — before you state any number, per above. Anti-anchoring is the entire reason
   it comes first. Pass the same `--session`/`--prompt` anchor you will pass to `est open`.

   ```
   est refclass --kind <research|design|implement|refactor|debug|review|ops> \
                --fanout <planned agent count> --text "<subject>"
   ```
2. **Drivers, then band** — the `exp_*` numbers, then `raw_p50` / `raw_p90`.
3. **`est open`** — mints the tid and applies calibration:

   ```
   est open --kind <k> --subject <text> [--description <text>] [--dod <json|@file>] \
            --raw-p50 <n> --raw-p90 <n> \
            --exp-agents <n> --exp-wf-phases <n> --exp-files-write <n> \
            --exp-turns <n> --exp-requests <n>
   ```

   Below `COLD_START_N` (10) completed tasks in the global bucket the band is labelled
   `uncalibrated` and **equals** the raw band. Cold start is explicit, not faked.

   **If it warns about a near-duplicate, STOP and use the tid it names.** A non-empty
   `near_duplicates` almost always means you should not have minted. Same goal, estimate moved →
   `est open --tid <named tid> --reason refinement`. Delegated work under an existing estimate →
   `est bind <named tid>`. Mint anyway only when the overlap is genuinely coincidental, and say so
   in one clause when you show the band. [The two incidents this came from →](references/re-estimation.md)
4. **`--dod`, on that same call** — capture Definition of Done now, each item tagged `deterministic` (machine-checkable
   command) or `human` (the user judges). Capturing it at estimate time is what stops "done" being
   renegotiated later to fit whatever got built.
5. **Plant the identity.** `est open` prints, on its own line:

   ```
   EST_PLANT: TaskUpdate({ taskId: "<n>", metadata: { est_tid: "<uuidv7>" } })
   ```

   **Issue that call verbatim** when a Task-tool task exists — `est` cannot write Task metadata, you
   are the only actor who can, and the planted key stitches the task together across sessions. No
   Task-tool task → skip it; the tid stands alone.
6. **Show one line to the user** — Work-CET p50/p90, request band, spend forecast: whatever `est
   open` printed and nothing it did not (there is no active-time band; do not invent one). That line
   is the entire user-facing friction. Do not narrate the ceremony.

If `est` errors or is unavailable, say so in one clause and get on with the work. **Never fabricate
a band to satisfy the ceremony.**

## Workflow blocks

For any **T1** task, one estimate per declared `meta.phases` entry, **written before the launch**,
in addition to the task-level band. Derive each block the same way — it is the same decomposition,
sliced by phase instead of summed.

```
est block <tid> --phase <i> --title <t> --p50 <n> --p90 <n> [--exp-agents <n>] [--model <m>]
```

- **`--phase` is 0-BASED** — the `phases[]` array index. A 1-based value silently mis-joins every
  block estimate to the wrong phase: it fails nothing and reports nothing, it just makes the numbers
  wrong.
- **Every `agent()` call carries `label` and `phase`.** These are what make per-phase attribution
  possible at all; unlabelled or unphased workflow agents are reported as a data-quality defect.
- **Roll-up, not replacement.** Blocks roll up beside the task band as a consistency check; the
  **task band stays the calibrated number**, and it is what the user sees and what accuracy is
  judged against.

Appending is the only revision: a duplicate `(estimate, phase)` is rejected.

## Re-estimating

Append, never edit. Two reasons in ordinary use, and they are **not** interchangeable:

- **`est open --tid <tid> --reason refinement`** — same goal, you now know it is bigger. The task
  **stays** in velocity stats and the refinement is scored as mid-task predictive skill.
- **`est scope <tid> --reason <text>`, then `est open --tid <tid> --reason scope_change`** — the
  goal itself moved. The task is **removed** from velocity stats, so it is not available by
  assertion: `est scope` refuses a no-op and `est open` verifies the scope actually advanced.

Baseline accuracy is always judged against the **first** estimate; a refinement never becomes the
baseline. (`--reason recalibration` also exists — see
[the three reasons in full →](references/re-estimation.md).)

**Exit code `2` is never worked around.** It means the command was well-formed and the operation is
not permitted; its message names the append path that *is* allowed. Take that path or leave the
record alone.

## Closing

```
est close <tid> [--status completed|abandoned|deleted|reopened]
est close <tid> --accept "<the human's verbatim words>"
```

**There is no flag that accepts a token count, a cost, or a velocity, and there never will be.** The
actual is computed by deterministic SQL over the harness's own logs, never from anything you report.
Do not offer a number; you do not have one.

`est close` runs a quiescence check and exits `2` naming the failing condition. Its remedy usually
begins **"do nothing"** — the sweeper's close pass finalizes quiet tasks on every eligible sweep,
through the same gate. Waiting is right when the work really did finish and the harness recorded it;
a task with no completion signal at all is eventually swept `abandoned`, which is right-censored and
measures nothing, and that is why `--accept` exists.

**Resuming work on a task the sweeper already closed starts with `est close <tid> --status
reopened`.** That appends a revision and re-opens the attribution window; until it lands, every hour
of the resumed work is metered against nothing and does not re-attach on its own.
[The gate, censoring, and how the retro scores →](references/closing.md)

**`--accept` is the one bypass you may use, and only on explicit human consent.** The criterion is
narrow and positive: **a first-person acceptance of completion, addressed to the work.** "I accept
the task is done", "I approve this as complete", "accepted, close it out". That shape and nothing
looser. Silence, thanks, praise, "nice", "ship it", moving on to another topic, and your own reading
that the work looks finished are **not** acceptance. **When it is not clearly that shape, ask** —
"do you accept this task as complete?" — and wait. Construing a borderline phrase as consent is the
failure this flag is designed around; asking costs one turn. Quote their words verbatim: the quote
is verified against the transcript, paraphrase fails, and inventing an acceptance is the one thing
you must never do. `--force` is Craig's tool, never yours.

## References

- `references/unit-and-calibration.md` — Work-CET's formula, the calibration pipeline, why nothing gates, why this skill's own spend is excluded, and the open question about p90.
- `references/re-estimation.md` — the three reasons in full, the exit-2 rationale, the two 2026-07-30 near-duplicate incidents.
- `references/closing.md` — the quiescence gate, right-censoring, `--accept` verification, reopening after a sweep close, how the retro scores.
- `references/cli-surface.md` — every verb outside the ceremony, global flags, the tunable constants.

`est --help` is the authority whenever this skill and the CLI disagree.

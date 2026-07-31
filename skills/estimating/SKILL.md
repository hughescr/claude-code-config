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

- **Input and cache_read are excluded.** This is not "total tokens" and not the bill; the Spend-CET
  forecast `est open` prints is explicitly a **lower bound** — the missing counters are 55–57% of
  list cost.
- **Output on the reference model is 1:1.** One Work-CET ≈ one Sonnet output token; work on a
  pricier model counts for more per token, a cheaper one less. So fanning out to a cheap tier grows
  Work-CET more slowly than it grows raw tokens.
- **Scale, for intuition:** a substantial multi-agent task here lands in the high hundreds of
  thousands to a few million Work-CET. Not your estimate — the magnitude you should be typing, so a
  three-digit number reads as obviously wrong.

> **`--raw-p50` is your own uncorrected best guess at the actual — never pre-multiply it by a
> correction factor.** The calibrator fits its multiplier to `actual / raw_p50` and applies it
> downstream at `est open`. Padding the raw number poisons that multiplier for every future
> estimate *and* gets the correction applied to you twice. Anchoring on the reference class is not
> padding — replacing a gut number with the corpus's observed actuals for comparable work is
> estimating better; multiplying a gut number by 3 is not.

## When this applies

Required before starting work when the planned goal involves **ANY** of: **T1** a `Workflow` launch
· **T2** ≥ 2 `Task`/agent launches · **T3** ≥ 3 orchestrator turns of coordinated work toward one
goal · **T4** the user asked for an estimate or a budget.

**Exempt:** lookups, single-file edits, one background agent on a trivial errand.

**The moment** is the start of the anchoring turn: prompt read, plan formed, **nothing launched**.
Estimating later biases the actual low, because the attribution window opens at the anchoring turn
— your planning and reading spend is inside the estimate's coverage by design.

**Delegated work is presumed already estimated.** If an orchestrator handed you a slice, do not open
a task for it even if your slice alone meets T1–T3. If your prompt names a tid, `est bind` attaches
your identity to it; `est open` does not. If you genuinely believe your slice is covered by no
existing estimate, ask your orchestrator rather than minting a tid yourself.

## How to arrive at a number

Do not invent one. Derive it, in this order.

**1. Run `est refclass` first and actually read it.**

```
est refclass --kind <research|design|implement|refactor|debug|review|ops> \
             --fanout <planned agent count> --text "<subject>"
```

Read-only, exits 0 even with no matches. Three things in its output are your raw material: the
**`unit:` footer** (confirms what you are denominating in); the **actual-cost distribution line**,
`p10 · p50 · p90` over completed tasks — the corpus's own answer to "what does work cost here", and
your anchor, printed even when your class is empty by falling back to the global distribution; and
the **rows**, comparable completed tasks each with its `fanout`, `raw p50`, `actual` and velocity.

**2. Build a per-agent figure from the rows, not from your head.** Each row carries an actual and a
fan-out, so `actual / fanout` is an observed cost per agent for work of that shape. Adjust for how
much bigger or smaller your agents' slices are, multiply by your planned fan-out, and add the
orchestrator's own turns — reading, planning and reviewing between phases is real spend inside your
window. If the result lands above the corpus p90 or below its p10, you owe a reason you can say out
loud; "my task is smaller than the median" is one, "that number looked large" is not.

**3. Reconcile with the drivers you are about to commit.** State `exp_agents`, `exp_wf_phases`,
`exp_files_write`, `exp_turns`, `exp_requests` as numbers and check they tell the same story as the
band — 12 agents and a 200k p50 is a contradiction, and the retro will find it. These are audited
against actuals, and they are what let a miss be *diagnosed* (orchestrator vs sub-agent) rather than
merely recorded.

**4. Band, never a point.** p90 sits meaningfully above p50 — identical tasks vary up to ~30× run to
run, so a p90 at 1.2× p50 is a claim the world does not support. Do not narrow a band because it
looks embarrassing.

**5. Watch it.** `est burn` mid-task is the feedback loop: consumption against the band, as a share
of p50 and p90. Blowing past p50 while the work is visibly half-done means `est open --tid <tid>
--reason refinement`, not silence.

*Worked shape* — a real `refclass` run for a design task at fan-out 3 returned one comparable row
(fan-out 32, raw p50 200,000, actual 5,132,557) plus `raw actual-cost distribution over 10 completed
task(s): p10 0 · p50 1,122,873 · p90 4,734,820 Work-CET`, UNCALIBRATED at n=7. The row gives ≈160k
per agent; three comparable slices is ≈500k, and orchestration on top puts p50 near the corpus p50
rather than near its p10 — which is the check that matters. (The p10 of 0 is not a floor; it is
tasks with no attributable spend.)

## The ceremony

1. **`est refclass`** — before you state any number, per above. Anti-anchoring is the entire reason
   it comes first. Pass the same `--session`/`--prompt` anchor you will pass to `est open`.
2. **Drivers, then band** — the `exp_*` numbers, then `raw_p50` / `raw_p90`.
3. **`est open`** — mints the tid and applies calibration:

   ```
   est open --kind <k> --subject <text> [--description <text>] [--dod <json|@file>] \
            --raw-p50 <n> --raw-p90 <n> \
            --exp-agents <n> --exp-wf-phases <n> --exp-files-write <n> \
            --exp-turns <n> --exp-requests <n>
   ```

   Below 10 comparable completed tasks the band is labelled `uncalibrated` and **equals** the raw
   band. Cold start is explicit, not faked.

   **If it warns about a near-duplicate, STOP and use the tid it names.** A non-empty
   `near_duplicates` almost always means you should not have minted. Same goal, estimate moved →
   `est open --tid <named tid> --reason refinement`. Delegated work under an existing estimate →
   `est bind <named tid>`. Mint anyway only when the overlap is genuinely coincidental, and say so
   in one clause when you show the band.
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
in addition to the task-level band.

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
baseline. (`--reason recalibration` also exists — see the reference.)

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
begins **"do nothing"** — the sweeper's close pass finalizes quiet tasks on every sweep, through the
same gate. Waiting is right when the work really did finish and the harness recorded it; a task with
no completion signal at all is eventually swept `abandoned`, which is right-censored and measures
nothing, and that is why `--accept` exists.

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

- `references/unit-and-calibration.md` — Work-CET's formula, the evidence, what "raw is a floor" licenses, why nothing gates, why this skill's own spend is excluded.
- `references/re-estimation.md` — the three reasons in full, the exit-2 rationale, the two 2026-07-30 near-duplicate incidents.
- `references/closing.md` — the quiescence gate, right-censoring, `--accept` verification, reopening after a sweep close, how the retro scores.
- `references/cli-surface.md` — every verb outside the ceremony, global flags, the tunable constants.

`est --help` is the authority whenever this skill and the CLI disagree.

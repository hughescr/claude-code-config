---
name: estimating
description: Record a calibrated story-point estimate before starting substantial work, using the `est` CLI. Use at the start of the anchoring turn — prompt read, plan formed, nothing launched — whenever the planned work involves a Workflow launch, two or more Task/agent launches, three or more orchestrator turns toward one goal, or the user asked for an estimate or a budget. Also use to add per-phase workflow block estimates before launching, to re-estimate by refinement or scope change, and to close and score a task on completion. Not for lookups, single-file edits, or one background agent on an errand.
---

# Estimating

Record a band **before** starting substantial work, then let the system score it against what
actually happened. Under a minute of friction. Nothing here blocks anything.

**`est` means `bun run ~/.claude/estimator/src/cli.ts`**, run from `~/.claude/estimator`. If
`which est` comes back empty, use the long form rather than skipping the step.

## What you are estimating

`--raw-p50` and `--raw-p90` are **story points** — positive integers on a relative scale, sized
against one fixed anchor:

> **1 story point = rename a single variable across 3 files in a TypeScript codebase, with no tests
> to update.**

- **A point is not a token, a minute, or a dollar.** Nothing on this path asks you to predict any of
  those. Points say how big this work is *next to the anchor*; every absolute quantity is measured
  afterwards from the harness's own logs, never stated by you.
- **The anchor is versioned and pinned.** The definition lives in the append-only `sp_anchor` table,
  `config.sp_anchor_id` (seeded `v1`) names which row is in force, and `est open` pins that id onto
  the row it writes as `estimate.sp_anchor_id` — exactly as it snapshots `ref_model` and
  `price_epoch`. That per-estimate pin is what keeps a historic points band interpretable: a rate
  fitted under `v1` is never applied to a band issued under `v2`. Introducing a new anchor is **id
  first, then text** (`est config set sp_anchor_id v2`, then `est config set sp_anchor_text "…"`),
  and **re-wording an id that is already defined is refused** — a re-wording is a redefinition, and
  the table is append-only so that the text cannot drift away from the id bands point at. Confirm
  what is in force from `est config` (`estimand`, `sp_anchor_id`, `sp_anchor_text`), or from the
  anchor line and the `unit:` line `est refclass` prints. (The `sp_` prefix is load-bearing: `anchor` on its own already means the session/prompt an
  estimate was issued from, an older and unrelated use of the word.) If the anchor is ever redefined,
  points minted under the old one mean a different thing, and the corpus keeps the two apart rather
  than pooling them.
- **Points are live only while `config.estimand` reads `story_point`** (singular). That is the whole
  cutover — `est config set estimand story_point`, Craig's call, no migration, no history rewritten
  — and until it lands `--raw-p50` / `--raw-p90` are Work-CET tokens and this page is describing the
  wrong unit. `est refclass` prints its anchor line only under points; no anchor line, no points.
  Under points each quantile must be a whole number in `[1, config.sp_max_points]` (seeded 1000): a
  Work-CET-scale number typed into `--raw-p50` is refused with **exit 1** — a malformed command
  line, retype it — because `estimate` is append-only and the row could never be corrected after.
- **Work-CET still exists — as the actual, never as your estimate.** Work-CET is computed from the
  logs, and the system fits a points→Work-CET rate per bucket. Where a rate exists, `est open`
  converts and shows it beside the points; where it does not, it shows points alone. Either way you
  never predict it.
  [The unit, the anchor, and why the estimand changed →](references/unit-and-calibration.md)

> **`--raw-p50` and `--raw-p90` are your own honest judgement, handed over uncorrected.** You say
> what the work looks like from here; the system measures `actual_wcet / raw_p50` and fits the
> points→Work-CET rate itself. That fit is its job and not yours. So **never pad, shade, or round
> toward a number that looks better** — a padded raw number is not a safer estimate, it is a
> corrupted measurement, and it corrupts the rate fitted from it for every future estimate too.
> Being consistent across estimates matters more than being right about any one of them.

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

By comparison, not by arithmetic. The only question is how big this work is next to things of known
size — the anchor, and the blocks you have sized before.

**1. Place it against the anchor.** How many anchor-sized units of work is this? Not multiplied out
literally — read it the way you would read "a bit more than a morning" against "a bit more than an
hour". The anchor exists so that everyone sizing anything is reading off the same ruler.

**2. Pick a rung; do not compute one.** 1 · 2 · 3 · 5 · 8 · 13 · 20 · 40. The gaps widen on purpose:
at 13, the difference between 13 and 14 is precision you do not have, and the ladder is what stops
you manufacturing it. Round to the nearest rung and move on.

**3. Compare against what you have already sized.** The second half of any relative scale is your
own history — "bigger than the docs pass I called 8, smaller than the migration I called 40". Your
recent bands are visible in `est board`.

**4. If it will not sit on a rung, split it.** Two far-apart rungs both feeling right, or the work
resisting comparison at all, means the whole task is the wrong unit — not that you should stare
harder. Split it and size the pieces. Above ~40 points that is mandatory; see below.

**5. `--raw-p90` is your own honest bad case, in points, on the same ladder.** Not p50 times a
habitual constant. Name what actually goes wrong on work of this shape — an agent needs a second
pass, a phase gets re-run, the search is wider than anyone thought — and size *that* world. During
cold start the calibrator's multipliers are exactly 1.0, so the number you write is the number that
is shown; do not narrow it because it looks embarrassing.

**6. Reconcile with the drivers you are about to commit.** State `exp_agents`, `exp_wf_phases`,
`exp_files_write`, `exp_turns`, `exp_requests` as numbers and check they tell the same story as the
band — twelve agents against a 5-point p50 is a contradiction, and the retro will find it. These are
audited against actuals, and they are what let a miss be *diagnosed* (orchestrator vs sub-agent)
rather than merely recorded.

**7. Watch it.** `est burn` mid-task is the feedback loop. What it measures is **Work-CET consumed**
— that is always real, because it is read off the logs. A *percentage of the band* is only
meaningful where a points→Work-CET rate exists to convert the band with; with no rate the band is
still denominated in points and a share of it is not a quantity. Blowing past p50 while the work is
visibly half-done means `est open --tid <tid> --reason refinement`, not silence.

### Decomposition is mandatory for large work

Whole-task sizing decays as the task grows — a single number for a large piece of work does not
reliably grasp its scale, and no amount of care fixes that from the outside. So it is a rule, not
advice:

**If the band would land above ~40 points, or the work spans a workflow with more than one phase,
decompose it before you state any number.**

- Split into phase-sized blocks: one per declared workflow phase, or one per coherent chunk of work
  if there is no workflow.
- Size each block on the ladder, by the same comparison as above.
- **The task band is the sum of the block bands** — p50 is the sum of block p50s, p90 the sum of
  block p90s. Do not also form a whole-task guess and reconcile the two; the sum *is* the estimate.
- Then record the blocks with `est block` (see [Workflow blocks](#workflow-blocks)), which needs a
  tid to attach to.

`est block` requires an existing estimate, so the order matters — and there is only one right one:

**Size each phase → sum them yourself → `est open` ONCE with that sum → `est block` per phase.**
That is the canonical order, in the CLI's own words. The blocks *record* the decomposition for
per-phase attribution; they do not replace a band that was already the decomposed number.

The reason is one clause: **`est close` scores the first estimate.** Baseline accuracy is fitted
from `MIN(eid)`, and so is `velocity_raw` — and therefore the points→Work-CET rate. So opening with
a coarse whole-task guess and rolling the blocks up afterwards leaves that coarse guess as *both*
the scored baseline and the sample the rate is fitted from. That is precisely the whole-task number
decomposition exists to avoid, and doing it that way defeats this rule silently.

**`--from-blocks` is a refinement lever, not a way to open.** It requires `--tid`, so it can only
ever land as a re-estimate. Reach for it when you genuinely re-sized the phases mid-task and the
block set under the current estimate is now the truth: `est open --tid <tid> --reason refinement
--from-blocks` takes p50 and p90 from `SUM(estimate_block)`, so the total cannot drift from its
parts and you are not retyping arithmetic the rows already hold.

Work that sits comfortably on a rung at or below 40 and has no phases is still estimated whole. Do
not manufacture blocks for it.

### Worked example — illustrative, not corpus data

A three-phase workflow: survey the call sites, land the change, review it. Sized separately: 5 · 20
· 8, so `--raw-p50 33`. The p90s are per-block and are not all the same story — the survey is what
it is (5), the change is where a second pass lives (40), review may need a re-run (13) — so
`--raw-p90 58`. Then `est block --phase 0/1/2` records the three, and each phase gets scored on its
own afterwards.

### What `est refclass` is for, and what it is not

Run it first, every time, and read it. It confirms the unit and the anchor, it frames your `--kind`
and `--fanout`, and if your number lands far from everything it shows, that is worth a second look
at your decomposition.

**It is a sanity check, not an anchor. Do not replace your number with one derived from its rows.**
Two reasons, and the second is the one that matters: a row's `actual` is the **whole task** —
orchestrator, sub-agents and auxiliary spend together — so `actual / fanout` is not a per-agent size
and adding orchestrator turns on top of it double-counts them; and an estimate copied out of
observed history is no longer an independent reading of your own judgement, which is the only thing
this system exists to collect. Points make those rows genuinely comparable in a way the old unit
never was, which makes the temptation stronger rather than weaker. This is deliberate. Do not
restore the anchoring.

Three regimes, none of them a number to copy:

- **No matching rows.** It says so and exits 0 — an empty reference class is a valid answer. Your
  sizing stands on its own.
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
2. **Drivers, then band** — the `exp_*` numbers, then `raw_p50` / `raw_p90` in points (summed from
   blocks when decomposition applies).
3. **`est open`** — mints the tid and applies calibration:

   ```
   est open --kind <k> --subject <text> [--description <text>] [--dod <json|@file>] \
            --raw-p50 <points> --raw-p90 <points> \
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
6. **Show one line to the user** — the p50/p90 points and whatever else `est open` actually printed:
   nothing it did not. There is no active-time band; and until a points→Work-CET rate exists for the
   bucket there is no Work-CET or spend line either. Do not invent one. That line is the entire
   user-facing friction. Do not narrate the ceremony.

If `est` errors or is unavailable, say so in one clause and get on with the work. **Never fabricate
a band to satisfy the ceremony.**

## Workflow blocks

For any **T1** task, one estimate per declared `meta.phases` entry, **written before the launch**.

```
est block <tid> --phase <i> --title <t> --p50 <points> --p90 <points> [--exp-agents <n>] [--model <m>]
```

- **Blocks are the primary estimate for large work.** When decomposition applies — above ~40 points,
  or more than one phase — the task band **is** the sum of the blocks, and the blocks are where the
  judgement actually happened. Only for small single-phase work is the task band an independent
  number that blocks merely check.
- **`--phase` is 0-BASED** — for a workflow, the `phases[]` array index; for a non-workflow
  decomposition, your own block's position numbered from 0. A 1-based value silently mis-joins every
  block estimate to the wrong phase: it fails nothing and reports nothing, it just makes the numbers
  wrong.
- **Every `agent()` call carries `label` and `phase`.** These are what make per-phase attribution
  possible at all; unlabelled or unphased workflow agents are reported as a data-quality defect.
- **`est block` needs an estimate to attach to**, so `est open` comes first — with the sum of the
  blocks you have already sized. Its refusal says so: *"block estimates roll up to a task band, they
  never replace one"*.
- **Every block prints the roll-up so far**, which *should converge on the band this task was opened
  with*. That is the check the line exists for. If it has genuinely moved, the line names the remedy
  — `est open --tid <tid> --reason refinement` — and it deliberately does not advertise
  `--from-blocks` from inside the blocking loop.
- **`--from-blocks` refuses three things**, all exit 1: without `--tid` (blocks hang off an
  estimate, so there has to be one to roll up — which is exactly what confines it to being a
  refinement); alongside `--raw-p50` or `--raw-p90` (a roll-up and a parallel guess are two answers
  to one question, and it will not silently pick one); and on a tid with no blocks yet, naming
  `est block`.
- **Blocks attach to the task's latest estimate, and the roll-up reads that same one.** So a
  `--from-blocks` refinement mints a fresh estimate with **no** blocks under it: running it twice in
  a row fails, and re-blocking after any re-estimate means issuing every block again against the new
  one. That is the same append-only discipline as everything else here, not a bug.

Appending is the only revision: a duplicate `(estimate, phase)` is rejected.

## Re-estimating

Append, never edit. Two reasons in ordinary use, and they are **not** interchangeable:

- **`est open --tid <tid> --reason refinement`** — same goal, you now know it is bigger. The task
  **stays** in velocity stats and the refinement is scored as mid-task predictive skill.
- **`est scope <tid> --reason <text>`, then `est open --tid <tid> --reason scope_change`** — the
  goal itself moved. The task is **removed** from velocity stats, so it is not available by
  assertion: `est scope` refuses a no-op and `est open` verifies the scope actually advanced.

Re-estimating means re-sizing on the same ladder against the same anchor — re-pointing a story, not
adjusting a forecast toward what you have now spent. If the decomposition changed, re-size the
blocks and re-sum.

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

- `references/unit-and-calibration.md` — the story point and its anchor, points→Work-CET velocity, the calibration pipeline, why the estimand changed, why nothing gates, why this skill's own spend is excluded, and the open question about p90.
- `references/re-estimation.md` — the three reasons in full, the exit-2 rationale, the two 2026-07-30 near-duplicate incidents.
- `references/closing.md` — the quiescence gate, right-censoring, `--accept` verification, reopening after a sweep close, how the retro scores.
- `references/cli-surface.md` — every verb outside the ceremony, global flags, the tunable constants.

`est --help` is the authority whenever this skill and the CLI disagree.

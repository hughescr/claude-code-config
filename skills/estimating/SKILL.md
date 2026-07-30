---
name: estimating
description: Record a calibrated token estimate before starting substantial work, using the `est` CLI. Use at the start of the anchoring turn — prompt read, plan formed, nothing launched — whenever the planned work involves a Workflow launch, two or more Task/agent launches, three or more orchestrator turns toward one goal, or the user asked for an estimate or a budget. Also use to add per-phase workflow block estimates before launching, to re-estimate by refinement or scope change, and to close and score a task on completion. Not for lookups, single-file edits, or one background agent on an errand.
---

# Estimating

Record an estimate **before** starting substantial work, then let the system score it against
what actually happened. Under a minute of friction. Nothing here blocks anything.

**`est` means `bun run ~/.claude/estimator/src/cli.ts`** wherever it appears below. A shim on
`PATH` is optional (`cd ~/.claude/estimator && bun link` mints one); if `which est` comes back
empty, use the long form rather than skipping the step.

## 1. The predicate — when this applies

An estimate is required before starting work when the planned goal involves **ANY** of:

- **T1** — a `Workflow` launch. Always substantial, no judgement call.
- **T2** — ≥ 2 `Task`/agent launches.
- **T3** — ≥ 3 orchestrator turns of coordinated work toward one goal.
- **T4** — the user explicitly asks for an estimate or a budget.

**Exempt:** a single background agent on a trivial errand, lookups, single-file edits.

**T1 and T2 are mechanically detectable after the fact; T3 and T4 are not.** "Coordinated work
toward one goal" is a semantic judgement no log records, and a verbal request for a budget is not
distinguishable from other prose. So skipping the ceremony on a T3 task is invisible to every
compliance metric. Treat this as a standing rule you keep, not as something a backstop will catch.

**The estimation moment** is the start of the anchoring turn: after reading the prompt and forming
a plan, **before** launching any delegation. Estimating later biases the actuals low, because the
task's attribution window opens at the anchoring turn — planning and reading spend is inside the
estimate's coverage, by design.

## 2. Observe-first — nothing blocks, so the ceremony has to earn its keep

There is no gate on this, and none is planned. No command refuses to run because an estimate is
missing. The standing response to falling compliance is to refine the wording of the rule, not to
install a blocker on the hot path.

That is a design constraint on how you run this, not a footnote: be fast, produce one useful line,
and get out of the way. If `est` is unavailable or errors, say so plainly in one clause and carry
on with the work — **never fabricate a band to satisfy the ceremony.**

## 3. The ceremony, in order

The order matters more than any individual step. Running step 3 before step 1 destroys the value
of the whole thing.

1. **Reference class first — before you state any number.**

   ```
   est refclass --kind <research|design|implement|refactor|debug|review|ops> \
                --fanout <n> --text "<subject>"
   ```

   Read-only, writes nothing, exits `0` even with no matches — an empty reference class is a valid
   and informative answer. It returns similar completed tasks with their raw estimate, actual, and
   velocity, plus the bucket's calibration state. **Anti-anchoring is the entire reason it comes
   first.** Below a bucket of 10 it labels itself `uncalibrated` and shows no multiplier; that is
   honesty, not a defect. `--fanout <n>` is your planned agent count and narrows to a comparable
   fan-out as a tolerance band (half to double); if nothing in the corpus ran at a comparable
   fan-out it says so and shows the unfiltered class. `--full` spills the unbudgeted form to a file
   and prints the path.

2. **Parametric commitment — drivers as numbers, before any token figure.**

   State `exp_agents`, `exp_wf_phases`, `exp_files_write`, `exp_turns`, `exp_requests`. These are
   audited against actuals later, and they are what let a miss be diagnosed (orchestrator vs
   sub-agent) instead of merely recorded.

3. **Raw band — `raw_p50` and `raw_p90`, never a point estimate.**

   Your raw number is stored as a **feature and treated as a floor, never a mean.** See §7.

4. **`est open` — mint the task and apply calibration.**

   ```
   est open --kind <k> --subject <text> [--description <text>] [--dod <json|@file>] \
            --raw-p50 <n> --raw-p90 <n> \
            --exp-agents <n> --exp-wf-phases <n> --exp-files-write <n> \
            --exp-turns <n> --exp-requests <n>
   ```

   Mints the `tid` and returns the calibrated band. Below a bucket of 10 the band is labelled
   `uncalibrated` and equals the raw band — cold start is explicit, not faked.

5. **Definition of Done, captured now.** Pass `--dod` with each item tagged `deterministic` (a
   machine-checkable command) or `human` (the user judges). Capturing it at estimate time is what
   stops "done" from being renegotiated later to fit whatever got built.

6. **Plant the identity.** `est open` prints the exact call to make, on its own line, behind a
   stable marker:

   ```
   EST_PLANT: TaskUpdate({ taskId: "<n>", metadata: { est_tid: "<uuidv7>" } })
   ```

   **Issue that call verbatim** when a Task-tool task exists for this work. `est` is a CLI and
   cannot write Task metadata; you are the only actor who can. The planted key is what stitches the
   task back together across sessions. If no Task-tool task exists, skip this — the `tid` stands
   alone and everything else still works.

7. **Show the band.** One line to the user: Work-CET p50/p90, request-count band, spend forecast —
   whatever `est open` actually printed, and nothing it did not. (There is no active-time band:
   Phase 1 predicts none, so do not invent one.) That line is the entire user-facing friction. Do
   not narrate the ceremony.

**The rest of the surface**, for when the ceremony above is not what you need:

- `est bind <tid> [--session <sid>] [--task <n>] [--run <runId>] [--agent <agentId>]` — attach a
  harness identity to a task after the fact. This is how a resumed session, a workflow run or a
  sub-agent gets its spend booked to the right `tid`.
- `est burn [<tid>] [--session <sid>]` — consumption so far against the band. Read-only, never
  writes, always exits `0`; `--json` is the statusline's contract, so leave its shape alone.
- `est board [--status <column>] [--limit <n>]` — the read model: every task with its band, its
  burn and its status.
- `est config` / `est config get <k>` / `est config set <k> <v>` — the calibration constants.
  Tuning is the user's call, not yours.
- `est --help` lists everything, and is the authority when this file and the CLI disagree.

## 4. Per-block estimates — every workflow block, no exceptions

For any **T1** task, one estimate per declared `meta.phases` entry, **written before the launch**,
in addition to the task-level band. You author the workflow script, so the shape of the work is
known at authoring time, and smaller items estimate better.

```
est block <tid> --phase <i> --title <t> --p50 <n> --p90 <n> [--exp-agents <n>] [--model <m>]
```

Three rules travel with it:

- **`--phase` is 0-BASED.** It is the `phases[]` array index. This is the single easiest thing to
  get wrong in the whole ceremony: passing a 1-based value silently mis-joins every block estimate
  to the wrong phase. It fails nothing and reports nothing — it just makes the numbers wrong.
- **Every `agent()` call carries `label` and `phase`.** These are what make per-phase attribution
  possible at all. Unlabelled or unphased workflow agents are reported as a data-quality defect,
  never silently tolerated.
- **Roll-up, not replacement.** Blocks roll up beside the task band as a consistency check. The
  **task band stays the calibrated number** — it is what the user is shown, what baseline accuracy
  is judged against, and the only thing an overrun nudge fires against.

Appending is the only way to revise: a duplicate `(estimate, phase)` is rejected. Re-estimating a
block means issuing a new estimate and blocking against that.

## 5. Re-estimation — `refinement` vs `scope_change`

Append, never edit. The two reasons are **not** interchangeable, and the asymmetry is the point:

| | `est open --reason refinement` | `est scope` → `est open --reason scope_change` |
|---|---|---|
| Means | Same goal, you now know it is bigger | The goal itself moved |
| Calibration | Task **stays** in velocity stats | Task is **removed** from velocity stats |
| Scored as | Mid-task predictive skill, reported *beside* baseline accuracy | Not scored |
| Precondition | none | a real `est scope` revision must land **first** |

Baseline accuracy is **always** judged against the **first** estimate. A refinement never becomes
the baseline — that is what makes "the cone of uncertainty narrows" a measurement rather than a
slogan.

`scope_change` is the only reason that removes a task from the calibration corpus, which makes it
the one lever that could make a bad estimate disappear. So it is not available by assertion:

```
est scope <tid> --reason <text> [--subject <t>] [--description <t>] [--dod <json|@file>]
est open --tid <tid> --reason scope_change ...
```

`est scope` refuses a no-op revision, and `est open` verifies the scope actually advanced past the
baseline estimate's. **A scope change is a fact in the scope history, or it is not a scope change.**

**Exit code `2` is the anti-Goodhart code.** It means the command was well-formed and the operation
is not permitted. Never retry it, never work around it, never downgrade it to a warning — its
message names the append path that *is* allowed. Take that path or leave the record alone.

## 6. Closing and scoring on completion

```
est close <tid> [--status completed|abandoned|deleted|reopened]
est close <tid> --accept "<the human's verbatim words>"
```

`--status reopened` is the append-only remedy the exit-`2` message points you at when a task is
already closed: reopen it, then close it again. There is no edit of the previous close.

**There is no flag that accepts a token count, a cost, or a velocity, and there never will be.**
The actual is computed by deterministic SQL over the harness's own logs — never from anything you
report. Do not offer a number; you do not have one.

`est close` runs a quiescence check (a completion signal or staleness, no attributable request in
the quiet window, no open turn, no live session, every bound agent terminal). If it exits `2` it
names the failing condition — wait for quiescence and close again, or leave it for the sweeper.

**`--accept` is the one bypass you may use, and only on explicit human consent.** The user does not
know this CLI exists; what they do is say the work is done.

The criterion is narrow and positive: **a first-person acceptance of completion, addressed to the
work.** "I accept the task is done", "I approve this as complete", "accepted, close it out". That
shape and nothing looser. Silence, thanks, praise, "nice", "ship it", moving on to another topic,
and your own reading that the work looks finished are **not** acceptance. **When it is not clearly
that shape, ask** — "do you accept this task as complete?" — and wait. Construing a borderline
phrase as consent is the failure this flag is designed around; asking costs one turn.

Then close with their words quoted verbatim:

```
est close <tid> --accept "<their words, exactly as they typed them>"
```

The quote is **verified against the transcript**: `est close` looks for those words in a human
message of a session bound to the task, and exits `2` if they are not there. Three things a quote
must be, so pass the whole sentence rather than a word of it — at least 12 characters, matching as a
**whole phrase** (a common word like "ok" or "done" is not consent, and will not match inside a
longer one), and **said after the task was opened** (an acceptance from earlier in the session was
about something else). Paraphrasing fails the check, and inventing an acceptance is the one thing
you must never do — the verification exists because an agent asserting "they accepted" is exactly
the self-report this design refuses everywhere else. What lands in `anomaly(accepted_close)` is the
quote itself, which is the entire audit trail for a close no arithmetic authorised.

`--accept` closes as `completed` (or `abandoned`); it cannot be combined with `--force`, and it
cannot reopen or delete. `--force` is unchanged and remains **the user's tool, never yours.**

Closing is a revision, never an edit: a later close appends a new revision and the latest one wins.
Nothing is overwritten.

Scoring happens in the retro, which is where the estimate finally earns or loses its keep:

```
est retro --dry-run
```

`--dry-run` computes and prints without writing back, and is the right default habit while the
corpus is small.

## 7. The calibration lesson — read this before you state a number

**Raw self-estimates run about 3× low.** That is the measured, repeated finding, and it is the
reason every part of this ceremony is shaped the way it is:

- Model self-predictions of token usage correlate weakly with actuals (roughly r = 0.2–0.39) and
  are **systematically biased low**, and identical tasks vary up to ~30× run to run.
- So the raw band is a **feature and a floor, never a mean**; calibration is mandatory; every output
  is a p50/p90 band; and raw-versus-calibrated velocity are tracked separately so it stays visible
  whether the calibrator is actually working.
- The correction you should expect in your own head: whatever number feels right, the honest band
  is wider and higher than that. Do not narrow a band because it looks embarrassing.
- **Never self-report tokens.** Estimates are predictions and are labelled as such; actuals come
  from the logs.

Early bands will be wide and humbling. That is the system working, not failing.

## 8. This skill's own cost is excluded

Requests emitted under the `estimating` skill book to overhead and are excluded from the task's
actual. Improving the ceremony must not worsen the numbers the ceremony produces. Keep it under a
minute anyway — that is the constraint that makes it survivable, not a target to spend up to.

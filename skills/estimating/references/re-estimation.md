# Reference: re-estimation, and the near-duplicate incidents

Covers the three re-estimate reasons in full, why exit code 2 is never worked around, and the two
2026-07-30 incidents the near-duplicate warning was built from. `est --help` and the code win any
disagreement with this file.

## The reasons

Re-estimation is append-only: a new `estimate` row, a new version, nothing edited.

| | `refinement` | `scope_change` | `recalibration` |
|---|---|---|---|
| Means | Same goal, you now know it is bigger | The goal itself moved | Same goal, same size; re-issue the band under newer multipliers |
| Calibration | Task **stays** in velocity stats | Task is **removed** from velocity stats | Task **stays** |
| Scored as | Mid-task predictive skill, reported *beside* baseline accuracy | Not scored | Not scored separately |
| Precondition | none | a real `est scope` revision must land **first** | none |

Baseline accuracy is **always** judged against the **first** estimate (`eid_at_start`). A
refinement never becomes the baseline — that is what makes "the cone of uncertainty narrows" a
measurement rather than a slogan. It is agile's re-pointing rule, and under a story-point estimand
it is that rule literally: you may re-point a story, and the burn-up still remembers what you
originally said.

Re-pointing means re-sizing against the same anchor on the same ladder — a fresh reading of how big
the work now looks. It is **not** an adjustment toward what has already been spent; the whole
mechanism depends on the new number being another independent judgement. Where the task was
decomposed, re-size the blocks and re-sum rather than nudging the total, and append the new blocks
against the new estimate.

`recalibration` is rare in practice. Use it when the estimate itself has not changed but the
multipliers have — for instance a long-running task opened during cold start that you want re-banded
after a retro brought the bucket over the threshold.

## Why `scope_change` is not available by assertion

It is the only reason that removes a task from the calibration corpus, which makes it the one lever
that could make a bad estimate disappear. So it costs a fact:

```
est scope <tid> --reason <text> [--subject <t>] [--description <t>] [--dod <json|@file>]
est open --tid <tid> --reason scope_change ...
```

`est scope` refuses a no-op revision, and `est open` verifies the scope actually advanced past the
baseline estimate's `scope_seq`. **A scope change is a fact in the scope history, or it is not a
scope change.**

## Exit code 2

Exit `2` means the command was well-formed and the operation is not permitted. It is the
anti-Goodhart code: it exists specifically at the points where a well-meaning agent would otherwise
tidy the record into looking better than it was. Never retry it, never work around it, never
downgrade it to a warning. Its message names the append path that *is* allowed; take that path or
leave the record alone. (Exit `1` is a malformed command line — a different thing, and worth
fixing.)

## `--continue <tid>`

Sugar for the common case: binds the current session to the task and appends a refinement in one
call. Equivalent to `est bind <tid> --session <sid>` followed by `est open --tid <tid> --reason
refinement`.

## The near-duplicate warning, and the two incidents it came from

When a session already has an open task whose subject overlaps yours, `est open` prints a warning
to stderr and carries `near_duplicates: [{tid, subject, status, overlap}]` in its `--json` output.
It still mints, and the exit code is still `0` — nothing gates. Overlap is the overlap coefficient
`|A ∩ B| / min(|A|, |B|)` over content tokens, plus a fallback exact-match on the normalised
subject for terse subjects that tokenise to nothing.

Two real incidents on 2026-07-30:

1. **A session re-opened for work it was already tracking.** The subject had grown — "sweeper close
   pass" became "sweeper close pass, cron recon, SessionStart hook and the near-duplicate warning"
   — and a second `est open` felt like the natural move. It was a `refinement`.
2. **A sub-agent minted its own tid** for a slice its orchestrator had already estimated. It should
   have run `est bind`.

Both split one session's spend across two tasks, so **both** actuals come out wrong and neither
task looks broken afterwards: each has a plausible band and a plausible burn, and only the sum is
nonsense. That silence is why the warning was added, and why the rule in SKILL.md is to stop rather
than to note it and continue.

Jaccard was rejected for the overlap measure because it punishes a long subject for being long:
the pair in incident 1 scores ~0.3 under Jaccard and slips under any threshold worth having.

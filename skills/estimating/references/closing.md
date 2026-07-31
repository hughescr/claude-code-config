# Reference: closing, the quiescence gate, censoring and the retro

Covers what `est close` checks before it finalizes, why an abandoned outcome measures nothing, how
to resume work the sweeper closed, and how scoring happens. `est --help` and the code win any
disagreement with this file.

## The quiescence gate

`est close` will not finalize a task that might still be running. It checks, roughly: a completion
signal or staleness; no attributable request inside the quiet window (`quiesce_main_min`, 60
minutes); no open turn; no live session; every bound agent still accounted for. If a condition
fails it exits `2` and names it.

Since 2026-07-30 the remedy that exit-`2` message points at begins **"do nothing"** — the sweeper's
close pass really does finalize quiet tasks, on every sweep, through the same gate with no bypass.
Waiting is the correct move whenever the work actually finished and the harness recorded it.

Tunables, all in `est config`: `quiesce_main_min` (60), `close_blocked_after_h` (24),
`close_abandon_after_h` (168), `close_pass_min_interval_min` (10), `close_fail_alert_after` (3).

## Why waiting is not always free — right-censoring

A task with **no** completion signal is eventually closed **`abandoned`**, after
`close_abandon_after_h` (a week) of silence, recorded as `anomaly(swept_abandon)`. An abandoned or
deleted outcome is **right-censored**: the actual is stored as a lower bound only. Such a task
preserves no measurement and contributes nothing usable to calibration — `v_velocity` filters it
out entirely.

That is the whole reason `--accept` exists. Relaying real human consent is what keeps a task in the
corpus when the harness saw no terminal signal.

## `--accept`, in detail

The quote is **verified against the transcript**: `est close` looks for those words in a human
message of a session bound to the task, and exits `2` if they are not there. Three properties the
quote must have:

- **at least 12 normalized characters** — a bare `--accept "ok"` is not consent;
- **whole-phrase match** — a common word will not match inside a longer sentence;
- **said after `task.created_at`** — a session is long-lived and hosts many tasks, so an acceptance
  from earlier in the session was about something else.

Paraphrasing fails the check. The verification exists because an agent asserting "they accepted" is
exactly the self-report this design refuses everywhere else. What lands in `anomaly(accepted_close)`
is the quote itself, which is the entire audit trail for a close no arithmetic authorised.

`--accept` closes as `completed` (or `abandoned`); it cannot be combined with `--force`, and it
cannot reopen or delete. `--force` is Craig's own override at a terminal, records
`anomaly(forced_close)`, and is never yours.

## Reopening after a sweep close

`est open --tid <tid>` on a finalized task exits `2` and names the command:

```
est close <tid> --status reopened
```

That APPENDS a revision — nothing is edited or lost — and re-opens the task's attribution window.
Until it lands, every hour of the resumed work is metered against nothing; resumed spend does not
re-attach on its own. There is a reopen floor on the completion-signal check, so the event that
justified the *first* close cannot silently justify a second one.

`est census` shows the `swept_abandon` row if you want to see when and why a task was closed.

Closing is a revision, never an edit: a later close appends a new revision and the latest one wins.

## Scoring

```
est retro --dry-run
```

`--dry-run` computes and prints without writing back, and is the right default habit while the
corpus is small. The retro:

- fits `mult_p50` / `mult_p90` per bucket from the decay-weighted log-velocity sample and writes
  them back to `refclass`;
- scores issued bands with **pinball loss** (headline: has power at small n, and scores a band
  rather than a point) and **log score** beside it (pinball goes insensitive once a miss is outside
  the band; log score does not);
- reports coverage against the 0.90 target with a **Jeffreys interval**, because coverage at n = 30
  carries a ~7-point standard error and a raw reading of 0.73 must not trigger band-widening. The
  interval is what stops the calibrator chasing its own noise;
- reports **bias and noise separately** (`mult_p50` vs `mult_p90`), because they need opposite
  fixes — shift the reference class vs widen the band — and one blended multiplier hides which
  moved;
- reports the orchestrator/sub-agent split of velocity, which is what lets a miss be *diagnosed*
  rather than merely recorded, and is why the `exp_*` drivers are worth stating.

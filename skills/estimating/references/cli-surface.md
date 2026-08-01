# Reference: the rest of the `est` surface

Covers the verbs and flags outside the estimate → block → close ceremony. `est --help` is the
authority and wins any disagreement with this file.

`est` is `bun run ~/.claude/estimator/src/cli.ts`, run from `~/.claude/estimator`. A shim on `PATH`
is optional (`cd ~/.claude/estimator && bun link` mints one).

## Global flags

`--db <path>` (default `$EST_DB`), `--lock <path>` (one lock per database), `-q/--quiet` (for
hooks), `--json`, `-h/--help`.

`--json` output is a contract for real consumers — `est burn --json` is what the statusline reads,
and `est open --json` is what this skill drives — so its shape is not yours to change.

## Verbs you may use

- **`est refclass`** — read-only, takes no lock, **always exits 0**; an empty class is a valid
  answer. Its footer states the unit in force — `ref_model`, `estimand` and the story-point anchor —
  which is the cheapest way to confirm you are sizing against the current anchor. Flags:
  `--text "<subject>"` (FTS5 over completed tasks), `--kind`, `--limit`, `--fanout`
  (a tolerance band, half to double, minimum ±2), `--session` / `--prompt` (the anchor — pass the
  same pair you will pass to `est open`, so the calibration shown here is the one the band gets
  stamped with), `--full` (writes the unbudgeted form to `spool/` and prints the path).
- **`est bind <tid>`** — `[--session <sid>] [--task <n>] [--run <runId>] [--agent <agentId>]`.
  Attaches a harness identity to a task after the fact. This is how a resumed session, a workflow
  run, or a sub-agent gets its spend booked to the right tid.
- **`est burn [<tid>]`** — `[--session <sid>] [--refresh]`. What it measures is **Work-CET
  consumed**, read off the logs; that part is always real. Expressing it as a share of p50/p90
  requires the band to be in Work-CET too, so a percentage is meaningful only where a points→Work-CET
  rate exists to convert the band with. Read-only, never writes, always exits 0. With no tid it guesses the most recently
  touched open task and says so. Its `check back ~Nm` line is session-scoped Claude-active time to the next human-input
  boundary, never token-derived, and it flags itself when the model is on probation. Its projection
  is linear and crude by construction: it answers "will this blow the band in the next hour", not
  "when will this finish".
- **`est board`** — `[--status <column>] [--limit <n>] [--html] [--md] [--out <dir>]`. The read
  model: every task with its band, its burn and its status.
- **`est census`** — sweep history, corpus counts, and the anomaly ledger. Where `swept_abandon`,
  `accepted_close` and `forced_close` rows show up. It also carries the **story-points panel**, which
  is the one place the whole unit state is visible at once: the estimand in force (and whether points
  are active at all), the anchor id and text, how many `estimate` rows are denominated in points, the
  seed rate with a **LIVE / IGNORED** verdict — ignored meaning it was reasoned for a different
  anchor than the one in force — and the **effective** points→Work-CET rate with its source
  (`fitted` with its *n*, `seed`, or none at all). The seed is surfaced here precisely because it
  lives in `config` and so appears in no ledger query in the rest of the report.
- **`est config`** / **`config get <k>`** — the calibration constants. `config set` is Craig's call,
  not yours; the key set is closed, so an unknown key exits 2 rather than being silently accepted.

## Verbs that are Craig's, or the sweeper's

`sweep`, `backfill`, `init`, `prices`, `recon`, `segments`, `audit`, `retro` (writing form),
`repair-identity --apply`, `close --force`. Read-only forms — `retro --dry-run`, `recon --dry-run`,
`repair-identity` with no flags, `audit` without `--fix` — are safe to run if you have a reason.

## Constants worth knowing

| key | value | what it governs |
|---|---|---|
| `ref_model` | `claude-sonnet-4-5` | the Work-CET normaliser — applied to the measured actual, never to your band |
| `estimand` | *read it* | the denomination the raw band is stated in. `story_point` (singular) is the points estimand; the cutover is `est config set estimand story_point` and is Craig's call. Velocity is never pooled across two of these, so the old `work_cet` corpus sits beside the new one and never mixes with it |
| `sp_anchor_id` | `v1` | which story-point anchor definition is in force. Pinned per estimate as `estimate.sp_anchor_id`, like `ref_model` and `price_epoch`; a redefinition changes what historic points mean, which is why the pin exists |
| `sp_anchor_text` | *read it* | the work defined to be 1 point. Move it and `sp_anchor_id` together or the redefinition is silent |
| `sp_seed_wcet_per_point` | *unset* | bootstrapped Work-CET per point, used only while no fitted rate exists. Empty = unset = no Work-CET forecast is issued. A convention, which is why it is a `config` row and not a ledger row |
| `sp_seed_anchor_id` | *unset* | the anchor the seed was reasoned against. The seed is ignored unless this equals `sp_anchor_id` |
| `sp_max_points` | 1000 | sanity ceiling on a points quantile. Outside `[1, n]` under `story_point`, `est open` / `est block` exit **1** — a malformed command line, not a refusal |
| `shrink_k` | 10 | the `k` in the shrinkage weight `n / (n + k)` — how far a calibrated bucket's own median is pulled toward the global one |
| `velocity_half_life_days` | 30 | decay on the velocity sample |
| `quiesce_main_min` | 60 | the close gate's quiet window |
| `close_abandon_after_h` | 168 | silence before a task is swept `abandoned` |

Read them with `est config`; the values above are a snapshot, not a source.

**`COLD_START_N` is not in this table and is not tunable.** The threshold below which `est open` and
`est refclass` refuse to calibrate is hardcoded at 10 in `src/tasks.ts`. It equals `shrink_k`'s
default by coincidence only — changing `shrink_k` does not move it. See
[unit-and-calibration.md](unit-and-calibration.md) for the difference.

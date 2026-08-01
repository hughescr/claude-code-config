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
  answer. Flags: `--text "<subject>"` (FTS5 over completed tasks), `--kind`, `--limit`, `--fanout`
  (a tolerance band, half to double, minimum ±2), `--session` / `--prompt` (the anchor — pass the
  same pair you will pass to `est open`, so the calibration shown here is the one the band gets
  stamped with), `--full` (writes the unbudgeted form to `spool/` and prints the path).
- **`est bind <tid>`** — `[--session <sid>] [--task <n>] [--run <runId>] [--agent <agentId>]`.
  Attaches a harness identity to a task after the fact. This is how a resumed session, a workflow
  run, or a sub-agent gets its spend booked to the right tid.
- **`est burn [<tid>]`** — `[--session <sid>] [--refresh]`. Consumption against the band. Read-only,
  never writes, always exits 0. With no tid it guesses the most recently touched open task and says
  so. Its `check back ~Nm` line is session-scoped Claude-active time to the next human-input
  boundary, never token-derived, and it flags itself when the model is on probation. Its projection
  is linear and crude by construction: it answers "will this blow the band in the next hour", not
  "when will this finish".
- **`est board`** — `[--status <column>] [--limit <n>] [--html] [--md] [--out <dir>]`. The read
  model: every task with its band, its burn and its status.
- **`est census`** — sweep history, corpus counts, and the anomaly ledger. Where `swept_abandon`,
  `accepted_close` and `forced_close` rows show up.
- **`est config`** / **`config get <k>`** — the calibration constants. `config set` is Craig's call,
  not yours; the key set is closed, so an unknown key exits 2 rather than being silently accepted.

## Verbs that are Craig's, or the sweeper's

`sweep`, `backfill`, `init`, `prices`, `recon`, `segments`, `audit`, `retro` (writing form),
`repair-identity --apply`, `close --force`. Read-only forms — `retro --dry-run`, `recon --dry-run`,
`repair-identity` with no flags, `audit` without `--fix` — are safe to run if you have a reason.

## Constants worth knowing

| key | value | what it governs |
|---|---|---|
| `ref_model` | `claude-sonnet-4-5` | the Work-CET normaliser |
| `estimand` | `work_cet` | which counters the unit includes |
| `shrink_k` | 10 | the `k` in the shrinkage weight `n / (n + k)` — how far a calibrated bucket's own median is pulled toward the global one |
| `velocity_half_life_days` | 30 | decay on the velocity sample |
| `quiesce_main_min` | 60 | the close gate's quiet window |
| `close_abandon_after_h` | 168 | silence before a task is swept `abandoned` |

Read them with `est config`; the values above are a snapshot, not a source.

**`COLD_START_N` is not in this table and is not tunable.** The threshold below which `est open` and
`est refclass` refuse to calibrate is hardcoded at 10 in `src/tasks.ts`. It equals `shrink_k`'s
default by coincidence only — changing `shrink_k` does not move it. See
[unit-and-calibration.md](unit-and-calibration.md) for the difference.

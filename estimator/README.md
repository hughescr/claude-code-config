# estimator

Token-based task estimation and tracking for Claude Code. Claude Code's transcripts are the
ground truth: a single-writer, flock-guarded sweeper re-derives API requests, turns, agent runs,
workflow runs/phases and task lifecycle events out of the on-disk `.jsonl` corpus into a local
sqlite database, deduplicating cumulative usage snapshots by `MAX` per `(request_id, counter)` so
every sweep is idempotent and a re-sweep is a no-op. On top of those actuals the `est` CLI records
estimate bands before work starts, tracks live burn against them, finalizes outcomes when a task
goes quiet, and calibrates future bands from the resulting velocity history. The currency is
**Work-CET** — price-weighted `output + cache_creation` normalised by a reference model's output
price — with full four-counter spend reported alongside it but never calibrated. Failures are
loud: anything unparseable, unpriced or unmappable lands in the `anomaly` table instead of being
silently dropped or zeroed.

Stack: TypeScript on bun, zero npm dependencies (`bun:sqlite`, `bun:test`). Everything is local —
the database, its WAL sidecars, the OTLP spool and the weekly backups are gitignored and never
leave this machine; only source code is committed.

## Layout

| Path | What it is |
|---|---|
| `DESIGN.md` | The authoritative specification (rev. R4), LOCAL/untracked — see [Design](#design). Every `§` reference in this repo points here. |
| `DECISIONS.md` | Decision ledger: gate verdicts, policy rulings, calibration row zero, deliberate deferrals. LOCAL/untracked. |
| `schema.sql` | The complete DDL. The only source of schema; applied verbatim on init. |
| `src/` | CLI and library code (`db.ts` is the open-or-init helper every path goes through). |
| `scripts/` | Maintenance and operational scripts, plus the two hook entry points — see below. |
| `gates/` | Phase 0 pre-build gate probes (`*.ts`, committed) and their reports (`*.md`, local). |
| `test/` | `bun test` suite. `support.ts` is the shared synthetic fixture builder, not a test file. |
| `tsconfig.json` | Typecheck-only config (`bun run typecheck`); nothing here ever emits. |
| `estimator.db` | The database (gitignored, WAL mode). Override the path with `EST_DB`. |
| `spool/`, `backups/`, `sweep.lock` | Hook spool + OTLP spool, weekly `VACUUM INTO` backups, writer lock — all gitignored. |

Only the gate **probes** are committed. Everything they produce — the `*.json` dumps and the
curated `*.md` reports alike — is corpus-derived data and stays local, alongside `DESIGN.md`,
`DECISIONS.md` and the database itself: a curated report is still written *about* a real corpus,
and this repository is public (`DECISIONS.md` §2, as superseded).

## Commands

Package scripts (Phase 0):

| Command | What it does |
|---|---|
| `bun run init` | Create/verify the database and apply `schema.sql`. |
| `bun run sweep` | Single-writer incremental sweep of the transcript corpus into sqlite. |
| `bun run backfill` | Full re-sweep over every surviving transcript. |
| `bun run prices` | Refresh the model price table from the upstream pricing JSON. |
| `bun run census` | Read-only status: what the collector has, versus what is on disk. |
| `bun run check:schema` | Load `schema.sql` into a throwaway database and assert its shape. |
| `bun run typecheck` | `tsc --noEmit` over `src/`, `test/`, `scripts/`, `gates/` (see below). |
| `bun test` | Test suite. |

The full CLI surface is `est <verb>` (`bun run src/cli.ts <verb>`, or the `est` shim on `PATH`).
Phase 0 collects; **Phase 1 is the estimation loop** and is what the verbs below are:

| Verb | What it does |
|---|---|
| `est refclass --text "<subject>" [--kind <k>] [--fanout <n>] [--full]` | The reference class, **shown before any number is stated** — top-5 FTS5 matches among completed tasks with their raw band, actual and velocity, plus one bucket line. Read-only, takes no lock, capped at 8,000 characters, and **always exits 0**: an empty reference class is a valid answer. Below 10 comparable tasks it prints the raw actual-cost distribution and **no multiplier**. |
| `est open --kind <k> --subject <t> --raw-p50 <n> --raw-p90 <n> --exp-…` | Mint a task (uuidv7) or append a re-estimate with `--tid <tid> --reason refinement\|scope_change\|recalibration`. Applies the bucket multiplier at write time, snapshots `ref_model`/`estimand`/`price_epoch`, and prints the band plus the exact `TaskUpdate` call that plants `est_tid`. `--continue <tid>` is sugar for bind + refinement. |
| `est block <tid> --phase <i> --title <t> --p50 <n> --p90 <n>` | One estimate per declared workflow phase, **before the launch**. `--phase` is **0-based** — the `phases[]` index, not the 1-based `workflowProgress.phaseIndex`. |
| `est bind <tid> [--session] [--task] [--run] [--agent]` | Attach a harness identity to a tid. Idempotent; an alias already bound to a *different* tid is a conflict, never a silent re-point. |
| `est scope <tid> --reason <t> [--subject] [--description] [--dod]` | Append a scope revision with a stored diff. A revision that changes nothing is refused — that is what stops `--reason scope_change` being manufacturable. |
| `est burn [<tid>] [--session <sid>] [--refresh]` | Consumption against the band. Read-only, never sweeps, never locks, **always exits 0**; `--json` is the statusline contract (one indexed `burn_cache` row, read-only connection, 50 ms timeout, well-formed empty result on every failure). |
| `est close <tid> [--status …] [--force]` | Finalize **by arithmetic**. No flag accepts a token count, a cost or a velocity, and none ever will. Blocks on the quiescence gate unless forced (which is recorded). A reopen is a new outcome revision, never an edit. |
| `est board [--status <col>] [--limit <n>]` | Terminal/JSON read model: Estimating · In Progress · Pending Verification · Done (7d) · Abandoned. The HTML/markdown board is Phase 2. |
| `est retro [--as-of <iso>] [--dry-run]` | Weekly calibration panel plus the write-back that makes the ceremony non-inert: one `refclass` snapshot per bucket and one `calib_run` row. `--dry-run` writes nothing and is the right habit while *n* is small. |

Two hook entry points ship with them — `est nudge` (PostToolUse) and `est capture-delete`
(PreToolUse) — via the wrappers in `scripts/`; both are advisory, fail open, and always exit 0.
Phase 2 adds the OTLP receiver, `est recon` and the rendered board.

**Exit codes** are a contract: `0` success *including a well-formed empty result* · `1` usage or
fatal · `2` **rejected by an invariant** · `3` completed with alerting anomalies · `4` the sweep
lock is held. Exit 2 is the anti-Goodhart code — five tables (`task_scope`, `estimate`,
`estimate_block`, `outcome`, `refclass`) are append-only *by database trigger*, so a wrong estimate
is corrected by appending a better one and the wrong one stays visible. There is no `--amend`, no
`--force-overwrite` and no `est delete` anywhere in this CLI.

### `est census`

The one command to run when you want to know whether the collector is telling the truth. It opens
the database **read-only**, never sweeps, and prints four things:

- the last *n* `sweep_census` rows (`--limit`, default 10) — files, bytes, sessions, oldest mtime
  and the vanished-file counters, so corpus shrinkage is visible as history rather than as a
  surprise (§5.8 expects `vanished = 0` while both pruners are stood down);
- row counts for every table that matters (`request`, `turn`, `agent_run`, `workflow_run`,
  `workflow_phase`, `task_event`, `anomaly`, `model_price`, `sweep_state`);
- a **live** walk of the corpus at `--root` (default `~/.claude/projects`) for comparison — this
  is the number that tells you a sweep is overdue;
- the **anomaly ledger**, grouped by kind. Nothing is dropped or zeroed silently in this system, so
  this ledger is where the truth about coverage lives: `malformed_line`, `truncated_tail`,
  `read_error`, `sidechain_replay`, `fork_replay`, `symlink_alias`, `compaction_continuation`,
  `phase_unmapped`, `spawn_depth_gt1`, and the rest.

```
bun run census                 # or: bun run src/cli.ts census --limit 30 --root <path>
```

## Operational scripts — what's wired and what's still manual

`scripts/` holds the scheduled and hook-driven legs of the collector. The cron/launchd leg is
still a separate, undecided install step; the four `~/.claude/settings.json` hooks (`SessionEnd`,
`PreToolUse(TaskUpdate)`, `PostToolUse(Task|Workflow)`) **are wired in** as of Phase 1. Each file's
own header has the detail; this table says only what exists and what its state is.

| File | State | What it does / where the install steps are |
|---|---|---|
| `est-cron.sh` | **NOT INSTALLED** (safe to run by hand) | The scheduled maintenance leg: daily `est sweep --blocking --budget 300s`, plus a stamp-driven weekly `est prices --sync` and `scripts/backup.ts`. Stamp-driven, not day-of-week-driven, so a sleeping laptop delays the weekly leg instead of skipping it. Run it manually any time — every write path is idempotent: `sh scripts/est-cron.sh [--daily|--weekly]`. |
| `com.craig.estimator.plist` | **NOT INSTALLED** | The launchd job that would run `est-cron.sh`. It lives in the repo as a reviewable artefact and takes effect only once copied to `~/Library/LaunchAgents/` and bootstrapped — the exact `cp` + `launchctl bootstrap` + `launchctl enable` sequence, and the removal sequence, are in the file's own header comment. |
| `session-end-sweep.sh` | **WIRED IN** (`SessionEnd`) | The blocking sweep (`--budget 20s`, inside the 30 s hook timeout) so a session's own transcripts land in the DB before the process exits. Referenced by `~/.claude/settings.json` as an **additional** user-level `SessionEnd` entry (hooks merge additively across settings levels — never a replacement). |
| `nudge-hook.sh` / `nudge.ts` | **WIRED IN** (`PostToolUse`, matcher `Task\|Workflow`) | P1.10: one read-only check for an open estimate bound to the session (nudges naming the `estimating` skill if not, ≤500 chars), one spool append to `spool/compliance.jsonl` (never a DB write), and a throttled **detached** micro-sweep so the hook can never consume its own timeout. Also carries the best-effort overrun nudge against `burn_cache` (P1.9); no-ops cleanly on a pre-migration (schema v4) database. Advisory, fail-open, always exits 0 — see the file headers and `test/nudge.test.ts`. |
| `capture-delete-hook.sh` / `capture-delete.ts` | **WIRED IN** (`PreToolUse`, matcher `TaskUpdate`) | P1.11, required by G-DELETE (§6.1): if `tool_input.status === 'deleted'`, appends one atomic line to `spool/task-events.jsonl` before the tool call runs — the only signal that survives a process death between the `tool_use` write and its `tool_result`. Always allows, never denies, always exits 0 — see `test/capture-delete.test.ts` for the mandated kill-simulation regression test. |
| `backup.ts` | Runs on demand; **scheduled only via the plist** | The weekly leg: `VACUUM INTO backups/estimator-<UTC date>.db`, `PRAGMA wal_checkpoint(TRUNCATE)`, then prune to the newest `--keep` (default 8 ≈ two months). Deliberately does **not** take the sweep lock — `VACUUM INTO` is a reader, and a snapshot taken mid-sweep is a valid earlier state, never a torn one. `bun run scripts/backup.ts [--db <path>] [--dir <path>] [--keep <n>]`. |

`est-lib.sh` is not in that list because it is never executed: it is sourced by the shell entry
points to locate `bun` and the `est` CLI, because launchd and hook processes run with a minimal
`PATH` that contains neither `/opt/homebrew/bin` nor `~/.bun/bin`.

## Gate results

§8 makes four probes blocking for Phase 1 logic. All four ran against the live corpus on
2026-07-28. The reports (`gates/*.md`) and the decisions taken on them (`DECISIONS.md` §1) are
local-only, so the verdicts are summarised here and the evidence is not linked: re-run
`gates/g-*.ts` to regenerate it.

| Gate | Verdict |
|---|---|
| G-FORK | **Prior falsified — keep the global `request_id` PK.** Overlap replicates: 5 independent pairs, 643 multi-file requestIds, 100% cross-session, `message.id` agreeing on all 643. Narrowing the key would double-count 2.4% of corpus Work-CET. The uuid-prefix fork detector is replaced by the shared-uuid detector; symlink aliasing and `/compact` continuations are newly documented mechanisms. |
| G-ATTR | **ESCALATED — sticky coverage is 18.7%, not the 82.8% the design assumes** (gate is 70%; the 82.8% was a mis-citation that counted `ambiguous` twice). The historical corpus is **not calibration-grade**: backfill seeds actual-cost distributions, never velocity. Live re-gate after ~2 weeks of real `est` usage. |
| G-PHASE | **No — run/agent grain with labelled inference is the default.** `agentId` join 87.7% against a 95% bar. The exact `workflowProgress` join is promoted to primary once cross-session run pairing and relaunch orphans are handled — **and the pairing fix landed after the gate ran, so re-run `gates/g-phase.ts` before Phase 1.** |
| G-DELETE | **Passed** — 12 of 12 `→deleted` events reconcile, 0 orphaned `TaskUpdate` calls of 562, and transcripts are primary. The `PreToolUse` capture hook is nevertheless **required** insurance: it is the only mechanism that survives a session dying between the `tool_use` and its `tool_result`. |

## Typechecking

`bun run typecheck` runs `tsc --noEmit` against `tsconfig.json` (strict, plus
`noUncheckedIndexedAccess`, `noImplicitOverride` and `noFallthroughCasesInSwitch`). bun runs the
TypeScript directly, so this is a lint pass, not a build step — nothing emits, ever.

**First run needs `bun install`.** `typescript` and `@types/bun` are declared as
`devDependencies` and pinned by the committed `bun.lock`; `node_modules/` is gitignored, so
nothing is vendored and the runtime dependency count is still exactly zero.

`@types/bun` is not optional, and neither is naming it in `tsconfig.json`'s `types` field: without
both, every `bun:sqlite` / `bun:test` import and every `Bun.*`, `console` and `process.*`
reference fails to resolve, and the run drowns in ~220 phantom errors that bury the real ones. A
raw `tsc --noEmit` in a tree that has never been `bun install`ed reports ~230 errors and means
nothing — that is a missing toolchain, not a finding.

Last run (2026-07-28, TypeScript 7.0.2, suite green at 412 tests across 17 files): **0 errors**.
The twelve that stood here before were all real drift between a caller and the code it calls, none
reached at runtime by any test, and all are fixed:

| File | What it was |
|---|---|
| `test/regression.test.ts` | five `.get(x)` calls on queries whose params tuple was declared `[]`, plus a `bytes` property `AgentTranscript` no longer declares |
| `src/ingest.ts`, `src/cli.ts`, `test/cli.test.ts` | `IngestAnomaly["kind"]` did not name the sweep- and discovery-level kinds that go through the same writer, so four `as` casts papered over it |
| `gates/g-attr.ts` | `TranscriptLine` imported from `ingest.ts`, which only re-exported it by accident; a `boolean` assigned to `void` |
| `src/ingest.ts` | a parenthesised conditional feeding `??`, which tsc reads as always nullish (TS2871) |
| `test/prices.test.ts` | a `fetch` stub missing the `preconnect` static |

Typecheck is green but is **not yet wired into a gate** — that is a deliberate follow-up, because
the compiler version is a moving target and a red build should not be able to arrive from a
dependency bump alone.

## Design

The authoritative specification is **`DESIGN.md`** (rev. R4) — kept LOCAL and untracked
(gitignored, alongside `DECISIONS.md` and the `gates/*.md` reports) because it contains private
prompt text and corpus-derived usage data, and this repository is public. Every `§` citation in
this repo points into it. `schema.sql` is now the *only* source of the DDL and the document names
it as such; the `Phase 1 interfaces` section is the contract this CLI's verbs implement, argument
by argument and exit code by exit code. Where this code and that document disagree, the document
wins — or the document gets revised first. These local files are covered by the weekly `backups/`
snapshot job, not by git.

**R4 is the first revision written after contact with the data**, and it exists because Phase 0's
gates falsified three of R3's assumptions — the sticky-attribution coverage figure (G-ATTR: 18.7%,
not 82.8%, which was a mis-citation counting `ambiguous` twice), the narrow-the-`request`-PK prior
(G-FORK: keep the global key), and the leading-uuid-prefix fork detector (replaced by shared-uuid
D3) — and turned up two mechanisms R3 does not describe at all (symlink aliasing, `/compact`
continuations). The consequence that reaches this code: the historical corpus is **not
calibration-grade**, so `est refclass` says `uncalibrated` until real `est`-opened tasks
accumulate, and no attribution constant is frozen anywhere — every one of them is a `config` row.

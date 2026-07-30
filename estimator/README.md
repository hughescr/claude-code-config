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
| `scripts/` | Maintenance and operational scripts, plus the three hook entry points and the ccstatusline burn segment — see below. |
| `gates/` | Phase 0 pre-build gate probes (`*.ts`, committed) and their reports (`*.md`, local), plus `g-smoke.ts` — the Phase 2 end-to-end smoke gate, which writes no report at all. |
| `test/` | `bun test` suite. `support.ts` is the shared synthetic fixture builder, not a test file. |
| `tsconfig.json` | Typecheck-only config (`bun run typecheck`); nothing here ever emits. |
| `estimator.db` | The database (gitignored, WAL mode). Override the path with `EST_DB`. |
| `spool/`, `backups/`, `sweep.lock` | Hook spool + OTLP spool, weekly `VACUUM INTO` backups, writer lock — all gitignored. |

Only the gate **probes** are committed. Everything they produce — the `*.json` dumps and the
curated `*.md` reports alike — is corpus-derived data and stays local, alongside `DESIGN.md`,
`DECISIONS.md` and the database itself: a curated report is still written *about* a real corpus,
and this repository is public (`DECISIONS.md` §2, as superseded).

## Commands

Package scripts:

| Command | What it does |
|---|---|
| `bun run init` | Create/verify the database and apply `schema.sql`. |
| `bun run sweep` | Single-writer incremental sweep of the transcript corpus into sqlite. |
| `bun run backfill` | Full re-sweep over every surviving transcript. |
| `bun run prices` | Refresh the model price table from the upstream pricing JSON. |
| `bun run census` | Read-only status: what the collector has, versus what is on disk. |
| `bun run config` | Read/tune the calibration constants: list, `get <k>`, `set <k> <v>`. |
| `bun run burn` / `board` / `close` / `retro` | Shorthands for the Phase 1 verbs of the same name. |
| `bun run check:schema` | `scripts/check-schema.ts`: load `schema.sql` into a throwaway database and assert its shape. |
| `bun run typecheck` | `tsc --noEmit` over `src/`, `test/`, `scripts/`, `gates/` (see below). |
| `bun test` | Test suite. |

The full CLI surface is `est <verb>`. **On a fresh clone there is no `est` on `PATH`** — every
verb is spelled `bun run ~/.claude/estimator/src/cli.ts <verb>` until you mint the shim, which is
one command from this directory:

```sh
bun link            # package.json declares bin.est -> src/cli.ts; puts `est` in ~/.bun/bin
```

Nothing depends on the shim: `scripts/est-lib.sh` (and therefore every hook) already falls back to
`bun run "$EST_HOME/src/cli.ts"`. It exists so the docs, and an agent following them, can say `est`.
Phase 0 collects; **Phase 1 is the estimation loop** and is what the verbs below are:

| Verb | What it does |
|---|---|
| `est refclass --text "<subject>" [--kind <k>] [--fanout <n>] [--full]` | The reference class, **shown before any number is stated** — top-5 FTS5 matches among completed tasks with their raw band, actual and velocity, plus one bucket line. Read-only, takes no lock, capped at 8,000 characters, and **always exits 0**: an empty reference class is a valid answer. Below 10 comparable tasks it prints the raw actual-cost distribution and **no multiplier**. `--fanout` narrows to a comparable agent fan-out as a **tolerance band** (half to double, minimum ±2), never equality, and falls back to the unfiltered class — saying so — rather than manufacturing an empty one. |
| `est open --kind <k> --subject <t> --raw-p50 <n> --raw-p90 <n> --exp-…` | Mint a task (uuidv7) or append a re-estimate with `--tid <tid> --reason refinement\|scope_change\|recalibration`. Applies the bucket multiplier at write time, snapshots `ref_model`/`estimand`/`price_epoch`, and prints the band plus the exact `TaskUpdate` call that plants `est_tid`. `--continue <tid>` is sugar for bind + refinement. |
| `est block <tid> --phase <i> --title <t> --p50 <n> --p90 <n>` | One estimate per declared workflow phase, **before the launch**. `--phase` is **0-based** — the `phases[]` index, not the 1-based `workflowProgress.phaseIndex`. |
| `est bind <tid> [--session] [--task] [--run] [--agent]` | Attach a harness identity to a tid. Idempotent; an alias already bound to a *different* tid is a conflict, never a silent re-point. |
| `est scope <tid> --reason <t> [--subject] [--description] [--dod]` | Append a scope revision with a stored diff. A revision that changes nothing is refused — that is what stops `--reason scope_change` being manufacturable. |
| `est burn [<tid>] [--session <sid>] [--refresh]` | Consumption against the band. Read-only, never sweeps, never locks, **always exits 0**; `--json` is the statusline contract (one indexed `burn_cache` row, read-only connection, 50 ms timeout, well-formed empty result on every failure). Phase 2 (P2.2) adds two objects to that payload, additively: `check_back` — the forecast of Claude-**active** time to the next human-input boundary, **session**-scoped and **never token-derived** — and `compute`, the API-time clock with the coverage share it is a fraction of. `check_back` has three shapes, all well-formed at exit 0: a band; `{"waiting_on_input": true}` when Claude is **blocked on the human** — no live agent, no open workflow, newest turn closed — so there is nothing to forecast; or `null`, with the key still present, when the session has no open segment or the corpus is thinner than `eta_min_fit`. |
| `est close <tid> [--status …] [--force]` | Finalize **by arithmetic**. No flag accepts a token count, a cost or a velocity, and none ever will. Blocks on the quiescence gate unless forced (which is recorded). A reopen is a new outcome revision, never an edit. |
| `est board [--status <col>] [--limit <n>]` \| `est board --html [--md] [--out <dir>]` | Terminal/JSON read model: Estimating · In Progress · Pending Verification · Done (7d) · Abandoned. Phase 2 (P2.7) adds the file renderer — self-contained `board.html`/`board.md`, written atomically (render to `.tmp`, `fsync`, `rename()`), regenerated at the end of a sweep that **changed** a `task` / `estimate` / `outcome` / `burn_cache` row (and then only if `board_min_interval_s` has elapsed — the change is the first gate, the throttle the second), and on demand via `--html`/`--md`, which bypass both. A render failure never touches the previous good file, never fails the sweep, and **exits `0` either way**: it is recorded as `anomaly(board_render_failed)`, because a failure only one operator's terminal ever saw is a failure the alerting cannot see. |
| `est recon [--window 7d\|<iso>/<iso>] [--source <axis>…] [--certify] [--dry-run]` | Phase 2 (P2.6): **our** numbers against **Anthropic-computed** ones, on four axes that fail independently — USD, tokens, active seconds and request count — with the OTEL↔transcript join coverage beside them, because a small delta on a small join is agreement with nothing. Refuses to sum a window that mixes DELTA and CUMULATIVE metric points. Exits `3` when an axis passes `recon_alert_pct` and writes `recon_mismatch`. `--certify` evaluates the criterion that retires the statusline's `[unvalidated]` marker (four consecutive weeks inside `unvalidated_max_delta_pct` at or above `unvalidated_min_join_pct`); retirement is **rolling**, so any later breaching week clears it again. |
| `est segments [--session <sid>] [--gap <min>] [--since <iso>] [--limit <n>]` | Phase 2 (P2.1): the **run segments** the check-back forecast is fitted on — start, active, busy, max concurrency, turns, agents, the gaps either side, the terminator and the dominant task. Read-only, never writes, never locks, **always exits 0**. `--gap` recomputes the whole partition at another threshold and **persists nothing**, which is how `segment_gap_min` gets fitted by evidence instead of by taste: the measured p50 segment length moves about tenfold across plausible values of it. |
| `est otel [--status] [--dump <seconds>] [--port <n>]` | Phase 2 (P2.3): the operator's view of the OTLP receiver, over HTTP. The **one verb that never opens the database** — the receiver's whole contract is that it never contends for the writer lock, so a diagnostic about it that took the lock would be breaking the property it reports on. `--status` (the default) reads `/healthz`: up or down, the port it actually **bound** rather than the one the env asked for, records received/rejected/dropped, and `spool_bytes` — which is the only externally visible sign of a **stalled sweeper**, since the receiver keeps appending whether or not anything drains. `--dump <seconds>` arms raw-body parking on the **already-running** receiver (`0` turns it off, one hour maximum), because restarting it to observe an envelope loses the export interval you were trying to see; those bodies contain **prompt text**, so `/healthz` reports the armed state too. Exits `0` when the receiver answers and `3` when it does not, so a cron leg can alert on a dead receiver without parsing anything. |
| `est audit [--json] [--fix] [--root <path>]` | Phase 2 (P2.12): the five checks that ask whether every row in the ledger traces to the corpus — an unknown `session_id`, a `task_alias` bound to an identity that never existed, a nullable `tid` naming no task, derived rows that outlived what derived them, and the append-only spine's anchors. **Read-only by default; the report is the product.** `--fix` is bounded by the doctrine rather than by judgement: it deletes only from the five derived/ledger tables (`task_event`, `anomaly`, `burn_cache`, `sweep_state`, `run_segment`), each removal recorded as `anomaly(audit_removed)` carrying the deleted row verbatim, and it **refuses the append-only spine** — a wrong estimate is corrected by appending a better one. Exits `0` clean · `2` spine refused · `3` findings reported, so a cron leg can alert. |
| `est retro [--as-of <iso>] [--dry-run]` | Weekly calibration panel plus the write-back that makes the ceremony non-inert: one `refclass` snapshot per bucket and one `calib_run` row. `--dry-run` writes nothing and is the right habit while *n* is small. |
| `est repair-identity [--apply]` | The **append-only correction path** for `estimate.estimator_model`, which is a calibration key rather than a label: `est retro` groups `v_velocity` on it and `est open` looks the reference class up with it. A band opened before the sweep ingested its own anchoring turn lands under the repairable `'unknown'` sentinel; this verb gives it a concrete family by **appending** an `estimate_identity_repair` row beside the ledger, never into it — `estimate` is append-only and `outcome.eid_at_start` is `MIN(eid)`, so a corrected estimate *revision* would look like a fix and change nothing downstream. Reads go through `v_estimate_identity`, and `v_velocity` projects the effective value. **Dry run by default**; `--apply` writes. Only ever touches an effective `'unknown'`, refuses a window spanning more than one main-chain family (`anomaly(estimator_identity_ambiguous)`, written once per estimate), and writes nothing on a second run. The sweep runs the same pass automatically — the moment a repair becomes possible is the moment ingest lands the turn. |
| `est config list` (or no argument) · `est config get <k>` · `est config set <k> <v>` | The calibration constants. §1.1 keeps **every** tunable in the `config` table rather than in code, and this is the write path that makes that true — before it existed, moving `ref_model` or `attr_stale_turns` on a live database meant hand-written SQL. The key set is **closed**: an unseeded key and `schema_version` are both refused with exit `2` — the first is a typo, the second is migration state — which is what lets a script tell a bad key from a bad command line (`1`). |

Three hook entry points ship alongside them, and they are **not** `est` verbs:
`scripts/nudge-hook.sh` (`PostToolUse`, matcher `Task|Workflow`), `scripts/capture-delete-hook.sh`
(`PreToolUse`, matcher `TaskUpdate`) and `scripts/prompt-sweep-hook.sh` (`UserPromptSubmit`, no
matcher) — thin shell wrappers around `scripts/nudge.ts`, `scripts/capture-delete.ts` and
`scripts/prompt-sweep.ts`. All three are advisory, fail open, and always exit 0. Nothing dispatches
them through `src/cli.ts`, and nothing should: registering them as verbs would add a second, unused
invocation path.
Phase 2 adds the OTLP receiver, `est recon` and the rendered board (`board.html`/`board.md`,
gitignored data next to `estimator.db`, never committed).

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

## Operational scripts — what's wired, and where the wiring lives

`scripts/` holds the scheduled, hook-driven and statusline legs of the collector. As of Phase 1
(2026-07-28) **every leg is live**, and the wiring lives in three different places, only one of
which is this repository:

- `~/.claude/settings.json` — the `SessionEnd`, `PreToolUse(TaskUpdate)`,
  `PostToolUse(Task|Workflow)` and `UserPromptSubmit` hooks;
- `~/Library/LaunchAgents/com.craig.estimator.plist` — the launchd job, installed and bootstrapped
  (it is a *copy* of the repo file, not a symlink: re-copy after editing the repo one);
- `~/.config/ccstatusline/settings.json` — the `custom-command` widget for `statusline-burn.ts`.

The last two are **outside** this repository and outside the weekly `backups/` snapshot (which is
database-only), so the table below carries whatever is needed to reproduce them on another machine.
Each file's own header has the rest of the detail; this table says only what exists and what its
state is.

| File | State | What it does / where the install steps are |
|---|---|---|
| `est-cron.sh` | **WIRED IN** (daily 03:30, via launchd; also safe to run by hand) | The scheduled maintenance leg: daily `est sweep --blocking --budget 300s`, plus a stamp-driven weekly `est prices --sync` and `scripts/backup.ts`. Stamp-driven, not day-of-week-driven, so a sleeping laptop delays the weekly leg instead of skipping it. Run it manually any time — every write path is idempotent: `sh scripts/est-cron.sh [--daily|--weekly]`. |
| `com.craig.estimator.plist` | **INSTALLED** (2026-07-28) | The launchd job that runs `est-cron.sh`. Copied to `~/Library/LaunchAgents/com.craig.estimator.plist` and bootstrapped as `gui/501/com.craig.estimator`; fires `StartCalendarInterval` 03:30 local (`RunAtLoad` is deliberately **false**, so installing it did not kick off a sweep — the one run on the clock so far was a manual `launchctl kickstart`, exit 0). Logs to `~/Library/Logs/com.craig.estimator.log`, outside this repo. The repo copy is the reviewable source; the installed copy is a snapshot of it, so re-`cp` after editing. The exact `cp` + `launchctl bootstrap` + `launchctl enable` sequence, the `kickstart`/`print` commands and the `launchctl bootout` removal sequence are all in the file's own header comment. |
| `session-end-sweep.sh` | **WIRED IN** (`SessionEnd`) | The blocking sweep (`--budget 20s`, inside the 30 s hook timeout) so a session's own transcripts land in the DB before the process exits. Referenced by `~/.claude/settings.json` as an **additional** user-level `SessionEnd` entry (hooks merge additively across settings levels — never a replacement). |
| `nudge-hook.sh` / `nudge.ts` | **WIRED IN** (`PostToolUse`, matcher `Task\|Workflow`) | P1.10: one read-only check for an open estimate bound to the session (nudges naming the `estimating` skill if not, ≤500 chars), one spool append to `spool/compliance.jsonl` (never a DB write), and a throttled **detached** micro-sweep so the hook can never consume its own timeout. Also carries the best-effort overrun nudge against `burn_cache` (P1.9); no-ops cleanly on a pre-migration (schema v4) database. Advisory, fail-open, always exits 0 — see the file headers and `test/nudge.test.ts`. The micro-sweep body itself lives in `src/microsweep.ts`, shared with the `UserPromptSubmit` hook below so both check the same global throttle marker. |
| `prompt-sweep-hook.sh` / `prompt-sweep.ts` | **WIRED IN** (`UserPromptSubmit`, no matcher) | The micro-sweep half of the nudge and nothing else: no compliance line, no binding lookup, no database read at all. It exists because `statusline-burn.ts` refuses to render a `burn_cache` row older than the staleness window, and until this hook the only mid-session refresh trigger was `PostToolUse(Task|Workflow)` — so the burn segment stayed correct during fan-out and silently vanished during conversation-only stretches. A prompt submission is the one event that reliably marks Craig as present, so the refresh hangs off it, throttled to one sweep per 30 s (`src/microsweep.ts`; the shared marker means a prompt inside another hook's fresher window correctly declines). **Silence is the hard requirement**: a `UserPromptSubmit` hook's stdout is injected into the model's context on *every* prompt, so the script prints nothing on success and the wrapper discards both streams as a second guard. Fail-open, always exits 0 — see `test/prompt-sweep.test.ts`. Since the 2026-07-30 boundary rule it has a **second, incidental value**: a user prompt now ends a run segment, and the sweep this hook spawns is what lands that boundary in `run_segment` within seconds. It is only a freshness assist — the boundary itself is derived at sweep time from the transcript's own user-message timestamps, so a session with no hook wired is cut identically, just later. |
| `capture-delete-hook.sh` / `capture-delete.ts` | **WIRED IN** (`PreToolUse`, matcher `TaskUpdate`) | P1.11, required by G-DELETE (§6.1): if `tool_input.status === 'deleted'`, appends one atomic line to `spool/task-events.jsonl` before the tool call runs — the only signal that survives a process death between the `tool_use` write and its `tool_result`. Always allows, never denies, always exits 0 — see `test/capture-delete.test.ts` for the mandated kill-simulation regression test. |
| `backup.ts` | **WIRED IN** (weekly, on the installed plist's schedule) — also runs on demand | The weekly leg: `VACUUM INTO backups/estimator-<UTC date>.db`, `PRAGMA wal_checkpoint(TRUNCATE)`, then prune to the newest `--keep` (default 8 ≈ two months). Deliberately does **not** take the sweep lock — `VACUUM INTO` is a reader, and a snapshot taken mid-sweep is a valid earlier state, never a torn one. `bun run scripts/backup.ts [--db <path>] [--dir <path>] [--keep <n>]`. |
| `repair-attribution.ts` | **NOT WIRED — run once, by hand, at land time** | The one-shot land step for the §5.4 attribution repair and the anomaly reclassification. `VACUUM INTO backups/` first, then a JSON dump of every `anomaly` row it is about to delete, then the deletion of the four shapes the fixed classifier no longer writes (the false "has no label" message, the duplicated journal-vs-progress cross-check, the mis-kinded relaunch row, and the `phase_unmapped` rows whose detail carried a wave count that moved between sweeps and so never deduped), then one `audit_removed` ledger row naming the counts and the dump. It then re-runs attribution and everything downstream of it — status promotion, run segments, `burn_cache` — and asserts the conservation invariants that would catch a double-count. It never touches an append-only ledger (`estimate`, `estimate_block`, `outcome`, `task_scope`, `refclass`, `eta_run`) and never re-points a `task_alias`. **Dry run by default**: `bun run scripts/repair-attribution.ts [--db <path>] [--apply]`. Follow it with `est backfill` twice — the first re-emits the classified anomaly rows, the second must write none. Covered by `test/repair-attribution.test.ts`. |
| `otel-receiver.ts` | **NOT YET WIRED** (Phase 2, P2.3 — the plist below is the install step) | The OTLP/HTTP receiver: a long-lived `Bun.serve` bound **explicitly** to `127.0.0.1:4318` (`EST_OTEL_PORT`) that accepts `POST /v1/logs`, `/v1/metrics`, `/v1/traces` and answers `GET /healthz`. It **never opens the database** — it appends one line per record to `spool/otel-*.jsonl` and the sweeper, still the single writer, drains them. It speaks OTLP/**JSON** only (`415` on any other content type), because decoding protobuf would need the first npm dependency in this repo. An unparseable body gets **`200`** with the bytes parked in `spool/otel-reject.jsonl`: the peer is an exporter that retries, and a 4xx would make it retry the same poison payload forever. Run `bun run scripts/otel-receiver.ts --dump 600` first — that parks raw bodies in `spool/otel-raw.jsonl` so the parser can be checked against what this machine actually emits. |
| `com.craig.estimator.otel.plist` | **NOT YET INSTALLED** (deliberate — installing it is a land-time step) | The launchd job for `otel-receiver.ts`, a **second** job rather than a change to `com.craig.estimator` (that one is a 03:30 calendar sweep and must stay one; `launchctl bootstrap` also refuses a duplicate `Label`). `RunAtLoad` is **true** here — the opposite of the cron job — because a receiver that starts at the next login loses everything before it; `KeepAlive.SuccessfulExit=false` restarts a crash but not a clean shutdown, and `ThrottleInterval 30` stops a port conflict becoming a spin. Installing it also requires the `env` block in `~/.claude/settings.json` (Craig's file: a build never edits it silently), which the plist header quotes in full. Logs to `~/Library/Logs/com.craig.estimator.otel.log`. |
| `statusline-burn.ts` | **WIRED IN** (ccstatusline `custom-command` widget) | P1.9: the burn segment in the prompt. Imports `burnRead` directly (one bun process, one 50 ms read-only DB read), prints percent-of-band and — from P2.2 — `check back ~Nm`, the Claude-**active** time to the next human-input boundary, which is a forecast off run-segment intervals and not the token-derived clock ETA that stays banned. When the session is **idle** — no live agent, no open delegation, newest turn closed — that slot renders `⏸ awaiting input` instead: the forecast is suppressed rather than guessed, and the rest of the segment is kept, because an idle session makes one number unavailable and does not make the burn bar wrong (Craig, 2026-07-30). It carries a trailing `?` for as long as the model is on probation, and that marker is **independent** of `[unvalidated]`: money is certified by reconciliation, time by pinball loss, and neither retires the other. p90 is deliberately not rendered here (one line of budget); it lives in `est burn` and on the board. The segment degrades to an **empty segment** on every failure — no stack trace, no stale number. "Failure" includes two well-formed payloads it refuses to render: a `stale` cache row (older than the sweep window, so the percentage is a number from the past) and `target: "fallback"` (nothing bound the task to this session, so the band may be another session's). It has one **second job**, off by default: with `EST_SESSION_MODEL_CAPTURE=1` in its environment it upserts `session_model` from the payload's model field, which is the one estimator-identity source that does **not** lag ingest (see `src/identity.ts`). That is gated because the field is not a documented harness contract and because a write contends for the WAL lock this file's read path exists to avoid — dump one real payload, confirm the field, then turn it on; its absence costs nothing, since the resolver falls through to the transcript. Its wiring lives **outside this repo**, in `~/.config/ccstatusline/settings.json`, as a widget entry with a hardcoded absolute path: `{"type": "custom-command", "commandPath": "/Users/craig/.claude/estimator/scripts/statusline-burn.ts", "timeout": 300}`. That only renders because `~/.claude/settings.json` sets `statusLine.command` to `bunx -y ccstatusline@latest`; both halves are needed to reproduce it. See the file's own header; its read path is `burnRead`, covered by `test/burn.test.ts`. |

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

### G-SMOKE — the Phase 2 end-to-end gate

`bun gates/g-smoke.ts [receiver|board|statusline|all]`. Unlike the four probes above it reads no
corpus, writes no report and produces no local artefact — its whole output is an exit code and a
transcript, so it is safe to run from a pre-commit leg and safe to re-run anywhere.

`bun test` proves the units; this proves the three Phase 2 deliverables work as **processes**, over
a real socket and a real filesystem: the OTLP receiver on an ephemeral port (spool → `est sweep` →
`request.duration_ms`), `board.html`/`board.md` with a populated card in every status column, and
`scripts/statusline-burn.ts` under ccstatusline's exact stdin contract — check-back ETA rendered,
exit 0, inside its 100 ms render budget, and `⏸ awaiting input` in place of the ETA when the payload says the
session is idle — plus the `est burn --json` payload the segment parses.

Every database, spool and output directory it touches is a fresh `mkdtemp`; nothing in it can
resolve to the live database, the live spool or the real corpus, and the receiver leg asserts the
receiver never opened a database at all.

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

Last run (2026-07-28, TypeScript 7.0.2, suite green across every test file): **0 errors**.
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

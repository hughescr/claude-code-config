/**
 * Database open-or-init helper — token-estimation-design-r3.md §4.2, §5.2.
 *
 * The only way a caller should get a handle on estimator.db. Guarantees:
 *   - connection PRAGMAs are always applied (WAL, busy_timeout, synchronous,
 *     foreign_keys) — the single-writer story depends on busy_timeout being set
 *     on EVERY connection, not just the sweeper's;
 *   - schema.sql is applied verbatim, in one transaction, when the database has
 *     no config.schema_version row;
 *   - a schema_version mismatch fails LOUDLY rather than operating on a shape
 *     the code was not written against (no silent migrations).
 *
 * Zero npm dependencies: bun:sqlite only.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { InvariantError } from "./errors.ts";

/** Project root — the directory holding schema.sql, src/, scripts/, gates/. */
export const ROOT: string = resolve(import.meta.dir, "..");

/**
 * Data root — the SIBLING directory holding everything the estimator writes at
 * runtime: `estimator.db` (+ WAL sidecars), `sweep.lock`, `spool/`, `backups/`,
 * `board.html`/`board.md`. `EST_DATA_ROOT` overrides it (tests, parallel corpora).
 *
 * A sibling of ROOT rather than a subdirectory of it, deliberately: this repo is
 * PUBLIC and none of its data may ever be committed (§4, §10 Q11), and keeping the
 * data inside the checkout meant the gitignore had to enumerate every artifact by
 * name — one forgotten entry away from publishing real subjects and real spend.
 * With code and data in separate trees the ignore rule is one line, `git clean`
 * in the checkout can never eat the corpus, and "what do I back up" has a
 * one-directory answer. Created lazily by whichever writer needs it first
 * (`openDb`, `tryAcquireLock`, `ensureSpool`, `backup.ts` — each already
 * `mkdirSync`s its parent), so a read-only open of a missing database still
 * fails loudly instead of manufacturing an empty tree.
 */
export const DATA_ROOT: string =
  process.env.EST_DATA_ROOT ?? resolve(ROOT, "..", "estimator-data");

/** Canonical schema location. */
export const SCHEMA_PATH: string = join(ROOT, "schema.sql");

/**
 * Canonical database location. `EST_DB` overrides it (tests, one-off checks,
 * `est --db`); the DB and its sidecars live under {@link DATA_ROOT}, outside the
 * public checkout, so nothing estimation-related can ever be committed (§4, §10 Q11).
 */
export const DB_PATH: string = process.env.EST_DB ?? join(DATA_ROOT, "estimator.db");

/**
 * Must match the config.schema_version seed in schema.sql.
 *
 * 20 — the cache-write TTL pricing fix (CACHE-TTL-PRICING.md D1-D6, Craig 2026-08-12).
 *     Anthropic prices a cache write by the TTL requested (1.25x base input for 5m,
 *     2.00x for 1h); `model_price` had exactly one cache-write column and every 1h
 *     write in the corpus was priced at 62.5% of its true rate, invisibly, because
 *     nothing recorded that a TTL distinction existed. Six ADD COLUMNs, two tables
 *     widened, no row dropped, rewritten or moved:
 *       - `request.cw5m_tok` / `cw1h_tok` / `cw_ttl_src` (D1). A DECOMPOSITION of
 *         `cw_tok`, not a replacement — `cw_tok` stays the authoritative aggregate
 *         and the only thing OTEL can write. `cw_ttl_src='unrecorded'` is the
 *         honest default for every pre-fix row and every OTEL-only row.
 *       - `model_price.usd_cw1h` / `usd_cw1h_src` (D2), honestly nullable: an
 *         unsynced vintage says so via `'unrecorded'` rather than defaulting to a
 *         number nobody measured. The pairing CHECK is column-level, attached to
 *         `usd_cw1h_src` and referencing the already-declared `usd_cw1h` — a
 *         *table*-level CHECK cannot be added by ALTER TABLE, this can.
 *       - `outcome.cw_ttl_unknown_share`, nullable (not `DEFAULT 0`, unlike its
 *         `unattrib_share` / `ambiguous_share` neighbours): every outcome revision
 *         written before this fix was priced at 100% unknown TTL, and a `0`
 *         default would stamp "fully known" onto exactly the rows that were not.
 *     `v_priced` / `v_wcet` / `v_task_actual_epoch` are recreated with the D3
 *     pricing expression: the 5m leg is filled first and every leg is clamped so
 *     the three always sum to exactly `cw_tok` in both directions (an over-split
 *     row — two divergent replays of one `request_id` — prices at the LOWER rate,
 *     never the higher one). The residual unknown-TTL leg prices at the recorded
 *     5m rate (D4) — deliberately NOT a config knob, because a
 *     `cw_ttl_unknown_policy` setting would let one `est config set` restate every
 *     historical actual, the exact hazard `ref_model` / `estimand` are unit-pinned
 *     against. Two new views make coverage visible rather than merely guarded:
 *     `v_cw_ttl_exposure` (request-side: unknown-TTL and over-split tokens, based
 *     on `v_request_live` so an unpriced family's exposure is still visible) and
 *     `v_cw_1h_price_gap` (price-side: a vintage with cache-write spend but no
 *     recorded 1h rate). Four config seeds: the plausibility band and default
 *     multiple `est prices --sync` gates a published 1h rate against
 *     (`price_cw_1h_min_multiple` / `_max_multiple` / `_default_multiple`), and
 *     `cw_ttl_unknown_warn_share` (`est report`'s threshold — reporting only,
 *     never a pricing lever). `est prices --fill-cw-1h` (D6) is the one-shot,
 *     idempotent, human-run command that fills every `usd_cw1h IS NULL` vintage
 *     from the same source chain and gate as a sync; it restates no recorded
 *     rate (`WHERE usd_cw1h IS NULL`) and touches no other column.
 *
 *     NOT in this step, deliberately scoped out (see the worktree report for
 *     est/cache-ttl-pricing): D8's closed-outcome re-heal on a pure repricing
 *     event (`outcome` still heals only when new spend lands after
 *     `finalized_at`) and D10's `cw_ttl_unrecorded` / `cw_split_mismatch` daily
 *     sweep-time anomaly rows. `price_cw_1h_implausible` and
 *     `cw_1h_price_backfilled` (the two anomalies D5's gate and D6's fill
 *     naturally produce) ARE recorded.
 * 19 — a REFUSED rate stops being scoreable, and the anchor registry stops being
 *     evadable (Craig 2026-07-31). Two ADD COLUMNs, one table, one view, three triggers;
 *     no row is dropped, rewritten or moved.
 *       - `estimate.wcet_rate` / `estimate.wcet_rate_src`. `bandInWcet` used to infer
 *         "a rate converted this band" from `cal_p50_wcet <> raw_p50_wcet`, and the
 *         inference was false: `est open` asked the ANCHOR-AWARE `pointsToWcet`, got the
 *         correct refusal for the first band under a new anchor, and then fell through to
 *         the ANCHOR-BLIND `calibrationFor`, multiplying the band by the previous anchor's
 *         fitted multiplier and stamping that snapshot's provenance onto the row. `cal`
 *         differed from `raw`, so `est close` scored a `velocity_cal` and an `in_band`
 *         against a rate the system had refused to issue. The write path now stores
 *         `cal = raw` with NO refclass provenance when there is no rate, and the row
 *         RECORDS which of the two happened. `'unrecorded'` is the pre-v19 state and the
 *         only one where the old inference is still consulted.
 *       - `sp_anchor.origin` + `sp_anchor_repair` + `v_sp_anchor`. The 17 -> 18 step
 *         canonised the mutable `{sp_anchor_id, sp_anchor_text}` pair into the registry —
 *         including the exact `{v1, "<the v2 definition>"}` corruption the registry exists
 *         to make unrepresentable. A pre-registry pair whose text nobody can vouch for now
 *         migrates as `'unverified'`, and the way out is `estimate_identity_repair`'s: an
 *         append-only ledger beside the row, projected by a view, with mandatory evidence.
 *       - `spa_ro_i` / `spar_ro_i`. `INSERT OR REPLACE` deletes the conflicting row and,
 *         with `recursive_triggers` OFF (the default), does so WITHOUT firing the delete
 *         trigger. Append-only enforcement a one-word idiom walks past is not enforcement,
 *         so the guard moved to the INSERT.
 * 18 — the anchor's DEFINITION gets a home of its own (Craig 2026-07-31). One table,
 *     `sp_anchor (id PRIMARY KEY, text, created_at)`, append-only like every other
 *     ledger here, seeded from the `sp_anchor_id` / `sp_anchor_text` pair already in
 *     `config`. No row is dropped, rewritten or moved.
 *
 *     v15 pinned `estimate.sp_anchor_id` onto every points band so that "8 points" stays
 *     interpretable, and the whole argument for that column was that re-wording the
 *     anchor redefines the unit. But the WORDING lived in a second mutable config key
 *     with nothing tying the two together, so the pair could be driven into a state that
 *     is simply false: bump the id to `v2`, re-word the text, then restore
 *     `sp_anchor_id v1`, and the anchor in force reads `{id: 'v1', text: '<the v2
 *     definition>'}`. Every band issued from then on is sized against the v2 scale and
 *     filed under v1 — which is exactly the corruption `sp_anchor_id` was added to
 *     prevent, arrived at through the remedy the refusal itself printed ("restore
 *     `sp_anchor_id`").
 *
 *     A registry makes that state unrepresentable rather than merely detectable: the
 *     text is a FUNCTION of the id, stored once, and `id` is a PRIMARY KEY on a table
 *     with `spa_ro_u` / `spa_ro_d`. There is nowhere for a second definition of `v1` to
 *     live. `config.sp_anchor_text` survives as a MIRROR that `setConfig` maintains, so
 *     `est config list` still shows the definition in force; every reader goes to
 *     {@link anchorTextOf}. The one new refusal is re-wording an anchor id that is
 *     already defined — which is a redefinition, and the remedy is to bump the id.
 * 17 — the ANCHOR is ENFORCED, and the PROCEDURE becomes recordable (Craig 2026-07-31).
 *     Three things, and no row is read, written or moved:
 *       - `v_velocity` projects `e.sp_anchor_id`. Under 'story_point' every sample in
 *         that view is Work-CET PER POINT OF SOME ANCHOR, and the view's own comment has
 *         always said never to pool across a unit — but the unit's VERSION was not
 *         projected, so `pointsToWcet` could hand a rate fitted under the v1 anchor to a
 *         band issued under v2. The seed path already guarded on the anchor
 *         (`sp_seed_anchor_id`); the fitted path is now consistent with it. `refclass`
 *         itself is NOT re-keyed: it is written by src/retro.ts, so the segregation is
 *         done on the read side (src/tasks.ts `pointsToWcet`) against this column until
 *         the fitting side can carry the anchor into the snapshot.
 *       - `estimate.procedure_version`, an ADD COLUMN. See the table comment: the model,
 *         the prices and the unit were versioned, the INSTRUCTION was not. NULL for every
 *         pre-v17 row, which reads as "vintage unknown" and never as "the current one".
 *       - one `config` seed, `procedure_version`. Here and not only in schema.sql's seed
 *         block for the reason v12 documents: P2.0's key set is CLOSED, so a knob the
 *         code reads but `est config set` refuses is the exact asymmetry it exists to
 *         prevent.
 * 16 — `v_block_accuracy` REFUSES a cross-unit comparison (Craig 2026-07-31). The SQL half
 *     of one shared guard: `estimate_block.p50_wcet` is stored in whatever
 *     `config.estimand` was at `est block` and is never converted by anything (the table
 *     has no cal_* pair and estb_ro_u / estb_ro_d mean it could not acquire one), while
 *     the actual joined beside it is log-derived Work-CET, always. Under 'story_point'
 *     the two axes are in different units, so `actual_wcet` goes NULL and a new
 *     `unit_mismatch` column carries the WHY — a number computed across them would wear
 *     the units of a measurement and be none. One view replaced; no row read, written or
 *     moved, so migration rule 2 holds trivially. The TypeScript half is `bandUnscorable`
 *     / `blocksInWcet` in src/tasks.ts, which `est close` and both `est retro` scoring
 *     panels now share instead of each carrying their own copy of the test.
 * 15 — STORY POINTS become an available estimand (Craig 2026-07-31). Three things, and
 *     no row is read, written or moved:
 *       - `estimate.sp_anchor_id`, an ADD COLUMN. Points are meaningless without the
 *         anchor that defined "1", so the anchor id is pinned onto every band exactly
 *         as `price_epoch` / `ref_model` / `estimand` already are. NULL for every
 *         Work-CET band and for every pre-v15 row, which reads as "not a points band".
 *       - `v_task_actual_epoch` gains a `WHEN 'story_point'` branch mapping to the
 *         work_cet counter set. The estimand names the unit of the BAND; the ACTUAL is
 *         always log-derived Work-CET. Without the branch the CASE falls to NULL and
 *         `v_velocity`'s `actual_wcet_at_epoch IS NOT NULL` filter would drop every
 *         completed story-point task, so the corpus could never learn a rate.
 *       - five `config` seeds: `sp_anchor_id`, `sp_anchor_text`,
 *         `sp_seed_wcet_per_point`, `sp_seed_anchor_id`, `sp_max_points`. Seeded here
 *         and not only in schema.sql for the reason v12 documents: P2.0's key set is
 *         CLOSED, so a knob the code reads but `est config set` refuses is precisely
 *         the asymmetry the closed set exists to prevent.
 *     `estimand` itself is NOT flipped. The cutover is `est config set estimand
 *     story_point` and it is Craig's call.
 * 14 — the SWEEPER CLOSE PASS becomes real (P1.7/§6.2, Craig 2026-07-30). §6.2's gate has
 *     always refused a premature close with "leave it for the sweeper", and no sweeper
 *     close pass existed — so the population it named (work that finished, session gone,
 *     nobody left to run `est close`) accumulated as `in_progress` forever, contributing
 *     no `outcome` row and therefore nothing to `v_velocity`. One index and four config
 *     seeds, no row moved. The partial index `ix_task_event_completed` covers the LINKED
 *     TERMINAL lifecycle rows — `completed` AND `deleted`, because §6.2's gate has always
 *     read both and P1.11's delete-capture hook exists so a deletion is RECORDED rather
 *     than laundered into an abandon — and is what makes the pass's candidate filter one
 *     indexed read per open task instead of a lifecycle-table scan per open task. The
 *     seeds are `close_pass_min_interval_min` (throttle), `close_abandon_after_h` (the
 *     no-signal abandon is held back far longer than the gate's 48 h permission
 *     threshold, because an auto-abandon permanently seals a task's attribution window),
 *     `close_fail_alert_after` and `close_blocked_after_h`. They are migration steps
 *     rather than schema.sql lines alone for the reason v12 documents — P2.0's key set is
 *     CLOSED, so a knob the code reads but `est config set` refuses is exactly the
 *     asymmetry the closed set exists to prevent.
 * 13 — ONE partial index, `ix_task_event_unlinked` (§3.2 step 6, Craig 2026-07-30). The
 *     sweep now links `task_event` rows to the tasks their planted `est_tid` names, and
 *     the linking UPDATE selects on `tid IS NULL` — a predicate no ordinary index can
 *     serve, so it re-scanned the entire lifecycle table on every sweep for the handful
 *     of rows that had just become linkable. The index is PARTIAL over exactly the
 *     unlinked rows, so it shrinks as they are linked and the steady state is an empty
 *     index rather than a growing scan. No row is touched; the append-only spine is not
 *     involved.
 * 12 — dangling delegations age out of ETA liveness (P2.1, Craig 2026-07-30). ONE config
 *     seed, `eta_live_agent_max_min` = 120. Root cause: v11's idle suppression read
 *     "started and never ended" as "running", which is also what §5.6's
 *     `agent_never_returned` population looks like — 54 unfinished `agent_run` rows on the
 *     live corpus, 49 of them more than six hours old, across 9 sessions. One corpse
 *     therefore pinned its session as busy forever and suppression could never fire for
 *     it, neutering v11 for exactly the long-lived sessions it was built for. 120 mirrors
 *     `attr_stale_minutes` rather than inventing a second answer to "how long may
 *     something the transcript never closed still be believed"; the liveness clock is
 *     last-observed-activity, so a genuinely long run is never aged out.
 * 11 — the check-back ETA answers the question it claims to (P2.1/P2.2, Craig
 *     2026-07-30). Root cause: `run_segment` was cut on GAPS alone, so a background
 *     agent bridging a gap that contained a prompt glued several human-to-human spans
 *     into one "activity streak" — measured live at 4.6 h across five prompts, which had
 *     `residual_life` forecasting "check back ~5.3h" while zero agents were live and
 *     Claude was waiting on Craig. Two changes, one of which touches this schema: a
 *     prompt in a gap now CUTS a segment (pure logic, src/eta.ts — no column moves, but
 *     every stored cut is now an observation of a superseded estimand, so `est backfill`
 *     rebuilds the corpus), and `burn_cache` gains `eta_waiting_on_input` so an idle
 *     session can say `check_back: {waiting_on_input: true}` instead of forecasting.
 *     `burn_cache` is REBUILT rather than ALTERed, the same dance v7 and v8 performed on
 *     it and for the same reason: SQLite has no `ADD COLUMN IF NOT EXISTS`.
 * 10 — the estimator identity becomes DETERMINISTIC and CORRECTABLE. Root cause: the
 *     only writer of `estimate.estimator_model` derived it from
 *     `SELECT model_family FROM request WHERE session_id=? AND origin='main'
 *      ORDER BY ts DESC LIMIT 1` — a query whose answer moves. `request` is populated
 *     by the SWEEP, so at `est open` (start of the anchoring turn) the turn's own rows
 *     are not on disk and a fresh session has none at all; and `ORDER BY ts DESC` with
 *     no upper bound means a later `/model` switch retroactively changes what the same
 *     open would have recorded. `est refclass` resolved the session by a THIRD rule, so
 *     step 1 and step 7 of one ceremony could disagree. Three objects fix it:
 *     `session_model` (the live, ingest-independent identity of an interactive session,
 *     written by the statusline shim behind EST_SESSION_MODEL_CAPTURE=1),
 *     `estimate_identity_repair` (APPEND-ONLY corrections beside an append-only ledger —
 *     `outcome.eid_at_start` is MIN(eid), so a corrected estimate REVISION would change
 *     nothing downstream), and `v_estimate_identity` (the effective value). `v_velocity`
 *     is repointed at it in the same step: a half-repoint would have `est retro` fitting
 *     on one key while `est open` looks up on another. See src/identity.ts.
 * 9 — §5.8 vanish-detector fix (root cause: `runSweep`'s watermark diff can only
 *     miss a transcript this database had already read once — a file gone before
 *     its first sweep leaves no `sweep_state` row to diff against, so the loss was
 *     UNREPRESENTABLE, not merely unreported). Additive: `sweep_state.mtime`
 *     (nullable; makes the vanish-age split exact instead of `last_swept`-inferred)
 *     and `corpus_loss` (durable per-path loss ledger, `INSERT OR IGNORE` idempotent,
 *     `resolved_at` instead of DELETE so a false positive is retracted by appending a
 *     fact). Three config seeds: `retention_days` (mirrors `cleanupPeriodDays` BY
 *     HAND — the build does not edit settings.json), `vanish_alarm_days` (replaces
 *     the literal `SIXTY_DAYS_MS`), `census_collapse_pct` (the D2/D3 sanity guard
 *     against a discovery outage). See src/census.ts.
 * 8 — Phase 2 (§Phase 2 interfaces P2.5). The OTEL facts arrive as their OWN tables
 *     (`otel_request`, `otel_metric`) rather than as columns of `request`, because the
 *     transcript is the token source of truth (§2) and a second writer for the same
 *     counter is how two sources disagree silently and neither is discoverable as
 *     wrong. OTEL fills exactly one column of `request` — `duration_ms`, and only
 *     where it is NULL — and a counter that DIFFERS writes an anomaly instead of a
 *     merge. `otel_metric` carries `temporality` per row because delta points sum and
 *     cumulative points must be differenced, and a window that mixes them is the §5.2
 *     dedup mistake in a new costume. Alongside them: `run_segment` + `eta_run` (the
 *     check-back corpus and its append-only fitting ledger), `recon_metric` (the three
 *     non-USD reconciliation axes — `recon` stays USD-only rather than having its CHECK
 *     widened, which would mean rebuilding a WITHOUT ROWID table for no gain), and
 *     `job_run` / `job_item` (the reconcile-only jobs feed). `burn_cache` is rebuilt to
 *     gain the forecast and compute columns — the same dance v7 performed on it, and
 *     legitimate for the one table in the schema that is explicitly a cache.
 * 7 — the statusline read path becomes a BOUNDED read. `est burn`'s cached path was
 *     nine statements per render, three of which walked history: a `task_alias`
 *     lookup by session (the PK starts with `id_kind`, so it SCANNED), a
 *     `COUNT(*) FROM agent_run WHERE tid = ?` (SCAN — the only index was on
 *     `(run_id, wf_launch_id)`), and provisional/unpriced counts that priced every
 *     request of the task by correlated subquery (~127 ms on a large task, against a
 *     0.01 ms row read). Two indexes kill the scans; the three derived counts become
 *     COLUMNS of `burn_cache`, computed once per sweep where the same aggregation
 *     already runs. P1.9 promises one indexed row read at a >= 5 s cadence forever,
 *     and that promise has to be true of the corpus in a year, not just today's.
 * 6 — `task_alias` keys on `tid` as well, because a session hosts MANY tasks.
 *     Under v5's `(id_kind, session_id, local_id)` key the pair ('session', S, S)
 *     was unique, so the second `est open` in a session silently wrote no alias:
 *     it was invisible to §5.4 attribution, its spend booked to the first task,
 *     and `est burn --session` rendered the first task's band. Exclusive
 *     identities (agent, workflow run, Task-tool number) keep single ownership
 *     through the `ux_alias_exclusive` partial unique index.
 *     Same version, same theme — a measurement that quietly changed meaning:
 *     `refclass` carries `ref_model` as a COLUMN and keys on (ref_model, estimand),
 *     because a multiplier only means anything in the unit it was fitted in, and
 *     with the unit buried in `params_json` (which no reader parses) a `ref_model`
 *     flip handed the old unit's snapshot to the new unit's band. And
 *     `v_task_actual_epoch` stops reading `config` for the normaliser and the
 *     counter set, reading the estimate's own snapshot instead, so a config flip
 *     can no longer restate an actual that was already measured.
 * 5 — Phase 1 (§Phase 1 interfaces P1.0): the `burn_cache` materialised read path
 *     that buys `est burn --json` its sub-100 ms budget, plus the
 *     `attr_stale_turns` / `attr_stale_minutes` staleness-closure config rows
 *     (§5.4). Exactly those two things; every other Phase 1 verb writes tables
 *     that already existed at v4.
 * 4 — `v_request_tiered` / `v_task_actual_epoch` refuse to append the
 *     `@above_200k` companion to a family that already carries a context
 *     bracket. Its own row is the long-context rate, so the companion was a
 *     second surcharge — and a stale provisional companion from sync()'s
 *     tier-peer fallback outranked the authoritative rate a later sync wrote.
 * 3 — `task_event.kind` ('create' | 'status'), in the row and in the dedup key.
 *     §5.4 counts a TaskCreate as touching a task, so ingest must persist one;
 *     without the column a create is indistinguishable from a transition to the
 *     same status, and the two collapse into one row.
 * 2 — review-gate fixes: per-request >200k context tier in `v_priced`, NULL-safe
 *     `task_event` dedup key, non-negative CHECKs on every counter,
 *     `estimate.ref_model` / `estimate.estimand` unit snapshot, worst-wins
 *     `v_phase_actual.phase_conf`, auxiliary origin excluded from calibration.
 * 1 — initial R3 §4.2 shape.
 */
export const SCHEMA_VERSION = "20";

/**
 * Forward-only, additive migrations, applied by {@link openDb} on a WRITABLE
 * connection (which is what §3.4's `SessionStart` → `est init --quiet` means by
 * "applies pending schema_version migrations").
 *
 * Three rules keep this honest:
 *
 *  1. **`schema.sql` is still the only source of shape.** A migration exists so an
 *     already-populated database reaches the same shape a fresh one gets from
 *     `schema.sql`; it is not a second definition. `test/schema.test.ts` asserts the
 *     two agree by migrating a downgraded database and diffing `sqlite_master`
 *     against a fresh one — the same "SQL cannot import a constant, so a test
 *     asserts the two sides agree" pattern `v_request_tiered` already uses.
 *  2. **No migration drops or rewrites a ROW.** The append-only spine (§4.2) means
 *     historical estimates, scopes and outcomes are evidence, and a migration that
 *     could restate them would be a hole straight through it. A migration may still
 *     rebuild a TABLE when SQLite offers no other way to widen a key (5 -> 6 does),
 *     provided every existing row is carried across verbatim, column for column.
 *  3. **Idempotent under concurrency.** Applied inside a `BEGIN IMMEDIATE` that
 *     re-reads the version first, so two processes racing to migrate produce one
 *     migration and one no-op rather than a duplicate-object error.
 */
export interface Migration {
  readonly from: string;
  readonly to: string;
  readonly sql: string;
  /**
   * Run inside the SAME transaction, immediately after `sql`, for the one thing SQL
   * cannot express idempotently: **ADD COLUMN**.
   *
   * Rule 3 above requires every step to survive being applied to a file that already
   * has the new shape but an older version marker, and the 6 -> 7 step already spells
   * out why that matters — "ADD COLUMN — with no `IF NOT EXISTS` in SQLite — is not
   * [safe]". `burn_cache` could dodge it by being droppable; `estimate` cannot be
   * rebuilt at all (four tables reference it, and its append-only triggers exist
   * precisely so its rows are never copied anywhere). So the guard moves from SQL to
   * TypeScript: read `PRAGMA table_info`, add the column only when it is absent.
   *
   * This is NOT an escape hatch for arbitrary migration logic. It may only do what a
   * `CREATE … IF NOT EXISTS` would do if SQLite offered one: never touch a row,
   * never read the append-only spine (rule 2), and be a no-op on a second run.
   */
  readonly apply?: (db: Database) => void;
}

/** True when `table` already has `column` — the ADD COLUMN idempotence guard. */
export function hasColumn(db: Database, table: string, column: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

export const MIGRATIONS: readonly Migration[] = [
  {
    from: "4",
    to: "5",
    sql: `
CREATE TABLE burn_cache (
  tid TEXT PRIMARY KEY REFERENCES task(tid),
  as_of TEXT NOT NULL,
  consumed_wcet INTEGER,
  wcet_main INTEGER, wcet_sub INTEGER, wcet_aux INTEGER,
  usd REAL,
  n_req INTEGER,
  n_agents_live INTEGER,
  active_s INTEGER,
  burn_wcet_per_min REAL,
  proj_total_wcet INTEGER
) STRICT, WITHOUT ROWID;
INSERT OR IGNORE INTO config (k, v) VALUES
  ('attr_stale_turns',   '5'),
  ('attr_stale_minutes', '120');
`,
  },
  {
    from: "5",
    to: "6",
    // A WITHOUT ROWID table's PRIMARY KEY cannot be widened in place, so both halves
    // of this step are the 12-step ALTER dance reduced to what applies here: nothing
    // references `task_alias` or `refclass` by foreign key, `DROP TABLE` takes each
    // table's own append-only triggers with it (recreated below), and every row is
    // copied column for column.
    sql: `
CREATE TABLE task_alias_v6 (
  tid TEXT NOT NULL REFERENCES task(tid),
  id_kind TEXT NOT NULL CHECK (id_kind IN
    ('session_task','session','workflow_run','agent','job')),
  session_id TEXT NOT NULL, local_id TEXT NOT NULL, first_seen TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sweeper',
  PRIMARY KEY (id_kind, session_id, local_id, tid)
) STRICT, WITHOUT ROWID;
INSERT INTO task_alias_v6 (tid, id_kind, session_id, local_id, first_seen, source)
  SELECT tid, id_kind, session_id, local_id, first_seen, source FROM task_alias;
DROP TABLE task_alias;
ALTER TABLE task_alias_v6 RENAME TO task_alias;
CREATE INDEX ix_alias_tid ON task_alias(tid);
CREATE UNIQUE INDEX ux_alias_exclusive ON task_alias(id_kind, session_id, local_id)
  WHERE id_kind <> 'session';

-- Same dance for refclass, and for the same reason: (ref_model, estimand) joins the
-- key so a snapshot can never be read back against a normaliser it was not fitted
-- in. ref_model is BACKFILLED from params_json, which is where writeBack has always
-- put it — no row is invented, and a pre-v6 row with no ref_model in its params
-- falls back to the config value that was in force when it was written.
CREATE TABLE refclass_v6 (
  as_of TEXT NOT NULL,
  bucket TEXT NOT NULL REFERENCES bucket_def(bucket),
  estimator_family TEXT NOT NULL,
  n INTEGER NOT NULL, n_eff REAL NOT NULL,
  med_log_v REAL NOT NULL, iqr_log_v REAL NOT NULL,
  shrink_w REAL NOT NULL, shrink_k REAL NOT NULL, half_life_days REAL NOT NULL,
  mult_p50 REAL NOT NULL, mult_p90 REAL NOT NULL,
  boot_lo_p50 REAL, boot_hi_p50 REAL,
  boot_lo_p90 REAL, boot_hi_p90 REAL,
  method TEXT NOT NULL CHECK (method IN ('plugin','bootstrap')),
  ref_model TEXT NOT NULL,
  estimand TEXT NOT NULL, params_json TEXT NOT NULL,
  PRIMARY KEY (as_of, bucket, estimator_family, ref_model, estimand)
) STRICT, WITHOUT ROWID;
INSERT INTO refclass_v6 (as_of, bucket, estimator_family, n, n_eff, med_log_v, iqr_log_v,
                         shrink_w, shrink_k, half_life_days, mult_p50, mult_p90,
                         boot_lo_p50, boot_hi_p50, boot_lo_p90, boot_hi_p90,
                         method, ref_model, estimand, params_json)
  SELECT as_of, bucket, estimator_family, n, n_eff, med_log_v, iqr_log_v,
         shrink_w, shrink_k, half_life_days, mult_p50, mult_p90,
         boot_lo_p50, boot_hi_p50, boot_lo_p90, boot_hi_p90, method,
         COALESCE(json_extract(params_json, '$.ref_model'),
                  (SELECT v FROM config WHERE k='ref_model')),
         estimand, params_json
    FROM refclass;
DROP TABLE refclass;
ALTER TABLE refclass_v6 RENAME TO refclass;
CREATE TRIGGER rc_ro_u BEFORE UPDATE ON refclass BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER rc_ro_d BEFORE DELETE ON refclass BEGIN SELECT RAISE(ABORT,'append-only'); END;

-- v_task_actual_epoch normalised by the ref_model IN FORCE NOW and hardcoded the
-- work_cet counter set, so a config flip restated already-measured actuals. It now
-- reads both from the estimate's own snapshot. A view holds no rows, so this one is
-- a straight replacement — but it MUST stay identical to the definition in
-- schema.sql, which is still the only source of shape.
DROP VIEW v_task_actual_epoch;
CREATE VIEW v_task_actual_epoch AS
SELECT r.tid,
  SUM(CAST((CASE e.estimand
              WHEN 'out'       THEN r.out_tok*pe.usd_out
              WHEN 'work_cet'  THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw
              WHEN 'out_cw_in' THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw + r.in_tok*pe.usd_in
            END) / rf.usd_out AS INTEGER)) AS wcet_at_epoch,
  e.price_epoch, e.eid AS eid_at_start
FROM v_request_live r
JOIN estimate e ON e.eid = (SELECT MIN(eid) FROM estimate WHERE tid = r.tid)
-- Same per-request context tier as v_priced, but resolved AT THE EPOCH rather than
-- at the request's own ts: reusing v_request_tiered here would pick a companion
-- family that may not exist at price_epoch, and this INNER JOIN would then drop the
-- request silently instead of pricing it. The \`NOT LIKE '%]'\` guard is the same
-- one v_request_tiered carries and for the same reason: a bracketed family's own
-- row already carries the long-context rate.
JOIN model_price pe
  ON pe.family = CASE WHEN (r.in_tok + r.cw_tok + r.cr_tok) > 200000
                       AND r.model_family NOT LIKE '%]'
                       AND EXISTS (SELECT 1 FROM model_price hi
                                    WHERE hi.family = r.model_family || '@above_200k'
                                      AND hi.effective_from <= e.price_epoch)
                      THEN r.model_family || '@above_200k'
                      ELSE r.model_family END
 AND pe.effective_from = (SELECT MAX(effective_from) FROM model_price
                          WHERE family = pe.family AND effective_from <= e.price_epoch)
-- The normaliser. \`e.ref_model\`, not config: the whole view is an INNER JOIN to
-- \`estimate\`, so the snapshot is always available and config could only ever be a
-- late substitute for it.
JOIN model_price rf ON rf.family = e.ref_model
 AND rf.effective_from = (SELECT MAX(effective_from) FROM model_price
                          WHERE family = rf.family AND effective_from <= e.price_epoch)
WHERE r.tid IS NOT NULL AND r.attr <> 'overhead'
  AND r.origin IN ('main','subagent')   -- task effort only; 'auxiliary' excluded (§4.6)
GROUP BY r.tid;
`,
  },
  {
    from: "6",
    to: "7",
    // `burn_cache` is REBUILT rather than widened by ALTER, and that is the one place
    // in this file where dropping a table is not a hole in the append-only spine: it
    // is the single table schema.sql declares droppable ("dropping it costs one sweep
    // and nothing else"), it holds no evidence, and the next sweep writes every row
    // back from `request`. The rebuild is also what makes this step safe to apply to a
    // file that already has the v7 shape but an older version marker, which
    // ADD COLUMN — with no `IF NOT EXISTS` in SQLite — is not.
    sql: `
DROP TABLE burn_cache;
CREATE TABLE burn_cache (
  tid TEXT PRIMARY KEY REFERENCES task(tid),
  as_of TEXT NOT NULL,
  consumed_wcet INTEGER,
  wcet_main INTEGER, wcet_sub INTEGER, wcet_aux INTEGER,
  usd REAL,
  n_req INTEGER,
  n_agents_live INTEGER,
  n_agents_total INTEGER,
  n_provisional INTEGER,
  n_unpriced INTEGER,
  active_s INTEGER,
  burn_wcet_per_min REAL,
  proj_total_wcet INTEGER
) STRICT, WITHOUT ROWID;

-- The two scans the statusline paid for on every render. IF NOT EXISTS for the same
-- reason burn_cache is rebuilt rather than altered: this step must land cleanly on a
-- file that already has the shape and only lacks the marker.
CREATE INDEX IF NOT EXISTS ix_agent_run_tid ON agent_run(tid);
CREATE INDEX IF NOT EXISTS ix_alias_session ON task_alias(session_id);
`,
  },
  {
    from: "7",
    to: "8",
    // Phase 2 (P2.5). ADDITIVE, except the one rebuild: `burn_cache` gains nine
    // columns and is rebuilt rather than ALTERed, exactly as 6 -> 7 did and for the
    // same two reasons — it is the single table schema.sql declares droppable (it
    // holds no evidence; the next sweep writes every row back), and SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so a rebuild is what makes this step land cleanly on
    // a file that already has the shape and only lacks the marker.
    //
    // The rebuild CARRIES THE ROWS ACROSS, which the 6 -> 7 step did not have to: P2.5
    // states "existing rows are carried across column for column; the new columns are
    // NULL until the next sweep", and the difference is visible on Craig's screen.
    // Dropping them empties `burn_cache` for every open task, and `burnJson`/`renderBurn`
    // read ONLY that table — so the statusline segment disappears from the moment of the
    // migration until the next full sweep writes the rows back. "Costs one sweep and
    // nothing else" is true of the DATA and false of the experience.
    //
    // The dance is: rename the old table out of the way, create the new one under its
    // real name with schema.sql's exact text, copy the fifteen v7 columns, drop the
    // rename. It is NOT `CREATE burn_cache_v8 … ALTER RENAME TO burn_cache`, because
    // SQLite rewrites a renamed table's stored DDL (quoting the new name), and
    // `test/schema.test.ts` compares `sqlite_master.sql` BYTE FOR BYTE against a fresh
    // database. Renaming the table being discarded has no such consequence.
    //
    // Everything else here is a CREATE of an object that did not exist at v7, so rule
    // 2 (no migration drops or rewrites a ROW) is met by construction: nothing in the
    // append-only spine is touched, and the config seeds are `INSERT OR IGNORE`, which
    // cannot restate a value Craig has already tuned.
    //
    // The DDL text below is the SAME TEXT as schema.sql's, with `IF NOT EXISTS` added
    // to every CREATE — the same guard 6 -> 7 put on its two indexes, and for the same
    // reason: schema.sql's own header documents `sqlite3 estimator.db < schema.sql` as a
    // supported way to build the file, and running that over a v7 database creates every
    // v8 object while `INSERT OR IGNORE` leaves `schema_version` at 7. Without the guard
    // this step would then die on "table otel_request already exists" and the database
    // would be stuck one version behind forever.
    //
    // The guard costs nothing in fidelity: SQLite STRIPS `IF NOT EXISTS` before storing
    // a definition in `sqlite_master`, so a migrated database and a fresh one hold
    // byte-identical DDL text for every object here — which is what makes the
    // migration-vs-schema.sql diff in `test/schema.test.ts` an exact comparison rather
    // than a shape approximation.
    sql: `
DROP TABLE IF EXISTS burn_cache_pre_v8;   -- residue of a step that died mid-rebuild
ALTER TABLE burn_cache RENAME TO burn_cache_pre_v8;
CREATE TABLE burn_cache (
  tid TEXT PRIMARY KEY REFERENCES task(tid),
  as_of TEXT NOT NULL,              -- when the sweep that wrote this row ran; \`stale_s\` derives
  consumed_wcet INTEGER,
  wcet_main INTEGER, wcet_sub INTEGER, wcet_aux INTEGER,
  usd REAL,                         -- overhead-EXCLUSIVE, like consumed_wcet: the two are divided
  n_req INTEGER,
  n_agents_live INTEGER,            -- bound agent_runs with no ended_at
  n_agents_total INTEGER,           -- bound agent_runs, live or finished
  n_provisional INTEGER,            -- requests priced from a provisional rate -> \`provisional_price\`
  n_unpriced INTEGER,               -- requests whose family has no price row  -> \`unpriced\`
  active_s INTEGER,                 -- §7.3 interval UNION, not a sum
  burn_wcet_per_min REAL,           -- over the current rolling window (config burn_window_min)
  proj_total_wcet INTEGER,          -- linear projection; CRUDE, and both output modes say so
  -- v8 (P2.2): the check-back forecast and the compute clock. Every one is a COLUMN
  -- for the P1.9 reason — a residual-life quantile computed per render is exactly the
  -- unbounded per-render work this table exists to abolish. NULL until the next sweep.
  seg_started_at TEXT,              -- the OPEN run_segment the forecast is issued against
  seg_elapsed_s INTEGER,
  check_back_p50_s INTEGER, check_back_p90_s INTEGER,
  eta_model TEXT,                   -- which of the three models issued the number on screen
  eta_probation INTEGER,            -- 1 => the statusline renders a trailing \`?\`
  eta_n_seg INTEGER,                -- closed segments the shipped model was fitted on. A COLUMN
                                    -- for the reason above and no other: reading it as
                                    -- \`COUNT(*) FROM run_segment WHERE gap_min = ?\` per render is
                                    -- a table scan (no index covers gap_min) inside the one path
                                    -- that promises to be bounded by the ROW.
  compute_s INTEGER,                -- SUM(request.duration_ms)/1000 over attributed requests
  compute_coverage_pct REAL         -- share of those requests that actually carry one; a compute
                                    -- figure without its coverage is a moved denominator
) STRICT, WITHOUT ROWID;
-- Column for column, exactly as P2.5 says. The nine v8 columns stay NULL until the next
-- sweep; every v7 figure the statusline reads is on screen the whole way through.
INSERT INTO burn_cache (tid, as_of, consumed_wcet, wcet_main, wcet_sub, wcet_aux, usd,
                        n_req, n_agents_live, n_agents_total, n_provisional, n_unpriced,
                        active_s, burn_wcet_per_min, proj_total_wcet)
  SELECT tid, as_of, consumed_wcet, wcet_main, wcet_sub, wcet_aux, usd,
         n_req, n_agents_live, n_agents_total, n_provisional, n_unpriced,
         active_s, burn_wcet_per_min, proj_total_wcet
    FROM burn_cache_pre_v8;
DROP TABLE burn_cache_pre_v8;

-- ---- P2.4: the OTEL facts, kept SEPARATE from \`request\` on purpose -------------
CREATE TABLE IF NOT EXISTS otel_request (         -- one row per api_request event; NOT a second \`request\`
  request_id TEXT PRIMARY KEY,      -- the join key to \`request\`; same global-PK doctrine (§5.2)
  session_id TEXT, prompt_id TEXT, message_uuid TEXT, client_request_id TEXT,
  model TEXT, query_source TEXT,    -- 'main' | 'subagent' | 'auxiliary' -> request.origin
  ts TEXT NOT NULL,                 -- event time, ISO, derived from timeUnixNano
  received_at TEXT NOT NULL,        -- when the receiver spooled it; drift between the two is
                                    -- export latency, and it is worth being able to see
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  cost_usd_micros INTEGER CHECK (cost_usd_micros IS NULL OR cost_usd_micros >= 0),
                                    -- INTEGER micros, not the float \`cost_usd\`: money summed
                                    -- across 10^5 rows should not accumulate float error
  in_tok  INTEGER CHECK (in_tok  IS NULL OR in_tok  >= 0),
  out_tok INTEGER CHECK (out_tok IS NULL OR out_tok >= 0),
  cw_tok  INTEGER CHECK (cw_tok  IS NULL OR cw_tok  >= 0),
  cr_tok  INTEGER CHECK (cr_tok  IS NULL OR cr_tok  >= 0),
  attempt INTEGER, speed TEXT, effort TEXT, status_code INTEGER,
  workflow_run_id TEXT, workflow_name TEXT,
  joined INTEGER NOT NULL DEFAULT 0 -- 1 once a matching \`request\` row was found; the complement
                                    -- is \`otel_unjoined\`, and it is the recon join_pct denominator
) STRICT;
CREATE INDEX IF NOT EXISTS ix_otel_req_turn ON otel_request(session_id, prompt_id);
CREATE INDEX IF NOT EXISTS ix_otel_req_ts   ON otel_request(ts);

CREATE TABLE IF NOT EXISTS otel_metric (          -- cost.usage | token.usage | active_time.total
  metric TEXT NOT NULL, ts TEXT NOT NULL,
                                    -- \`ts\` is ISO SECONDS, because every window predicate in
                                    -- this schema is a string compare on it. \`ts_nanos\` is the
                                    -- sub-second half of the point's identity, kept as the
                                    -- verbatim int64 STRING it arrived as (it exceeds 2^53).
                                    -- Nothing aggregates over it; it exists so two points of
                                    -- one series 250 ms apart cannot collapse into one row.
  ts_nanos     TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  -- NOT NULL SENTINELS, for the reason task_event documents: SQLite treats NULLs as
  -- DISTINCT inside a UNIQUE/PRIMARY key, so nullable dimensions make the dedup key
  -- match nothing and every re-drain inserts a duplicate.
  session_id   TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  model        TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  query_source TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  token_type   TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
                                    -- The four columns above are the ALLOWLISTED dimensions, and
                                    -- an OTLP point carries dimensions the allowlist drops
                                    -- (\`tool\`, \`decision\`, …). Two genuinely distinct series then
                                    -- share every stored dimension and the DO UPDATE overwrites
                                    -- one with the other -- silent ingest loss, not deduplication.
                                    -- \`dim_digest\` is a one-way 64-bit digest of the FULL decoded
                                    -- attribute set plus unit and stream start (src/otel.ts), so
                                    -- the stored identity is as wide as the wire identity without
                                    -- persisting a single unallowlisted VALUE.
  dim_digest   TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  value REAL NOT NULL, unit TEXT,
  temporality TEXT NOT NULL CHECK (temporality IN ('delta','cumulative','unspecified')),
                                    -- delta SUMs; cumulative must be DIFFERENCED per series.
                                    -- Mixing them in one window is the §5.2 dedup mistake again.
  received_at TEXT NOT NULL,
  PRIMARY KEY (metric, ts, ts_nanos, session_id, model, query_source, token_type, dim_digest)
) STRICT, WITHOUT ROWID;

-- ---- P2.1: the check-back corpus ----------------------------------------------
-- DERIVED but DURABLE, and the distinction from burn_cache is deliberate: a segment
-- outlives the transcript that produced it (P2.10 prunes at 365 days), so this table
-- is upserted per sweep and NEVER deleted. Mutable only while terminator='open';
-- frozen once terminal. No append-only trigger: it is regenerable for as long as its
-- inputs exist, and \`est audit --fix\` is allowed to clear it (P2.12).
CREATE TABLE IF NOT EXISTS run_segment (
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  active_s INTEGER NOT NULL CHECK (active_s >= 0),
  busy_s   INTEGER NOT NULL CHECK (busy_s   >= 0),
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency >= 0),
  n_turns  INTEGER NOT NULL DEFAULT 0,
  n_agents INTEGER NOT NULL DEFAULT 0,
  gap_before_s INTEGER, gap_after_s INTEGER,   -- RECORDED, never predicted (§7.3 clock 3)
  terminator TEXT NOT NULL CHECK (terminator IN
    ('human_input','compaction','session_end','open')),
  interval_src_mix TEXT,            -- e.g. 'turn+agent+otel'; a segment assembled from mixed
                                    -- sources is visible as such, like agent_run.interval_src
  gap_min REAL NOT NULL,            -- the segment_gap_min IN FORCE when this row was cut, so a
                                    -- retuned threshold cannot silently restate old segments
  tid TEXT REFERENCES task(tid),    -- the task owning the MAJORITY of active seconds; the
                                    -- forecast itself is session-scoped (P2.1)
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  -- \`gap_min\` IS PART OF THE IDENTITY, and that is the whole point of the column. A
  -- key of (session_id, started_at) alone made a retune of \`segment_gap_min\` a silent
  -- no-op: the re-partition at the new threshold usually reuses a \`started_at\` that is
  -- already present as a TERMINAL row, so the INSERT lost the PK conflict and the
  -- \`terminator = 'open'\` freeze guard refused the UPDATE — the table came back
  -- byte-identical while \`refreshSegments\` reported segments written. Downstream the
  -- corpus at the new threshold was EMPTY, \`n_closed < eta_min_fit\`, and \`check_back\`
  -- vanished from the statusline forever with no error anywhere.
  --
  -- With gap_min in the key a retune writes a fresh PARTITION alongside the old one.
  -- That is also the honest data model: rows cut at 2 minutes and rows cut at 30 are
  -- different observations of the same wall clock, never one corpus (the measured p50
  -- moves ~10× across plausible thresholds), which is exactly why every reader — the
  -- \`v_eta_corpus\` consumers, \`v_segment_current\` below, \`forecastSession\` — filters
  -- on the threshold IN FORCE rather than on the table.
  PRIMARY KEY (session_id, gap_min, started_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_run_segment_tid ON run_segment(tid);
CREATE INDEX IF NOT EXISTS ix_run_segment_end ON run_segment(ended_at);
-- Covers the corpus-size count and the per-partition open-row sweep; without it both
-- are full scans of a table that only ever grows.
CREATE INDEX IF NOT EXISTS ix_run_segment_gap ON run_segment(gap_min, terminator);

CREATE TABLE IF NOT EXISTS eta_run (              -- APPEND-ONLY: what the check-back model was fitted on, and
  as_of TEXT NOT NULL,              -- what it had to beat. calib_run's sibling (§4.5).
  eta_model TEXT NOT NULL CHECK (eta_model IN ('const_median','residual_life','fanout_cond')),
  n_seg INTEGER NOT NULL, n_censored INTEGER NOT NULL DEFAULT 0,
  gap_min REAL NOT NULL,
  pinball_p50 REAL, pinball_p90 REAL,
  baseline_pinball_p50 REAL NOT NULL,   -- const_median; the floor a model must clear
  coverage_p90 REAL, cov_lo REAL, cov_hi REAL,   -- Jeffreys, as §7.4
  won INTEGER NOT NULL DEFAULT 0,
  probation INTEGER NOT NULL DEFAULT 1,
  params_json TEXT NOT NULL,
  PRIMARY KEY (as_of, eta_model)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS eta_ro_u BEFORE UPDATE ON eta_run BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS eta_ro_d BEFORE DELETE ON eta_run BEGIN SELECT RAISE(ABORT,'append-only'); END;

-- ---- P2.6: non-USD reconciliation --------------------------------------------
-- \`recon\` (USD) is UNTOUCHED — widening its CHECK would mean rebuilding a WITHOUT
-- ROWID table for no gain. Tokens, active seconds and request counts are different
-- units and get their own table rather than being coerced into usd-named columns.
CREATE TABLE IF NOT EXISTS recon_metric (
  as_of TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('tokens','active_s','requests')),
  source TEXT NOT NULL CHECK (source IN ('otel_tokens','otel_active','otel_request')),
  window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  ours REAL NOT NULL, theirs REAL NOT NULL, delta_pct REAL NOT NULL,
  join_pct REAL,                    -- share of OUR requests in the window OTEL also saw; a small
                                    -- delta on a tiny join is agreement with nothing (P2.6)
  unit TEXT NOT NULL, note TEXT,
  PRIMARY KEY (as_of, metric, source)
) STRICT, WITHOUT ROWID;

-- ---- P2.9: jobs reconcile, RECONCILE-ONLY ------------------------------------
CREATE TABLE IF NOT EXISTS job_run (
  job_id TEXT PRIMARY KEY,          -- the ~/.claude/jobs/<id> directory name
  session_id TEXT, resume_session_id TEXT,
  name TEXT, state TEXT, backend TEXT, template TEXT,
  created_at TEXT, updated_at TEXT, first_terminal_at TEXT,
  reported_tokens INTEGER CHECK (reported_tokens IS NULL OR reported_tokens >= 0),
                                    -- state.json.tokens: a HARNESS AGGREGATE. Stored for audit,
                                    -- NEVER summed — same ban as wf_*.json totalTokens and
                                    -- workflowProgress[].tokens (§1, §5.6).
  n_items INTEGER NOT NULL DEFAULT 0,
  n_items_started INTEGER NOT NULL DEFAULT 0,   -- fan[] entries with startedAt > 0; the item-grain
                                                -- check stays dormant until this is populated
  tid TEXT REFERENCES task(tid)
) STRICT;

CREATE TABLE IF NOT EXISTS job_item (
  job_id TEXT NOT NULL REFERENCES job_run(job_id),
  item_id TEXT NOT NULL,            -- fan[].id, e.g. 'todo:3'
  kind TEXT, label TEXT,
  started_at TEXT, done_at TEXT,    -- NULL where the harness wrote 0; 0 is 'unset', not epoch
  PRIMARY KEY (job_id, item_id)
) STRICT, WITHOUT ROWID;

-- Phase 2 views (P2.5). The board is a projection over views that already exist plus
-- \`run_segment\`; it adds none of its own.

-- The audit surface for the dedup chain (§5.2): ours vs theirs, per request, per
-- counter. OTEL is FORBIDDEN from merging a counter (P2.4), so a disagreement is a
-- finding rather than a correction — this view is where the finding is readable, and
-- it is the only independent check the dedup chain has ever had.
CREATE VIEW IF NOT EXISTS v_otel_join AS
SELECT o.request_id, o.session_id, o.ts, o.model, o.query_source, o.attempt,
       o.duration_ms, o.cost_usd_micros,
       CASE WHEN r.request_id IS NULL THEN 0 ELSE 1 END AS joined,
       o.prompt_id AS otel_prompt_id, r.prompt_id AS our_prompt_id,
       o.in_tok AS otel_in, o.out_tok AS otel_out, o.cw_tok AS otel_cw, o.cr_tok AS otel_cr,
       r.in_tok AS our_in, r.out_tok AS our_out, r.cw_tok AS our_cw, r.cr_tok AS our_cr,
       o.in_tok  - r.in_tok  AS d_in,
       o.out_tok - r.out_tok AS d_out,
       o.cw_tok  - r.cw_tok  AS d_cw,
       o.cr_tok  - r.cr_tok  AS d_cr
FROM otel_request o LEFT JOIN v_request_live r ON r.request_id = o.request_id;

-- The weekly rollup the retro line and the certification criterion both read. One row
-- per ISO-ish week, carrying the LATEST recon in that week (SQLite's bare-column rule:
-- MAX(as_of) fixes which row the other columns come from) plus the three non-USD axes
-- and the join coverage that stops a week of missing data from certifying itself.
CREATE VIEW IF NOT EXISTS v_recon_week AS
SELECT strftime('%Y-W%W', c.window_start) AS week,
       MAX(c.as_of) AS as_of,
       c.window_start, c.window_end,
       c.ours_usd, c.theirs_usd, c.delta_pct AS usd_delta_pct,
       (SELECT m.delta_pct FROM recon_metric m
         WHERE m.as_of = c.as_of AND m.metric = 'tokens')   AS tokens_delta_pct,
       (SELECT m.delta_pct FROM recon_metric m
         WHERE m.as_of = c.as_of AND m.metric = 'active_s') AS active_delta_pct,
       (SELECT m.delta_pct FROM recon_metric m
         WHERE m.as_of = c.as_of AND m.metric = 'requests') AS requests_delta_pct,
       (SELECT m.join_pct  FROM recon_metric m
         WHERE m.as_of = c.as_of AND m.metric = 'requests') AS join_pct
FROM recon c WHERE c.source = 'otel_cost'
GROUP BY week;

-- The check-back fitting corpus. Open segments are RIGHT-CENSORED observations, not
-- omissions: dropping the long-running ones biases the estimator short exactly when it
-- matters (P2.1), which is the same censoring treatment §6.2 gives abandoned tasks.
CREATE VIEW IF NOT EXISTS v_eta_corpus AS
SELECT s.session_id, s.started_at, s.ended_at, s.active_s, s.busy_s, s.terminator,
       s.gap_min, s.tid, s.n_turns, s.n_agents, s.max_concurrency,
       CAST((julianday(s.ended_at) - julianday(s.started_at)) * 86400 AS INTEGER) AS span_s,
       CASE WHEN s.terminator = 'open' THEN 1 ELSE 0 END AS censored
FROM run_segment s;

-- The open segment per session — what burn_cache reads when it writes the forecast.
-- SCOPED TO THE THRESHOLD IN FORCE, like every other reader of \`run_segment\`: after a
-- \`segment_gap_min\` retune the retired partition still holds this session's old open
-- row, and it starts at a DIFFERENT instant, so an unscoped MAX(started_at) would issue
-- the forecast against a segment cut to a rule nobody is using any more.
CREATE VIEW IF NOT EXISTS v_segment_current AS
SELECT s.* FROM run_segment s
WHERE s.terminator = 'open'
  AND s.gap_min = (SELECT CAST(v AS REAL) FROM config WHERE k = 'segment_gap_min')
  AND s.started_at = (SELECT MAX(started_at) FROM run_segment
                       WHERE session_id = s.session_id AND terminator = 'open'
                         AND gap_min = s.gap_min);

-- One key is deliberately absent, \`unvalidated_retired_at\`: \`est recon --certify\` is its
-- only writer and its PRESENCE is the certification.
INSERT OR IGNORE INTO config (k, v) VALUES
  ('segment_gap_min',           '5'),
  ('eta_min_segments',          '30'),
  ('eta_min_fit',               '5'),
  ('eta_min_pinball_gain',      '0.05'),
  ('recon_alert_pct',           '5'),
  ('unvalidated_max_delta_pct', '2'),
  ('unvalidated_weeks',         '4'),
  ('unvalidated_min_join_pct',  '95'),
  ('board_min_interval_s',      '30'),
  ('job_item_min_pop',          '0.5'),
  ('otel_max_body_mb',          '8'),
  ('otel_stale_min',            '15'),
  ('otel_spool_retention_days', '14');
`,
  },
  {
    from: "8",
    to: "9",
    // §5.8 vanish-detector fix (see the SCHEMA_VERSION doc comment above). Purely
    // additive in effect — one nullable column, one new table, three config seeds —
    // but `sweep_state` gains its column via the SAME rebuild dance v6->v7 and
    // v7->v8 used for `refclass`/`burn_cache`, and for the reason those steps give:
    // SQLite has no `ADD COLUMN IF NOT EXISTS`. A plain `ALTER TABLE ADD COLUMN`
    // would work exactly once; it duplicate-column-errors the moment this step runs
    // against a database `schema.sql` already built fresh WITH `mtime` (any
    // migration test that downgrades an EARLIER version without also downgrading
    // `sweep_state`'s shape hits this immediately). The rebuild sidesteps it by
    // construction: the copy only ever SELECTs the four columns that existed at
    // every prior version, so it is correct whether or not the source already
    // happens to carry `mtime`. No row in the append-only spine is touched —
    // `sweep_state` is explicitly a performance-only watermark table, not evidence.
    sql: `
DROP TABLE IF EXISTS sweep_state_pre_v9;   -- residue of a step that died mid-rebuild
ALTER TABLE sweep_state RENAME TO sweep_state_pre_v9;
CREATE TABLE sweep_state (          -- performance only; losing it costs seconds, not correctness
  path TEXT PRIMARY KEY, inode INTEGER NOT NULL, bytes_read INTEGER NOT NULL,
  last_swept TEXT NOT NULL,
  mtime TEXT                        -- v9: the file's own mtime at last read. NULL until
                                    -- \`est backfill\` rewrites it; D1's vanish-age split
                                    -- falls back to \`last_swept\` (a lower bound; §5.8) until then.
) STRICT;
INSERT INTO sweep_state (path, inode, bytes_read, last_swept)
  SELECT path, inode, bytes_read, last_swept FROM sweep_state_pre_v9;
DROP TABLE sweep_state_pre_v9;

CREATE TABLE IF NOT EXISTS corpus_loss (          -- v9: durable record of a transcript that stopped existing
                                    -- (§5.8 root cause: \`sweep_state\` alone cannot represent a
                                    -- loss that happened before a path was ever watermarked).
                                    -- Append-only in spirit: a false positive is retracted via
                                    -- \`resolved_at\`, never a DELETE — see src/census.ts.
  path TEXT PRIMARY KEY,
  session_id TEXT,                 -- nullable: not every lost path resolves to one session
  kind TEXT NOT NULL CHECK (kind IN ('main','agent','state','unknown')),
  detected_by TEXT NOT NULL CHECK (detected_by IN
    ('watermark_diff','discovery_probe','ledger_probe')),
  first_missing_at TEXT NOT NULL,
  last_seen_at TEXT,
  mtime TEXT,
  age_source TEXT NOT NULL CHECK (age_source IN ('mtime','last_swept','ledger_ts','unknown')),
  expected INTEGER NOT NULL DEFAULT 0,  -- 1 => age >= config.retention_days at detection time
  resolved_at TEXT                 -- set when a LATER sweep finds the file back on disk
) STRICT;

INSERT OR IGNORE INTO config (k, v) VALUES
  ('retention_days',      '365'),
  ('vanish_alarm_days',   '60'),
  ('census_collapse_pct', '20');
`,
  },
  {
    from: "9",
    to: "10",
    // The estimator-identity repair path (see the SCHEMA_VERSION doc comment above).
    //
    // Additive except for ONE view replacement, and a view holds no rows: `v_velocity`
    // is repointed at `v_estimate_identity` so the calibration corpus groups on the
    // EFFECTIVE estimator family. That repoint has to happen in the SAME step as the
    // repair table, because a half-repoint is a worse version of the bug it fixes —
    // `est retro` fitting on the repaired key while `est open` looks up on the recorded
    // key would make every band silently miss its own calibration bucket.
    //
    // Rule 2 (no migration drops or rewrites a ROW) is met by construction: two new
    // tables, two new triggers, one new view, one view replacement. Nothing in the
    // append-only spine is touched — which is the entire point of this step, since the
    // thing being corrected LIVES in that spine and may not be edited.
    //
    // The DDL text below is schema.sql's exact text plus `IF NOT EXISTS`, which SQLite
    // strips before storing, so a migrated database and a fresh one hold byte-identical
    // definitions and `test/schema.test.ts` stays an exact comparison.
    sql: `
CREATE TABLE IF NOT EXISTS session_model (
  session_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  model_family TEXT NOT NULL,
  seen_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS estimate_identity_repair (
  eid INTEGER NOT NULL REFERENCES estimate(eid),
  seq INTEGER NOT NULL,
  repaired_at TEXT NOT NULL,
  estimator_model TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN
    ('anchor_prompt','at_created','statusline','manual')),
  evidence TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (eid, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS eir_ro_u BEFORE UPDATE ON estimate_identity_repair
  BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS eir_ro_d BEFORE DELETE ON estimate_identity_repair
  BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE VIEW IF NOT EXISTS v_estimate_identity AS
SELECT e.eid, e.tid,
       e.estimator_model AS estimator_model_recorded,
       COALESCE(r.estimator_model, e.estimator_model) AS estimator_model,
       r.method AS repair_method,
       r.repaired_at
FROM estimate e
LEFT JOIN estimate_identity_repair r
  ON r.eid = e.eid
 AND r.seq = (SELECT MAX(seq) FROM estimate_identity_repair WHERE eid = e.eid);

DROP VIEW IF EXISTS v_velocity;
CREATE VIEW IF NOT EXISTS v_velocity AS
SELECT e.bucket, i.estimator_model, e.price_epoch, e.refclass_as_of,
       e.ref_model, e.estimand,                          -- the UNIT; never pool across these
       o.velocity_raw, o.velocity_cal, o.finalized_at,
       o.wcet_main, o.wcet_sub, o.wcet_aux,
       o.wcet_main + o.wcet_sub AS wcet_task_effort,     -- calibrate on THIS, not on the total
       e.exp_agents, o.n_agents
FROM v_outcome_current o
JOIN estimate e ON e.eid = o.eid_at_start
JOIN v_estimate_identity i ON i.eid = e.eid              -- v10: the EFFECTIVE identity, not e.*
WHERE o.scope_changed = 0 AND o.censored = 0 AND o.final_status = 'completed'
  AND o.unpriced_share = 0 AND o.price_provisional = 0   -- R2: unpriced degrades the ROW
  AND o.actual_wcet_at_epoch IS NOT NULL;                -- R2: epoch-consistent actuals only
`,
  },
  {
    from: "10",
    to: "11",
    // Idle suppression for the check-back ETA (see the SCHEMA_VERSION doc comment above).
    // ONE new column on ONE table, and that table is `burn_cache` — the single table this
    // schema declares droppable, holding no evidence, every row rewritten by the next
    // sweep. Rule 2 (no migration drops or rewrites a ROW) is met the way v7 -> v8 met it:
    // the rebuild CARRIES EVERY ROW ACROSS, column for column, because `burnJson` and
    // `renderBurn` read only this table and an emptied cache means the statusline segment
    // disappears from the moment of the migration until the next full sweep. "Costs one
    // sweep and nothing else" is true of the data and false of the experience.
    //
    // A rebuild rather than `ALTER TABLE ... ADD COLUMN` for the reason v7 -> v8, v6 -> v7
    // and v8 -> v9 all give: SQLite has no `ADD COLUMN IF NOT EXISTS`, and schema.sql's own
    // header documents `sqlite3 estimator.db < schema.sql` as a supported way to build the
    // file — so this step has to land cleanly on a database that ALREADY has the column and
    // only lacks the version marker. `ADD COLUMN` would duplicate-column-error there and
    // strand the file one version behind forever. The copy lists only the v8 columns, which
    // exist at every version this step can run against.
    //
    // And it is `CREATE TABLE burn_cache` under its real name after renaming the OLD table
    // out of the way, never `CREATE burn_cache_v11 ... RENAME TO burn_cache`: SQLite
    // rewrites a renamed table's stored DDL, and `test/schema.test.ts` compares
    // `sqlite_master.sql` byte for byte against a fresh database.
    //
    // NOTHING here touches `run_segment`. The boundary rule that ships alongside this
    // column changed where segments are CUT, which makes every stored cut an observation
    // of a superseded estimand — but a migration is the wrong place to restate a corpus.
    // `refreshSegments` already owns that, atomically and with a `segment_recut` ledger
    // entry per moved row, and `est backfill` is the documented way to ask for it. A
    // migration that silently deleted the fitting corpus would be the one thing this
    // schema's doctrine forbids more firmly than a stale number.
    sql: `
DROP TABLE IF EXISTS burn_cache_pre_v11;   -- residue of a step that died mid-rebuild
ALTER TABLE burn_cache RENAME TO burn_cache_pre_v11;
CREATE TABLE burn_cache (
  tid TEXT PRIMARY KEY REFERENCES task(tid),
  as_of TEXT NOT NULL,              -- when the sweep that wrote this row ran; \`stale_s\` derives
  consumed_wcet INTEGER,
  wcet_main INTEGER, wcet_sub INTEGER, wcet_aux INTEGER,
  usd REAL,                         -- overhead-EXCLUSIVE, like consumed_wcet: the two are divided
  n_req INTEGER,
  n_agents_live INTEGER,            -- bound agent_runs with no ended_at
  n_agents_total INTEGER,           -- bound agent_runs, live or finished
  n_provisional INTEGER,            -- requests priced from a provisional rate -> \`provisional_price\`
  n_unpriced INTEGER,               -- requests whose family has no price row  -> \`unpriced\`
  active_s INTEGER,                 -- §7.3 interval UNION, not a sum
  burn_wcet_per_min REAL,           -- over the current rolling window (config burn_window_min)
  proj_total_wcet INTEGER,          -- linear projection; CRUDE, and both output modes say so
  -- v8 (P2.2): the check-back forecast and the compute clock. Every one is a COLUMN
  -- for the P1.9 reason — a residual-life quantile computed per render is exactly the
  -- unbounded per-render work this table exists to abolish. NULL until the next sweep.
  seg_started_at TEXT,              -- the OPEN run_segment the forecast is issued against
  seg_elapsed_s INTEGER,
  check_back_p50_s INTEGER, check_back_p90_s INTEGER,
  eta_model TEXT,                   -- which of the three models issued the number on screen
  eta_probation INTEGER,            -- 1 => the statusline renders a trailing \`?\`
  eta_n_seg INTEGER,                -- closed segments the shipped model was fitted on. A COLUMN
                                    -- for the reason above and no other: reading it as
                                    -- \`COUNT(*) FROM run_segment WHERE gap_min = ?\` per render is
                                    -- a table scan (no index covers gap_min) inside the one path
                                    -- that promises to be bounded by the ROW.
  compute_s INTEGER,                -- SUM(request.duration_ms)/1000 over attributed requests
  compute_coverage_pct REAL,        -- share of those requests that actually carry one; a compute
                                    -- figure without its coverage is a moved denominator
  -- v11: idle suppression (P2.1/P2.2, Craig 2026-07-30). 1 => the resolved session has no
  -- live agent, no open workflow and a closed newest turn, so Claude is BLOCKED ON THE
  -- HUMAN and no forecast is issued: \`check_back\` becomes \`{waiting_on_input: true}\` and
  -- every column above is written NULL. A column rather than a render-time derivation for
  -- the same P1.9 reason as its neighbours — the predicate reads \`agent_run\`,
  -- \`workflow_run\` and \`turn\`, none of which the bounded read path may touch.
  eta_waiting_on_input INTEGER      -- NULL only on a row written before this column existed
) STRICT, WITHOUT ROWID;
-- Column for column. \`eta_waiting_on_input\` stays NULL until the next sweep, which reads
-- as "not waiting" — the pre-amendment behaviour, for one sweep.
INSERT INTO burn_cache (tid, as_of, consumed_wcet, wcet_main, wcet_sub, wcet_aux, usd,
                        n_req, n_agents_live, n_agents_total, n_provisional, n_unpriced,
                        active_s, burn_wcet_per_min, proj_total_wcet,
                        seg_started_at, seg_elapsed_s, check_back_p50_s, check_back_p90_s,
                        eta_model, eta_probation, eta_n_seg, compute_s, compute_coverage_pct)
  SELECT tid, as_of, consumed_wcet, wcet_main, wcet_sub, wcet_aux, usd,
         n_req, n_agents_live, n_agents_total, n_provisional, n_unpriced,
         active_s, burn_wcet_per_min, proj_total_wcet,
         seg_started_at, seg_elapsed_s, check_back_p50_s, check_back_p90_s,
         eta_model, eta_probation, eta_n_seg, compute_s, compute_coverage_pct
    FROM burn_cache_pre_v11;
DROP TABLE burn_cache_pre_v11;
`,
  },
  {
    from: "11",
    to: "12",
    // Dangling delegations age out of ETA liveness (see the SCHEMA_VERSION doc comment).
    //
    // ONE `config` seed and nothing else — no table, no column, no view. It is a whole
    // migration step rather than a line added to schema.sql's seed block because P2.0's
    // key set is CLOSED: `est config get/set` refuses a key that is not SEEDED, so a
    // database that never re-ran `schema.sql` would have a knob the code reads (via
    // `configNum`'s default) and Craig cannot tune. That asymmetry — a live default nobody
    // can see or change — is exactly what the closed key set exists to prevent, and it is
    // the same reason v4 -> v5 seeded `attr_stale_minutes` through a migration instead of
    // leaving it to the seed block.
    //
    // `INSERT OR IGNORE`, so a value Craig has already tuned is never restated (migration
    // rule 2). Nothing else in the append-only spine is touched.
    sql: `
INSERT OR IGNORE INTO config (k, v) VALUES
  ('eta_live_agent_max_min', '120');
`,
  },
  {
    from: "12",
    to: "13",
    // ONE partial index, so the sweep's `session_task` backfill stops re-scanning the
    // whole lifecycle table (see schema.sql's note on `ix_task_event_unlinked`).
    //
    // `IF NOT EXISTS` for the reason the v8 step documents: `sqlite3 estimator.db <
    // schema.sql` over an older file creates every new object while `INSERT OR IGNORE`
    // leaves `schema_version` behind, so a migration that assumed the object was absent
    // would strand the database one version back with a "table already exists" error.
    // SQLite strips the clause before storing the definition, so `sqlite_master` still
    // matches a fresh database byte for byte — which `test/schema.test.ts` asserts.
    //
    // No row is read, written or moved: migration rule 2 holds trivially.
    sql: `
CREATE INDEX IF NOT EXISTS ix_task_event_unlinked ON task_event(session_id, task_num)
  WHERE tid IS NULL AND task_num <> '';
`,
  },
  {
    from: "13",
    to: "14",
    // The sweeper close pass (src/autoclose.ts). ONE partial index and ONE config seed;
    // no table, no column, no view, and nothing in the append-only spine is read, written
    // or moved, so migration rule 2 holds trivially.
    //
    // `IF NOT EXISTS` / `INSERT OR IGNORE` for the reasons the v8 and v12 steps document:
    // `sqlite3 estimator.db < schema.sql` over an older file creates every new object
    // while leaving `schema_version` behind, so a step that assumed the object was absent
    // would strand the database one version back with "index already exists"; and a value
    // Craig has already tuned must never be restated by a migration.
    //
    // The seed is here rather than only in schema.sql's seed block because P2.0's key set
    // is CLOSED — `est config get/set` refuses a key that is not SEEDED — so a database
    // that never re-ran schema.sql would have a live default nobody could see or change.
    sql: `
CREATE INDEX IF NOT EXISTS ix_task_event_completed ON task_event(tid, ts, to_status)
  WHERE tid IS NOT NULL AND to_status IN ('completed','deleted');
INSERT OR IGNORE INTO config (k, v) VALUES
  ('close_pass_min_interval_min', '10'),
  ('close_abandon_after_h',       '168'),
  ('close_fail_alert_after',      '3'),
  ('close_blocked_after_h',       '24');
`,
  },
  {
    from: "14",
    to: "15",
    // Story points become an available estimand (see the SCHEMA_VERSION doc comment).
    //
    // The view is replaced, not altered: a view holds no rows, so this is the same
    // straight replacement the 5 -> 6 step made, and the definition below MUST stay
    // byte-identical to schema.sql's — `test/schema.test.ts` diffs `sqlite_master`
    // between a migrated file and a fresh one. `IF EXISTS` / `IF NOT EXISTS` for the
    // reason the v8, v12 and v13 steps document (SQLite strips the clause before
    // storing, so fidelity costs nothing).
    //
    // The COLUMN is in `apply` below rather than here, because SQLite has no
    // `ADD COLUMN IF NOT EXISTS` and rule 3 requires this step to survive a file that
    // already has the shape. The 6 -> 7 step names that hazard explicitly and dodged it
    // by rebuilding `burn_cache`; `estimate` has no such escape — `estimate_block`,
    // `estimate_identity_repair`, `outcome` and `task_scope`'s consumers all reference
    // it, and its append-only triggers exist so that its rows are never copied
    // anywhere. Nothing in the append-only spine is read, written or moved: ADD COLUMN
    // widens every existing row with NULL in place, which is the honest value — a band
    // issued before v15 was not denominated against any anchor.
    sql: `
DROP VIEW IF EXISTS v_task_actual_epoch;
CREATE VIEW IF NOT EXISTS v_task_actual_epoch AS
SELECT r.tid,
  SUM(CAST((CASE e.estimand
              WHEN 'out'         THEN r.out_tok*pe.usd_out
              WHEN 'work_cet'    THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw
              WHEN 'out_cw_in'   THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw + r.in_tok*pe.usd_in
              WHEN 'story_point' THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw
            END) / rf.usd_out AS INTEGER)) AS wcet_at_epoch,
  e.price_epoch, e.eid AS eid_at_start
FROM v_request_live r
JOIN estimate e ON e.eid = (SELECT MIN(eid) FROM estimate WHERE tid = r.tid)
-- Same per-request context tier as v_priced, but resolved AT THE EPOCH rather than
-- at the request's own ts: reusing v_request_tiered here would pick a companion
-- family that may not exist at price_epoch, and this INNER JOIN would then drop the
-- request silently instead of pricing it. The \`NOT LIKE '%]'\` guard is the same
-- one v_request_tiered carries and for the same reason: a bracketed family's own
-- row already carries the long-context rate.
JOIN model_price pe
  ON pe.family = CASE WHEN (r.in_tok + r.cw_tok + r.cr_tok) > 200000
                       AND r.model_family NOT LIKE '%]'
                       AND EXISTS (SELECT 1 FROM model_price hi
                                    WHERE hi.family = r.model_family || '@above_200k'
                                      AND hi.effective_from <= e.price_epoch)
                      THEN r.model_family || '@above_200k'
                      ELSE r.model_family END
 AND pe.effective_from = (SELECT MAX(effective_from) FROM model_price
                          WHERE family = pe.family AND effective_from <= e.price_epoch)
-- The normaliser. \`e.ref_model\`, not config: the whole view is an INNER JOIN to
-- \`estimate\`, so the snapshot is always available and config could only ever be a
-- late substitute for it.
JOIN model_price rf ON rf.family = e.ref_model
 AND rf.effective_from = (SELECT MAX(effective_from) FROM model_price
                          WHERE family = rf.family AND effective_from <= e.price_epoch)
WHERE r.tid IS NOT NULL AND r.attr <> 'overhead'
  AND r.origin IN ('main','subagent')   -- task effort only; 'auxiliary' excluded (§4.6)
GROUP BY r.tid;

INSERT OR IGNORE INTO config (k, v) VALUES
  ('sp_anchor_id',           'v1'),
  ('sp_anchor_text',         'rename a single variable across 3 files in a TypeScript codebase, with no tests to update'),
  ('sp_seed_wcet_per_point', ''),
  ('sp_seed_anchor_id',      ''),
  ('sp_max_points',          '1000');
`,
    apply: (db: Database): void => {
      // The column definition is written EXACTLY as schema.sql spells it, because
      // SQLite splices this text into the stored `CREATE TABLE estimate` and the
      // migrated file has to come out byte-identical to a fresh one.
      if (!hasColumn(db, "estimate", "sp_anchor_id")) {
        db.exec("ALTER TABLE estimate ADD COLUMN sp_anchor_id TEXT");
      }
    },
  },
  {
    from: "15",
    to: "16",
    // `v_block_accuracy` refuses a cross-unit comparison (see the SCHEMA_VERSION doc
    // comment above).
    //
    // A straight view replacement, the same shape the 5 -> 6 and 14 -> 15 steps used: a
    // view holds no rows, so migration rule 2 (no migration drops or rewrites a ROW) is
    // met by construction — nothing here reads, writes or moves anything in the
    // append-only spine, and `estimate_block` in particular is untouched. The
    // definition below MUST stay byte-identical to schema.sql's, because
    // `test/schema.test.ts` diffs `sqlite_master` between a migrated file and a fresh
    // one. Idempotent for the reason v8/v12/v13/v15 document: `IF EXISTS` /
    // `IF NOT EXISTS` cost nothing, since SQLite strips the clause before storing.
    sql: `
DROP VIEW IF EXISTS v_block_accuracy;
CREATE VIEW IF NOT EXISTS v_block_accuracy AS
SELECT b.eid, e.tid, b.phase_idx, b.title, b.p50_wcet, b.p90_wcet, b.exp_agents,
       CASE WHEN e.estimand = 'story_point' THEN NULL ELSE pa.wcet END AS actual_wcet,
       CASE WHEN e.estimand = 'story_point' AND pa.wcet IS NOT NULL THEN 1 ELSE 0 END AS unit_mismatch,
       pa.n_agents, pa.phase_conf
FROM estimate_block b
JOIN estimate e     ON e.eid = b.eid
JOIN workflow_run r ON r.tid = e.tid
LEFT JOIN v_phase_actual pa
       ON pa.run_id = r.run_id AND pa.wf_launch_id = r.wf_launch_id
      AND pa.phase_idx = b.phase_idx;
`,
  },
  {
    from: "16",
    to: "17",
    // The anchor becomes enforceable, and the procedure becomes recordable (see the
    // SCHEMA_VERSION doc comment above).
    //
    // The VIEW is replaced, the same straight swap the 5 -> 6, 14 -> 15 and 15 -> 16
    // steps made: a view holds no rows, so migration rule 2 (no migration drops or
    // rewrites a ROW) is met by construction. The definition below MUST stay
    // byte-identical to schema.sql's, because `test/schema.test.ts` diffs
    // `sqlite_master` between a migrated file and a fresh one. `IF EXISTS` /
    // `IF NOT EXISTS` for the reason v8/v12/v13/v15/v16 document: SQLite strips the
    // clause before storing, so idempotence costs nothing in fidelity.
    //
    // The COLUMN is in `apply` below, because SQLite has no `ADD COLUMN IF NOT EXISTS`
    // and rule 3 requires this step to survive a file that already has the shape. The
    // 14 -> 15 step names that hazard and takes the same route: `estimate` cannot be
    // rebuilt (four tables reference it, and its append-only triggers exist so its rows
    // are never copied anywhere), so it is an ADD COLUMN. Nothing in the append-only
    // spine is read, written or moved — ADD COLUMN widens every existing row with NULL
    // in place, which is the honest value: a band issued before v17 recorded no
    // procedure, and its vintage is genuinely unknown.
    //
    // The seed is `INSERT OR IGNORE`, so a value Craig has already set is never
    // restated (migration rule 2).
    sql: `
DROP VIEW IF EXISTS v_velocity;
CREATE VIEW IF NOT EXISTS v_velocity AS
SELECT e.bucket, i.estimator_model, e.price_epoch, e.refclass_as_of,
       e.ref_model, e.estimand,                          -- the UNIT; never pool across these
       e.sp_anchor_id,                                   -- the unit's VERSION under 'story_point'
       o.velocity_raw, o.velocity_cal, o.finalized_at,
       o.wcet_main, o.wcet_sub, o.wcet_aux,
       o.wcet_main + o.wcet_sub AS wcet_task_effort,     -- calibrate on THIS, not on the total
       e.exp_agents, o.n_agents
FROM v_outcome_current o
JOIN estimate e ON e.eid = o.eid_at_start
JOIN v_estimate_identity i ON i.eid = e.eid              -- v10: the EFFECTIVE identity, not e.*
WHERE o.scope_changed = 0 AND o.censored = 0 AND o.final_status = 'completed'
  AND o.unpriced_share = 0 AND o.price_provisional = 0   -- R2: unpriced degrades the ROW
  AND o.actual_wcet_at_epoch IS NOT NULL;                -- R2: epoch-consistent actuals only

INSERT OR IGNORE INTO config (k, v) VALUES
  ('procedure_version', '2026-07-31-uncorrected-judgement');
`,
    apply: (db: Database): void => {
      // Written EXACTLY as schema.sql spells it: SQLite splices this text into the
      // stored `CREATE TABLE estimate`, and a migrated file has to come out
      // byte-identical to a fresh one.
      if (!hasColumn(db, "estimate", "procedure_version")) {
        db.exec("ALTER TABLE estimate ADD COLUMN procedure_version TEXT");
      }
    },
  },
  {
    from: "17",
    to: "18",
    // The anchor's DEFINITION gets a home of its own (see the SCHEMA_VERSION doc
    // comment above).
    //
    // One new TABLE plus its two append-only triggers, and one seed row derived from
    // the pair already in `config`. Nothing existing is read, rewritten or moved:
    // migration rule 2 holds because the only write is an INSERT into a table that did
    // not exist a statement ago.
    //
    // `IF NOT EXISTS` throughout, for the reason v8/v12/v13/v15/v16/v17 document —
    // SQLite strips the clause before storing a definition, so rule 3's idempotence
    // costs nothing in fidelity and `test/schema.test.ts`'s byte-for-byte comparison
    // against a fresh file still holds.
    //
    // The SEED is a SELECT rather than a literal, and that is the whole point of doing
    // it here instead of in schema.sql alone: a live database's `sp_anchor_text` is
    // whatever Craig has set it to, and stamping schema.sql's default over it would be
    // asserting a definition nobody wrote. `created_at` is a fixed instant rather than
    // `now`, so a migrated file and a fresh one hold the same row and rule 3 stays
    // testable. Anchor ids that appear only in `estimate.sp_anchor_id` are deliberately
    // NOT invented a definition here: their text was never recorded anywhere, and
    // `src/unit.ts` reads an absent row as "definition unknown", which is true.
    sql: `
CREATE TABLE IF NOT EXISTS sp_anchor (
  id TEXT PRIMARY KEY,              -- human-meaningful and Craig-readable: 'v1', 'v2'
  text TEXT NOT NULL,               -- the work defined to be 1 point, verbatim
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS spa_ro_u BEFORE UPDATE ON sp_anchor BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS spa_ro_d BEFORE DELETE ON sp_anchor BEGIN SELECT RAISE(ABORT,'append-only'); END;

INSERT OR IGNORE INTO sp_anchor (id, text, created_at)
SELECT (SELECT v FROM config WHERE k = 'sp_anchor_id'),
       (SELECT v FROM config WHERE k = 'sp_anchor_text'),
       '2026-07-31T00:00:00Z'
 WHERE (SELECT v FROM config WHERE k = 'sp_anchor_id') IS NOT NULL
   AND COALESCE((SELECT v FROM config WHERE k = 'sp_anchor_text'), '') <> ''
   -- The row is SKIPPED rather than merely ignored on conflict (v19). INSERT OR IGNORE
   -- used to be enough, but v19's spa_ro_i fires BEFORE INSERT and RAISE(ABORT)s on a
   -- duplicate id — and RAISE(ABORT) is NOT what OR IGNORE resolves, so on rule 3's
   -- re-run path (a file that already has the shape, walked from 17 again) this
   -- statement would abort. It does not surface today only because bun's
   -- multi-statement Database.exec swallows the error and runs on, which is a thing to
   -- write a migration around rather than to depend on.
   AND NOT EXISTS (SELECT 1 FROM sp_anchor
                    WHERE id = (SELECT v FROM config WHERE k = 'sp_anchor_id'));
`,
  },
  {
    from: "18",
    to: "19",
    // A refused rate stops being scoreable, and the registry stops being evadable (see
    // the SCHEMA_VERSION doc comment above).
    //
    // One new TABLE with its three append-only triggers, one new VIEW, one new trigger on
    // `sp_anchor`, and two ADD COLUMNs on each of `estimate` and `sp_anchor`. Nothing
    // existing is read, rewritten or moved: ADD COLUMN widens every existing row in place
    // (it is a metadata edit — no UPDATE runs, so the append-only triggers are neither
    // fired nor evaded), and the only DML is into a table that did not exist a statement
    // ago. Migration rule 2 holds.
    //
    // `IF NOT EXISTS` throughout, for the reason v8/v12/v13/v15/v16/v17/v18 document —
    // SQLite strips the clause before storing a definition, so rule 3's idempotence costs
    // nothing in fidelity and `test/schema.test.ts`'s byte-for-byte comparison against a
    // fresh file still holds.
    //
    // THE DEFAULTS ARE THE MIGRATION. There is no backfill and there cannot be one:
    // `estimate` and `sp_anchor` are both append-only, so every pre-existing row keeps
    // whatever the ADD COLUMN default says about it, and the defaults are therefore
    // chosen to be TRUE of an unknown row rather than convenient.
    //
    //  - `estimate.wcet_rate_src` defaults to `'unrecorded'`, which is exactly what those
    //    rows are: issued before anything recorded the answer. `bandInWcet` reads that
    //    value as "fall back to the old `cal <> raw` inference", because for those rows
    //    the inference is the only evidence that exists — including for rows the v18
    //    defect already mis-stamped, which nothing can now separate. Defaulting to
    //    `'none'` instead would silently un-score every points band ever issued.
    //  - `sp_anchor.origin` defaults to `'unverified'`, which demotes a definition a user
    //    may well have declared by hand at v18. That is the deliberate direction: v18
    //    recorded no provenance at all, so "declared" would be an assertion about rows
    //    nobody can distinguish, while "unverified" only asks for a confirmation that
    //    `est anchor define <id> "<same text>"` supplies in one command. It refuses
    //    nothing in the meantime.
    // The three COLUMNS are in `apply` below, because SQLite has no
    // `ADD COLUMN IF NOT EXISTS` and rule 3 requires this step to survive a file that
    // already has the shape — the same route the 14 -> 15 and 16 -> 17 steps take, and
    // for the same reason: neither `estimate` nor `sp_anchor` can be rebuilt.
    sql: `
CREATE TRIGGER IF NOT EXISTS spa_ro_i BEFORE INSERT ON sp_anchor
  WHEN EXISTS (SELECT 1 FROM sp_anchor WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE IF NOT EXISTS sp_anchor_repair (
  id TEXT NOT NULL REFERENCES sp_anchor(id),
  seq INTEGER NOT NULL,
  repaired_at TEXT NOT NULL,
  text TEXT NOT NULL,               -- the definition as CONFIRMED or CORRECTED
  evidence TEXT NOT NULL,           -- JSON; mandatory, exactly as estimate_identity_repair's is
  note TEXT,
  PRIMARY KEY (id, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS spar_ro_u BEFORE UPDATE ON sp_anchor_repair
  BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS spar_ro_d BEFORE DELETE ON sp_anchor_repair
  BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS spar_ro_i BEFORE INSERT ON sp_anchor_repair
  WHEN EXISTS (SELECT 1 FROM sp_anchor_repair WHERE id = NEW.id AND seq = NEW.seq)
  BEGIN SELECT RAISE(ABORT,'append-only'); END;

DROP VIEW IF EXISTS v_sp_anchor;
CREATE VIEW IF NOT EXISTS v_sp_anchor AS
SELECT a.id,
       a.text AS text_recorded,
       COALESCE(r.text, a.text) AS text,
       a.origin,
       CASE WHEN a.origin = 'declared' OR r.text IS NOT NULL THEN 1 ELSE 0 END AS verified,
       a.created_at,
       r.repaired_at
FROM sp_anchor a
LEFT JOIN sp_anchor_repair r
  ON r.id = a.id
 AND r.seq = (SELECT MAX(seq) FROM sp_anchor_repair WHERE id = a.id);
`,
    apply: (db: Database): void => {
      // Each definition is written EXACTLY as schema.sql spells it: SQLite splices this
      // text into the stored CREATE TABLE and `test/schema.test.ts` diffs a migrated
      // file's `sqlite_master` against a fresh one byte for byte.
      if (!hasColumn(db, "estimate", "wcet_rate")) {
        db.exec("ALTER TABLE estimate ADD COLUMN wcet_rate REAL CHECK (wcet_rate IS NULL OR wcet_rate > 0)");
      }
      if (!hasColumn(db, "estimate", "wcet_rate_src")) {
        db.exec(
          "ALTER TABLE estimate ADD COLUMN wcet_rate_src TEXT NOT NULL DEFAULT 'unrecorded' CHECK (wcet_rate_src IN ('n/a','fitted','seed','none','unrecorded'))",
        );
      }
      if (!hasColumn(db, "sp_anchor", "origin")) {
        db.exec(
          "ALTER TABLE sp_anchor ADD COLUMN origin TEXT NOT NULL DEFAULT 'unverified' CHECK (origin IN ('declared','unverified'))",
        );
      }
    },
  },
  {
    from: "19",
    to: "20",
    // The cache-write TTL pricing fix (see the SCHEMA_VERSION doc comment above).
    //
    // Three tables gain six ADD COLUMNs total; five views are recreated with the D3
    // pricing expression (three replaced, two new); four config seeds. Nothing in the
    // append-only spine is read, rewritten or moved: ADD COLUMN widens every existing
    // row in place with the honest default (`'unrecorded'` for the two src columns,
    // `0` for the two counters, NULL for the two nullable rate/share columns), views
    // hold no rows, and the seeds are `INSERT OR IGNORE` so a value Craig has already
    // tuned is never restated (migration rule 2).
    //
    // The COLUMNS are in `apply` below, because SQLite has no `ADD COLUMN IF NOT
    // EXISTS` and rule 3 requires this step to survive a file that already has the
    // shape — the same route the 14 -> 15, 16 -> 17 and 18 -> 19 steps take, and for
    // the same reason: `request`, `model_price` and `outcome` cannot be rebuilt (each
    // is referenced by other tables and/or carries append-only triggers whose whole
    // point is that rows are never copied anywhere).
    //
    // The VIEW definitions below MUST stay byte-identical to schema.sql's, because
    // `test/schema.test.ts` diffs a migrated file's `sqlite_master` against a fresh
    // one. `IF EXISTS` / `IF NOT EXISTS` for the reason v8 and every step since
    // documents: SQLite strips the clause before storing, so idempotence costs
    // nothing in fidelity.
    sql: `
DROP VIEW IF EXISTS v_priced;
CREATE VIEW IF NOT EXISTS v_priced AS
SELECT r.*, p.usd_in, p.usd_out, p.usd_cw, p.usd_cr, p.usd_cw1h, p.provisional,
  MIN(r.cw5m_tok, r.cw_tok) AS cw5m_priced_tok,
  MIN(r.cw1h_tok, r.cw_tok - MIN(r.cw5m_tok, r.cw_tok)) AS cw1h_priced_tok,
  r.cw_tok - MIN(r.cw5m_tok, r.cw_tok)
           - MIN(r.cw1h_tok, r.cw_tok - MIN(r.cw5m_tok, r.cw_tok)) AS cw_ttl_unknown_tok
FROM v_request_tiered r
JOIN model_price p ON p.family = r.price_family
 AND p.effective_from = (SELECT MAX(effective_from) FROM model_price
                         WHERE family = r.price_family AND effective_from <= r.ts);

DROP VIEW IF EXISTS v_wcet;
CREATE VIEW IF NOT EXISTS v_wcet AS
SELECT v.*,
  CAST((v.out_tok*v.usd_out + v.cw_cost) / v.ref_out AS INTEGER) AS wcet,
  CAST((v.in_tok*v.usd_in + v.out_tok*v.usd_out
        + v.cw_cost + v.cr_tok*v.usd_cr) / v.ref_out AS INTEGER) AS scet
FROM (SELECT p.*,
        p.cw1h_priced_tok * COALESCE(p.usd_cw1h, p.usd_cw)
          + p.cw5m_priced_tok * p.usd_cw
          + p.cw_ttl_unknown_tok * p.usd_cw AS cw_cost,
        (SELECT usd_out FROM model_price
          WHERE family = (SELECT v FROM config WHERE k='ref_model')
            AND effective_from <= p.ts
          ORDER BY effective_from DESC LIMIT 1) AS ref_out
      FROM v_priced p) v;

CREATE VIEW IF NOT EXISTS v_cw_ttl_exposure AS
SELECT ts, model_family, tid, cw_tok, cw5m_tok, cw1h_tok, cw_ttl_src,
       MAX(cw_tok - cw5m_tok - cw1h_tok, 0) AS cw_ttl_unknown_tok,
       MAX(cw5m_tok + cw1h_tok - cw_tok, 0) AS cw_ttl_over_tok
FROM v_request_live
WHERE cw_tok > 0
  AND (cw_ttl_src = 'unrecorded'
       OR cw5m_tok + cw1h_tok <> cw_tok);

CREATE VIEW IF NOT EXISTS v_cw_1h_price_gap AS
SELECT p.family, p.effective_from, p.usd_cw1h_src
FROM model_price p
WHERE p.usd_cw1h IS NULL
  AND EXISTS (SELECT 1 FROM v_priced r WHERE r.price_family = p.family AND r.cw_tok > 0);

DROP VIEW IF EXISTS v_task_actual_epoch;
CREATE VIEW IF NOT EXISTS v_task_actual_epoch AS
SELECT r.tid,
  SUM(CAST((CASE e.estimand
              WHEN 'out'         THEN r.out_tok*pe.usd_out
              WHEN 'work_cet'    THEN r.out_tok*pe.usd_out
                + MIN(r.cw5m_tok, r.cw_tok) * pe.usd_cw
                + MIN(r.cw1h_tok, r.cw_tok - MIN(r.cw5m_tok, r.cw_tok)) * COALESCE(pe.usd_cw1h, pe.usd_cw)
                + (r.cw_tok - MIN(r.cw5m_tok, r.cw_tok)
                            - MIN(r.cw1h_tok, r.cw_tok - MIN(r.cw5m_tok, r.cw_tok))) * pe.usd_cw
              WHEN 'out_cw_in'   THEN r.out_tok*pe.usd_out + r.in_tok*pe.usd_in
                + MIN(r.cw5m_tok, r.cw_tok) * pe.usd_cw
                + MIN(r.cw1h_tok, r.cw_tok - MIN(r.cw5m_tok, r.cw_tok)) * COALESCE(pe.usd_cw1h, pe.usd_cw)
                + (r.cw_tok - MIN(r.cw5m_tok, r.cw_tok)
                            - MIN(r.cw1h_tok, r.cw_tok - MIN(r.cw5m_tok, r.cw_tok))) * pe.usd_cw
              WHEN 'story_point' THEN r.out_tok*pe.usd_out
                + MIN(r.cw5m_tok, r.cw_tok) * pe.usd_cw
                + MIN(r.cw1h_tok, r.cw_tok - MIN(r.cw5m_tok, r.cw_tok)) * COALESCE(pe.usd_cw1h, pe.usd_cw)
                + (r.cw_tok - MIN(r.cw5m_tok, r.cw_tok)
                            - MIN(r.cw1h_tok, r.cw_tok - MIN(r.cw5m_tok, r.cw_tok))) * pe.usd_cw
            END) / rf.usd_out AS INTEGER)) AS wcet_at_epoch,
  e.price_epoch, e.eid AS eid_at_start
FROM v_request_live r
JOIN estimate e ON e.eid = (SELECT MIN(eid) FROM estimate WHERE tid = r.tid)
-- Same per-request context tier as v_priced, but resolved AT THE EPOCH rather than
-- at the request's own ts: reusing v_request_tiered here would pick a companion
-- family that may not exist at price_epoch, and this INNER JOIN would then drop the
-- request silently instead of pricing it. The \`NOT LIKE '%]'\` guard is the same
-- one v_request_tiered carries and for the same reason: a bracketed family's own
-- row already carries the long-context rate.
JOIN model_price pe
  ON pe.family = CASE WHEN (r.in_tok + r.cw_tok + r.cr_tok) > 200000
                       AND r.model_family NOT LIKE '%]'
                       AND EXISTS (SELECT 1 FROM model_price hi
                                    WHERE hi.family = r.model_family || '@above_200k'
                                      AND hi.effective_from <= e.price_epoch)
                      THEN r.model_family || '@above_200k'
                      ELSE r.model_family END
 AND pe.effective_from = (SELECT MAX(effective_from) FROM model_price
                          WHERE family = pe.family AND effective_from <= e.price_epoch)
-- The normaliser. \`e.ref_model\`, not config: the whole view is an INNER JOIN to
-- \`estimate\`, so the snapshot is always available and config could only ever be a
-- late substitute for it.
JOIN model_price rf ON rf.family = e.ref_model
 AND rf.effective_from = (SELECT MAX(effective_from) FROM model_price
                          WHERE family = rf.family AND effective_from <= e.price_epoch)
WHERE r.tid IS NOT NULL AND r.attr <> 'overhead'
  AND r.origin IN ('main','subagent')   -- task effort only; 'auxiliary' excluded (§4.6)
GROUP BY r.tid;

INSERT OR IGNORE INTO config (k, v) VALUES
  ('price_cw_1h_min_multiple',    '1.5'),
  ('price_cw_1h_max_multiple',    '2.5'),
  ('price_cw_1h_default_multiple', '2'),
  ('cw_ttl_unknown_warn_share',    '0.02');
`,
    apply: (db: Database): void => {
      // Each definition is written EXACTLY as schema.sql spells it: SQLite splices
      // this text into the stored CREATE TABLE and `test/schema.test.ts` diffs a
      // migrated file's `sqlite_master` against a fresh one byte for byte.
      if (!hasColumn(db, "request", "cw5m_tok")) {
        db.exec("ALTER TABLE request ADD COLUMN cw5m_tok INTEGER NOT NULL DEFAULT 0 CHECK (cw5m_tok >= 0)");
      }
      if (!hasColumn(db, "request", "cw1h_tok")) {
        db.exec("ALTER TABLE request ADD COLUMN cw1h_tok INTEGER NOT NULL DEFAULT 0 CHECK (cw1h_tok >= 0)");
      }
      if (!hasColumn(db, "request", "cw_ttl_src")) {
        db.exec(
          "ALTER TABLE request ADD COLUMN cw_ttl_src TEXT NOT NULL DEFAULT 'unrecorded' CHECK (cw_ttl_src IN ('transcript','unrecorded'))",
        );
      }
      if (!hasColumn(db, "model_price", "usd_cw1h")) {
        db.exec("ALTER TABLE model_price ADD COLUMN usd_cw1h REAL CHECK (usd_cw1h IS NULL OR usd_cw1h >= 0)");
      }
      if (!hasColumn(db, "model_price", "usd_cw1h_src")) {
        db.exec(
          "ALTER TABLE model_price ADD COLUMN usd_cw1h_src TEXT NOT NULL DEFAULT 'unrecorded' CHECK (usd_cw1h_src IN ('litellm','models_dev','manual','derived_from_input','unrecorded') AND ((usd_cw1h IS NULL) = (usd_cw1h_src = 'unrecorded')))",
        );
      }
      if (!hasColumn(db, "outcome", "cw_ttl_unknown_share")) {
        db.exec("ALTER TABLE outcome ADD COLUMN cw_ttl_unknown_share REAL");
      }
    },
  },
];

export interface OpenOptions {
  /** Database file. Defaults to DB_PATH. */
  path?: string;
  /**
   * Open read-only (statusline, board, any read model). Never initialises;
   * throws if the database is missing or uninitialised.
   */
  readonly?: boolean;
  /** Skip initialisation even when writable — used to inspect a raw file. */
  noInit?: boolean;
  /**
   * `busy_timeout` for this connection, ms. Defaults to 5000 (§2's single-writer
   * hygiene). `est burn` passes **50**: a statusline that queues behind a sweep is
   * worse than one that is five seconds stale, so it must fail fast (P1.9).
   */
  busyTimeoutMs?: number;
  /** Skip pending migrations (inspection paths). Ignored when `readonly`. */
  noMigrate?: boolean;
}

/** PRAGMAs applied to every connection, before any DDL/DML. */
function applyPragmas(db: Database, readonly: boolean, busyTimeoutMs: number): void {
  // journal_mode is a persistent property of the file; only a writer may set it,
  // and it can never be set from inside a transaction.
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  } else {
    // Belt to the connection flag's braces: a read model must be incapable of
    // writing even if a future edit hands it a statement that would (P1.9).
    db.exec("PRAGMA query_only = ON;");
  }
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);
  db.exec("PRAGMA foreign_keys = ON;");
}

/** True when the `config` table exists — the marker that DDL has ever run. */
function hasConfigTable(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='config'",
    )
    .get();
  return row !== null;
}

/** config.schema_version, or null when absent. */
export function schemaVersion(db: Database): string | null {
  if (!hasConfigTable(db)) return null;
  const row = db
    .query<{ v: string }, []>("SELECT v FROM config WHERE k='schema_version'")
    .get();
  return row?.v ?? null;
}

/**
 * Apply schema.sql to an empty database.
 *
 * The file's leading connection PRAGMAs are stripped before execution: they are
 * already set by applyPragmas(), and `PRAGMA journal_mode` raises
 * "cannot change into wal mode from within a transaction" if left in the DDL
 * transaction. Everything else runs as ONE transaction, so a failure leaves the
 * file empty and re-runnable rather than half-built.
 */
export function applySchema(db: Database, schemaPath: string = SCHEMA_PATH): void {
  const sql = readSchema(schemaPath);
  const ddl = sql.replace(/^[ \t]*PRAGMA[^;]*;[ \t]*$/gim, "");
  db.transaction(() => db.exec(ddl))();
}

function readSchema(schemaPath: string): string {
  // Sync read: initialisation happens once, before anything else, and every
  // caller (CLI, hooks, tests) wants it to have already happened.
  const text = readFileSync(schemaPath, "utf8");
  if (text.trim().length === 0) {
    throw new Error(`estimator: schema is empty: ${schemaPath}`);
  }
  return text;
}

/**
 * Open the estimator database, initialising it from schema.sql if needed.
 * Idempotent: opening an initialised database only sets PRAGMAs and verifies
 * the schema version.
 */
export function openDb(options: OpenOptions = {}): Database {
  const path = options.path ?? DB_PATH;
  const readonly = options.readonly ?? false;

  if (!readonly) mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, readonly ? { readonly: true } : { create: true });
  try {
    applyPragmas(db, readonly, options.busyTimeoutMs ?? 5000);

    let version = schemaVersion(db);
    if (version !== null && version !== SCHEMA_VERSION && !readonly && options.noMigrate !== true) {
      version = migrate(db, version);
    }

    if (version === null) {
      if (readonly) {
        throw new Error(
          `estimator: database at ${path} is not initialised; run \`est init\` (or bun run init) first`,
        );
      }
      if (options.noInit) return db;
      if (hasConfigTable(db)) {
        // config exists without a version row: someone deleted the seed, or an
        // older/foreign schema is in the file. Never guess — §2 loud failures.
        throw new Error(
          `estimator: database at ${path} has a config table but no schema_version row (partially initialised or foreign schema); refusing to touch it`,
        );
      }
      applySchema(db);
      const applied = schemaVersion(db);
      if (applied !== SCHEMA_VERSION) {
        throw new Error(
          `estimator: schema.sql seeded schema_version=${applied}, expected ${SCHEMA_VERSION}`,
        );
      }
      return db;
    }

    if (version !== SCHEMA_VERSION) {
      throw new Error(
        `estimator: schema_version mismatch at ${path}: database=${version}, code expects ${SCHEMA_VERSION}. ` +
          (readonly
            ? "This is a read-only connection, which never migrates; run any writing `est` command once to apply pending migrations."
            : `No migration path from ${version}; move the file aside or upgrade the code.`),
      );
    }

    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Walk {@link MIGRATIONS} forward from `version`, one `BEGIN IMMEDIATE` per step.
 * Returns the version actually reached — the caller decides whether that is enough,
 * so a database from the future (version > ours) fails loudly rather than being
 * "migrated" by a code path that has never seen its shape.
 */
export function migrate(db: Database, version: string): string {
  let current = version;
  for (;;) {
    const step = MIGRATIONS.find((m) => m.from === current);
    if (step === undefined) return current;
    db.transaction(() => {
      // Re-read INSIDE the write transaction: another process may have applied this
      // very step while we waited on the lock, and running it twice is a duplicate
      // -object error rather than a no-op.
      const observed = schemaVersion(db);
      if (observed !== step.from) return;
      db.exec(step.sql);
      // Same transaction, so a step whose column half succeeds and whose version bump
      // does not is not a state this database can be left in.
      step.apply?.(db);
      db.query("UPDATE config SET v=? WHERE k='schema_version'").run(step.to);
    }).immediate();
    const reached = schemaVersion(db);
    if (reached === current) return current; // another writer took a different path
    current = reached ?? current;
    if (current === SCHEMA_VERSION) return current;
  }
}

/** Read a config value, or null. */
export function getConfig(db: Database, key: string): string | null {
  const row = db.query<{ v: string }, [string]>("SELECT v FROM config WHERE k=?").get(key);
  return row?.v ?? null;
}

/**
 * The one config key `schema.sql` deliberately does NOT seed: its PRESENCE is what
 * retires the statusline's `[unvalidated]` marker (P2.6), and `est recon --certify` is
 * its only writer.
 *
 * It lives here rather than in `src/recon.ts` for a mechanical reason: `src/burn.ts`
 * reads it and `src/recon.ts` reads `src/burn.ts`'s interval union, so declaring it in
 * either of those makes an import cycle between the read path and the writer. `db.ts`
 * already owns every config accessor and depends on nothing.
 */
export const UNVALIDATED_RETIRED_KEY = "unvalidated_retired_at";

/** Is the `[unvalidated]` marker retired? See {@link UNVALIDATED_RETIRED_KEY}. */
export function unvalidatedRetired(db: Database): boolean {
  return getConfig(db, UNVALIDATED_RETIRED_KEY) !== null;
}

// ---------------------------------------------------------------------------
// the story-point anchor registry (v18)
// ---------------------------------------------------------------------------

/** `config.sp_anchor_id` — which definition is in force. */
export const ANCHOR_ID_KEY = "sp_anchor_id";
/** `config.sp_anchor_text` — a MIRROR of the registry, maintained by {@link setConfig}. */
export const ANCHOR_TEXT_KEY = "sp_anchor_text";

/**
 * An anchor's EFFECTIVE definition — the registry row with the newest
 * `sp_anchor_repair` correction laid over it — or `null` if nobody ever recorded one.
 *
 * `verified` is the v19 half and the one a caller must read before treating `text` as
 * authoritative. It is false while the definition is still the 17 -> 18 step's reading of
 * the mutable `{sp_anchor_id, sp_anchor_text}` config pair: that pair could be, and was
 * demonstrably able to be, driven into `{v1, "<the v2 definition>"}`, so migrating it in
 * as fact would launder exactly the corruption `sp_anchor` was added to prevent. A human
 * vouches for it through {@link repairAnchor} (which `est anchor define` calls), and only
 * then does it read as established.
 *
 * `verified: false` is a REPAIR STATE, not a refusal: the text is still shown, the id is
 * still a perfectly good denomination, and nothing that worked at v18 stops working.
 */
export interface AnchorDefinition {
  readonly id: string;
  /** The effective definition — a repair if one exists, otherwise what was recorded. */
  readonly text: string;
  /** What the base row records. Differs from `text` only after a correction. */
  readonly textRecorded: string;
  /** Has a human declared or confirmed this definition? */
  readonly verified: boolean;
}

/**
 * The full definition of `id`, correction included, or `null`.
 *
 * This and {@link anchorTextOf} are the ONLY read paths for an anchor's meaning.
 * `config.sp_anchor_text` is a mirror kept for `est config list`; it is never consulted,
 * because the entire reason `sp_anchor` exists is that a second mutable copy of the
 * definition could disagree with the id it was filed under.
 *
 * Lives in `src/db.ts` for the reason {@link UNVALIDATED_RETIRED_KEY} documents: this
 * file already owns every config accessor and depends on nothing, and `setConfig` — the
 * registry's only writer — is here.
 */
export function anchorDefinition(db: Database, id: string): AnchorDefinition | null {
  const row = db
    .query<{ text: string; text_recorded: string; verified: number }, [string]>(
      "SELECT text, text_recorded, verified FROM v_sp_anchor WHERE id = ?",
    )
    .get(id);
  if (row === null || row === undefined) return null;
  return {
    id,
    text: row.text,
    textRecorded: row.text_recorded,
    verified: row.verified === 1,
  };
}

/**
 * The work `id` was defined to be one point, or `null` if nobody ever recorded it.
 * Shorthand for {@link anchorDefinition}'s `text` — the effective definition, so a
 * repaired anchor reads as its correction everywhere.
 */
export function anchorTextOf(db: Database, id: string): string | null {
  return anchorDefinition(db, id)?.text ?? null;
}

/**
 * Define an anchor. Append-only, and idempotent on an exact restatement of a VERIFIED
 * definition.
 *
 * Re-using an id with a DIFFERENT definition is refused, and that refusal is the whole
 * mechanism: it is what makes `{id: 'v1', text: '<the v2 definition>'}` unrepresentable
 * rather than merely detectable. Without it the pair is two independent config keys and
 * the only defence available is a checker that notices afterwards — by which time bands
 * have been issued against a scale that is not the one they name.
 *
 * Exit 2: a re-wording IS a redefinition of the unit, it cannot be undone once bands
 * exist under it, and the legal path (a new id) is named in the remedy.
 *
 * **An UNVERIFIED definition is a different case and is routed to {@link repairAnchor}
 * (v19).** Refusing to move it would be defending a text nobody vouched for — the 17 ->
 * 18 step's reading of a mutable config pair — and would leave a user who can see it is
 * wrong with no way to say so.
 */
export function registerAnchor(db: Database, id: string, text: string, now: Date = new Date()): void {
  const existing = anchorDefinition(db, id);
  if (existing !== null && !existing.verified) {
    repairAnchor(db, id, text, { evidence: { method: "restated" }, now });
    return;
  }
  if (existing !== null && existing.text === text) return;
  if (existing !== null) {
    throw new InvariantError(
      `story-point anchor '${id}' is already defined as ${JSON.stringify(existing.text)}; ` +
        `re-wording it to ${JSON.stringify(text)} would redefine what one point means while leaving every band ` +
        "already issued — and every band issued from now on — claiming the same scale",
      `bump the id first, then state the definition: \`est config set ${ANCHOR_ID_KEY} <new id>\` ` +
        `followed by \`est config set ${ANCHOR_TEXT_KEY} "${text}"\`. ` +
        `Anchor ids are append-only for the same reason \`estimate\` is: '${id}' is what a stored band POINTS AT, ` +
        "so its meaning cannot move after the fact",
    );
  }
  db.query("INSERT INTO sp_anchor (id, text, created_at, origin) VALUES (?,?,?,'declared')").run(
    id,
    text,
    now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  );
}

/**
 * CONFIRM or CORRECT an unverified anchor definition (v19).
 *
 * The `estimate_identity_repair` pattern, applied to the same shape of problem: the base
 * row is never touched — `SELECT text FROM sp_anchor` still returns what the migration
 * believed — and the correction is appended beside it for `v_sp_anchor` to project.
 * Restating the same text is a CONFIRMATION and is recorded identically, because the fact
 * that was missing is not the wording, it is that a human vouched for it.
 *
 * Refused on a `'declared'` anchor: that one was stated up front and bands point at it,
 * so {@link registerAnchor}'s refusal is the right answer and this is not a way around it.
 */
export function repairAnchor(
  db: Database,
  id: string,
  text: string,
  opts: { evidence: unknown; note?: string | null; now?: Date } = { evidence: {} },
): void {
  const existing = anchorDefinition(db, id);
  if (existing === null) {
    throw new InvariantError(
      `story-point anchor '${id}' has no recorded definition, so there is nothing to repair`,
      `state it instead: \`est anchor define ${id} "<what one point is>"\``,
    );
  }
  // VERIFIED, by any route — declared up front, or vouched for by an earlier repair —
  // means the same thing and gets the same refusal. The ledger admits many rows per id
  // (`estimate_identity_repair` uses that), but the second one would be re-wording a
  // definition a human has already stood behind, which is the redefinition this whole
  // table exists to refuse. One correction is the way OUT of the migration's guess; it is
  // not a standing licence to re-word.
  if (existing.verified) {
    throw new InvariantError(
      `story-point anchor '${id}' is already vouched for as ${JSON.stringify(existing.text)}; ` +
        "a definition someone has stood behind is what stored bands point at, and it does not move",
      `bump the id first, then state the definition: \`est config set ${ANCHOR_ID_KEY} <new id>\` ` +
        `followed by \`est config set ${ANCHOR_TEXT_KEY} "${text}"\``,
    );
  }
  const now = opts.now ?? new Date();
  const seq =
    (db
      .query<{ s: number | null }, [string]>("SELECT MAX(seq) AS s FROM sp_anchor_repair WHERE id = ?")
      .get(id)?.s ?? 0) + 1;
  db.query(
    "INSERT INTO sp_anchor_repair (id, seq, repaired_at, text, evidence, note) VALUES (?,?,?,?,?,?)",
  ).run(
    id,
    seq,
    now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    text,
    JSON.stringify(opts.evidence ?? {}),
    opts.note ?? null,
  );
}

/**
 * Write a config value (upsert). Config is the home of every tunable (§1.1).
 *
 * Two keys are not plain tunables and are intercepted here rather than in
 * `src/cli.ts`'s `est config set`, because `setConfig` is the single writer and a guard
 * that lives above it is a guard the next caller can walk around:
 *
 *  - **`sp_anchor_text`** DEFINES the anchor currently in force. It registers, or it is
 *    refused as a redefinition ({@link registerAnchor}). It never silently re-words.
 *  - **`sp_anchor_id`** SELECTS a definition. Pointing at an id nobody has defined is
 *    allowed — that is the intended middle of `set sp_anchor_id v2` followed by
 *    `set sp_anchor_text "…"` — and the mirror goes empty to say so, rather than
 *    keeping the previous anchor's words under the new id's name.
 *
 * Both arms and the upsert share one transaction: a mirror that disagreed with the
 * registry would be the very confusion this table was added to end.
 */
export function setConfig(db: Database, key: string, value: string): void {
  const write = (k: string, v: string): void => {
    db.query("INSERT INTO config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(
      k,
      v,
    );
  };
  if (key !== ANCHOR_TEXT_KEY && key !== ANCHOR_ID_KEY) {
    write(key, value);
    return;
  }
  db.transaction(() => {
    if (key === ANCHOR_TEXT_KEY) {
      const id = getConfig(db, ANCHOR_ID_KEY);
      // An empty text is "clear the mirror", not "define the anchor as nothing".
      if (id !== null && value.trim() !== "") registerAnchor(db, id, value);
      write(key, value);
      return;
    }
    write(ANCHOR_ID_KEY, value);
    write(ANCHOR_TEXT_KEY, anchorTextOf(db, value) ?? "");
  })();
}

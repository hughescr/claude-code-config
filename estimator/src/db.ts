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

/** Project root — the directory holding schema.sql, src/, scripts/, gates/. */
export const ROOT: string = resolve(import.meta.dir, "..");

/** Canonical schema location. */
export const SCHEMA_PATH: string = join(ROOT, "schema.sql");

/**
 * Canonical database location. `EST_DB` overrides it (tests, one-off checks,
 * `est --db`); the DB and its sidecars are gitignored (§4, §10 Q11).
 */
export const DB_PATH: string = process.env.EST_DB ?? join(ROOT, "estimator.db");

/**
 * Must match the config.schema_version seed in schema.sql.
 *
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
export const SCHEMA_VERSION = "10";

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
                                    -- \`est backfill --full\` rewrites it; D1's vanish-age split
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

/** Write a config value (upsert). Config is the home of every tunable (§1.1). */
export function setConfig(db: Database, key: string, value: string): void {
  db.query("INSERT INTO config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(
    key,
    value,
  );
}

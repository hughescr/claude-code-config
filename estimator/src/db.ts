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
export const SCHEMA_VERSION = "7";

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

/** Write a config value (upsert). Config is the home of every tunable (§1.1). */
export function setConfig(db: Database, key: string, value: string): void {
  db.query("INSERT INTO config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(
    key,
    value,
  );
}

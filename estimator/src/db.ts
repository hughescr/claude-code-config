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
export const SCHEMA_VERSION = "4";

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
}

/** PRAGMAs applied to every connection, before any DDL/DML. */
function applyPragmas(db: Database, readonly: boolean): void {
  // journal_mode is a persistent property of the file; only a writer may set it,
  // and it can never be set from inside a transaction.
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec("PRAGMA busy_timeout = 5000;");
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
    applyPragmas(db, readonly);

    const version = schemaVersion(db);

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
        `estimator: schema_version mismatch at ${path}: database=${version}, code expects ${SCHEMA_VERSION}. No migrations exist yet; move the file aside or upgrade the code.`,
      );
    }

    return db;
  } catch (err) {
    db.close();
    throw err;
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

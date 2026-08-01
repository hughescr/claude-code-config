#!/usr/bin/env bun
/**
 * Schema smoke check — the `sqlite3 :memory: < schema.sql` equivalent, with teeth.
 *
 * Loads schema.sql into a throwaway database via src/db.ts and asserts the
 * things a silent DDL error would otherwise hide:
 *   - every table/view named in design R3 §4.2 exists;
 *   - the append-only triggers actually ABORT;
 *   - config and bucket_def seeds landed;
 *   - re-opening is a no-op (idempotent init);
 *   - every view is queryable (SQLite does not resolve view bodies at CREATE time).
 *
 * Usage: bun run scripts/check-schema.ts   (alias: bun run check:schema)
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_PATH, SCHEMA_VERSION } from "../src/db.ts";

const EXPECTED_TABLES = [
  "agent_run",
  "anomaly",
  "bucket_def",
  "burn_cache",
  "calib_run",
  "config",
  "corpus_loss",
  "estimate",
  "estimate_block",
  "estimate_identity_repair",
  "eta_run",
  "job_item",
  "job_run",
  "model_price",
  "otel_metric",
  "otel_request",
  "outcome",
  "price_sync",
  "recon",
  "recon_metric",
  "refclass",
  "request",
  "run_segment",
  "session_model",
  "sp_anchor",
  "sweep_census",
  "sweep_state",
  "task",
  "task_alias",
  "task_event",
  "task_fts",
  "task_scope",
  "turn",
  "workflow_phase",
  "workflow_run",
];

const EXPECTED_VIEWS = [
  "v_block_accuracy",
  "v_estimate_identity",
  "v_eta_corpus",
  "v_missed_estimate",
  "v_otel_join",
  "v_outcome_current",
  "v_phase_actual",
  "v_priced",
  "v_recon_week",
  "v_request_live",
  "v_request_tiered",
  "v_scope_current",
  "v_segment_current",
  "v_task_actual",
  "v_task_actual_epoch",
  "v_unpriced",
  "v_velocity",
  "v_wcet",
];

const EXPECTED_TRIGGERS = [
  "eir_ro_d",
  "eir_ro_u",
  "est_ro_d",
  "est_ro_u",
  "estb_ro_d",
  "estb_ro_u",
  "eta_ro_d",
  "eta_ro_u",
  "out_ro_d",
  "out_ro_u",
  "rc_ro_d",
  "rc_ro_u",
  "scope_ro_d",
  "scope_ro_u",
  "spa_ro_d",
  "spa_ro_u",
];

const EXPECTED_CONFIG_KEYS = [
  "attr_stale_minutes",
  "attr_stale_turns",
  "board_min_interval_s",
  "boot_resamples",
  "coverage_prior",
  "estimand",
  "eta_min_fit",
  "eta_min_pinball_gain",
  "eta_min_segments",
  "job_item_min_pop",
  "otel_max_body_mb",
  "otel_spool_retention_days",
  "otel_stale_min",
  "quiesce_main_min",
  "recon_alert_pct",
  "ref_model",
  "schema_version",
  "segment_gap_min",
  "shrink_k",
  "split_min_pinball_gain",
  "unvalidated_max_delta_pct",
  "unvalidated_min_join_pct",
  "unvalidated_weeks",
  "velocity_half_life_days",
];

/**
 * `unvalidated_retired_at` is the one config key that must NOT be seeded: `est recon
 * --certify` is its only writer and its PRESENCE is what retires the statusline's
 * `[unvalidated]` marker (P2.6). A seed here would certify the system on day one.
 */
const FORBIDDEN_CONFIG_KEYS = ["unvalidated_retired_at"];

const failures: string[] = [];

function check(ok: boolean, message: string): void {
  if (!ok) failures.push(message);
}

function names(db: Database, type: string): string[] {
  return db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((r) => r.name);
}

const dir = mkdtempSync(join(tmpdir(), "estimator-schema-check-"));
const dbPath = join(dir, "check.db");

try {
  const db = openDb({ path: dbPath });

  // FTS5 creates shadow tables (task_fts_data etc.); count only declared objects.
  const allTables = names(db, "table");
  const tables = allTables.filter((n) => !/^task_fts_(data|idx|content|docsize|config)$/.test(n));
  const views = names(db, "view");
  const triggers = names(db, "trigger");
  const indexes = names(db, "index");

  for (const t of EXPECTED_TABLES) check(tables.includes(t), `missing table: ${t}`);
  for (const v of EXPECTED_VIEWS) check(views.includes(v), `missing view: ${v}`);
  for (const g of EXPECTED_TRIGGERS) check(triggers.includes(g), `missing trigger: ${g}`);

  const extraTables = tables.filter((t) => !EXPECTED_TABLES.includes(t));
  check(extraTables.length === 0, `unexpected tables: ${extraTables.join(", ")}`);
  const extraViews = views.filter((v) => !EXPECTED_VIEWS.includes(v));
  check(extraViews.length === 0, `unexpected views: ${extraViews.join(", ")}`);

  // Views are not name-resolved at CREATE time — a typo only surfaces on SELECT.
  for (const v of views) {
    try {
      db.query(`SELECT * FROM ${v} LIMIT 0`).all();
    } catch (err) {
      failures.push(`view not queryable: ${v} — ${(err as Error).message}`);
    }
  }

  // Seeds.
  const configKeys = db
    .query<{ k: string }, []>("SELECT k FROM config ORDER BY k")
    .all()
    .map((r) => r.k);
  for (const k of EXPECTED_CONFIG_KEYS) check(configKeys.includes(k), `missing config key: ${k}`);
  for (const k of FORBIDDEN_CONFIG_KEYS) {
    check(!configKeys.includes(k), `config key ${k} is SEEDED; only \`est recon --certify\` may write it`);
  }
  const version = db.query<{ v: string }, []>("SELECT v FROM config WHERE k='schema_version'").get();
  check(version?.v === SCHEMA_VERSION, `schema_version seed is ${version?.v}, expected ${SCHEMA_VERSION}`);
  const estimand = db.query<{ v: string }, []>("SELECT v FROM config WHERE k='estimand'").get();
  check(estimand?.v === "work_cet", `estimand seed is ${estimand?.v}, expected work_cet`);
  const globalBucket = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM bucket_def WHERE bucket='global'")
    .get();
  check(globalBucket?.n === 1, "bucket_def is missing the seeded 'global' row");

  // PRAGMAs that the single-writer story depends on.
  const fk = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  check(fk?.foreign_keys === 1, "foreign_keys is not ON");
  const jm = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  check(jm?.journal_mode === "wal", `journal_mode is ${jm?.journal_mode}, expected wal`);

  // Append-only triggers must actually fire. task_scope is the cheapest to prove:
  // insert a task + scope row, then try to mutate it.
  db.query(
    "INSERT INTO task (tid,kind,status,created_at,anchor_session,anchor_prompt) VALUES ('t0','implement','estimating','1970-01-01T00:00:00Z','s0','p0')",
  ).run();
  db.query(
    "INSERT INTO task_scope (tid,seq,ts,subject,dod_json,scope_hash,source) VALUES ('t0',1,'1970-01-01T00:00:00Z','probe','[]','deadbeef','est_open')",
  ).run();
  for (const [label, sql] of [
    ["task_scope UPDATE", "UPDATE task_scope SET subject='mutated' WHERE tid='t0'"],
    ["task_scope DELETE", "DELETE FROM task_scope WHERE tid='t0'"],
  ] as const) {
    let aborted = false;
    try {
      db.query(sql).run();
    } catch (err) {
      aborted = /append-only/.test((err as Error).message);
    }
    check(aborted, `${label} was NOT blocked by the append-only trigger`);
  }

  // Counter CHECKs. A negative token count is corrupt input, and the §5.2 MAX
  // upsert would pin it in place; the constraint must reject it at the row.
  for (const col of ["in_tok", "out_tok", "cw_tok", "cr_tok"]) {
    let rejected = false;
    try {
      db.query(
        `INSERT INTO request (request_id, session_id, origin, model, model_family, ts, ${col})
         VALUES ('neg-${col}', 's0', 'main', 'm', 'm', '1970-01-01T00:00:00Z', -1)`,
      ).run();
    } catch (err) {
      rejected = /CHECK constraint failed/i.test((err as Error).message);
    }
    check(rejected, `request.${col} accepted a NEGATIVE value`);
  }

  // task_event's dedup key must survive NULL inputs: SQLite treats NULLs as
  // distinct inside a UNIQUE index, so without the NOT NULL sentinels the
  // sweeper's `ON CONFLICT ... DO NOTHING` re-inserted on every re-sweep.
  const teInsert =
    `INSERT INTO task_event (session_id, task_num, ts, kind, from_status, to_status, source)
     VALUES ('s0', NULL, '1970-01-01T00:00:00Z', NULL, NULL, NULL, 'transcript')
     ON CONFLICT(session_id, task_num, ts, to_status, kind) DO NOTHING`;
  db.query(teInsert).run();
  db.query(teInsert).run();
  const teRows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get();
  check(teRows?.n === 1, `task_event re-insert produced ${teRows?.n} rows, expected 1 (NULL dedup)`);
  const teNulls = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM task_event WHERE task_num IS NULL OR to_status IS NULL OR kind IS NULL",
    )
    .get();
  check(teNulls?.n === 0, "task_event stored a NULL in a dedup-key column");

  // A TaskCreate and a transition to the same status at the same instant are two
  // different facts; `kind` is in the key so one cannot swallow the other.
  db.query(
    `INSERT INTO task_event (session_id, task_num, ts, kind, from_status, to_status, source)
     VALUES ('s0', '9', '1970-01-01T00:00:01Z', 'create', NULL, 'pending', 'transcript'),
            ('s0', '9', '1970-01-01T00:00:01Z', 'status', 'in_progress', 'pending', 'transcript')`,
  ).run();
  const teKinds = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event WHERE task_num='9'")
    .get();
  check(teKinds?.n === 2, `task_event collapsed a create and a status change into ${teKinds?.n} row(s)`);

  // The unit an estimate was issued in is mandatory (§4.1): price_epoch pins the
  // RATES, ref_model/estimand pin the DEFINITION of a CET.
  const estCols = db
    // `notnull` is the NOTNULL operator to SQLite's tokeniser; it has to be quoted.
    .query<{ name: string; nn: number }, []>(
      `SELECT name, "notnull" AS nn FROM pragma_table_info('estimate')`,
    )
    .all();
  for (const col of ["ref_model", "estimand"]) {
    const c = estCols.find((x) => x.name === col);
    check(c !== undefined, `estimate is missing the unit column: ${col}`);
    check(c?.nn === 1, `estimate.${col} is nullable; the unit must always be recorded`);
  }

  // Foreign keys are enforced on this connection.
  let fkRejected = false;
  try {
    db.query(
      "INSERT INTO task_alias (tid,id_kind,session_id,local_id,first_seen) VALUES ('nope','session','s1','l1','1970-01-01T00:00:00Z')",
    ).run();
  } catch (err) {
    fkRejected = /FOREIGN KEY/i.test((err as Error).message);
  }
  check(fkRejected, "foreign key violation was not rejected");

  db.close();

  // Re-open: initialisation must be a no-op, not a second DDL run.
  const reopened = openDb({ path: dbPath });
  const tablesAfter = names(reopened, "table").filter(
    (n) => !/^task_fts_(data|idx|content|docsize|config)$/.test(n),
  );
  check(tablesAfter.length === tables.length, "re-open changed the table count (init is not idempotent)");
  reopened.close();

  console.log(`schema:   ${SCHEMA_PATH}`);
  console.log(`version:  ${version?.v}`);
  console.log(`tables:   ${tables.length}  (+${allTables.length - tables.length} fts5 shadow)`);
  console.log(`views:    ${views.length}`);
  console.log(`triggers: ${triggers.length}`);
  console.log(`indexes:  ${indexes.filter((n) => !/^sqlite_autoindex/.test(n)).length} explicit`);
  console.log(`objects:  ${tables.length + views.length} tables+views`);
  console.log("");
  console.log(`tables:   ${tables.join(" ")}`);
  console.log(`views:    ${views.join(" ")}`);

  if (failures.length > 0) {
    console.error(`\nFAIL (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nOK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

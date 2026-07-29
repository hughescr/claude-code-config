import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, openDb, SCHEMA_VERSION, schemaVersion, setConfig } from "./db.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "estimator-db-test-"));
  path = join(dir, "estimator.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openDb", () => {
  test("creates and initialises a missing database", () => {
    const db = openDb({ path });
    expect(existsSync(path)).toBe(true);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(getConfig(db, "estimand")).toBe("work_cet");
    db.close();
  });

  test("is idempotent — re-opening does not re-run the DDL", () => {
    const first = openDb({ path });
    const before = first
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master")
      .get()!.n;
    first.close();

    const second = openDb({ path });
    const after = second
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master")
      .get()!.n;
    expect(after).toBe(before);
    second.close();
  });

  test("sets the pragmas the single-writer story depends on", () => {
    const db = openDb({ path });
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe(
      "wal",
    );
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys).toBe(
      1,
    );
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout).toBe(5000);
    db.close();
  });

  test("refuses a readonly open of an uninitialised database", () => {
    expect(() => openDb({ path, readonly: true })).toThrow();
  });

  test("fails loudly on a schema_version mismatch instead of migrating", () => {
    const db = openDb({ path });
    setConfig(db, "schema_version", "999");
    db.close();
    expect(() => openDb({ path })).toThrow(/schema_version mismatch/);
  });

  test("migrates a v5 task_alias to the v6 key, carrying every row across verbatim", () => {
    // Reverse the 5 -> 6 rebuild to produce a genuine v5 shape, populate it, and let
    // openDb migrate it forward. The rows are the point: this is the one migration
    // that rebuilds a table, and a rebuild that loses an alias loses a task's spend.
    const db = openDb({ path });
    db.exec(`
CREATE TABLE task_alias_v5 (
  tid TEXT NOT NULL REFERENCES task(tid),
  id_kind TEXT NOT NULL CHECK (id_kind IN
    ('session_task','session','workflow_run','agent','job')),
  session_id TEXT NOT NULL, local_id TEXT NOT NULL, first_seen TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sweeper',
  PRIMARY KEY (id_kind, session_id, local_id)
) STRICT, WITHOUT ROWID;
DROP TABLE task_alias;
ALTER TABLE task_alias_v5 RENAME TO task_alias;
CREATE INDEX ix_alias_tid ON task_alias(tid);
INSERT INTO task (tid, kind, status, created_at, anchor_session, anchor_prompt)
  VALUES ('t1','implement','estimating','2026-01-01T00:00:00Z','s1','p1'),
         ('t2','implement','estimating','2026-01-01T01:00:00Z','s1','p2');
INSERT INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
  VALUES ('t1','session','s1','s1','2026-01-01T00:00:00Z','est_bind'),
         ('t1','agent','s1','a1','2026-01-01T00:05:00Z','sweeper');
`);
    setConfig(db, "schema_version", "5");
    db.close();

    const migrated = openDb({ path });
    expect(schemaVersion(migrated)).toBe(SCHEMA_VERSION);
    const rows = migrated
      .query<{ tid: string; id_kind: string; local_id: string; source: string }, []>(
        "SELECT tid, id_kind, local_id, source FROM task_alias ORDER BY id_kind",
      )
      .all();
    expect(rows).toEqual([
      { tid: "t1", id_kind: "agent", local_id: "a1", source: "sweeper" },
      { tid: "t1", id_kind: "session", local_id: "s1", source: "est_bind" },
    ]);

    // The point of the widened key: a second task may hold the same session.
    migrated
      .query(
        "INSERT INTO task_alias (tid,id_kind,session_id,local_id,first_seen,source) VALUES ('t2','session','s1','s1','2026-01-01T01:00:00Z','est_bind')",
      )
      .run();
    // ...and the point of ux_alias_exclusive: it may NOT hold the same agent.
    expect(() =>
      migrated
        .query(
          "INSERT INTO task_alias (tid,id_kind,session_id,local_id,first_seen,source) VALUES ('t2','agent','s1','a1','2026-01-01T01:00:00Z','est_bind')",
        )
        .run(),
    ).toThrow(/UNIQUE/i);
    migrated.close();
  });

  test("readonly opens an initialised database and can read config", () => {
    openDb({ path }).close();
    const ro = openDb({ path, readonly: true });
    expect(getConfig(ro, "ref_model")).not.toBeNull();
    expect(() => setConfig(ro, "ref_model", "nope")).toThrow();
    ro.close();
  });
});

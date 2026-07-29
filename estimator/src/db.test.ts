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

  test("readonly opens an initialised database and can read config", () => {
    openDb({ path }).close();
    const ro = openDb({ path, readonly: true });
    expect(getConfig(ro, "ref_model")).not.toBeNull();
    expect(() => setConfig(ro, "ref_model", "nope")).toThrow();
    ro.close();
  });
});

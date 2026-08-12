/**
 * scripts/check-schema.ts — the schema allowlist gate.
 *
 * The gate itself builds and tears down its own throwaway mkdtemp database
 * (src/db.ts's `path` option wins over EST_DB), so it is safe to run for real; the
 * EST_DB / EST_SPOOL_DIR env below is belt-and-braces per the standing rule that every
 * subprocess test sets them to temp paths regardless.
 *
 * This exists because the gate was previously reachable only via `bun run check:schema`
 * run by hand — nothing in `bun test` executed it, so a schema object added without a
 * matching allowlist entry shipped silently. Running the real gate as a subprocess here
 * closes that class of drift for any future schema object, not just today's two views.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync as readFile, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK_SCHEMA_SCRIPT = join(import.meta.dir, "..", "scripts", "check-schema.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "est-schema-gate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("schema gate", () => {
  test("bun run scripts/check-schema.ts exits 0 with no stderr", () => {
    const proc = Bun.spawnSync([process.execPath, "run", CHECK_SCHEMA_SCRIPT], {
      env: {
        ...process.env,
        EST_DB: join(dir, "estimator.db"),
        EST_SPOOL_DIR: join(dir, "spool"),
        EST_LOCK: join(dir, "sweep.lock"),
      },
    });
    expect({ code: proc.exitCode, stderr: proc.stderr.toString("utf8") }).toEqual({ code: 0, stderr: "" });
  });

  test("EXPECTED_VIEWS names every view actually declared in schema.sql", () => {
    // Cheap, no subprocess: catches a missing allowlist entry without parsing stderr.
    const src = readFile(CHECK_SCHEMA_SCRIPT, "utf8");
    const schemaSql = readFile(join(import.meta.dir, "..", "schema.sql"), "utf8");
    const declaredViews = [...schemaSql.matchAll(/CREATE VIEW (\w+)/g)].map((m) => m[1]);
    for (const v of declaredViews) {
      expect(src.includes(`"${v}"`)).toBe(true);
    }
  });
});

/**
 * test/backfill-idempotence.test.ts — `est backfill` run twice over an unchanged
 * fixture corpus must leave the database in the same state.
 *
 * `est backfill` is `est sweep --full`: it deliberately ignores the `sweep_state`
 * watermarks and re-reads every transcript from byte 0. That makes it the one verb
 * that re-derives the ENTIRE corpus on every invocation, so any writer that appends
 * where it should upsert, double-counts a request, re-raises a settled anomaly or
 * re-runs attribution to a different answer shows up here and nowhere else — a
 * watermarked `est sweep` skips the very files that would expose it.
 *
 * The check is deliberately whole-database and generic rather than a hand-picked
 * list of columns: it enumerates `sqlite_master` and hashes every row of every user
 * table, so a table added later is covered without anyone remembering to add it.
 * Exactly two things are allowed to differ, and both are asserted positively rather
 * than merely skipped:
 *
 *   - `sweep_census` gains one row per sweep. It is the append-only audit of "what
 *     did the corpus look like when we looked at it", so a second look SHOULD leave
 *     a second row; a backfill that left none would mean the census never ran.
 *   - `sweep_state.last_swept` is a wall-clock stamp of the most recent read. Every
 *     other column of that table (path, inode, bytes_read, mtime) is derived from
 *     the file and must be byte-identical.
 *
 * Everything is synthetic: the fixture corpus under `test/fixtures/corpus`, a
 * seeded task with an invented uuid, and round-number prices (§4 — no real id, path
 * or absolute token figure in a tracked file).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { makeHarness, price, REF_MODEL, type Harness } from "./support.ts";

const CORPUS = join(import.meta.dir, "fixtures", "corpus", "projects");
const SESSION = "11111111-1111-4111-8111-111111111111";
const TID = "019f0000-0000-7000-8000-0000000000b1";

/** Families the fixture corpus bills at, so the priced views are populated too. */
const FIXTURE_FAMILIES = ["claude-fable-5", "claude-sonnet-5", "claude-opus-5[1m]", "claude-opus-4-8"];

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-backfill-idem-");
});

afterEach(() => {
  h.close();
});

/** Tables whose row content is re-derived from the corpus and must not move. */
function userTables(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '%_fts'          -- fts5 virtual table
          AND name NOT LIKE '%_fts_%'        -- and its shadow tables
        ORDER BY name`,
    )
    .all()
    .map((r) => r.name);
}

/**
 * A content fingerprint per table: row count plus a hash over the sorted rows, so
 * the comparison is insensitive to physical row order (a re-derived table may be
 * rebuilt in a different order and still be the same state).
 */
function fingerprint(dbPath: string): Map<string, string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const out = new Map<string, string>();
    for (const t of userTables(db)) {
      // `last_swept` is a wall clock, not derived state — see the header.
      const projection = t === "sweep_state" ? "path, inode, bytes_read, mtime" : "*";
      const rows = db.query(`SELECT ${projection} FROM "${t}"`).all() as Record<string, unknown>[];
      const sorted = rows.map((r) => JSON.stringify(r)).sort();
      out.set(t, `${rows.length}|${Bun.hash(sorted.join("\n")).toString(16)}`);
    }
    return out;
  } finally {
    db.close();
  }
}

async function backfill(): Promise<void> {
  const r = await h.cli("backfill", "--root", CORPUS, "-q");
  // 3 is "anomalies were recorded", which a healthy fixture sweep may still return.
  expect([0, 3]).toContain(r.code);
}

describe("est backfill is idempotent over an unchanged corpus", () => {
  beforeEach(async () => {
    // The ref model too: Work-CET is denominated in ITS output tokens, so `v_wcet`
    // is empty without a `model_price` row for it however well the corpus is priced.
    for (const f of [...FIXTURE_FAMILIES, REF_MODEL]) price(h.db, f, { in: 1, out: 1, cw: 1, cr: 1 });
    // A bound task, so attribution and `burn_cache` are inside the compared state
    // rather than sitting empty: those are the writers most likely to differ on a
    // second pass, because they DELETE-then-reinsert rather than upsert.
    h.db
      .query(
        `INSERT INTO task (tid, kind, status, created_at, started_at, ended_at, anchor_session, anchor_prompt)
         VALUES (?, 'implement', 'in_progress', '2026-07-28T10:00:00Z', NULL, NULL, ?, 'P1')`,
      )
      .run(TID, SESSION);
    h.db
      .query(
        `INSERT INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
         VALUES (?, 'session', ?, ?, '2026-07-28T10:00:00Z', 'manual')`,
      )
      .run(TID, SESSION, SESSION);
  });

  test("a second backfill over the same files leaves every derived table identical", async () => {
    await backfill();
    const first = fingerprint(h.dbPath);
    // Sanity: the corpus really was ingested, so an all-empty database cannot pass
    // this test by being trivially stable.
    expect(first.get("request")).not.toMatch(/^0\|/);
    expect(first.get("agent_run")).not.toMatch(/^0\|/);
    expect(first.get("burn_cache")).not.toMatch(/^0\|/);

    await backfill();
    const second = fingerprint(h.dbPath);

    expect([...second.keys()]).toEqual([...first.keys()]);
    const moved = [...first.keys()].filter((t) => first.get(t) !== second.get(t));
    // `sweep_census` is the one append-only audit table; everything else is derived.
    expect(moved).toEqual(["sweep_census"]);
  });

  test("the census row is appended, not rewritten — the audit of the second look survives", async () => {
    await backfill();
    const censusRows = () =>
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sweep_census").get()!.n;
    expect(censusRows()).toBe(1);
    await backfill();
    expect(censusRows()).toBe(2);

    // And the second look found nothing missing: the corpus did not shrink between
    // the two passes, so the vanish detector must stay silent.
    const vanished = h.db
      .query<{ vanished_total: number }, []>(
        "SELECT vanished_total FROM sweep_census ORDER BY swept_at DESC, rowid DESC LIMIT 1",
      )
      .get()!.vanished_total;
    expect(vanished).toBe(0);
  });

  test("re-reading from byte 0 does not duplicate a request or re-raise a settled anomaly", async () => {
    await backfill();
    const counts = () =>
      h.db
        .query<
          { requests: number; anomalies: number; agents: number; runs: number; turns: number; wcet: number },
          []
        >(
          `SELECT (SELECT COUNT(*) FROM request)                    AS requests,
                  (SELECT COUNT(*) FROM anomaly)                    AS anomalies,
                  (SELECT COUNT(*) FROM agent_run)                  AS agents,
                  (SELECT COUNT(*) FROM workflow_run)               AS runs,
                  (SELECT COUNT(*) FROM turn)                       AS turns,
                  (SELECT COALESCE(SUM(wcet), 0) FROM v_wcet)       AS wcet`,
        )
        .get()!;
    const before = counts();
    expect(before.requests).toBeGreaterThan(0);
    expect(before.wcet).toBeGreaterThan(0);

    await backfill();
    expect(counts()).toEqual(before);
  });
});

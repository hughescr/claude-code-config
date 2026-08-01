/**
 * The band identity (schema v18) — one value, compared whole.
 *
 * Six defects arrived at review with one cause: what makes two bands comparable was
 * checked piecemeal, a different subset at each site. `src/unit.ts` replaces the
 * convention with a value; this file is the repro for each of the six, plus the
 * structural test that says a SEVENTH component would be one edit.
 *
 * Everything here is synthetic (`test/support.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeHarness,
  openArgs,
  REF_MODEL,
  request,
  seedPrices,
  turn,
  type Harness,
} from "./support.ts";
import { anchorTextOf, openDb, SCHEMA_VERSION, schemaVersion } from "../src/db.ts";
import { COLD_START_N, pointsToWcet } from "../src/tasks.ts";
import {
  BandIdentity,
  IDENTITY_COMPONENTS,
  POINTS_ESTIMAND,
  storyPointAnchor,
  type EstimateUnitColumns,
  type IdentityComponentName,
} from "../src/unit.ts";
import { attributeTasks } from "../src/attribute.ts";

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-unit-identity-");
  seedPrices(h.db);
  turn(h.db, { session: "s1", prompt: "p1", at: "2026-01-01T00:00:00Z" });
});

afterEach(() => {
  h.close();
});

const ALT_REF_MODEL = "claude-opus-5";

function flipToPoints(): void {
  h.db.query("UPDATE config SET v = ? WHERE k = 'estimand'").run(POINTS_ESTIMAND);
}

/** The v1 definition schema.sql seeds. Named once so a re-wording breaks one line. */
const V1_TEXT =
  "rename a single variable across 3 files in a TypeScript codebase, with no tests to update";

/**
 * One completed task, sized `p50` in the estimand in force, that really consumed `wcet`
 * Work-CET. `seedPrices` makes `usd_out = 1`, so `out_tok` IS the Work-CET figure.
 *
 * `family` pins the ESTIMATOR family through the `session_model` leg of
 * `resolveEstimatorIdentity`, which is ingest-independent and therefore the only leg a
 * fixture can set before `est open` runs. It is what makes the family-scope repro below
 * expressible at all.
 */
async function completed(
  n: number,
  wcet: number,
  p50: number,
  p90: number,
  family?: string,
): Promise<string> {
  const session = `u${n}`;
  const at = `2026-02-${String((n % 27) + 1).padStart(2, "0")}T00:00:00Z`;
  turn(h.db, { session, prompt: "p1", at, durationMs: 60_000 });
  if (family !== undefined) {
    h.db
      .query(
        "INSERT OR REPLACE INTO session_model (session_id, model, model_family, seen_at) VALUES (?,?,?,?)",
      )
      .run(session, family, family, at);
  }
  const r = await h.cli(
    ...openArgs({ subject: `sized work ${n}`, "raw-p50": p50, "raw-p90": p90 }),
    "--session", session, "--prompt", "p1", "--json",
  );
  expect(r.code).toBe(0);
  const tid = r.json<{ tid: string }>().tid;
  request(h.db, `rq-u-${n}`, { session, out: wcet, ts: at });
  attributeTasks(h.db);
  expect((await h.cli("close", tid, "--force")).code).toBeLessThanOrEqual(3);
  return tid;
}

// ---------------------------------------------------------------------------
// 1 — `ref_model` is part of the unit, at every site (Codex finding 1)
// ---------------------------------------------------------------------------

/**
 * `schema.sql` declares the unit as `(ref_model, estimand)` and says in as many words
 * that a band issued in sonnet-output-equivalents is not comparable to one issued in
 * opus-output-equivalents. The guard that enforced it read `estimand` and the anchor and
 * never looked at `ref_model` — so a one-line `est config set ref_model` let numbers
 * denominated in one currency be written under a parent denominated in another.
 */
describe("a ref_model flip is a unit change, and every writer sees it", () => {
  async function openOne(): Promise<string> {
    const r = await h.cli(
      ...openArgs({ subject: "opened under the old normaliser" }),
      "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(r.code).toBe(0);
    return r.json<{ tid: string }>().tid;
  }

  test("`est block` refuses numbers whose parent was normalised differently", async () => {
    const tid = await openOne();
    expect((await h.cli("config", "set", "ref_model", ALT_REF_MODEL)).code).toBe(0);

    const r = await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "500", "--p90", "900");
    expect(r.code).toBe(2);
    expect(r.err).toContain("normaliser");
    expect(r.err).toContain(REF_MODEL);
    expect(r.err).toContain(ALT_REF_MODEL);
    // The remedy names the command that puts the unit back.
    expect(r.err).toContain(`est config set ref_model ${REF_MODEL}`);
    // Nothing was written. Before the fix this row landed, and `v_block_accuracy` scored
    // it against the parent as if the two were in the same currency.
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_block").get()!.n,
    ).toBe(0);
  });

  test("`--continue` refuses rather than re-labelling the old raw band", async () => {
    const tid = await openOne();
    await h.cli("config", "set", "ref_model", ALT_REF_MODEL);

    // `--continue` copies the previous band's raw quantiles VERBATIM. Without ref_model
    // in the comparison it re-issued those sonnet-denominated numbers into a row stamped
    // `ref_model = claude-opus-5` — the same integers, a different currency, and nothing
    // anywhere recording that they had been redenominated.
    const r = await h.cli("open", "--continue", tid, "--session", "s1", "--prompt", "p1");
    expect(r.code).toBe(2);
    expect(r.err).toContain("normaliser");
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM estimate WHERE tid = ?").get(tid)!.n,
    ).toBe(1);
    // And no row anywhere claims the new normaliser.
    expect(
      h.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM estimate WHERE ref_model = ?")
        .get(ALT_REF_MODEL)!.n,
    ).toBe(0);
  });

  test("restoring the normaliser makes the same command work", async () => {
    const tid = await openOne();
    await h.cli("config", "set", "ref_model", ALT_REF_MODEL);
    expect((await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "500", "--p90", "900")).code).toBe(2);
    // The refusal is a denomination check, not a wall: the remedy it prints works.
    await h.cli("config", "set", "ref_model", REF_MODEL);
    expect((await h.cli("block", tid, "--phase", "0", "--title", "recon", "--p50", "500", "--p90", "900")).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2 — the foreign-anchor guard is scoped to the snapshot (Codex finding 2)
// ---------------------------------------------------------------------------

/**
 * `refclass` snapshots are fitted per `(bucket, estimator_family)`, so the rows behind a
 * multiplier are one family's. The guard defending that multiplier from an anchor bump
 * counted every family — so a single unrelated v1 sample from a model nobody is using
 * suppressed a homogeneous ten-sample v2 rate. A refusal justified by a row that was
 * never in the fit is a wrong refusal, not a conservative one, and this tool's degraded
 * mode is already "no percentage".
 */
describe("a foreign-anchor sample only poisons the family it is in", () => {
  const FAMILY_A = "claude-test-1";
  const FAMILY_B = "claude-other-9";

  test("a v1 sample in another family does not suppress a homogeneous v2 rate", async () => {
    flipToPoints();
    // One completed v1 task, in a family of its own, finalized BEFORE the snapshot — so
    // it is inside the window the guard checks and can only be excluded by family.
    await completed(1, 20_000, 10, 20, FAMILY_B);

    await h.cli("config", "set", "sp_anchor_id", "v2");
    await h.cli("config", "set", "sp_anchor_text", "a v2-sized piece of work");
    for (let i = 0; i < COLD_START_N; i += 1) await completed(10 + i, 60_000, 10, 20, FAMILY_A);
    expect((await h.cli("retro")).code).toBeLessThanOrEqual(3);

    const rate = pointsToWcet(h.db, {
      bucket: "global",
      estimatorFamily: FAMILY_A,
      refModel: REF_MODEL,
      estimand: POINTS_ESTIMAND,
      anchorId: "v2",
    });
    // Before the fix: { rate: null, source: null, n: 0 } — ten homogeneous v2 samples
    // refused because of one row in a different reference class.
    expect(rate.source).toBe("fitted");
    expect(rate.n).toBe(COLD_START_N);
    expect(rate.rate).toBeCloseTo(6000, 6);
  });

  test("a v1 sample in the SAME family still suppresses it", async () => {
    flipToPoints();
    await completed(1, 20_000, 10, 20, FAMILY_A);

    await h.cli("config", "set", "sp_anchor_id", "v2");
    await h.cli("config", "set", "sp_anchor_text", "a v2-sized piece of work");
    for (let i = 0; i < COLD_START_N; i += 1) await completed(10 + i, 60_000, 10, 20, FAMILY_A);
    expect((await h.cli("retro")).code).toBeLessThanOrEqual(3);

    // The snapshot for FAMILY_A really was fitted across both anchors, so its median is
    // per point of nothing in particular. Narrowing the guard must not blunt it.
    expect(
      pointsToWcet(h.db, {
        bucket: "global",
        estimatorFamily: FAMILY_A,
        refModel: REF_MODEL,
        estimand: POINTS_ESTIMAND,
        anchorId: "v2",
      }),
    ).toEqual({ rate: null, source: null, n: 0 });
  });
});

// ---------------------------------------------------------------------------
// 3 — one window, shared (Codex finding 3)
// ---------------------------------------------------------------------------

/**
 * `est retro --as-of T` used to fit every row in the unit regardless of `T`, while the
 * guard on the resulting snapshot counted only rows finalized at or before the
 * snapshot's own `as_of`. The two were never the same window, and the gap is exactly
 * wide enough to launder a mixture into a rate.
 */
describe("est retro fits the window it stamps on the snapshot", () => {
  async function twoAnchorsWorthOfCorpus(): Promise<void> {
    flipToPoints();
    for (let i = 0; i < COLD_START_N; i += 1) await completed(100 + i, 20_000, 10, 20);
    await h.cli("config", "set", "sp_anchor_id", "v2");
    await h.cli("config", "set", "sp_anchor_text", "a v2-sized piece of work");
    for (let i = 0; i < COLD_START_N; i += 1) await completed(200 + i, 60_000, 10, 20);
  }

  test("a backdated retro fits nothing, rather than everything under a backdated label", async () => {
    await twoAnchorsWorthOfCorpus();
    const asOf = "2000-01-01T00:00:00Z";
    expect((await h.cli("retro", "--as-of", asOf)).code).toBeLessThanOrEqual(3);

    // Before the fix: one snapshot at as_of 2000-01-01 with n = 20 — ten v1 samples at
    // 2,000/point and ten v2 at 6,000, pooled into one median, none of which had
    // happened at the instant the snapshot claims to speak for.
    const snaps = h.db
      .query<{ n: number }, [string]>("SELECT n FROM refclass WHERE as_of = ?")
      .all(asOf);
    expect(snaps).toEqual([]);
  });

  test("the mixture is never handed back as a v2 rate", async () => {
    await twoAnchorsWorthOfCorpus();
    await h.cli("retro", "--as-of", "2000-01-01T00:00:00Z");

    // Before the fix this returned `{ source: "fitted", n: 20, rate: ~2000 }` for a v2
    // band: the guard asked what a year-2000 snapshot could have seen, correctly found
    // zero foreign samples below the year 2000, and licensed the mixture.
    expect(
      pointsToWcet(h.db, {
        bucket: "global",
        estimatorFamily: "unknown",
        refModel: REF_MODEL,
        estimand: POINTS_ESTIMAND,
        anchorId: "v2",
      }),
    ).toEqual({ rate: null, source: null, n: 0 });
  });

  test("an ordinary retro still fits the whole corpus", async () => {
    // The window is a BOUND, not a new filter: with `--as-of` at the default (now) every
    // finalized row is at or before it, so nothing about the normal path moves.
    await twoAnchorsWorthOfCorpus();
    expect((await h.cli("retro")).code).toBeLessThanOrEqual(3);
    const total = h.db
      .query<{ n: number }, []>("SELECT SUM(n) AS n FROM refclass")
      .get()!.n;
    expect(total).toBe(2 * COLD_START_N);
  });

  test("the guard and the retro build their row set from the same expression", () => {
    // Not a behaviour test — a wiring test. The two used to be two SQL strings in two
    // files that were supposed to agree and did not.
    const identity = BandIdentity.ambient(h.db);
    const bounded = identity.samples({ asOf: "2026-05-01T00:00:00Z" });
    expect(bounded.where("any").sql).toContain("finalized_at <= ?");
    expect(bounded.where("foreign").sql).toContain("finalized_at <= ?");
    // Same base predicate; the anchor clause is the only difference, which is the one
    // widening `refclass`'s key legitimately forces.
    const base = bounded.where("any").sql;
    expect(bounded.where("foreign").sql.startsWith(base.split(" AND finalized_at")[0]!)).toBe(true);
    // And an unbounded scope (the cold-start denominator) says so by omitting the clause
    // rather than by passing a sentinel date.
    expect(identity.samples({ asOf: null }).where("any").sql).not.toContain("finalized_at");
  });
});

// ---------------------------------------------------------------------------
// 4 — the anchor's text cannot drift from its id (Codex finding 5)
// ---------------------------------------------------------------------------

/**
 * The refusal's own remedy was the exploit. "restore `est config set sp_anchor_id v1`"
 * only restores the SCALE if v1 still means what it meant, and the text lived in a second
 * mutable config key with nothing tying the two together.
 *
 * `sp_anchor` makes the text a function of the id. The desynchronised pair is not
 * detected — it is not expressible.
 */
describe("the story-point anchor registry", () => {
  test("restoring an id restores its definition, not whatever was typed last", async () => {
    expect(storyPointAnchor(h.db)).toEqual({ id: "v1", text: V1_TEXT });

    expect((await h.cli("config", "set", "sp_anchor_id", "v2")).code).toBe(0);
    expect((await h.cli("config", "set", "sp_anchor_text", "ship one CLI flag with its test")).code).toBe(0);
    expect(storyPointAnchor(h.db)).toEqual({ id: "v2", text: "ship one CLI flag with its test" });

    expect((await h.cli("config", "set", "sp_anchor_id", "v1")).code).toBe(0);
    // Codex's repro landed here with { id: "v1", text: "ship one CLI flag with its test" }
    // — v2-sized bands filed under the v1 scale, arrived at by following the remedy.
    expect(storyPointAnchor(h.db)).toEqual({ id: "v1", text: V1_TEXT });
    // The mirror agrees, because it is written from the registry rather than kept beside it.
    expect(
      h.db.query<{ v: string }, []>("SELECT v FROM config WHERE k='sp_anchor_text'").get()!.v,
    ).toBe(V1_TEXT);
  });

  test("re-wording a defined anchor is refused, and names the legal path", async () => {
    const r = await h.cli("config", "set", "sp_anchor_text", "something subtly different");
    expect(r.code).toBe(2);
    expect(r.err).toContain("already defined");
    expect(r.err).toContain("est config set sp_anchor_id");
    // Nothing moved: not the registry, not the mirror.
    expect(anchorTextOf(h.db, "v1")).toBe(V1_TEXT);
    expect(
      h.db.query<{ v: string }, []>("SELECT v FROM config WHERE k='sp_anchor_text'").get()!.v,
    ).toBe(V1_TEXT);
  });

  test("restating the SAME definition is a no-op, not a refusal", async () => {
    expect((await h.cli("config", "set", "sp_anchor_text", V1_TEXT)).code).toBe(0);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sp_anchor").get()!.n,
    ).toBe(1);
  });

  test("the registry is append-only, physically", () => {
    expect(() => h.db.query("UPDATE sp_anchor SET text = 'no' WHERE id = 'v1'").run()).toThrow(
      /append-only/,
    );
    expect(() => h.db.query("DELETE FROM sp_anchor WHERE id = 'v1'").run()).toThrow(/append-only/);
  });

  test("an id nobody has defined reads as undefined, never as the previous one's words", async () => {
    await h.cli("config", "set", "sp_anchor_id", "v2");
    expect(anchorTextOf(h.db, "v2")).toBeNull();
    expect(storyPointAnchor(h.db).text).not.toBe(V1_TEXT);
    // ...and the mirror says so too, rather than keeping v1's sentence under v2's name.
    expect(
      h.db.query<{ v: string }, []>("SELECT v FROM config WHERE k='sp_anchor_text'").get()!.v,
    ).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5 — the identity is one value, and a fifth component is one edit
// ---------------------------------------------------------------------------

/**
 * The test that says the CAUSE is fixed rather than the symptoms.
 *
 * It names no component. It walks {@link IDENTITY_COMPONENTS} and asserts that every
 * entry is carried by every derived form — the comparison, the refusal prose, and the
 * SQL row set. Appending a fifth entry to that table without wiring it fails here, and
 * wiring it correctly requires touching nothing but `src/unit.ts`.
 */
describe("the band identity carries every declared component", () => {
  const BASE: EstimateUnitColumns = {
    ref_model: REF_MODEL,
    estimand: POINTS_ESTIMAND,
    sp_anchor_id: "v1",
  };

  /**
   * A row differing from {@link BASE} in exactly the given component, or `null` when the
   * component is DERIVED and so cannot be varied on its own — which for `sp_anchor_text`
   * is not a gap in the test but the registry's guarantee restated: the text is a
   * function of the id, so there is no row that changes one without the other.
   */
  function varyOne(name: IdentityComponentName): EstimateUnitColumns | null {
    switch (name) {
      case "ref_model":
        return { ...BASE, ref_model: ALT_REF_MODEL };
      case "estimand":
        return { ...BASE, estimand: "work_cet" };
      case "sp_anchor_id":
        return { ...BASE, sp_anchor_id: "v9" };
      default:
        return null;
    }
  }

  test("the table is not empty and every entry is distinctly named", () => {
    expect(IDENTITY_COMPONENTS.length).toBeGreaterThan(0);
    expect(new Set(IDENTITY_COMPONENTS.map((c) => c.name)).size).toBe(IDENTITY_COMPONENTS.length);
  });

  test("every column-backed component is filtered on by the row set", () => {
    const scope = BandIdentity.ofEstimate(h.db, BASE).samples({ asOf: null });
    for (const c of IDENTITY_COMPONENTS) {
      if (c.column === null) continue;
      const sql = `${scope.where("any").sql} ${scope.where("this").sql}`;
      expect(sql).toContain(c.column);
    }
  });

  test("every component with a value appears in the refusal prose", () => {
    const described = BandIdentity.ofEstimate(h.db, BASE).describe();
    for (const c of IDENTITY_COMPONENTS) {
      // Every component of BASE has a value: ref_model, estimand, anchor id, and the
      // anchor text the registry resolves from that id.
      expect(described).toContain(c.label);
    }
  });

  test("varying any single component makes the identities unequal, and says which", () => {
    const base = BandIdentity.ofEstimate(h.db, BASE);
    for (const c of IDENTITY_COMPONENTS) {
      const varied = varyOne(c.name);
      if (varied === null) continue;
      const other = BandIdentity.ofEstimate(h.db, varied);
      expect(base.equals(other)).toBe(false);
      expect(base.differences(other).map((d) => d.component.name)).toContain(c.name);
    }
  });

  test("the derived component is compared too, when both sides have one", async () => {
    // Two ids, two definitions, both registered — so `sp_anchor_text` differs in its own
    // right and is reported in its own right. If the text were carried but not compared,
    // this would be one difference instead of two.
    await h.cli("config", "set", "sp_anchor_id", "v2");
    await h.cli("config", "set", "sp_anchor_text", "a v2-sized piece of work");
    const v1 = BandIdentity.ofEstimate(h.db, BASE);
    const v2 = BandIdentity.ofEstimate(h.db, { ...BASE, sp_anchor_id: "v2" });
    expect(v1.differences(v2).map((d) => d.component.name).sort()).toEqual(
      ["sp_anchor_id", "sp_anchor_text"],
    );
  });

  test("an unrecorded definition is skipped, not counted as a difference", () => {
    // The anti-over-refusal rule. A band naming an anchor that predates the registry has
    // no recoverable definition; treating "unknown" as "different" would refuse work
    // whose unit is in fact perfectly well known from its id.
    const known = BandIdentity.ofEstimate(h.db, BASE);
    const alsoKnown = BandIdentity.ofEstimate(h.db, BASE);
    expect(known.equals(alsoKnown)).toBe(true);
    const orphan = BandIdentity.ofEstimate(h.db, { ...BASE, sp_anchor_id: "v-legacy" });
    // Different id, so unequal — but only ONE difference, because the missing text makes
    // no claim either way.
    expect(orphan.differences(known).map((d) => d.component.name)).toEqual(["sp_anchor_id"]);
  });

  test("equality is total: identical inputs agree on every component", () => {
    const a = BandIdentity.ofEstimate(h.db, BASE);
    const b = BandIdentity.ofEstimate(h.db, { ...BASE });
    expect(a.equals(b)).toBe(true);
    expect(a.differences(b)).toEqual([]);
  });

  test("a Work-CET identity carries no anchor at all", () => {
    const wcet = BandIdentity.ambient(h.db);
    expect(wcet.describe()).not.toContain("story-point anchor");
    flipToPoints();
    expect(BandIdentity.ambient(h.db).describe()).toContain("story-point anchor");
  });
});

// ---------------------------------------------------------------------------
// 6 — schema migration 17 -> 18
// ---------------------------------------------------------------------------

describe("schema migration 17 -> 18", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "est-unit-migrate18-"));
    db = openDb({ path: join(dir, "estimator.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a v17 database migrates to exactly the shape schema.sql builds", () => {
    db.exec(`
      DROP TRIGGER spa_ro_u;
      DROP TRIGGER spa_ro_d;
      DROP TABLE sp_anchor;
      UPDATE config SET v = '17' WHERE k = 'schema_version';
    `);
    // Migration rule 2: a value Craig has already tuned survives untouched.
    db.query("UPDATE config SET v='999' WHERE k='shrink_k'").run();
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='shrink_k'").get()?.v).toBe("999");

    const freshDir = mkdtempSync(join(tmpdir(), "est-unit-fresh18-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const objects = (d: Database): unknown =>
        d
          .query<{ type: string; name: string; sql: string | null }, []>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      // The whole `sqlite_master` row, `sql` text included — SQLite strips
      // `IF NOT EXISTS` before storing, so the step's idempotence guard costs nothing in
      // fidelity and this stays an EXACT comparison.
      expect(objects(db)).toEqual(objects(fresh));
      // ...and the seeded row is the same row, not merely the same shape.
      const anchor = (d: Database): unknown =>
        d.query<unknown, []>("SELECT id, text, created_at FROM sp_anchor ORDER BY id").all();
      expect(anchor(db)).toEqual(anchor(fresh));
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("the step is idempotent against a file that already has the shape", () => {
    const path = join(dir, "estimator.db");
    db.query("UPDATE config SET v = '17' WHERE k = 'schema_version'").run();
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sp_anchor").get()!.n).toBe(1);
    expect(anchorTextOf(db, "v1")).toBe(V1_TEXT);
  });

  test("the seed comes from the database's own config, not from schema.sql's default", () => {
    // A live v17 database has whatever `sp_anchor_text` Craig set. Stamping the shipped
    // default over it would be asserting a definition nobody wrote — and would silently
    // redenominate every band already issued.
    db.exec(`
      DROP TRIGGER spa_ro_u;
      DROP TRIGGER spa_ro_d;
      DROP TABLE sp_anchor;
      UPDATE config SET v = 'v3'                    WHERE k = 'sp_anchor_id';
      UPDATE config SET v = 'the definition in use' WHERE k = 'sp_anchor_text';
      UPDATE config SET v = '17'                    WHERE k = 'schema_version';
    `);
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(anchorTextOf(db, "v3")).toBe("the definition in use");
    // And only that one: an id nobody was using does not acquire a definition.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sp_anchor").get()!.n).toBe(1);
  });
});

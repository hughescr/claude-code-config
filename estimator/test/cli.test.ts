/**
 * src/cli.ts — argument parsing and the Phase 0 verbs (§8).
 *
 * Everything here runs against a throwaway database and, where a corpus is
 * needed, against `test/fixtures/corpus` — never the real one. `run()` is driven
 * directly rather than through a subprocess so exit codes and captured output are
 * both assertable, and `--db` / `--lock` / `--root` keep every case isolated.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BENIGN_ANOMALY_KINDS,
  COMMAND_FLAGS,
  HELP,
  insertAnomalies,
  isConstraintError,
  parseArgs,
  parseDuration,
  renderTable,
  run,
  runSweep,
  spendByModel,
  spendByOrigin,
  unpricedSummary,
} from "../src/cli.ts";
import { openDb, SCHEMA_VERSION } from "../src/db.ts";

const FIXTURE_CORPUS = join(import.meta.dir, "fixtures", "corpus", "projects");

let dir: string;
let dbPath: string;
let lockPath: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "est-cli-"));
  dbPath = join(dir, "estimator.db");
  lockPath = join(dir, "sweep.lock");
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const io = () => ({ out: (s: string) => stdout.push(s), err: (s: string) => stderr.push(s) });
const outText = (): string => stdout.join("\n");
const errText = (): string => stderr.join("\n");

/** Base flags every command in this file needs to stay off the real machine state. */
const base = (): string[] => ["--db", dbPath, "--lock", lockPath];
const sweepArgs = (...extra: string[]): string[] => [...base(), "--root", FIXTURE_CORPUS, ...extra];

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("recognises each command with no flags", () => {
    for (const cmd of Object.keys(COMMAND_FLAGS)) {
      const p = parseArgs([cmd]);
      expect(p.command).toBe(cmd as never);
      expect(p.errors).toEqual([]);
    }
  });

  test("an unknown command is an error, not a silent no-op", () => {
    // Deliberately a word that is NOT a verb and is not scheduled to become one.
    // `retro` used to stand here and became real in Phase 1, which is the failure
    // mode this comment exists to prevent: a negative-case test whose subject the
    // roadmap later implements starts asserting the opposite of what it means.
    const p = parseArgs(["reticulate"]);
    expect(p.command).toBeNull();
    expect(p.errors).toEqual(["unknown command: reticulate"]);
  });

  test("value flags accept both --x v and --x=v", () => {
    expect(parseArgs(["sweep", "--budget", "20s"]).flags.budget).toBe("20s");
    expect(parseArgs(["sweep", "--budget=20s"]).flags.budget).toBe("20s");
  });

  test("a value flag with no value is an error rather than swallowing the next flag", () => {
    const p = parseArgs(["sweep", "--budget", "--blocking"]);
    expect(p.errors).toEqual(["--budget requires a value"]);
    expect(p.flags.blocking).toBe(true);
  });

  test("flags may precede the command", () => {
    const p = parseArgs(["--db", "/tmp/x.db", "sweep", "--blocking"]);
    expect(p.command).toBe("sweep");
    expect(p.flags.db).toBe("/tmp/x.db");
    expect(p.flags.blocking).toBe(true);
    expect(p.errors).toEqual([]);
  });

  test("booleans: --x, --x=false, --no-x", () => {
    expect(parseArgs(["sweep", "--blocking"]).flags.blocking).toBe(true);
    expect(parseArgs(["sweep", "--blocking=false"]).flags.blocking).toBe(false);
    expect(parseArgs(["sweep", "--no-blocking"]).flags.blocking).toBe(false);
  });

  test("short aliases, including bundles", () => {
    expect(parseArgs(["init", "-q"]).flags.quiet).toBe(true);
    const p = parseArgs(["init", "-qh"]);
    expect(p.flags.quiet).toBe(true);
    expect(p.flags.help).toBe(true);
  });

  test("unknown flags are reported", () => {
    expect(parseArgs(["sweep", "--turbo"]).errors).toEqual(["unknown flag: --turbo"]);
    expect(parseArgs(["sweep", "-z"]).errors).toEqual(["unknown flag: -z"]);
  });

  test("a flag belonging to another command names the command it belongs to", () => {
    const p = parseArgs(["init", "--budget", "20s"]);
    expect(p.errors).toEqual(["--budget is not valid for `est init`"]);
  });

  test("global flags are valid on every command", () => {
    for (const cmd of ["init", "sweep", "backfill", "prices", "census"]) {
      const p = parseArgs([cmd, "--db", "/tmp/x.db", "--lock", "/tmp/x.lock", "--json", "-q"]);
      expect(p.errors).toEqual([]);
    }
  });

  test("`--` ends flag parsing", () => {
    const p = parseArgs(["census", "--", "--budget", "x"]);
    expect(p.positionals).toEqual(["--budget", "x"]);
    expect(p.errors).toEqual([]);
  });

  test("no command at all parses cleanly (run() prints help and exits 1)", () => {
    const p = parseArgs([]);
    expect(p.command).toBeNull();
    expect(p.errors).toEqual([]);
  });
});

describe("parseDuration", () => {
  test("units", () => {
    expect(parseDuration("20s")).toBe(20_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });
  test("a bare number is seconds — the unit a hook line most likely means", () => {
    expect(parseDuration("20")).toBe(20_000);
  });
  test("garbage is null, never a silent zero budget", () => {
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("20 s")).toBeNull();
    expect(parseDuration("-5s")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("renderTable", () => {
  test("labels left, numbers right, no trailing whitespace", () => {
    const t = renderTable(["k", "n"], [["a", "1"], ["bb", "22"]]);
    expect(t.split("\n")).toEqual(["k    n", "--  --", "a    1", "bb  22"]);
    for (const line of t.split("\n")) expect(line).toBe(line.trimEnd());
  });
});

// ---------------------------------------------------------------------------
// est init
// ---------------------------------------------------------------------------

describe("est init", () => {
  test("creates the database in a fresh directory and reports the schema version", async () => {
    const code = await run(["init", ...base()], io());
    expect(code).toBe(0);
    // Pinned to the code's own constant, not a literal: the version is bumped
    // whenever schema.sql changes shape, and a literal here just makes every such
    // change look like a regression in a test that is not about versions at all.
    expect(outText()).toContain(`schema_version ${SCHEMA_VERSION}`);

    const db = new Database(dbPath, { readonly: true });
    const v = db
      .query<{ v: string }, []>("SELECT v FROM config WHERE k='schema_version'")
      .get();
    expect(v?.v).toBe(SCHEMA_VERSION);
    db.close();
  });

  test("is idempotent — a second init neither fails nor changes anything", async () => {
    expect(await run(["init", ...base()], io())).toBe(0);
    const first = new Database(dbPath, { readonly: true });
    const before = first.query<{ n: number }, []>("SELECT COUNT(*) n FROM config").get()!.n;
    first.close();

    expect(await run(["init", ...base()], io())).toBe(0);
    const second = new Database(dbPath, { readonly: true });
    expect(second.query<{ n: number }, []>("SELECT COUNT(*) n FROM config").get()!.n).toBe(before);
    second.close();
  });

  test("--json emits parseable output; --quiet emits nothing", async () => {
    expect(await run(["init", ...base(), "--json"], io())).toBe(0);
    const parsed = JSON.parse(outText()) as { db: string; schema_version: string };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.db).toBe(dbPath);

    stdout = [];
    expect(await run(["init", ...base(), "--quiet"], io())).toBe(0);
    expect(outText()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// est sweep
// ---------------------------------------------------------------------------

describe("est sweep", () => {
  test("ingests the fixture corpus and records a census row", async () => {
    await run(["init", ...base(), "-q"], io());
    const code = await run(["sweep", ...sweepArgs(), "--json"], io());
    // Exit 3: the fixture corpus deliberately contains a wf_record_mismatch.
    expect([0, 3]).toContain(code);

    const report = JSON.parse(outText()) as {
      sessions: { total: number; ingested: number };
      rows: { requests: number; turns: number; agent_runs: number; task_events: number };
      vanished: { total: number };
    };
    expect(report.sessions.total).toBe(1);
    expect(report.sessions.ingested).toBe(1);
    expect(report.rows.requests).toBeGreaterThan(0);
    expect(report.rows.agent_runs).toBe(3);
    // One TaskCreate + one TaskUpdate statusChange — both are `task_event` rows.
    expect(report.rows.task_events).toBe(2);
    expect(report.vanished.total).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sweep_census").get()!.n).toBe(1);
    expect(
      db
        .query<{ kind: string; n: number }, []>(
          "SELECT kind, COUNT(*) AS n FROM task_event GROUP BY kind ORDER BY kind",
        )
        .all(),
    ).toEqual([
      { kind: "create", n: 1 },
      { kind: "status", n: 1 },
    ]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request").get()!.n).toBeGreaterThan(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sweep_state").get()!.n).toBe(5);
    db.close();
  });

  test("a re-sweep is a no-op: no sessions ingested, no new rows, no duplicate anomalies", async () => {
    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...sweepArgs(), "-q"], io());

    const db = new Database(dbPath, { readonly: true });
    const snapshot = () =>
      db
        .query<{ requests: number; anomalies: number; agents: number }, []>(
          `SELECT (SELECT COUNT(*) FROM request) requests,
                  (SELECT COUNT(*) FROM anomaly) anomalies,
                  (SELECT COUNT(*) FROM agent_run) agents`,
        )
        .get()!;
    const before = snapshot();
    db.close();

    stdout = [];
    const code = await run(["sweep", ...sweepArgs(), "--json"], io());
    const report = JSON.parse(outText()) as {
      sessions: { ingested: number; skipped: number };
      anomalies: { recorded: number };
    };
    expect(report.sessions.ingested).toBe(0);
    expect(report.sessions.skipped).toBe(1);
    expect(report.anomalies.recorded).toBe(0);
    expect(code).toBe(0); // nothing new to alert about

    const after = new Database(dbPath, { readonly: true });
    const now = after
      .query<{ requests: number; anomalies: number; agents: number }, []>(
        `SELECT (SELECT COUNT(*) FROM request) requests,
                (SELECT COUNT(*) FROM anomaly) anomalies,
                (SELECT COUNT(*) FROM agent_run) agents`,
      )
      .get()!;
    after.close();
    expect(now).toEqual(before);
  });

  test("--full (backfill) re-reads skipped sessions and still lands on the same totals", async () => {
    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...sweepArgs(), "-q"], io());
    const db = new Database(dbPath, { readonly: true });
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request").get()!.n;
    const tokensBefore = db
      .query<{ t: number }, []>("SELECT COALESCE(SUM(out_tok+cw_tok),0) t FROM request")
      .get()!.t;
    db.close();

    stdout = [];
    await run(["backfill", ...sweepArgs(), "--json"], io());
    const report = JSON.parse(stdout[0]!) as { sessions: { ingested: number }; full: boolean };
    expect(report.full).toBe(true);
    expect(report.sessions.ingested).toBe(1);

    const after = new Database(dbPath, { readonly: true });
    expect(after.query<{ n: number }, []>("SELECT COUNT(*) n FROM request").get()!.n).toBe(before);
    expect(
      after.query<{ t: number }, []>("SELECT COALESCE(SUM(out_tok+cw_tok),0) t FROM request").get()!.t,
    ).toBe(tokensBefore);
    after.close();
  });

  test("a bad --budget is a usage error, never a silently zero budget", async () => {
    await run(["init", ...base(), "-q"], io());
    const code = await run(["sweep", ...sweepArgs(), "--budget", "soon"], io());
    expect(code).toBe(1);
    expect(errText()).toContain("cannot parse duration");
  });

  test("an exhausted budget commits what it has and logs sweep_budget_exceeded", async () => {
    await run(["init", ...base(), "-q"], io());
    const db = openDb({ path: dbPath });
    // -1 ms is deterministically "already over budget" at the first check; a
    // 0 or 1 ms budget would race the (very fast) fixture discovery.
    const report = await runSweep(db, { root: FIXTURE_CORPUS, budgetMs: -1 });
    expect(report.budget_exceeded).toBe(true);
    expect(report.sessions.ingested).toBe(0);
    const kinds = db
      .query<{ kind: string }, []>("SELECT kind FROM anomaly")
      .all()
      .map((r) => r.kind);
    expect(kinds).toContain("sweep_budget_exceeded");
    // The census row is still written: discovery completed, only ingest was cut.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sweep_census").get()!.n).toBe(1);
    db.close();
  });

  test("exit 4 when another live writer holds the lock, and nothing is written", async () => {
    await run(["init", ...base(), "-q"], io());
    // A lock owned by THIS process on THIS host is unambiguously live, so the
    // staleness logic cannot steal it.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: "test",
        acquiredAt: new Date().toISOString(),
      }),
    );

    const code = await run(["sweep", ...sweepArgs()], io());
    expect(code).toBe(4);
    expect(errText()).toContain("sweep lock");

    const db = new Database(dbPath, { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sweep_census").get()!.n).toBe(0);
    db.close();
  });

  test("a sweep that never gets the lock does not MIGRATE either (§2 invariant 1)", async () => {
    // The subtle half of "nothing is written": `openDb()` applies pending migrations
    // the moment it sees a stale `schema_version`, and a migration is not a benign
    // write — the 5 -> 6 step DROPs and rebuilds `task_alias` and `refclass`. With the
    // connection opened before the lock, THIS command — which reports the lock is held
    // and returns 4 — still rewrote the schema underneath the process that holds it.
    await run(["init", ...base(), "-q"], io());
    const seed = new Database(dbPath);
    seed.query("UPDATE config SET v='5' WHERE k='schema_version'").run();
    seed.close();

    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: "test",
        acquiredAt: new Date().toISOString(),
      }),
    );

    expect(await run(["sweep", ...sweepArgs()], io())).toBe(4);

    const db = new Database(dbPath, { readonly: true });
    expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='schema_version'").get()!.v).toBe("5");
    db.close();
  });

  test("a writing verb that cannot take the lock opens no writable connection at all", async () => {
    // The general form of the test above, and the one that does not depend on which
    // migrations happen to exist: an absent database is not created. `openDb()` opens
    // with `create: true` and applies schema.sql, so a file appearing here would mean a
    // writable connection was opened outside the lock.
    const untouched = join(dir, "never-created.db");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: "test",
        acquiredAt: new Date().toISOString(),
      }),
    );

    const code = await run(["sweep", "--db", untouched, "--lock", lockPath, "--root", FIXTURE_CORPUS], io());
    expect(code).toBe(4);
    expect(await Bun.file(untouched).exists()).toBe(false);
  });

  test("a driver constraint failure is classified as a REJECTION, not a transient error", async () => {
    // The exit-2 backstop in `verb()`: five tables carry `RAISE(ABORT,'append-only')`
    // and several more carry unique keys, so a refusal can arrive from the driver
    // rather than from one of our own typed guards. Printing it as exit 1 would invite
    // the retry that P1.12 exists to forbid, so the classifier is pinned against a
    // REAL SQLite error rather than a hand-written string.
    const db = openDb({ path: dbPath });
    let unique: unknown;
    try {
      db.query("INSERT INTO config (k, v) VALUES ('ref_model', 'x')").run();
    } catch (e) {
      unique = e;
    } finally {
      db.close();
    }
    expect(unique).toBeInstanceOf(Error);
    expect(isConstraintError(unique)).toBe(true);
    // The append-only triggers raise by message, so both shapes have to be recognised.
    expect(isConstraintError(new Error("constraint failed: append-only"))).toBe(true);
    // And nothing else may be: a read error must stay exit 1.
    expect(isConstraintError(new Error("unable to open database file"))).toBe(false);
    expect(isConstraintError("not even an error")).toBe(false);
  });

  test("a vanished transcript raises corpus_shrink and drops its sweep_state row (§5.8)", async () => {
    const corpus = join(dir, "corpus");
    cpSync(join(import.meta.dir, "fixtures", "corpus"), corpus, { recursive: true });
    const root = join(corpus, "projects");
    const victim = join(
      root,
      "-Users-craig-demo",
      "11111111-1111-4111-8111-111111111111",
      "subagents",
      "agent-abeef0000000000a1.jsonl",
    );

    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...base(), "--root", root, "-q"], io());

    unlinkSync(victim);
    stdout = [];
    const code = await run(["sweep", ...base(), "--root", root, "--json"], io());
    const report = JSON.parse(outText()) as {
      vanished: { total: number; lt_60d: number; paths: string[] };
    };
    expect(report.vanished.total).toBe(1);
    expect(report.vanished.lt_60d).toBe(1); // seen alive seconds ago: the alarming bucket
    expect(report.vanished.paths[0]).toContain("agent-abeef0000000000a1.jsonl");
    expect(code).toBe(3); // corpus_shrink is never benign

    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) n FROM anomaly WHERE kind = ?")
        .get("corpus_shrink")!.n,
    ).toBe(1);
    expect(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM sweep_state WHERE path = ?").get(victim)!
        .n,
    ).toBe(0);
    const census = db
      .query<{ vanished_total: number }, []>(
        "SELECT vanished_total FROM sweep_census ORDER BY swept_at DESC LIMIT 1",
      )
      .get()!;
    expect(census.vanished_total).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// anomaly ledger
// ---------------------------------------------------------------------------

describe("insertAnomalies", () => {
  test("de-duplicates on (kind, detail) so a daily cron does not grow the ledger", () => {
    const db = openDb({ path: dbPath });
    const rows = [
      { kind: "corpus_shrink" as const, detail: "a" },
      { kind: "corpus_shrink" as const, detail: "a" },
      { kind: "corpus_shrink" as const, detail: "b" },
    ];
    expect(insertAnomalies(db, rows, "2026-07-28T00:00:00Z")).toHaveLength(2);
    expect(insertAnomalies(db, rows, "2026-07-29T00:00:00Z")).toHaveLength(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM anomaly").get()!.n).toBe(2);
    db.close();
  });

  test("the path is folded into the detail so two files never collapse into one entry", () => {
    const db = openDb({ path: dbPath });
    insertAnomalies(
      db,
      [
        { kind: "truncated_tail" as const, detail: "torn", path: "/a.jsonl" },
        { kind: "truncated_tail" as const, detail: "torn", path: "/b.jsonl" },
      ],
      "2026-07-28T00:00:00Z",
    );
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM anomaly").get()!.n).toBe(2);
    db.close();
  });

  test("expected-against-a-live-corpus kinds are classified benign, everything else is not", () => {
    expect(BENIGN_ANOMALY_KINDS.has("truncated_tail")).toBe(true);
    expect(BENIGN_ANOMALY_KINDS.has("unpriced_model")).toBe(true);
    // The fork shapes: what a corpus of forked sessions LOOKS like, not damage.
    // The live tree carries ~46 of them, so alerting would exit 3 on the first
    // backfill and once per fork forever after.
    expect(BENIGN_ANOMALY_KINDS.has("compaction_continuation")).toBe(true);
    expect(BENIGN_ANOMALY_KINDS.has("symlink_alias")).toBe(true);
    expect(BENIGN_ANOMALY_KINDS.has("fork_replay")).toBe(true);
    expect(BENIGN_ANOMALY_KINDS.has("corpus_shrink")).toBe(false);
    expect(BENIGN_ANOMALY_KINDS.has("rid_collision")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// est prices / est backfill's spend report
// ---------------------------------------------------------------------------

describe("est prices", () => {
  test("with no sub-flag it refuses rather than doing something surprising", async () => {
    await run(["init", ...base(), "-q"], io());
    expect(await run(["prices", ...base()], io())).toBe(1);
    expect(errText()).toContain("nothing to do");
  });

  test("--sync --source fixture populates model_price and reports its legs", async () => {
    await run(["init", ...base(), "-q"], io());
    const code = await run(["prices", ...base(), "--sync", "--source", "fixture"], io());
    expect(code).toBe(0);
    expect(outText()).toContain("price sync ok");

    const db = new Database(dbPath, { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM model_price").get()!.n).toBeGreaterThan(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM price_sync").get()!.n).toBe(1);
    db.close();
  });

  test("--set requires all four rates", async () => {
    await run(["init", ...base(), "-q"], io());
    expect(await run(["prices", ...base(), "--set", "claude-x-1", "--in", "1"], io())).toBe(1);
    expect(errText()).toContain("all four rates");
  });

  test("--set writes a manual price that --show reads back", async () => {
    await run(["init", ...base(), "-q"], io());
    const code = await run(
      [
        "prices",
        ...base(),
        "--set",
        "claude-x-1-20260101",
        "--in",
        "1",
        "--out",
        "5",
        "--cw",
        "1.25",
        "--cr",
        "0.1",
        "--show",
      ],
      io(),
    );
    expect(code).toBe(0);
    expect(outText()).toContain("claude-x-1"); // the -YYYYMMDD alias collapsed to the family
    expect(outText()).toContain("manual");
  });
});

describe("est backfill — spend report", () => {
  test("per-model and per-origin tables, with unpriced families counted separately", async () => {
    await run(["init", ...base(), "-q"], io());
    await run(["prices", ...base(), "--sync", "--source", "fixture", "-q"], io());
    stdout = [];
    await run(["backfill", ...sweepArgs()], io());

    const text = outText();
    expect(text).toContain("Work-CET / Spend-CET by model");
    expect(text).toContain("Work-CET / Spend-CET by origin");
    expect(text).toContain("TOTAL");
    expect(text).toContain("subagent");

    const db = new Database(dbPath, { readonly: true });
    const models = spendByModel(db);
    const origins = spendByOrigin(db);
    expect(models.length).toBeGreaterThan(0);
    // Same underlying rows, two groupings: the totals must agree exactly.
    const sum = (rows: { wcet: number }[]) => rows.reduce((a, r) => a + r.wcet, 0);
    expect(sum(models)).toBe(sum(origins));
    expect(origins.map((o) => o.key).sort()).toEqual(["main", "subagent"]);
    for (const m of models) expect(m.scet).toBeGreaterThanOrEqual(m.wcet);

    // The fixture corpus contains claude-opus-5[1m], whose bracketed family cannot
    // join model_price — the report must SAY so, not quietly omit it (§4.3).
    const unpriced = unpricedSummary(db);
    expect(unpriced.n_req).toBeGreaterThan(0);
    expect(unpriced.families.some((f) => f.includes("["))).toBe(true);
    expect(text).toContain("unpriced:");
    expect(text).toContain("context suffix");
    db.close();
  });

  test("requests older than their family's first price row are counted, not silently dropped", async () => {
    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...sweepArgs(), "-q"], io());
    // Price a family the fixture corpus uses, but only from a date AFTER its
    // requests: v_priced's `effective_from <= ts` join drops them and v_unpriced
    // (which only checks family membership) never sees them.
    const db = openDb({ path: dbPath });
    const family = db
      .query<{ model_family: string }, []>("SELECT model_family FROM request LIMIT 1")
      .get()!.model_family;
    db.query(
      `INSERT INTO model_price (family, effective_from, usd_in, usd_out, usd_cw, usd_cr,
                                provisional, source, synced_epoch, ingested_at)
       VALUES (?, '2099-01-01T00:00:00Z', 1, 1, 1, 1, 0, 'manual', NULL, '2099-01-01T00:00:00Z')`,
    ).run(family);

    const summary = unpricedSummary(db);
    expect(summary.n_pre_epoch).toBeGreaterThan(0);
    expect(summary.families).not.toContain(family); // invisible to v_unpriced
    db.close();

    stdout = [];
    await run(["backfill", ...sweepArgs()], io());
    expect(outText()).toContain("pre-epoch:");

    const after = new Database(dbPath, { readonly: true });
    const details = after
      .query<{ detail: string }, [string]>("SELECT detail FROM anomaly WHERE kind = ?")
      .all("unpriced_model")
      .map((r) => r.detail);
    expect(details.some((d) => d.includes("predate the earliest effective_from"))).toBe(true);
    after.close();
  });

  test("unpriced families raise anomaly(unpriced_model) even when prices synced cleanly", async () => {
    await run(["init", ...base(), "-q"], io());
    await run(["prices", ...base(), "--sync", "--source", "fixture", "-q"], io());
    await run(["backfill", ...sweepArgs(), "-q"], io());

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<{ detail: string }, [string]>("SELECT detail FROM anomaly WHERE kind = ?")
      .all("unpriced_model");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.detail.includes("claude-opus-5[1m]"))).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// est census / help
// ---------------------------------------------------------------------------

describe("est census", () => {
  test("reports live corpus counts, db row counts and the census history", async () => {
    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...sweepArgs(), "-q"], io());
    stdout = [];
    const code = await run(["census", ...base(), "--root", FIXTURE_CORPUS, "--json"], io());
    expect(code).toBe(0);

    const parsed = JSON.parse(outText()) as {
      live: { files: number; sessions: number };
      db: { request: number; sweep_state: number };
      history: { vanished_total: number }[];
    };
    expect(parsed.live.files).toBe(5);
    expect(parsed.live.sessions).toBe(1);
    expect(parsed.db.request).toBeGreaterThan(0);
    expect(parsed.db.sweep_state).toBe(5);
    expect(parsed.history).toHaveLength(1);
    expect(parsed.history[0]!.vanished_total).toBe(0);
  });

  test("human output is readable before any sweep has run", async () => {
    await run(["init", ...base(), "-q"], io());
    stdout = [];
    expect(await run(["census", ...base(), "--root", FIXTURE_CORPUS], io())).toBe(0);
    expect(outText()).toContain("no sweeps recorded yet");
  });

  test("census never writes — it opens the database read-only", async () => {
    // No init: a read-only open of a missing database must fail loudly, not
    // create one as a side effect of asking a question.
    const code = await run(["census", ...base(), "--root", FIXTURE_CORPUS], io());
    expect(code).toBe(1);
    expect(errText().length).toBeGreaterThan(0);
  });
});

describe("est config", () => {
  test("lists every seeded key, and `get` prints the bare value", async () => {
    await run(["init", ...base(), "-q"], io());
    stdout = [];
    expect(await run(["config", ...base(), "--json"], io())).toBe(0);
    const listed = (JSON.parse(outText()) as { config: Record<string, string> }).config;
    expect(listed.attr_stale_turns).toBe("5");
    expect(listed.attr_stale_minutes).toBe("120");
    expect(listed.shrink_k).toBe("10");

    stdout = [];
    expect(await run(["config", "get", "attr_stale_turns", ...base()], io())).toBe(0);
    expect(outText()).toBe("5");
  });

  test("`set` tunes a seeded key and the next read sees the new value", async () => {
    // The whole point of the verb: schema.sql tells the reader the retro tunes
    // `attr_stale_turns`, and this is the write path that claim depends on.
    await run(["init", ...base(), "-q"], io());
    stdout = [];
    expect(await run(["config", "set", "attr_stale_turns", "7", ...base()], io())).toBe(0);
    expect(outText()).toContain("5 → 7");

    stdout = [];
    expect(await run(["config", "get", "attr_stale_turns", ...base(), "--json"], io())).toBe(0);
    expect(JSON.parse(outText())).toMatchObject({ key: "attr_stale_turns", value: "7" });

    const db = openDb({ path: dbPath, readonly: true });
    expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='attr_stale_turns'").get()!.v).toBe("7");
    db.close();
  });

  test("`list` is a synonym for the bare form, not an unknown subcommand", async () => {
    // P2.0 spells the surface `est config list [--json]`; the bare form shipped first
    // and both have to work, because the documented invocation is the one a script
    // written against the spec will use.
    await run(["init", ...base(), "-q"], io());
    stdout = [];
    expect(await run(["config", "list", ...base(), "--json"], io())).toBe(0);
    const listed = (JSON.parse(outText()) as { config: Record<string, string> }).config;
    expect(listed.shrink_k).toBe("10");
  });

  test("an unseeded key exits 2 (closed key set), not 1 (bad command line)", async () => {
    // The two codes carry different information and a script needs both: 2 says the
    // KEY was rejected by the closed set, 1 says the COMMAND LINE was malformed.
    // Collapsing them makes a typo'd key indistinguishable from a missing argument.
    await run(["init", ...base(), "-q"], io());
    expect(await run(["config", "set", "attr_stale_turnz", "7", ...base()], io())).toBe(2);
    expect(errText()).toContain("unknown key");
    const db = openDb({ path: dbPath, readonly: true });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM config WHERE k LIKE 'attr_stale_turn%'").get()!.n).toBe(1);
    db.close();
  });

  test("schema_version is migration state and is REJECTED with the remedy", async () => {
    await run(["init", ...base(), "-q"], io());
    expect(await run(["config", "set", "schema_version", "99", ...base()], io())).toBe(2);
    expect(errText()).toContain("REJECTED");
    expect(errText()).toContain("est init");
    const db = openDb({ path: dbPath, readonly: true });
    expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='schema_version'").get()!.v).toBe(
      String(SCHEMA_VERSION),
    );
    db.close();
  });

  test("`get` of an unknown key exits 2; an unknown subcommand exits 1", async () => {
    await run(["init", ...base(), "-q"], io());
    expect(await run(["config", "get", "nope", ...base()], io())).toBe(2);
    expect(errText()).toContain("unknown key: nope");
    stderr = [];
    expect(await run(["config", "frob", ...base()], io())).toBe(1);
    expect(errText()).toContain("unknown subcommand");
    stderr = [];
    // A missing argument is a command-line error, so it stays 1 even though the
    // neighbouring key failures are now 2.
    expect(await run(["config", "set", "shrink_k", ...base()], io())).toBe(1);
    expect(errText()).toContain("missing <value>");
  });

  test("listing and `get` never create a database — they open read-only", async () => {
    expect(await run(["config", ...base()], io())).toBe(1);
    expect(errText().length).toBeGreaterThan(0);
  });
});

describe("run()", () => {
  test("no command prints help and exits 1; `help` exits 0", async () => {
    expect(await run([], io())).toBe(1);
    expect(outText()).toBe(HELP);
    stdout = [];
    expect(await run(["help"], io())).toBe(0);
    stdout = [];
    expect(await run(["sweep", "--help"], io())).toBe(0);
    expect(outText()).toBe(HELP);
  });

  test("a parse error exits 1 and explains itself before touching any database", async () => {
    const code = await run(["sweep", "--turbo", ...base()], io());
    expect(code).toBe(1);
    expect(errText()).toContain("unknown flag: --turbo");
    expect(errText()).toContain("est help");
  });

  test("--version", async () => {
    expect(await run(["version"], io())).toBe(0);
    expect(outText()).toContain("est 0.1.0");
  });

  test("a fatal error is reported, never swallowed into a zero exit", async () => {
    // A file that is not a database at all.
    writeFileSync(dbPath, "not a database");
    const code = await run(["init", "--db", dbPath, "--lock", lockPath], io());
    expect(code).toBe(1);
    expect(errText()).toContain("est:");
  });
});

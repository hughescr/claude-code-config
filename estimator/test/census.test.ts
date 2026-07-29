/**
 * src/census.ts — the §5.8 vanish-detector fix.
 *
 * ROOT CAUSE, demonstrated: the pre-fix sweep (`runSweep`'s D1, src/cli.ts) diffs
 * `sweep_state` — paths this database has already watermarked — against what
 * discovery finds today. A main transcript deleted BEFORE it was ever watermarked
 * leaves no `sweep_state` row to diff against, so `vanished.total` stayed 0
 * forever for exactly that loss. The mandated regression (T1 below) reproduces
 * the live shape byte for byte: after one real sweep watermarks everything, the
 * main transcript's OWN watermark is scrubbed (simulating "gone before this
 * database ever saw it") while its sub-agent transcript's watermark survives —
 * which is precisely what the live corpus looked like for 9 sessions across 35
 * sweeps that all reported `vanished_total = 0`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, BENIGN_ANOMALY_KINDS } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { discoverCorpus } from "../src/discover.ts";
import {
  ageDaysFrom,
  checkCensusCollapse,
  classifyPathKind,
  isExpected,
  readCensusConfig,
  runCorpusLossProbe,
  type CensusConfig,
} from "../src/census.ts";

const FIXTURE_CORPUS = join(import.meta.dir, "fixtures", "corpus", "projects");
const SESSION = "11111111-1111-4111-8111-111111111111";

let dir: string;
let dbPath: string;
let lockPath: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "est-census-"));
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
const base = (): string[] => ["--db", dbPath, "--lock", lockPath];

/** A private copy of the fixture corpus this test file is free to mutate. */
function copyCorpus(): { root: string; main: string } {
  const corpusDir = join(dir, "corpus");
  cpSync(join(import.meta.dir, "fixtures", "corpus"), corpusDir, { recursive: true });
  const root = join(corpusDir, "projects");
  const main = join(root, "-Users-craig-demo", `${SESSION}.jsonl`);
  return { root, main };
}

// ---------------------------------------------------------------------------
// T1 — THE MANDATED REGRESSION: a loss D1 structurally cannot see
// ---------------------------------------------------------------------------

describe("D2 — the discovery-side probe closes D1's blind spot (§5.8)", () => {
  test("a main transcript gone with NO watermark drives vanished.total positive on the very next sweep", async () => {
    const { root, main } = copyCorpus();
    const realMain = realpathSync(main);

    await run(["init", ...base(), "-q"], io());
    // Sweep #1: everything present, everything watermarked (including `main`).
    await run(["sweep", ...base(), "--root", root, "-q"], io());

    const preDb = new Database(dbPath, { readonly: true });
    expect(
      preDb.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM sweep_state WHERE path = ?").get(realMain)!
        .n,
    ).toBe(1);
    preDb.close();

    // Reproduce the live shape exactly: the sub-agent transcript stays present AND
    // watermarked; the main transcript is deleted from disk AND its watermark row
    // is scrubbed — "as if this database had never read it", which is the actual
    // pre-fix failure mode (a path deleted before its first sweep is unrepresentable
    // to a diff over `sweep_state`, not merely unreported by one).
    unlinkSync(main);
    const scrub = new Database(dbPath);
    scrub.query("DELETE FROM sweep_state WHERE path = ?").run(realMain);
    scrub.close();

    stdout = [];
    const code = await run(["sweep", ...base(), "--root", root, "--json"], io());
    const report = JSON.parse(outText()) as {
      vanished: { total: number; lt_60d: number; sessions_lost: string[]; expected: number; paths: string[] };
    };

    // THE ASSERTION THAT FAILS PRE-FIX: D1 alone has no `sweep_state` row for
    // `realMain` to diff against (it was just deleted), so `report.vanished.total`
    // would be 0 without D2. With D2 wired in, the session's missing main is
    // caught from the DISCOVERY side instead.
    expect(report.vanished.total).toBeGreaterThanOrEqual(1);
    expect(report.vanished.sessions_lost).toContain(SESSION);
    expect(report.vanished.lt_60d).toBeGreaterThanOrEqual(1); // just lost: the alarming bucket
    expect(code).toBe(3); // corpus_shrink is never benign

    const db = new Database(dbPath, { readonly: true });
    expect(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM anomaly WHERE kind = ?").get("corpus_shrink")!
        .n,
    ).toBe(1);
    const loss = db
      .query<{ detected_by: string; kind: string; expected: number }, [string]>(
        "SELECT detected_by, kind, expected FROM corpus_loss WHERE session_id = ?",
      )
      .get(SESSION);
    expect(loss).toEqual({ detected_by: "discovery_probe", kind: "main", expected: 0 });
    const census = db
      .query<{ vanished_total: number }, []>(
        "SELECT vanished_total FROM sweep_census ORDER BY swept_at DESC LIMIT 1",
      )
      .get()!;
    expect(census.vanished_total).toBeGreaterThanOrEqual(1);
    db.close();
  });

  // ---------------------------------------------------------------------------
  // T2 — idempotence: the second sweep after a loss adds nothing new
  // ---------------------------------------------------------------------------
  test("a THIRD sweep (one after the loss was already recorded) reports zero new loss", async () => {
    const { root, main } = copyCorpus();
    const realMain = realpathSync(main);

    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...base(), "--root", root, "-q"], io());
    unlinkSync(main);
    const scrub = new Database(dbPath);
    scrub.query("DELETE FROM sweep_state WHERE path = ?").run(realMain);
    scrub.close();
    await run(["sweep", ...base(), "--root", root, "-q"], io()); // sweep #2: records the loss

    const before = new Database(dbPath, { readonly: true });
    const lossCountBefore = before.query<{ n: number }, []>("SELECT COUNT(*) n FROM corpus_loss").get()!.n;
    const anomalyCountBefore = before
      .query<{ n: number }, [string]>("SELECT COUNT(*) n FROM anomaly WHERE kind = ?")
      .get("corpus_shrink")!.n;
    before.close();
    expect(lossCountBefore).toBeGreaterThanOrEqual(1);
    expect(anomalyCountBefore).toBe(1);

    stdout = [];
    const code = await run(["sweep", ...base(), "--root", root, "--json"], io()); // sweep #3
    const report = JSON.parse(outText()) as { vanished: { total: number } };
    expect(report.vanished.total).toBe(0); // nothing NEW vanished this sweep
    expect(code).toBe(0);

    const after = new Database(dbPath, { readonly: true });
    expect(after.query<{ n: number }, []>("SELECT COUNT(*) n FROM corpus_loss").get()!.n).toBe(
      lossCountBefore,
    ); // no duplicate row
    expect(
      after.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM anomaly WHERE kind = ?").get("corpus_shrink")!
        .n,
    ).toBe(anomalyCountBefore); // no duplicate anomaly ((kind, detail) dedup held)
    after.close();
  });

  // ---------------------------------------------------------------------------
  // T5-style — no false positives on an intact corpus
  // ---------------------------------------------------------------------------
  test("a sweep over a corpus where every session has its main transcript writes zero corpus_loss rows", async () => {
    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...base(), "--root", FIXTURE_CORPUS, "-q"], io());
    const db = new Database(dbPath, { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM corpus_loss").get()!.n).toBe(0);
    db.close();
  });

  // ---------------------------------------------------------------------------
  // Collapse guard — first sweep of a genuinely empty root is not a "collapse"
  // ---------------------------------------------------------------------------
  test("the FIRST sweep of an empty root is not a census_collapse (nothing to have dropped from)", async () => {
    const emptyRoot = join(dir, "empty-projects");
    await run(["init", ...base(), "-q"], io());
    const code = await run(["sweep", ...base(), "--root", emptyRoot, "-q"], io());
    expect(code).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM anomaly WHERE kind = ?").get("census_collapse")!
        .n,
    ).toBe(0);
    db.close();
  });

  test("a REAL collapse (sessions -> zero after a real prior sweep) raises census_collapse and skips D2", async () => {
    const { root } = copyCorpus();
    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...base(), "--root", root, "-q"], io()); // real sweep: 1 session recorded

    const emptyRoot = join(dir, "now-empty");
    stdout = [];
    const code = await run(["sweep", ...base(), "--root", emptyRoot, "--json"], io());
    expect(code).toBe(3);
    const report = JSON.parse(outText()) as { vanished: { total: number } };
    // The collapse guard skips D2 entirely, so this must NOT read as N durable losses.
    expect(report.vanished.total).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM anomaly WHERE kind = ?").get("census_collapse")!
        .n,
    ).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM corpus_loss").get()!.n).toBe(0);
    db.close();
  });

  /**
   * The test above cannot see the half of the guard that mattered: it sweeps a
   * DIFFERENT root, so the `row.path.startsWith(prefix)` filter empties D1 by
   * construction and D1 is never exercised at all.
   *
   * This is the real outage shape — `--root` still present, its contents gone (an
   * unmounted volume, a bad `EST_PROJECTS`, a project subtree moved aside). Pre-fix
   * the guard ran inside `runCorpusLossProbe`, which is called AFTER
   * `writeCorpusLoss(db, d1Losses)`, so the outage was laundered into one durable
   * `watermark_diff` row per watermarked path — irretrievably, since retraction only
   * covered `discovery_probe` — and then every `sweep_state` row was DELETEd, so the
   * recovery sweep had to re-read the whole corpus.
   */
  test("a discovery OUTAGE persists no D1 loss and drops no watermark", async () => {
    const { root } = copyCorpus();
    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...base(), "--root", root, "-q"], io());

    const pre = new Database(dbPath, { readonly: true });
    const watermarks = pre.query<{ n: number }, []>("SELECT COUNT(*) n FROM sweep_state").get()!.n;
    pre.close();
    expect(watermarks).toBeGreaterThan(0);

    // The root survives; everything under it goes away.
    renameSync(join(root, "-Users-craig-demo"), join(dir, "moved-aside"));

    stdout = [];
    const code = await run(["sweep", ...base(), "--root", root, "--json"], io());
    const report = JSON.parse(outText()) as {
      vanished: { total: number; lt_60d: number; expected: number };
    };
    expect(code).toBe(3); // census_collapse is alerting, and should be
    expect(report.vanished).toEqual({ ...report.vanished, total: 0, lt_60d: 0, expected: 0 });

    const db = new Database(dbPath, { readonly: true });
    expect(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM anomaly WHERE kind = ?").get("census_collapse")!
        .n,
    ).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM corpus_loss").get()!.n).toBe(0);
    // The watermarks are what keep the recovery sweep incremental.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sweep_state").get()!.n).toBe(watermarks);
    db.close();
  });

  /**
   * `UPSERT_SWEEP_STATE_SQL` names `$mtime` and the call site never bound it.
   * bun:sqlite does not throw on an unbound named parameter — it binds NULL — so
   * `sweep_state.mtime` was NULL on every row forever and D1's exact retention-age
   * split (`age_source='mtime'`) could never engage; every loss fell back to the
   * `last_swept` lower bound. Silence is exactly why this needs an assertion.
   */
  test("every watermark carries the file's own mtime", async () => {
    const { root } = copyCorpus();
    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...base(), "--root", root, "-q"], io());
    const db = new Database(dbPath, { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sweep_state").get()!.n).toBeGreaterThan(0);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sweep_state WHERE mtime IS NULL").get()!.n,
    ).toBe(0);
    db.close();
  });

  /**
   * The lifecycle `ON CONFLICT(path) DO NOTHING` could not express: lost, restored,
   * lost AGAIN. The row stayed `resolved_at`-stamped through the second, genuine
   * loss, `alreadyKnown` (built from every row, resolved included) filtered the
   * re-loss out of `newLosses`, and so the ledger reported zero open losses for a
   * file that was gone.
   *
   * It also pins the other half: a `watermark_diff` row could never be resolved at
   * all, because retraction was filtered to `detected_by='discovery_probe'` — and D1
   * rows may carry a NULL `session_id`, so a session-keyed retraction could not have
   * reached them even unfiltered.
   */
  test("a path lost, restored and lost again re-opens its loss row", async () => {
    const { root } = copyCorpus();
    const victim = join(
      root,
      "-Users-craig-demo",
      SESSION,
      "subagents",
      "agent-abeef0000000000a1.jsonl",
    );
    const contents = readFileSync(victim);

    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...base(), "--root", root, "-q"], io());
    const real = realpathSync(victim);

    const openLoss = (): { first_missing_at: string; resolved_at: string | null } | null => {
      const db = new Database(dbPath, { readonly: true });
      const row =
        db
          .query<{ first_missing_at: string; resolved_at: string | null }, [string]>(
            "SELECT first_missing_at, resolved_at FROM corpus_loss WHERE path = ?",
          )
          .get(real) ?? null;
      db.close();
      return row;
    };

    // Loss #1.
    unlinkSync(victim);
    await run(["sweep", ...base(), "--root", root, "-q"], io());
    const first = openLoss();
    expect(first).not.toBeNull();
    expect(first!.resolved_at).toBeNull();

    // Restored: the sweep that finds it again must RETRACT the loss.
    writeFileSync(victim, contents);
    await run(["sweep", ...base(), "--root", root, "-q"], io());
    expect(openLoss()!.resolved_at).not.toBeNull();

    // Loss #2 — the one that used to be invisible.
    unlinkSync(victim);
    stdout = [];
    await run(["sweep", ...base(), "--root", root, "--json"], io());
    const report = JSON.parse(outText()) as { vanished: { total: number; paths: string[] } };
    expect(report.vanished.paths).toContain(real);
    const second = openLoss()!;
    expect(second.resolved_at).toBeNull();
    expect(second.first_missing_at).not.toBe(first!.first_missing_at);
  });

  /**
   * §5.8's benign retention split, end to end and through the exit code — which is
   * where it used to be defeated. D2 correctly classified a transcript reaped past
   * `retention_days` as `expected` and raised the BENIGN `corpus_shrink_expected`,
   * and then discovery's own `main_transcript_missing` — raised with no age evidence
   * whatsoever — was alerting and failed the sweep anyway.
   */
  test("a main transcript reaped past retention_days does not fail the sweep", async () => {
    const { root, main } = copyCorpus();
    const realMain = realpathSync(main);
    await run(["init", ...base(), "-q"], io());
    await run(["sweep", ...base(), "--root", root, "-q"], io());

    // Age the ledger past `retention_days`, then reproduce the D1-blind shape: the
    // file goes AND its watermark goes, so only D2 can see the loss — and D2's only
    // age evidence is the ledger.
    const age = new Database(dbPath);
    age.query("UPDATE request SET ts = '2020-01-01T00:00:00Z'").run();
    age.query("UPDATE agent_run SET started_at = '2020-01-01T00:00:00Z'").run();
    age.query("DELETE FROM sweep_state WHERE path = ?").run(realMain);
    age.close();
    unlinkSync(main);

    stdout = [];
    const code = await run(["sweep", ...base(), "--root", root, "--json"], io());
    const report = JSON.parse(outText()) as {
      vanished: { total: number; expected: number };
      anomalies: { alerting: number; by_kind: Record<string, number> };
    };
    expect(report.vanished.total).toBe(1);
    expect(report.vanished.expected).toBe(1);
    expect(report.anomalies.by_kind.corpus_shrink_expected).toBe(1);
    expect(report.anomalies.by_kind.main_transcript_missing).toBe(1);
    expect(report.anomalies.alerting).toBe(0);
    expect(code).toBe(0);

    // Recorded, never hidden — and `--strict` still promotes both.
    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .query<{ expected: number; age_source: string }, [string]>(
          "SELECT expected, age_source FROM corpus_loss WHERE session_id = ?",
        )
        .get(SESSION),
    ).toEqual({ expected: 1, age_source: "ledger_ts" });
    db.close();
    expect(BENIGN_ANOMALY_KINDS.has("main_transcript_missing")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit-level: the pure classification helpers
// ---------------------------------------------------------------------------

describe("census.ts pure helpers", () => {
  test("classifyPathKind reads the role off a path's shape alone", () => {
    expect(classifyPathKind("/x/-p/11111111-1111-4111-8111-111111111111.jsonl")).toBe("main");
    expect(
      classifyPathKind("/x/-p/11111111-1111-4111-8111-111111111111/subagents/agent-a1.jsonl"),
    ).toBe("agent");
    expect(
      classifyPathKind("/x/-p/11111111-1111-4111-8111-111111111111/workflows/wf_r1.json"),
    ).toBe("state");
    expect(classifyPathKind("/x/-p/not-a-session-shaped-file.txt")).toBe("unknown");
  });

  test("isExpected: unknown age is never expected — the conservative direction", () => {
    const cfg: CensusConfig = { retentionDays: 365, vanishAlarmDays: 60, collapsePct: 20 };
    expect(isExpected(null, cfg)).toBe(false);
    expect(isExpected(400, cfg)).toBe(true);
    expect(isExpected(364, cfg)).toBe(false);
    expect(isExpected(365, cfg)).toBe(true);
  });

  test("ageDaysFrom is null for an absent instant, a bound otherwise", () => {
    const now = new Date("2026-03-02T00:00:00Z");
    expect(ageDaysFrom(null, now)).toBeNull();
    expect(ageDaysFrom("2026-03-01T00:00:00Z", now)).toBeCloseTo(1, 5);
  });

  test("checkCensusCollapse never trips with no prior sweep_census row", () => {
    const db = openDb({ path: join(dir, "unit.db") });
    const corpus = discoverCorpus(join(dir, "does-not-exist"));
    const cfg = readCensusConfig(db);
    expect(checkCensusCollapse(db, corpus, cfg)).toEqual({ collapsed: false, detail: null });
    db.close();
  });

  test("readCensusConfig falls back to the documented defaults", () => {
    const db = openDb({ path: join(dir, "unit2.db") });
    expect(readCensusConfig(db)).toEqual({
      retentionDays: 365,
      vanishAlarmDays: 60,
      collapsePct: 20,
    });
    db.close();
  });

  test("runCorpusLossProbe is a no-op on a corpus with no lost sessions", () => {
    const db = openDb({ path: join(dir, "unit3.db") });
    const corpus = discoverCorpus(FIXTURE_CORPUS);
    const result = runCorpusLossProbe(db, corpus, "2026-01-01T00:00:00Z", new Date("2026-01-01T00:00:00Z"));
    expect(result).toEqual({
      newLosses: [],
      insertedCount: 0,
      resolvedCount: 0,
      collapsed: false,
      collapseDetail: null,
    });
    db.close();
  });
});

// `corpus_shrink_expected` must be BENIGN, and it must be a real kind in the set —
// both regressed silently if either the anomaly type or this membership drifts.
test("corpus_shrink_expected is benign; corpus_shrink and census_collapse are not", () => {
  expect(BENIGN_ANOMALY_KINDS.has("corpus_shrink_expected")).toBe(true);
  expect(BENIGN_ANOMALY_KINDS.has("corpus_shrink")).toBe(false);
  expect(BENIGN_ANOMALY_KINDS.has("census_collapse")).toBe(false);
});

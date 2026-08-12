/**
 * test/g-attr-live.test.ts — the live G-ATTR re-gate's metric computation
 * (design/GATE-LIVE-SEMANTICS.md), against a synthetic fixture DB.
 *
 * Everything here is invented (§4: no real id, path or token figure in a tracked
 * file). These tests seed `request`/`task`/`task_alias`/`turn`/`agent_run` directly —
 * `gates/g-attr.ts` reads `request.attr`, so what is under test is the AGGREGATION,
 * not the attribution pass itself (that is `test/attribute.test.ts`'s job).
 *
 * All DB access here goes through `makeHarness` (a `mkdtempSync` temp dir; `EST_DB`-
 * equivalent by construction, never the live database) — including inside
 * `coverageExHook`/`stalenessGrid`, which additionally `VACUUM INTO` their own
 * throwaway copies under `node:os`'s `tmpdir()`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { agentRun, makeHarness, request, seedPrices, turn, type Harness } from "./support.ts";
import { attributeTasks } from "../src/attribute.ts";
import {
  anomalyPreconditions,
  byDimension,
  computeHeadline,
  coverageExHook,
  currencySensitivity,
  runLive,
  staleClosedShare,
  stalenessGrid,
  taskCensus,
  verdictOf,
} from "../gates/g-attr.ts";

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-gattr-live-");
  seedPrices(h.db);
});

afterEach(() => {
  h.close();
});

// ---------------------------------------------------------------------------
// seeding helpers — `task`/`task_alias` directly, no ceremony (mirrors attribute.test.ts)
// ---------------------------------------------------------------------------

interface TaskSpec {
  session?: string;
  prompt?: string;
  createdAt?: string;
  status?: string;
  bindSession?: boolean;
}

function seedTask(db: Database, tid: string, spec: TaskSpec = {}): string {
  const session = spec.session ?? "s1";
  const prompt = spec.prompt ?? "p1";
  db.query(
    `INSERT INTO task (tid, kind, status, created_at, started_at, ended_at, anchor_session, anchor_prompt)
     VALUES (?, 'implement', ?, ?, NULL, NULL, ?, ?)`,
  ).run(tid, spec.status ?? "in_progress", spec.createdAt ?? "2026-08-01T00:00:00Z", session, prompt);
  if (spec.bindSession !== false) alias(db, tid, "session", session, session);
  return tid;
}

function alias(db: Database, tid: string, kind: string, session: string, localId: string, source = "manual"): void {
  db.query(
    `INSERT OR REPLACE INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
     VALUES (?, ?, ?, ?, '2026-08-01T00:00:00Z', ?)`,
  ).run(tid, kind, session, localId, source);
}

/**
 * The full FK chain `outcome` needs — `bucket_def`, `task_scope` (the `(tid, scope_seq)`
 * composite FK on `estimate`), then `estimate` itself — trimmed to whatever every
 * NOT NULL column and CHECK requires, with no bearing on what `taskCensus` measures.
 */
function finalize(db: Database, tid: string, finalizedAt: string, status = "completed"): void {
  const ts = "2026-08-01T00:00:00Z";
  db.query("INSERT OR IGNORE INTO bucket_def (bucket, created_at, dims_json) VALUES ('default', ?, '{}')").run(ts);
  db.query(
    "INSERT INTO task_scope (tid, seq, ts, subject, scope_hash, source) VALUES (?, 1, ?, 'test', 'deadbeef', 'est_open')",
  ).run(tid, ts);
  db.query(
    `INSERT INTO estimate (tid, version, created_at, reason, scope_seq, raw_p50_wcet, raw_p90_wcet,
       exp_agents, exp_wf_phases, exp_files_write, exp_turns, exp_requests, bucket, bucket_n,
       shrink_w, cal_p50_wcet, cal_p90_wcet, price_epoch, ref_model, estimand, estimator_model)
     VALUES (?, 1, ?, 'initial', 1, 0, 0, 1, 0, 1, 1, 1, 'default', 0, 0, 0, 0, ?, 'test-ref', 'work_cet', 'test-model')`,
  ).run(tid, ts, ts);
  const eid = (db.query<{ eid: number }, []>("SELECT last_insert_rowid() AS eid").get()!).eid;
  db.query(
    `INSERT INTO outcome (tid, revision, finalized_at, final_status, censored, eid_at_start, eid_final,
       actual_wcet, actual_scet, actual_in, actual_out, actual_cw, actual_cr, n_requests, n_agents)
     VALUES (?, 1, ?, ?, 0, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
  ).run(tid, finalizedAt, status, eid, eid);
}

function anomaly(db: Database, kind: string, detail = "test", tid: string | null = null): void {
  db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES (?, ?, ?, ?)").run(
    "2026-08-01T00:00:00Z",
    kind,
    detail,
    tid,
  );
}

const TID = "019f0000-0000-7000-8000-000000000001";
const TID2 = "019f0000-0000-7000-8000-000000000002";

// ---------------------------------------------------------------------------
// computeHeadline — D1-D5
// ---------------------------------------------------------------------------

describe("computeHeadline", () => {
  test("L2 excludes overhead, replay and auxiliary; coverage is exclusive+sticky over L2", () => {
    seedTask(h.db, TID, { session: "s1" });

    // In L2 (main/subagent, non-replay, non-overhead, tracked session): 10 exclusive.
    request(h.db, "rq1", { session: "s1", origin: "main", out: 10, attr: "exclusive", tid: TID });
    // In L2: 5 ambiguous — counted in the denominator, not the numerator.
    request(h.db, "rq2", { session: "s1", origin: "subagent", out: 5, attr: "ambiguous", tid: TID });
    // Excluded from L2 by origin (auxiliary).
    request(h.db, "rq3", { session: "s1", origin: "auxiliary", out: 1000, attr: "exclusive", tid: TID });
    // Excluded from L2 by attr (overhead, replay).
    request(h.db, "rq4", { session: "s1", origin: "main", out: 1000, attr: "overhead", tid: TID });
    request(h.db, "rq5", { session: "s1", origin: "main", out: 1000, attr: "replay", tid: TID });
    // Untracked session: in L0, excluded from L1/L2.
    request(h.db, "rq6", { session: "s-untracked", origin: "main", out: 50, attr: "none" });

    const headline = computeHeadline(h.db, { since: "2026-01-01T00:00:00Z" });

    expect(headline.L2.exclusive).toBe(10);
    expect(headline.L2.ambiguous).toBe(5);
    expect(headline.L2.total).toBe(15);
    expect(headline.coverage_pct).toBeCloseTo((10 / 15) * 100, 6);
    expect(headline.ambiguous_incl_pct).toBeCloseTo(100, 6);

    // L1 keeps the auxiliary row (tracked session, no origin filter) but not the
    // untracked one; L0 keeps everything except replay.
    expect(headline.L1.total).toBe(10 + 5 + 1000 + 1000); // rq1+rq2+rq3+rq4, rq5 is replay
    expect(headline.L0.total).toBe(10 + 5 + 1000 + 1000 + 50);

    // E' = exclusive+sticky over L0's whole-window denominator. L0 does not filter by
    // origin, so rq3 (auxiliary, but attr='exclusive') counts in E's numerator too —
    // that is the point of the bridge rung being a DIFFERENT population from L2/L3.
    expect(headline.e_prime_pct).toBeCloseTo(((10 + 1000) / headline.L0.total) * 100, 6);
  });

  test("--since / --hook-merge style windowing: `until` is exclusive", () => {
    seedTask(h.db, TID, { session: "s1" });
    request(h.db, "early", { session: "s1", origin: "main", out: 10, attr: "exclusive", tid: TID, ts: "2026-08-01T00:00:00Z" });
    request(h.db, "boundary", { session: "s1", origin: "main", out: 10, attr: "exclusive", tid: TID, ts: "2026-08-05T00:00:00Z" });
    request(h.db, "late", { session: "s1", origin: "main", out: 10, attr: "exclusive", tid: TID, ts: "2026-08-10T00:00:00Z" });

    const pre = computeHeadline(h.db, { since: "2026-08-01T00:00:00Z", until: "2026-08-05T00:00:00Z" });
    const post = computeHeadline(h.db, { since: "2026-08-05T00:00:00Z" });

    expect(pre.L2.total).toBe(10); // only "early"
    expect(post.L2.total).toBe(20); // "boundary" + "late"
  });

  test("empty corpus is a defined answer (0 coverage, not NaN/crash)", () => {
    const headline = computeHeadline(h.db, { since: "2026-01-01T00:00:00Z" });
    expect(headline.coverage_pct).toBe(0);
    expect(headline.L2.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// currencySensitivity — D4
// ---------------------------------------------------------------------------

describe("currencySensitivity", () => {
  test("wcet_priced, out+cw, in+out+cw and request-count move independently", () => {
    seedTask(h.db, TID, { session: "s1" });
    // seedPrices makes usd_out = usd_cw = usd_in = 1, so wcet == out_tok + cw_tok.
    request(h.db, "rq1", { session: "s1", origin: "main", in: 3, out: 10, cw: 2, attr: "exclusive", tid: TID });
    request(h.db, "rq2", { session: "s1", origin: "main", in: 1, out: 4, cw: 0, attr: "ambiguous", tid: TID });

    const cs = currencySensitivity(h.db, { since: "2026-01-01T00:00:00Z" });
    // wcet excludes `in_tok` by construction (v_wcet: out*usd_out + cw_cost only).
    expect(cs.wcet_priced!.total).toBe(16); // (10+2)+(4+0), usd_out=usd_cw=1
    expect(cs.out_plus_cw!.total).toBe(16);
    expect(cs.in_out_cw!.total).toBe(20);
    expect(cs.request_count!.total).toBe(2);
    expect(cs.request_count!.coverage_pct).toBeCloseTo(50, 6); // 1 of 2 requests exclusive
  });
});

// ---------------------------------------------------------------------------
// byDimension — origin / model family reweighting sensitivity
// ---------------------------------------------------------------------------

describe("byDimension", () => {
  test("shares sum to 100 and each key's coverage is scoped to itself", () => {
    seedTask(h.db, TID, { session: "s1" });
    request(h.db, "rq1", { session: "s1", origin: "main", out: 10, attr: "exclusive", tid: TID });
    request(h.db, "rq2", { session: "s1", origin: "subagent", out: 30, attr: "ambiguous", tid: TID });

    const byOrigin = byDimension(h.db, "origin", { since: "2026-01-01T00:00:00Z" });
    const main = byOrigin.find((o) => o.key === "main")!;
    const sub = byOrigin.find((o) => o.key === "subagent")!;
    expect(main.coverage_pct).toBeCloseTo(100, 6);
    expect(sub.coverage_pct).toBeCloseTo(0, 6);
    expect(main.share_pct + sub.share_pct).toBeCloseTo(100, 6);
  });
});

// ---------------------------------------------------------------------------
// taskCensus — D7
// ---------------------------------------------------------------------------

describe("taskCensus", () => {
  test("opened/finalized/still-open/never-attributed and the alias mix", () => {
    seedTask(h.db, TID, { session: "s1", createdAt: "2026-08-02T00:00:00Z" });
    seedTask(h.db, TID2, { session: "s2", createdAt: "2026-08-03T00:00:00Z" });
    alias(h.db, TID, "agent", "s1", "ag1", "hook");

    // TID gets an outcome (finalized) and an attributed request; TID2 gets neither.
    finalize(h.db, TID, "2026-08-04T00:00:00Z");
    request(h.db, "rq1", { session: "s1", origin: "main", out: 10, attr: "exclusive", tid: TID });

    const census = taskCensus(h.db, { since: "2026-08-01T00:00:00Z" });
    expect(census.opened_in_window).toBe(2);
    expect(census.finalized_in_window).toBe(1);
    expect(census.still_open_now).toBe(1); // TID2
    expect(census.never_attributed_pct).toBeCloseTo(50, 6); // TID2 only
    const hookAlias = census.alias_counts.find((a) => a.id_kind === "agent" && a.source === "hook");
    expect(hookAlias?.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// anomalyPreconditions — D9
// ---------------------------------------------------------------------------

describe("anomalyPreconditions", () => {
  test("counts only the two ALERTING kinds, ignores everything else", () => {
    anomaly(h.db, "hook_bind_conflict");
    anomaly(h.db, "hook_bind_conflict");
    anomaly(h.db, "alias_split_identity");
    anomaly(h.db, "hook_bind_superseded"); // BENIGN, not counted
    anomaly(h.db, "malformed_line"); // unrelated, not counted

    const p = anomalyPreconditions(h.db);
    expect(p.hook_bind_conflict).toBe(2);
    expect(p.alias_split_identity).toBe(1);
  });

  test("zero when the ledger is clean — the common case before hook-binding lands", () => {
    const p = anomalyPreconditions(h.db);
    expect(p).toEqual({ hook_bind_conflict: 0, alias_split_identity: 0 });
  });
});

// ---------------------------------------------------------------------------
// staleClosedShare — D10
// ---------------------------------------------------------------------------

describe("staleClosedShare", () => {
  test("pre_task spend INSIDE a bound task's window is stale-closed; before it is not", () => {
    seedTask(h.db, TID, { session: "s1", createdAt: "2026-08-02T00:00:00Z" });
    // Inside the task's window (ts >= created_at) but attr fell to pre_task (staleness).
    request(h.db, "rq-stale", { session: "s1", origin: "main", out: 7, attr: "pre_task", ts: "2026-08-03T00:00:00Z" });
    // Before the task existed at all — genuinely pre-task, not stale-closed.
    request(h.db, "rq-pre", { session: "s1", origin: "main", out: 3, attr: "pre_task", ts: "2026-08-01T00:00:00Z" });
    // The base-population denominator needs something in it too.
    request(h.db, "rq-base", { session: "s1", origin: "main", out: 10, attr: "exclusive", tid: TID, ts: "2026-08-02T00:00:00Z" });

    const share = staleClosedShare(h.db, { since: "2026-08-01T00:00:00Z" });
    // denominator (L2 base) = 7 + 3 + 10 = 20; numerator (stale-closed only) = 7.
    expect(share).toBeCloseTo((7 / 20) * 100, 6);
  });
});

// ---------------------------------------------------------------------------
// coverageExHook / stalenessGrid — D9/D10, the mutation-requiring recomputes
// ---------------------------------------------------------------------------

describe("coverageExHook", () => {
  test("deleting a hook alias and re-attributing can only move coverage down or flat", () => {
    // Two candidate tasks in one session; TID2's ONLY claim is a hook-sourced agent
    // alias, so removing it should give its turn's spend back to residual/ambiguous.
    turn(h.db, { session: "s1", prompt: "p1", at: "2026-08-02T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "p1", createdAt: "2026-08-02T10:00:00Z", bindSession: false });
    seedTask(h.db, TID2, { session: "s1", prompt: "p1", createdAt: "2026-08-02T10:00:00Z", bindSession: false });
    alias(h.db, TID, "session", "s1", "s1", "manual");
    alias(h.db, TID2, "agent", "s1", "ag1", "hook");
    agentRun(h.db, "ag1", { session: "s1", launchPrompt: "p1", startedAt: "2026-08-02T10:00:10Z", endedAt: "2026-08-02T10:05:00Z" });
    request(h.db, "rq-agent", { session: "s1", origin: "subagent", agent: "ag1", out: 40, ts: "2026-08-02T10:01:00Z" });
    request(h.db, "rq-main", { session: "s1", origin: "main", prompt: "p1", out: 10, ts: "2026-08-02T10:00:10Z" });

    attributeTasks(h.db);
    const live = computeHeadline(h.db, { since: "2026-08-01T00:00:00Z" });

    // Snapshot the master copy the way `runLive` does: VACUUM INTO, then run the
    // ex-hook shadow against the COPY, never the harness's own `h.db`.
    const { mkdtempSync, rmSync, copyFileSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "g-attr-live-test-"));
    const masterPath = join(dir, "master.db");
    const quoted = masterPath.replace(/'/g, "''");
    h.db.exec(`VACUUM INTO '${quoted}'`);
    try {
      const exHook = coverageExHook(masterPath, { since: "2026-08-01T00:00:00Z" });
      expect(exHook).toBeLessThanOrEqual(live.coverage_pct);

      // The harness's own database must be completely untouched by the shadow run.
      const stillHook = h.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_alias WHERE source = 'hook'")
        .get()!.n;
      expect(stillHook).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stalenessGrid", () => {
  test("a tighter quiet-turns bound cannot raise coverage above the shipped setting", () => {
    turn(h.db, { session: "s1", prompt: "anchor", at: "2026-08-02T10:00:00Z" });
    seedTask(h.db, TID, { session: "s1", prompt: "anchor", createdAt: "2026-08-02T10:00:00Z" });
    for (let i = 0; i < 6; i += 1) {
      turn(h.db, { session: "s1", prompt: `t${i}`, at: `2026-08-02T10:0${i + 1}:00Z` });
    }
    request(h.db, "rq-anchor", { session: "s1", prompt: "anchor", out: 10, ts: "2026-08-02T10:00:10Z" });
    for (let i = 0; i < 6; i += 1) {
      request(h.db, `rq-t${i}`, { session: "s1", prompt: `t${i}`, out: 10, ts: `2026-08-02T10:0${i + 1}:10Z` });
    }
    attributeTasks(h.db);

    const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "g-attr-live-test-"));
    const masterPath = join(dir, "master.db");
    const quoted = masterPath.replace(/'/g, "''");
    h.db.exec(`VACUUM INTO '${quoted}'`);
    try {
      const grid = stalenessGrid(masterPath, { since: "2026-08-01T00:00:00Z" }, [1, 5], [120]);
      const tight = grid.find((g) => g.turns === 1)!;
      const loose = grid.find((g) => g.turns === 5)!;
      expect(tight.coverage_pct).toBeLessThanOrEqual(loose.coverage_pct);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// verdictOf — D14
// ---------------------------------------------------------------------------

describe("verdictOf", () => {
  test("below threshold escalates regardless of a clean anomaly ledger", () => {
    expect(verdictOf(69.9, { hook_bind_conflict: 0, alias_split_identity: 0 })).toBe("ESCALATE");
  });
  test("at/above threshold with a clean ledger passes", () => {
    expect(verdictOf(70, { hook_bind_conflict: 0, alias_split_identity: 0 })).toBe("PASS");
  });
  test("above threshold but an unclean ledger still escalates (D9: coverage cannot validate the binder)", () => {
    expect(verdictOf(95, { hook_bind_conflict: 1, alias_split_identity: 0 })).toBe("ESCALATE");
    expect(verdictOf(95, { hook_bind_conflict: 0, alias_split_identity: 1 })).toBe("ESCALATE");
  });
});

// ---------------------------------------------------------------------------
// runLive — end to end, skipping X1 (transcript corpus is out of scope for a
// DB-fixture unit test), and asserting the live handle is never mutated.
// ---------------------------------------------------------------------------

describe("runLive", () => {
  test("end-to-end report shape, and the live db is untouched afterwards", async () => {
    seedTask(h.db, TID, { session: "s1", createdAt: "2026-08-02T00:00:00Z" });
    request(h.db, "rq1", { session: "s1", origin: "main", out: 10, attr: "exclusive", tid: TID, ts: "2026-08-02T00:00:00Z" });
    request(h.db, "rq2", { session: "s1", origin: "subagent", out: 5, attr: "ambiguous", tid: TID, ts: "2026-08-02T00:00:00Z" });

    const before = h.db
      .query<{ tid: string | null; attr: string }, [string]>("SELECT tid, attr FROM request WHERE request_id = ?")
      .get("rq2");

    const report = await runLive(h.db, { since: "2026-08-01T00:00:00Z", skipX1: true });

    expect(report.headline.coverage_pct).toBeCloseTo((10 / 15) * 100, 6);
    expect(report.task_census.opened_in_window).toBe(1);
    expect(report.anomaly_preconditions).toEqual({ hook_bind_conflict: 0, alias_split_identity: 0 });
    expect(report.verdict).toBe("ESCALATE"); // well under 70%
    expect(report.licenses).toBeNull();
    expect(report.hook_aliases_present).toBe(false);
    // `coverage_ex_hook` is always a FULL re-sweep (D9), never merely "coverage minus
    // hook rows" — this fixture seeds `request.attr` directly rather than through
    // `attributeTasks` (no `turn` rows), so the shadow re-derives a different number.
    // What must hold regardless of fixture realism is the algebraic identity D9 defines.
    expect(report.hook_lift_pct).toBeCloseTo(report.headline.coverage_pct - (report.coverage_ex_hook_pct ?? 0), 6);
    expect(report.coverage_ex_hook_pct).toBeGreaterThanOrEqual(0);
    expect(report.coverage_ex_hook_pct).toBeLessThanOrEqual(100);
    expect(report.staleness_grid.length).toBeGreaterThan(0);

    // The live handle passed in must read back EXACTLY as it did before the run —
    // every mutating step in `runLive` operates on a `VACUUM INTO` temp copy.
    const after = h.db
      .query<{ tid: string | null; attr: string }, [string]>("SELECT tid, attr FROM request WHERE request_id = ?")
      .get("rq2");
    expect(after).toEqual(before);
  });

  test("PASS carries the D14 licence text; a clean anomaly ledger is required, not just the threshold", async () => {
    seedTask(h.db, TID, { session: "s1", createdAt: "2026-08-02T00:00:00Z" });
    request(h.db, "rq1", { session: "s1", origin: "main", out: 10, attr: "exclusive", tid: TID, ts: "2026-08-02T00:00:00Z" });

    const clean = await runLive(h.db, { since: "2026-08-01T00:00:00Z", skipX1: true });
    expect(clean.headline.coverage_pct).toBeCloseTo(100, 6);
    expect(clean.verdict).toBe("PASS");
    expect(clean.licenses).toContain("P2.11");
    expect(clean.licenses).toContain("Not a validation of the binder");

    anomaly(h.db, "hook_bind_conflict");
    const dirty = await runLive(h.db, { since: "2026-08-01T00:00:00Z", skipX1: true });
    expect(dirty.headline.coverage_pct).toBeCloseTo(100, 6); // unchanged — same requests
    expect(dirty.verdict).toBe("ESCALATE"); // but the ledger is unclean now
    expect(dirty.licenses).toBeNull();
  });
});

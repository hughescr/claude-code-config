/**
 * schema.sql invariants — the constraints and view semantics a review gate found
 * were silently wrong, pinned so they cannot regress.
 *
 * Everything here is DDL/SQL behaviour, so it is asserted against a real database
 * opened by `src/db.ts` rather than against any TypeScript layer. Where a writer
 * already exists (`INSERT_TASK_EVENT_SQL`), the test drives THAT statement rather
 * than a hand-rolled equivalent: the bug was an interaction between the writer's
 * `ON CONFLICT` target and the table's uniqueness, and a re-typed INSERT would not
 * have caught it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db.ts";
import { INSERT_TASK_EVENT_SQL } from "../src/ingest.ts";
import { ABOVE_200K_SUFFIX, LONG_CONTEXT_THRESHOLD } from "../src/prices.ts";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "estimator-schema-test-"));
  db = openDb({ path: join(dir, "estimator.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** USD per Mtok, effective from `from` (default: covers all history). */
function price(
  family: string,
  rates: { in: number; out: number; cw: number; cr: number },
  from = "1970-01-01T00:00:00Z",
): void {
  db.query(
    `INSERT INTO model_price (family, effective_from, usd_in, usd_out, usd_cw, usd_cr,
                              provisional, source, synced_epoch, ingested_at)
     VALUES (?,?,?,?,?,?,0,'manual',NULL,'1970-01-01T00:00:00Z')`,
  ).run(family, from, rates.in, rates.out, rates.cw, rates.cr);
}

interface ReqOpts {
  family?: string;
  origin?: string;
  in_tok?: number;
  out_tok?: number;
  cw_tok?: number;
  cr_tok?: number;
  ts?: string;
  tid?: string | null;
  attr?: string;
  agent_id?: string | null;
}

function request(id: string, o: ReqOpts = {}): void {
  const family = o.family ?? "claude-test-1";
  db.query(
    `INSERT INTO request (request_id, session_id, origin, model, model_family, ts,
                          in_tok, out_tok, cw_tok, cr_tok, tid, attr, agent_id)
     VALUES (?, 's1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.origin ?? "main",
    family,
    family,
    o.ts ?? "2026-01-01T00:00:00Z",
    o.in_tok ?? 0,
    o.out_tok ?? 0,
    o.cw_tok ?? 0,
    o.cr_tok ?? 0,
    o.tid ?? null,
    o.attr ?? "none",
    o.agent_id ?? null,
  );
}

/** A task with one scope revision — the minimum an `estimate` row can reference. */
function task(tid: string): void {
  db.query(
    `INSERT INTO task (tid, kind, status, created_at, anchor_session, anchor_prompt)
     VALUES (?, 'implement', 'in_progress', '2026-01-01T00:00:00Z', 's1', 'p1')`,
  ).run(tid);
  db.query(
    `INSERT INTO task_scope (tid, seq, ts, subject, dod_json, scope_hash, source)
     VALUES (?, 1, '2026-01-01T00:00:00Z', 'subject', '[]', 'hash', 'est_open')`,
  ).run(tid);
}

/** The band `v_task_actual_epoch` and `v_velocity` read the unit off. */
function estimate(
  tid: string,
  opts: { price_epoch?: string; ref_model?: string; estimand?: string } = {},
): void {
  db.query(
    `INSERT INTO estimate (tid, version, created_at, reason, scope_seq,
                           raw_p50_wcet, raw_p90_wcet, exp_agents, exp_wf_phases,
                           exp_files_write, exp_turns, exp_requests, bucket, bucket_n,
                           refclass_as_of, shrink_w, cal_p50_wcet, cal_p90_wcet,
                           price_epoch, ref_model, estimand, estimator_model)
     VALUES (?, 1, '2026-01-01T00:00:00Z', 'initial', 1,
             1000, 2000, 1, 0, 1, 5, 10, 'global', 0,
             NULL, 0, 1000, 2000,
             ?, ?, ?, 'claude-opus-5')`,
  ).run(
    tid,
    opts.price_epoch ?? "2026-01-01T00:00:00Z",
    opts.ref_model ?? "claude-sonnet-4-5",
    opts.estimand ?? "work_cet",
  );
}

function agent(id: string, phaseIdx: number, conf: string): void {
  db.query(
    `INSERT INTO agent_run (agent_id, session_id, run_id, wf_launch_id, phase_idx, phase_conf)
     VALUES (?, 's1', 'wf_r1', 'wl_1', ?, ?)`,
  ).run(id, phaseIdx, conf);
}

// ---------------------------------------------------------------------------
// Finding 1 — v_phase_actual.phase_conf is worst-wins
// ---------------------------------------------------------------------------

describe("v_phase_actual.phase_conf", () => {
  test("a phase mixing exact and inferred agents reports the WORSE label", () => {
    agent("a1", 0, "exact");
    agent("a2", 0, "inferred");

    const row = db
      .query<{ phase_conf: string; n_agents: number }, []>(
        "SELECT phase_conf, n_agents FROM v_phase_actual WHERE phase_idx = 0",
      )
      .get()!;
    expect(row.n_agents).toBe(2);
    // MIN() returned 'exact' here and told the caller the mapping was certain.
    expect(row.phase_conf).toBe("inferred");
  });

  test("one unmapped agent degrades the whole phase", () => {
    agent("a1", 1, "exact");
    agent("a2", 1, "inferred");
    agent("a3", 1, "unmapped");

    const conf = db
      .query<{ phase_conf: string }, []>("SELECT phase_conf FROM v_phase_actual WHERE phase_idx = 1")
      .get()!.phase_conf;
    expect(conf).toBe("unmapped");
  });

  test("a uniformly exact phase is still reported exact", () => {
    agent("a1", 2, "exact");
    agent("a2", 2, "exact");

    const conf = db
      .query<{ phase_conf: string }, []>("SELECT phase_conf FROM v_phase_actual WHERE phase_idx = 2")
      .get()!.phase_conf;
    expect(conf).toBe("exact");
  });

  test("the three labels really do sort worst-last, which is what MAX() relies on", () => {
    const order = db
      .query<{ c: string }, []>(
        `SELECT c FROM (SELECT 'exact' AS c UNION ALL SELECT 'inferred' UNION ALL SELECT 'unmapped')
          ORDER BY c`,
      )
      .all()
      .map((r) => r.c);
    expect(order).toEqual(["exact", "inferred", "unmapped"]);
  });
});

// ---------------------------------------------------------------------------
// Finding 4 — counters cannot go negative
// ---------------------------------------------------------------------------

describe("non-negative counters", () => {
  for (const col of ["in_tok", "out_tok", "cw_tok", "cr_tok"] as const) {
    test(`request.${col} rejects a negative value loudly`, () => {
      expect(() => request("neg", { [col]: -1 })).toThrow(/CHECK constraint failed/i);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request").get()!.n).toBe(0);
    });
  }

  test("zero and positive counters are still accepted", () => {
    request("ok0", { in_tok: 0, out_tok: 0, cw_tok: 0, cr_tok: 0 });
    request("ok1", { in_tok: 1, out_tok: 2, cw_tok: 3, cr_tok: 4 });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request").get()!.n).toBe(2);
  });

  test("request.duration_ms rejects a negative but allows NULL", () => {
    request("d0");
    expect(() => db.query("UPDATE request SET duration_ms = -5 WHERE request_id='d0'").run()).toThrow(
      /CHECK constraint failed/i,
    );
    db.query("UPDATE request SET duration_ms = 5 WHERE request_id='d0'").run();
  });

  test("outcome roll-ups reject a negative actual", () => {
    task("t-neg");
    estimate("t-neg");
    const eid = db.query<{ eid: number }, []>("SELECT eid FROM estimate").get()!.eid;
    const insert = (col: string, value: number): void => {
      db.query(
        `INSERT INTO outcome (tid, revision, finalized_at, final_status, eid_at_start, eid_final,
                              actual_wcet, actual_scet, actual_in, actual_out, actual_cw, actual_cr,
                              n_requests, n_agents, ${col})
         VALUES ('t-neg', 1, '2026-01-02T00:00:00Z', 'completed', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
      ).run(eid, eid, value);
    };
    expect(() => insert("wcet_sub", -1)).toThrow(/CHECK constraint failed/i);
    expect(() => insert("n_req_main", -1)).toThrow(/CHECK constraint failed/i);
    expect(() => insert("overhead_wcet", -1)).toThrow(/CHECK constraint failed/i);
    insert("wcet_sub", 0); // the same row shape is fine at zero
  });
});

// ---------------------------------------------------------------------------
// Finding 5 — task_event dedups across re-sweeps even with NULL inputs
// ---------------------------------------------------------------------------

describe("task_event uniqueness", () => {
  /** Drive the REAL ingest statement, nulls and all. */
  const emit = (row: {
    session_id: string;
    task_num: string | null;
    ts: string;
    kind?: "create" | "status";
    from_status: string | null;
    to_status: string | null;
  }): void => {
    db.query(INSERT_TASK_EVENT_SQL).run({
      $session_id: row.session_id,
      $task_num: row.task_num,
      $ts: row.ts,
      $kind: row.kind ?? "status",
      $from_status: row.from_status,
      $to_status: row.to_status,
    } as never);
  };

  test("a re-sweep of an event with NULL task_num and to_status inserts NOTHING twice", () => {
    const ev = {
      session_id: "s1",
      task_num: null,
      ts: "2026-01-01T00:00:00Z",
      from_status: null,
      to_status: null,
    };
    emit(ev);
    emit(ev); // the sweeper is idempotent; this is the third sweep of the same file
    emit(ev);

    const rows = db
      .query<{ task_num: string; to_status: string; n: number }, []>(
        "SELECT task_num, to_status, COUNT(*) AS n FROM task_event",
      )
      .all();
    expect(rows).toEqual([{ task_num: "", to_status: "", n: 1 }]);
  });

  test("NULLs are coerced to the sentinel, not stored as NULL", () => {
    emit({
      session_id: "s1",
      task_num: null,
      ts: "2026-01-01T00:00:00Z",
      from_status: null,
      to_status: null,
    });
    const nulls = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM task_event WHERE task_num IS NULL OR to_status IS NULL",
      )
      .get()!.n;
    expect(nulls).toBe(0);
  });

  test("a partially-NULL key still dedups", () => {
    const ev = {
      session_id: "s1",
      task_num: "3",
      ts: "2026-01-01T00:00:00Z",
      from_status: "pending",
      to_status: null,
    };
    emit(ev);
    emit(ev);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM task_event").get()!.n).toBe(1);
  });

  test("genuinely distinct events are still distinct", () => {
    const base = {
      session_id: "s1",
      task_num: null as string | null,
      ts: "2026-01-01T00:00:00Z",
      from_status: null,
      to_status: null as string | null,
    };
    emit(base);
    emit({ ...base, ts: "2026-01-01T00:00:01Z" });
    emit({ ...base, to_status: "completed" });
    emit({ ...base, task_num: "7" });
    emit({ ...base, session_id: "s2" });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM task_event").get()!.n).toBe(5);
  });

  test("a TaskCreate and a transition to the same status are two rows, not one", () => {
    // Both are `to_status='pending'` on one task at one instant, so without
    // `kind` in the dedup key the create is swallowed and §5.4's "touched"
    // silently loses it.
    const at = { session_id: "s1", task_num: "9", ts: "2026-01-01T00:00:00Z" } as const;
    emit({ ...at, kind: "create", from_status: null, to_status: "pending" });
    emit({ ...at, kind: "status", from_status: "in_progress", to_status: "pending" });
    expect(
      db
        .query<{ kind: string }, []>("SELECT kind FROM task_event ORDER BY kind")
        .all()
        .map((r) => r.kind),
    ).toEqual(["create", "status"]);

    // ...and each is still idempotent on its own key.
    emit({ ...at, kind: "create", from_status: null, to_status: "pending" });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM task_event").get()!.n).toBe(2);
  });

  test("kind rejects a value outside the vocabulary", () => {
    expect(() =>
      db
        .query(
          `INSERT INTO task_event (session_id, task_num, ts, kind, to_status, source)
           VALUES ('s1','9','2026-01-01T00:00:00Z','touched','pending','transcript')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});

// ---------------------------------------------------------------------------
// Finding 6 — the >200k context tier is chosen PER REQUEST
// ---------------------------------------------------------------------------

describe("above-200k context tier", () => {
  const STD = { in: 3, out: 15, cw: 3.75, cr: 0.3 };
  const HI = { in: 6, out: 22.5, cw: 7.5, cr: 0.6 };

  beforeEach(() => {
    price("claude-sonnet-4-5", STD); // config.ref_model — the Work-CET normaliser
    price("claude-test-1", STD);
    price("claude-test-1@above_200k", HI);
  });

  const priced = (id: string) =>
    db
      .query<{ price_family: string; usd_out: number; usd_in: number }, [string]>(
        "SELECT price_family, usd_out, usd_in FROM v_priced WHERE request_id = ?",
      )
      .get(id)!;

  test("a request at or below the threshold prices at the STANDARD tier", () => {
    // 200,000 exactly — the boundary is `> 200000`, so this is standard.
    request("r_small", { in_tok: 100_000, cw_tok: 50_000, cr_tok: 50_000, out_tok: 1000 });
    const p = priced("r_small");
    expect(p.price_family).toBe("claude-test-1");
    expect(p.usd_out).toBe(STD.out);
  });

  test("a request above the threshold prices at the LONG-CONTEXT tier", () => {
    request("r_big", { in_tok: 100_000, cw_tok: 50_000, cr_tok: 100_000, out_tok: 1000 });
    const p = priced("r_big");
    expect(p.price_family).toBe("claude-test-1@above_200k");
    expect(p.usd_out).toBe(HI.out);
    expect(p.usd_in).toBe(HI.in);
  });

  test("out_tok is NOT part of the context that triggers the tier", () => {
    // 150k of prompt, 500k of completion: the API billed the prompt at the
    // standard tier, and counting the completion would invent a premium.
    request("r_out", { in_tok: 100_000, cw_tok: 50_000, cr_tok: 0, out_tok: 500_000 });
    expect(priced("r_out").price_family).toBe("claude-test-1");
  });

  test("both tiers are reachable from ONE model_family in one corpus", () => {
    request("r_lo", { in_tok: 10_000, out_tok: 100 });
    request("r_hi", { in_tok: 300_000, out_tok: 100 });
    const rows = db
      .query<{ request_id: string; usd_out: number }, []>(
        "SELECT request_id, usd_out FROM v_priced ORDER BY request_id",
      )
      .all();
    expect(rows).toEqual([
      { request_id: "r_hi", usd_out: HI.out },
      { request_id: "r_lo", usd_out: STD.out },
    ]);
  });

  test("a family with no published >200k tier falls back to its base rate", () => {
    price("claude-test-2", STD);
    request("r_nocomp", { family: "claude-test-2", in_tok: 400_000, out_tok: 100 });
    const p = priced("r_nocomp");
    expect(p.price_family).toBe("claude-test-2");
    expect(p.usd_out).toBe(STD.out);
    // and it is NOT quietly dropped out of the INNER JOIN
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM v_priced").get()!.n).toBe(1);
  });

  test("a companion row that postdates the request does not apply", () => {
    price("claude-test-3", STD);
    price("claude-test-3@above_200k", HI, "2030-01-01T00:00:00Z");
    request("r_early", {
      family: "claude-test-3",
      in_tok: 400_000,
      out_tok: 100,
      ts: "2026-01-01T00:00:00Z",
    });
    expect(priced("r_early").price_family).toBe("claude-test-3");
  });

  test("a family that already carries a long-context suffix is not surcharged twice", () => {
    // `src/prices.ts` writes the >200k rate INTO the bracketed row, and no
    // `claude-test-1[1m]@above_200k` companion is ever written.
    price("claude-test-1[1m]", HI);
    request("r_1m", { family: "claude-test-1[1m]", in_tok: 400_000, out_tok: 100 });
    const p = priced("r_1m");
    expect(p.price_family).toBe("claude-test-1[1m]");
    expect(p.usd_out).toBe(HI.out);
  });

  test("a bracketed family IGNORES an `@above_200k` companion that exists anyway", () => {
    // The claim above cannot rest on "sync() never writes one": history in
    // `model_price` is append-only, so ONE sync that guessed the family from a
    // tier peer (which used to copy the peer's companion under the bracketed
    // name) leaves a row a later, authoritative sync can never supersede. The
    // view must refuse the companion outright, or the guess outranks the
    // published rate forever — 3x here, and provisional=1, which keeps every
    // task touching the request out of v_velocity permanently.
    price("claude-test-1[1m]", HI);
    price("claude-test-1[1m]@above_200k", { in: HI.in * 2, out: HI.out * 2, cw: 1, cr: 1 });
    request("r_1m_dup", { family: "claude-test-1[1m]", in_tok: 400_000, out_tok: 100 });
    const p = priced("r_1m_dup");
    expect(p.price_family).toBe("claude-test-1[1m]");
    expect(p.usd_out).toBe(HI.out);
  });

  test("v_wcet carries the tiered rate into the Work-CET number", () => {
    request("r_lo", { in_tok: 10_000, cw_tok: 50_000, out_tok: 1000 });
    request("r_hi", { in_tok: 300_000, cw_tok: 50_000, out_tok: 1000 });
    const rows = db
      .query<{ request_id: string; wcet: number }, []>(
        "SELECT request_id, wcet FROM v_wcet ORDER BY request_id",
      )
      .all();
    // ref_out = 15 (claude-sonnet-4-5 standard output rate)
    //   lo: (1000*15   + 50000*3.75) / 15 = 13500
    //   hi: (1000*22.5 + 50000*7.5 ) / 15 = 26500
    expect(rows).toEqual([
      { request_id: "r_hi", wcet: 26_500 },
      { request_id: "r_lo", wcet: 13_500 },
    ]);
  });

  test("the long-context premium is REAL — the same request costs more above 200k", () => {
    request("r_lo", { in_tok: 10_000, cw_tok: 50_000, out_tok: 1000 });
    request("r_hi", { in_tok: 300_000, cw_tok: 50_000, out_tok: 1000 });
    const wcet = (id: string): number =>
      db.query<{ wcet: number }, [string]>("SELECT wcet FROM v_wcet WHERE request_id = ?").get(id)!
        .wcet;
    expect(wcet("r_hi")).toBeGreaterThan(wcet("r_lo"));
  });

  test("the companion family does not leak into v_unpriced", () => {
    request("r_hi", { in_tok: 300_000, out_tok: 100 });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM v_unpriced").get()!.n).toBe(0);
  });

  test("schema.sql's literals still match the constants src/prices.ts writes with", () => {
    // SQL cannot import LONG_CONTEXT_THRESHOLD / ABOVE_200K_SUFFIX, so the view
    // hardcodes them. If either constant moves, the companion rows sync() writes
    // and the rows v_priced looks for stop being the same rows — silently, because
    // the fallback to the base family looks exactly like "no long-context tier
    // published". This pins the contract from the TypeScript side.
    price(`claude-test-4${ABOVE_200K_SUFFIX}`, HI);
    price("claude-test-4", STD);
    request("r_at", { family: "claude-test-4", in_tok: LONG_CONTEXT_THRESHOLD, out_tok: 100 });
    request("r_over", { family: "claude-test-4", in_tok: LONG_CONTEXT_THRESHOLD + 1, out_tok: 100 });
    expect(priced("r_at").price_family).toBe("claude-test-4");
    expect(priced("r_over").price_family).toBe(`claude-test-4${ABOVE_200K_SUFFIX}`);
  });
});

// ---------------------------------------------------------------------------
// Findings 2 and 3 — the calibration corpus compares like with like
// ---------------------------------------------------------------------------

describe("calibration aggregates", () => {
  beforeEach(() => {
    price("claude-sonnet-4-5", { in: 3, out: 15, cw: 3.75, cr: 0.3 });
    price("claude-test-1", { in: 3, out: 15, cw: 3.75, cr: 0.3 });
  });

  test("estimate snapshots the unit it was issued in", () => {
    task("t1");
    estimate("t1", { ref_model: "claude-opus-5", estimand: "out" });
    const row = db
      .query<{ ref_model: string; estimand: string }, []>(
        "SELECT ref_model, estimand FROM estimate",
      )
      .get()!;
    expect(row).toEqual({ ref_model: "claude-opus-5", estimand: "out" });
  });

  test("the unit columns are mandatory — an unlabelled band cannot be recorded", () => {
    task("t2");
    expect(() =>
      db
        .query(
          `INSERT INTO estimate (tid, version, created_at, reason, scope_seq,
                                 raw_p50_wcet, raw_p90_wcet, exp_agents, exp_wf_phases,
                                 exp_files_write, exp_turns, exp_requests, bucket, bucket_n,
                                 shrink_w, cal_p50_wcet, cal_p90_wcet, price_epoch, estimator_model)
           VALUES ('t2', 1, '2026-01-01T00:00:00Z', 'initial', 1, 1, 1, 1, 0, 1, 1, 1,
                   'global', 0, 0, 1, 1, '2026-01-01T00:00:00Z', 'claude-opus-5')`,
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed/i);
  });

  test("v_velocity projects the unit so a consumer cannot pool across currencies", () => {
    const cols = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('v_velocity')")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("ref_model");
    expect(cols).toContain("estimand");
    expect(cols).toContain("wcet_task_effort");
  });

  test("v_task_actual_epoch excludes auxiliary spend from task effort", () => {
    task("t3");
    estimate("t3");
    // 1000 out-tokens each: main and subagent count, auxiliary must not.
    request("q_main", { tid: "t3", origin: "main", out_tok: 1000 });
    request("q_sub", { tid: "t3", origin: "subagent", out_tok: 1000 });
    request("q_aux", { tid: "t3", origin: "auxiliary", out_tok: 1000 });

    const wcet = db
      .query<{ wcet_at_epoch: number }, []>(
        "SELECT wcet_at_epoch FROM v_task_actual_epoch WHERE tid = 't3'",
      )
      .get()!.wcet_at_epoch;
    // (1000*15)/15 = 1000 per counted request; auxiliary would have made it 3000.
    expect(wcet).toBe(2000);
  });

  test("v_task_actual still COUNTS auxiliary in the spend total and splits it out", () => {
    task("t4");
    request("s_main", { tid: "t4", origin: "main", out_tok: 1000 });
    request("s_aux", { tid: "t4", origin: "auxiliary", out_tok: 1000 });

    const row = db
      .query<{ wcet: number; wcet_task_effort: number; wcet_aux: number }, []>(
        "SELECT wcet, wcet_task_effort, wcet_aux FROM v_task_actual WHERE tid = 't4'",
      )
      .get()!;
    expect(row.wcet).toBe(2000); // Spend-CET style: auxiliary is real money
    expect(row.wcet_task_effort).toBe(1000); // what calibration reads
    expect(row.wcet_aux).toBe(1000);
  });

  test("overhead is excluded from the epoch actual, as before", () => {
    task("t5");
    estimate("t5");
    request("o_work", { tid: "t5", origin: "main", out_tok: 1000 });
    request("o_ovh", { tid: "t5", origin: "main", out_tok: 1000, attr: "overhead" });

    const wcet = db
      .query<{ wcet_at_epoch: number }, []>(
        "SELECT wcet_at_epoch FROM v_task_actual_epoch WHERE tid = 't5'",
      )
      .get()!.wcet_at_epoch;
    expect(wcet).toBe(1000);
  });

  test("the epoch actual picks the >200k tier in force AT THE EPOCH", () => {
    price("claude-test-1@above_200k", { in: 6, out: 22.5, cw: 7.5, cr: 0.6 });
    task("t6");
    estimate("t6");
    request("e_hi", { tid: "t6", origin: "main", in_tok: 300_000, out_tok: 1000 });
    const wcet = db
      .query<{ wcet_at_epoch: number }, []>(
        "SELECT wcet_at_epoch FROM v_task_actual_epoch WHERE tid = 't6'",
      )
      .get()!.wcet_at_epoch;
    expect(wcet).toBe(1500); // (1000 * 22.5) / 15
  });

  // -- the actual is denominated ONCE, at issue time ------------------------
  // A measurement whose unit can be changed after the fact is not a measurement.
  // `est config set ref_model` / `set estimand` are one-line changes; neither may
  // reach backwards into a number the corpus has already recorded.

  const epochWcet = (tid: string): number | null =>
    db
      .query<{ wcet_at_epoch: number | null }, [string]>(
        "SELECT wcet_at_epoch FROM v_task_actual_epoch WHERE tid = ?",
      )
      .get(tid)?.wcet_at_epoch ?? null;

  test("a later ref_model flip does NOT restate an already-measured actual", () => {
    price("claude-opus-5", { in: 15, out: 75, cw: 18.75, cr: 1.5 });
    task("t7");
    estimate("t7", { ref_model: "claude-sonnet-4-5" });
    request("u_main", { tid: "t7", origin: "main", out_tok: 1000 });
    expect(epochWcet("t7")).toBe(1000); // (1000*15)/15, in sonnet output-equivalents

    // The flip the design explicitly anticipates. It touches no request, no price
    // row and no estimate — so it must move no actual.
    db.query("UPDATE config SET v = 'claude-opus-5' WHERE k = 'ref_model'").run();
    // Normalising by opus's 75 would have reported 200: a 5x restatement, arriving
    // inside v_velocity labelled `ref_model = 'claude-sonnet-4-5'` (the view projects
    // e.ref_model), i.e. mis-denominated without ever looking mislabelled.
    expect(epochWcet("t7")).toBe(1000);
  });

  test("the counter set comes from the estimate's estimand, not from config", () => {
    task("t8");
    estimate("t8", { estimand: "out" }); // out only: cache-creation is NOT in this unit
    request("v_main", { tid: "t8", origin: "main", out_tok: 1000, cw_tok: 4000 });
    // 'out' => (1000*15)/15. Hardcoding work_cet would have added (4000*3.75)/15.
    expect(epochWcet("t8")).toBe(1000);

    task("t9");
    estimate("t9", { estimand: "out_cw_in" });
    request("v_main9", { tid: "t9", origin: "main", in_tok: 5000, out_tok: 1000, cw_tok: 4000 });
    // (1000*15 + 4000*3.75 + 5000*3)/15
    expect(epochWcet("t9")).toBe(3000);

    // And config cannot reach in either: t8 stays an 'out' measurement.
    db.query("UPDATE config SET v = 'out_cw_in' WHERE k = 'estimand'").run();
    expect(epochWcet("t8")).toBe(1000);
  });

  test("an estimand outside §4.1 yields NULL rather than a number in an unknown unit", () => {
    task("t10");
    estimate("t10", { estimand: "typo_cet" });
    request("w_main", { tid: "t10", origin: "main", out_tok: 1000, cw_tok: 1000 });
    // NULL is what v_velocity's `actual_wcet_at_epoch IS NOT NULL` filter excludes,
    // so a bad unit costs the corpus a row instead of poisoning it with one.
    expect(epochWcet("t10")).toBeNull();
  });

  test("refclass keys on the unit, so two units coexist at one as_of", () => {
    const snapshot = (asOf: string, refModel: string): void => {
      db.query(
        `INSERT INTO refclass (as_of, bucket, estimator_family, n, n_eff, med_log_v, iqr_log_v,
                               shrink_w, shrink_k, half_life_days, mult_p50, mult_p90,
                               boot_lo_p50, boot_hi_p50, boot_lo_p90, boot_hi_p90,
                               method, ref_model, estimand, params_json)
         VALUES (?, 'global', '*', 12, 9.5, 1.1, 0.4, 0.545, 10, 30, 3.0, 6.0,
                 NULL, NULL, NULL, NULL, 'bootstrap', ?, 'work_cet', '{}')`,
      ).run(asOf, refModel);
    };
    snapshot("2026-02-01T00:00:00Z", "claude-sonnet-4-5");
    // Under a (as_of, bucket, estimator_family) key this was a PRIMARY KEY violation
    // on a table nothing may update or delete, so the units could not both exist.
    snapshot("2026-02-01T00:00:00Z", "claude-opus-5");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM refclass").get()!.n).toBe(2);
    // The same unit twice is still a duplicate, which is what append-only means.
    expect(() => snapshot("2026-02-01T00:00:00Z", "claude-opus-5")).toThrow(/UNIQUE constraint/i);
  });
});

// ---------------------------------------------------------------------------
// The v5 -> v6 migration reaches the same shape schema.sql builds from scratch
// ---------------------------------------------------------------------------

describe("schema migration", () => {
  /**
   * Downgrade the unit-keyed objects to their v5 shape in place, then let `openDb`
   * migrate the file forward. `schema.sql` is the only source of shape, so the test
   * of a migration is that it lands on exactly what a fresh database has — not that
   * it runs without error.
   */
  test("a downgraded database migrates to the same refclass and epoch view a fresh one has", () => {
    db.exec(`
      DROP TRIGGER rc_ro_u;
      DROP TRIGGER rc_ro_d;
      CREATE TABLE refclass_v5 (
        as_of TEXT NOT NULL,
        bucket TEXT NOT NULL REFERENCES bucket_def(bucket),
        estimator_family TEXT NOT NULL,
        n INTEGER NOT NULL, n_eff REAL NOT NULL,
        med_log_v REAL NOT NULL, iqr_log_v REAL NOT NULL,
        shrink_w REAL NOT NULL, shrink_k REAL NOT NULL, half_life_days REAL NOT NULL,
        mult_p50 REAL NOT NULL, mult_p90 REAL NOT NULL,
        boot_lo_p50 REAL, boot_hi_p50 REAL,
        boot_lo_p90 REAL, boot_hi_p90 REAL,
        method TEXT NOT NULL CHECK (method IN ('plugin','bootstrap')),
        estimand TEXT NOT NULL, params_json TEXT NOT NULL,
        PRIMARY KEY (as_of, bucket, estimator_family)
      ) STRICT, WITHOUT ROWID;
      DROP TABLE refclass;
      ALTER TABLE refclass_v5 RENAME TO refclass;
      INSERT INTO refclass VALUES ('2026-02-01T00:00:00Z','global','*',12,9.5,1.1,0.4,
        0.545,10,30,3.0,6.0,NULL,NULL,NULL,NULL,'bootstrap','work_cet',
        '{"ref_model":"claude-opus-5","cold_start_n":10}');
      INSERT INTO refclass VALUES ('2026-01-01T00:00:00Z','global','*',5,5,0.9,0.3,
        0.33,10,30,2.0,4.0,NULL,NULL,NULL,NULL,'plugin','work_cet','{}');
      DROP VIEW v_task_actual_epoch;
      CREATE VIEW v_task_actual_epoch AS
      SELECT r.tid,
        SUM(CAST((r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw) / rf.usd_out AS INTEGER)) AS wcet_at_epoch,
        e.price_epoch, e.eid AS eid_at_start
      FROM v_request_live r
      JOIN estimate e ON e.eid = (SELECT MIN(eid) FROM estimate WHERE tid = r.tid)
      JOIN model_price pe ON pe.family = r.model_family
       AND pe.effective_from = (SELECT MAX(effective_from) FROM model_price
                                WHERE family = pe.family AND effective_from <= e.price_epoch)
      JOIN model_price rf ON rf.family = (SELECT v FROM config WHERE k='ref_model')
       AND rf.effective_from = (SELECT MAX(effective_from) FROM model_price
                                WHERE family = rf.family AND effective_from <= e.price_epoch)
      WHERE r.tid IS NOT NULL AND r.attr <> 'overhead'
        AND r.origin IN ('main','subagent')
      GROUP BY r.tid;
      UPDATE config SET v = '5' WHERE k = 'schema_version';
    `);
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

    // Both rows survive, and ref_model is backfilled from params_json where it was,
    // falling back to the config value in force for a snapshot that never carried it.
    expect(
      db
        .query<{ as_of: string; ref_model: string; n: number }, []>(
          "SELECT as_of, ref_model, n FROM refclass ORDER BY as_of",
        )
        .all(),
    ).toEqual([
      { as_of: "2026-01-01T00:00:00Z", ref_model: "claude-sonnet-4-5", n: 5 },
      { as_of: "2026-02-01T00:00:00Z", ref_model: "claude-opus-5", n: 12 },
    ]);
    // Rebuilt, not abandoned: the append-only triggers came back with the table.
    expect(() => db.query("UPDATE refclass SET n = 99").run()).toThrow(/append-only/);

    const freshDir = mkdtempSync(join(tmpdir(), "estimator-schema-fresh-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const shape = (d: Database, table: string): unknown =>
        d
          .query<unknown, []>(
            `SELECT name, type, "notnull", pk FROM pragma_table_info('${table}') ORDER BY name`,
          )
          .all();
      const definition = (d: Database, name: string): string =>
        d.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?").get(name)!
          .sql;
      expect(shape(db, "refclass")).toEqual(shape(fresh, "refclass"));
      expect(definition(db, "v_task_actual_epoch")).toBe(definition(fresh, "v_task_actual_epoch"));
      expect(
        db
          .query<unknown, []>(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all(),
      ).toEqual(
        fresh
          .query<unknown, []>(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all(),
      );
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

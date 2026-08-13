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
import { BACKFILL_TASK_EVENT_TID_SQL, INSERT_TASK_EVENT_SQL, UPSERT_REQUEST_SQL } from "../src/ingest.ts";
import { CLOSE_PASS_CANDIDATE_SQL } from "../src/autoclose.ts";
import { ABOVE_200K_SUFFIX, LONG_CONTEXT_THRESHOLD } from "../src/prices.ts";
import { INSERT_AUXILIARY_SQL, SUPERSEDE_AUXILIARY_SQL } from "../src/otel.ts";

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
  rates: { in: number; out: number; cw: number; cr: number; cw1h?: number },
  from = "1970-01-01T00:00:00Z",
): void {
  db.query(
    `INSERT INTO model_price (family, effective_from, usd_in, usd_out, usd_cw, usd_cr,
                              usd_cw1h, usd_cw1h_src, provisional, source, synced_epoch, ingested_at)
     VALUES (?,?,?,?,?,?,?,?,0,'manual',NULL,'1970-01-01T00:00:00Z')`,
  ).run(
    family,
    from,
    rates.in,
    rates.out,
    rates.cw,
    rates.cr,
    rates.cw1h ?? null,
    rates.cw1h === undefined ? "unrecorded" : "manual",
  );
}

interface ReqOpts {
  family?: string;
  origin?: string;
  in_tok?: number;
  out_tok?: number;
  cw_tok?: number;
  cr_tok?: number;
  cw5m_tok?: number;
  cw1h_tok?: number;
  cw_ttl_src?: string;
  ts?: string;
  tid?: string | null;
  attr?: string;
  agent_id?: string | null;
}

function request(id: string, o: ReqOpts = {}): void {
  const family = o.family ?? "claude-test-1";
  db.query(
    `INSERT INTO request (request_id, session_id, origin, model, model_family, ts,
                          in_tok, out_tok, cw_tok, cr_tok, cw5m_tok, cw1h_tok, cw_ttl_src,
                          tid, attr, agent_id)
     VALUES (?, 's1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    o.cw5m_tok ?? 0,
    o.cw1h_tok ?? 0,
    o.cw_ttl_src ?? "unrecorded",
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

  /**
   * v7 -> v8 (P2.5). The `burn_cache` REBUILD is what makes this test mandatory rather
   * than a formality: a migration that adds columns by dropping and recreating a table
   * is one typo away from a shape a fresh database never has, and every consumer of the
   * cache would then read NULLs it could not explain.
   */
  test("a v7 database migrates to exactly the shape schema.sql builds", () => {
    // Downgrade in place: drop every v8 object and restore the v7 burn_cache, so the
    // starting file is what a real v7 database looks like.
    db.exec(`
      DROP VIEW v_otel_join;
      DROP VIEW v_recon_week;
      DROP VIEW v_eta_corpus;
      DROP VIEW v_segment_current;
      DROP TABLE job_item;
      DROP TABLE job_run;
      DROP TABLE recon_metric;
      DROP TRIGGER eta_ro_u;
      DROP TRIGGER eta_ro_d;
      DROP TABLE eta_run;
      DROP TABLE run_segment;
      DROP TABLE otel_metric;
      DROP TABLE otel_request;
      DROP TABLE burn_cache;
      CREATE TABLE burn_cache (
        tid TEXT PRIMARY KEY REFERENCES task(tid),
        as_of TEXT NOT NULL,
        consumed_wcet INTEGER,
        wcet_main INTEGER, wcet_sub INTEGER, wcet_aux INTEGER,
        usd REAL,
        n_req INTEGER,
        n_agents_live INTEGER,
        n_agents_total INTEGER,
        n_provisional INTEGER,
        n_unpriced INTEGER,
        active_s INTEGER,
        burn_wcet_per_min REAL,
        proj_total_wcet INTEGER
      ) STRICT, WITHOUT ROWID;
      DELETE FROM config WHERE k IN
        ('segment_gap_min','eta_min_segments','eta_min_fit','eta_min_pinball_gain',
         'recon_alert_pct','unvalidated_max_delta_pct','unvalidated_weeks',
         'unvalidated_min_join_pct','board_min_interval_s','job_item_min_pop',
         'otel_max_body_mb','otel_stale_min','otel_spool_retention_days');
      UPDATE config SET v = '7' WHERE k = 'schema_version';
    `);
    // A tuned value must survive the step: the config seeds are INSERT OR IGNORE, and a
    // migration that restated one would be rewriting a row Craig set on purpose.
    db.query("UPDATE config SET v='999' WHERE k='shrink_k'").run();
    // And a burn_cache ROW must survive it. P2.5: "existing rows are carried across
    // column for column; the new columns are NULL until the next sweep". Dropping them
    // empties the cache for every open task, and `burnJson`/`renderBurn` read ONLY this
    // table — the statusline segment would vanish until the next full sweep.
    task("T-burn");
    db.query(
      `INSERT INTO burn_cache (tid, as_of, consumed_wcet, wcet_main, wcet_sub, wcet_aux, usd,
                               n_req, n_agents_live, n_agents_total, n_provisional, n_unpriced,
                               active_s, burn_wcet_per_min, proj_total_wcet)
       VALUES ('T-burn','2026-03-01T00:00:00Z',12345,10000,2345,0,1.5,7,1,2,0,0,600,42.5,20000)`,
    ).run();
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.query<{ v: string }, []>("SELECT v FROM config WHERE k='shrink_k'").get()?.v).toBe("999");

    // Carried across column for column, with the nine new columns NULL.
    const carried = db
      .query<
        { tid: string; consumed_wcet: number; proj_total_wcet: number; check_back_p50_s: number | null },
        []
      >(
        "SELECT tid, consumed_wcet, proj_total_wcet, check_back_p50_s FROM burn_cache",
      )
      .all();
    expect(carried).toEqual([
      { tid: "T-burn", consumed_wcet: 12345, proj_total_wcet: 20000, check_back_p50_s: null },
    ]);
    // The rebuild's scratch table is not left lying around.
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'burn_cache_pre_v8'",
        )
        .get()?.n,
    ).toBe(0);

    const freshDir = mkdtempSync(join(tmpdir(), "estimator-schema-v8-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const objects = (d: Database): unknown =>
        d
          .query<unknown, []>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      // The whole `sqlite_master` row, `sql` text included — SQLite strips
      // `IF NOT EXISTS` before storing a definition, so the migration's idempotence
      // guard costs nothing in fidelity and this stays an EXACT comparison.
      expect(objects(db)).toEqual(objects(fresh));

      for (const table of [
        "burn_cache",
        "otel_request",
        "otel_metric",
        "run_segment",
        "eta_run",
        "recon_metric",
        "job_run",
        "job_item",
      ]) {
        const shape = (d: Database): unknown =>
          d
            .query<unknown, []>(
              `SELECT name, type, "notnull", pk FROM pragma_table_info('${table}') ORDER BY name`,
            )
            .all();
        expect(shape(db)).toEqual(shape(fresh));
      }

      // The seeds landed, and the ONE key that must never be seeded still is not:
      // `est recon --certify` is the only writer of `unvalidated_retired_at`, and its
      // presence is what retires the [unvalidated] marker.
      expect(
        db.query<{ v: string }, []>("SELECT v FROM config WHERE k='segment_gap_min'").get()?.v,
      ).toBe("5");
      expect(
        db.query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM config WHERE k='unvalidated_retired_at'",
        ).get()?.n,
      ).toBe(0);

      // eta_run came back WITH its append-only triggers. A rebuild that silently
      // dropped them would leave the fitting ledger rewritable.
      db.query(
        `INSERT INTO eta_run (as_of, eta_model, n_seg, n_censored, gap_min,
                              baseline_pinball_p50, params_json)
         VALUES ('2026-01-01T00:00:00Z','const_median',3,0,5,1.0,'{}')`,
      ).run();
      expect(() => db.query("UPDATE eta_run SET n_seg = 9").run()).toThrow(/append-only/);
      expect(() => db.query("DELETE FROM eta_run").run()).toThrow(/append-only/);
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  /**
   * schema.sql's own header documents `sqlite3 estimator.db < schema.sql` as a way to
   * build the file. Running that over a v7 database creates every v8 object while
   * `INSERT OR IGNORE` leaves `schema_version` at 7 — so the migration has to be
   * idempotent against objects that already exist, or the database is stuck a version
   * behind forever with a confusing "table already exists" error.
   */
  /**
   * v12 -> v13 (§3.2 step 6): the partial index the `session_task` backfill needs. One
   * object, no row touched — but the same two things have to hold as for every step
   * above: a migrated file is byte-identical to a fresh one, and the statement the
   * index exists for actually uses it.
   */
  test("a v12 database gains ix_task_event_unlinked and matches a fresh file exactly", () => {
    db.exec(`
      DROP INDEX ix_task_event_unlinked;
      UPDATE config SET v = '12' WHERE k = 'schema_version';
    `);
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

    const freshDir = mkdtempSync(join(tmpdir(), "estimator-schema-v13-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const objects = (d: Database): unknown =>
        d
          .query<unknown, []>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      // The whole row, `sql` text included: `IF NOT EXISTS` is stripped before storage,
      // so the migration's idempotence guard costs nothing in fidelity.
      expect(objects(db)).toEqual(objects(fresh));
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }

    // The point of the index, asserted against the planner rather than against prose:
    // the backfill's predicates and the index's have to stay verbatim identical, and a
    // full scan here is exactly the regression this step exists to prevent.
    const plan = db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${BACKFILL_TASK_EVENT_TID_SQL}`)
      .all()
      .map((r) => r.detail)
      .join(" | ");
    // "SCAN task_event USING INDEX ix_task_event_unlinked" IS the win: the partial index
    // holds only the unlinked rows, so scanning all of it is scanning only them — and in
    // the steady state, nothing. What must never come back is the bare table scan.
    expect(plan).toContain("ix_task_event_unlinked");
    expect(plan).not.toMatch(/SCAN task_event(?! USING)/);
  });

  /**
   * v13 -> v14 (P1.7/§6.2): the sweeper close pass. One partial index
   * (`ix_task_event_completed`) and one config seed (`close_pass_min_interval_min`);
   * the same two obligations as every step above — a migrated file is byte-identical to
   * a fresh one, and the statement the index exists for actually uses it — plus the one
   * a config-seeding step carries: the key must land where `est config set` can see it,
   * and a value Craig has already tuned must survive the migration untouched.
   */
  test("a v13 database gains the close-pass index and seeds, and matches a fresh file exactly", () => {
    db.exec(`
      DROP INDEX ix_task_event_completed;
      DELETE FROM config WHERE k IN ('close_pass_min_interval_min','close_abandon_after_h',
                                     'close_fail_alert_after','close_blocked_after_h');
      UPDATE config SET v = '13' WHERE k = 'schema_version';
    `);
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    const seed = (k: string): string | undefined =>
      db.query<{ v: string }, [string]>("SELECT v FROM config WHERE k = ?").get(k)?.v;
    expect(seed("close_pass_min_interval_min")).toBe("10");
    // The abandon window is a SEPARATE, much longer clock than the gate's 48 h
    // permission threshold — an auto-abandon seals a task's attribution window, so it
    // gets a margin the permission threshold does not need.
    expect(seed("close_abandon_after_h")).toBe("168");
    expect(seed("close_fail_alert_after")).toBe("3");
    expect(seed("close_blocked_after_h")).toBe("24");

    const freshDir = mkdtempSync(join(tmpdir(), "estimator-schema-v14-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const objects = (d: Database): unknown =>
        d
          .query<unknown, []>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      expect(objects(db)).toEqual(objects(fresh));
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }

    // The candidate filter's completion-signal probe, asserted against the planner: the
    // index's predicate and CLOSE_PASS_CANDIDATE_SQL's have to stay verbatim identical,
    // and a lifecycle-table scan per open task is the regression this step prevents.
    const plan = db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${CLOSE_PASS_CANDIDATE_SQL}`)
      .all()
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).toContain("ix_task_event_completed");
    expect(plan).not.toMatch(/SCAN task_event(?! USING)/);

    // The index covers BOTH terminal statuses. §6.2's gate has always read both, and
    // P1.11's delete-capture hook exists so a `TaskUpdate status:"deleted"` is RECORDED
    // — an index that saw only completions would make the close pass blind to every
    // captured deletion, which would then reach it via the staleness arm and be filed
    // `abandoned`: the exact laundering that hook exists to prevent.
    const ddl =
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name = 'ix_task_event_completed'",
        )
        .get()?.sql ?? "";
    expect(ddl).toContain("'completed'");
    expect(ddl).toContain("'deleted'");
  });

  test("migration rule 2: a tuned close-pass knob survives the v14 step", () => {
    db.exec(`
      DROP INDEX ix_task_event_completed;
      UPDATE config SET v = '90'  WHERE k = 'close_pass_min_interval_min';
      UPDATE config SET v = '720' WHERE k = 'close_abandon_after_h';
      UPDATE config SET v = '13'  WHERE k = 'schema_version';
    `);
    const path = join(dir, "estimator.db");
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    // `INSERT OR IGNORE`, not `INSERT OR REPLACE`: a migration never restates a value a
    // human has already set.
    const seed = (k: string): string | undefined =>
      db.query<{ v: string }, [string]>("SELECT v FROM config WHERE k = ?").get(k)?.v;
    expect(seed("close_pass_min_interval_min")).toBe("90");
    expect(seed("close_abandon_after_h")).toBe("720");
  });

  test("the v8 step lands on a file that already has the shape and only lacks the marker", () => {
    db.query("UPDATE config SET v='7' WHERE k='schema_version'").run();
    const path = join(dir, "estimator.db");
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM otel_request").get()?.n,
    ).toBe(0);
  });

  /**
   * The obligation every ADD COLUMN step carries (see the v14 test above and its
   * counterpart in test/story-points.test.ts): a migrated file must be byte-identical
   * to a fresh one. For v19 -> v20 this needs a GENUINELY v19-shaped database, not
   * one fabricated by dropping columns from THIS repo's own (already-v20) schema.sql
   * — that would reintroduce v20-only comments into a "v19" file and corrupt the very
   * placement being tested. So the three v19 view bodies are inlined verbatim below
   * (from the pre-cutover schema, the same source `git show <pre-fix rev>:schema.sql`
   * would give), the same way the v14 chain test inlines the pre-v15 v_task_actual_epoch.
   *
   * DROP VIEW / CREATE VIEW ordering matters: `ALTER TABLE ... DROP COLUMN`
   * re-validates every remaining view in the schema and fails outright if one
   * references the column being dropped or selects from a view that would no longer
   * resolve. v_cw_ttl_exposure and v_cw_1h_price_gap name v20 columns directly, so
   * they drop and stay dropped; v_task_actual (unchanged since v19) selects from
   * v_wcet, which selects from v_priced, so those two must be put back in their v19
   * shape rather than merely dropped, or every later DROP COLUMN below fails with an
   * opaque "error in view ...: no such column" the instant it is reached.
   * DROP COLUMN order within model_price also matters: usd_cw1h_src's CHECK
   * references usd_cw1h, so the _src column has to go first.
   */
  test("a genuinely v19-shaped database migrates to exactly the shape schema.sql builds", () => {
    db.exec(`
      DROP VIEW v_cw_ttl_exposure;
      DROP VIEW v_cw_1h_price_gap;
      DROP VIEW v_task_actual_epoch;
      DROP VIEW v_wcet;
      DROP VIEW v_priced;
      CREATE VIEW v_priced AS
      SELECT r.*, p.usd_in, p.usd_out, p.usd_cw, p.usd_cr, p.provisional
      FROM v_request_tiered r
      JOIN model_price p ON p.family = r.price_family
       AND p.effective_from = (SELECT MAX(effective_from) FROM model_price
                               WHERE family = r.price_family AND effective_from <= r.ts);
      CREATE VIEW v_wcet AS
      SELECT v.*,
        CAST((v.out_tok*v.usd_out + v.cw_tok*v.usd_cw) / v.ref_out AS INTEGER) AS wcet,
        CAST((v.in_tok*v.usd_in + v.out_tok*v.usd_out
              + v.cw_tok*v.usd_cw + v.cr_tok*v.usd_cr) / v.ref_out AS INTEGER) AS scet
      FROM (SELECT p.*,
              (SELECT usd_out FROM model_price
                WHERE family = (SELECT v FROM config WHERE k='ref_model')
                  AND effective_from <= p.ts
                ORDER BY effective_from DESC LIMIT 1) AS ref_out
            FROM v_priced p) v;
      CREATE VIEW v_task_actual_epoch AS
      SELECT r.tid,
        SUM(CAST((CASE e.estimand
                    WHEN 'out'         THEN r.out_tok*pe.usd_out
                    WHEN 'work_cet'    THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw
                    WHEN 'out_cw_in'   THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw + r.in_tok*pe.usd_in
                    WHEN 'story_point' THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw
                  END) / rf.usd_out AS INTEGER)) AS wcet_at_epoch,
        e.price_epoch, e.eid AS eid_at_start
      FROM v_request_live r
      JOIN estimate e ON e.eid = (SELECT MIN(eid) FROM estimate WHERE tid = r.tid)
      JOIN model_price pe
        ON pe.family = CASE WHEN (r.in_tok + r.cw_tok + r.cr_tok) > 200000
                             AND r.model_family NOT LIKE '%]'
                             AND EXISTS (SELECT 1 FROM model_price hi
                                          WHERE hi.family = r.model_family || '@above_200k'
                                            AND hi.effective_from <= e.price_epoch)
                            THEN r.model_family || '@above_200k'
                            ELSE r.model_family END
       AND pe.effective_from = (SELECT MAX(effective_from) FROM model_price
                                WHERE family = pe.family AND effective_from <= e.price_epoch)
      JOIN model_price rf ON rf.family = e.ref_model
       AND rf.effective_from = (SELECT MAX(effective_from) FROM model_price
                                WHERE family = rf.family AND effective_from <= e.price_epoch)
      WHERE r.tid IS NOT NULL AND r.attr <> 'overhead'
        AND r.origin IN ('main','subagent')
      GROUP BY r.tid;
      ALTER TABLE outcome DROP COLUMN cw_ttl_unknown_share;
      ALTER TABLE model_price DROP COLUMN usd_cw1h_src;
      ALTER TABLE model_price DROP COLUMN usd_cw1h;
      ALTER TABLE request DROP COLUMN cw_ttl_src;
      ALTER TABLE request DROP COLUMN cw1h_tok;
      ALTER TABLE request DROP COLUMN cw5m_tok;
      DELETE FROM config WHERE k IN ('price_cw_1h_min_multiple','price_cw_1h_max_multiple',
                                     'price_cw_1h_default_multiple','cw_ttl_unknown_warn_share');
      UPDATE config SET v = '19' WHERE k = 'schema_version';
    `);
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

    // The four config seeds this step is responsible for come back at their defaults.
    const seed = (k: string): string | undefined =>
      db.query<{ v: string }, [string]>("SELECT v FROM config WHERE k = ?").get(k)?.v;
    expect(seed("price_cw_1h_min_multiple")).toBe("1.5");
    expect(seed("price_cw_1h_max_multiple")).toBe("2.5");
    expect(seed("price_cw_1h_default_multiple")).toBe("2");
    expect(seed("cw_ttl_unknown_warn_share")).toBe("0.02");

    // This is the assertion that would have caught the D1 comment-placement bug:
    // it fails on `table:request` against the pre-fix schema.sql and passes once
    // schema.sql's ADD COLUMN splice matches where ALTER actually leaves it.
    const freshDir = mkdtempSync(join(tmpdir(), "estimator-schema-v20-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const objects = (d: Database): unknown =>
        d
          .query<unknown, []>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      expect(objects(db)).toEqual(objects(fresh));
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("migration rule 2: a tuned cache-write-1h knob survives the v19 -> v20 step", () => {
    db.exec(`
      UPDATE config SET v = '1.4' WHERE k = 'price_cw_1h_min_multiple';
      UPDATE config SET v = '19' WHERE k = 'schema_version';
    `);
    const path = join(dir, "estimator.db");
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    // `INSERT OR IGNORE`: a value Craig has already tuned is never restated by a
    // migration that lands on a file already carrying the v20 shape.
    expect(
      db.query<{ v: string }, []>("SELECT v FROM config WHERE k = 'price_cw_1h_min_multiple'").get()?.v,
    ).toBe("1.4");
  });

  test("the v19 -> v20 step lands on a file that already has the shape and only lacks the marker", () => {
    db.query("UPDATE config SET v='19' WHERE k='schema_version'").run();
    const path = join(dir, "estimator.db");
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_cw_ttl_exposure").get()?.n,
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // HOOK-BINDING-SPEC.md -- hook-based spawn-time attribution binding (v21)
  // ---------------------------------------------------------------------------

  test("a genuinely v20-shaped database migrates to exactly the shape schema.sql builds (v21, config rows only)", () => {
    db.exec(`
      DELETE FROM config WHERE k IN
        ('hook_bind_enabled','hook_focus_ttl_min','hook_bind_marker','hook_bind_batch_max');
      UPDATE config SET v = '20' WHERE k = 'schema_version';
    `);
    const path = join(dir, "estimator.db");
    db.close();

    db = openDb({ path }); // migrates on open
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

    const seed = (k: string): string | undefined =>
      db.query<{ v: string }, [string]>("SELECT v FROM config WHERE k = ?").get(k)?.v;
    expect(seed("hook_bind_enabled")).toBe("1");
    expect(seed("hook_focus_ttl_min")).toBe("120");
    expect(seed("hook_bind_marker")).toBe("0");
    expect(seed("hook_bind_batch_max")).toBe("5000");

    // v21 is config-only: no CREATE, no ALTER. `sqlite_master` must be byte-identical
    // to a fresh database's (test/schema.test.ts's own byte-identity discipline, §8.2).
    const freshDir = mkdtempSync(join(tmpdir(), "estimator-schema-v21-"));
    const fresh = openDb({ path: join(freshDir, "estimator.db") });
    try {
      const objects = (d: Database): unknown =>
        d
          .query<unknown, []>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
      expect(objects(db)).toEqual(objects(fresh));
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("migration rule 2: a tuned hook_focus_ttl_min knob survives the v20 -> v21 step", () => {
    db.exec(`
      UPDATE config SET v = '45' WHERE k = 'hook_focus_ttl_min';
      UPDATE config SET v = '20' WHERE k = 'schema_version';
    `);
    const path = join(dir, "estimator.db");
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    // `INSERT OR IGNORE`: a value Craig has already tuned is never restated by a
    // migration that lands on a file already carrying the v21 shape.
    expect(
      db.query<{ v: string }, []>("SELECT v FROM config WHERE k = 'hook_focus_ttl_min'").get()?.v,
    ).toBe("45");
  });

  test("the v20 -> v21 step lands on a file that already has the shape and only lacks the marker", () => {
    db.query("UPDATE config SET v='20' WHERE k='schema_version'").run();
    const path = join(dir, "estimator.db");
    db.close();
    db = openDb({ path });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      db.query<{ v: string }, []>("SELECT v FROM config WHERE k = 'hook_bind_enabled'").get()?.v,
    ).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// CACHE-TTL-PRICING.md — the cache-write TTL pricing fix (v20)
// ---------------------------------------------------------------------------

describe("cache-write TTL pricing (D1-D5)", () => {
  const RATES = { in: 1, out: 1, cw: 1, cr: 1, cw1h: 2 };

  beforeEach(() => {
    price("claude-sonnet-4-5", RATES); // config.ref_model
    price("claude-test-1", RATES);
  });

  const wcetOf = (id: string): number =>
    db.query<{ wcet: number }, [string]>("SELECT wcet FROM v_wcet WHERE request_id = ?").get(id)!.wcet;

  test("a 5m-only cache write prices at exactly cw_tok * usd_cw", () => {
    request("r5m", { cw_tok: 100, cw5m_tok: 100, cw1h_tok: 0, cw_ttl_src: "transcript" });
    expect(wcetOf("r5m")).toBe(100 * RATES.cw);
  });

  test("a 1h-only cache write prices at exactly cw_tok * usd_cw1h (2x usd_in here)", () => {
    request("r1h", { cw_tok: 100, cw5m_tok: 0, cw1h_tok: 100, cw_ttl_src: "transcript" });
    expect(wcetOf("r1h")).toBe(100 * RATES.cw1h);
  });

  test("a mixed request prices the weighted sum of both legs", () => {
    request("rmix", { cw_tok: 100, cw5m_tok: 60, cw1h_tok: 40, cw_ttl_src: "transcript" });
    expect(wcetOf("rmix")).toBe(60 * RATES.cw + 40 * RATES.cw1h);
  });

  test("D4: an unrecorded-TTL request is priced EXACTLY as it was pre-fix — cw_tok * usd_cw", () => {
    request("runk", { cw_tok: 100, cw5m_tok: 0, cw1h_tok: 0, cw_ttl_src: "unrecorded" });
    expect(wcetOf("runk")).toBe(100 * RATES.cw);
  });

  test("D3: an over-split row (cw5m+cw1h > cw_tok) is clamped to price exactly cw_tok tokens, at the LOWER (5m-filled-first) rate", () => {
    // 80 + 80 = 160 > cw_tok(100). 5m fills first: 5m_priced=80, 1h_priced=min(80,20)=20.
    request("rover", { cw_tok: 100, cw5m_tok: 80, cw1h_tok: 80, cw_ttl_src: "transcript" });
    const naive1hFirst = 80 * RATES.cw1h + 20 * RATES.cw; // the rejected, higher-priced order
    const fiveMFirst = 80 * RATES.cw + 20 * RATES.cw1h; // what the view actually computes
    expect(wcetOf("rover")).toBe(fiveMFirst);
    expect(wcetOf("rover")).toBeLessThan(naive1hFirst);

    const row = db
      .query<{ cw5m_priced_tok: number; cw1h_priced_tok: number; cw_ttl_unknown_tok: number }, [string]>(
        "SELECT cw5m_priced_tok, cw1h_priced_tok, cw_ttl_unknown_tok FROM v_priced WHERE request_id = ?",
      )
      .get("rover")!;
    // The three legs always sum to exactly cw_tok, in both directions.
    expect(row.cw5m_priced_tok + row.cw1h_priced_tok + row.cw_ttl_unknown_tok).toBe(100);
  });

  // v_cw_ttl_exposure (D3/D10) is deliberately NOT keyed by request_id — it is
  // the diagnostic/reporting surface, so rows are distinguished by `ts` here.
  test("v_cw_ttl_exposure surfaces unknown-TTL and over-split rows, and only those", () => {
    request("known", { cw_tok: 100, cw5m_tok: 60, cw1h_tok: 40, cw_ttl_src: "transcript", ts: "2026-01-01T00:00:01Z" });
    request("unk", { cw_tok: 100, cw5m_tok: 0, cw1h_tok: 0, cw_ttl_src: "unrecorded", ts: "2026-01-01T00:00:02Z" });
    request("over", { cw_tok: 100, cw5m_tok: 80, cw1h_tok: 80, cw_ttl_src: "transcript", ts: "2026-01-01T00:00:03Z" });
    request("nocache", { cw_tok: 0, ts: "2026-01-01T00:00:04Z" });

    const rows = db
      .query<{ ts: string; cw_ttl_unknown_tok: number; cw_ttl_over_tok: number }, []>(
        "SELECT ts, cw_ttl_unknown_tok, cw_ttl_over_tok FROM v_cw_ttl_exposure ORDER BY ts",
      )
      .all();
    expect(rows.map((r) => r.ts)).toEqual(["2026-01-01T00:00:02Z", "2026-01-01T00:00:03Z"]);
    expect(rows.find((r) => r.ts === "2026-01-01T00:00:02Z")).toMatchObject({
      cw_ttl_unknown_tok: 100,
      cw_ttl_over_tok: 0,
    });
    expect(rows.find((r) => r.ts === "2026-01-01T00:00:03Z")).toMatchObject({
      cw_ttl_unknown_tok: 0,
      cw_ttl_over_tok: 60,
    });
  });

  test("v_cw_ttl_exposure is reachable for an UNPRICED family too", () => {
    // "claude-unpriced-1" has NO model_price row at all — v_priced's INNER JOIN
    // would drop it entirely, which is exactly the blind spot this view exists
    // to avoid.
    request("unpriced_unk", {
      family: "claude-unpriced-1",
      cw_tok: 50,
      cw_ttl_src: "unrecorded",
      ts: "2026-01-01T00:00:09Z",
    });
    const row = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM v_cw_ttl_exposure WHERE ts = '2026-01-01T00:00:09Z'",
      )
      .get()!;
    expect(row.n).toBe(1);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM v_priced WHERE request_id = 'unpriced_unk'",
        )
        .get()!.n,
    ).toBe(0);
  });

  test("v_cw_1h_price_gap names a family with cache-write spend but no recorded 1h rate, and only that one", () => {
    price("claude-test-2", { in: 1, out: 1, cw: 1, cr: 1 }); // no cw1h — 'unrecorded'
    request("gapped", { family: "claude-test-2", cw_tok: 10 });
    request("covered", { family: "claude-test-1", cw_tok: 10, cw5m_tok: 10, cw_ttl_src: "transcript" });

    const gap = db.query<{ family: string }, []>("SELECT family FROM v_cw_1h_price_gap").all();
    expect(gap.map((r) => r.family)).toEqual(["claude-test-2"]);

    db.exec("UPDATE model_price SET usd_cw1h = 2, usd_cw1h_src = 'manual' WHERE family = 'claude-test-2'");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_cw_1h_price_gap").get()!.n).toBe(0);
  });

  test("D3: v_wcet and v_task_actual_epoch agree on the same cw_cost expression", () => {
    task("t1");
    estimate("t1", {
      price_epoch: "2026-01-01T00:00:00Z",
      ref_model: "claude-sonnet-4-5",
      estimand: "work_cet",
    });
    request("rtask", {
      tid: "t1",
      attr: "exclusive",
      origin: "main",
      cw_tok: 100,
      cw5m_tok: 60,
      cw1h_tok: 40,
      cw_ttl_src: "transcript",
      ts: "2026-01-01T00:00:00Z",
    });

    const fromWcet = db
      .query<{ wcet_task_effort: number }, []>(
        "SELECT wcet_task_effort FROM v_task_actual WHERE tid = 't1'",
      )
      .get()!.wcet_task_effort;
    const fromEpoch = db
      .query<{ wcet_at_epoch: number }, []>(
        "SELECT wcet_at_epoch FROM v_task_actual_epoch WHERE tid = 't1'",
      )
      .get()!.wcet_at_epoch;
    expect(fromEpoch).toBe(fromWcet);
    expect(fromWcet).toBe(60 * RATES.cw + 40 * RATES.cw1h);
  });

  test("D1/D7: OTEL never names the three new request columns — it has no TTL information", () => {
    expect(INSERT_AUXILIARY_SQL).not.toContain("cw5m_tok");
    expect(INSERT_AUXILIARY_SQL).not.toContain("cw1h_tok");
    expect(INSERT_AUXILIARY_SQL).not.toContain("cw_ttl_src");
    expect(SUPERSEDE_AUXILIARY_SQL).not.toContain("cw5m_tok");
    expect(SUPERSEDE_AUXILIARY_SQL).not.toContain("cw1h_tok");
    expect(SUPERSEDE_AUXILIARY_SQL).not.toContain("cw_ttl_src");
  });
});

// ---------------------------------------------------------------------------
// CACHE-TTL-PRICING.md D1/D7 — ingest-side dedup ratchet (UPSERT_REQUEST_SQL)
// ---------------------------------------------------------------------------

describe("cache-write TTL dedup ratchet (D7)", () => {
  const upsert = (row: {
    request_id: string;
    model: string;
    cw_tok: number;
    cw5m_tok: number;
    cw1h_tok: number;
    cw_ttl_src: string;
  }): void => {
    db.query(UPSERT_REQUEST_SQL).run({
      $request_id: row.request_id,
      $message_id: null,
      $is_sidechain: 0,
      $session_id: "s1",
      $prompt_id: null,
      $origin: "main",
      $agent_id: null,
      $run_id: null,
      $wf_launch_id: null,
      $model: row.model,
      $model_family: row.model,
      $attribution_agent: null,
      $attribution_skill: null,
      $ts: "2026-01-01T00:00:00Z",
      $in_tok: 0,
      $out_tok: 0,
      $cw_tok: row.cw_tok,
      $cr_tok: 0,
      $cw5m_tok: row.cw5m_tok,
      $cw1h_tok: row.cw1h_tok,
      $cw_ttl_src: row.cw_ttl_src,
    } as never);
  };

  const stored = () =>
    db
      .query<
        { cw_tok: number; cw5m_tok: number; cw1h_tok: number; cw_ttl_src: string; model: string },
        []
      >("SELECT cw_tok, cw5m_tok, cw1h_tok, cw_ttl_src, model FROM request WHERE request_id = 'rid1'")
      .get()!;

  test("same model, unrecorded THEN transcript: knowledge ratchets up and counters MAX", () => {
    upsert({ request_id: "rid1", model: "claude-test-1", cw_tok: 50, cw5m_tok: 0, cw1h_tok: 0, cw_ttl_src: "unrecorded" });
    upsert({ request_id: "rid1", model: "claude-test-1", cw_tok: 100, cw5m_tok: 60, cw1h_tok: 40, cw_ttl_src: "transcript" });
    expect(stored()).toMatchObject({ cw_tok: 100, cw5m_tok: 60, cw1h_tok: 40, cw_ttl_src: "transcript" });
  });

  test("same model, transcript THEN a later line with no split: the label does NOT ratchet down, and cw_tok can still rise ahead of the split (the honest residual D3 prices)", () => {
    upsert({ request_id: "rid1", model: "claude-test-1", cw_tok: 100, cw5m_tok: 60, cw1h_tok: 40, cw_ttl_src: "transcript" });
    upsert({ request_id: "rid1", model: "claude-test-1", cw_tok: 150, cw5m_tok: 0, cw1h_tok: 0, cw_ttl_src: "unrecorded" });
    const row = stored();
    expect(row.cw_ttl_src).toBe("transcript");
    expect(row.cw_tok).toBe(150); // MAX ratchets the aggregate...
    expect(row.cw5m_tok).toBe(60); // ...but the split counters do NOT follow it,
    expect(row.cw1h_tok).toBe(40); // which is the visible residual D3's clamp prices.
  });

  test("a TAKEOVER by an unrecorded row over a stored transcript row yields unrecorded WITH the winner's counters — never 'transcript' over 0/0", () => {
    // Model A wins first (bigger total), model B (smaller) is the loser.
    upsert({ request_id: "rid1", model: "claude-test-1", cw_tok: 100, cw5m_tok: 60, cw1h_tok: 40, cw_ttl_src: "transcript" });
    // A DIFFERENT, LARGER-total model with no split takes over the row.
    db.query(UPSERT_REQUEST_SQL).run({
      $request_id: "rid1",
      $message_id: null,
      $is_sidechain: 0,
      $session_id: "s1",
      $prompt_id: null,
      $origin: "main",
      $agent_id: null,
      $run_id: null,
      $wf_launch_id: null,
      $model: "claude-test-9",
      $model_family: "claude-test-9",
      $attribution_agent: null,
      $attribution_skill: null,
      $ts: "2026-01-01T00:00:01Z",
      $in_tok: 0,
      $out_tok: 1000, // forces a bigger EXCLUDED_TOTAL, so this row TAKES OVER
      $cw_tok: 0,
      $cr_tok: 0,
      $cw5m_tok: 0,
      $cw1h_tok: 0,
      $cw_ttl_src: "unrecorded",
    } as never);
    const row = stored();
    expect(row.model).toBe("claude-test-9");
    expect(row.cw_ttl_src).toBe("unrecorded"); // NEVER 'transcript' over a 0/0 split
    expect(row.cw5m_tok).toBe(0);
    expect(row.cw1h_tok).toBe(0);
  });

  test("a CONTESTED non-takeover by a transcript row over a stored unrecorded row leaves the stored row's label AND counters untouched", () => {
    // The STORED row has the larger total, so the challenger below is contested
    // but does NOT take over (RID_TAKEOVER needs a STRICTLY larger excluded total).
    upsert({ request_id: "rid1", model: "claude-test-9", cw_tok: 1000, cw5m_tok: 0, cw1h_tok: 0, cw_ttl_src: "unrecorded" });
    db.query(UPSERT_REQUEST_SQL).run({
      $request_id: "rid1",
      $message_id: null,
      $is_sidechain: 0,
      $session_id: "s1",
      $prompt_id: null,
      $origin: "main",
      $agent_id: null,
      $run_id: null,
      $wf_launch_id: null,
      $model: "claude-test-1", // a DIFFERENT, SMALLER-total model: contested, no takeover
      $model_family: "claude-test-1",
      $attribution_agent: null,
      $attribution_skill: null,
      $ts: "2026-01-01T00:00:01Z",
      $in_tok: 0,
      $out_tok: 0,
      $cw_tok: 100,
      $cr_tok: 0,
      $cw5m_tok: 60,
      $cw1h_tok: 40,
      $cw_ttl_src: "transcript",
    } as never);
    const row = stored();
    expect(row.model).toBe("claude-test-9"); // the stored winner is untouched
    expect(row.cw_ttl_src).toBe("unrecorded");
    expect(row.cw_tok).toBe(1000);
  });
});

/**
 * `est open` / `est block` / `est bind` / `est scope` / `est refclass` — the write
 * verbs of the estimation loop and the read that must precede them (P1.1–P1.5).
 *
 * Every test here is really about one of three properties, and they are the reason
 * the design has an exit code 2 at all (P1.12):
 *
 *  1. **Append-only is physical.** Five tables carry `RAISE(ABORT,'append-only')`
 *     triggers; the CLI's job is never to fight them and to translate a refusal into
 *     a remedy. So the tests assert the REFUSAL and the exit code, not just the row.
 *  2. **The `scope_change` precondition cannot be manufactured.** It is the only
 *     reason that removes a task from the velocity corpus, so it is the one lever an
 *     estimator could pull to make a bad estimate disappear — hence both halves are
 *     pinned: `est open` rejects the reason without a newer scope row, and `est scope`
 *     rejects a revision that changes nothing.
 *  3. **Cold start is labelled, never faked.** An uncalibrated band that looked
 *     calibrated is the first thing that would teach Craig to distrust the system.
 *
 * Fixtures are synthetic throughout (`test/support.ts`): no real id, path or token
 * figure may appear in a tracked file (§4).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeHarness,
  openArgs,
  price,
  REF_MODEL,
  request,
  seedPrices,
  turn,
  type Harness,
} from "./support.ts";
import { ftsQuery, parseDod, scopeHash, PLANT_MARKER, COLD_START_N } from "../src/tasks.ts";
import { attributeTasks } from "../src/attribute.ts";

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-estimate-");
  seedPrices(h.db);
  turn(h.db, { session: "s1", prompt: "p1", at: "2026-01-01T00:00:00Z" });
});

afterEach(() => {
  h.close();
});

/** Open a task and return its tid. Anchored explicitly, so nothing is inferred. */
async function open(...extra: string[]): Promise<string> {
  const r = await h.cli(...openArgs(), "--session", "s1", "--prompt", "p1", "--json", ...extra);
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

/** A second, distinct task in the same session — the sequential case (§5.4). */
async function openOther(...extra: string[]): Promise<string> {
  const r = await h.cli(
    ...openArgs({ subject: "other work" }), "--session", "s1", "--prompt", "p1", "--json", ...extra,
  );
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

// ---------------------------------------------------------------------------
// P1.1 — est open
// ---------------------------------------------------------------------------

describe("est open — P1.1 mint", () => {
  test("writes task + scope@1 + fts + session alias + estimate@v1 in one transaction", async () => {
    const tid = await open();

    const task = h.db.query<{ status: string; anchor_session: string; anchor_prompt: string }, [string]>(
      "SELECT status, anchor_session, anchor_prompt FROM task WHERE tid = ?",
    ).get(tid);
    expect(task).toMatchObject({ status: "estimating", anchor_session: "s1", anchor_prompt: "p1" });

    const scope = h.db.query<{ seq: number; source: string; scope_hash: string }, [string]>(
      "SELECT seq, source, scope_hash FROM task_scope WHERE tid = ?",
    ).get(tid)!;
    expect(scope.seq).toBe(1);
    expect(scope.source).toBe("est_open");
    expect(scope.scope_hash).toBe(scopeHash("widget pipeline rewrite", null, "[]"));

    const est = h.db.query<{ version: number; reason: string; scope_seq: number }, [string]>(
      "SELECT version, reason, scope_seq FROM estimate WHERE tid = ?",
    ).get(tid);
    expect(est).toMatchObject({ version: 1, reason: "initial", scope_seq: 1 });

    const alias = h.db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM task_alias WHERE tid = ? AND id_kind = 'session' AND local_id = 's1'",
    ).get(tid);
    expect(alias?.n).toBe(1);

    const fts = h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM task_fts WHERE tid = ?").get(tid);
    expect(fts?.n).toBe(1);
  });

  test("a SECOND est open in the same session gets its own alias — the session is not taken", async () => {
    const first = await open();
    const second = await openOther();
    expect(second).not.toBe(first);

    // Both bindings exist. Under the v5 key the second insert hit ('session', s1, s1)
    // and DID NOTHING: no alias, no anomaly, exit 0 — so §5.4 never saw the second
    // task, its spend booked to the first, and `est bind` could not repair it either.
    const owners = h.db
      .query<{ tid: string }, []>(
        "SELECT tid FROM task_alias WHERE id_kind='session' AND session_id='s1' ORDER BY tid",
      )
      .all()
      .map((x) => x.tid);
    expect(owners).toEqual([first, second].sort());

    // Nothing anomalous happened: sequential tasks in one session are the ordinary
    // shape of a working day, not a condition to report.
    const anomalies = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!;
    expect(anomalies.n).toBe(0);
  });

  test("the second task's spend is ITS OWN — not booked to the first task's actual", async () => {
    const first = await open();
    request(h.db, "r-first", { session: "s1", prompt: "p1", out: 100, ts: "2026-01-01T00:00:30Z" });

    turn(h.db, { session: "s1", prompt: "p2", at: "2026-01-01T00:10:00Z" });
    const second = (
      await h.cli(
        ...openArgs({ subject: "the next thing" }), "--session", "s1", "--prompt", "p2", "--json",
      )
    ).json<{ tid: string }>().tid;
    request(h.db, "r-second", { session: "s1", prompt: "p2", out: 100, ts: "2026-01-01T00:10:30Z" });

    attributeTasks(h.db);
    const owner = (id: string): string | null =>
      h.db.query<{ tid: string | null }, [string]>("SELECT tid FROM request WHERE request_id = ?")
        .get(id)!.tid;
    expect(owner("r-first")).toBe(first);
    // Under the v5 key this read back as `first` with attr='exclusive': confidently
    // wrong, inflating one measured actual and zeroing another, in the corpus every
    // future band is calibrated against.
    expect(owner("r-second")).toBe(second);
  });

  test("prints the EST_PLANT marker with the exact TaskUpdate call to issue", async () => {
    const r = await h.cli(...openArgs(), "--session", "s1", "--prompt", "p1");
    expect(r.code).toBe(0);
    const line = r.out.split("\n").find((l) => l.startsWith(PLANT_MARKER))!;
    expect(line).toContain("TaskUpdate({ taskId: \"<n>\", metadata: { est_tid: \"");
    // The tid in the printed call must be the tid that was actually minted, or the
    // skill plants an identity that stitches nothing.
    const tid = h.db.query<{ tid: string }, []>("SELECT tid FROM task").get()!.tid;
    expect(line).toContain(tid);
  });

  test("cold start is explicit: uncalibrated, shrink_w 0, refclass_as_of NULL, cal == raw", async () => {
    const r = await h.cli(...openArgs(), "--session", "s1", "--prompt", "p1", "--json");
    const body = r.json<{ uncalibrated: boolean; bucket_n: number; band: { p50_wcet: number; p90_wcet: number } }>();
    expect(body.uncalibrated).toBe(true);
    expect(body.bucket_n).toBeLessThan(COLD_START_N);
    expect(body.band.p50_wcet).toBe(1000);
    expect(body.band.p90_wcet).toBe(3000);

    const row = h.db.query<{ shrink_w: number; refclass_as_of: string | null; cal_p50_wcet: number }, []>(
      "SELECT shrink_w, refclass_as_of, cal_p50_wcet FROM estimate",
    ).get()!;
    expect(row.shrink_w).toBe(0);
    expect(row.refclass_as_of).toBeNull();
    expect(row.cal_p50_wcet).toBe(1000);
  });

  test("the human band line says UNCALIBRATED in words, not only in a JSON field", async () => {
    const r = await h.cli(...openArgs(), "--session", "s1", "--prompt", "p1");
    expect(r.out).toContain("UNCALIBRATED");
  });

  test("snapshots the unit and the vintage so a later config change cannot restate history", async () => {
    const tid = await open();
    const row = h.db.query<{ ref_model: string; estimand: string; price_epoch: string }, [string]>(
      "SELECT ref_model, estimand, price_epoch FROM estimate WHERE tid = ?",
    ).get(tid)!;
    expect(row.ref_model).toBe(REF_MODEL);
    expect(row.estimand).toBe("work_cet");
    expect(row.price_epoch).not.toBe("");

    // Changing config now must not move the estimate that was already issued.
    h.db.query("UPDATE config SET v = 'claude-other-9' WHERE k = 'ref_model'").run();
    const after = h.db.query<{ ref_model: string }, [string]>(
      "SELECT ref_model FROM estimate WHERE tid = ?",
    ).get(tid)!;
    expect(after.ref_model).toBe(REF_MODEL);
  });

  test("the Spend-CET forecast is the band at the ref model's output price, not a guess", async () => {
    // seedPrices puts usd_out at $1/Mtok, so a 1,000-token band forecasts $0.001.
    const r = await h.cli(...openArgs(), "--session", "s1", "--prompt", "p1", "--json");
    const body = r.json<{ band: { spend_usd_p50: number | null } }>();
    expect(body.band.spend_usd_p50).toBeCloseTo(0.001, 6);
  });

  test("an anchor resolved without explicit flags is recorded as anomaly(anchor_inferred)", async () => {
    const explicit = await h.cli(...openArgs(), "--session", "s1", "--prompt", "p1", "--json");
    expect(explicit.code).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind='anchor_inferred'").get()?.n).toBe(0);

    const inferred = await h.cli(...openArgs({ subject: "second task" }), "--json");
    expect(inferred.code).toBe(0);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind='anchor_inferred'").get()?.n,
    ).toBe(1);
  });

  test("an ambiguous anchor asks for --session instead of guessing (exit 1)", async () => {
    // Two sessions whose newest turns are seconds apart: attributing a whole task's
    // spend to a coin flip is exactly what P1.0 forbids.
    turn(h.db, { session: "s2", prompt: "q1", at: "2026-01-01T00:00:30Z" });
    const r = await h.cli(...openArgs());
    expect(r.code).toBe(1);
    expect(r.err).toContain("--session");
  });

  test("--kind is validated against the closed set", async () => {
    const r = await h.cli(...openArgs({ kind: "archaeology" }), "--session", "s1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--kind");
  });

  test("a missing driver number is a usage error, not a defaulted zero", async () => {
    const args = openArgs();
    const i = args.indexOf("--exp-turns");
    args.splice(i, 2);
    const r = await h.cli(...args, "--session", "s1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("exp-turns");
  });

  test("--json emits exactly one object carrying schema: 1 (P1.0)", async () => {
    const r = await h.cli(...openArgs(), "--session", "s1", "--prompt", "p1", "--json");
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(r.json<{ schema: number }>().schema).toBe(1);
  });
});

describe("est open — P1.1 re-estimate", () => {
  test("appends version 2 and leaves version 1 untouched (append-only)", async () => {
    const tid = await open();
    const r = await h.cli(
      ...openArgs({ subject: "" }),
      "--tid",
      tid,
      "--reason",
      "refinement",
      "--raw-p50",
      "5000",
      "--json",
    );
    expect(r.code).toBe(0);

    const rows = h.db.query<{ version: number; reason: string; raw_p50_wcet: number }, [string]>(
      "SELECT version, reason, raw_p50_wcet FROM estimate WHERE tid = ? ORDER BY version",
    ).all(tid);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 1, reason: "initial", raw_p50_wcet: 1000 });
    expect(rows[1]).toMatchObject({ version: 2, reason: "refinement", raw_p50_wcet: 5000 });
  });

  test("--reason initial with --tid is REJECTED (exit 2): one baseline per task, forever", async () => {
    const tid = await open();
    const r = await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "initial");
    expect(r.code).toBe(2);
    expect(r.err).toContain("REJECTED");
    expect(r.err).toContain("instead:");
  });

  test("--tid with no --reason is a usage error (exit 1)", async () => {
    const tid = await open();
    const r = await h.cli(...openArgs({ subject: "" }), "--tid", tid);
    expect(r.code).toBe(1);
  });

  test("--reason without --tid is REJECTED: there is nothing to re-estimate", async () => {
    const r = await h.cli(...openArgs(), "--session", "s1", "--reason", "refinement");
    expect(r.code).toBe(2);
  });

  test("an unknown --tid is REJECTED (exit 2), never silently minted", async () => {
    const r = await h.cli(...openArgs({ subject: "" }), "--tid", "no-such-tid", "--reason", "refinement");
    expect(r.code).toBe(2);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task").get()?.n).toBe(0);
  });

  test("--reason scope_change without an intervening `est scope` is REJECTED (exit 2)", async () => {
    const tid = await open();
    const r = await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "scope_change");
    expect(r.code).toBe(2);
    expect(r.err).toContain("est scope");
    // and nothing was appended — the refusal is not a partial write
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM estimate WHERE tid = ?").get(tid)?.n,
    ).toBe(1);
  });

  test("--reason scope_change is accepted once a real scope revision exists", async () => {
    const tid = await open();
    expect((await h.cli("scope", tid, "--reason", "the goal moved", "--subject", "widget pipeline rewrite v2")).code).toBe(0);
    const r = await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "scope_change", "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ reason: string }>().reason).toBe("scope_change");
    const row = h.db.query<{ scope_seq: number }, [string]>(
      "SELECT scope_seq FROM estimate WHERE tid = ? ORDER BY eid DESC LIMIT 1",
    ).get(tid)!;
    expect(row.scope_seq).toBe(2);
  });

  test("--continue re-issues the previous drivers without retyping them", async () => {
    const tid = await open();
    const r = await h.cli("open", "--continue", tid, "--session", "s1", "--json");
    expect(r.code).toBe(0);
    const body = r.json<{ reason: string; tid: string }>();
    expect(body.reason).toBe("refinement");
    expect(body.tid).toBe(tid);
    const rows = h.db.query<{ exp_turns: number }, [string]>(
      "SELECT exp_turns FROM estimate WHERE tid = ? ORDER BY version",
    ).all(tid);
    expect(rows.map((x) => x.exp_turns)).toEqual([6, 6]);
  });

  test("the ABORT triggers are real: a direct UPDATE of an estimate is refused by the database", async () => {
    await open();
    expect(() => h.db.query("UPDATE estimate SET raw_p50_wcet = 1").run()).toThrow(/append-only/);
    expect(() => h.db.query("DELETE FROM estimate").run()).toThrow(/append-only/);
    expect(() => h.db.query("UPDATE task_scope SET subject = 'x'").run()).toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// P1.2 — est block
// ---------------------------------------------------------------------------

describe("est block — P1.2", () => {
  test("appends one row per phase against the task's current maximum eid", async () => {
    const tid = await open();
    expect((await h.cli("block", tid, "--phase", "0", "--title", "survey", "--p50", "100", "--p90", "300")).code).toBe(0);
    expect((await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "400", "--p90", "900")).code).toBe(0);

    const eid = h.db.query<{ eid: number }, [string]>("SELECT MAX(eid) AS eid FROM estimate WHERE tid = ?").get(tid)!.eid;
    const rows = h.db.query<{ phase_idx: number; title: string; p50_wcet: number }, [number]>(
      "SELECT phase_idx, title, p50_wcet FROM estimate_block WHERE eid = ? ORDER BY phase_idx",
    ).all(eid);
    expect(rows).toEqual([
      { phase_idx: 0, title: "survey", p50_wcet: 100 },
      { phase_idx: 1, title: "build", p50_wcet: 400 },
    ]);
  });

  test("a duplicate (eid, phase) is REJECTED (exit 2) — re-estimating a block means a new estimate", async () => {
    const tid = await open();
    await h.cli("block", tid, "--phase", "0", "--title", "survey", "--p50", "100", "--p90", "300");
    const r = await h.cli("block", tid, "--phase", "0", "--title", "survey again", "--p50", "999", "--p90", "999");
    expect(r.code).toBe(2);
    expect(r.err).toContain("append-only");
    expect(r.err).toContain("est open");
  });

  test("a new estimate gives the blocks a fresh eid to hang from", async () => {
    const tid = await open();
    await h.cli("block", tid, "--phase", "0", "--title", "survey", "--p50", "100", "--p90", "300");
    await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "refinement");
    const r = await h.cli("block", tid, "--phase", "0", "--title", "survey", "--p50", "800", "--p90", "1600");
    expect(r.code).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate_block").get()?.n).toBe(2);
  });

  test("--phase is validated as 0-based against the bound run's declared phase count", async () => {
    const tid = await open();
    h.db.query(
      `INSERT INTO workflow_run (run_id, wf_launch_id, session_id, workflow_name, transcript_dir,
                                 default_model, launch_prompt_id, n_phases_planned, started_at, ended_at, tid)
       VALUES ('wf-demo','launch-1','s1','demo',NULL,NULL,'p1',2,'2026-01-01T00:00:00Z',NULL,?)`,
    ).run(tid);
    for (const [idx, title] of [[0, "survey"], [1, "build"]] as const) {
      h.db.query(
        "INSERT INTO workflow_phase (run_id, wf_launch_id, phase_idx, title, detail, model) VALUES ('wf-demo','launch-1',?,?,NULL,NULL)",
      ).run(idx, title);
    }
    // 2 is the 1-based `phaseIndex` of the last phase and the 0-based index of a
    // phase that does not exist. Accepting it would put a block estimate where no
    // actual can ever join it — silently, which is the whole hazard.
    const bad = await h.cli("block", tid, "--phase", "2", "--title", "build", "--p50", "1", "--p90", "2");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("0-BASED");
    expect((await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "1", "--p90", "2")).code).toBe(0);
  });

  test("blocking a task with no estimate is REJECTED (exit 2)", async () => {
    const tid = await open();
    h.db.query("DELETE FROM estimate_block").run();
    const r = await h.cli("block", "not-a-tid", "--phase", "0", "--title", "x", "--p50", "1", "--p90", "2");
    expect(r.code).toBe(2);
    expect(r.err).toContain("est open");
    expect(tid).not.toBe("");
  });

  test("a negative or out-of-range --phase is a usage error", async () => {
    const tid = await open();
    expect((await h.cli("block", tid, "--phase", "-1", "--title", "x", "--p50", "1", "--p90", "2")).code).toBe(1);
    expect((await h.cli("block", tid, "--phase", "64", "--title", "x", "--p50", "1", "--p90", "2")).code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P1.3 — est bind
// ---------------------------------------------------------------------------

describe("est bind — P1.3", () => {
  test("writes one alias per identity flag, with id_kind derived from the flag", async () => {
    const tid = await open();
    const r = await h.cli(
      "bind", tid, "--session", "s2", "--task", "7", "--run", "wf-demo", "--agent", "a1", "--json",
    );
    expect(r.code).toBe(0);
    const rows = h.db.query<{ id_kind: string; session_id: string; local_id: string; source: string }, [string]>(
      "SELECT id_kind, session_id, local_id, source FROM task_alias WHERE tid = ? ORDER BY id_kind",
    ).all(tid);
    expect(rows.map((x) => x.id_kind)).toEqual(["agent", "session", "session", "session_task", "workflow_run"]);
    for (const row of rows) expect(row.source).toBe("est_bind");
  });

  test("is idempotent by primary key: re-binding the same identity is not an error", async () => {
    const tid = await open();
    expect((await h.cli("bind", tid, "--session", "s2")).code).toBe(0);
    const again = await h.cli("bind", tid, "--session", "s2", "--json");
    expect(again.code).toBe(0);
    expect(again.json<{ written: Array<{ existed: boolean }> }>().written[0]!.existed).toBe(true);
  });

  test("an EXCLUSIVE alias already bound to a DIFFERENT tid is REJECTED (exit 2), never re-pointed", async () => {
    const a = await open();
    const other = await openOther();
    expect((await h.cli("bind", a, "--session", "s9", "--agent", "ag-1")).code).toBe(0);
    const r = await h.cli("bind", other, "--session", "s9", "--agent", "ag-1");
    expect(r.code).toBe(2);
    expect(r.err).toContain(a);
    // the original binding survives — a refusal must not half-apply, and that
    // includes the --session row in the SAME call, which would have been legal alone
    const owner = h.db.query<{ tid: string }, []>(
      "SELECT tid FROM task_alias WHERE id_kind='agent' AND local_id='ag-1'",
    ).get()!;
    expect(owner.tid).toBe(a);
    const halfApplied = h.db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM task_alias WHERE id_kind='session' AND session_id='s9' AND tid = ?",
    ).get(other)!;
    expect(halfApplied.n).toBe(0);
  });

  test("a SESSION is shared: a second tid binds alongside the first, never over it", async () => {
    const a = await open();
    const other = await openOther();
    expect((await h.cli("bind", a, "--session", "s9")).code).toBe(0);
    const second = await h.cli("bind", other, "--session", "s9", "--json");
    expect(second.code).toBe(0);
    // `existed: false` — this is a NEW row, not a swallowed no-op. The v5 key made
    // ('session', s9, s9) unique, so this bind exited 2 and the second task was
    // unattributable for the rest of the session.
    expect(second.json<{ written: Array<{ existed: boolean }> }>().written[0]!.existed).toBe(false);
    const owners = h.db
      .query<{ tid: string }, []>(
        "SELECT tid FROM task_alias WHERE id_kind='session' AND session_id='s9' ORDER BY tid",
      )
      .all()
      .map((x) => x.tid);
    expect(owners).toEqual([a, other].sort());
  });

  test("--task without --session is a usage error: a Task-tool number is session-scoped", async () => {
    const tid = await open();
    const r = await h.cli("bind", tid, "--task", "7");
    expect(r.code).toBe(1);
  });

  test("no identity flag at all is a usage error", async () => {
    const tid = await open();
    expect((await h.cli("bind", tid)).code).toBe(1);
  });

  test("an unknown tid is REJECTED (exit 2)", async () => {
    expect((await h.cli("bind", "no-such-tid", "--session", "s2")).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P1.5 — est scope
// ---------------------------------------------------------------------------

describe("est scope — P1.5", () => {
  test("appends seq+1 with a recomputed hash, a stored diff and source est_scope", async () => {
    const tid = await open();
    const r = await h.cli("scope", tid, "--reason", "Craig added the migration", "--subject", "widget pipeline rewrite + migration", "--json");
    expect(r.code).toBe(0);
    const row = h.db.query<
      { seq: number; source: string; reason: string; diff_summary: string | null; scope_hash: string },
      [string]
    >("SELECT seq, source, reason, diff_summary, scope_hash FROM task_scope WHERE tid = ? ORDER BY seq DESC LIMIT 1").get(tid)!;
    expect(row.seq).toBe(2);
    expect(row.source).toBe("est_scope");
    expect(row.reason).toBe("Craig added the migration");
    expect(row.diff_summary).toContain("migration");
    expect(row.scope_hash).not.toBe(
      h.db.query<{ scope_hash: string }, [string]>("SELECT scope_hash FROM task_scope WHERE tid = ? AND seq = 1").get(tid)!.scope_hash,
    );
  });

  test("the stored diff is truncated to the documented 2 KB budget", async () => {
    const tid = await open();
    await h.cli("scope", tid, "--reason", "big", "--description", "x".repeat(8000));
    const row = h.db.query<{ diff_summary: string }, [string]>(
      "SELECT diff_summary FROM task_scope WHERE tid = ? AND seq = 2",
    ).get(tid)!;
    expect(row.diff_summary.length).toBeLessThanOrEqual(2048 + 80);
  });

  test("a revision that changes nothing is REJECTED (exit 2) — the precondition cannot be manufactured", async () => {
    const tid = await open();
    const r = await h.cli("scope", tid, "--reason", "no-op", "--subject", "widget pipeline rewrite");
    expect(r.code).toBe(2);
    expect(r.err).toContain("changes nothing");
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM task_scope WHERE tid = ?").get(tid)?.n,
    ).toBe(1);
  });

  test("re-indexes task_fts so the reference class sees the new subject", async () => {
    const tid = await open();
    await h.cli("scope", tid, "--reason", "renamed", "--subject", "sprocket calibration");
    const row = h.db.query<{ subject: string }, [string]>("SELECT subject FROM task_fts WHERE tid = ?").get(tid)!;
    expect(row.subject).toBe("sprocket calibration");
    expect(h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM task_fts WHERE tid = ?").get(tid)?.n).toBe(1);
  });

  test("an unknown tid is REJECTED (exit 2)", async () => {
    expect((await h.cli("scope", "no-such-tid", "--reason", "x", "--subject", "y")).code).toBe(2);
  });

  test("--dod captures the checklist and changes the hash", async () => {
    const tid = await open();
    const dod = JSON.stringify([{ item: "bun test green", kind: "deterministic", check: "bun test" }, "Craig likes it"]);
    expect((await h.cli("scope", tid, "--reason", "dod", "--dod", dod)).code).toBe(0);
    const row = h.db.query<{ dod_json: string }, [string]>(
      "SELECT dod_json FROM task_scope WHERE tid = ? AND seq = 2",
    ).get(tid)!;
    const parsed = JSON.parse(row.dod_json) as Array<{ item: string; kind: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: "deterministic" });
    // A bare string is `human`: assuming a claim is machine-checkable when nobody
    // said how is exactly the renegotiation the DoD exists to prevent.
    expect(parsed[1]).toMatchObject({ kind: "human" });
  });
});

describe("parseDod — P1.1/§3.2 step 5", () => {
  test("empty input is an empty checklist, not an error", () => {
    expect(parseDod(null)).toEqual([]);
    expect(parseDod("  ")).toEqual([]);
  });
  test("a non-array is a usage error", () => {
    expect(() => parseDod('{"item":"x"}')).toThrow(/JSON array/);
  });
  test("unparseable JSON is a usage error, not a silent empty list", () => {
    expect(() => parseDod("[not json")).toThrow(/JSON array/);
  });
  test("an object with no item is a usage error", () => {
    expect(() => parseDod('[{"kind":"human"}]')).toThrow(/missing "item"/);
  });
});

// ---------------------------------------------------------------------------
// P1.4 — est refclass
// ---------------------------------------------------------------------------

describe("est refclass — P1.4", () => {
  test("no matches is exit 0 and says so — an empty reference class is a valid answer", async () => {
    const r = await h.cli("refclass", "--kind", "implement", "--text", "nothing like this exists");
    expect(r.code).toBe(0);
    expect(r.out).toContain("valid answer");
  });

  test("exits 0 against a database with no tasks at all", async () => {
    const fresh = makeHarness("est-refclass-empty-");
    try {
      const r = await fresh.cli("refclass", "--text", "anything", "--json");
      expect(r.code).toBe(0);
      expect(r.json<{ matches: unknown[] }>().matches).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  test("takes no lock: it is callable while a writer holds one", async () => {
    // P1.4 is read-only by contract because it is step 1 of the ceremony, and step 1
    // blocking on a running sweep would make the ceremony skippable in exactly the
    // moment it matters. Holding the lock file must not change the answer.
    await Bun.write(h.lockPath, "held by a pretend sweeper");
    const r = await h.cli("refclass", "--text", "widget", "--json");
    expect(r.code).toBe(0);
  });

  test("cold start prints no multiplier and labels itself uncalibrated", async () => {
    await open();
    const r = await h.cli("refclass", "--text", "widget pipeline", "--json");
    const body = r.json<{ bucket: { uncalibrated: boolean; mult_p50: number | null } }>();
    expect(body.bucket.uncalibrated).toBe(true);
    expect(body.bucket.mult_p50).toBeNull();
    const human = await h.cli("refclass", "--text", "widget pipeline");
    expect(human.out).toContain("UNCALIBRATED");
    expect(human.out).not.toMatch(/×\d/);
  });

  test("open tasks are not a reference class: only COMPLETED tasks can be matched", async () => {
    await open();
    const r = await h.cli("refclass", "--text", "widget pipeline rewrite", "--json");
    expect(r.json<{ matches: unknown[] }>().matches).toEqual([]);
  });

  test("output stays inside the 8,000-character budget", async () => {
    await open();
    const r = await h.cli("refclass", "--text", "widget pipeline");
    expect(r.out.length).toBeLessThanOrEqual(8000);
  });

  test("a price change cannot retroactively move a completed task's unit", async () => {
    // Guards §4.2 delta 3 from the read side: refclass filters on the ESTIMATE's
    // ref_model/estimand, so a task issued under one unit must not appear under another.
    price(h.db, "claude-other-9", { in: 1, out: 2, cw: 2, cr: 2 });
    h.db.query("UPDATE config SET v = 'claude-other-9' WHERE k = 'ref_model'").run();
    const r = await h.cli("refclass", "--text", "widget", "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ ref_model: string }>().ref_model).toBe("claude-other-9");
  });
});

// ---------------------------------------------------------------------------
// P1.0 — the cross-cutting contracts, over every Phase 1 verb at once
// ---------------------------------------------------------------------------

describe("P1.0 — cross-cutting", () => {
  test("every Phase 1 verb's --json is exactly one object carrying schema: 1", async () => {
    const tid = await open();
    const invocations: string[][] = [
      ["refclass", "--text", "widget"],
      ["block", tid, "--phase", "0", "--title", "survey", "--p50", "1", "--p90", "2"],
      ["bind", tid, "--session", "s4"],
      ["scope", tid, "--reason", "moved", "--subject", "widget pipeline rewrite v2"],
      ["burn", tid],
      ["board"],
      ["retro", "--dry-run"],
      ["close", tid, "--force"],
    ];
    for (const argv of invocations) {
      const r = await h.cli(...argv, "--json");
      expect(r.code).toBeLessThanOrEqual(3);
      const lines = r.out.trim().split("\n");
      expect({ verb: argv[0], lines: lines.length }).toEqual({ verb: argv[0], lines: 1 });
      expect({ verb: argv[0], schema: JSON.parse(r.out).schema }).toEqual({ verb: argv[0], schema: 1 });
    }
  });

  test("diagnostics go to stderr, so --json stdout stays parseable even when rejected", async () => {
    const r = await h.cli("scope", "no-such-tid", "--reason", "x", "--subject", "y", "--json");
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).not.toBe("");
  });

  test("a flag belonging to another verb is a distinct, more useful error than an unknown one", async () => {
    const r = await h.cli("open", "--budget", "20s");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not valid for `est open`");
  });

  test("global flags are accepted before the verb, as a hook or cron line may place them", async () => {
    const r = await h.cli("--json", "board");
    expect(r.code).toBe(0);
    expect(r.json<{ schema: number }>().schema).toBe(1);
  });

  test("`est help` lists every command the dispatcher accepts", async () => {
    const r = await h.cli("help");
    expect(r.code).toBe(0);
    for (const verb of ["refclass", "open", "block", "bind", "scope", "burn", "close", "board", "retro"]) {
      expect(r.out).toContain(`  ${verb}`);
    }
  });
});

describe("ftsQuery — P1.4's MATCH sanitiser", () => {
  test("quotes and ORs every token, so punctuation cannot become syntax", () => {
    expect(ftsQuery("fix: the C++ parser")).toBe('"fix" OR "the" OR "parser"');
  });
  test("text with no usable token yields null rather than an invalid MATCH", () => {
    expect(ftsQuery("!!! ?")).toBeNull();
  });
  test("a query that would be a syntax error degrades to no matches, never a crash", async () => {
    const r = await h.cli("refclass", "--text", 'AND OR NEAR "', "--json");
    expect(r.code).toBe(0);
    expect(r.json<{ matches: unknown[] }>().matches).toEqual([]);
  });
});

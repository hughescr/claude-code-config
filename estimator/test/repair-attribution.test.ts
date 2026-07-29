/**
 * test/repair-attribution.test.ts — the land step, exercised end to end against a
 * temp database.
 *
 * The script is destructive (it DELETEs from `anomaly`) and it runs once, against
 * the live corpus, on a day when nothing else is watching. That combination is
 * exactly what a test is for: every predicate here is the one the land step will
 * evaluate, and the fixture reproduces each of the four retracted shapes plus both
 * shapes that must survive.
 *
 * Synthetic throughout — no real id, path or token figure (§4). `backupDir` is
 * always the harness's own temp directory, so nothing ever lands in the real
 * `backups/`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentRun, makeHarness, request, seedPrices, turn, type Harness } from "./support.ts";
import { repairAttribution } from "../scripts/repair-attribution.ts";

let h: Harness;
const TID = "019f0000-0000-7000-8000-000000000001";
const NOW = new Date("2026-03-01T00:00:00Z");

beforeEach(() => {
  h = makeHarness("est-repair-");
  seedPrices(h.db);
});

afterEach(() => {
  h.close();
});

function anomaly(db: Database, kind: string, detail: string): void {
  db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES ('2026-02-01T00:00:00Z', ?, ?, NULL)").run(
    kind,
    detail,
  );
}

/** The live ledger's five shapes: four retracted, two kept. */
function seedLedger(db: Database): void {
  anomaly(
    db,
    "wf_record_mismatch",
    "run wf_x: workflow agent a1111111111111111 has no label — the §3.2 authoring rule (label + phase on every agent()) was not followed",
  );
  anomaly(
    db,
    "wf_record_mismatch",
    "run wf_x: agent a1111111111111111 in journal.jsonl but absent from workflowProgress[] (journal wins; agent falls back to interval clustering)",
  );
  anomaly(db, "wf_record_mismatch", "run wf_x: 2 launches share this runId; all agents attribute to wf_launch_id=l2");
  anomaly(
    db,
    "phase_unmapped",
    "run wf_x: agent a1111111111111111 has no workflowProgress record and clustering produced 3 waves against 4 planned phases",
  );
  // Re-logged with a different wave count, which is how 238 rows covered 204 agents.
  anomaly(
    db,
    "phase_unmapped",
    "run wf_x: agent a1111111111111111 has no workflowProgress record and clustering produced 4 waves against 4 planned phases",
  );
  // --- the two that must survive -------------------------------------------
  anomaly(
    db,
    "wf_record_mismatch",
    'a2222222222222222: phaseIndex=5 / phaseTitle="Sweep" matches no entry in phases[] (n=4)',
  );
  anomaly(db, "wf_record_mismatch", "workflowProgress workflow_agent record has no agentId");
  // ...and one unrelated kind, to prove the predicates are narrow.
  anomaly(db, "truncated_tail", "a live write tore the last line");
}

function seedWork(db: Database): void {
  // Six turns before the anchor, the shape F1 was refused by.
  for (let i = 0; i < 6; i += 1) {
    turn(db, { session: "s1", prompt: `pre${i}`, at: `2026-02-01T09:0${i}:00Z` });
  }
  turn(db, { session: "s1", prompt: "anchor", at: "2026-02-01T10:00:00Z" });
  db.query(
    `INSERT INTO task (tid, kind, status, created_at, started_at, ended_at, anchor_session, anchor_prompt)
     VALUES (?, 'implement', 'in_progress', '2026-02-01T10:00:00Z', NULL, NULL, 's1', 'anchor')`,
  ).run(TID);
  db.query(
    `INSERT INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
     VALUES (?, 'session', 's1', 's1', '2026-02-01T10:00:00Z', 'manual')`,
  ).run(TID);
  agentRun(db, "ag1", {
    session: "s1",
    launchPrompt: "anchor",
    startedAt: "2026-02-01T10:01:00Z",
    endedAt: "2026-02-01T10:30:00Z",
  });
  request(db, "rq-1", { session: "s1", prompt: "anchor", ts: "2026-02-01T10:00:10Z", out: 10 });
  request(db, "rq-2", {
    session: "s1",
    prompt: "anchor",
    origin: "subagent",
    agent: "ag1",
    ts: "2026-02-01T10:10:00Z",
    out: 500,
  });
}

const counts = (kind: string): number =>
  h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = ?").get(kind)!.n;

describe("scripts/repair-attribution.ts", () => {
  test("dry run reports the retraction and writes absolutely nothing", () => {
    seedLedger(h.db);
    seedWork(h.db);
    const before = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n;

    const lines: string[] = [];
    const r = repairAttribution(h.db, { backupDir: h.dir, now: NOW, out: (s) => lines.push(s) });

    expect(r.applied).toBe(false);
    expect(r.retracted).toBe(5);
    expect(r.kept).toBe(2);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n).toBe(before);
    expect(
      h.db.query<{ tid: string | null }, []>("SELECT tid FROM turn WHERE prompt_id = 'anchor'").get()?.tid,
    ).toBeNull();
    expect(lines.join("\n")).toContain("DRY RUN");
  });

  test("--apply retracts exactly the four dead shapes and keeps the two genuine ones", () => {
    seedLedger(h.db);
    seedWork(h.db);

    const r = repairAttribution(h.db, { apply: true, backupDir: h.dir, now: NOW, out: () => {} });
    expect(r.applied).toBe(true);
    expect(r.retracted).toBe(5);
    expect(r.problems).toEqual([]);

    // Both survivors, and nothing else of that kind.
    const survivors = h.db
      .query<{ detail: string }, []>("SELECT detail FROM anomaly WHERE kind = 'wf_record_mismatch' ORDER BY id")
      .all()
      .map((a) => a.detail);
    expect(survivors).toHaveLength(2);
    expect(survivors[0]).toContain("matches no entry in phases[]");
    expect(survivors[1]).toContain("has no agentId");
    expect(counts("phase_unmapped")).toBe(0);
    // A narrow predicate: an unrelated kind is untouched.
    expect(counts("truncated_tail")).toBe(1);
    // The retraction is itself a ledger row, exactly one.
    expect(counts("audit_removed")).toBe(1);
  });

  test("--apply leaves a restorable snapshot and a full dump of every deleted row", () => {
    seedLedger(h.db);
    seedWork(h.db);
    const r = repairAttribution(h.db, { apply: true, backupDir: h.dir, now: NOW, out: () => {} });

    expect(existsSync(r.snapshot!)).toBe(true);
    expect(r.snapshot!.startsWith(join(h.dir, "pre-attr-repair-"))).toBe(true);
    const dumped = JSON.parse(readFileSync(r.dump!, "utf8")) as Array<{ kind: string; detail: string }>;
    expect(dumped).toHaveLength(5);
    // Every deleted row is recoverable from the dump, not merely counted.
    expect(dumped.some((d) => d.detail.includes("clustering produced 3 waves"))).toBe(true);
    expect(dumped.some((d) => d.detail.includes("clustering produced 4 waves"))).toBe(true);
  });

  test("re-attributes: the anchor turn, its agent and their requests are bound", () => {
    seedLedger(h.db);
    seedWork(h.db);
    repairAttribution(h.db, { apply: true, backupDir: h.dir, now: NOW, out: () => {} });

    expect(
      h.db.query<{ tid: string | null }, []>("SELECT tid FROM turn WHERE prompt_id = 'anchor'").get()?.tid,
    ).toBe(TID);
    expect(h.db.query<{ tid: string | null }, []>("SELECT tid FROM agent_run WHERE agent_id = 'ag1'").get()?.tid).toBe(
      TID,
    );
    const bound = h.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM request WHERE tid = ? AND attr = 'exclusive'")
      .get(TID)!.n;
    expect(bound).toBe(2);
    // The burn row the statusline reads now carries the sub-agent's spend.
    const burn = h.db
      .query<{ wcet_main: number; wcet_sub: number }, [string]>(
        "SELECT wcet_main, wcet_sub FROM burn_cache WHERE tid = ?",
      )
      .get(TID)!;
    expect(burn.wcet_main).toBeGreaterThan(0);
    expect(burn.wcet_sub).toBeGreaterThan(0);
  });

  test("idempotent: a second --apply retracts nothing and adds no second ledger row", () => {
    seedLedger(h.db);
    seedWork(h.db);
    repairAttribution(h.db, { apply: true, backupDir: h.dir, now: NOW, out: () => {} });
    const after = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n;

    const second = repairAttribution(h.db, {
      apply: true,
      backupDir: h.dir,
      now: new Date("2026-03-02T00:00:00Z"),
      out: () => {},
    });
    expect(second.retracted).toBe(0);
    expect(second.problems).toEqual([]);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n).toBe(after);
    expect(counts("audit_removed")).toBe(1);
  });

  /**
   * The conservation invariant, on the binding path it used to cry wolf about.
   *
   * `est bind --run` exists because a run's transcripts routinely live under a
   * DIFFERENT session from the task's anchor, and `attributeTasks` books that spend
   * through the run alias. The invariant's denominator counted only sessions carrying
   * an `id_kind='session'` alias, so one legitimate `--run` bind put the numerator
   * above the denominator and the land step reported "the shape a double-count has"
   * about a correctly attributed database — and exited 3. A safety net that fires on
   * the supported path is worse than none, because the next real violation reads as
   * noise.
   */
  test("a legitimate `est bind --run` into another session is not a conservation failure", () => {
    seedWork(h.db);
    // The run and everything under it live in `sX`, which has no session alias.
    h.db
      .query(
        `INSERT INTO workflow_run (run_id, wf_launch_id, session_id, workflow_name, transcript_dir,
                                   default_model, launch_prompt_id, n_phases_planned, started_at, ended_at, tid)
         VALUES ('wfA', 'wfA-l1', 'sX', 'demo', NULL, NULL, NULL, 2,
                 '2026-02-01T10:05:00Z', '2026-02-01T10:40:00Z', NULL)`,
      )
      .run();
    h.db
      .query(
        `INSERT INTO task_alias (tid, id_kind, session_id, local_id, first_seen, source)
         VALUES (?, 'workflow_run', '', 'wfA', '2026-02-01T10:05:00Z', 'est_bind')`,
      )
      .run(TID);
    agentRun(h.db, "ag-wf", {
      session: "sX",
      launchPrompt: null,
      runId: "wfA",
      launchId: "wfA-l1",
      startedAt: "2026-02-01T10:05:00Z",
      endedAt: "2026-02-01T10:40:00Z",
    });
    request(h.db, "rq-wf", {
      session: "sX",
      prompt: null,
      origin: "subagent",
      agent: "ag-wf",
      run: "wfA",
      launchId: "wfA-l1",
      ts: "2026-02-01T10:20:00Z",
      out: 1000,
    });

    const r = repairAttribution(h.db, { apply: true, backupDir: h.dir, now: NOW, out: () => {} });
    expect(r.problems).toEqual([]);
    // And the spend really did land where the bind says — the invariant is not being
    // satisfied by attributing nothing.
    expect(
      h.db.query<{ tid: string | null }, []>("SELECT tid FROM request WHERE request_id = 'rq-wf'").get()?.tid,
    ).toBe(TID);
  });

  /**
   * When conservation DOES fail, the repair must not be on disk. The assertion used
   * to run after four independently committed steps, so "CONSERVATION CHECK FAILED"
   * described damage already done and exit 3 named it rather than preventing it.
   * A duplicated `request_id` is the cheapest way to make the check fail on purpose.
   */
  test("a conservation failure rolls the whole repair back", () => {
    seedLedger(h.db);
    seedWork(h.db);
    // The cheapest invariant to break on purpose: a `replay` row carrying a tid. §5.2
    // excludes replays from every sum, and attribution deliberately never relabels
    // one, so this survives the pass and the assertion catches it.
    h.db.query("UPDATE request SET attr = 'replay', tid = ? WHERE request_id = 'rq-2'").run(TID);

    const before = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n;
    const lines: string[] = [];
    const r = repairAttribution(h.db, {
      apply: true,
      backupDir: h.dir,
      now: NOW,
      out: (s) => lines.push(s),
    });

    expect(r.problems.length).toBeGreaterThan(0);
    // Nothing was retracted, nothing was re-attributed: the transaction was undone.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n).toBe(before);
    expect(counts("audit_removed")).toBe(0);
    expect(
      h.db.query<{ tid: string | null }, []>("SELECT tid FROM turn WHERE prompt_id = 'anchor'").get()?.tid,
    ).toBeNull();
    expect(lines.join("\n")).toContain("ROLLED BACK");
    // The snapshot taken before any write is still the documented escape hatch.
    expect(existsSync(r.snapshot!)).toBe(true);
  });

  test("a row written by the FIXED classifier is never mistaken for an old one", () => {
    // The new wordings, which must survive a repair run in full.
    anomaly(h.db, "agent_never_returned", "run wf_x: agent a3333333333333333 never returned — no result record in journal.jsonl; its tokens are counted, its phase is not");
    anomaly(h.db, "wf_relaunch_orphan", "run wf_x: agent a4444444444444444 started before the earliest workflowProgress[] record — it belongs to an earlier launch under the same runId, whose progress the state file overwrote");
    anomaly(h.db, "wf_relaunch_detected", "run wf_x: relaunched under the same runId; wf_<runId>.json describes only the last launch, so earlier agents cannot be told apart");
    anomaly(h.db, "wf_record_mismatch", "run wf_x: workflow agent a5555555555555555 has a workflowProgress record with no label — the §3.2 authoring rule (label + phase on every agent()) was not followed");
    anomaly(h.db, "phase_unmapped", "run wf_x: agent a6666666666666666 has no workflowProgress record and no relaunch or never-returned explanation (4 planned phase(s))");

    const r = repairAttribution(h.db, { apply: true, backupDir: h.dir, now: NOW, out: () => {} });
    expect(r.retracted).toBe(0);
    expect(counts("agent_never_returned")).toBe(1);
    expect(counts("wf_relaunch_orphan")).toBe(1);
    expect(counts("wf_relaunch_detected")).toBe(1);
    expect(counts("wf_record_mismatch")).toBe(1);
    expect(counts("phase_unmapped")).toBe(1);
  });
});

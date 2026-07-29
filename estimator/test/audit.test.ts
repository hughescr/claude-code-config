/**
 * test/audit.test.ts — P2.12's `est audit`, the five checks and the bounded `--fix`.
 *
 * Two properties get the most attention, because both are the kind that fail silently:
 *
 *  - **The audit must not manufacture findings.** "Unknown session" is decided from the
 *    UNION of what is on disk and what `sweep_state` ever swept. Either source alone
 *    condemns most of a real corpus — disk alone loses everything the retention window
 *    pruned, `sweep_state` alone loses everything ingested through a rewritten path —
 *    and an audit that cries wolf is an audit nobody runs.
 *  - **`--fix` is bounded by the doctrine, not by judgement.** It deletes only from the
 *    five derived/ledger tables, records each removal in the ledger it cleaned, and
 *    refuses the append-only spine at exit 2. That refusal is P1.12's rule applied to
 *    the one tool most likely to want to break it.
 *
 * Every session id, path and figure here is synthetic (§4), and the corpus root is an
 * empty tmp directory — never `~/.claude/projects`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXABLE, SPINE, auditReport, knownSessions } from "../src/audit.ts";
import { agentRun, makeHarness, openArgs, request, seedPrices, turn, type Harness } from "./support.ts";

let h: Harness;
/** An empty corpus root: nothing on disk vouches for any session unless a test says so. */
let root: string;

beforeEach(() => {
  h = makeHarness("est-audit-");
  seedPrices(h.db);
  root = mkdtempSync(join(tmpdir(), "est-audit-corpus-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  h.close();
});

/**
 * A real-looking transcript for `sid`, so discovery vouches for it.
 *
 * `sid` must be uuid-shaped: `discoverCorpus` only treats `<uuid>.jsonl` as a session
 * transcript, which is also why the harness's `s1`-shaped ids are made known through
 * {@link swept} instead.
 */
function transcript(sid: string): void {
  const projectDir = join(root, "-Users-synthetic-project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sid}.jsonl`), "");
}

/** A uuid-shaped session id discovery will accept off disk. */
const ON_DISK_SID = "0195f0aa-1111-4111-8111-111111111111";

/** A sweep watermark for `sid` — the OTHER half of "this session was real". */
function swept(sid: string): void {
  h.db
    .query("INSERT OR REPLACE INTO sweep_state (path, inode, bytes_read, last_swept) VALUES (?,1,0,?)")
    .run(join(root, "-Users-synthetic-project", `${sid}.jsonl`), "2026-01-01T00:00:00Z");
}

function taskEvent(sid: string, taskNum: string, tid: string | null = null): void {
  h.db
    .query(
      `INSERT INTO task_event (tid, session_id, kind, task_num, ts, from_status, to_status, source)
       VALUES (?,?,'status',?, '2026-01-01T00:00:00Z', NULL, 'in_progress', 'transcript')`,
    )
    .run(tid, sid, taskNum);
}

// A valid v7-shaped id that no `task` row will ever carry.
const PHANTOM_TID = "0195f0aa-0000-7000-8000-000000000001";

const audit = (over: string[] = []): ReturnType<Harness["cli"]> => h.cli("audit", "--root", root, ...over);

describe("knownSessions — the union, because either source alone manufactures findings", () => {
  test("a session on disk is known; a session only ever SWEPT is known; a third is not", () => {
    transcript(ON_DISK_SID);
    swept("s-only-swept");
    const known = knownSessions(h.db, root);
    expect(known.has(ON_DISK_SID)).toBe(true);
    // The pruned-transcript case: the file is gone, but a sweep once read it, so the
    // rows it produced are measurements and not fabrications.
    expect(known.has("s-only-swept")).toBe(true);
    expect(known.has("s-never-existed")).toBe(false);
  });
});

describe("the five checks", () => {
  test("clean corpus, clean database: no findings and exit 0", async () => {
    swept("s1");
    turn(h.db, { session: "s1" });
    request(h.db, "r1", { session: "s1" });
    const r = await audit(["--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ findings: unknown[] }>().findings).toEqual([]);
  });

  test("check 1: a row whose session appears nowhere is reported by table and exits 3", async () => {
    // The advisory-41 shape exactly: a task_event from a session that does not exist.
    taskEvent("s-fabricated", "7");
    const r = await audit(["--json"]);
    expect(r.code).toBe(3);
    const f = r.json<{ findings: Array<{ check: number; table: string; n: number; fixable: boolean }> }>().findings;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ check: 1, table: "task_event", n: 1, fixable: true });
  });

  test("check 3: a nullable tid naming no task is a finding even when the session is real", async () => {
    swept("s1");
    agentRun(h.db, "a1", { session: "s1" });
    // `agent_run.tid` carries an FK, so no code path in this repo can leave it
    // dangling — a hand-edit through the `sqlite3` CLI can, because that shell
    // defaults `foreign_keys` to OFF. That is precisely the forensic shape check 3
    // exists to catch, so the test manufactures it the same way the damage would be.
    h.db.query("PRAGMA foreign_keys = OFF").run();
    h.db.query("UPDATE agent_run SET tid = ? WHERE agent_id = 'a1'").run(PHANTOM_TID);
    h.db.query("PRAGMA foreign_keys = ON").run();
    const f = (await audit(["--json"])).json<{ findings: Array<{ check: number; table: string }> }>().findings;
    expect(f.some((x) => x.check === 3 && x.table === "agent_run")).toBe(true);
  });

  test("check 4: a burn_cache row for a TERMINAL task, and a phantom run_segment", async () => {
    swept("s1");
    turn(h.db, { session: "s1" });
    const opened = await h.cli(...openArgs({ subject: "audit target" }), "--session", "s1", "--prompt", "p1", "--json");
    const tid = opened.json<{ tid: string }>().tid;
    h.db.query("UPDATE task SET status = 'completed' WHERE tid = ?").run(tid);
    h.db
      .query("INSERT INTO burn_cache (tid, as_of) VALUES (?, '2026-01-01T00:00:00Z')")
      .run(tid);
    h.db
      .query(
        `INSERT INTO run_segment (session_id, started_at, ended_at, active_s, busy_s, max_concurrency,
                                  gap_min, terminator, first_seen, last_seen)
         VALUES ('s-phantom','2026-01-01T00:00:00Z','2026-01-01T00:05:00Z',300,300,1,
                 5,'session_end','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
      )
      .run();

    const f = (await audit(["--json"])).json<{ findings: Array<{ check: number; table: string }> }>().findings;
    expect(f.some((x) => x.check === 4 && x.table === "burn_cache")).toBe(true);
    expect(f.some((x) => x.check === 4 && x.table === "run_segment")).toBe(true);
    // run_segment is reported ONCE, by check 4 — check 1 deliberately skips it.
    expect(f.filter((x) => x.table === "run_segment")).toHaveLength(1);
  });

  test("check 5: a spine row is reported and flagged as spine, never as fixable", async () => {
    turn(h.db, { session: "s-vanished" });
    const opened = await h.cli(
      ...openArgs({ subject: "spine anchor" }),
      "--session",
      "s-vanished",
      "--prompt",
      "p1",
      "--json",
    );
    expect(opened.code).toBe(0);
    // Neither a transcript nor a sweep_state row vouches for `s-vanished`.
    const f = (await audit(["--json"])).json<{
      findings: Array<{ check: number; table: string; spine: boolean; fixable: boolean }>;
    }>().findings;
    const spine = f.find((x) => x.check === 5 && x.table === "estimate");
    expect(spine).toBeDefined();
    expect(spine!.spine).toBe(true);
    expect(spine!.fixable).toBe(false);
  });
});

describe("--fix is bounded by the doctrine", () => {
  test("deletes only from the five tables and records each removal as audit_removed", async () => {
    swept("s1");
    taskEvent("s-fabricated", "7"); // fixable (task_event)
    request(h.db, "r-phantom", { session: "s-fabricated" }); // NOT fixable (request)

    const r = await audit(["--fix", "--json"]);
    // Findings remain (the `request` row is outside the five tables), so: exit 3.
    expect(r.code).toBe(3);
    expect(r.json<{ removed: Record<string, number> }>().removed).toEqual({ task_event: 1 });

    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()!.n).toBe(0);
    // The `request` row is untouched: `--fix` may not delete what a sweep would not
    // rebuild, and saying so is more useful than a partial cleanup nobody can audit.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM request").get()!.n).toBe(1);

    const removed = h.db
      .query<{ detail: string }, []>("SELECT detail FROM anomaly WHERE kind = 'audit_removed'")
      .all();
    expect(removed).toHaveLength(1);
    // The full deleted row, verbatim: the cleanup is recorded in the ledger it cleaned.
    expect(removed[0]!.detail).toContain("task_event");
    expect(removed[0]!.detail).toContain("s-fabricated");
    expect(JSON.parse(removed[0]!.detail.slice(removed[0]!.detail.indexOf("{")))).toMatchObject({
      session_id: "s-fabricated",
      task_num: "7",
    });
  });

  test("a spine finding makes --fix exit 2 while still tidying the ledger tables", async () => {
    taskEvent("s-fabricated", "7");
    turn(h.db, { session: "s-vanished" });
    expect(
      (await h.cli(...openArgs({ subject: "spine anchor" }), "--session", "s-vanished", "--prompt", "p1", "--json"))
        .code,
    ).toBe(0);

    const r = await audit(["--fix"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("REFUSED");
    expect(r.out).toContain("APPENDING");
    // Refusing the spine must not hold the ledger cleanup hostage: the spine rows were
    // never candidates, and leaving both problems standing helps nobody.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()!.n).toBe(0);
    // …and not one spine row moved.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM estimate").get()!.n).toBe(1);
  });

  test("a read-only run NEVER writes, even with findings", async () => {
    taskEvent("s-fabricated", "7");
    const before = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n;
    expect((await audit()).code).toBe(3);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()!.n).toBe(1);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n).toBe(before);
  });

  test("the deletable set and the spine set are disjoint, and neither drifts by accident", () => {
    // A guard on the doctrine itself rather than on one code path: adding a spine table
    // to FIXABLE is the one edit that would turn `--fix` into an `--amend`.
    for (const t of SPINE) expect(t in FIXABLE).toBe(false);
    expect(Object.keys(FIXABLE).sort()).toEqual(
      ["anomaly", "burn_cache", "run_segment", "sweep_state", "task_event"].sort(),
    );
  });
});

describe("auditReport is a pure read", () => {
  test("the report carries its own evidence — the rows, not just a count", () => {
    taskEvent("s-fabricated", "7");
    const r = auditReport(h.db, { root, now: new Date("2026-02-01T00:00:00Z") });
    expect(r.as_of).toBe("2026-02-01T00:00:00Z");
    expect(r.findings[0]!.rows[0]).toMatchObject({ session_id: "s-fabricated", task_num: "7" });
  });
});

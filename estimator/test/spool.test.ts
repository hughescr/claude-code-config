/**
 * src/spool.ts — the INGESTION side of the hook spool (P1.10, P1.11).
 *
 * The hooks themselves are tested as subprocesses in `test/nudge.test.ts` and
 * `test/capture-delete.test.ts`; this file tests the reader, and the seam between
 * them. The constraint that shapes both halves is that a hook runs on Craig's hot
 * path and **must not write to the database** — a `BEGIN IMMEDIATE` there queues
 * behind exactly the sweeps a fan-out triggers — so each hook makes one `O_APPEND`
 * write and the next sweep drains it.
 *
 * Two properties get the most attention here because losing either loses records the
 * design says cannot be lost:
 *
 *  - **Drain is crash-safe by rename.** The live file is renamed before it is read, so
 *    a hook appending mid-drain lands in a fresh file; if the process dies mid-drain
 *    the `.draining` residue is picked up first on the next sweep.
 *  - **The writers and the reader must agree on WHERE the spool is.** They are three
 *    separate files owned by two separate work streams, and a disagreement is silent
 *    on both sides: the hooks keep exiting 0 and the sweeper keeps finding nothing.
 *
 * The last test is the reader half of P1.11's mandatory regression test: a spooled
 * delete line, with no transcript record of the deletion anywhere, still produces a
 * `deleted` outcome with `censored = 1`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  makeHarness,
  openArgs,
  request,
  seedPrices,
  turn,
  type Harness,
} from "./support.ts";
import {
  COMPLIANCE_FILE,
  MICROSWEEP_MARKER,
  TASK_EVENTS_FILE,
  drainSpool,
  overrunMarkerFile,
  parseComplianceLines,
  parseTaskEventLines,
  pruneMarkers,
  spoolDirFrom,
} from "../src/spool.ts";
import { INSERT_TASK_EVENT_SQL } from "../src/ingest.ts";
import { attributeTasks } from "../src/attribute.ts";
import { closeTask } from "../src/close.ts";

let h: Harness;
let spool: string;

const LONG_AGO = "2026-01-01T00:00:00Z";
const NOW = new Date("2026-02-01T00:00:00Z");

/** The hook scripts' own resolver, restated. The agreement test below pins it. */
const HOOK_SCRIPTS = ["nudge.ts", "capture-delete.ts"] as const;

beforeEach(() => {
  h = makeHarness("est-spool-");
  spool = join(h.dir, "spool");
  mkdirSync(spool, { recursive: true });
  seedPrices(h.db);
});

afterEach(() => {
  h.close();
});

function appendLine(file: string, record: unknown): void {
  appendFileSync(join(spool, file), `${JSON.stringify(record)}\n`, "utf8");
}

function drain(): ReturnType<typeof drainSpool> {
  let result!: ReturnType<typeof drainSpool>;
  h.db.transaction(() => {
    result = drainSpool(h.db, spool);
  }).immediate();
  result.cleanup();
  return result;
}

// ---------------------------------------------------------------------------
// the seam: writers and reader must resolve the same directory
// ---------------------------------------------------------------------------

describe("spool location — the writer/reader seam", () => {
  test("the reader honours EST_SPOOL_DIR, which is the name the hook scripts use", () => {
    expect(spoolDirFrom({ EST_SPOOL_DIR: "/tmp/from-hook" }, "/root")).toBe("/tmp/from-hook");
    expect(spoolDirFrom({ EST_SPOOL: "/tmp/legacy" }, "/root")).toBe("/tmp/legacy");
    expect(spoolDirFrom({}, "/root")).toBe(join("/root", "spool"));
    expect(spoolDirFrom({ EST_SPOOL_DIR: "" }, "/root")).toBe(join("/root", "spool"));
  });

  test("every hook script reads the same environment variable the reader does", () => {
    // A hook writing to a directory the sweeper never drains fails SILENTLY on both
    // sides — the hook exits 0, the sweep reports zero records — so the agreement is
    // asserted against the scripts' source rather than trusted.
    for (const name of HOOK_SCRIPTS) {
      const src = readFileSync(join(import.meta.dir, "..", "scripts", name), "utf8");
      expect(src).toContain("EST_SPOOL_DIR");
      expect(spoolDirFrom({ EST_SPOOL_DIR: "/x" }, "/root")).toBe("/x");
    }
  });

  test("a missing spool directory is an empty drain, not a throw", () => {
    const result = drainSpool(h.db, join(h.dir, "no-such-spool"));
    expect(result.task_events.read).toBe(0);
    expect(result.compliance.read).toBe(0);
    expect(result.anomalies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P1.11 — the delete-capture format
// ---------------------------------------------------------------------------

describe("drainSpool — P1.11 task events", () => {
  test("a spooled delete becomes a task_event row with source='pretooluse'", () => {
    appendLine(TASK_EVENTS_FILE, {
      ts: LONG_AGO,
      session_id: "s1",
      task_num: "7",
      to_status: "deleted",
      source: "pretooluse",
    });
    const result = drain();
    expect(result.task_events).toMatchObject({ read: 1, inserted: 1, malformed: 0 });

    const row = h.db.query<{ session_id: string; task_num: string; to_status: string; source: string; kind: string }, []>(
      "SELECT session_id, task_num, to_status, source, kind FROM task_event",
    ).get()!;
    expect(row).toEqual({
      session_id: "s1",
      task_num: "7",
      to_status: "deleted",
      source: "pretooluse",
      kind: "status",
    });
  });

  test("the hook row and the transcript row collapse on the natural key", () => {
    // The common case: the deletion completed normally, so the sweeper ALSO finds it
    // in the transcript. `task_event`'s UNIQUE (session_id, task_num, ts, to_status,
    // kind) is what makes the duplicate free rather than a double count.
    h.db.query(INSERT_TASK_EVENT_SQL).run({
      $session_id: "s1",
      $task_num: "7",
      $ts: LONG_AGO,
      $kind: "status",
      $from_status: "in_progress",
      $to_status: "deleted",
      $source: "transcript",
    } as never);
    appendLine(TASK_EVENTS_FILE, { ts: LONG_AGO, session_id: "s1", task_num: "7", to_status: "deleted" });
    const result = drain();
    expect(result.task_events.read).toBe(1);
    expect(result.task_events.inserted).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()?.n).toBe(1);
  });

  test("a re-drained identical line inserts nothing: the drain is idempotent", () => {
    const line = { ts: LONG_AGO, session_id: "s1", task_num: "7", to_status: "deleted" };
    appendLine(TASK_EVENTS_FILE, line);
    expect(drain().task_events.inserted).toBe(1);
    appendLine(TASK_EVENTS_FILE, line);
    expect(drain().task_events.inserted).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()?.n).toBe(1);
  });

  test("a mixed batch counts only the rows that actually landed", () => {
    // `inserted` is summed from each statement's `changes`, so a batch straddling the
    // dedup boundary has to come out at the number of NEW rows — not the batch size,
    // and not zero because one line collided.
    const dup = { ts: LONG_AGO, session_id: "s1", task_num: "7", to_status: "deleted" };
    appendLine(TASK_EVENTS_FILE, dup);
    expect(drain().task_events.inserted).toBe(1);

    appendLine(TASK_EVENTS_FILE, dup);
    appendLine(TASK_EVENTS_FILE, { ...dup, task_num: "8" });
    appendLine(TASK_EVENTS_FILE, { ...dup, task_num: "9" });
    const result = drain();
    expect(result.task_events).toMatchObject({ read: 3, inserted: 2, malformed: 0 });
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()?.n).toBe(3);
  });

  test("alternative field spellings a hook might emit are accepted", () => {
    const parsed = parseTaskEventLines(
      `${JSON.stringify({ ts: LONG_AGO, sessionId: "s1", taskId: "9", status: "deleted" })}\n`,
    );
    expect(parsed.rows[0]).toMatchObject({ session_id: "s1", task_num: "9", to_status: "deleted" });
  });

  test("a malformed line is counted and reported, never silently dropped", () => {
    appendFileSync(join(spool, TASK_EVENTS_FILE), "{ this is not json }\n", "utf8");
    appendLine(TASK_EVENTS_FILE, { ts: LONG_AGO, session_id: "s1", task_num: "7", to_status: "deleted" });
    const result = drain();
    expect(result.task_events.read).toBe(1);
    expect(result.task_events.malformed).toBe(1);
    expect(result.anomalies.map((a) => a.kind)).toContain("malformed_line");
  });

  test("a torn final append is a truncated tail, not corruption", () => {
    // The hook was killed between the write and its newline. The bytes that DID land
    // are unusable, but calling that "corruption" would make an ordinary kill look
    // like a defect in the writer.
    appendFileSync(join(spool, TASK_EVENTS_FILE), '{"ts":"2026-01-01T00:00:00Z","sess', "utf8");
    const parsed = parseTaskEventLines(readFileSync(join(spool, TASK_EVENTS_FILE), "utf8"));
    expect(parsed.truncatedTail).toBe(1);
    expect(parsed.malformed).toBe(0);
    expect(parsed.rows).toEqual([]);
  });

  test("a record missing a required field is malformed rather than half-inserted", () => {
    const parsed = parseTaskEventLines(`${JSON.stringify({ ts: LONG_AGO, session_id: "s1" })}\n`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.malformed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P1.10 — the compliance format
// ---------------------------------------------------------------------------

describe("drainSpool — P1.10 compliance records", () => {
  test("a bound launch is counted and discarded; an unbound one becomes anomaly(missed_estimate)", () => {
    appendLine(COMPLIANCE_FILE, {
      ts: LONG_AGO,
      session_id: "s1",
      tool_name: "Task",
      tool_input_sha256: "a".repeat(64),
      bound_tid: "some-tid",
      nudged: false,
    });
    appendLine(COMPLIANCE_FILE, {
      ts: LONG_AGO,
      session_id: "s2",
      tool_name: "Workflow",
      tool_input_sha256: "b".repeat(64),
      bound_tid: null,
      nudged: true,
    });
    const result = drain();
    expect(result.compliance).toMatchObject({ read: 2, nudged: 1, unbound: 1, malformed: 0 });
    const missed = result.anomalies.filter((a) => a.kind === "missed_estimate");
    expect(missed).toHaveLength(1);
    expect(missed[0]!.detail).toContain("Workflow");
    expect(missed[0]!.detail).toContain("(nudged)");
  });

  test("whether a nudge was emitted is recorded — the view cannot reconstruct it", () => {
    appendLine(COMPLIANCE_FILE, { ts: LONG_AGO, session_id: "s3", tool_name: "Task", bound_tid: null, nudged: false });
    const result = drain();
    expect(result.anomalies[0]!.detail).toContain("no nudge emitted");
  });

  test("compliance records write no rows of their own (Phase 1's schema delta is two things)", () => {
    appendLine(COMPLIANCE_FILE, { ts: LONG_AGO, session_id: "s1", tool_name: "Task", bound_tid: "t", nudged: false });
    drain();
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()?.n).toBe(0);
  });

  test("a malformed compliance line is counted, and the good lines still land", () => {
    appendFileSync(join(spool, COMPLIANCE_FILE), "not json at all\n", "utf8");
    appendLine(COMPLIANCE_FILE, { ts: LONG_AGO, session_id: "s1", tool_name: "Task", bound_tid: null, nudged: true });
    const result = drain();
    expect(result.compliance.read).toBe(1);
    expect(result.compliance.malformed).toBe(1);
    expect(parseComplianceLines("null\n").malformed).toBe(1);
  });

  test("a db_unavailable line is NOT a compliance miss — it is evidence of nothing", () => {
    // The hook writes this when it could not read the database at all (missing,
    // locked, schema ahead of it). Counting its null `bound_tid` as unbound turns a
    // broken file into a permanent missed_estimate anomaly and poisons §3.3's rate.
    appendLine(COMPLIANCE_FILE, {
      ts: LONG_AGO,
      session_id: "s9",
      tool_name: "Task",
      tool_input_sha256: "c".repeat(64),
      bound_tid: null,
      nudged: false,
      nudge_kind: "none",
      db_unavailable: true,
    });
    const result = drain();
    expect(result.compliance).toMatchObject({ read: 1, nudged: 0, unbound: 0, db_unavailable: 1 });
    expect(result.anomalies.filter((a) => a.kind === "missed_estimate")).toHaveLength(0);
  });

  test("nudge_kind carries the overrun nudge, which `nudged` alone used to hide", () => {
    const rows = parseComplianceLines(
      `${JSON.stringify({ ts: LONG_AGO, session_id: "s1", tool_name: "Task", bound_tid: "t1", nudged: true, nudge_kind: "overrun" })}\n`,
    ).rows;
    expect(rows[0]).toMatchObject({ nudged: true, nudge_kind: "overrun", db_unavailable: false });

    // A line written before the field existed still says which nudge it was: a bound
    // task can only have been nudged about its band.
    const legacy = parseComplianceLines(
      `${JSON.stringify({ ts: LONG_AGO, session_id: "s1", tool_name: "Task", bound_tid: null, nudged: true })}\n`,
    ).rows;
    expect(legacy[0]!.nudge_kind).toBe("no_estimate");
  });

  test("an overrun nudge counts into compliance.nudged without being a miss", () => {
    appendLine(COMPLIANCE_FILE, {
      ts: LONG_AGO,
      session_id: "s1",
      tool_name: "Task",
      bound_tid: "t1",
      nudged: true,
      nudge_kind: "overrun",
    });
    const result = drain();
    expect(result.compliance).toMatchObject({ read: 1, nudged: 1, unbound: 0 });
    expect(result.anomalies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hook marker files — the spool's other residue
// ---------------------------------------------------------------------------

describe("pruneMarkers — nothing else enumerates the spool directory", () => {
  const touch = (name: string, ageMs: number): void => {
    const path = join(spool, name);
    writeFileSync(path, "x");
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  };

  test("a stale .microsweep marker is reaped and a fresh one is left armed", () => {
    touch(MICROSWEEP_MARKER, 2 * 60 * 60 * 1000);
    expect(pruneMarkers(spool)).toBe(1);
    expect(existsSync(join(spool, MICROSWEEP_MARKER))).toBe(false);

    touch(MICROSWEEP_MARKER, 5 * 1000); // inside the 20 s throttle window
    expect(pruneMarkers(spool)).toBe(0);
    expect(existsSync(join(spool, MICROSWEEP_MARKER))).toBe(true);
  });

  test("per-session markers from the pre-global throttle are reaped too", () => {
    touch(`${MICROSWEEP_MARKER}.some-session-id`, 2 * 60 * 60 * 1000);
    expect(pruneMarkers(spool)).toBe(1);
    expect(readdirSync(spool)).toEqual([]);
  });

  test("an overrun marker survives an hour and is reaped on the long horizon", () => {
    touch(overrunMarkerFile("t-live"), 2 * 60 * 60 * 1000);
    touch(overrunMarkerFile("t-forgotten"), 31 * 24 * 60 * 60 * 1000);
    expect(pruneMarkers(spool)).toBe(1);
    expect(existsSync(join(spool, overrunMarkerFile("t-live")))).toBe(true);
    expect(existsSync(join(spool, overrunMarkerFile("t-forgotten")))).toBe(false);
  });

  test("the spool files themselves are never touched, however old", () => {
    touch(COMPLIANCE_FILE, 365 * 24 * 60 * 60 * 1000);
    touch(`${TASK_EVENTS_FILE}.draining`, 365 * 24 * 60 * 60 * 1000);
    expect(pruneMarkers(spool)).toBe(0);
    expect(readdirSync(spool).sort()).toEqual([COMPLIANCE_FILE, `${TASK_EVENTS_FILE}.draining`].sort());
  });

  test("every drain prunes, so no scheduler entry of its own is needed", () => {
    touch(MICROSWEEP_MARKER, 2 * 60 * 60 * 1000);
    expect(drain().markers_pruned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// crash safety — the property the whole spool design exists for
// ---------------------------------------------------------------------------

describe("drainSpool — crash safety", () => {
  test("the live file is renamed, not truncated, so a concurrent append is not lost", () => {
    appendLine(TASK_EVENTS_FILE, { ts: LONG_AGO, session_id: "s1", task_num: "1", to_status: "deleted" });
    // Simulate the hook firing DURING the drain: the reader has already claimed the
    // old file, so this append creates a fresh one.
    let mid = 0;
    h.db.transaction(() => {
      const r = drainSpool(h.db, spool);
      appendLine(TASK_EVENTS_FILE, { ts: LONG_AGO, session_id: "s1", task_num: "2", to_status: "deleted" });
      mid = r.task_events.inserted;
      r.cleanup();
    }).immediate();
    expect(mid).toBe(1);

    // The record written mid-drain survives and lands on the next sweep.
    expect(drain().task_events.inserted).toBe(1);
    const nums = h.db.query<{ task_num: string }, []>("SELECT task_num FROM task_event ORDER BY task_num").all();
    expect(nums.map((r) => r.task_num)).toEqual(["1", "2"]);
  });

  test("a `.draining` residue from a dead sweep is recovered first, not orphaned", () => {
    // Exactly what a crash between the rename and the commit leaves behind.
    appendLine(TASK_EVENTS_FILE, { ts: LONG_AGO, session_id: "s1", task_num: "5", to_status: "deleted" });
    renameSync(join(spool, TASK_EVENTS_FILE), join(spool, `${TASK_EVENTS_FILE}.draining`));
    appendLine(TASK_EVENTS_FILE, { ts: LONG_AGO, session_id: "s1", task_num: "6", to_status: "deleted" });

    const first = drain();
    expect(first.task_events.inserted).toBe(1);
    expect(existsSync(join(spool, `${TASK_EVENTS_FILE}.draining`))).toBe(false);
    // The live file waited its turn rather than being merged and double-counted.
    expect(existsSync(join(spool, TASK_EVENTS_FILE))).toBe(true);
    expect(drain().task_events.inserted).toBe(1);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()?.n).toBe(2);
  });

  test("cleanup() runs after the commit, so a failed transaction keeps the records on disk", () => {
    appendLine(TASK_EVENTS_FILE, { ts: LONG_AGO, session_id: "s1", task_num: "8", to_status: "deleted" });
    // Drain, then abandon the transaction WITHOUT calling cleanup — the shape of a
    // process dying mid-sweep. The claimed file must still be on disk.
    let claimedExists = false;
    try {
      h.db.transaction(() => {
        drainSpool(h.db, spool);
        throw new Error("simulated crash before commit");
      }).immediate();
    } catch {
      claimedExists = existsSync(join(spool, `${TASK_EVENTS_FILE}.draining`));
    }
    expect(claimedExists).toBe(true);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()?.n).toBe(0);
    // The next sweep finishes the job.
    expect(drain().task_events.inserted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P1.11's mandatory regression test — the reader half
// ---------------------------------------------------------------------------

describe("P1.11 mandatory regression — a deletion whose tool_result was never written", () => {
  test("the spooled hook row is the only signal, and it still yields a censored 'deleted' outcome", async () => {
    // Setup: a task with a Task-tool binding and some spend, quiescent.
    turn(h.db, { session: "s1", prompt: "p1", at: LONG_AGO, durationMs: 60_000 });
    const opened = await h.cli(...openArgs(), "--session", "s1", "--prompt", "p1", "--json");
    const tid = opened.json<{ tid: string }>().tid;
    expect((await h.cli("bind", tid, "--session", "s1", "--task", "13")).code).toBe(0);
    request(h.db, "r1", { out: 400, ts: "2026-01-01T00:01:00Z" });
    attributeTasks(h.db);

    // The session died between the TaskUpdate `tool_use` and its `tool_result`, so
    // there is NO transcript record of the deletion — the sweeper writes none — and
    // G-DELETE found the file-presence fallback unreliable in both directions. The
    // PreToolUse hook's spooled line is the only thing that survived.
    appendLine(TASK_EVENTS_FILE, {
      ts: "2026-01-01T00:02:00Z",
      session_id: "s1",
      task_num: "13",
      to_status: "deleted",
      source: "pretooluse",
    });
    const drained = drain();
    expect(drained.task_events.inserted).toBe(1);

    const recorded = h.db.query<{ source: string }, []>(
      "SELECT source FROM task_event WHERE to_status = 'deleted'",
    ).get()!;
    expect(recorded.source).toBe("pretooluse");

    // That row is a completion signal, so the task is closeable, and the outcome it
    // produces is `deleted` and right-censored: the actual is a LOWER bound.
    const outcome = closeTask(h.db, { tid, status: "deleted", now: NOW });
    expect(outcome.final_status).toBe("deleted");
    expect(outcome.censored).toBe(true);
    expect(outcome.actual_wcet).toBe(400);
    // Censored rows never enter the velocity corpus — an abandoned task's actual is
    // not evidence about how big the work was.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_velocity").get()?.n).toBe(0);
  });

  test("closing a task disarms its overrun marker rather than leaving it to the 30-day prune", async () => {
    turn(h.db, { session: "s2", prompt: "p2", at: LONG_AGO, durationMs: 60_000 });
    const opened = await h.cli(...openArgs(), "--session", "s2", "--prompt", "p2", "--json");
    const tid = opened.json<{ tid: string }>().tid;
    request(h.db, "r2", { out: 400, ts: "2026-01-01T00:01:00Z" });
    attributeTasks(h.db);

    const marker = join(spool, overrunMarkerFile(tid));
    writeFileSync(marker, JSON.stringify({ band: "v1:1000", ts: LONG_AGO }));
    closeTask(h.db, { tid, status: "completed", now: NOW, force: true, spoolDir: spool });
    // Left behind, it would leak a file AND swallow the first nudge after a reopen.
    expect(existsSync(marker)).toBe(false);
  });

  test("without the spooled row there is no deletion record at all — which is the point", () => {
    // The negative control: same scenario, hook not installed. Nothing in the corpus
    // says the task was deleted, and the design's answer to that is the hook above.
    rmSync(join(spool, TASK_EVENTS_FILE), { force: true });
    drain();
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event").get()?.n).toBe(0);
  });
});

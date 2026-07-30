/**
 * The PLANTED `est_tid` — §3.2 step 6, and the join that was missing from it.
 *
 * The ceremony's last step is `TaskUpdate({ taskId: "<n>", metadata: { est_tid } })`,
 * and until this pass existed the sweeper watched the wrong half of that call. The
 * harness reports a `TaskUpdate` back as `updatedFields: ["metadata", ...]` — the
 * planted VALUE never appears in `toolUseResult` — so an ingest reading results alone
 * saw "some metadata changed" and minted nothing. The live corpus held ZERO
 * `task_alias(id_kind='session_task')` rows because of it, and that is not a cosmetic
 * gap: §6.2's completion-signal arm (src/close.ts `quiescence`) looks `task_event` up
 * BY that alias, so every close fell through to the 48-hour staleness backstop.
 *
 * Every fixture here is synthetic — invented session ids, invented task numbers, and
 * tids minted by `est open` inside the test's own temp database.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeHarness, openArgs, seedPrices, type Harness } from "./support.ts";
import { BENIGN_ANOMALY_KINDS, runSweep } from "../src/cli.ts";
import { quiescence } from "../src/close.ts";

/** Invented, and shaped like a session id so discovery accepts the filename. */
const SESSION = "cafe1234-1111-4111-8111-abcabcabcabc";
const TASK_NUM = "7";

let h: Harness;
const roots: string[] = [];

beforeEach(() => {
  h = makeHarness("est-plant-");
  seedPrices(h.db);
});

afterEach(() => {
  h.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "est-plant-corpus-"));
  roots.push(root);
  return root;
}

function write(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

/** The human line that opens the turn every tool call below belongs to. */
function promptLine(ts: string): string {
  return JSON.stringify({
    type: "user",
    uuid: "u-prompt",
    sessionId: SESSION,
    isSidechain: false,
    userType: "external",
    promptId: "P1",
    timestamp: ts,
    message: { role: "user", content: "go" },
  });
}

/**
 * An assistant line that emits ONE `tool_use` block, carrying usage the way every
 * real assistant line does — the plant reader shares this line with the request
 * extractor, so a fixture without usage would be testing a shape that never occurs.
 */
function toolUse(o: { uuid: string; id: string; name: string; input: unknown; ts: string }): string {
  return JSON.stringify({
    type: "assistant",
    uuid: o.uuid,
    sessionId: SESSION,
    isSidechain: false,
    promptId: null,
    timestamp: o.ts,
    requestId: `req_${o.uuid}`,
    message: {
      id: `msg_${o.uuid}`,
      role: "assistant",
      model: "claude-test-1",
      content: [{ type: "tool_use", id: o.id, name: o.name, input: o.input }],
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: 10,
      },
    },
  });
}

/**
 * The matching `tool_result` line, carrying whatever the harness reports back.
 *
 * `ids` is a LIST because parallel tool calls can land their results on one line, and
 * which block a plant belongs to is the difference between the right task number and
 * a permanent binding to the wrong one.
 */
function toolResult(o: {
  uuid: string;
  id?: string;
  ids?: Array<{ id: string; isError?: boolean }>;
  result: unknown;
  ts: string;
}): string {
  const blocks = (o.ids ?? [{ id: o.id ?? "" }]).map((b) => ({
    type: "tool_result",
    tool_use_id: b.id,
    content: b.isError === true ? "Error: no such task" : "ok",
    ...(b.isError === true ? { is_error: true } : {}),
  }));
  return JSON.stringify({
    type: "user",
    uuid: o.uuid,
    sessionId: SESSION,
    isSidechain: false,
    userType: "external",
    promptId: "P1",
    timestamp: o.ts,
    message: { role: "user", content: blocks },
    toolUseResult: o.result,
  });
}

/**
 * The whole lifecycle of one harness task: created, planted + started, completed.
 * `plantOn` chooses WHICH call carries the metadata, because the two need different
 * machinery — `TaskUpdate` names its task number in the input, `TaskCreate` cannot.
 */
function lifecycle(tid: string, plantOn: "update" | "create" = "update"): string[] {
  const createInput = plantOn === "create"
    ? { subject: "synthetic work", metadata: { est_tid: tid } }
    : { subject: "synthetic work" };
  const updateInput = plantOn === "update"
    ? { taskId: TASK_NUM, status: "in_progress", metadata: { est_tid: tid } }
    : { taskId: TASK_NUM, status: "in_progress" };
  return [
    promptLine("2026-07-30T10:00:00.000Z"),
    toolUse({ uuid: "a1", id: "toolu_c", name: "TaskCreate", input: createInput, ts: "2026-07-30T10:00:01.000Z" }),
    toolResult({
      uuid: "u1",
      id: "toolu_c",
      result: { task: { id: TASK_NUM, subject: "synthetic work" } },
      ts: "2026-07-30T10:00:02.000Z",
    }),
    toolUse({ uuid: "a2", id: "toolu_u1", name: "TaskUpdate", input: updateInput, ts: "2026-07-30T10:00:03.000Z" }),
    toolResult({
      uuid: "u2",
      id: "toolu_u1",
      result: {
        success: true,
        taskId: TASK_NUM,
        // Exactly what the harness reports: the metadata CHANGED, and its value is
        // nowhere on this side of the call.
        updatedFields: ["metadata", "status"],
        statusChange: { from: "pending", to: "in_progress" },
      },
      ts: "2026-07-30T10:00:04.000Z",
    }),
    toolUse({
      uuid: "a3",
      id: "toolu_u2",
      name: "TaskUpdate",
      input: { taskId: TASK_NUM, status: "completed" },
      ts: "2026-07-30T10:00:05.000Z",
    }),
    toolResult({
      uuid: "u3",
      id: "toolu_u2",
      result: {
        success: true,
        taskId: TASK_NUM,
        updatedFields: ["status"],
        statusChange: { from: "in_progress", to: "completed" },
      },
      ts: "2026-07-30T10:00:06.000Z",
    }),
  ];
}

/** `est open`, anchored to the synthetic session the corpus below belongs to. */
async function openTask(): Promise<string> {
  const r = await h.cli(...openArgs(), "--session", SESSION, "--prompt", "P1", "--json");
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

function corpusFor(lines: readonly string[]): string {
  const root = newRoot();
  write(join(root, "-Users-craig-demo", `${SESSION}.jsonl`), lines);
  return root;
}

const aliasRows = (): Array<{ tid: string; local_id: string; source: string }> =>
  h.db
    .query<{ tid: string; local_id: string; source: string }, []>(
      "SELECT tid, local_id, source FROM task_alias WHERE id_kind = 'session_task' ORDER BY local_id",
    )
    .all();

describe("session_task aliases from a planted est_tid", () => {
  test("a TaskUpdate plant mints the alias, links every task_event, and re-sweeps clean", async () => {
    const tid = await openTask();
    const root = corpusFor(lifecycle(tid));

    const swept = await h.cli("sweep", "--root", root, "--json");
    expect([0, 3]).toContain(swept.code);
    const report = swept.json<{ rows: { task_plants: number; task_event_tids: number } }>();
    expect(report.rows.task_plants).toBe(1);

    expect(aliasRows()).toEqual([{ tid, local_id: TASK_NUM, source: "sweeper" }]);

    // Three lifecycle events (one create, two transitions), all pointing at the task.
    const linked = h.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM task_event WHERE tid = ?")
      .get(tid)!.n;
    expect(linked).toBe(3);
    expect(report.rows.task_event_tids).toBe(3);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event WHERE tid IS NULL").get()!.n,
    ).toBe(0);

    // §5.8: a re-sweep of an unchanged corpus is a no-op. The alias insert is
    // `OR IGNORE` and the backfill only touches NULLs, so the second pass moves
    // nothing at all — not even the rows it would otherwise rewrite identically.
    const again = await runSweep(h.db, { root, full: true });
    expect(again.rows.task_event_tids).toBe(0);
    expect(aliasRows()).toEqual([{ tid, local_id: TASK_NUM, source: "sweeper" }]);
  });

  test("a plant on TaskCreate is resolved through its tool_use id", async () => {
    // The create's input cannot name a task number — the harness assigns one in the
    // result — so the plant is held by `tool_use_id` until that result arrives.
    const tid = await openTask();
    const swept = await h.cli("sweep", "--root", corpusFor(lifecycle(tid, "create")), "--json");
    expect([0, 3]).toContain(swept.code);
    expect(aliasRows()).toEqual([{ tid, local_id: TASK_NUM, source: "sweeper" }]);
  });

  test("a plant naming a tid this database never minted is dropped AND reported", async () => {
    // A transcript is untrusted input: a tid from another machine, or one whose task
    // row is gone, must not become an alias pointing at nothing (`est audit` counts
    // that as damage). The lifecycle rows still land; only the join is withheld — and
    // the withholding is reported, because a silent drop is indistinguishable from the
    // ingest bug this whole pass exists to fix.
    await openTask();
    const stranger = "019f0000-0000-7000-8000-000000000000";
    const swept = await h.cli("sweep", "--root", corpusFor(lifecycle(stranger)), "--json");
    expect([0, 3]).toContain(swept.code);
    expect(aliasRows()).toEqual([]);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_event WHERE tid IS NOT NULL").get()!.n,
    ).toBe(0);

    const row = h.db
      .query<{ detail: string }, []>("SELECT detail FROM anomaly WHERE kind = 'plant_unlinked'")
      .get();
    expect(row?.detail).toContain(TASK_NUM);
    // The recovery story, stated truthfully: every sweep reads a growing transcript in
    // FULL (`readJsonl` streams from byte zero; `sweep_state.bytes_read` only decides
    // whether to open the file at all), so the retry is automatic while the session is
    // live, and `est backfill` is only needed once the file has settled.
    expect(row?.detail).toContain("re-reads the transcript");
    expect(row?.detail).toContain("est backfill");
    // Benign: refusing the alias is the correct outcome, so it must not make the
    // nightly sweep exit 3 forever.
    expect(BENIGN_ANOMALY_KINDS.has("plant_unlinked")).toBe(true);
  });

  test("results batched onto ONE line bind by tool_use_id, never by position", async () => {
    // Parallel tool calls: the plant's result is the SECOND block on the line. Taking
    // content[0] would mint `session_task` for the wrong harness task number — and
    // because the alias is first-plant-wins and physically exclusive, no re-sweep
    // could ever correct it.
    const tid = await openTask();
    const root = corpusFor([
      promptLine("2026-07-30T10:00:00.000Z"),
      toolUse({
        uuid: "a1",
        id: "toolu_other",
        name: "TaskUpdate",
        input: { taskId: "99", status: "in_progress" },
        ts: "2026-07-30T10:00:01.000Z",
      }),
      toolUse({
        uuid: "a2",
        id: "toolu_plant",
        name: "TaskUpdate",
        input: { taskId: TASK_NUM, status: "in_progress", metadata: { est_tid: tid } },
        ts: "2026-07-30T10:00:02.000Z",
      }),
      toolResult({
        uuid: "u1",
        ids: [{ id: "toolu_other" }, { id: "toolu_plant" }],
        result: { success: true, taskId: "99", updatedFields: ["status"] },
        ts: "2026-07-30T10:00:03.000Z",
      }),
    ]);
    const swept = await h.cli("sweep", "--root", root, "--json");
    expect([0, 3]).toContain(swept.code);
    expect(aliasRows()).toEqual([{ tid, local_id: TASK_NUM, source: "sweeper" }]);
  });

  test("a plant whose call ERRORED never becomes the alias", async () => {
    // `TaskUpdate` against a task id the harness rejects comes back `is_error`. Minting
    // from the attempt would freeze the corpus onto a number that was never accepted,
    // and first-plant-wins means the RETRY could then never bind.
    const tid = await openTask();
    const root = corpusFor([
      promptLine("2026-07-30T10:00:00.000Z"),
      toolUse({
        uuid: "a1",
        id: "toolu_bad",
        name: "TaskUpdate",
        input: { taskId: "404", status: "in_progress", metadata: { est_tid: tid } },
        ts: "2026-07-30T10:00:01.000Z",
      }),
      toolResult({
        uuid: "u1",
        ids: [{ id: "toolu_bad", isError: true }],
        result: { success: false, error: "no such task" },
        ts: "2026-07-30T10:00:02.000Z",
      }),
      // The retry, against the number that exists, binds normally.
      ...lifecycle(tid),
    ]);
    const swept = await h.cli("sweep", "--root", root, "--json");
    expect([0, 3]).toContain(swept.code);
    expect(aliasRows()).toEqual([{ tid, local_id: TASK_NUM, source: "sweeper" }]);
  });

  test("a plant whose tool_result never arrived is reported, not silently dropped", async () => {
    // The P1.11 shape: the session died between the `tool_use` line and its result, so
    // the harness's verdict on that call is not on disk. Dropping the plant is right —
    // an alias minted from a call nobody saw succeed is permanent — but a silent drop
    // makes "never planted" and "planted and lost" look identical.
    const tid = await openTask();
    const root = corpusFor([
      promptLine("2026-07-30T10:00:00.000Z"),
      toolUse({
        uuid: "a1",
        id: "toolu_orphan",
        name: "TaskUpdate",
        input: { taskId: TASK_NUM, status: "in_progress", metadata: { est_tid: tid } },
        ts: "2026-07-30T10:00:01.000Z",
      }),
    ]);
    const swept = await h.cli("sweep", "--root", root, "--json");
    expect([0, 3]).toContain(swept.code);
    expect(aliasRows()).toEqual([]);

    const row = h.db
      .query<{ detail: string }, []>("SELECT detail FROM anomaly WHERE kind = 'plant_unlinked'")
      .get();
    expect(row?.detail).toContain("toolu_orphan");
    expect(row?.detail).toContain("never acknowledged");
  });

  test("a task number re-planted at a SECOND tid keeps the first binding", async () => {
    // `ux_alias_exclusive` is the physical guard: one harness task number is exactly
    // one logical task's, and silently re-pointing it would split one stream of spend
    // across two actuals. First plant wins; the second is ignored, not an error.
    const first = await openTask();
    const swept = await h.cli("sweep", "--root", corpusFor(lifecycle(first)), "--json");
    expect([0, 3]).toContain(swept.code);

    const second = await openTask();
    const root = corpusFor([
      ...lifecycle(first),
      toolUse({
        uuid: "a9",
        id: "toolu_u9",
        name: "TaskUpdate",
        input: { taskId: TASK_NUM, metadata: { est_tid: second } },
        ts: "2026-07-30T10:10:00.000Z",
      }),
      toolResult({
        uuid: "u9",
        id: "toolu_u9",
        result: { success: true, taskId: TASK_NUM, updatedFields: ["metadata"] },
        ts: "2026-07-30T10:10:01.000Z",
      }),
    ]);
    await runSweep(h.db, { root, full: true });
    expect(aliasRows()).toEqual([{ tid: first, local_id: TASK_NUM, source: "sweeper" }]);
  });
});

describe("the §6.2 completion-signal arm, once the alias exists", () => {
  test("goes from 'no completion signal' to a real signal across the sweep", async () => {
    const tid = await openTask();
    const now = new Date("2026-07-30T10:30:00.000Z");

    // Before: nothing links the harness task to the tid, so the only way this task
    // could ever close was the 48-hour staleness backstop.
    const before = quiescence(h.db, tid, now);
    expect(before.completion_signal).toBe(false);
    expect(before.failing.join(" | ")).toContain("no completion signal");

    const swept = await h.cli("sweep", "--root", corpusFor(lifecycle(tid)), "--json");
    expect([0, 3]).toContain(swept.code);

    const after = quiescence(h.db, tid, now);
    expect(after.completion_signal).toBe(true);
    expect(after.failing.join(" | ")).not.toContain("no completion signal");
    // Still not closeable, and that is the point: the OTHER conditions are what hold
    // it now (the task's own activity is minutes old, not hours), so the arm this
    // test is about is the one that changed.
    expect(after.ok).toBe(false);
    expect(after.failing.length).toBeGreaterThan(0);
  });
});

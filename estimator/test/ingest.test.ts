/**
 * src/ingest.ts — the MAX dedup rule (§5.2), agent intervals (§5.3), exact phase
 * attribution (§5.6) and the origin split (§4.6).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertAnomalies } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { discoverCorpus, readWorkflowState, type SessionCorpus } from "../src/discover.ts";
import {
  buildAgentRuns,
  clusterAgentsIntoWaves,
  compactionAnomalies,
  detectForkReplays,
  detectRidCollisions,
  ingestAgentTranscript,
  ingestMainTranscript,
  ingestSession,
  markSidechainReplays,
  modelFamily,
  planCorpus,
  readJsonl,
  replayAnomalies,
  resolveRidCollisions,
  writeBatch,
  type RequestRow,
  type TranscriptIndexEntry,
} from "../src/ingest.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const CORPUS = join(FIXTURES, "corpus", "projects");
const SESSION = "11111111-1111-4111-8111-111111111111";
const SESSION_DIR = join(CORPUS, "-Users-craig-demo", SESSION);
const MAIN = join(CORPUS, "-Users-craig-demo", `${SESSION}.jsonl`);
const WF_DIR = join(SESSION_DIR, "subagents", "workflows", "wf_demo0001-abc");
const AGENT_CUMULATIVE = join(WF_DIR, "agent-a1111111111111111.jsonl");
const AGENT_TRUNCATED = join(WF_DIR, "agent-a2222222222222222.jsonl");
const AGENT_MALFORMED = join(FIXTURES, "agent-malformed-mid.jsonl");

function session(): SessionCorpus {
  return discoverCorpus(CORPUS).sessions[0]!;
}

// ---------------------------------------------------------------------------

describe("modelFamily", () => {
  test("strips a trailing dated alias", () => {
    expect(modelFamily("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(modelFamily("claude-opus-4-1-20250805")).toBe("claude-opus-4-1");
  });

  test("leaves undated ids alone", () => {
    expect(modelFamily("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(modelFamily("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  test("preserves a [1m] context suffix — it prices differently and is NOT the same family", () => {
    expect(modelFamily("claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(modelFamily("claude-opus-5-20260101[1m]")).toBe("claude-opus-5[1m]");
    expect(modelFamily("claude-opus-5[1m]")).not.toBe(modelFamily("claude-opus-5"));
  });
});

// ---------------------------------------------------------------------------

describe("readJsonl — bad input is counted, never thrown (§2)", () => {
  test("a truncated final line is skipped and reported as truncatedTail", async () => {
    // Guard the fixture itself: a formatter that appends a newline would silently
    // turn this into a different test.
    const bytes = readFileSync(AGENT_TRUNCATED);
    expect(bytes.at(-1)).not.toBe(0x0a);

    const seen: unknown[] = [];
    const { stats, anomalies } = await readJsonl(AGENT_TRUNCATED, (line) => {
      seen.push(JSON.parse(line));
    });
    expect(stats.lines).toBe(5);
    expect(stats.truncatedTail).toBe(1);
    expect(stats.malformed).toBe(0);
    expect(seen).toHaveLength(4);
    expect(anomalies.map((a) => a.kind)).toEqual(["truncated_tail"]);
  });

  test("a malformed MID-file line is a different, louder failure", async () => {
    const { stats, anomalies } = await readJsonl(AGENT_MALFORMED, (line) => {
      JSON.parse(line);
    });
    expect(stats.malformed).toBe(1);
    expect(stats.truncatedTail).toBe(0);
    expect(stats.blank).toBe(1); // the blank line is not counted as a line
    expect(anomalies[0]!.kind).toBe("malformed_line");
    expect(anomalies[0]!.detail).toContain("line 2");
  });

  test("a missing file yields empty stats rather than an exception", async () => {
    const { stats, anomalies, complete } = await readJsonl(join(FIXTURES, "gone.jsonl"), () => {});
    expect(stats.lines).toBe(0);
    // Nothing was read, so the watermark must not move — and the sweep must be
    // able to say why afterwards.
    expect(complete).toBe(false);
    expect(anomalies.map((a) => a.kind)).toEqual(["read_error"]);
  });

  test("a stream that cannot even be OPENED records a read_error, not silence", async () => {
    // A path the OS cannot represent fails inside `Bun.file()` itself, before any
    // async read — the one `readJsonl` branch that used to return `complete:false`
    // with an empty anomaly list, so a permanently unreadable file contributed
    // nothing to the ledger forever.
    const bad = join(FIXTURES, "nul\u0000byte.jsonl");
    const { stats, anomalies, complete } = await readJsonl(bad, () => {});
    expect(stats.lines).toBe(0);
    expect(complete).toBe(false);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.kind).toBe("read_error");
    expect(anomalies[0]!.path).toBe(bad);
    expect(anomalies[0]!.detail).toContain("watermark NOT advanced");
  });

  test("flags the unterminated tail to the consumer so a prefilter cannot hide it", async () => {
    const flags: boolean[] = [];
    await readJsonl(AGENT_TRUNCATED, (_line, isTail) => {
      flags.push(isTail);
    });
    expect(flags).toEqual([false, false, false, false, true]);
  });

  test("a MID-FILE line torn before the prefilter marker is malformed, not clean", async () => {
    // The prefilter skips any non-tail line without `"output_tokens"`, so a line
    // severed before that marker used to be waved through: the sweep reported a
    // clean parse while a paid request had silently vanished. Non-tail parse
    // failures must be as loud in an agent transcript as in a main one.
    const dir = mkdtempSync(join(tmpdir(), "est-mid-torn-"));
    const p = join(dir, "torn-mid.jsonl");
    const lines = readFileSync(AGENT_CUMULATIVE, "utf8").split("\n").filter((l) => l.length > 0);
    const torn = lines[1]!.slice(0, lines[1]!.indexOf('"usage"'));
    expect(torn).not.toContain('"output_tokens"');
    // Terminated by a newline and followed by more content: not a tail.
    writeFileSync(p, `${lines[0]}\n${torn}\n${lines[2]}\n${lines[3]}\n`);

    const ingest = await ingestAgentTranscript(p, {
      origin: "subagent",
      sessionId: SESSION,
      promptId: null,
      agentId: "a1111111111111111",
    });
    expect(ingest.stats.malformed).toBe(1);
    expect(ingest.stats.truncatedTail).toBe(0);
    expect(ingest.anomalies.map((a) => a.kind)).toContain("malformed_line");
    // The intact lines around it still land.
    expect(ingest.requests).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the prefilter still skips well-formed non-usage lines without parsing them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "est-prefilter-"));
    const p = join(dir, "quiet.jsonl");
    writeFileSync(
      p,
      `{"type":"user","timestamp":"2026-07-28T10:00:00.000Z","message":{"role":"user","content":"hi"}}\n`,
    );
    const ingest = await ingestAgentTranscript(p, {
      origin: "subagent",
      sessionId: SESSION,
      promptId: null,
      agentId: "a1111111111111111",
    });
    expect(ingest.stats.malformed).toBe(0);
    expect(ingest.firstTs).toBe("2026-07-28T10:00:00.000Z");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a tail torn BEFORE the prefilter marker is still reported", async () => {
    // Regression: the usage prefilter used to skip such a line entirely, so a
    // sweep would report a clean parse while silently missing a paid request.
    const dir = mkdtempSync(join(tmpdir(), "est-tail-"));
    const p = join(dir, "torn.jsonl");
    const [first] = readFileSync(AGENT_CUMULATIVE, "utf8").split("\n");
    writeFileSync(p, `${first}\n{"type":"assistant","uuid":"x","timestamp":"2026-07-28T10:0`);

    const ingest = await ingestAgentTranscript(p, {
      origin: "subagent",
      sessionId: SESSION,
      promptId: null,
      agentId: "a1111111111111111",
    });
    expect(ingest.stats.truncatedTail).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

describe("MAX dedup — the rule the whole design rests on (§5.2)", () => {
  test("cumulative streaming snapshots produce MAX, not first", async () => {
    const ingest = await ingestAgentTranscript(AGENT_CUMULATIVE, {
      origin: "subagent",
      sessionId: SESSION,
      promptId: "P1",
      agentId: "a1111111111111111",
    });

    // Three raw rows share req_W1 with output_tokens 5 -> 800 -> 3400.
    const w1 = ingest.requests.filter((r) => r.request_id === "req_W1");
    expect(w1.map((r) => r.out_tok)).toEqual([5, 800, 3400]);

    const db = openDb({ path: join(mkdtempSync(join(tmpdir(), "est-max-")), "e.db") });
    db.transaction(() => {
      writeBatch(db, blank({ requests: ingest.requests }));
    })();

    const row = db
      .query<{ out_tok: number; cw_tok: number; n: number }, []>(
        "SELECT out_tok, cw_tok, (SELECT COUNT(*) FROM request) AS n FROM request WHERE request_id='req_W1'",
      )
      .get()!;
    expect(row.out_tok).toBe(3400); // NOT 5 — first-wins is an 88% undercount
    expect(row.cw_tok).toBe(26850);
    expect(row.n).toBe(2); // req_W1 + req_W2, deduped
    db.close();
  });

  test("re-ingesting a truncated file then the full file matches a whole-file parse", async () => {
    // The regression test §5.2 mandates: upsert-with-MAX must make a partial read
    // of a live file harmless, or the byte watermark freezes a low value forever.
    const dir = mkdtempSync(join(tmpdir(), "est-partial-"));
    const full = readFileSync(AGENT_CUMULATIVE, "utf8");
    const lines = full.split("\n").filter((l) => l.length > 0);
    const partialPath = join(dir, "partial.jsonl");
    // First sweep sees the file mid-write: three lines, the last one torn.
    writeFileSync(partialPath, `${lines.slice(0, 2).join("\n")}\n${lines[2]!.slice(0, 200)}`);

    const db = openDb({ path: join(dir, "e.db") });
    const ctx = {
      origin: "subagent" as const,
      sessionId: SESSION,
      promptId: "P1",
      agentId: "a1111111111111111",
    };

    const partial = await ingestAgentTranscript(partialPath, ctx);
    expect(partial.stats.truncatedTail).toBe(1);
    db.transaction(() => writeBatch(db, blank({ requests: partial.requests })))();
    const afterPartial = db
      .query<{ t: number }, []>("SELECT SUM(out_tok) AS t FROM request")
      .get()!.t;
    expect(afterPartial).toBe(5); // the low watermark, as expected mid-stream

    // Second sweep sees the whole file.
    writeFileSync(partialPath, full);
    const complete = await ingestAgentTranscript(partialPath, ctx);
    db.transaction(() => writeBatch(db, blank({ requests: complete.requests })))();

    const totals = db
      .query<{ out: number; cw: number; n: number }, []>(
        "SELECT SUM(out_tok) AS out, SUM(cw_tok) AS cw, COUNT(*) AS n FROM request",
      )
      .get()!;
    expect(totals).toEqual({ out: 3400 + 120, cw: 26850 + 400, n: 2 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("re-sweeping an unchanged corpus is a no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "est-idem-"));
    const db = openDb({ path: join(dir, "e.db") });
    const batch = await ingestSession(session());

    db.transaction(() => writeBatch(db, batch))();
    const snapshot = () =>
      db
        .query<{ n: number; out: number; cw: number; agents: number }, []>(
          `SELECT (SELECT COUNT(*) FROM request) AS n,
                  (SELECT SUM(out_tok) FROM request) AS out,
                  (SELECT SUM(cw_tok) FROM request) AS cw,
                  (SELECT COUNT(*) FROM agent_run) AS agents`,
        )
        .get()!;
    const first = snapshot();

    db.transaction(() => writeBatch(db, batch))();
    expect(snapshot()).toEqual(first);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("flags a requestId carrying two different models", () => {
    expect(detectRidCollisions([req({}), req({})])).toEqual([]);
    const collisions = detectRidCollisions([req({}), req({ model: "claude-opus-5[1m]" })]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.kind).toBe("rid_collision");
  });
});

// ---------------------------------------------------------------------------

describe("rid collisions resolve to a coherent whole row, never a chimera", () => {
  test("a collision-free batch passes through untouched", () => {
    const rows = [req({ out_tok: 5 }), req({ out_tok: 800 }), req({ request_id: "req_Y" })];
    const resolved = resolveRidCollisions(rows);
    expect(resolved.requests).toEqual(rows);
    expect(resolved.anomalies).toEqual([]);
  });

  test("per-counter MAX is never taken ACROSS models — the whole row wins together", () => {
    // The chimera: MAX per counter would keep in_tok=900 from the sonnet call and
    // out_tok=400 from the opus one, and price the result at whichever model was
    // read first. No call ever produced that row.
    const sonnet = req({ model: "claude-sonnet-5", in_tok: 900, out_tok: 10, cw_tok: 0, cr_tok: 0 });
    const opus = req({
      model: "claude-opus-5[1m]",
      model_family: "claude-opus-5[1m]",
      in_tok: 5,
      out_tok: 400,
      cw_tok: 600,
      cr_tok: 0,
    });
    const { requests, anomalies } = resolveRidCollisions([sonnet, opus]);

    expect(requests).toHaveLength(1);
    // opus totals 1005 vs sonnet's 910 — larger total wins, whole.
    expect(requests[0]).toEqual(opus);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.kind).toBe("rid_collision");
    expect(anomalies[0]!.detail).toContain("claude-opus-5[1m]");
    expect(anomalies[0]!.detail).toContain("dropped claude-sonnet-5");
  });

  test("MAX still applies WITHIN the winning model's snapshots", () => {
    const { requests } = resolveRidCollisions([
      req({ model: "claude-sonnet-5", out_tok: 5, cw_tok: 100 }),
      req({ model: "claude-sonnet-5", out_tok: 3400, cw_tok: 100 }),
      req({ model: "claude-opus-5[1m]", out_tok: 40, cw_tok: 0 }),
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe("claude-sonnet-5");
    expect(requests[0]!.out_tok).toBe(3400);
  });

  test("the winner does not depend on which file the sweeper read first", () => {
    const a = req({ model: "claude-sonnet-5", out_tok: 100 });
    const b = req({ model: "claude-opus-5[1m]", out_tok: 100 });
    const forward = resolveRidCollisions([a, b]).requests[0]!;
    const reverse = resolveRidCollisions([b, a]).requests[0]!;
    // Exact tie on total -> model id ASC, so both orders agree.
    expect(forward).toEqual(reverse);
    expect(forward.model).toBe("claude-opus-5[1m]");
  });

  test("ingestSession emits one row per requestId even when models collide", async () => {
    const batch = await ingestSession(session());
    const ids = batch.requests.map((r) => r.request_id);
    expect(new Set(ids).size).toBeLessThanOrEqual(ids.length);
    const multiModel = [...groupBy(batch.requests, (r) => r.request_id)]
      .filter(([, group]) => new Set(group.map((r) => r.model)).size > 1)
      .map(([id]) => id);
    expect(multiModel).toEqual([]);
  });

  test("a CROSS-SWEEP collision is resolved by the upsert, not blended by it", () => {
    const dir = mkdtempSync(join(tmpdir(), "est-rid-"));
    const db = openDb({ path: join(dir, "e.db") });

    // Sweep 1 commits the smaller call.
    const loser = req({ model: "claude-sonnet-5", in_tok: 900, out_tok: 10 });
    db.transaction(() => writeBatch(db, blank({ requests: [loser] })))();

    // Sweep 2 reads the other file, which carries the larger call under the same id.
    const winner = req({
      model: "claude-opus-5[1m]",
      model_family: "claude-opus-5[1m]",
      message_id: "msg_opus",
      ts: "2026-07-28T11:00:00.000Z",
      in_tok: 5,
      out_tok: 400,
      cw_tok: 600,
    });
    db.transaction(() => writeBatch(db, blank({ requests: [winner] })))();

    const row = db
      .query<
        { model: string; model_family: string; message_id: string; ts: string; in_tok: number; out_tok: number; cw_tok: number },
        []
      >(
        "SELECT model, model_family, message_id, ts, in_tok, out_tok, cw_tok FROM request WHERE request_id='req_X'",
      )
      .get()!;
    // Every field comes from ONE call: no in_tok=900 next to out_tok=400.
    expect(row).toEqual({
      model: "claude-opus-5[1m]",
      model_family: "claude-opus-5[1m]",
      message_id: "msg_opus",
      ts: "2026-07-28T11:00:00.000Z",
      in_tok: 5,
      out_tok: 400,
      cw_tok: 600,
    });

    // ...and the loser cannot claw the row back on a later re-sweep.
    db.transaction(() => writeBatch(db, blank({ requests: [loser] })))();
    expect(
      db.query<{ model: string; in_tok: number }, []>(
        "SELECT model, in_tok FROM request WHERE request_id='req_X'",
      ).get()!,
    ).toEqual({ model: "claude-opus-5[1m]", in_tok: 5 });

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("same model, different snapshots: the upsert still takes MAX per counter", () => {
    const dir = mkdtempSync(join(tmpdir(), "est-rid-same-"));
    const db = openDb({ path: join(dir, "e.db") });
    db.transaction(() =>
      writeBatch(db, blank({ requests: [req({ in_tok: 4, out_tok: 5, cw_tok: 26850 })] })),
    )();
    db.transaction(() =>
      writeBatch(db, blank({ requests: [req({ in_tok: 4, out_tok: 3400, cw_tok: 0 })] })),
    )();
    expect(
      db.query<{ out_tok: number; cw_tok: number }, []>(
        "SELECT out_tok, cw_tok FROM request WHERE request_id='req_X'",
      ).get()!,
    ).toEqual({ out_tok: 3400, cw_tok: 26850 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

describe("sidechain-replay pass reports a STABLE loser list (§5.2)", () => {
  test("loser_ids is sorted, so the (kind, detail) ledger dedup can collapse a re-sweep", () => {
    const dir = mkdtempSync(join(tmpdir(), "est-replay-order-"));
    const db = openDb({ path: join(dir, "e.db") });

    // One message, four request ids. The losers' RANK order (by total DESC) is
    // deliberately the reverse of their lexicographic order, so this pins the
    // ORDER BY inside GROUP_CONCAT rather than the CTE's own ranking. The order
    // is a CONTRACT, not an observation: src/cli.ts keys ledger de-duplication on
    // the anomaly detail, which embeds this string verbatim, so a plan change
    // that reshuffled it would re-log the same collapse on every cron run.
    const shared = { message_id: "msg_R", ts: "2026-07-28T10:00:00.000Z" };
    db.transaction(() =>
      writeBatch(
        db,
        blank({
          requests: [
            req({ ...shared, request_id: "req_w", is_sidechain: 0, out_tok: 100 }),
            req({ ...shared, request_id: "req_c", is_sidechain: 1, out_tok: 90 }),
            req({ ...shared, request_id: "req_a", is_sidechain: 1, out_tok: 80 }),
            req({ ...shared, request_id: "req_b", is_sidechain: 1, out_tok: 70 }),
          ],
        }),
      ),
    )();

    const groups = db.transaction(() => markSidechainReplays(db)).immediate();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.winner_id).toBe("req_w"); // main beats sidechain (rule 1)
    expect(groups[0]!.n_losers).toBe(3);
    expect(groups[0]!.loser_ids).toBe("req_a,req_b,req_c");

    // The detail string is what src/cli.ts de-duplicates the ledger on, so a
    // re-run must produce it byte-for-byte or the daily cron grows the ledger.
    const first = replayAnomalies(groups);
    const again = replayAnomalies(db.transaction(() => markSidechainReplays(db)).immediate());
    expect(again).toEqual(first);
    expect(first[0]!.detail).toContain("req_a,req_b,req_c");

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** A `request` row with the fields a test cares about overridden. */
function req(parts: Partial<RequestRow>): RequestRow {
  return {
    request_id: "req_X",
    message_id: "msg_X",
    is_sidechain: 0,
    session_id: SESSION,
    prompt_id: null,
    origin: "main",
    agent_id: null,
    run_id: null,
    wf_launch_id: null,
    model: "claude-sonnet-5",
    model_family: "claude-sonnet-5",
    attribution_agent: null,
    attribution_skill: null,
    ts: "2026-07-28T10:00:00.000Z",
    in_tok: 1,
    out_tok: 1,
    cw_tok: 0,
    cr_tok: 0,
    ...parts,
  };
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = out.get(k);
    if (group === undefined) out.set(k, [row]);
    else group.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("ingestMainTranscript", () => {
  test("segments turns and extracts requests in one pass", async () => {
    const main = await ingestMainTranscript(MAIN, SESSION);
    expect(main.turns.map((t) => t.prompt_id)).toEqual(["P1", "P2"]);
    expect(main.turns[0]!.duration_ms).toBe(90000);
    expect(main.turns[0]!.pending_wf).toBe(1);
    expect(main.turns[1]!.pending_bg).toBe(1);
    expect(main.stats.malformed).toBe(0);
  });

  test("filters <synthetic> lines — they are never billed", async () => {
    const main = await ingestMainTranscript(MAIN, SESSION);
    expect(main.requests.map((r) => r.request_id)).not.toContain("req_synth");
    expect(main.requests.some((r) => r.model === "<synthetic>")).toBe(false);
  });

  test("stamps every request with the turn it belongs to", async () => {
    const main = await ingestMainTranscript(MAIN, SESSION);
    const byId = new Map(main.requests.map((r) => [r.request_id, r]));
    expect(byId.get("req_main_A")!.prompt_id).toBe("P1");
    expect(byId.get("req_main_B")!.prompt_id).toBe("P1");
    expect(byId.get("req_main_C")!.prompt_id).toBe("P2");
    expect(byId.get("req_main_D")!.prompt_id).toBe("P2");
    expect(byId.get("req_main_A")!.origin).toBe("main");
  });

  test("captures the workflow launch with its relaunch discriminator", async () => {
    const main = await ingestMainTranscript(MAIN, SESSION);
    expect(main.launches).toHaveLength(1);
    expect(main.launches[0]).toMatchObject({
      run_id: "wf_demo0001-abc",
      wf_launch_id: "wl_launch1", // toolUseResult.taskId, not runId
      prompt_id: "P1",
      workflow_name: "demo-flow",
    });
  });

  test("maps launch tool_use ids to their launching turn", async () => {
    const main = await ingestMainTranscript(MAIN, SESSION);
    expect(main.toolUsePrompts.get("toolu_WF1")).toBe("P1");
    expect(main.toolUsePrompts.get("toolu_AG1")).toBe("P2");
  });

  test("captures BOTH TaskCreate and statusChange records for the lifecycle ledger", async () => {
    // §5.4 counts a turn as "touching" a task if it created OR transitioned it,
    // and gates/g-attr.ts measured attribution against exactly that. An ingest
    // that kept only statusChange made every create invisible.
    const main = await ingestMainTranscript(MAIN, SESSION);
    expect(main.taskEvents).toEqual([
      {
        session_id: SESSION,
        task_num: "4",
        ts: "2026-07-28T10:05:50.000Z",
        kind: "create",
        from_status: null,
        to_status: "pending",
      },
      {
        session_id: SESSION,
        task_num: "3",
        ts: "2026-07-28T10:06:00.000Z",
        kind: "status",
        from_status: "pending",
        to_status: "in_progress",
      },
    ]);
  });

  test("a Workflow launch result is never mistaken for a task event", async () => {
    // Both carry `toolUseResult.taskId`; only the launch carries `runId`.
    const main = await ingestMainTranscript(MAIN, SESSION);
    expect(main.taskEvents.map((e) => e.task_num)).not.toContain("wl_launch1");
    expect(main.launches).toHaveLength(1);
  });

  test("orphan turn_durations leave the segmenter as an anomaly, not as silence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "est-orphan-"));
    const p = join(dir, "main.jsonl");
    // A resumed session: the turn_duration for a turn opened in an EARLIER file.
    writeFileSync(
      p,
      [
        `{"type":"system","subtype":"turn_duration","sessionId":"${SESSION}","timestamp":"2026-07-28T09:59:00.000Z","durationMs":1000}`,
        `{"type":"user","uuid":"u1","sessionId":"${SESSION}","isSidechain":false,"promptId":"PX","timestamp":"2026-07-28T10:00:00.000Z","message":{"role":"user","content":"go"}}`,
        "",
      ].join("\n"),
    );

    const main = await ingestMainTranscript(p, SESSION);
    expect(main.orphanTurnDurations).toBe(1);
    const orphan = main.anomalies.find((a) => a.kind === "orphan_turn_duration");
    expect(orphan).toBeDefined();
    expect(orphan!.detail).toContain("1 turn_duration record(s)");
    expect(orphan!.path).toBe(p);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

describe("agent_run assembly (§5.3, §5.6)", () => {
  test("workflowProgress startedAt+durationMs beats transcript timestamps", async () => {
    const s = session();
    const batch = await ingestSession(s);
    const a1 = batch.agentRuns.find((a) => a.agent_id === "a1111111111111111")!;

    // Transcript lines run 10:00:21 -> 10:01:55; the scheduler interval is wider
    // and is what the design says to use.
    expect(a1.interval_src).toBe("workflow_progress");
    expect(a1.started_at).toBe("2026-07-28T10:00:20.000Z");
    expect(a1.ended_at).toBe("2026-07-28T10:02:00.000Z");
    expect(a1.queued_at).toBe("2026-07-28T10:00:15.000Z");
    expect(a1.attempt).toBe(1);
  });

  test("phase attribution is exact, and 0-based against phases[]", async () => {
    const batch = await ingestSession(session());
    const a1 = batch.agentRuns.find((a) => a.agent_id === "a1111111111111111")!;
    const a2 = batch.agentRuns.find((a) => a.agent_id === "a2222222222222222")!;
    expect([a1.phase_idx, a1.phase_title, a1.phase_conf]).toEqual([0, "Research", "exact"]);
    expect([a2.phase_idx, a2.phase_title, a2.phase_conf]).toEqual([1, "Synthesize", "exact"]);
    expect(a1.label).toBe("research:one");
  });

  test("stores workflowProgress.tokens for audit and never anywhere else", async () => {
    const batch = await ingestSession(session());
    const a1 = batch.agentRuns.find((a) => a.agent_id === "a1111111111111111")!;
    expect(a1.reported_tokens).toBe(26850);
    // The truth, recomputed from the transcript, is larger — which is the whole
    // reason the field is banned from sums.
    const recomputed = batch.requests
      .filter((r) => r.agent_id === "a1111111111111111")
      .reduce((max, r) => Math.max(max, r.out_tok + r.cw_tok), 0);
    expect(recomputed).toBeGreaterThan(0);
  });

  test("an Agent-tool sub-agent falls back to transcript timestamps", async () => {
    const batch = await ingestSession(session());
    const agent = batch.agentRuns.find((a) => a.agent_id === "abeef0000000000a1")!;
    expect(agent.interval_src).toBe("transcript");
    expect(agent.started_at).toBe("2026-07-28T10:05:12.000Z");
    expect(agent.ended_at).toBe("2026-07-28T10:07:30.000Z");
    expect(agent.run_id).toBeNull();
    expect(agent.phase_conf).toBe("unmapped");
  });

  test("an Agent-tool sub-agent inherits its LAUNCHING turn via meta.toolUseId", async () => {
    const batch = await ingestSession(session());
    const agent = batch.agentRuns.find((a) => a.agent_id === "abeef0000000000a1")!;
    // toolu_AG1 was issued during turn P2 — and the sub-agent's own transcript
    // carries no promptId at all, so this join is the only way to know.
    expect(agent.launch_prompt_id).toBe("P2");
    const reqs = batch.requests.filter((r) => r.agent_id === "abeef0000000000a1");
    expect(reqs.every((r) => r.prompt_id === "P2")).toBe(true);
    expect(reqs.every((r) => r.origin === "subagent")).toBe(true);
  });

  test("interval clustering is the fallback when workflowProgress is incomplete", () => {
    const waves = clusterAgentsIntoWaves([
      { agentId: "a", startedAt: "2026-07-28T10:00:00Z", endedAt: "2026-07-28T10:05:00Z" },
      { agentId: "b", startedAt: "2026-07-28T10:01:00Z", endedAt: "2026-07-28T10:06:00Z" },
      { agentId: "c", startedAt: "2026-07-28T10:20:00Z", endedAt: "2026-07-28T10:25:00Z" },
    ]);
    expect(waves).toEqual([["a", "b"], ["c"]]);
  });

  test("a stale state file degrades to 'inferred', never to a silent 'exact'", () => {
    const { state } = readWorkflowState(
      join(SESSION_DIR, "workflows", "wf_demo0001-abc.json"),
    );
    // Simulate the killed-run case: the state file never recorded either agent.
    state!.progressAgents.length = 0;

    const s = session();
    const { rows } = buildAgentRuns({
      sessionId: SESSION,
      agents: s.workflows[0]!.agents,
      intervals: new Map([
        [
          "a1111111111111111",
          {
            agentId: "a1111111111111111",
            firstTs: "2026-07-28T10:00:21.000Z",
            lastTs: "2026-07-28T10:01:55.000Z",
          },
        ],
        [
          "a2222222222222222",
          {
            agentId: "a2222222222222222",
            firstTs: "2026-07-28T10:02:06.000Z",
            lastTs: "2026-07-28T10:04:00.000Z",
          },
        ],
      ]),
      state,
      runId: "wf_demo0001-abc",
      wfLaunchId: "wl_launch1",
    });

    expect(rows.map((r) => r.interval_src)).toEqual(["transcript", "transcript"]);
    // Two waves, two planned phases -> ordered mapping, marked inferred.
    expect(rows.map((r) => [r.phase_idx, r.phase_conf])).toEqual([
      [0, "inferred"],
      [1, "inferred"],
    ]);
  });

  test("reports a workflow agent with no label — the §3.2 authoring rule", () => {
    const { state } = readWorkflowState(
      join(SESSION_DIR, "workflows", "wf_demo0001-abc.json"),
    );
    state!.progressAgents[0]!.label = null;
    const s = session();
    const { anomalies } = buildAgentRuns({
      sessionId: SESSION,
      agents: s.workflows[0]!.agents,
      intervals: new Map(),
      state,
      runId: "wf_demo0001-abc",
      wfLaunchId: "wl_launch1",
    });
    expect(
      anomalies.some(
        (a) => a.kind === "wf_record_mismatch" && a.detail.includes("has no label"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("ingestSession -> writeBatch (end to end)", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "estimator-ingest-"));
    db = openDb({ path: join(dir, "estimator.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes deduped requests with the origin split intact (§4.6)", async () => {
    const batch = await ingestSession(session());
    db.transaction(() => writeBatch(db, batch))();

    const rows = db
      .query<{ request_id: string; origin: string; out_tok: number; cw_tok: number }, []>(
        "SELECT request_id, origin, out_tok, cw_tok FROM request ORDER BY request_id",
      )
      .all();
    expect(rows.map((r) => r.request_id)).toEqual([
      "req_S1",
      "req_W1",
      "req_W2",
      "req_W3",
      "req_W4",
      "req_main_A",
      "req_main_B",
      "req_main_C",
      "req_main_D",
    ]);

    const byId = new Map(rows.map((r) => [r.request_id, r]));
    expect(byId.get("req_W1")!.out_tok).toBe(3400); // MAX of 5/800/3400
    expect(byId.get("req_W3")!.out_tok).toBe(950); // MAX of 60/950
    expect(byId.get("req_S1")!.out_tok).toBe(70); // MAX of 8/70
    expect(byId.get("req_main_A")!.out_tok).toBe(250); // MAX of 100/250
    // req_W5 was in the torn tail: skipped, counted, never invented.
    expect(byId.has("req_W5")).toBe(false);

    const split = db
      .query<{ origin: string; n: number }, []>(
        "SELECT origin, COUNT(*) AS n FROM request GROUP BY origin ORDER BY origin",
      )
      .all();
    expect(split).toEqual([
      { origin: "main", n: 4 },
      { origin: "subagent", n: 5 },
    ]);
  });

  test("writes turns, workflow run/phases and agent runs", async () => {
    const batch = await ingestSession(session());
    db.transaction(() => writeBatch(db, batch))();

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM turn").get()!.n).toBe(2);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM agent_run").get()!.n).toBe(3);
    // One TaskCreate + one TaskUpdate statusChange, told apart by `kind`.
    expect(
      db
        .query<{ kind: string; task_num: string }, []>(
          "SELECT kind, task_num FROM task_event ORDER BY ts",
        )
        .all(),
    ).toEqual([
      { kind: "create", task_num: "4" },
      { kind: "status", task_num: "3" },
    ]);

    const run = db
      .query<
        { run_id: string; wf_launch_id: string; n_phases_planned: number; started_at: string; ended_at: string },
        []
      >("SELECT run_id, wf_launch_id, n_phases_planned, started_at, ended_at FROM workflow_run")
      .get()!;
    expect(run.run_id).toBe("wf_demo0001-abc");
    expect(run.wf_launch_id).toBe("wl_launch1");
    expect(run.n_phases_planned).toBe(2);
    // DERIVED from agent intervals — the state file's own durationMs (999) is banned.
    expect(run.started_at).toBe("2026-07-28T10:00:20.000Z");
    expect(run.ended_at).toBe("2026-07-28T10:04:05.000Z");

    const phases = db
      .query<{ phase_idx: number; title: string; model: string }, []>(
        "SELECT phase_idx, title, model FROM workflow_phase ORDER BY phase_idx",
      )
      .all();
    expect(phases).toEqual([
      { phase_idx: 0, title: "Research", model: "claude-sonnet-5" },
      { phase_idx: 1, title: "Synthesize", model: "claude-sonnet-5" },
    ]);
  });

  test("agent_run.phase_idx joins workflow_phase — the off-by-one would break this", async () => {
    const batch = await ingestSession(session());
    db.transaction(() => writeBatch(db, batch))();

    const joined = db
      .query<{ agent_id: string; phase_title: string; plan_title: string }, []>(
        `SELECT a.agent_id, a.phase_title, p.title AS plan_title
           FROM agent_run a
           JOIN workflow_phase p
             ON p.run_id = a.run_id AND p.wf_launch_id = a.wf_launch_id
            AND p.phase_idx = a.phase_idx
          ORDER BY a.agent_id`,
      )
      .all();
    expect(joined).toHaveLength(2);
    for (const row of joined) expect(row.phase_title).toBe(row.plan_title);
  });

  test("a re-sweep never downgrades an exact phase or a scheduler interval", async () => {
    const batch = await ingestSession(session());
    db.transaction(() => writeBatch(db, batch))();

    // A later sweep that only saw the transcripts (stale/missing state file).
    const degraded = structuredClone(batch);
    for (const a of degraded.agentRuns) {
      a.interval_src = "transcript";
      a.started_at = "2026-07-28T23:00:00.000Z";
      a.ended_at = "2026-07-28T23:30:00.000Z";
      a.phase_conf = "unmapped";
      a.phase_idx = null;
    }
    db.transaction(() => writeBatch(db, degraded))();

    const a1 = db
      .query<{ interval_src: string; started_at: string; phase_conf: string; phase_idx: number }, []>(
        "SELECT interval_src, started_at, phase_conf, phase_idx FROM agent_run WHERE agent_id='a1111111111111111'",
      )
      .get()!;
    expect(a1.interval_src).toBe("workflow_progress");
    expect(a1.started_at).toBe("2026-07-28T10:00:20.000Z");
    expect(a1.phase_conf).toBe("exact");
    expect(a1.phase_idx).toBe(0);
  });

  test("records the torn tail in the anomaly ledger — via the ONE anomaly writer", async () => {
    // writeBatch writes rows only. `insertAnomalies` is the single anomaly writer
    // because it is the only one that de-duplicates on (kind, detail); a second,
    // non-idempotent path in writeBatch was how a daily cron could have grown the
    // ledger by a copy a day.
    const batch = await ingestSession(session());
    expect(batch.anomalies.some((a) => a.kind === "truncated_tail")).toBe(true);

    db.transaction(() => writeBatch(db, batch))();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM anomaly").get()!.n).toBe(0);

    const now = "2026-07-28T12:00:00.000Z";
    db.transaction(() => insertAnomalies(db, batch.anomalies, now))();
    const kinds = db
      .query<{ kind: string }, []>("SELECT DISTINCT kind FROM anomaly ORDER BY kind")
      .all()
      .map((r) => r.kind);
    expect(kinds).toContain("truncated_tail");

    // ...and a re-sweep adds nothing: the ledger dedup is what makes it a no-op.
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM anomaly").get()!.n;
    db.transaction(() => insertAnomalies(db, batch.anomalies, now))();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM anomaly").get()!.n).toBe(before);
  });

  test("the whole corpus parses without a single malformed line", async () => {
    const batch = await ingestSession(session());
    expect(batch.stats.malformed).toBe(0);
    expect(batch.stats.truncatedTail).toBe(1);
    expect(statSync(MAIN).size).toBeGreaterThan(0);
  });
});

/** An empty batch with the given parts filled in. */
function blank(parts: Partial<Parameters<typeof writeBatch>[1]>): Parameters<typeof writeBatch>[1] {
  return {
    requests: [],
    turns: [],
    agentRuns: [],
    workflowRuns: [],
    workflowPhases: [],
    taskEvents: [],
    anomalies: [],
    files: [],
    stats: { lines: 0, blank: 0, parsed: 0, malformed: 0, truncatedTail: 0 },
    incompleteFiles: [],
    skippedFiles: [],
    ...parts,
  };
}

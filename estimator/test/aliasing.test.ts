/**
 * The three cross-session mechanisms G-FORK and G-PHASE found on disk, none of
 * which a single session can see on its own:
 *
 *   1. **fork_replay** — a child session replays the parent's history, so one
 *      billed call is on disk twice under two sessions. Detector D3 (any shared
 *      line uuid) scored precision 1.00 / recall 1.00 against ground truth; the
 *      leading-uuid-prefix detector R3 §5.2 proposed scored 0.357 recall and is
 *      gone. Both shapes it has to survive are pinned here: the rewind fork
 *      (`e19de116`, a wholly phantom session — 1 file, 9 requests, all shared)
 *      and the `/compact` continuation (parent TAIL into child HEAD, leading
 *      prefix ZERO, 64% of all replayed duplicates in the corpus).
 *
 *   2. **symlink_alias** — a fork while a sub-agent is in flight leaves the child
 *      a SYMLINK to the parent's still-open transcript. One physical file, two
 *      claimants, and `agent_run.session_id` used to go to whichever the walk
 *      reached first. The link TARGET's session owns it; the loser is logged.
 *
 *   3. **cross-session runId pairing** — `wf_<runId>.json` and
 *      `subagents/workflows/<runId>/` land under different sessions whenever a run
 *      outlives its launching session. Per-session pairing degraded 3 runs /
 *      46 agents to `phase_conf='unmapped'` with both halves sitting on disk.
 *
 * Plus the `/compact` boundary feed itself (`compaction_continuation`), which
 * `ingestMainTranscript` used to compute and then throw away.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSweep, watermarkable } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { discoverCorpus, sessionIdFromPath } from "../src/discover.ts";
import {
  compactionAnomalies,
  detectForkReplays,
  ingestMainTranscript,
  ingestSession,
  planCorpus,
  writeBatch,
  type TranscriptIndexEntry,
} from "../src/ingest.ts";

const SESSION_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SESSION_B = "bbbbbbbb-2222-4222-8222-222222222222";

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "est-alias-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function write(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

/** One assistant usage line — the only line shape that produces a `request` row. */
function usageLine(o: {
  uuid: string;
  requestId: string;
  messageId: string;
  ts: string;
  session: string;
  out?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: o.uuid,
    sessionId: o.session,
    isSidechain: false,
    promptId: null,
    timestamp: o.ts,
    requestId: o.requestId,
    message: {
      id: o.messageId,
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "x" }],
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: o.out ?? 100,
      },
    },
  });
}

function userLine(o: { uuid: string; promptId: string; ts: string; session: string }): string {
  return JSON.stringify({
    type: "user",
    uuid: o.uuid,
    sessionId: o.session,
    isSidechain: false,
    userType: "external",
    promptId: o.promptId,
    timestamp: o.ts,
    message: { role: "user", content: "go" },
  });
}

// ---------------------------------------------------------------------------
// D3, on synthetic index entries — the detector in isolation
// ---------------------------------------------------------------------------

function entry(parts: Partial<TranscriptIndexEntry>): TranscriptIndexEntry {
  return { path: "/p/a.jsonl", sessionId: SESSION_A, uuids: [], requestIds: [], ...parts };
}

describe("detectForkReplays — D3 (G-FORK §5)", () => {
  test("flags the e19de116 shape: a child that is 100% replay of the parent's head", () => {
    // The real pair: 9 shared requestIds, 49 shared uuids, and the child is a
    // WHOLLY PHANTOM session — one file, nine requests, every one of them a copy.
    const parentUuids = Array.from({ length: 60 }, (_, i) => `u${i}`);
    const parentRids = Array.from({ length: 20 }, (_, i) => `req_${i}`);
    const anomalies = detectForkReplays([
      entry({ path: "/p/parent.jsonl", sessionId: SESSION_A, uuids: parentUuids, requestIds: parentRids }),
      entry({
        path: "/p/child.jsonl",
        sessionId: SESSION_B,
        uuids: parentUuids.slice(0, 49), // leading replay, then the child would diverge
        requestIds: parentRids.slice(0, 9),
      }),
    ]);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.kind).toBe("fork_replay");
    // Both sessions and the shared-request count are the payload the gate asked for.
    expect(anomalies[0]!.detail).toContain(SESSION_A);
    expect(anomalies[0]!.detail).toContain(SESSION_B);
    expect(anomalies[0]!.detail).toContain("49 line uuid(s)");
    expect(anomalies[0]!.detail).toContain("9 shared requestId(s)");
  });

  test("flags the /compact TAIL->HEAD shape the leading-prefix detector was blind to", () => {
    // G-FORK §3.3: `/compact` ends a session and rewrites the surviving context
    // window — the parent's TAIL — into the child's HEAD. Strict leading prefix is
    // ZERO here, which is exactly why D1 missed 249 of 387 replayed requests.
    const shared = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const parent = [...Array.from({ length: 40 }, (_, i) => `p${i}`), ...shared];
    const child = [...shared, ...Array.from({ length: 40 }, (_, i) => `c${i}`)];
    expect(parent[0]).not.toBe(child[0]); // no common leading uuid at all

    const anomalies = detectForkReplays([
      entry({ path: "/p/parent.jsonl", sessionId: SESSION_A, uuids: parent, requestIds: ["r1", "r2"] }),
      entry({ path: "/p/child.jsonl", sessionId: SESSION_B, uuids: child, requestIds: ["r2", "r3"] }),
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.detail).toContain("30 line uuid(s)");
    expect(anomalies[0]!.detail).toContain("1 shared requestId(s)");
  });

  test("two files of the SAME session are a resume append, not a fork", () => {
    expect(
      detectForkReplays([
        entry({ path: "/p/one.jsonl", sessionId: SESSION_A, uuids: ["u1", "u2"] }),
        entry({ path: "/p/two.jsonl", sessionId: SESSION_A, uuids: ["u2", "u3"] }),
      ]),
    ).toEqual([]);
  });

  test("ONE physical file claimed by two sessions is symlink_alias, never fork_replay", () => {
    // A symlink alias is one file, so no uuid-comparison detector can or should
    // flag it — planCorpus owns that case (G-FORK §5, excluding row 1).
    expect(
      detectForkReplays([
        entry({ path: "/p/same.jsonl", sessionId: SESSION_A, uuids: ["u1", "u2"] }),
        entry({ path: "/p/same.jsonl", sessionId: SESSION_B, uuids: ["u1", "u2"] }),
      ]),
    ).toEqual([]);
  });

  test("the detail is byte-identical whichever order the sweep read the two files", () => {
    // src/cli.ts de-duplicates the ledger on (kind, detail); an order-dependent
    // string would re-log the same fork on every cron run.
    const a = entry({ path: "/p/a.jsonl", sessionId: SESSION_A, uuids: ["u1"], requestIds: ["r1"] });
    const b = entry({ path: "/p/b.jsonl", sessionId: SESSION_B, uuids: ["u1"], requestIds: ["r1"] });
    expect(detectForkReplays([a, b])).toEqual(detectForkReplays([b, a]));
  });

  test("a corpus with no cross-session overlap says nothing", () => {
    expect(
      detectForkReplays([
        entry({ path: "/p/a.jsonl", sessionId: SESSION_A, uuids: ["u1"] }),
        entry({ path: "/p/b.jsonl", sessionId: SESSION_B, uuids: ["u2"] }),
      ]),
    ).toEqual([]);
  });
});

describe("fork_replay end to end, through est sweep", () => {
  test("a forked child session lands one fork_replay row, and the call is counted ONCE", async () => {
    const root = newRoot();
    const project = join(root, "-Users-craig-demo");
    // The parent's first two requests, replayed verbatim into the child (same
    // uuids, same requestIds, same message ids) — a rewind fork.
    const shared = [
      usageLine({ uuid: "u1", requestId: "req_1", messageId: "msg_1", ts: "2026-07-28T10:00:00.000Z", session: SESSION_A }),
      usageLine({ uuid: "u2", requestId: "req_2", messageId: "msg_2", ts: "2026-07-28T10:00:10.000Z", session: SESSION_A }),
    ];
    write(join(project, `${SESSION_A}.jsonl`), [
      userLine({ uuid: "p0", promptId: "P1", ts: "2026-07-28T09:59:59.000Z", session: SESSION_A }),
      ...shared,
      usageLine({ uuid: "u3", requestId: "req_3", messageId: "msg_3", ts: "2026-07-28T10:00:20.000Z", session: SESSION_A }),
    ]);
    write(join(project, `${SESSION_B}.jsonl`), [
      userLine({ uuid: "p0b", promptId: "P1b", ts: "2026-07-28T11:00:00.000Z", session: SESSION_B }),
      ...shared,
      usageLine({ uuid: "u9", requestId: "req_9", messageId: "msg_9", ts: "2026-07-28T11:00:30.000Z", session: SESSION_B }),
    ]);

    const db = openDb({ path: join(root, "e.db") });
    const report = await runSweep(db, { root });
    expect(report.anomalies.by_kind.fork_replay).toBe(1);

    const detail = db
      .query<{ detail: string }, []>("SELECT detail FROM anomaly WHERE kind='fork_replay'")
      .get()!.detail;
    expect(detail).toContain("2 shared requestId(s)");

    // The global request_id PK is what makes the duplicate free: 4 distinct calls
    // on disk across 6 usage lines, not 6 rows. (A (session_id, request_id) key
    // would have produced 6 and inflated the child session by 100%.)
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request").get()!.n).toBe(4);

    // A second sweep re-logs nothing: the (kind, detail) ledger dedup holds.
    const again = await runSweep(db, { root, full: true });
    expect(again.anomalies.by_kind.fork_replay ?? 0).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// symlink alias — ownership goes to the link TARGET, not to the first walker
// ---------------------------------------------------------------------------

/**
 * Session A holds a SYMLINK to session B's agent transcript. A sorts first, so a
 * walk-order winner would be A — the test is only meaningful because the target
 * is the session the walk reaches SECOND.
 */
function aliasCorpus(): { root: string; real: string } {
  const root = newRoot();
  const project = join(root, "-Users-craig-demo");
  const real = join(project, SESSION_B, "subagents", "agent-a1111111111111111.jsonl");
  write(real, [
    usageLine({ uuid: "g1", requestId: "req_g1", messageId: "msg_g1", ts: "2026-07-28T10:00:00.000Z", session: SESSION_B }),
  ]);
  write(join(project, `${SESSION_A}.jsonl`), [
    userLine({ uuid: "p0", promptId: "P1", ts: "2026-07-28T09:00:00.000Z", session: SESSION_A }),
  ]);
  write(join(project, `${SESSION_B}.jsonl`), [
    userLine({ uuid: "q0", promptId: "Q1", ts: "2026-07-28T09:30:00.000Z", session: SESSION_B }),
  ]);
  const linkDir = join(project, SESSION_A, "subagents");
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(real, join(linkDir, "agent-a1111111111111111.jsonl"));
  // Discovery canonicalises, and on macOS $TMPDIR is itself a symlink, so the
  // expected path has to be the canonical one too.
  return { root, real: realpathSync(real) };
}

describe("symlink_alias — one physical transcript, one owner (G-FORK §3.4, §7 rec 4)", () => {
  test("sessionIdFromPath names the session a canonical path belongs to", () => {
    expect(sessionIdFromPath(`/x/-p/${SESSION_B}/subagents/agent-a1.jsonl`)).toBe(SESSION_B);
    expect(sessionIdFromPath(`/x/-p/${SESSION_A}.jsonl`)).toBe(SESSION_A);
    expect(sessionIdFromPath("/x/-p/not-a-session/agent-a1.jsonl")).toBeNull();
  });

  test("planCorpus attributes the file to the link TARGET and logs the losing claim", () => {
    const { root, real } = aliasCorpus();
    const corpus = discoverCorpus(root);
    // Both sessions enumerate it, realpath-canonicalised to the same file.
    expect(corpus.sessions.map((s) => s.agents.map((a) => a.transcriptPath))).toEqual([
      [real],
      [real],
    ]);

    const plan = planCorpus(corpus);
    expect(plan.owner.get(real)).toBe(SESSION_B); // the target's session, not the first walked
    const alias = plan.anomalies.filter((a) => a.kind === "symlink_alias");
    expect(alias).toHaveLength(1);
    expect(alias[0]!.detail).toContain(SESSION_A);
    expect(alias[0]!.detail).toContain(SESSION_B);
    expect(alias[0]!.detail).toContain("Attributed to bbbbbbbb");
    expect(alias[0]!.path).toBe(real);
  });

  test("the losing session ingests the file zero times", async () => {
    const { root, real } = aliasCorpus();
    const corpus = discoverCorpus(root);
    const plan = planCorpus(corpus);
    const byId = new Map(corpus.sessions.map((s) => [s.sessionId, s]));

    const loser = await ingestSession(byId.get(SESSION_A)!, plan);
    expect(loser.agentRuns).toEqual([]);
    expect(loser.requests.filter((r) => r.agent_id !== null)).toEqual([]);
    expect(loser.files.map((f) => f.path)).not.toContain(real);

    const owner = await ingestSession(byId.get(SESSION_B)!, plan);
    expect(owner.agentRuns.map((a) => [a.agent_id, a.session_id])).toEqual([
      ["a1111111111111111", SESSION_B],
    ]);
    expect(owner.skippedFiles).toEqual([]);
  });

  test("the loser withholds the watermark for a file it never opened", async () => {
    // Same invariant as an aborted read (§5.2): a watermark asserts "these bytes
    // are accounted for". If the owner is cut off by the sweep budget and the
    // loser had watermarked the file anyway, the next incremental sweep would see
    // (same inode, same bytes) -> unchanged -> skip, and the file's spend would be
    // frozen out of every future sweep.
    const { root, real } = aliasCorpus();
    const corpus = discoverCorpus(root);
    const plan = planCorpus(corpus);
    const loser = await ingestSession(
      corpus.sessions.find((s) => s.sessionId === SESSION_A)!,
      plan,
    );
    expect(loser.skippedFiles).toEqual([real]);
    expect(
      watermarkable(
        [{ path: real, inode: 1, bytes: 10, mtime: "2026-01-01T00:00:00.000Z" }],
        loser.skippedFiles,
      ),
    ).toEqual([]);
  });

  test("a sweep books ONE agent_run, to the launcher, and records the alias", async () => {
    const { root } = aliasCorpus();
    const db = openDb({ path: join(root, "e.db") });
    const report = await runSweep(db, { root });
    expect(report.anomalies.by_kind.symlink_alias).toBe(1);

    const rows = db
      .query<{ agent_id: string; session_id: string }, []>(
        "SELECT agent_id, session_id FROM agent_run",
      )
      .all();
    expect(rows).toEqual([{ agent_id: "a1111111111111111", session_id: SESSION_B }]);
    // The alias is not a fork: the two sessions share a FILE, not a replay.
    expect(report.anomalies.by_kind.fork_replay ?? 0).toBe(0);
    // …and it is BENIGN. `planCorpus` already resolved it correctly, so alerting
    // would exit 3 on the first backfill of a tree that carries ~46 of these.
    expect(report.anomalies.alerting).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// cross-session runId pairing (G-PHASE §2b — 3 runs / 46 agents on this machine)
// ---------------------------------------------------------------------------

const RUN_ID = "wf_cross01-abc";

/** Session A keeps the state file; session B keeps the run's transcripts. */
function splitRunCorpus(): string {
  const root = newRoot();
  const project = join(root, "-Users-craig-demo");
  write(join(project, `${SESSION_A}.jsonl`), [
    userLine({ uuid: "p0", promptId: "P1", ts: "2026-07-28T09:00:00.000Z", session: SESSION_A }),
  ]);
  write(join(project, `${SESSION_B}.jsonl`), [
    userLine({ uuid: "q0", promptId: "Q1", ts: "2026-07-28T09:30:00.000Z", session: SESSION_B }),
  ]);
  writeFileSync(
    (mkdirSync(join(project, SESSION_A, "workflows"), { recursive: true }),
    join(project, SESSION_A, "workflows", `${RUN_ID}.json`)),
    JSON.stringify({
      runId: RUN_ID,
      taskId: "wl_cross1",
      workflowName: "cross-session",
      transcriptDir: `subagents/workflows/${RUN_ID}`,
      defaultModel: "claude-sonnet-5",
      // The banned aggregates are present and wrong, as they always are.
      agentCount: 99,
      status: "killed",
      totalTokens: 12345,
      phases: [{ title: "Research" }, { title: "Synthesize" }],
      workflowProgress: [
        {
          type: "workflow_agent",
          agentId: "a1111111111111111",
          index: 0,
          label: "research:one",
          phaseIndex: 1,
          phaseTitle: "Research",
          model: "claude-sonnet-5",
          state: "completed",
          queuedAt: Date.parse("2026-07-28T10:00:15.000Z"),
          startedAt: Date.parse("2026-07-28T10:00:20.000Z"),
          durationMs: 100000,
          attempt: 1,
          tokens: 26850,
        },
      ],
    }),
  );
  write(join(project, SESSION_B, "subagents", "workflows", RUN_ID, "agent-a1111111111111111.jsonl"), [
    usageLine({ uuid: "w1", requestId: "req_w1", messageId: "msg_w1", ts: "2026-07-28T10:00:21.000Z", session: SESSION_B }),
  ]);
  return root;
}

describe("cross-session runId pairing", () => {
  test("per-session pairing alone leaves the run unmapped — the bug being fixed", async () => {
    const root = splitRunCorpus();
    const session = discoverCorpus(root).sessions.find((s) => s.sessionId === SESSION_B)!;
    // No plan: exactly what ingestSession could see before, and the state file is
    // in the OTHER session, so there is nothing to join.
    const batch = await ingestSession(session);
    expect(batch.agentRuns[0]!.phase_conf).toBe("unmapped");
    expect(batch.agentRuns[0]!.phase_idx).toBeNull();
  });

  test("the corpus plan pairs state file and transcript dir by runId, so the join is exact", async () => {
    const root = splitRunCorpus();
    const corpus = discoverCorpus(root);
    const plan = planCorpus(corpus);
    expect(plan.stateByRun.get(RUN_ID)?.taskId).toBe("wl_cross1");

    const session = corpus.sessions.find((s) => s.sessionId === SESSION_B)!;
    const batch = await ingestSession(session, plan);
    const agent = batch.agentRuns[0]!;
    expect([agent.phase_idx, agent.phase_title, agent.phase_conf]).toEqual([0, "Research", "exact"]);
    expect(agent.label).toBe("research:one");
    // The scheduler interval wins over the transcript's own timestamps (§5.3)...
    expect(agent.interval_src).toBe("workflow_progress");
    // ...and the relaunch discriminator comes from the state file's taskId.
    expect(agent.wf_launch_id).toBe("wl_cross1");
    expect(batch.workflowPhases.map((p) => p.title)).toEqual(["Research", "Synthesize"]);
  });

  test("a sweep writes the joined phase, not a run stranded at 'unmapped'", async () => {
    const root = splitRunCorpus();
    const db = openDb({ path: join(root, "e.db") });
    await runSweep(db, { root });
    expect(
      db
        .query<{ phase_conf: string; phase_idx: number; wf_launch_id: string }, []>(
          "SELECT phase_conf, phase_idx, wf_launch_id FROM agent_run",
        )
        .get(),
    ).toEqual({ phase_conf: "exact", phase_idx: 0, wf_launch_id: "wl_cross1" });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM workflow_phase").get()!.n).toBe(2);
    db.close();
  });

  test("the better-populated state file wins when two sessions both kept one", () => {
    // A resumed session's copy can be a stub. Ties break on path, so the choice
    // never depends on which session the walk visited first.
    const root = splitRunCorpus();
    const project = join(root, "-Users-craig-demo");
    mkdirSync(join(project, SESSION_B, "workflows"), { recursive: true });
    writeFileSync(
      join(project, SESSION_B, "workflows", `${RUN_ID}.json`),
      JSON.stringify({ runId: RUN_ID, taskId: "wl_stub", phases: [], workflowProgress: [] }),
    );
    const plan = planCorpus(discoverCorpus(root));
    expect(plan.stateByRun.get(RUN_ID)?.taskId).toBe("wl_cross1");
  });
});

// ---------------------------------------------------------------------------
// compaction_continuation — the Phase 1 `outcome.compactions` feed
// ---------------------------------------------------------------------------

describe("compaction_continuation", () => {
  function compactCorpus(): string {
    const root = newRoot();
    write(join(root, "-Users-craig-demo", `${SESSION_A}.jsonl`), [
      userLine({ uuid: "p0", promptId: "P1", ts: "2026-07-28T10:00:00.000Z", session: SESSION_A }),
      usageLine({ uuid: "u1", requestId: "req_1", messageId: "msg_1", ts: "2026-07-28T10:00:05.000Z", session: SESSION_A }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        uuid: "cb1",
        sessionId: SESSION_A,
        timestamp: "2026-07-28T10:10:00.000Z",
        compactMetadata: { trigger: "manual", preTokens: 154321 },
      }),
    ]);
    return root;
  }

  test("ingestMainTranscript persists the boundary instead of counting and dropping it", async () => {
    const root = compactCorpus();
    const main = await ingestMainTranscript(
      join(root, "-Users-craig-demo", `${SESSION_A}.jsonl`),
      SESSION_A,
    );
    expect(main.compactions).toEqual([{ ts: "2026-07-28T10:10:00.000Z", preTokens: 154321 }]);
    const rows = main.anomalies.filter((a) => a.kind === "compaction_continuation");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain(SESSION_A);
    expect(rows[0]!.detail).toContain("2026-07-28T10:10:00.000Z");
    expect(rows[0]!.detail).toContain("preTokens=154321");
  });

  test("a boundary with no preTokens says so rather than reporting a zero", () => {
    const [row] = compactionAnomalies(SESSION_A, [{ ts: "2026-07-28T10:10:00.000Z", preTokens: null }]);
    expect(row!.detail).toContain("carried no preTokens");
    expect(row!.detail).not.toContain("preTokens=0");
  });

  test("a sweep records it, does NOT alert on it, and does not re-log it", async () => {
    const root = compactCorpus();
    const db = openDb({ path: join(root, "e.db") });
    const report = await runSweep(db, { root });
    expect(report.anomalies.by_kind.compaction_continuation).toBe(1);
    // Compaction is a normal event; alerting would exit 3 on every long session.
    expect(report.anomalies.alerting).toBe(0);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) n FROM anomaly WHERE kind='compaction_continuation'").get()!.n,
    ).toBe(1);

    const again = await runSweep(db, { root, full: true });
    expect(again.anomalies.by_kind.compaction_continuation ?? 0).toBe(0);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) n FROM anomaly WHERE kind='compaction_continuation'").get()!.n,
    ).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// writeBatch no longer writes anomalies — one writer, and it de-duplicates
// ---------------------------------------------------------------------------

describe("the anomaly ledger has exactly one writer", () => {
  test("writeBatch writes rows only", async () => {
    const root = compactRootWithNothing();
    const db = openDb({ path: join(root, "e.db") });
    const session = discoverCorpus(root).sessions[0]!;
    const batch = await ingestSession(session);
    expect(batch.anomalies.length).toBeGreaterThan(0);
    db.transaction(() => writeBatch(db, batch))();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM anomaly").get()!.n).toBe(0);
    db.close();
  });

  function compactRootWithNothing(): string {
    const root = newRoot();
    // A main transcript with a torn tail: guaranteed at least one anomaly.
    const path = join(root, "-Users-craig-demo", `${SESSION_A}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${userLine({ uuid: "p0", promptId: "P1", ts: "2026-07-28T10:00:00.000Z", session: SESSION_A })}\n{"type":"assistant","uuid":"u1","time`,
    );
    return root;
  }
});

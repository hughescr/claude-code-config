/**
 * THE MANDATED TRUNCATED-TRANSCRIPT REGRESSION TEST — §5.2, §8.
 *
 * §5.2: "With `INSERT OR IGNORE`, a live-file partial read would freeze a low
 * value forever behind the byte watermark, silently reintroducing the 88%
 * undercount. Upsert-with-max makes watermarks pure performance; the **mandated
 * regression test**: ingest a sub-agent transcript truncated mid-request,
 * re-ingest the full file, assert totals equal the whole-file parse."
 *
 * §8 lists it as a pre-build gate ("Regression tests, both mandated").
 *
 * What makes this test different from the unit-level truncation cases already in
 * test/ingest.test.ts: those drive `ingestAgentTranscript` directly and never go
 * near `sweep_state`. The failure mode §5.2 names is a *sweeper* failure — the
 * byte watermark deciding a file needs no re-read, or a non-MAX write freezing
 * the partial value — so this file drives the whole `est sweep` path, twice,
 * against a corpus that changes underneath it exactly the way a live one does.
 *
 * The oracle is a **from-scratch sweep**: a second, empty database swept once
 * over the final state of the same corpus. Whatever an incremental sweeper
 * accumulated across a torn read and an extension must equal what a single clean
 * read of the finished files produces — not approximately, not for tokens only,
 * but row for row. Anything else means history is path-dependent, and a re-sweep
 * would no longer be the recovery mechanism §2 says it is.
 *
 * Four scenarios. A and B truncate mid-line and then extend; C and D cover the
 * two §5.2 rules that the truncation cases cannot reach — the watermark that must
 * NOT advance over bytes nobody read, and the second dedup pass:
 *
 *   A. **Sub-agent transcript torn mid-request** (§5.2 verbatim; the sub-agent
 *      path is 79.2% of cost). The cut lands inside the `usage` object of a
 *      cumulative streaming snapshot, so sweep 1 sees a strictly lower
 *      `output_tokens` for a requestId that sweep 2 sees complete.
 *
 *   B. **Main transcript torn mid-line, plus structure that arrives late.** The
 *      cut lands before the usage marker (the prefilter path), a whole turn's
 *      worth of assistant work appears only in sweep 2, a second workflow agent's
 *      transcript does not exist yet at sweep 1, and the workflow state file
 *      grows a `workflowProgress` record between sweeps. This is the case where
 *      an already-written row must be *upgraded* (NULL prompt_id backfilled,
 *      provisional interval finalised) rather than merely raised.
 *
 *   C. **A transcript that could not be READ at all.** Unlike a torn tail, the
 *      file does not grow, so the byte watermark is the only thing standing
 *      between the unread bytes and permanent invisibility. Asserts the
 *      watermark is withheld.
 *
 *   D. **A sidechain replay** — the same `message.id` under a NEW request_id,
 *      which the request_id PK cannot see. Asserts §5.2's second dedup pass
 *      counts it once, keeps the loser row for audit, and is idempotent.
 *
 * Zero npm dependencies: bun:test + bun:sqlite + node builtins.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, watermarkable } from "../src/cli.ts";
import { ingestSession, readJsonl } from "../src/ingest.ts";
import { openDb } from "../src/db.ts";

// ---------------------------------------------------------------------------
// transcript line builders — the shapes verified on this machine [R2][R3]
// ---------------------------------------------------------------------------

function jsonLine(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

/** The four counters, in the order the harness writes them. */
function usage(inTok: number, outTok: number, cwTok: number, crTok: number): Record<string, number> {
  return {
    input_tokens: inTok,
    cache_creation_input_tokens: cwTok,
    cache_read_input_tokens: crTok,
    output_tokens: outTok,
  };
}

interface AssistantOpts {
  sessionId: string;
  uuid: string;
  ts: string;
  requestId: string;
  model: string;
  /** [input, output, cache_creation, cache_read] */
  toks: readonly [number, number, number, number];
  content?: unknown[];
  agentId?: string;
  sidechain?: boolean;
}

/** An `assistant` line: the only line type that carries usage. */
function assistantLine(o: AssistantOpts): string {
  return jsonLine({
    type: "assistant",
    uuid: o.uuid,
    sessionId: o.sessionId,
    isSidechain: o.sidechain ?? false,
    ...(o.agentId === undefined ? {} : { agentId: o.agentId }),
    promptId: null, // assistant lines never carry one — §5.3 propagates it forward
    timestamp: o.ts,
    requestId: o.requestId,
    message: {
      id: `msg_${o.requestId}`,
      role: "assistant",
      model: o.model,
      content: o.content ?? [{ type: "text", text: "working" }],
      usage: usage(o.toks[0], o.toks[1], o.toks[2], o.toks[3]),
    },
  });
}

interface UserOpts {
  sessionId: string;
  uuid: string;
  ts: string;
  promptId: string | null;
  content?: unknown;
  toolUseResult?: unknown;
  agentId?: string;
  sidechain?: boolean;
}

function userLine(o: UserOpts): string {
  return jsonLine({
    type: "user",
    uuid: o.uuid,
    sessionId: o.sessionId,
    isSidechain: o.sidechain ?? false,
    ...(o.agentId === undefined ? {} : { agentId: o.agentId }),
    userType: "external",
    promptId: o.promptId,
    timestamp: o.ts,
    message: { role: "user", content: o.content ?? "do the thing" },
    ...(o.toolUseResult === undefined ? {} : { toolUseResult: o.toolUseResult }),
  });
}

function turnDurationLine(o: {
  sessionId: string;
  uuid: string;
  ts: string;
  durationMs: number;
  pendingWf?: number;
  pendingBg?: number;
}): string {
  return jsonLine({
    type: "system",
    subtype: "turn_duration",
    uuid: o.uuid,
    sessionId: o.sessionId,
    isSidechain: false,
    timestamp: o.ts,
    durationMs: o.durationMs,
    messageCount: 6,
    ...(o.pendingWf === undefined ? {} : { pendingWorkflowCount: o.pendingWf }),
    ...(o.pendingBg === undefined ? {} : { pendingBackgroundAgentCount: o.pendingBg }),
  });
}

const epoch = (iso: string): number => Date.parse(iso);

/**
 * Write a JSONL file.
 *
 * A complete file ends with a newline; a torn one does not — that missing
 * terminator is precisely what `readJsonl` keys `truncatedTail` on, so the two
 * cases must differ in exactly that byte and nothing else.
 */
function writeTranscript(path: string, lines: readonly string[], torn?: string): void {
  const body = lines.map((l) => `${l}\n`).join("");
  writeFileSync(path, torn === undefined ? body : body + torn);
}

/** Cut a line mid-`usage`, inside the digits of `output_tokens` (§5.2 "mid-request"). */
function tearInsideUsage(line: string, outTok: number): string {
  const marker = `"output_tokens":${outTok}`;
  const at = line.indexOf(marker);
  expect(at).toBeGreaterThan(0); // guard the fixture, not the code under test
  const fragment = line.slice(0, at + marker.length - 2);
  expect(() => JSON.parse(fragment) as unknown).toThrow();
  return fragment;
}

/** Cut a line BEFORE `"output_tokens"` — the fragment the usage prefilter cannot see. */
function tearBeforeUsage(line: string): string {
  const at = line.indexOf('"usage"');
  expect(at).toBeGreaterThan(0);
  const fragment = line.slice(0, at);
  expect(fragment).not.toContain('"output_tokens"');
  expect(() => JSON.parse(fragment) as unknown).toThrow();
  return fragment;
}

// ---------------------------------------------------------------------------
// prices — seeded so no `unpriced_model` noise enters the anomaly ledger and so
// the comparison can be made in the actual estimand (Work-CET), not raw tokens.
// ---------------------------------------------------------------------------

/** [family, usd_in, usd_out, usd_cw, usd_cr] per Mtok. */
const PRICES: readonly (readonly [string, number, number, number, number])[] = [
  ["claude-sonnet-4-5", 3, 15, 3.75, 0.3], // config.ref_model — the Work-CET normaliser
  ["claude-fable-5", 5, 25, 6.25, 0.5],
  ["claude-sonnet-5", 3, 15, 3.75, 0.3],
];

function seedPrices(dbPath: string): void {
  const db = openDb({ path: dbPath });
  try {
    const stmt = db.prepare(
      `INSERT INTO model_price (family, effective_from, usd_in, usd_out, usd_cw, usd_cr,
                                provisional, source, synced_epoch, ingested_at)
       VALUES (?, '2020-01-01T00:00:00Z', ?, ?, ?, ?, 0, 'manual', NULL, '2020-01-01T00:00:00Z')
       ON CONFLICT DO NOTHING`,
    );
    for (const [family, i, o, cw, cr] of PRICES) stmt.run(family, i, o, cw, cr);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// sweeping and snapshotting
// ---------------------------------------------------------------------------

interface SweepOutcome {
  code: number;
  sessions: { total: number; ingested: number; skipped: number; empty: number };
  parse: { truncatedTail: number; malformed: number };
  files_incomplete: number;
  sidechain_replays: number;
  anomalies: { recorded: number; by_kind: Record<string, number> };
  vanished: { total: number };
}

/** Drive the real CLI, against a throwaway database and lock. */
async function sweep(dbPath: string, root: string): Promise<SweepOutcome> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    ["sweep", "--db", dbPath, "--lock", `${dbPath}.lock`, "--root", root, "--json"],
    { out: (s) => out.push(s), err: (s) => err.push(s) },
  );
  if (out.length === 0) throw new Error(`est sweep produced no report: ${err.join("\n")}`);
  return { code, ...(JSON.parse(out.join("\n")) as Omit<SweepOutcome, "code">) };
}

type Row = Record<string, unknown>;

interface Snapshot {
  requests: Row[];
  turns: Row[];
  agents: Row[];
  runs: Row[];
  phases: Row[];
  events: Row[];
  sweepState: Row[];
  totals: Row;
}

/**
 * Every derived fact a sweep is responsible for, in a stable order.
 *
 * `anomaly` is deliberately NOT here: the incremental database legitimately
 * remembers a torn tail that the finished files no longer contain, and that
 * memory is the §2 loud-failure ledger working. It is asserted separately.
 * `sweep_census` is excluded for the same reason (one row per sweep, by design).
 */
function snapshot(dbPath: string): Snapshot {
  const db = new Database(dbPath, { readonly: true });
  try {
    const q = (sql: string): Row[] => db.query<Row, []>(sql).all();
    return {
      requests: q(
        `SELECT request_id, message_id, is_sidechain, session_id, prompt_id, origin,
                agent_id, run_id, wf_launch_id, model, model_family,
                attribution_agent, attribution_skill, ts,
                in_tok, out_tok, cw_tok, cr_tok, tid, attr
           FROM request ORDER BY request_id`,
      ),
      turns: q(
        `SELECT session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid
           FROM turn ORDER BY session_id, prompt_id`,
      ),
      agents: q("SELECT * FROM agent_run ORDER BY agent_id"),
      runs: q("SELECT * FROM workflow_run ORDER BY run_id, wf_launch_id"),
      phases: q("SELECT * FROM workflow_phase ORDER BY run_id, wf_launch_id, phase_idx"),
      events: q(
        `SELECT session_id, task_num, ts, kind, from_status, to_status, source
           FROM task_event ORDER BY ts, task_num, kind`,
      ),
      sweepState: q("SELECT path, inode, bytes_read FROM sweep_state ORDER BY path"),
      totals: db
        .query<Row, []>(
          `SELECT COUNT(*) AS n_req,
                  COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(out_tok),0) AS out_tok,
                  COALESCE(SUM(cw_tok),0) AS cw_tok, COALESCE(SUM(cr_tok),0) AS cr_tok,
                  COALESCE(SUM(wcet),0)   AS wcet,   COALESCE(SUM(scet),0)   AS scet
             FROM v_wcet`,
        )
        .get()!,
    };
  } finally {
    db.close();
  }
}

/** Table-by-table, so a failure names the table that diverged. */
function expectConverged(incremental: Snapshot, fresh: Snapshot): void {
  expect(incremental.requests).toEqual(fresh.requests);
  expect(incremental.turns).toEqual(fresh.turns);
  expect(incremental.agents).toEqual(fresh.agents);
  expect(incremental.runs).toEqual(fresh.runs);
  expect(incremental.phases).toEqual(fresh.phases);
  expect(incremental.events).toEqual(fresh.events);
  expect(incremental.sweepState).toEqual(fresh.sweepState);
  expect(incremental.totals).toEqual(fresh.totals);
}

function anomalyKinds(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ kind: string }, []>("SELECT kind FROM anomaly ORDER BY id")
      .all()
      .map((r) => r.kind);
  } finally {
    db.close();
  }
}

function requestTokens(dbPath: string): Map<string, { out: number; cw: number }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return new Map(
      db
        .query<{ request_id: string; out_tok: number; cw_tok: number }, []>(
          "SELECT request_id, out_tok, cw_tok FROM request",
        )
        .all()
        .map((r) => [r.request_id, { out: r.out_tok, cw: r.cw_tok }]),
    );
  } finally {
    db.close();
  }
}

// ===========================================================================
// Scenario A — a sub-agent transcript torn mid-request, then completed and grown
// ===========================================================================

const SID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PROJECT_A = "-Users-craig-regress-a";
const RUN_A = "wf_regressA-001";
const AGENT_A = "a0000000000000001";

/** The main transcript. Static across both stages: only the agent file changes. */
function mainLinesA(): string[] {
  return [
    userLine({ sessionId: SID_A, uuid: "u1", ts: "2026-07-28T10:00:00.000Z", promptId: "P1" }),
    assistantLine({
      sessionId: SID_A,
      uuid: "a1",
      ts: "2026-07-28T10:00:05.000Z",
      requestId: "req_mainA",
      model: "claude-fable-5",
      toks: [4, 100, 5000, 0],
      content: [{ type: "tool_use", id: "toolu_WF1", name: "Workflow", input: { script: "…" } }],
    }),
    userLine({
      sessionId: SID_A,
      uuid: "u2",
      ts: "2026-07-28T10:00:12.000Z",
      promptId: "P1",
      content: [{ type: "tool_result", tool_use_id: "toolu_WF1", content: "launched" }],
      toolUseResult: {
        status: "async_launched",
        taskId: "wl_regressA",
        taskType: "local_workflow",
        workflowName: "regress-flow",
        runId: RUN_A,
        transcriptDir: `subagents/workflows/${RUN_A}`,
        scriptPath: "workflows/scripts/regress.js",
      },
    }),
    turnDurationLine({
      sessionId: SID_A,
      uuid: "s1",
      ts: "2026-07-28T10:01:30.000Z",
      durationMs: 90_000,
      pendingWf: 1,
    }),
  ];
}

/**
 * The workflow agent's transcript, whole.
 *
 * Lines 1..3 are one request's cumulative streaming snapshots (5 -> 800 -> 3400
 * output tokens against a constant 26,850 cache_creation) — the shape verified
 * at 12,568 monotonic steps with zero decreases [B]. Line 3 is where the tear
 * goes.
 */
function agentLinesA(): string[] {
  const common = { sessionId: SID_A, agentId: AGENT_A, sidechain: true, model: "claude-sonnet-5" };
  return [
    userLine({
      sessionId: SID_A,
      uuid: "wA_u1",
      ts: "2026-07-28T10:00:21.000Z",
      promptId: null,
      agentId: AGENT_A,
      sidechain: true,
      content: "investigate",
    }),
    assistantLine({
      ...common,
      uuid: "wA_a1",
      ts: "2026-07-28T10:00:22.000Z",
      requestId: "req_A1",
      toks: [2, 5, 26850, 0],
    }),
    assistantLine({
      ...common,
      uuid: "wA_a2",
      ts: "2026-07-28T10:00:40.000Z",
      requestId: "req_A1",
      toks: [2, 800, 26850, 0],
    }),
    assistantLine({
      ...common,
      uuid: "wA_a3",
      ts: "2026-07-28T10:01:10.000Z",
      requestId: "req_A1",
      toks: [2, 3400, 26850, 0],
    }),
    userLine({
      sessionId: SID_A,
      uuid: "wA_u2",
      ts: "2026-07-28T10:01:12.000Z",
      promptId: null,
      agentId: AGENT_A,
      sidechain: true,
      content: [{ type: "tool_result", tool_use_id: "toolu_x1", content: "ok" }],
    }),
    assistantLine({
      ...common,
      uuid: "wA_a4",
      ts: "2026-07-28T10:01:55.000Z",
      requestId: "req_A2",
      toks: [3, 120, 400, 26850],
    }),
  ];
}

/**
 * `wf_<runId>.json`, static across both stages.
 *
 * The scheduler interval CONTAINS the transcript interval (queued 10:00:15,
 * started 10:00:20, +120 s -> 10:02:20, against transcript lines 10:00:21 ->
 * 10:01:55), which is the real relationship: a scheduler start precedes the
 * first written line by the time-to-first-token, and the run is recorded as over
 * only after the last one (§5.3).
 */
function stateA(): unknown {
  return {
    runId: RUN_A,
    taskId: "wl_regressA",
    workflowName: "regress-flow",
    transcriptDir: `subagents/workflows/${RUN_A}`,
    scriptPath: "workflows/scripts/regress.js",
    defaultModel: "claude-sonnet-5",
    phases: [{ title: "Investigate", detail: "one investigator" }],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Investigate" },
      {
        type: "workflow_agent",
        index: 1,
        label: "investigate:one",
        phaseIndex: 1,
        phaseTitle: "Investigate",
        agentId: AGENT_A,
        agentType: "general-purpose",
        model: "claude-sonnet-5",
        state: "done",
        queuedAt: epoch("2026-07-28T10:00:15.000Z"),
        startedAt: epoch("2026-07-28T10:00:20.000Z"),
        attempt: 1,
        tokens: 26850, // BANNED from every sum (§5.6) — stored for audit only
        toolCalls: 3,
        durationMs: 120_000,
        promptPreview: "investigate",
        resultPreview: "found things",
      },
    ],
    // Run-level aggregates, all on the §5.6 ban list. Present because real files
    // have them, and wrong on purpose so a reader of them would be caught.
    agentCount: 99,
    status: "killed",
    totalTokens: 1,
    durationMs: 1,
    result: "BANNED — never read",
  };
}

function buildScenarioA(root: string, stage: 1 | 2): void {
  const projectDir = join(root, PROJECT_A);
  const sessionDir = join(projectDir, SID_A);
  const wfDir = join(sessionDir, "subagents", "workflows", RUN_A);
  mkdirSync(join(sessionDir, "workflows"), { recursive: true });
  mkdirSync(wfDir, { recursive: true });

  writeTranscript(join(projectDir, `${SID_A}.jsonl`), mainLinesA());
  writeFileSync(
    join(sessionDir, "workflows", `${RUN_A}.json`),
    JSON.stringify(stateA(), null, 2),
  );
  writeFileSync(
    join(wfDir, `agent-${AGENT_A}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", spawnDepth: 1, model: "sonnet" }),
  );
  writeFileSync(
    join(wfDir, "journal.jsonl"),
    `${jsonLine({ type: "started", key: "v2:aaaa", agentId: AGENT_A })}\n`,
  );

  const lines = agentLinesA();
  const agentPath = join(wfDir, `agent-${AGENT_A}.jsonl`);
  if (stage === 1) {
    // Caught mid-write: two complete snapshots, and the third cut inside its own
    // output_tokens digits.
    writeTranscript(agentPath, lines.slice(0, 3), tearInsideUsage(lines[3]!, 3400));
  } else {
    writeTranscript(agentPath, lines);
  }
}

// ===========================================================================
// Scenario B — main transcript torn mid-line; structure and files arrive later
// ===========================================================================

const SID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PROJECT_B = "-Users-craig-regress-b";
const RUN_B = "wf_regressB-002";
const WF_AGENT_1 = "b0000000000000001";
const WF_AGENT_2 = "b0000000000000002";
const TOOL_AGENT = "b0000000000000009";

function mainLinesB(): string[] {
  return [
    userLine({ sessionId: SID_B, uuid: "u1", ts: "2026-07-28T10:00:00.000Z", promptId: "P1" }),
    assistantLine({
      sessionId: SID_B,
      uuid: "a1",
      ts: "2026-07-28T10:00:05.000Z",
      requestId: "req_mainB1",
      model: "claude-fable-5",
      toks: [4, 100, 5000, 0],
      content: [{ type: "tool_use", id: "toolu_WF1", name: "Workflow", input: { script: "…" } }],
    }),
    userLine({
      sessionId: SID_B,
      uuid: "u2",
      ts: "2026-07-28T10:00:12.000Z",
      promptId: "P1",
      content: [{ type: "tool_result", tool_use_id: "toolu_WF1", content: "launched" }],
      toolUseResult: {
        status: "async_launched",
        taskId: "wl_regressB",
        taskType: "local_workflow",
        workflowName: "regress-flow-b",
        runId: RUN_B,
        transcriptDir: `subagents/workflows/${RUN_B}`,
        scriptPath: "workflows/scripts/regress-b.js",
      },
    }),
    turnDurationLine({
      sessionId: SID_B,
      uuid: "s1",
      ts: "2026-07-28T10:01:30.000Z",
      durationMs: 90_000,
      pendingWf: 1,
    }),
    // --- turn P2 opens; the sweep in scenario B lands right here -------------
    userLine({
      sessionId: SID_B,
      uuid: "u3",
      ts: "2026-07-28T10:05:00.000Z",
      promptId: "P2",
      content: "now review it",
    }),
    // ...and this line is the one that is torn. It launches the Agent-tool
    // sub-agent, so at sweep 1 that sub-agent's spend has no visible launching
    // turn at all — `toolUsePrompts` cannot resolve toolu_AG1 yet.
    assistantLine({
      sessionId: SID_B,
      uuid: "a2",
      ts: "2026-07-28T10:05:04.000Z",
      requestId: "req_mainB2",
      model: "claude-fable-5",
      toks: [10, 500, 1000, 90000],
      content: [{ type: "tool_use", id: "toolu_AG1", name: "Agent", input: { prompt: "review" } }],
    }),
    userLine({
      sessionId: SID_B,
      uuid: "u4",
      ts: "2026-07-28T10:05:20.000Z",
      promptId: "P2",
      content: [{ type: "tool_result", tool_use_id: "toolu_AG1", content: "reviewed" }],
    }),
    // TaskCreate: `toolUseResult.task`, no statusChange. §5.4 counts this as
    // touching the task, so the sweeper has to persist it as a task_event too.
    userLine({
      sessionId: SID_B,
      uuid: "u4b",
      ts: "2026-07-28T10:05:40.000Z",
      promptId: "P2",
      content: [{ type: "tool_result", tool_use_id: "toolu_TC1", content: "created" }],
      toolUseResult: { task: { id: "7", subject: "review it" } },
    }),
    userLine({
      sessionId: SID_B,
      uuid: "u5",
      ts: "2026-07-28T10:06:00.000Z",
      promptId: "P2",
      content: [{ type: "tool_result", tool_use_id: "toolu_TU9", content: "ok" }],
      toolUseResult: {
        success: true,
        taskId: "7",
        updatedFields: ["status"],
        statusChange: { from: "pending", to: "in_progress" },
      },
    }),
    turnDurationLine({
      sessionId: SID_B,
      uuid: "s2",
      ts: "2026-07-28T10:06:30.000Z",
      durationMs: 60_000,
      pendingBg: 1,
    }),
  ];
}

/** The Agent-tool sub-agent — running, and growing, while its launch is unread. */
function toolAgentLinesB(): string[] {
  const common = {
    sessionId: SID_B,
    agentId: TOOL_AGENT,
    sidechain: true,
    model: "claude-sonnet-5",
  };
  return [
    userLine({
      sessionId: SID_B,
      uuid: "ag_u1",
      ts: "2026-07-28T10:05:12.000Z",
      promptId: null,
      agentId: TOOL_AGENT,
      sidechain: true,
      content: "review it",
    }),
    assistantLine({
      ...common,
      uuid: "ag_a1",
      ts: "2026-07-28T10:05:13.000Z",
      requestId: "req_S1",
      toks: [2, 8, 1200, 0],
    }),
    assistantLine({
      ...common,
      uuid: "ag_a2",
      ts: "2026-07-28T10:06:40.000Z",
      requestId: "req_S1",
      toks: [2, 70, 1200, 0],
    }),
    assistantLine({
      ...common,
      uuid: "ag_a3",
      ts: "2026-07-28T10:07:30.000Z",
      requestId: "req_S2",
      toks: [3, 40, 100, 1200],
    }),
  ];
}

function wfAgent1LinesB(): string[] {
  const common = {
    sessionId: SID_B,
    agentId: WF_AGENT_1,
    sidechain: true,
    model: "claude-sonnet-5",
  };
  return [
    userLine({
      sessionId: SID_B,
      uuid: "wB1_u1",
      ts: "2026-07-28T10:00:21.000Z",
      promptId: null,
      agentId: WF_AGENT_1,
      sidechain: true,
      content: "collect",
    }),
    assistantLine({
      ...common,
      uuid: "wB1_a1",
      ts: "2026-07-28T10:01:55.000Z",
      requestId: "req_B1",
      toks: [2, 250, 9000, 0],
    }),
  ];
}

function wfAgent2LinesB(): string[] {
  const common = {
    sessionId: SID_B,
    agentId: WF_AGENT_2,
    sidechain: true,
    model: "claude-sonnet-5",
  };
  return [
    userLine({
      sessionId: SID_B,
      uuid: "wB2_u1",
      ts: "2026-07-28T10:02:11.000Z",
      promptId: null,
      agentId: WF_AGENT_2,
      sidechain: true,
      content: "merge",
    }),
    assistantLine({
      ...common,
      uuid: "wB2_a1",
      ts: "2026-07-28T10:03:30.000Z",
      requestId: "req_B2",
      toks: [2, 700, 3000, 9000],
    }),
  ];
}

/**
 * The state file, mid-run and finished.
 *
 * At stage 1 the run is live: phase 1's agent has not been scheduled, and the
 * running agent has a `startedAt` but no `durationMs` — so its `ended_at` is the
 * NULL-or-provisional §5.3 describes, and must be *filled in* by the next sweep
 * rather than left behind.
 */
function stateB(stage: 1 | 2): unknown {
  const agent1 = {
    type: "workflow_agent",
    index: 1,
    label: "collect:one",
    phaseIndex: 1,
    phaseTitle: "Collect",
    agentId: WF_AGENT_1,
    agentType: "general-purpose",
    model: "claude-sonnet-5",
    state: stage === 1 ? "running" : "done",
    queuedAt: epoch("2026-07-28T10:00:15.000Z"),
    startedAt: epoch("2026-07-28T10:00:20.000Z"),
    attempt: 1,
    tokens: 9000,
    toolCalls: 2,
    ...(stage === 1 ? {} : { durationMs: 120_000 }),
    promptPreview: "collect",
    resultPreview: stage === 1 ? "" : "collected",
  };
  const agent2 = {
    type: "workflow_agent",
    index: 2,
    label: "merge:two",
    phaseIndex: 2,
    phaseTitle: "Merge",
    agentId: WF_AGENT_2,
    agentType: "general-purpose",
    model: "claude-sonnet-5",
    state: "done",
    queuedAt: epoch("2026-07-28T10:02:05.000Z"),
    startedAt: epoch("2026-07-28T10:02:10.000Z"),
    attempt: 1,
    tokens: 3000,
    toolCalls: 1,
    durationMs: 100_000,
    promptPreview: "merge",
    resultPreview: "merged",
  };
  return {
    runId: RUN_B,
    taskId: "wl_regressB",
    workflowName: "regress-flow-b",
    transcriptDir: `subagents/workflows/${RUN_B}`,
    scriptPath: "workflows/scripts/regress-b.js",
    defaultModel: "claude-sonnet-5",
    phases: [
      { title: "Collect", detail: "one collector" },
      { title: "Merge", detail: "merge the findings" },
    ],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Collect" },
      { type: "workflow_phase", index: 2, title: "Merge" },
      agent1,
      ...(stage === 1 ? [] : [agent2]),
    ],
    agentCount: 99,
    status: "killed",
    totalTokens: 1,
    durationMs: 1,
    result: "BANNED — never read",
  };
}

function buildScenarioB(root: string, stage: 1 | 2): void {
  const projectDir = join(root, PROJECT_B);
  const sessionDir = join(projectDir, SID_B);
  const subagentsDir = join(sessionDir, "subagents");
  const wfDir = join(subagentsDir, "workflows", RUN_B);
  mkdirSync(join(sessionDir, "workflows"), { recursive: true });
  mkdirSync(wfDir, { recursive: true });

  // --- main transcript: torn mid-line at stage 1 ----------------------------
  const main = mainLinesB();
  const mainPath = join(projectDir, `${SID_B}.jsonl`);
  if (stage === 1) {
    // The cut lands BEFORE `"usage"`, so the fragment carries no `output_tokens`
    // marker: a prefilter that skipped it would report a clean parse over a file
    // that is missing a paid request.
    writeTranscript(mainPath, main.slice(0, 5), tearBeforeUsage(main[5]!));
  } else {
    writeTranscript(mainPath, main);
  }

  // --- Agent-tool sub-agent: present at both stages, longer at stage 2 ------
  const toolLines = toolAgentLinesB();
  writeTranscript(
    join(subagentsDir, `agent-${TOOL_AGENT}.jsonl`),
    stage === 1 ? toolLines.slice(0, 2) : toolLines,
  );
  writeFileSync(
    join(subagentsDir, `agent-${TOOL_AGENT}.meta.json`),
    JSON.stringify({
      agentType: "code-reviewer",
      description: "review it",
      toolUseId: "toolu_AG1",
      spawnDepth: 1,
    }),
  );

  // --- workflow agents: the second one does not exist yet at stage 1 --------
  writeTranscript(join(wfDir, `agent-${WF_AGENT_1}.jsonl`), wfAgent1LinesB());
  writeFileSync(
    join(wfDir, `agent-${WF_AGENT_1}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", spawnDepth: 1, model: "sonnet" }),
  );
  const journal = [jsonLine({ type: "started", key: "v2:bbb1", agentId: WF_AGENT_1 })];
  if (stage === 2) {
    writeTranscript(join(wfDir, `agent-${WF_AGENT_2}.jsonl`), wfAgent2LinesB());
    writeFileSync(
      join(wfDir, `agent-${WF_AGENT_2}.meta.json`),
      JSON.stringify({ agentType: "general-purpose", spawnDepth: 1, model: "sonnet" }),
    );
    journal.push(
      jsonLine({ type: "result", key: "v2:bbb1", agentId: WF_AGENT_1, result: "collected" }),
      jsonLine({ type: "started", key: "v2:bbb2", agentId: WF_AGENT_2 }),
      jsonLine({ type: "result", key: "v2:bbb2", agentId: WF_AGENT_2, result: "merged" }),
    );
  }
  writeTranscript(join(wfDir, "journal.jsonl"), journal);

  writeFileSync(
    join(sessionDir, "workflows", `${RUN_B}.json`),
    JSON.stringify(stateB(stage), null, 2),
  );
}

// ===========================================================================
// the tests
// ===========================================================================

interface Bench {
  dir: string;
  root: string;
  incremental: string;
  fresh: string;
}

function bench(name: string): Bench {
  const dir = mkdtempSync(join(tmpdir(), `est-regress-${name}-`));
  const b: Bench = {
    dir,
    root: join(dir, "projects"),
    incremental: join(dir, "incremental.db"),
    fresh: join(dir, "fresh.db"),
  };
  mkdirSync(b.root, { recursive: true });
  seedPrices(b.incremental);
  seedPrices(b.fresh);
  return b;
}

describe("truncated-transcript re-ingest (§5.2 mandated regression)", () => {
  test("A: a sub-agent transcript torn mid-request converges on the whole-file parse", async () => {
    const b = bench("a");
    try {
      // --- sweep 1: the sweeper catches the agent file mid-write ------------
      buildScenarioA(b.root, 1);
      const first = await sweep(b.incremental, b.root);
      expect(first.sessions.ingested).toBe(1);
      expect(first.parse.truncatedTail).toBe(1);
      expect(first.parse.malformed).toBe(0);
      expect(first.anomalies.by_kind.truncated_tail).toBe(1);
      // A torn tail alone is benign — expected of any live corpus (§2).
      expect(first.code).toBe(0);

      // The low watermark, exactly as expected mid-stream: the third snapshot is
      // unreadable, so 800 is all that is known. Nothing is invented, and the
      // request whose only line was torn does not exist yet.
      const afterFirst = requestTokens(b.incremental);
      expect(afterFirst.get("req_A1")).toEqual({ out: 800, cw: 26850 });
      expect(afterFirst.has("req_A2")).toBe(false);
      expect([...afterFirst.keys()].sort()).toEqual(["req_A1", "req_mainA"]);

      // --- the file is completed and extended -------------------------------
      buildScenarioA(b.root, 2);
      const second = await sweep(b.incremental, b.root);
      // The byte watermark must NOT decide this file needs no re-read.
      expect(second.sessions.ingested).toBe(1);
      expect(second.sessions.skipped).toBe(0);
      expect(second.parse.truncatedTail).toBe(0);
      expect(second.vanished.total).toBe(0);

      // THE assertion §5.2 mandates: the totals are the whole-file parse's, not
      // the watermark's. 800 -> 3400 for a row already on disk is the 88%
      // undercount this rule exists to prevent.
      const afterSecond = requestTokens(b.incremental);
      expect(afterSecond.get("req_A1")).toEqual({ out: 3400, cw: 26850 });
      expect(afterSecond.get("req_A2")).toEqual({ out: 120, cw: 400 });
      expect(afterSecond.get("req_mainA")).toEqual({ out: 100, cw: 5000 });

      // --- the oracle: one clean sweep of the finished corpus ---------------
      const freshRun = await sweep(b.fresh, b.root);
      expect(freshRun.sessions.ingested).toBe(1);
      // Nothing is torn, unlabelled, unmapped, unpriced or missing any more, so
      // a from-scratch sweep of the final corpus is silent.
      expect(freshRun.anomalies.recorded).toBe(0);
      expect(freshRun.code).toBe(0);

      const incrementalSnap = snapshot(b.incremental);
      const freshSnap = snapshot(b.fresh);
      // Guard against a vacuous pass: the comparison must be over real spend.
      expect(incrementalSnap.requests).toHaveLength(3);
      expect(incrementalSnap.totals.out_tok).toBe(3620); // 3400 + 120 + 100
      expect(incrementalSnap.totals.cw_tok).toBe(32250); // 26850 + 400 + 5000
      expect(incrementalSnap.totals.wcet as number).toBeGreaterThan(0);
      expectConverged(incrementalSnap, freshSnap);

      // --- and the third sweep is a no-op ----------------------------------
      const third = await sweep(b.incremental, b.root);
      expect(third.sessions.ingested).toBe(0);
      expect(third.sessions.skipped).toBe(1);
      expect(third.anomalies.recorded).toBe(0);
      expect(third.code).toBe(0);
      expect(snapshot(b.incremental)).toEqual(incrementalSnap);

      // The ledger is the one thing that legitimately differs: the incremental
      // database REMEMBERS the torn read, and the finished corpus has no trace
      // of it. A loud failure is not retracted just because it healed (§2).
      expect(anomalyKinds(b.incremental)).toEqual(["truncated_tail"]);
      expect(anomalyKinds(b.fresh)).toEqual([]);
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  test("B: a main transcript torn mid-line, with structure that lands one sweep later", async () => {
    const b = bench("b");
    try {
      // --- sweep 1: mid-turn, mid-run, mid-write ----------------------------
      buildScenarioB(b.root, 1);
      const first = await sweep(b.incremental, b.root);
      expect(first.sessions.ingested).toBe(1);
      expect(first.parse.truncatedTail).toBe(1);
      expect(first.parse.malformed).toBe(0);

      const db1 = new Database(b.incremental, { readonly: true });
      try {
        // The torn assistant line is invisible, so its request does not exist...
        const ids = db1
          .query<{ request_id: string }, []>("SELECT request_id FROM request ORDER BY request_id")
          .all()
          .map((r) => r.request_id);
        expect(ids).toEqual(["req_B1", "req_S1", "req_mainB1"]);

        // ...and with it goes the only record of which turn launched the
        // Agent-tool sub-agent. Its spend is captured anyway, unattributed
        // rather than dropped — a NULL prompt_id is a counted state (§4.2).
        const s1 = db1
          .query<{ prompt_id: string | null }, []>("SELECT prompt_id FROM request WHERE request_id='req_S1'")
          .get()!;
        expect(s1.prompt_id).toBeNull();
        const toolAgent = db1
          .query<{ launch_prompt_id: string | null; ended_at: string | null }, [string]>(
            "SELECT launch_prompt_id, ended_at FROM agent_run WHERE agent_id=?",
          )
          .get(TOOL_AGENT)!;
        expect(toolAgent.launch_prompt_id).toBeNull();

        // Turn P2 is open: the user line is written, the turn_duration record is
        // not, so duration_ms is NULL and must stay NULL rather than become 0.
        const p2 = db1
          .query<{ duration_ms: number | null }, []>(
            "SELECT duration_ms FROM turn WHERE prompt_id='P2'",
          )
          .get()!;
        expect(p2.duration_ms).toBeNull();

        // The live workflow agent has a scheduler start but no duration yet.
        const wf1 = db1
          .query<{ interval_src: string; started_at: string; ended_at: string | null; status: string }, [string]>(
            "SELECT interval_src, started_at, ended_at, status FROM agent_run WHERE agent_id=?",
          )
          .get(WF_AGENT_1)!;
        expect(wf1.interval_src).toBe("workflow_progress");
        expect(wf1.started_at).toBe("2026-07-28T10:00:20.000Z");
        expect(wf1.ended_at).toBeNull();
        expect(wf1.status).toBe("running");

        // Phase 1's agent has not been scheduled: no transcript, no row.
        expect(
          db1.query<{ n: number }, []>("SELECT COUNT(*) n FROM agent_run").get()!.n,
        ).toBe(2);
      } finally {
        db1.close();
      }

      // --- the transcripts are completed, extended, and joined by a third ----
      buildScenarioB(b.root, 2);
      const second = await sweep(b.incremental, b.root);
      expect(second.sessions.ingested).toBe(1);
      expect(second.sessions.skipped).toBe(0);
      expect(second.parse.truncatedTail).toBe(0);
      expect(second.vanished.total).toBe(0);

      const db2 = new Database(b.incremental, { readonly: true });
      try {
        // The formerly-torn request is now counted...
        expect(
          db2.query<{ out_tok: number }, []>("SELECT out_tok FROM request WHERE request_id='req_mainB2'").get()!
            .out_tok,
        ).toBe(500);
        // ...the cumulative sub-agent counter is raised, not frozen...
        expect(
          db2.query<{ out_tok: number }, []>("SELECT out_tok FROM request WHERE request_id='req_S1'").get()!
            .out_tok,
        ).toBe(70);
        // ...and the rows written blind at sweep 1 are BACKFILLED, not stranded:
        // the launching turn is now known, so the sub-agent's spend attributes.
        const s1 = db2
          .query<{ prompt_id: string | null }, []>("SELECT prompt_id FROM request WHERE request_id='req_S1'")
          .get()!;
        expect(s1.prompt_id).toBe("P2");
        const toolAgent = db2
          .query<{ launch_prompt_id: string | null }, [string]>(
            "SELECT launch_prompt_id FROM agent_run WHERE agent_id=?",
          )
          .get(TOOL_AGENT)!;
        expect(toolAgent.launch_prompt_id).toBe("P2");

        // The provisional interval is finalised (§5.3), and the exact phase join
        // now covers both agents (§5.6).
        const wf1 = db2
          .query<{ ended_at: string | null; status: string; phase_conf: string; phase_idx: number }, [string]>(
            "SELECT ended_at, status, phase_conf, phase_idx FROM agent_run WHERE agent_id=?",
          )
          .get(WF_AGENT_1)!;
        expect(wf1.ended_at).toBe("2026-07-28T10:02:20.000Z");
        expect(wf1.status).toBe("done");
        expect([wf1.phase_conf, wf1.phase_idx]).toEqual(["exact", 0]);
        const wf2 = db2
          .query<{ phase_conf: string; phase_idx: number; interval_src: string }, [string]>(
            "SELECT phase_conf, phase_idx, interval_src FROM agent_run WHERE agent_id=?",
          )
          .get(WF_AGENT_2)!;
        expect([wf2.phase_conf, wf2.phase_idx, wf2.interval_src]).toEqual([
          "exact",
          1,
          "workflow_progress",
        ]);

        // Turn P2's clock arrived with the extension.
        expect(
          db2.query<{ duration_ms: number }, []>("SELECT duration_ms FROM turn WHERE prompt_id='P2'").get()!
            .duration_ms,
        ).toBe(60_000);

        // BOTH lifecycle facts for task 7 survive the sweep: the TaskCreate and
        // the TaskUpdate that moved it. §5.4's "touched" is the union of the two,
        // so an ingest that persisted only the transition would lose every task
        // that was created and finished inside one turn.
        expect(
          db2
            .query<{ kind: string; from_status: string | null; to_status: string; source: string }, []>(
              "SELECT kind, from_status, to_status, source FROM task_event WHERE task_num='7' ORDER BY ts",
            )
            .all(),
        ).toEqual([
          // `from_status` is nullable: a create has no prior state to record.
          { kind: "create", from_status: null, to_status: "pending", source: "transcript" },
          { kind: "status", from_status: "pending", to_status: "in_progress", source: "transcript" },
        ]);
      } finally {
        db2.close();
      }

      // --- the oracle -------------------------------------------------------
      const freshRun = await sweep(b.fresh, b.root);
      expect(freshRun.sessions.ingested).toBe(1);
      expect(freshRun.anomalies.recorded).toBe(0);
      expect(freshRun.code).toBe(0);

      const incrementalSnap = snapshot(b.incremental);
      const freshSnap = snapshot(b.fresh);
      expect(incrementalSnap.requests).toHaveLength(6);
      expect(incrementalSnap.turns).toHaveLength(2);
      expect(incrementalSnap.agents).toHaveLength(3);
      expect(incrementalSnap.totals.out_tok).toBe(100 + 500 + 70 + 40 + 250 + 700);
      expect(incrementalSnap.totals.wcet as number).toBeGreaterThan(0);
      expectConverged(incrementalSnap, freshSnap);

      // --- no-op re-sweep ---------------------------------------------------
      const third = await sweep(b.incremental, b.root);
      expect(third.sessions.ingested).toBe(0);
      expect(third.sessions.skipped).toBe(1);
      expect(third.anomalies.recorded).toBe(0);
      expect(snapshot(b.incremental)).toEqual(incrementalSnap);

      // The only anomaly either sweep of this corpus could raise is the torn
      // tail the incremental database read and the fresh one never saw.
      expect(anomalyKinds(b.incremental)).toEqual(["truncated_tail"]);
      expect(anomalyKinds(b.fresh)).toEqual([]);
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Scenario D — §5.2's SECOND dedup pass (ccusage's message_id fallback)
// ===========================================================================
//
// The request_id PK collapses the same request id seen twice. It does nothing
// about the case [FS][TESTED] documents: a sidechain line replaying a parent
// message under a NEW request_id. Both rows survive the PK and both get counted
// — the precise double-count ccusage's message_id fallback exists to prevent, in
// the sub-agent path that is 79.2% of cost.

const SID_D = "dddddddd-4444-4444-8444-dddddddddddd";
const PROJECT_D = "-Users-craig-regress-d";
const AGENT_D = "d0000000000000001";

/** The replayed message: one id, two request ids, main vs sidechain. */
const REPLAYED_MSG = "msg_req_D_main";

function buildScenarioD(root: string): void {
  const projectDir = join(root, PROJECT_D);
  const sessionDir = join(projectDir, SID_D);
  const subagents = join(sessionDir, "subagents");
  mkdirSync(subagents, { recursive: true });

  writeTranscript(join(projectDir, `${SID_D}.jsonl`), [
    userLine({ sessionId: SID_D, uuid: "u1", ts: "2026-07-28T10:00:00.000Z", promptId: "P1" }),
    assistantLine({
      sessionId: SID_D,
      uuid: "a1",
      ts: "2026-07-28T10:00:05.000Z",
      requestId: "req_D_main",
      model: "claude-fable-5",
      toks: [4, 100, 5000, 0],
      content: [{ type: "tool_use", id: "toolu_AG1", name: "Agent", input: { prompt: "go" } }],
    }),
    userLine({
      sessionId: SID_D,
      uuid: "u2",
      ts: "2026-07-28T10:00:12.000Z",
      promptId: "P1",
      content: [{ type: "tool_result", tool_use_id: "toolu_AG1", content: "done" }],
    }),
  ]);

  writeFileSync(
    join(subagents, `agent-${AGENT_D}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", spawnDepth: 1, toolUseId: "toolu_AG1" }),
  );
  // The sub-agent transcript replays the parent's message under a new requestId
  // (`message.id` identical, `requestId` different, `isSidechain` true) and then
  // does its own work under a request id of its own.
  const replay = assistantLine({
    sessionId: SID_D,
    uuid: "dA_a0",
    ts: "2026-07-28T10:00:20.000Z",
    requestId: "req_D_replay",
    model: "claude-fable-5",
    agentId: AGENT_D,
    sidechain: true,
    toks: [4, 100, 5000, 0],
  }).replace(`"msg_req_D_replay"`, `"${REPLAYED_MSG}"`);
  expect(replay).toContain(`"${REPLAYED_MSG}"`);

  writeTranscript(join(subagents, `agent-${AGENT_D}.jsonl`), [
    replay,
    assistantLine({
      sessionId: SID_D,
      uuid: "dA_a1",
      ts: "2026-07-28T10:00:22.000Z",
      requestId: "req_D_own",
      model: "claude-sonnet-5",
      agentId: AGENT_D,
      sidechain: true,
      toks: [2, 3400, 26850, 0],
    }),
  ]);
}

function attrOf(dbPath: string): Map<string, string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return new Map(
      db
        .query<{ request_id: string; attr: string }, []>("SELECT request_id, attr FROM request")
        .all()
        .map((r) => [r.request_id, r.attr]),
    );
  } finally {
    db.close();
  }
}

function liveOutTokens(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.query<{ n: number }, []>("SELECT COALESCE(SUM(out_tok),0) AS n FROM v_request_live").get()!
        .n
    );
  } finally {
    db.close();
  }
}

describe("sidechain replay dedup (§5.2 second pass)", () => {
  test("D: a message replayed under a new request_id is counted ONCE", async () => {
    const b = bench("d");
    try {
      buildScenarioD(b.root);
      const first = await sweep(b.incremental, b.root);
      expect(first.sessions.ingested).toBe(1);
      expect(first.sidechain_replays).toBe(1);
      expect(first.anomalies.by_kind.sidechain_replay).toBe(1);

      // The loser is KEPT for audit and demoted — never deleted (§5.2).
      const attrs = attrOf(b.incremental);
      expect(attrs.get("req_D_main")).toBe("none"); // is_sidechain=0 wins rule (1)
      expect(attrs.get("req_D_replay")).toBe("replay");
      expect(attrs.get("req_D_own")).toBe("none");

      // v_request_live — the base of the whole view stack — really does filter it.
      expect(liveOutTokens(b.incremental)).toBe(100 + 3400);

      // --- idempotence: a re-sweep recomputes the same winner ---------------
      const second = await sweep(b.incremental, b.root);
      expect(second.sessions.skipped).toBe(1);
      expect(attrOf(b.incremental)).toEqual(attrs);
      expect(liveOutTokens(b.incremental)).toBe(100 + 3400);

      // --- and a from-scratch sweep agrees, row for row --------------------
      await sweep(b.fresh, b.root);
      expectConverged(snapshot(b.incremental), snapshot(b.fresh));
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Scenario C — a transcript that could not be READ, and the watermark trap
// ===========================================================================
//
// §5.2's mandated test covers the torn *tail*: the file grows, so the byte check
// re-opens it and upsert-with-MAX raises the value. It does NOT cover the read
// that ABORTS. `readJsonl` catches the stream error, records an anomaly and
// returns the rows it managed to get — and the file's size and inode never
// change. Write a `sweep_state` row for it anyway and the next sweep computes
// (same inode, same bytes) -> `unchanged` -> skips the whole session, freezing
// the unread bytes out of every future incremental sweep. Only
// `est backfill --full` would recover them, and scripts/est-cron.sh never runs
// one, so the loss is permanent in practice.
//
// The seams are exercised directly rather than through a whole `est sweep`: on
// this platform a file that `readJsonl` cannot open is one `discoverCorpus` also
// cannot resolve (bun's `realpathSync` needs read permission), so a corpus-level
// fixture would test the discovery path instead of the watermark path.

const SID_C = "cccccccc-3333-4333-8333-cccccccccccc";
const AGENT_C = "c0000000000000001";

describe("unreadable-transcript re-ingest (the watermark trap §5.2 forbids)", () => {
  test("C1: readJsonl reports an aborted read as read_error, not as a clean parse", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const dir = mkdtempSync(join(tmpdir(), "est-regress-c1-"));
    try {
      const path = join(dir, "unreadable.jsonl");
      writeTranscript(path, ['{"type":"user"}', '{"type":"assistant"}']);
      chmodSync(path, 0o000);

      const seen: string[] = [];
      const r = await readJsonl(path, (line) => seen.push(line));
      expect(r.complete).toBe(false);
      expect(seen).toEqual([]);
      expect(r.anomalies.map((a) => a.kind)).toEqual(["read_error"]);
      // A clean read of the same file says the opposite, so `complete` is not
      // simply always-false.
      chmodSync(path, 0o644);
      const ok = await readJsonl(path, () => {});
      expect(ok.complete).toBe(true);
      expect(ok.anomalies).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("C2: ingestSession surfaces the unread file and keeps everything else", async () => {
    if (process.getuid?.() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "est-regress-c2-"));
    try {
      const mainPath = join(dir, `${SID_C}.jsonl`);
      const agentPath = join(dir, `agent-${AGENT_C}.jsonl`);
      writeTranscript(mainPath, [
        userLine({ sessionId: SID_C, uuid: "u1", ts: "2026-07-28T10:00:00.000Z", promptId: "P1" }),
        assistantLine({
          sessionId: SID_C,
          uuid: "a1",
          ts: "2026-07-28T10:00:05.000Z",
          requestId: "req_mainC",
          model: "claude-fable-5",
          toks: [4, 100, 5000, 0],
        }),
      ]);
      writeTranscript(agentPath, [
        assistantLine({
          sessionId: SID_C,
          uuid: "cA_a1",
          ts: "2026-07-28T10:00:22.000Z",
          requestId: "req_C1",
          model: "claude-sonnet-5",
          agentId: AGENT_C,
          sidechain: true,
          toks: [2, 3400, 26850, 0],
        }),
      ]);
      chmodSync(agentPath, 0o000);

      // Hand-built so the corpus is exactly this: one readable main transcript
      // and one sub-agent transcript that cannot be opened.
      const batch = await ingestSession({
        sessionId: SID_C,
        projectDirs: [dir],
        mainTranscripts: [mainPath],
        agents: [
          {
            agentId: AGENT_C,
            transcriptPath: agentPath,
            metaPath: null,
            meta: null,
            runId: null,
          },
        ],
        workflows: [],
        states: [],
      });

      expect(batch.incompleteFiles).toEqual([agentPath]);
      // The readable half is still ingested — a partial read costs coverage,
      // never the whole session.
      expect(batch.requests.map((r) => r.request_id)).toEqual(["req_mainC"]);
      expect(batch.anomalies.map((a) => a.kind)).toContain("read_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("C3: an unread file never becomes a watermark", () => {
    const prints = [
      { path: "/corpus/main.jsonl", inode: 11, bytes: 500, mtime: "2026-01-01T00:00:00.000Z" },
      { path: "/corpus/agent-1.jsonl", inode: 22, bytes: 9000, mtime: "2026-01-01T00:00:00.000Z" },
      { path: "/corpus/agent-2.jsonl", inode: 33, bytes: 40, mtime: "2026-01-01T00:00:00.000Z" },
    ];
    // Nothing vetoed: every file is watermarked, exactly as before the fix.
    expect(watermarkable(prints, [])).toEqual(prints);

    // The vetoed file — and ONLY it — loses its watermark, so the next sweep
    // sees `was === undefined`, cannot compute `unchanged`, and re-reads it.
    const kept = watermarkable(prints, ["/corpus/agent-1.jsonl"]);
    expect(kept.map((f) => f.path)).toEqual(["/corpus/main.jsonl", "/corpus/agent-2.jsonl"]);
  });
});

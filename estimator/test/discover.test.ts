/**
 * src/discover.ts — corpus enumeration and the §5.6 ban list.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BANNED_WF_RUN_FIELDS,
  discoverCorpus,
  NEVER_SUMMED_WF_AGENT_FIELDS,
  readJournalAgentIds,
  readWorkflowState,
  sessionFiles,
  sessionIdFromPath,
  type SessionCorpus,
} from "../src/discover.ts";

const CORPUS = join(import.meta.dir, "fixtures", "corpus", "projects");
const SESSION = "11111111-1111-4111-8111-111111111111";
const SESSION_DIR = join(CORPUS, "-Users-craig-demo", SESSION);
const STATE_PATH = join(SESSION_DIR, "workflows", "wf_demo0001-abc.json");

function onlySession(): SessionCorpus {
  const corpus = discoverCorpus(CORPUS);
  expect(corpus.sessions).toHaveLength(1);
  return corpus.sessions[0]!;
}

describe("discoverCorpus", () => {
  test("finds the main transcript, both agent kinds, and the workflow dir", () => {
    const s = onlySession();
    expect(s.sessionId).toBe(SESSION);
    expect(s.mainTranscripts).toHaveLength(1);
    expect(s.mainTranscripts[0]!.endsWith(`${SESSION}.jsonl`)).toBe(true);

    // Agent-tool sub-agents live directly under subagents/ ...
    expect(s.agents.map((a) => a.agentId)).toEqual(["abeef0000000000a1"]);
    // ... workflow agents under subagents/workflows/<runId>/.
    expect(s.workflows).toHaveLength(1);
    expect(s.workflows[0]!.runId).toBe("wf_demo0001-abc");
    expect(s.workflows[0]!.agents.map((a) => a.agentId).sort()).toEqual([
      "a1111111111111111",
      "a2222222222222222",
    ]);
    expect(s.states).toHaveLength(1);
  });

  test("ignores .wakatime sidecars, index files and non-UUID names", () => {
    const corpus = discoverCorpus(CORPUS);
    for (const path of corpus.sessions.flatMap((s) => s.mainTranscripts)) {
      expect(path.endsWith(".jsonl")).toBe(true);
      expect(path.includes(".wakatime")).toBe(false);
    }
  });

  test("reads agent meta, including the toolUseId that names the launching turn", () => {
    const s = onlySession();
    const agent = s.agents[0]!;
    expect(agent.meta?.agentType).toBe("general-purpose");
    expect(agent.meta?.toolUseId).toBe("toolu_AG1");
    expect(agent.meta?.spawnDepth).toBe(1);
    // Workflow agents get the shorter {agentType, spawnDepth, model} shape [R2].
    const wfAgent = s.workflows[0]!.agents.find((a) => a.agentId === "a1111111111111111")!;
    expect(wfAgent.meta?.toolUseId).toBeNull();
    expect(wfAgent.meta?.agentType).toBe("claude-code-guide");
  });

  test("realpath-canonicalises transcript paths and records a census", () => {
    const corpus = discoverCorpus(CORPUS);
    expect(corpus.census.sessions).toBe(1);
    expect(corpus.census.files).toBe(5); // 1 main + 2 workflow agents + 1 agent + 1 state
    expect(corpus.census.bytes).toBeGreaterThan(0);
    expect(corpus.census.oldestMtime).not.toBeNull();
  });

  test("sessionFiles enumerates every artefact the ingest reads — including states", () => {
    // ONE definition, shared with the sweeper's watermark set: a watermark that
    // covers a file nobody read is the §5.2 trap, so the two must be the same
    // function rather than two lists that happen to agree.
    const paths = sessionFiles(onlySession());
    expect(paths).toHaveLength(5); // 1 main + 2 workflow agents + 1 Agent-tool agent + 1 state
    expect(new Set(paths).size).toBe(5);
    expect(paths.filter((p) => p.endsWith(".jsonl"))).toHaveLength(4);
    expect(paths.filter((p) => p.endsWith(".json"))).toHaveLength(1);
  });

  test("an empty or missing root yields an empty corpus, never a throw", () => {
    const corpus = discoverCorpus(join(import.meta.dir, "fixtures", "does-not-exist"));
    expect(corpus.sessions).toEqual([]);
    expect(corpus.anomalies).toEqual([]);
  });
});

describe("the §5.6 ban list", () => {
  test("the fixture really does contain every banned aggregate", () => {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, unknown>;
    for (const field of BANNED_WF_RUN_FIELDS) {
      expect(raw).toHaveProperty(field);
    }
    // ...and they are the wrong numbers, which is why they are banned.
    expect(raw.agentCount).toBe(99); // 2 agents actually exist
    expect(raw.status).toBe("killed"); // one agent is still running
    expect(raw.totalTokens).toBe(12345);
  });

  test("none of them reaches a caller — enforced by allowlist construction", () => {
    const { state } = readWorkflowState(STATE_PATH);
    const keys = new Set(Object.keys(state!));
    for (const field of BANNED_WF_RUN_FIELDS) {
      expect(keys.has(field)).toBe(false);
    }
    // Serialising the whole result must not smuggle a banned value through a
    // nested object either.
    const serialised = JSON.stringify(state);
    expect(serialised).not.toContain("BANNED");
    expect(serialised).not.toContain('"agentCount"');
    expect(serialised).not.toContain('"totalTokens"');
  });

  test("names the one per-agent field that is read but never summed", () => {
    expect([...NEVER_SUMMED_WF_AGENT_FIELDS]).toEqual(["tokens"]);
  });

  test("per-agent `tokens` survives only under its audit-only name", () => {
    const { state } = readWorkflowState(STATE_PATH);
    const agent = state!.progressAgents[0]!;
    expect(agent).not.toHaveProperty("tokens");
    expect(agent.reportedTokensAuditOnly).toBe(26850);
    // `toolCalls` is neither sanctioned nor needed: not read at all.
    expect(agent).not.toHaveProperty("toolCalls");
  });
});

describe("readWorkflowState", () => {
  test("reads the sanctioned static plan", () => {
    const { state } = readWorkflowState(STATE_PATH);
    expect(state!.runId).toBe("wf_demo0001-abc");
    expect(state!.taskId).toBe("wl_launch1");
    expect(state!.workflowName).toBe("demo-flow");
    expect(state!.defaultModel).toBe("claude-sonnet-5");
    expect(state!.phases.map((p) => [p.phaseIdx, p.title])).toEqual([
      [0, "Research"],
      [1, "Synthesize"],
    ]);
  });

  test("NORMALISES the 1-based phaseIndex onto the 0-based phases[] array", () => {
    // The spec asserts "meta.phases index == workflowProgress.phaseIndex"; on this
    // machine it is off by one, and taking it literally shifts every phase join.
    const { state, anomalies } = readWorkflowState(STATE_PATH);
    const [research, synth] = state!.progressAgents;
    expect(research!.rawPhaseIndex).toBe(1);
    expect(research!.phaseIdx).toBe(0);
    expect(research!.phaseTitle).toBe("Research");
    expect(state!.phases[research!.phaseIdx!]!.title).toBe("Research");

    expect(synth!.rawPhaseIndex).toBe(2);
    expect(synth!.phaseIdx).toBe(1);
    expect(state!.phases[synth!.phaseIdx!]!.title).toBe("Synthesize");

    // A clean file produces no mismatch noise.
    expect(anomalies).toEqual([]);
  });

  test("converts epoch-ms scheduler stamps to ISO and derives endedAt", () => {
    const { state } = readWorkflowState(STATE_PATH);
    const a = state!.progressAgents[0]!;
    expect(a.queuedAt).toBe("2026-07-28T10:00:15.000Z");
    expect(a.startedAt).toBe("2026-07-28T10:00:20.000Z");
    expect(a.durationMs).toBe(100000);
    // startedAt + durationMs — the §5.3 primary interval.
    expect(a.endedAt).toBe("2026-07-28T10:02:00.000Z");
    expect(state!.progressAgents[1]!.attempt).toBe(2);
  });

  test("falls back to a title lookup and reports the mismatch when phaseIndex lies", () => {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, unknown>;
    const progress = raw.workflowProgress as Record<string, unknown>[];
    progress[2]!.phaseIndex = 42; // nonsense index, honest title
    const tmp = join(mkdtempSync(join(tmpdir(), "estimator-wf-")), "wf_mismatch.json");
    writeFileSync(tmp, JSON.stringify(raw));

    const { state, anomalies } = readWorkflowState(tmp);
    expect(state!.progressAgents[0]!.phaseIdx).toBe(0); // rescued by phaseTitle
    expect(anomalies.some((a) => a.kind === "wf_record_mismatch")).toBe(true);
    rmSync(dirname(tmp), { recursive: true, force: true });
  });

  test("an unparseable state file is an anomaly, not an exception", () => {
    const { state, anomalies } = readWorkflowState(join(import.meta.dir, "fixtures", "nope.json"));
    expect(state).toBeNull();
    expect(anomalies[0]!.kind).toBe("wf_state_unparseable");
  });
});

describe("symlinked directories (§5.1 — `Dirent.isDirectory()` lies about links)", () => {
  const RUN_ID = "wf_demo0001-abc";
  const SESSION_B = "22222222-2222-4222-8222-222222222222";
  const tmpRoots: string[] = [];

  /** A throwaway corpus root; every one is removed in afterEach. */
  function newRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "estimator-symlink-"));
    tmpRoots.push(root);
    return root;
  }

  afterEach(() => {
    for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  test("a symlinked <sessionId>/ artefact dir keeps its agents, run and state", () => {
    const root = newRoot();
    const project = join(root, "-Users-craig-demo2");
    mkdirSync(project, { recursive: true });
    symlinkSync(SESSION_DIR, join(project, SESSION_B));

    const corpus = discoverCorpus(root);
    expect(corpus.sessions).toHaveLength(1);
    const s = corpus.sessions[0]!;
    expect(s.sessionId).toBe(SESSION_B);
    // Before the fix this session had zero of all three: the whole subagents +
    // workflows + states set fell into the ".jsonl?" branch and was dropped.
    expect(s.agents).toHaveLength(1);
    expect(s.workflows).toHaveLength(1);
    expect(s.workflows[0]!.agents).toHaveLength(2);
    expect(s.states).toHaveLength(1);
  });

  test("a symlinked run directory is followed, not skipped", () => {
    const root = newRoot();
    const wfRoot = join(root, "-p", SESSION_B, "subagents", "workflows");
    mkdirSync(wfRoot, { recursive: true });
    symlinkSync(join(SESSION_DIR, "subagents", "workflows", RUN_ID), join(wfRoot, RUN_ID));

    const s = discoverCorpus(root).sessions[0]!;
    expect(s.workflows).toHaveLength(1);
    expect(s.workflows[0]!.runId).toBe(RUN_ID);
    expect(s.workflows[0]!.agents.map((a) => a.agentId).sort()).toEqual([
      "a1111111111111111",
      "a2222222222222222",
    ]);
    // The journal comes from the link target too.
    expect(s.workflows[0]!.journalAgentIds).toHaveLength(3);
  });

  test("a DANGLING run-directory link is loud, never silent (§2)", () => {
    const root = newRoot();
    const wfRoot = join(root, "-p", SESSION_B, "subagents", "workflows");
    mkdirSync(wfRoot, { recursive: true });
    symlinkSync(join(root, "gone-forever"), join(wfRoot, RUN_ID));

    const corpus = discoverCorpus(root);
    expect(corpus.sessions[0]!.workflows).toEqual([]);
    const dangling = corpus.anomalies.filter((a) => a.kind === "dangling_symlink");
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.detail).toContain(RUN_ID);
  });

  test("a DANGLING <sessionId>/ link is loud too", () => {
    const root = newRoot();
    const project = join(root, "-p");
    mkdirSync(project, { recursive: true });
    symlinkSync(join(root, "gone-forever"), join(project, SESSION_B));

    const corpus = discoverCorpus(root);
    expect(corpus.anomalies.some((a) => a.kind === "dangling_symlink")).toBe(true);
  });

  test("the census counts a shared run directory ONCE, not once per session", () => {
    const root = newRoot();
    const project = join(root, "-Users-craig-demo2");
    mkdirSync(project, { recursive: true });
    symlinkSync(SESSION_DIR, join(project, SESSION_B));
    // Two sessions, one physical artefact set: files must not double.
    const solo = discoverCorpus(root).census.files;
    symlinkSync(SESSION_DIR, join(project, "33333333-3333-4333-8333-333333333333"));
    const corpus = discoverCorpus(root);
    expect(corpus.sessions).toHaveLength(2);
    expect(corpus.census.files).toBe(solo);
  });
});

describe("journal cross-check (§5.1 — the journal wins)", () => {
  test("reads agentIds out of journal.jsonl", () => {
    const ids = readJournalAgentIds(
      join(SESSION_DIR, "subagents", "workflows", "wf_demo0001-abc", "journal.jsonl"),
    );
    expect(ids.sort()).toEqual([
      "a1111111111111111",
      "a2222222222222222",
      "a3333333333333333",
    ]);
  });

  test("an agent in the journal but missing from workflowProgress is reported", () => {
    const corpus = discoverCorpus(CORPUS);
    const mismatch = corpus.anomalies.find(
      (a) => a.kind === "wf_record_mismatch" && a.detail.includes("a3333333333333333"),
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.detail).toContain("journal wins");
  });
});

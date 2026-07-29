#!/usr/bin/env bun
/**
 * G-FORK — Phase 0 hard gate (design R3 §5.2, §8).
 *
 * Question: does `requestId` recur ACROSS sessions? The design's global
 * `request_id` primary key exists solely to collapse "fork replays" — the `[J]`
 * observation (n=1 session pair, 9 requests, 50 shared uuids) that forking a
 * session mints a new sessionId replaying the parent's history with
 * byte-identical requestIds. That PK is the least reversible decision in the
 * design; if the observation does not replicate, the key narrows to
 * `(session_id, request_id)`.
 *
 * This script is READ-ONLY over ~/.claude/projects and writes nothing. It:
 *   1. streams every transcript (main, Agent-tool subagent, workflow agent),
 *   2. indexes requestId -> files and uuid -> files corpus-wide,
 *   3. classifies every multi-file requestId as fork_replay / collision /
 *      same_session_copy / other,
 *   4. runs the proposed leading-uuid-prefix fork detector independently and
 *      scores it (precision/recall) against the requestId-overlap ground truth.
 *
 * Usage:  bun gates/g-fork.ts [--json <path>]
 */

import { discoverCorpus, type Corpus } from "../src/discover.ts";
import { readJsonl } from "../src/ingest.ts";

// ---------------------------------------------------------------------------
// per-file record
// ---------------------------------------------------------------------------

type Origin = "main" | "agent" | "wf_agent";

interface RequestObs {
  /** message.id values seen on this requestId in this file. */
  msgIds: Set<string>;
  models: Set<string>;
  /** line uuids carrying this requestId in this file. */
  uuids: string[];
  firstTs: string | null;
  lastTs: string | null;
  lines: number;
  /** MAX per counter within this file — the design's dedup rule (§5.2). */
  maxOut: number;
  maxCw: number;
  maxIn: number;
  maxCr: number;
}

interface FileRec {
  idx: number;
  path: string;
  /** sessionId as derived from the path (the DB's session grain). */
  fileSession: string;
  origin: Origin;
  agentId: string | null;
  runId: string | null;
  projectDir: string;
  /** distinct `sessionId` values written INSIDE the file. */
  lineSessions: Set<string>;
  /** every line uuid, in file order. */
  uuids: string[];
  requests: Map<string, RequestObs>;
  lines: number;
  malformed: number;
}

const shortPath = (p: string): string => p.replace(`${process.env.HOME}/.claude/projects/`, "");

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function scanFile(rec: FileRec): Promise<void> {
  const res = await readJsonl(rec.path, (raw) => {
    const line = JSON.parse(raw) as Record<string, unknown>;
    rec.lines += 1;

    const uuid = str(line.uuid);
    if (uuid !== null) rec.uuids.push(uuid);

    const ls = str(line.sessionId) ?? str(line.session_id);
    if (ls !== null) rec.lineSessions.add(ls);

    const rid = str(line.requestId);
    if (rid === null) return;

    const message = (line.message ?? null) as Record<string, unknown> | null;
    const usage = (message?.usage ?? line.usage ?? null) as Record<string, unknown> | null;

    let obs = rec.requests.get(rid);
    if (obs === undefined) {
      obs = {
        msgIds: new Set(),
        models: new Set(),
        uuids: [],
        firstTs: null,
        lastTs: null,
        lines: 0,
        maxOut: 0,
        maxCw: 0,
        maxIn: 0,
        maxCr: 0,
      };
      rec.requests.set(rid, obs);
    }
    obs.lines += 1;
    const mid = str(message?.id);
    if (mid !== null) obs.msgIds.add(mid);
    const model = str(message?.model);
    if (model !== null) obs.models.add(model);
    if (uuid !== null) obs.uuids.push(uuid);
    const ts = str(line.timestamp);
    if (ts !== null) {
      if (obs.firstTs === null || ts < obs.firstTs) obs.firstTs = ts;
      if (obs.lastTs === null || ts > obs.lastTs) obs.lastTs = ts;
    }
    if (usage !== null) {
      const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      obs.maxOut = Math.max(obs.maxOut, n(usage.output_tokens));
      obs.maxCw = Math.max(obs.maxCw, n(usage.cache_creation_input_tokens));
      obs.maxIn = Math.max(obs.maxIn, n(usage.input_tokens));
      obs.maxCr = Math.max(obs.maxCr, n(usage.cache_read_input_tokens));
    }
  });
  rec.malformed = res.stats.malformed + res.stats.truncatedTail;
}

// ---------------------------------------------------------------------------
// corpus enumeration
// ---------------------------------------------------------------------------

function enumerateFiles(corpus: Corpus): FileRec[] {
  const out: FileRec[] = [];
  const push = (
    path: string,
    fileSession: string,
    origin: Origin,
    agentId: string | null,
    runId: string | null,
    projectDir: string,
  ): void => {
    out.push({
      idx: out.length,
      path,
      fileSession,
      origin,
      agentId,
      runId,
      projectDir,
      lineSessions: new Set(),
      uuids: [],
      requests: new Map(),
      lines: 0,
      malformed: 0,
    });
  };

  for (const s of corpus.sessions) {
    const pd = s.projectDirs[0] ?? "";
    for (const m of s.mainTranscripts) push(m, s.sessionId, "main", null, null, pd);
    for (const a of s.agents) push(a.transcriptPath, s.sessionId, "agent", a.agentId, null, pd);
    for (const wf of s.workflows) {
      for (const a of wf.agents) {
        push(a.transcriptPath, s.sessionId, "wf_agent", a.agentId, wf.runId, pd);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

/**
 * `symlink_alias` — ONE physical file reachable from two session dirs (the child
 * session symlinks the parent's still-running subagent transcript into its own
 * `subagents/`). Not a replay at all: the same bytes, counted twice by any key
 * that carries session_id.
 * `fork_replay`  — two distinct files, shared uuids, and every shared requestId
 * carries the SAME message.id: the identical billed API call written twice.
 * `collision`    — same requestId, no shared uuids, different message.id: two
 * genuinely distinct API calls that happen to share an id (~1/16k `[CA]`).
 */
type Verdict = "fork_replay" | "collision" | "symlink_alias" | "same_session_copy" | "other";

/** WHERE the replayed region sits — this is what the R3 detector assumes. */
type Shape = "leading_prefix" | "tail_into_head" | "scattered" | "none";

interface PairFinding {
  a: number;
  b: number;
  /** requestIds shared by exactly this file pair. */
  rids: string[];
  sharedUuids: number;
  /** length of the common LEADING uuid prefix — the R3 detector's raw signal. */
  prefixLen: number;
  /** order-tolerant variant: |set(A[0..W]) ∩ set(B[0..W])| / W over a 64-uuid window. */
  windowJaccard: number;
  shape: Shape;
  crossSession: boolean;
  msgIdAgree: number;
  msgIdDisagree: number;
  verdict: Verdict;
  /** Work-CET tokens (out + cache_creation) that a narrow key would count twice. */
  dupOut: number;
  dupCw: number;
}

function commonPrefixLen(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/** Order-tolerant leading-window overlap. Transcript writers reorder adjacent
 *  lines nondeterministically, which a strict positional prefix mistakes for
 *  divergence (observed: one real fork pair truncates at 17 of ~300). */
const WINDOW = 64;
function windowOverlap(a: string[], b: string[]): number {
  const w = Math.min(WINDOW, a.length, b.length);
  if (w === 0) return 0;
  const sa = new Set(a.slice(0, w));
  let hit = 0;
  for (const u of b.slice(0, w)) if (sa.has(u)) hit += 1;
  return hit / w;
}

/** Index of the first/last shared uuid in a file's uuid sequence, as a fraction. */
function span(uuids: string[], shared: Set<string>): { first: number; last: number } {
  let first = -1;
  let last = -1;
  for (let i = 0; i < uuids.length; i += 1) {
    if (!shared.has(uuids[i]!)) continue;
    if (first < 0) first = i;
    last = i;
  }
  const n = Math.max(uuids.length - 1, 1);
  return { first: first < 0 ? -1 : first / n, last: last < 0 ? -1 : last / n };
}

function classifyShape(fa: FileRec, fb: FileRec, shared: Set<string>): Shape {
  if (shared.size === 0) return "none";
  const sa = span(fa.uuids, shared);
  const sb = span(fb.uuids, shared);
  // Both replays start near the head of their file => rewind/branch fork.
  if (sa.first < 0.05 && sb.first < 0.05) return "leading_prefix";
  // One file's TAIL reproduced at the other file's HEAD => post-/compact
  // continuation: the surviving context window is rewritten into a new session.
  if ((sa.last > 0.9 && sb.first < 0.1) || (sb.last > 0.9 && sa.first < 0.1)) {
    return "tail_into_head";
  }
  return "scattered";
}

function classify(
  fa: FileRec,
  fb: FileRec,
  rids: string[],
  sharedUuidSet: Set<string>,
): PairFinding {
  let msgIdAgree = 0;
  let msgIdDisagree = 0;
  let dupOut = 0;
  let dupCw = 0;
  for (const rid of rids) {
    const oa = fa.requests.get(rid)!;
    const ob = fb.requests.get(rid)!;
    if ([...oa.msgIds].some((m) => ob.msgIds.has(m))) msgIdAgree += 1;
    else msgIdDisagree += 1;
    // A narrow (session_id, request_id) key keeps both rows; a global key keeps
    // one. The double-count is therefore the SMALLER of the two per-file maxima.
    dupOut += Math.min(oa.maxOut, ob.maxOut);
    dupCw += Math.min(oa.maxCw, ob.maxCw);
  }

  const crossSession = fa.fileSession !== fb.fileSession;
  const sameFile = fa.path === fb.path;

  let verdict: Verdict;
  if (sameFile) verdict = "symlink_alias";
  else if (!crossSession) verdict = "same_session_copy";
  else if (sharedUuidSet.size === 0 && msgIdAgree === 0) verdict = "collision";
  else if (msgIdDisagree === 0) verdict = "fork_replay";
  else verdict = "other";

  return {
    a: fa.idx,
    b: fb.idx,
    rids,
    sharedUuids: sharedUuidSet.size,
    prefixLen: sameFile ? fa.uuids.length : commonPrefixLen(fa.uuids, fb.uuids),
    windowJaccard: sameFile ? 1 : windowOverlap(fa.uuids, fb.uuids),
    shape: sameFile ? "leading_prefix" : classifyShape(fa, fb, sharedUuidSet),
    crossSession,
    msgIdAgree,
    msgIdDisagree,
    verdict,
    dupOut,
    dupCw,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const t0 = Date.now();
const corpus = discoverCorpus();
const files = enumerateFiles(corpus);

// bounded concurrency — 1.7k small files, no need to melt the fd table
const CONC = 24;
let cursor = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      await scanFile(files[i]!);
    }
  }),
);

// --- index requestId -> files ------------------------------------------------
const ridToFiles = new Map<string, number[]>();
let totalRequestObs = 0;
for (const f of files) {
  for (const rid of f.requests.keys()) {
    totalRequestObs += 1;
    const arr = ridToFiles.get(rid);
    if (arr === undefined) ridToFiles.set(rid, [f.idx]);
    else arr.push(f.idx);
  }
}

// --- index uuid -> files (full recall, independent of requestId) -------------
const uuidToFiles = new Map<string, number[]>();
for (const f of files) {
  const seen = new Set<string>();
  for (const u of f.uuids) {
    if (seen.has(u)) continue;
    seen.add(u);
    const arr = uuidToFiles.get(u);
    if (arr === undefined) uuidToFiles.set(u, [f.idx]);
    else arr.push(f.idx);
  }
}

// --- multi-file requestIds, grouped by file pair -----------------------------
const pairKey = (a: number, b: number): string => `${a}|${b}`;
const pairRids = new Map<string, string[]>();
const multiFileRids: string[] = [];
for (const [rid, idxs] of ridToFiles) {
  if (idxs.length < 2) continue;
  multiFileRids.push(rid);
  for (let i = 0; i < idxs.length; i += 1) {
    for (let j = i + 1; j < idxs.length; j += 1) {
      const a = Math.min(idxs[i]!, idxs[j]!);
      const b = Math.max(idxs[i]!, idxs[j]!);
      const k = pairKey(a, b);
      const arr = pairRids.get(k);
      if (arr === undefined) pairRids.set(k, [rid]);
      else arr.push(rid);
    }
  }
}

// --- shared-uuid file pairs (fork evidence, requestId-independent) -----------
const pairUuids = new Map<string, Set<string>>();
for (const [uuid, idxs] of uuidToFiles) {
  if (idxs.length < 2) continue;
  for (let i = 0; i < idxs.length; i += 1) {
    for (let j = i + 1; j < idxs.length; j += 1) {
      const a = Math.min(idxs[i]!, idxs[j]!);
      const b = Math.max(idxs[i]!, idxs[j]!);
      const k = pairKey(a, b);
      let s = pairUuids.get(k);
      if (s === undefined) {
        s = new Set();
        pairUuids.set(k, s);
      }
      s.add(uuid);
    }
  }
}

// --- classify every requestId-overlapping pair -------------------------------
const findings: PairFinding[] = [];
for (const [k, rids] of pairRids) {
  const [a, b] = k.split("|").map(Number) as [number, number];
  findings.push(classify(files[a]!, files[b]!, rids, pairUuids.get(k) ?? new Set()));
}
findings.sort((x, y) => y.rids.length - x.rids.length);

// --- DETECTOR VALIDATION -----------------------------------------------------
// Ground truth is NOT the shape classification (that would be circular): it is
// "distinct files, different sessions, sharing >=1 requestId" — measured from
// requestIds alone, with no uuid input. Three candidate detectors, each run with
// the index a real sweeper would build, and scored against it.
//
//  D1  R3 as written — group files by uuids[0], require a positional common
//      leading prefix.
//  D2  order-tolerant — group files sharing ANY of their first 64 uuids.
//  D3  any shared uuid anywhere (one global uuid->files hash pass).
const groundTruth = new Set(
  findings
    .filter((f) => f.crossSession && f.verdict !== "symlink_alias" && f.rids.length > 0)
    .map((f) => pairKey(f.a, f.b)),
);
const gtRidCount = new Map<string, number>();
for (const f of findings) gtRidCount.set(pairKey(f.a, f.b), f.rids.length);

/** Turn an index (key -> file idxs) into the set of candidate pairs it yields. */
function pairsFromIndex(index: Map<string, number[]>): Set<string> {
  const out = new Set<string>();
  for (const idxs of index.values()) {
    if (idxs.length < 2) continue;
    for (let i = 0; i < idxs.length; i += 1) {
      for (let j = i + 1; j < idxs.length; j += 1) {
        const a = Math.min(idxs[i]!, idxs[j]!);
        const b = Math.max(idxs[i]!, idxs[j]!);
        if (files[a]!.path === files[b]!.path) continue; // symlink alias, not a replay
        out.add(pairKey(a, b));
      }
    }
  }
  return out;
}

const byFirstUuid = new Map<string, number[]>();
const byLeadingWindow = new Map<string, number[]>();
for (const f of files) {
  const first = f.uuids[0];
  if (first !== undefined) {
    const arr = byFirstUuid.get(first);
    if (arr === undefined) byFirstUuid.set(first, [f.idx]);
    else arr.push(f.idx);
  }
  for (const u of new Set(f.uuids.slice(0, WINDOW))) {
    const arr = byLeadingWindow.get(u);
    if (arr === undefined) byLeadingWindow.set(u, [f.idx]);
    else arr.push(f.idx);
  }
}

const d1Cand = pairsFromIndex(byFirstUuid);
const d1 = new Set([...d1Cand].filter((k) => {
  const [a, b] = k.split("|").map(Number) as [number, number];
  return commonPrefixLen(files[a]!.uuids, files[b]!.uuids) > 0;
}));
const d2Cand = pairsFromIndex(byLeadingWindow);
const d2 = new Set([...d2Cand].filter((k) => {
  const [a, b] = k.split("|").map(Number) as [number, number];
  return windowOverlap(files[a]!.uuids, files[b]!.uuids) >= 0.5;
}));
const d3 = pairsFromIndex(uuidToFiles);

function score(name: string, hits: Set<string>) {
  const tp = [...hits].filter((k) => groundTruth.has(k));
  const fp = [...hits].filter((k) => !groundTruth.has(k));
  const fn = [...groundTruth].filter((k) => !hits.has(k));
  const ridsOf = (ks: string[]): number => ks.reduce((n, k) => n + (gtRidCount.get(k) ?? 0), 0);
  return {
    detector: name,
    flaggedPairs: hits.size,
    truePositives: tp.length,
    falsePositives: fp.length,
    falseNegatives: fn.length,
    precision: hits.size === 0 ? null : tp.length / hits.size,
    recallByPair: groundTruth.size === 0 ? null : tp.length / groundTruth.size,
    /** the number that matters: share of double-counted REQUESTS caught. */
    recallByRequest: ridsOf([...groundTruth]) === 0 ? null : ridsOf(tp) / ridsOf([...groundTruth]),
    missedRequests: ridsOf(fn),
    missedPairs: fn.map((k) => {
      const [a, b] = k.split("|").map(Number) as [number, number];
      return {
        a: shortPath(files[a]!.path),
        b: shortPath(files[b]!.path),
        sharedRequestIds: gtRidCount.get(k) ?? 0,
      };
    }),
  };
}

const detectorScores = [
  score("D1 leading-uuid-prefix (R3 as written)", d1),
  score("D2 leading-64-uuid window >=50% (order-tolerant)", d2),
  score("D3 any shared uuid (global uuid index)", d3),
];

// --- cost impact: what a narrow (session_id, request_id) key double-counts ----
let corpusOut = 0;
let corpusCw = 0;
{
  // Global-key totals: MAX per counter per requestId across all files.
  const maxOut = new Map<string, number>();
  const maxCw = new Map<string, number>();
  for (const f of files) {
    for (const [rid, o] of f.requests) {
      maxOut.set(rid, Math.max(maxOut.get(rid) ?? 0, o.maxOut));
      maxCw.set(rid, Math.max(maxCw.get(rid) ?? 0, o.maxCw));
    }
  }
  for (const v of maxOut.values()) corpusOut += v;
  for (const v of maxCw.values()) corpusCw += v;
}
const dupOutTotal = findings.reduce((n, f) => n + f.dupOut, 0);
const dupCwTotal = findings.reduce((n, f) => n + f.dupCw, 0);

// --- line-sessionId disagreement (an independent fork/copy signature) --------
const sessionMismatch = files.filter(
  (f) => f.origin === "main" && f.lineSessions.size > 0 && !f.lineSessions.has(f.fileSession),
);
const multiSessionFiles = files.filter((f) => f.lineSessions.size > 1);

// --- same-session duplicate main transcripts (multi-project-dir copies) ------
const dupMain = corpus.sessions.filter((s) => s.mainTranscripts.length > 1);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const counts: Record<Verdict, number> = {
  fork_replay: 0,
  collision: 0,
  symlink_alias: 0,
  same_session_copy: 0,
  other: 0,
};
for (const f of findings) counts[f.verdict] += 1;

const crossSessionRids = new Set<string>();
for (const f of findings) if (f.crossSession) for (const r of f.rids) crossSessionRids.add(r);

const report = {
  generatedAt: new Date().toISOString(),
  elapsedMs: Date.now() - t0,
  corpus: {
    root: corpus.root,
    sessions: corpus.census.sessions,
    files: files.length,
    filesByOrigin: {
      main: files.filter((f) => f.origin === "main").length,
      agent: files.filter((f) => f.origin === "agent").length,
      wf_agent: files.filter((f) => f.origin === "wf_agent").length,
    },
    lines: files.reduce((n, f) => n + f.lines, 0),
    malformedOrTruncated: files.reduce((n, f) => n + f.malformed, 0),
    discoveryAnomalies: corpus.anomalies.length,
    emptyFiles: files.filter((f) => f.lines === 0).length,
  },
  requests: {
    distinctRequestIds: ridToFiles.size,
    perFileObservations: totalRequestObs,
    multiFileRequestIds: multiFileRids.length,
    crossSessionRequestIds: crossSessionRids.size,
    crossSessionRatePpm: ridToFiles.size === 0 ? 0 : (crossSessionRids.size / ridToFiles.size) * 1e6,
  },
  uuids: {
    distinct: uuidToFiles.size,
    sharedAcrossFiles: [...uuidToFiles.values()].filter((v) => v.length > 1).length,
    filePairsSharingUuids: pairUuids.size,
  },
  overlapPairs: {
    total: findings.length,
    ...counts,
    crossSessionPairs: findings.filter((f) => f.crossSession).length,
    byShape: findings.reduce<Record<string, number>>((m, f) => {
      m[f.shape] = (m[f.shape] ?? 0) + 1;
      return m;
    }, {}),
  },
  costImpact: {
    note: "Work-CET counters a narrow (session_id, request_id) key would count twice",
    corpusOutputTokens: corpusOut,
    corpusCacheCreationTokens: corpusCw,
    doubleCountedOutputTokens: dupOutTotal,
    doubleCountedCacheCreationTokens: dupCwTotal,
    doubleCountedPctOutput: corpusOut === 0 ? 0 : (dupOutTotal / corpusOut) * 100,
    doubleCountedPctCacheCreation: corpusCw === 0 ? 0 : (dupCwTotal / corpusCw) * 100,
    doubleCountedPctUnweighted:
      corpusOut + corpusCw === 0 ? 0 : ((dupOutTotal + dupCwTotal) / (corpusOut + corpusCw)) * 100,
  },
  detectors: detectorScores,
  signals: {
    mainFilesWhoseLineSessionIdDiffersFromFilename: sessionMismatch.map((f) => ({
      path: shortPath(f.path),
      fileSession: f.fileSession,
      lineSessions: [...f.lineSessions],
    })),
    filesWithMultipleLineSessionIds: multiSessionFiles.map((f) => ({
      path: shortPath(f.path),
      lineSessions: [...f.lineSessions],
    })),
    sessionsWithMultipleMainTranscripts: dupMain.map((s) => ({
      sessionId: s.sessionId,
      paths: s.mainTranscripts.map(shortPath),
    })),
  },
  findings: findings.slice(0, 40).map((f) => ({
    verdict: f.verdict,
    shape: f.shape,
    crossSession: f.crossSession,
    a: shortPath(files[f.a]!.path),
    b: shortPath(files[f.b]!.path),
    sessionA: files[f.a]!.fileSession,
    sessionB: files[f.b]!.fileSession,
    originA: files[f.a]!.origin,
    originB: files[f.b]!.origin,
    sharedRequestIds: f.rids.length,
    sampleRids: f.rids.slice(0, 3),
    sharedUuids: f.sharedUuids,
    strictLeadingPrefixLen: f.prefixLen,
    leadingWindowOverlap: Number(f.windowJaccard.toFixed(3)),
    msgIdAgree: f.msgIdAgree,
    msgIdDisagree: f.msgIdDisagree,
    dupOutputTokens: f.dupOut,
    dupCacheCreationTokens: f.dupCw,
  })),
};

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag >= 0 && process.argv[jsonFlag + 1] !== undefined) {
  await Bun.write(process.argv[jsonFlag + 1]!, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));

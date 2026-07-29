#!/usr/bin/env bun
/**
 * G-FORK probe — anatomy of one overlapping file pair.
 *
 * `g-fork.ts` says WHICH pairs overlap; this says HOW. For a pair it prints the
 * positional layout of the shared uuids in each file (are they a leading block?
 * a block at an offset? scattered?), the first divergent line, and the
 * compaction / sessionId / timestamp context that names the mechanism.
 *
 * Usage:  bun gates/g-fork-probe.ts <fileA.jsonl> <fileB.jsonl>
 */

import { readJsonl } from "../src/ingest.ts";

interface L {
  i: number;
  uuid: string | null;
  parentUuid: string | null;
  type: string | null;
  sessionId: string | null;
  requestId: string | null;
  msgId: string | null;
  ts: string | null;
  isCompactSummary: boolean;
  isSidechain: boolean;
  subtype: string | null;
  preview: string;
}

function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function load(path: string): Promise<L[]> {
  const out: L[] = [];
  await readJsonl(path, (raw) => {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const msg = (o.message ?? null) as Record<string, unknown> | null;
    let preview = "";
    const c = msg?.content;
    if (typeof c === "string") preview = c.slice(0, 90);
    else if (Array.isArray(c)) {
      const first = c[0] as Record<string, unknown> | undefined;
      preview = `[${String(first?.type)}] ${String(first?.text ?? first?.name ?? "").slice(0, 80)}`;
    }
    out.push({
      i: out.length,
      uuid: s(o.uuid),
      parentUuid: s(o.parentUuid),
      type: s(o.type),
      sessionId: s(o.sessionId) ?? s(o.session_id),
      requestId: s(o.requestId),
      msgId: s(msg?.id),
      ts: s(o.timestamp),
      isCompactSummary: o.isCompactSummary === true,
      isSidechain: o.isSidechain === true,
      subtype: s(o.subtype),
      preview: preview.replace(/\s+/g, " "),
    });
  });
  return out;
}

/** Longest run of consecutive indices, and how the shared set is distributed. */
function layout(lines: L[], shared: Set<string>): {
  count: number;
  firstIdx: number;
  lastIdx: number;
  blocks: [number, number][];
} {
  const hit = lines.map((l) => l.uuid !== null && shared.has(l.uuid));
  const blocks: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= hit.length; i += 1) {
    if (i < hit.length && hit[i] === true) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      blocks.push([start, i - 1]);
      start = -1;
    }
  }
  const idxs = hit.flatMap((h, i) => (h ? [i] : []));
  return {
    count: idxs.length,
    firstIdx: idxs[0] ?? -1,
    lastIdx: idxs[idxs.length - 1] ?? -1,
    blocks,
  };
}

const [pa, pb] = process.argv.slice(2);
if (pa === undefined || pb === undefined) {
  console.error("usage: bun gates/g-fork-probe.ts <a.jsonl> <b.jsonl>");
  process.exit(2);
}

const A = await load(pa);
const B = await load(pb);
const ua = new Set(A.map((l) => l.uuid).filter((u): u is string => u !== null));
const ub = new Set(B.map((l) => l.uuid).filter((u): u is string => u !== null));
const shared = new Set([...ua].filter((u) => ub.has(u)));

const la = layout(A, shared);
const lb = layout(B, shared);

const short = (p: string): string => p.split("/").slice(-1)[0]!;

const summarise = (name: string, L: L[], lay: ReturnType<typeof layout>) => ({
  file: short(name),
  lines: L.length,
  firstTs: L[0]?.ts ?? null,
  lastTs: L[L.length - 1]?.ts ?? null,
  sessionIds: [...new Set(L.map((l) => l.sessionId).filter((x) => x !== null))],
  compactSummaryLines: L.filter((l) => l.isCompactSummary).length,
  sharedUuidCount: lay.count,
  sharedFirstIdx: lay.firstIdx,
  sharedLastIdx: lay.lastIdx,
  sharedBlocks: lay.blocks.length,
  largestBlock: lay.blocks.reduce((m, [x, y]) => Math.max(m, y - x + 1), 0),
  blockPreview: lay.blocks.slice(0, 6),
  isLeadingBlock: lay.firstIdx === 0,
});

// first line of B that is NOT shared, and its context
const firstDivergentB = B.find((l) => l.uuid === null || !shared.has(l.uuid));
const lastSharedB = [...B].reverse().find((l) => l.uuid !== null && shared.has(l.uuid));
const firstDivergentA = A.find((l) => l.uuid === null || !shared.has(l.uuid));

// do the shared uuids sit in the SAME order in both files?
const orderA = A.filter((l) => l.uuid !== null && shared.has(l.uuid)).map((l) => l.uuid);
const orderB = B.filter((l) => l.uuid !== null && shared.has(l.uuid)).map((l) => l.uuid);
const sameOrder = orderA.length === orderB.length && orderA.every((u, i) => u === orderB[i]);

// does B's leading uuid appear anywhere in A?
const bFirstInA = B[0]?.uuid !== undefined && B[0].uuid !== null ? A.findIndex((l) => l.uuid === B[0]!.uuid) : -1;
const aFirstInB = A[0]?.uuid !== undefined && A[0].uuid !== null ? B.findIndex((l) => l.uuid === A[0]!.uuid) : -1;

console.log(
  JSON.stringify(
    {
      A: summarise(pa, A, la),
      B: summarise(pb, B, lb),
      sharedUuids: shared.size,
      sharedInSameRelativeOrder: sameOrder,
      indexOfBFirstUuidInA: bFirstInA,
      indexOfAFirstUuidInB: aFirstInB,
      firstLineOfA: A[0] === undefined ? null : { i: 0, type: A[0].type, ts: A[0].ts, isCompactSummary: A[0].isCompactSummary, preview: A[0].preview },
      firstLineOfB: B[0] === undefined ? null : { i: 0, type: B[0].type, ts: B[0].ts, isCompactSummary: B[0].isCompactSummary, preview: B[0].preview },
      firstDivergentInA: firstDivergentA === undefined ? null : { i: firstDivergentA.i, type: firstDivergentA.type, ts: firstDivergentA.ts, preview: firstDivergentA.preview },
      lastSharedInB: lastSharedB === undefined ? null : { i: lastSharedB.i, type: lastSharedB.type, ts: lastSharedB.ts, preview: lastSharedB.preview },
      firstDivergentInB: firstDivergentB === undefined ? null : { i: firstDivergentB.i, type: firstDivergentB.type, ts: firstDivergentB.ts, isCompactSummary: firstDivergentB.isCompactSummary, preview: firstDivergentB.preview },
    },
    null,
    2,
  ),
);

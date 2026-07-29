/**
 * G-ATTR — Phase 0 pre-build gate (design R3 §1.1, §5.4, §8).
 *
 * Question: is sticky last-touched attribution feasible on the REAL corpus?
 * Threshold: `exclusive ∪ sticky` token coverage < 70% ⇒ escalate before Phase 1.
 *
 * This is NOT a re-run of the original `attr2.py` probe. That probe measured at
 * REQUEST grain, counted `ambiguous` inside its headline "coverage" figure, and
 * silently dropped every session that contained no task events. This script
 * reimplements the measurement against the R3 §5.3–§5.4 definitions:
 *
 *   - TURN grain. The attribution unit is one main-transcript turn
 *     (session_id, promptId); §5.4's rules are stated "per main-transcript turn".
 *   - Sub-agent tokens inherit their LAUNCHING TURN's class (§5.3), which is
 *     what makes the measurement meaningful at all — sub-agents are ~79% of
 *     spend, and `attr2.py` never opened a single sub-agent transcript.
 *   - "Touched" includes TaskCreate, not just TaskUpdate statusChanges (§5.4).
 *   - "Open" is R3's "open tracked task": created and not yet completed/deleted.
 *     The original probe's in_progress-only definition is kept as a variant,
 *     because §1.1 records that 46.7% of completions skip `in_progress`.
 *   - Coverage = exclusive ∪ sticky ONLY. `ambiguous` and `pre_task` are
 *     residuals, per §5.4's "the 17.2% residual is a named number".
 *   - Dedup is MAX per (request_id, counter) (§5.2) plus the message_id
 *     sidechain-replay pass. Getting this wrong is an 8.4–18.3× undercount.
 *
 * Read-only on the corpus. Writes nothing but its own stdout/JSON.
 *
 * Usage:  bun run gates/g-attr.ts [--json out.json] [--limit N]
 */

import { discoverCorpus, type SessionCorpus } from "../src/discover.ts";
import { ingestSession, readJsonl, type RequestRow } from "../src/ingest.ts";
// `TranscriptLine` is declared in segment.ts; ingest.ts only imports it, so
// sourcing it from there compiled by luck and stopped when the re-export went.
import { TurnSegmenter, type TranscriptLine } from "../src/segment.ts";

// ---------------------------------------------------------------------------
// currencies
// ---------------------------------------------------------------------------

/**
 * Work-CET is price-weighted (§4.1), but this corpus is dominated by model ids
 * that no public price table carries (`claude-fable-5`, `claude-sonnet-5`,
 * `claude-opus-5`, `claude-opus-4-8`), so a weighted headline here would be
 * mostly invented. Coverage is a SHARE, and a share only moves under
 * reweighting if the attribution class correlates with the model mix — so the
 * headline is the unweighted Work-CET counter pair, and the per-family class
 * breakdown printed at the end is what tests the reweighting sensitivity
 * directly.
 */
const CURRENCIES = {
  wcet_unweighted: (r: Counters) => r.out + r.cw,
  attr2_in_out_cw: (r: Counters) => r.in + r.out + r.cw,
  out_only: (r: Counters) => r.out,
  requests: () => 1,
} as const;

type CurrencyName = keyof typeof CURRENCIES;
const CURRENCY_NAMES = Object.keys(CURRENCIES) as CurrencyName[];

interface Counters {
  in: number;
  out: number;
  cw: number;
  cr: number;
}

/** One deduped request, compacted down to what the gate actually needs. */
interface Req extends Counters {
  request_id: string;
  message_id: string | null;
  is_sidechain: number;
  session_id: string;
  prompt_id: string | null;
  origin: string;
  model_family: string;
  attribution_skill: string | null;
  replay: boolean;
}

// ---------------------------------------------------------------------------
// task events — the §5.4 "touch" stream
// ---------------------------------------------------------------------------

type TaskEventKind = "create" | "status" | "touch";

interface TaskEvent {
  ts: string;
  taskId: string;
  kind: TaskEventKind;
  to: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Second, cheap pass over ONE main transcript for task lifecycle events and turn
 * starts. Main transcripts are the small half of the corpus (sub-agent files
 * dominate the bytes), so re-reading them rather than threading a new field
 * through `ingest.ts` costs little and keeps the gate from touching shipped code.
 *
 * Shapes verified live on this corpus:
 *   TaskCreate → toolUseResult.task = {id, subject}
 *   TaskUpdate → toolUseResult = {success, taskId, updatedFields, statusChange:{from,to}}
 *   TaskUpdate with no status edit → same, minus `statusChange` (a touch, not a transition)
 */
async function readTaskStream(
  path: string,
): Promise<{ events: TaskEvent[]; turnStarts: Map<string, string> }> {
  const events: TaskEvent[] = [];
  const turnStarts = new Map<string, string>();
  const seg = new TurnSegmenter(null);

  await readJsonl(path, (raw) => {
    const line = JSON.parse(raw) as TranscriptLine;
    seg.push(line);

    const ts = str(line.timestamp);
    if (ts === null) return;

    const promptId = seg.currentPromptId;
    if (promptId !== null) {
      const prev = turnStarts.get(promptId);
      if (prev === undefined || ts < prev) turnStarts.set(promptId, ts);
    }

    if (line.type !== "user") return;
    const tur = line.toolUseResult;
    if (tur === null || typeof tur !== "object") return;
    const r = tur as Record<string, unknown>;

    const task = r.task;
    if (task !== null && typeof task === "object") {
      const id = str((task as Record<string, unknown>).id);
      if (id !== null) {
        events.push({ ts, taskId: id, kind: "create", to: "pending" });
        return;
      }
    }

    const sc = r.statusChange;
    if (sc !== null && typeof sc === "object") {
      const s = sc as Record<string, unknown>;
      const id = str(r.taskId) ?? str(s.taskId);
      if (id !== null) {
        events.push({
          ts,
          taskId: id,
          kind: "status",
          to: str(s.to) ?? str(s.toStatus) ?? str(s.status),
        });
        return;
      }
    }

    // A TaskUpdate that edited something other than status still TOUCHES the task.
    if (Array.isArray(r.updatedFields)) {
      const id = str(r.taskId);
      if (id !== null) events.push({ ts, taskId: id, kind: "touch", to: null });
    }
  });

  return { events, turnStarts };
}

// ---------------------------------------------------------------------------
// attribution (§5.4)
// ---------------------------------------------------------------------------

type AttrClass = "overhead" | "exclusive" | "sticky" | "ambiguous" | "pre_task";

/** How "open" is defined. R3's wording is D1; `attr2.py` implemented D2. */
type OpenDef = "r3_not_closed" | "in_progress_only";

const CLOSED = new Set(["completed", "deleted", "cancelled", "canceled"]);

interface TurnInfo {
  promptId: string;
  startedAt: string;
  events: TaskEvent[];
}

interface ClassifiedTurn {
  promptId: string;
  /** class under end-of-turn evaluation — the §5.4 anchor_prompt semantics. */
  cls: AttrClass;
  /** class under start-of-turn evaluation — sensitivity variant. */
  clsAtStart: AttrClass;
}

/**
 * Walk one session's turns in time order, maintaining the open set and the
 * last-touched task, and label each turn.
 *
 * End-of-turn is primary: §5.4 says attribution windows open at
 * `task.anchor_prompt`, i.e. the turn that CREATES a task is inside that task's
 * actual, which only holds if the turn's own task events count toward it.
 */
function classifySession(
  turns: TurnInfo[],
  openDef: OpenDef,
  openSizeOut?: Map<string, number>,
): ClassifiedTurn[] {
  const open: string[] = []; // insertion-ordered; membership set is small
  let lastTouched: string | null = null;

  const isOpening = (e: TaskEvent): boolean =>
    openDef === "r3_not_closed"
      ? e.kind === "create" || (e.to !== null && !CLOSED.has(e.to))
      : e.to === "in_progress";

  const isClosing = (e: TaskEvent): boolean =>
    openDef === "r3_not_closed"
      ? e.to !== null && CLOSED.has(e.to)
      : e.kind === "status" && e.to !== "in_progress";

  const apply = (e: TaskEvent): void => {
    if (isClosing(e)) {
      const i = open.indexOf(e.taskId);
      if (i >= 0) open.splice(i, 1);
    } else if (isOpening(e)) {
      if (!open.includes(e.taskId)) open.push(e.taskId);
    }
    // Every event is a touch, including a pure metadata edit and a close.
    lastTouched = e.taskId;
  };

  const label = (): AttrClass => {
    if (open.length === 1) return "exclusive";
    if (open.length > 1) return "ambiguous";
    return lastTouched === null ? "pre_task" : "sticky";
  };

  const out: ClassifiedTurn[] = [];
  for (const t of turns) {
    const clsAtStart = label();
    for (const e of t.events) apply(e);
    openSizeOut?.set(t.promptId, open.length);
    out.push({ promptId: t.promptId, cls: label(), clsAtStart });
  }
  return out;
}

// ---------------------------------------------------------------------------
// accumulation
// ---------------------------------------------------------------------------

type Bucket = Record<CurrencyName, number>;

function zeroBucket(): Bucket {
  return { wcet_unweighted: 0, attr2_in_out_cw: 0, out_only: 0, requests: 0 };
}

function addTo(b: Bucket, r: Counters): void {
  for (const n of CURRENCY_NAMES) b[n] += CURRENCIES[n](r);
}

class Tally {
  readonly byClass = new Map<string, Bucket>();
  total: Bucket = zeroBucket();

  add(cls: string, r: Counters): void {
    let b = this.byClass.get(cls);
    if (b === undefined) {
      b = zeroBucket();
      this.byClass.set(cls, b);
    }
    addTo(b, r);
    addTo(this.total, r);
  }

  share(cls: string | string[], cur: CurrencyName): number {
    const keys = Array.isArray(cls) ? cls : [cls];
    const denom = this.total[cur];
    if (denom === 0) return 0;
    let n = 0;
    for (const k of keys) n += this.byClass.get(k)?.[cur] ?? 0;
    return (100 * n) / denom;
  }
}

// ---------------------------------------------------------------------------
// dedup (§5.2) — MAX per (request_id, counter), then the message_id replay pass
// ---------------------------------------------------------------------------

function upsertMax(into: Map<string, Req>, row: RequestRow): void {
  const cur = into.get(row.request_id);
  if (cur === undefined) {
    into.set(row.request_id, {
      request_id: row.request_id,
      message_id: row.message_id,
      is_sidechain: row.is_sidechain,
      session_id: row.session_id,
      prompt_id: row.prompt_id,
      origin: row.origin,
      model_family: row.model_family,
      attribution_skill: row.attribution_skill,
      in: row.in_tok,
      out: row.out_tok,
      cw: row.cw_tok,
      cr: row.cr_tok,
      replay: false,
    });
    return;
  }
  cur.in = Math.max(cur.in, row.in_tok);
  cur.out = Math.max(cur.out, row.out_tok);
  cur.cw = Math.max(cur.cw, row.cw_tok);
  cur.cr = Math.max(cur.cr, row.cr_tok);
  // first-seen wins on identity fields (fork stability, §5.2)
  if (cur.prompt_id === null && row.prompt_id !== null) cur.prompt_id = row.prompt_id;
}

/** ccusage's tie-break, verbatim from §5.2. Marks losers `replay`. */
function markSidechainReplays(reqs: Map<string, Req>): number {
  const byMessage = new Map<string, Req[]>();
  for (const r of reqs.values()) {
    if (r.message_id === null) continue;
    const list = byMessage.get(r.message_id);
    if (list === undefined) byMessage.set(r.message_id, [r]);
    else list.push(r);
  }
  let marked = 0;
  for (const list of byMessage.values()) {
    if (list.length < 2) continue;
    let winner = list[0]!;
    for (const c of list.slice(1)) {
      const better =
        c.is_sidechain !== winner.is_sidechain
          ? c.is_sidechain < winner.is_sidechain
          : c.in + c.out + c.cw + c.cr !== winner.in + winner.out + winner.cw + winner.cr
            ? c.in + c.out + c.cw + c.cr > winner.in + winner.out + winner.cw + winner.cr
            : c.request_id < winner.request_id;
      if (better) winner = c;
    }
    for (const r of list) {
      if (r !== winner) {
        r.replay = true;
        marked += 1;
      }
    }
  }
  return marked;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface SessionSummary {
  sessionId: string;
  taskEvents: number;
  distinctTasks: number;
  /** Tasks that reached a terminal status — the rest stay "open" forever. */
  closedTasks: number;
  maxOpen: number;
  turns: number;
  wcet: number;
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const jsonAt = argv.indexOf("--json");
  const jsonOut = jsonAt >= 0 ? argv[jsonAt + 1] : null;
  const limitAt = argv.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) : Infinity;

  const t0 = Date.now();
  const corpus = discoverCorpus();
  const sessions = corpus.sessions.slice(0, limit);
  process.stderr.write(
    `discovered ${corpus.sessions.length} sessions, ${corpus.census.files} files, ` +
      `${(corpus.census.bytes / 1e6).toFixed(0)} MB in ${Date.now() - t0} ms\n`,
  );

  // Turn class, keyed `${sessionId}|${promptId}`, for each open-definition
  // and each evaluation point.
  const clsR3 = new Map<string, AttrClass>();
  const clsR3Start = new Map<string, AttrClass>();
  const clsInProg = new Map<string, AttrClass>();
  const openSizeR3 = new Map<string, number>();
  const openSizeInProg = new Map<string, number>();
  const sessionsWithNoTasks = new Set<string>();
  const sessionSummaries: SessionSummary[] = [];

  const requests = new Map<string, Req>();
  let ingestAnomalies = 0;
  let malformed = 0;
  let truncated = 0;

  let done = 0;
  for (const session of sessions) {
    await processSession(session);
    done += 1;
    if (done % 25 === 0) process.stderr.write(`  ${done}/${sessions.length} sessions\r`);
  }
  process.stderr.write(`\n`);

  async function processSession(session: SessionCorpus): Promise<void> {
    // --- task stream + turn starts, from every main transcript of the session --
    const events: TaskEvent[] = [];
    const seenEvent = new Set<string>();
    const turnStarts = new Map<string, string>();
    for (const path of session.mainTranscripts) {
      const { events: evs, turnStarts: ts } = await readTaskStream(path);
      for (const e of evs) {
        // A session can be written under several munged project dirs (§5.1);
        // identical events must not be replayed into the state machine twice.
        const k = `${e.ts}|${e.taskId}|${e.kind}|${e.to ?? ""}`;
        if (seenEvent.has(k)) continue;
        seenEvent.add(k);
        events.push(e);
      }
      for (const [p, t] of ts) {
        const prev = turnStarts.get(p);
        if (prev === undefined || t < prev) turnStarts.set(p, t);
      }
    }
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    // --- turns in time order, each carrying the events that fall inside it ----
    const ordered = [...turnStarts.entries()].sort((a, b) =>
      a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
    );
    const turns: TurnInfo[] = ordered.map(([promptId, startedAt]) => ({
      promptId,
      startedAt,
      events: [],
    }));
    // Assign each event to the last turn that had already started. Events before
    // any turn attach to the first turn, so pre-prompt hook activity is not lost.
    let ti = 0;
    for (const e of events) {
      while (ti + 1 < turns.length && turns[ti + 1]!.startedAt <= e.ts) ti += 1;
      if (turns.length > 0) turns[ti]!.events.push(e);
    }

    if (events.length === 0) sessionsWithNoTasks.add(session.sessionId);

    const sizeR3 = new Map<string, number>();
    for (const c of classifySession(turns, "r3_not_closed", sizeR3)) {
      clsR3.set(`${session.sessionId}|${c.promptId}`, c.cls);
      clsR3Start.set(`${session.sessionId}|${c.promptId}`, c.clsAtStart);
    }
    for (const [p, n] of sizeR3) openSizeR3.set(`${session.sessionId}|${p}`, n);

    const sizeIP = new Map<string, number>();
    for (const c of classifySession(turns, "in_progress_only", sizeIP)) {
      clsInProg.set(`${session.sessionId}|${c.promptId}`, c.cls);
    }
    for (const [p, n] of sizeIP) openSizeInProg.set(`${session.sessionId}|${p}`, n);

    // --- requests (main + every sub-agent), via the shipped ingest ------------
    const batch = await ingestSession(session);
    for (const row of batch.requests) upsertMax(requests, row);
    ingestAnomalies += batch.anomalies.length;
    malformed += batch.stats.malformed;
    truncated += batch.stats.truncatedTail;

    let wcet = 0;
    for (const r of batch.requests) wcet += r.out_tok + r.cw_tok;
    const closed = new Set(
      events.filter((e) => e.to !== null && CLOSED.has(e.to)).map((e) => e.taskId),
    );
    sessionSummaries.push({
      sessionId: session.sessionId,
      taskEvents: events.length,
      distinctTasks: new Set(events.map((e) => e.taskId)).size,
      closedTasks: closed.size,
      maxOpen: Math.max(0, ...[...sizeR3.values()]),
      turns: turns.length,
      wcet,
    });
  }

  const replays = markSidechainReplays(requests);

  // --- roll up ---------------------------------------------------------------
  const all = new Tally(); // R3 open-def, end-of-turn, WHOLE corpus
  const start = new Tally(); // R3 open-def, start-of-turn
  const inprog = new Tally(); // in_progress-only open-def (attr2.py's)
  const taskBearing = new Tally(); // R3, restricted to sessions with >=1 task event
  const byOrigin = new Map<string, Tally>();
  const byFamily = new Map<string, Tally>();

  const attr2 = new Tally(); // faithful `attr2.py` replication
  /** Ladder rung C: all origins, task-bearing sessions, in_progress-only def. */
  const ladderC = new Tally();
  const openHistR3 = new Tally();
  const openHistIP = new Tally();

  let unjoined = zeroBucket(); // no promptId, or a promptId with no turn
  let unjoinedSub = zeroBucket();
  let replayed = zeroBucket();
  let overheadSkill = 0;

  const classOf = (m: Map<string, AttrClass>, r: Req): AttrClass | null => {
    if (r.prompt_id === null) return null;
    return m.get(`${r.session_id}|${r.prompt_id}`) ?? null;
  };

  for (const r of requests.values()) {
    if (r.replay) {
      addTo(replayed, r);
      continue;
    }
    if (r.attribution_skill === "estimating") overheadSkill += 1;

    const c = classOf(clsR3, r);
    if (c === null) {
      addTo(unjoined, r);
      if (r.origin === "subagent") addTo(unjoinedSub, r);
      // §5.4 rule 3's floor: an unjoinable request is pre_task, never NULL.
      all.add("pre_task", r);
      if (!sessionsWithNoTasks.has(r.session_id)) taskBearing.add("pre_task", r);
      start.add("pre_task", r);
      inprog.add("pre_task", r);
    } else {
      all.add(c, r);
      if (!sessionsWithNoTasks.has(r.session_id)) taskBearing.add(c, r);
      start.add(classOf(clsR3Start, r) ?? "pre_task", r);
      inprog.add(classOf(clsInProg, r) ?? "pre_task", r);
    }

    let o = byOrigin.get(r.origin);
    if (o === undefined) byOrigin.set(r.origin, (o = new Tally()));
    o.add(c ?? "pre_task", r);

    let f = byFamily.get(r.model_family);
    if (f === undefined) byFamily.set(r.model_family, (f = new Tally()));
    f.add(c ?? "pre_task", r);

    // Faithful replication of the original `attr2.py`, for the 82.8/26.5/45.9
    // comparison: MAIN transcripts only (its glob never reached sub-agent dirs),
    // task-bearing sessions only, in_progress-only open-def.
    if (r.origin === "main" && !sessionsWithNoTasks.has(r.session_id)) {
      attr2.add(classOf(clsInProg, r) ?? "pre_task", r);
    }
    if (!sessionsWithNoTasks.has(r.session_id)) {
      ladderC.add(classOf(clsInProg, r) ?? "pre_task", r);
    }

    // How many tasks were open, token-weighted — this is what explains a large
    // `ambiguous` share, and whether it is a definition artefact or real WIP.
    const n3 = r.prompt_id === null ? null : (openSizeR3.get(`${r.session_id}|${r.prompt_id}`) ?? null);
    openHistR3.add(n3 === null ? "unjoined" : n3 >= 6 ? "6+" : String(n3), r);
    const nI = r.prompt_id === null ? null : (openSizeInProg.get(`${r.session_id}|${r.prompt_id}`) ?? null);
    openHistIP.add(nI === null ? "unjoined" : nI >= 6 ? "6+" : String(nI), r);
  }

  // tokens living in sessions that never created or touched a single task
  const zeroTaskSession = zeroBucket();
  for (const r of requests.values()) {
    if (!r.replay && sessionsWithNoTasks.has(r.session_id)) addTo(zeroTaskSession, r);
  }

  const COV = ["exclusive", "sticky"];
  const cur: CurrencyName = "wcet_unweighted";

  const report = {
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    corpus: {
      root: corpus.root,
      sessions: sessions.length,
      files: corpus.census.files,
      bytes: corpus.census.bytes,
      oldest_mtime: corpus.census.oldestMtime,
      discovery_anomalies: corpus.anomalies.length,
      ingest_anomalies: ingestAnomalies,
      malformed_lines: malformed,
      truncated_tails: truncated,
      unique_requests: requests.size,
      sidechain_replays_marked: replays,
      requests_with_estimating_skill: overheadSkill,
    },
    headline: {
      currency: cur,
      coverage_pct: all.share(COV, cur),
      exclusive_pct: all.share("exclusive", cur),
      sticky_pct: all.share("sticky", cur),
      ambiguous_pct: all.share("ambiguous", cur),
      pre_task_pct: all.share("pre_task", cur),
      zero_open_pct: all.share(["sticky", "pre_task"], cur),
      zero_task_session_pct: (100 * zeroTaskSession[cur]) / all.total[cur],
      zero_task_sessions: sessionsWithNoTasks.size,
    },
    variants: {
      task_bearing_sessions_only: {
        coverage_pct: taskBearing.share(COV, cur),
        exclusive_pct: taskBearing.share("exclusive", cur),
        zero_open_pct: taskBearing.share(["sticky", "pre_task"], cur),
        ambiguous_pct: taskBearing.share("ambiguous", cur),
      },
      start_of_turn_evaluation: {
        coverage_pct: start.share(COV, cur),
        exclusive_pct: start.share("exclusive", cur),
      },
      in_progress_only_open_def: {
        coverage_pct: inprog.share(COV, cur),
        exclusive_pct: inprog.share("exclusive", cur),
        ambiguous_pct: inprog.share("ambiguous", cur),
      },
      attr2_headline_incl_ambiguous: all.share([...COV, "ambiguous"], cur),
    },
    /** The original probe, reproduced on its own terms (§ header comment). */
    attr2_replication: {
      note: "main transcripts only, task-bearing sessions only, in_progress-only open-def, in+out+cw",
      headline_coverage_incl_ambiguous_pct: attr2.share(
        ["exclusive", "sticky", "ambiguous"],
        "attr2_in_out_cw",
      ),
      strict_exclusive_pct: attr2.share("exclusive", "attr2_in_out_cw"),
      sticky_pct: attr2.share("sticky", "attr2_in_out_cw"),
      ambiguous_pct: attr2.share("ambiguous", "attr2_in_out_cw"),
      pre_task_pct: attr2.share("pre_task", "attr2_in_out_cw"),
      zero_open_pct: attr2.share(["sticky", "pre_task"], "attr2_in_out_cw"),
      /** Coverage as R3 defines it (exclusive ∪ sticky), on the probe's data. */
      r3_coverage_pct: attr2.share(COV, "attr2_in_out_cw"),
    },
    /**
     * Why the headline is not 82.8%, one correction at a time. Every rung is
     * `exclusive ∪ sticky` in Work-CET (out+cw); only the stated change differs
     * from the rung above it.
     */
    ladder: {
      A_attr2_own_headline_incl_ambiguous: attr2.share(
        [...COV, "ambiguous"],
        "attr2_in_out_cw",
      ),
      B_same_data_r3_coverage_def: attr2.share(COV, cur),
      C_plus_subagent_tokens: ladderC.share(COV, cur),
      D_plus_zero_task_sessions: inprog.share(COV, cur),
      E_plus_r3_open_def_HEADLINE: all.share(COV, cur),
    },
    open_task_histogram: {
      r3_not_closed: Object.fromEntries(
        [...openHistR3.byClass].map(([k, b]) => [k, (100 * b[cur]) / openHistR3.total[cur]]),
      ),
      in_progress_only: Object.fromEntries(
        [...openHistIP.byClass].map(([k, b]) => [k, (100 * b[cur]) / openHistIP.total[cur]]),
      ),
    },
    currencies: Object.fromEntries(
      CURRENCY_NAMES.map((c) => [
        c,
        {
          coverage_pct: all.share(COV, c),
          exclusive_pct: all.share("exclusive", c),
          zero_open_pct: all.share(["sticky", "pre_task"], c),
          total: all.total[c],
        },
      ]),
    ),
    by_origin: Object.fromEntries(
      [...byOrigin].map(([k, t]) => [
        k,
        {
          coverage_pct: t.share(COV, cur),
          exclusive_pct: t.share("exclusive", cur),
          share_of_corpus_pct: (100 * t.total[cur]) / all.total[cur],
          total: t.total[cur],
        },
      ]),
    ),
    by_model_family: Object.fromEntries(
      [...byFamily]
        .sort((a, b) => b[1].total[cur] - a[1].total[cur])
        .map(([k, t]) => [
          k,
          {
            coverage_pct: t.share(COV, cur),
            share_of_corpus_pct: (100 * t.total[cur]) / all.total[cur],
          },
        ]),
    ),
    join_quality: {
      unjoined_pct: (100 * unjoined[cur]) / all.total[cur],
      unjoined_subagent_pct: (100 * unjoinedSub[cur]) / all.total[cur],
      replay_excluded_pct: (100 * replayed[cur]) / (all.total[cur] + replayed[cur]),
    },
    task_hygiene: (() => {
      const bearing = sessionSummaries.filter((s) => s.taskEvents > 0);
      const created = bearing.reduce((a, s) => a + s.distinctTasks, 0);
      const closed = bearing.reduce((a, s) => a + s.closedTasks, 0);
      return {
        task_bearing_sessions: bearing.length,
        tasks_created: created,
        tasks_ever_closed: closed,
        never_closed_pct: created === 0 ? 0 : (100 * (created - closed)) / created,
        median_tasks_per_bearing_session: bearing.length === 0
          ? 0
          : bearing.map((s) => s.distinctTasks).sort((a, b) => a - b)[
              Math.floor(bearing.length / 2)
            ]!,
        max_simultaneously_open: Math.max(0, ...bearing.map((s) => s.maxOpen)),
      };
    })(),
    top_sessions: sessionSummaries
      .sort((a, b) => b.wcet - a.wcet)
      .slice(0, 15)
      .map((s) => ({ ...s, sessionId: s.sessionId.slice(0, 8) })),
    verdict: all.share(COV, cur) < 70 ? "ESCALATE" : "PASS",
  };

  const pct = (x: number): string => x.toFixed(1).padStart(5) + "%";
  const L = (s: string): void => {
    process.stdout.write(s + "\n");
  };

  L("=== G-ATTR — sticky attribution feasibility (R3 §5.4), turn grain ===");
  L(
    `corpus: ${report.corpus.sessions} sessions, ${report.corpus.files} files, ` +
      `${(report.corpus.bytes / 1e6).toFixed(0)} MB, ${report.corpus.unique_requests} unique requests` +
      ` (${report.elapsed_ms} ms)`,
  );
  L("");
  L("headline — Work-CET (out+cw), whole corpus, end-of-turn, R3 open-def:");
  L(`  exclusive        ${pct(report.headline.exclusive_pct)}`);
  L(`  sticky           ${pct(report.headline.sticky_pct)}`);
  L(`  ------------------------`);
  L(`  COVERAGE         ${pct(report.headline.coverage_pct)}   (threshold 70%)`);
  L(`  ambiguous        ${pct(report.headline.ambiguous_pct)}`);
  L(`  pre_task         ${pct(report.headline.pre_task_pct)}`);
  L(`  zero-open        ${pct(report.headline.zero_open_pct)}`);
  L(
    `  zero-task-session${pct(report.headline.zero_task_session_pct)}   ` +
      `(${report.headline.zero_task_sessions}/${report.corpus.sessions} sessions)`,
  );
  L("");
  L("variants:");
  L(
    `  task-bearing sessions only : coverage ${pct(report.variants.task_bearing_sessions_only.coverage_pct)}  ` +
      `exclusive ${pct(report.variants.task_bearing_sessions_only.exclusive_pct)}  ` +
      `zero-open ${pct(report.variants.task_bearing_sessions_only.zero_open_pct)}`,
  );
  L(
    `  start-of-turn evaluation   : coverage ${pct(report.variants.start_of_turn_evaluation.coverage_pct)}  ` +
      `exclusive ${pct(report.variants.start_of_turn_evaluation.exclusive_pct)}`,
  );
  L(
    `  in_progress-only open-def  : coverage ${pct(report.variants.in_progress_only_open_def.coverage_pct)}  ` +
      `exclusive ${pct(report.variants.in_progress_only_open_def.exclusive_pct)}  ` +
      `ambiguous ${pct(report.variants.in_progress_only_open_def.ambiguous_pct)}`,
  );
  L(`  attr2 headline (cov+ambig) : ${pct(report.variants.attr2_headline_incl_ambiguous)}`);
  L("");
  L("attr2.py replication (main-only, task-bearing sessions, in_progress def, in+out+cw):");
  L(
    `  its headline (cov+ambig)   ${pct(report.attr2_replication.headline_coverage_incl_ambiguous_pct)}` +
      `   [original: 82.8%]`,
  );
  L(`  strict exclusive           ${pct(report.attr2_replication.strict_exclusive_pct)}   [original: 26.5%]`);
  L(`  zero-open                  ${pct(report.attr2_replication.zero_open_pct)}   [original: 45.9%]`);
  L(`  R3 coverage on its data    ${pct(report.attr2_replication.r3_coverage_pct)}`);
  L("");
  L("decomposition ladder (coverage = exclusive ∪ sticky unless noted):");
  L(`  A  attr2.py's own headline, incl. ambiguous ....... ${pct(report.ladder.A_attr2_own_headline_incl_ambiguous)}`);
  L(`  B  same data, R3 coverage def (drop ambiguous) .... ${pct(report.ladder.B_same_data_r3_coverage_def)}`);
  L(`  C  + sub-agent tokens (82% of corpus) ............. ${pct(report.ladder.C_plus_subagent_tokens)}`);
  L(`  D  + sessions with no tasks at all ................ ${pct(report.ladder.D_plus_zero_task_sessions)}`);
  L(`  E  + R3 "open = not closed" def  == HEADLINE ...... ${pct(report.ladder.E_plus_r3_open_def_HEADLINE)}`);
  L("");
  L("open-task count when a token was spent (token-weighted %):");
  for (const [defName, hist] of Object.entries(report.open_task_histogram)) {
    const entries = Object.entries(hist as Record<string, number>).sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true }),
    );
    L(`  ${defName.padEnd(16)} ` + entries.map(([k, v]) => `${k}:${v.toFixed(1)}%`).join("  "));
  }
  L("");
  L("currency sensitivity:");
  for (const c of CURRENCY_NAMES) {
    const v = report.currencies[c] as { coverage_pct: number; exclusive_pct: number };
    L(`  ${c.padEnd(18)} coverage ${pct(v.coverage_pct)}  exclusive ${pct(v.exclusive_pct)}`);
  }
  L("");
  L("by origin:");
  for (const [k, v] of Object.entries(report.by_origin)) {
    const o = v as { coverage_pct: number; share_of_corpus_pct: number };
    L(
      `  ${k.padEnd(10)} ${pct(o.share_of_corpus_pct)} of corpus   coverage ${pct(o.coverage_pct)}`,
    );
  }
  L("");
  L("by model family (reweighting sensitivity):");
  for (const [k, v] of Object.entries(report.by_model_family)) {
    const f = v as { coverage_pct: number; share_of_corpus_pct: number };
    if (f.share_of_corpus_pct < 0.05) continue;
    L(`  ${k.padEnd(26)} ${pct(f.share_of_corpus_pct)} of corpus   coverage ${pct(f.coverage_pct)}`);
  }
  L("");
  L("task hygiene (why `ambiguous` is so large):");
  L(
    `  ${report.task_hygiene.task_bearing_sessions} task-bearing sessions, ` +
      `${report.task_hygiene.tasks_created} tasks created, ` +
      `${report.task_hygiene.never_closed_pct.toFixed(1)}% never reached a terminal status`,
  );
  L(
    `  median ${report.task_hygiene.median_tasks_per_bearing_session} tasks/session, ` +
      `max ${report.task_hygiene.max_simultaneously_open} open at once`,
  );
  L("");
  L("join quality:");
  L(`  unjoined (no turn)   ${pct(report.join_quality.unjoined_pct)}`);
  L(`  ...of which subagent ${pct(report.join_quality.unjoined_subagent_pct)}`);
  L(`  sidechain replays    ${pct(report.join_quality.replay_excluded_pct)} excluded`);
  L("");
  L(`VERDICT: ${report.verdict}`);

  if (jsonOut !== undefined && jsonOut !== null) {
    await Bun.write(jsonOut, JSON.stringify(report, null, 2));
    process.stderr.write(`wrote ${jsonOut}\n`);
  }
}

await main();

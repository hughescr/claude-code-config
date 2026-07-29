#!/usr/bin/env bun
/**
 * src/cli.ts — the `est` command. Phase 0 verbs only (§8).
 *
 *   est init                    bootstrap ~/.claude/estimator + the database (idempotent)
 *   est sweep                   single-writer incremental sweep of the transcript corpus
 *   est backfill                full re-sweep over every surviving transcript + spend report
 *   est prices --sync           refresh model_price from the upstream pricing JSON
 *   est census                  sweep_census history + live corpus counts
 *
 * Three properties this file is responsible for (§2):
 *
 *  1. **Single writer.** Every path that writes takes the `flock`-style sweep lock
 *     from src/lock.ts. Nothing else in Phase 0 writes to the database.
 *  2. **Idempotence.** A re-sweep of an unchanged corpus is a no-op: row writes go
 *     through the upsert-with-MAX statements in src/ingest.ts, `sweep_state` is a
 *     pure performance watermark, and anomalies are de-duplicated on (kind, detail)
 *     before insert so a daily cron does not grow the ledger by a copy per day.
 *  3. **Loud failures.** Nothing unparseable is dropped or zeroed — it lands in
 *     `anomaly`, is counted in the report, and raises the process exit code.
 *
 * Exit codes:
 *   0  success
 *   1  usage error, or a fatal error (unreadable schema, schema_version mismatch)
 *   3  completed, but alerting anomalies were recorded (or the budget was exceeded)
 *   4  the sweep lock is held by another writer and `--blocking` was not given
 *
 * Zero npm dependencies: bun:sqlite + node builtins only.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { DB_PATH, ROOT, getConfig, openDb } from "./db.ts";
import { PROJECTS_ROOT, discoverCorpus, sessionFiles, type Corpus } from "./discover.ts";
import {
  INSERT_ANOMALY_SQL,
  detectForkReplays,
  ingestSession,
  markSidechainReplays,
  planCorpus,
  replayAnomalies,
  toIngestAnomalies,
  writeBatch,
  type IngestAnomaly,
  type IngestBatch,
  type ParseStats,
  type ReplayGroup,
  type TranscriptIndexEntry,
} from "./ingest.ts";
import { LOCK_PATH, LockBusyError, withLock } from "./lock.ts";
import { isoSeconds, setManualPrice, showPrices, sync, type SyncResult } from "./prices.ts";

// ---------------------------------------------------------------------------
// argument parsing — pure, exported, and tested without running any command
// ---------------------------------------------------------------------------

export const COMMANDS = ["init", "sweep", "backfill", "prices", "census", "help", "version"] as const;
export type Command = (typeof COMMANDS)[number];

export interface FlagSpec {
  /** `--x` / `--no-x`; value is `true` / `false`. */
  readonly booleans: readonly string[];
  /** `--x v` or `--x=v`; value is the string. */
  readonly values: readonly string[];
}

/** Accepted by every command; a hook or a cron line may put them anywhere. */
export const GLOBAL_FLAGS: FlagSpec = {
  booleans: ["help", "quiet", "json", "version"],
  values: ["db", "lock"],
};

export const COMMAND_FLAGS: Record<Command, FlagSpec> = {
  init: { booleans: [], values: [] },
  sweep: { booleans: ["blocking", "strict"], values: ["budget", "root", "chunk"] },
  backfill: { booleans: ["strict"], values: ["budget", "root", "chunk", "top"] },
  prices: { booleans: ["sync", "show"], values: ["source", "set", "in", "out", "cw", "cr", "at"] },
  census: { booleans: [], values: ["limit", "root"] },
  help: { booleans: [], values: [] },
  version: { booleans: [], values: [] },
};

const ALIASES: Readonly<Record<string, string>> = { h: "help", q: "quiet", v: "version" };

/**
 * Tokenising needs to know which flags take a value BEFORE the command is known
 * (`est --db /tmp/x.db sweep`), so the tokeniser uses the union and the resolved
 * command validates afterwards. That ordering is why an unknown flag and a
 * misplaced flag are two distinct error messages.
 */
const ALL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...GLOBAL_FLAGS.values,
  ...Object.values(COMMAND_FLAGS).flatMap((s) => s.values),
]);
const ALL_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  ...GLOBAL_FLAGS.booleans,
  ...Object.values(COMMAND_FLAGS).flatMap((s) => s.booleans),
]);

export interface Parsed {
  command: Command | null;
  flags: Record<string, string | boolean>;
  positionals: string[];
  errors: string[];
}

export function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = { command: null, flags: {}, positionals: [], errors: [] };
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]!;

    if (literal || tok === "-" || !tok.startsWith("-")) {
      if (!literal && out.command === null && !tok.startsWith("-")) {
        if ((COMMANDS as readonly string[]).includes(tok)) out.command = tok as Command;
        else out.errors.push(`unknown command: ${tok}`);
        continue;
      }
      out.positionals.push(tok);
      continue;
    }

    if (tok === "--") {
      literal = true;
      continue;
    }

    // -h / -q / -v, and -hq bundles.
    if (!tok.startsWith("--")) {
      for (const ch of tok.slice(1)) {
        const name = ALIASES[ch];
        if (name === undefined) out.errors.push(`unknown flag: -${ch}`);
        else out.flags[name] = true;
      }
      continue;
    }

    const body = tok.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? null : body.slice(eq + 1);

    if (name.startsWith("no-") && ALL_BOOLEAN_FLAGS.has(name.slice(3))) {
      if (inlineValue !== null) out.errors.push(`--${name} takes no value`);
      else out.flags[name.slice(3)] = false;
      continue;
    }

    if (ALL_VALUE_FLAGS.has(name)) {
      if (inlineValue !== null) {
        out.flags[name] = inlineValue;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        out.errors.push(`--${name} requires a value`);
        continue;
      }
      out.flags[name] = next;
      i += 1;
      continue;
    }

    if (ALL_BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null && inlineValue !== "true" && inlineValue !== "false") {
        out.errors.push(`--${name} is a boolean flag; got --${name}=${inlineValue}`);
      } else {
        out.flags[name] = inlineValue !== "false";
      }
      continue;
    }

    out.errors.push(`unknown flag: --${name}`);
  }

  // Flags valid for some OTHER command are a distinct, more useful error than
  // "unknown flag" — `est init --budget 20s` should say so plainly.
  if (out.command !== null) {
    const spec = COMMAND_FLAGS[out.command];
    const allowed = new Set([
      ...GLOBAL_FLAGS.booleans,
      ...GLOBAL_FLAGS.values,
      ...spec.booleans,
      ...spec.values,
    ]);
    for (const key of Object.keys(out.flags)) {
      if (!allowed.has(key)) out.errors.push(`--${key} is not valid for \`est ${out.command}\``);
    }
  }

  return out;
}

/** `20s`, `500ms`, `2m`, `1h`, or a bare number of seconds. Null when unparseable. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(text.trim());
  if (m === null) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(Number(m[1]) * mult);
}

function flagString(p: Parsed, name: string): string | null {
  const v = p.flags[name];
  return typeof v === "string" ? v : null;
}
function flagBool(p: Parsed, name: string, dflt = false): boolean {
  const v = p.flags[name];
  return typeof v === "boolean" ? v : dflt;
}
function flagInt(p: Parsed, name: string, dflt: number): number {
  const v = flagString(p, name);
  if (v === null) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ---------------------------------------------------------------------------
// anomaly ledger — de-duplicated, so a daily cron does not grow it linearly
// ---------------------------------------------------------------------------

/**
 * Anomaly kinds that are EXPECTED against a live corpus and therefore do not on
 * their own make a sweep "failed":
 *   - `truncated_tail`: every session being written to right now has one;
 *   - `unpriced_model`: normal until `est prices --sync` has run once;
 *   - the three fork/compaction shapes below, which are what a real corpus of
 *     forked sessions LOOKS like, not damage taken by one.
 * They are still recorded and still reported — `--strict` promotes them.
 */
export const BENIGN_ANOMALY_KINDS: ReadonlySet<string> = new Set([
  "truncated_tail",
  "unpriced_model",
  // A `/compact` boundary is a normal event, recorded because Phase 1's
  // `outcome.compactions` needs the feed and §5.5 needs the preTokens depth — not
  // because anything went wrong. Alerting on it would make every long session's
  // nightly sweep exit 3 (see `compactionAnomalies` in src/ingest.ts).
  "compaction_continuation",
  // The other two structural facts of a FORKED corpus, benign for the same
  // reason and decided the same way. `symlink_alias` is one physical transcript
  // reachable from two session dirs after a fork with a sub-agent in flight;
  // `fork_replay` is a child session replaying its parent's history. Neither is
  // a failure: `planCorpus` resolves the alias to the link target and the global
  // `request` PK plus the §5.2 replay pass keep the duplicate out of every sum.
  // They are recorded because they are EVIDENCE — Phase 1 wants the shapes — and
  // because `insertAnomalies` dedups on (kind, detail), a steady-state nightly
  // sweep writes none of them. Alerting would fire 46 times on the first
  // backfill of the live tree and once per fork forever after.
  "symlink_alias",
  "fork_replay",
]);

/**
 * Insert anomalies, skipping (kind, detail) pairs already in the ledger.
 *
 * `anomaly` has no natural key and `INSERT_ANOMALY_SQL` is a plain INSERT, so an
 * unguarded sweeper would re-log every dangling symlink and every torn tail on
 * every run — breaking "a re-sweep is a no-op" (§2). The guard is done batch-first
 * (one SELECT of existing keys, one filtered insert loop) rather than with a
 * per-row `WHERE NOT EXISTS`, which would be a table scan per anomaly.
 *
 * Returns the rows actually written.
 */
export function insertAnomalies(db: Database, rows: readonly IngestAnomaly[], now: string): IngestAnomaly[] {
  if (rows.length === 0) return [];

  const seen = new Set<string>();
  for (const r of db
    .query<{ kind: string; detail: string }, []>("SELECT kind, detail FROM anomaly WHERE tid IS NULL")
    .all()) {
    seen.add(`${r.kind} ${r.detail}`);
  }

  const stmt = db.prepare(INSERT_ANOMALY_SQL);
  const written: IngestAnomaly[] = [];
  for (const a of rows) {
    const detail = a.path === undefined ? a.detail : `${a.detail} [${a.path}]`;
    const key = `${a.kind} ${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stmt.run({ $ts: now, $kind: a.kind, $detail: detail } as never);
    written.push(a);
  }
  return written;
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

export interface SweepOptions {
  /** Corpus root. Defaults to {@link PROJECTS_ROOT}. */
  root?: string;
  /** Wall-clock budget; the sweep commits what it has and stops. Null = unlimited. */
  budgetMs?: number | null;
  /** Ignore `sweep_state` watermarks and re-read every file (`est backfill`). */
  full?: boolean;
  /** Sessions per write transaction. Bounds memory on a large corpus. */
  chunkSessions?: number;
  /** Injected clock. */
  now?: Date;
}

export interface SweepReport {
  root: string;
  swept_at: string;
  elapsed_ms: number;
  budget_ms: number | null;
  budget_exceeded: boolean;
  full: boolean;
  sessions: {
    total: number;
    ingested: number;
    /** Every file unchanged since the last sweep (watermark hit). */
    skipped: number;
    /** Discovered but carrying no readable artefact at all — nothing to ingest. */
    empty: number;
  };
  corpus: { files: number; bytes: number; sessions: number; oldest_mtime: string | null };
  rows: {
    requests: number;
    turns: number;
    agent_runs: number;
    workflow_runs: number;
    workflow_phases: number;
    /** `task_event` rows — TaskCreate AND TaskUpdate statusChange (§6.1). */
    task_events: number;
  };
  parse: ParseStats;
  /** Files whose read aborted before EOF; their watermark was deliberately NOT
   *  advanced, so the next sweep re-reads them (§5.2's watermark invariant). */
  files_incomplete: number;
  /** §5.2 second dedup pass: rows demoted to `attr='replay'` this sweep. */
  sidechain_replays: number;
  anomalies: { recorded: number; alerting: number; by_kind: Record<string, number> };
  vanished: { total: number; lt_60d: number; paths: string[] };
}

const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000;

export interface FileFingerprint {
  path: string;
  inode: number;
  bytes: number;
}

function fingerprint(path: string): FileFingerprint | null {
  try {
    const st = statSync(path);
    return { path, inode: Number(st.ino), bytes: st.size };
  } catch {
    return null; // vanished between discovery and ingest (GC race, §3.4)
  }
}

/**
 * The fingerprints that may become `sweep_state` watermarks: every file the
 * session touched, MINUS any whose read aborted before EOF.
 *
 * This is the whole fix for the watermark trap, so it is a named function rather
 * than an inline filter. A watermark says "these bytes are accounted for"; a file
 * whose stream errored has bytes nobody parsed. Writing it anyway means the next
 * incremental sweep computes (same inode, same bytes) -> `unchanged` -> skips the
 * session, and the unread tail is frozen out of every future sweep — recoverable
 * only by `est backfill --full`, which the cron never runs. Dropping the
 * fingerprint costs one re-read; every write path is idempotent (§2).
 */
export function watermarkable(
  prints: readonly FileFingerprint[],
  incompleteFiles: readonly string[],
): FileFingerprint[] {
  if (incompleteFiles.length === 0) return [...prints];
  const vetoed = new Set(incompleteFiles);
  return prints.filter((f) => !vetoed.has(f.path));
}

function emptyBatch(): IngestBatch {
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
  };
}

/**
 * Accumulate what a flush WRITES. `files` is excluded on purpose: it is the D3
 * fork index, it is not rows, and it has to outlive every flush of the sweep (the
 * two halves of a fork are routinely in different chunks), so `runSweep` collects
 * it separately instead of letting `emptyBatch()` throw it away.
 */
function mergeBatch(into: IngestBatch, from: IngestBatch): void {
  into.requests.push(...from.requests);
  into.turns.push(...from.turns);
  into.agentRuns.push(...from.agentRuns);
  into.workflowRuns.push(...from.workflowRuns);
  into.workflowPhases.push(...from.workflowPhases);
  into.taskEvents.push(...from.taskEvents);
  into.anomalies.push(...from.anomalies);
  into.incompleteFiles.push(...from.incompleteFiles);
  into.skippedFiles.push(...from.skippedFiles);
  into.stats.lines += from.stats.lines;
  into.stats.blank += from.stats.blank;
  into.stats.parsed += from.stats.parsed;
  into.stats.malformed += from.stats.malformed;
  into.stats.truncatedTail += from.stats.truncatedTail;
}

const UPSERT_SWEEP_STATE_SQL = `
INSERT INTO sweep_state (path, inode, bytes_read, last_swept)
VALUES ($path, $inode, $bytes_read, $last_swept)
ON CONFLICT(path) DO UPDATE SET
  inode = excluded.inode, bytes_read = excluded.bytes_read, last_swept = excluded.last_swept
`;

const UPSERT_CENSUS_SQL = `
INSERT INTO sweep_census (swept_at, n_files, n_bytes, n_sessions, oldest_mtime, vanished_total, vanished_lt_60d)
VALUES ($swept_at, $n_files, $n_bytes, $n_sessions, $oldest_mtime, $vanished_total, $vanished_lt_60d)
ON CONFLICT(swept_at) DO UPDATE SET
  n_files = excluded.n_files, n_bytes = excluded.n_bytes, n_sessions = excluded.n_sessions,
  oldest_mtime = excluded.oldest_mtime,
  vanished_total = excluded.vanished_total, vanished_lt_60d = excluded.vanished_lt_60d
`;

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * discover -> ingest (which segments) -> write -> census. Must be called with the
 * sweep lock held; `sweepCommand` is the only caller that does that.
 *
 * The budget is checked between sessions, never inside one: a half-ingested
 * session would still be correct (upserts are idempotent) but leaving the
 * granularity at "whole sessions" keeps `sweep_state` truthful, which is what
 * makes the NEXT sweep cheap.
 */
export async function runSweep(db: Database, opts: SweepOptions = {}): Promise<SweepReport> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const sweptAt = now.toISOString();
  const root = opts.root ?? PROJECTS_ROOT;
  const budgetMs = opts.budgetMs ?? null;
  const full = opts.full ?? false;
  const chunkSessions = opts.chunkSessions ?? 25;
  const overBudget = (): boolean => budgetMs !== null && Date.now() - t0 > budgetMs;

  const corpus: Corpus = discoverCorpus(root);
  // Corpus-wide before per-session: who owns a symlink-shared transcript, and
  // which state file describes each runId. Both answers are order-dependent if
  // left to `ingestSession` (G-FORK §3.4, G-PHASE §2b).
  const plan = planCorpus(corpus);

  // --- watermarks, scoped to THIS corpus root -------------------------------
  // A test corpus and the real one share one database only by accident, but the
  // vanished-file diff must never read one root's absence as the other's loss.
  const prefix = realRoot(root);
  const prior = new Map<string, { inode: number; bytes: number; lastSwept: string }>();
  for (const row of db
    .query<{ path: string; inode: number; bytes_read: number; last_swept: string }, []>(
      "SELECT path, inode, bytes_read, last_swept FROM sweep_state",
    )
    .all()) {
    if (!row.path.startsWith(prefix)) continue;
    prior.set(row.path, { inode: row.inode, bytes: row.bytes_read, lastSwept: row.last_swept });
  }

  const onDisk = new Set<string>();
  for (const s of corpus.sessions) for (const p of sessionFiles(s)) onDisk.add(p);

  // --- §5.8 corpus shrinkage ------------------------------------------------
  // KNOWN IMPRECISION, stated rather than hidden: `sweep_state` has no column for
  // the file's own mtime, so a vanished file's AGE is unknowable after the fact.
  // `last_swept` only bounds it from below (age >= now - last_swept). The split is
  // therefore computed conservatively — anything last seen alive inside the 60-day
  // window counts as `lt_60d`, the alarming bucket — so the failure mode is a false
  // alarm, never a missed one. Add `sweep_state.mtime` to make it exact.
  const vanished: string[] = [];
  let vanishedLt60d = 0;
  for (const [path, st] of prior) {
    if (onDisk.has(path)) continue;
    if (fingerprint(path) !== null) continue; // present but not discovered: not a loss
    vanished.push(path);
    const seenAgo = now.getTime() - Date.parse(st.lastSwept);
    if (!Number.isFinite(seenAgo) || seenAgo < SIXTY_DAYS_MS) vanishedLt60d += 1;
  }

  const report: SweepReport = {
    root,
    swept_at: sweptAt,
    elapsed_ms: 0,
    budget_ms: budgetMs,
    budget_exceeded: false,
    full,
    sessions: { total: corpus.sessions.length, ingested: 0, skipped: 0, empty: 0 },
    corpus: {
      files: corpus.census.files,
      bytes: corpus.census.bytes,
      sessions: corpus.census.sessions,
      oldest_mtime: corpus.census.oldestMtime,
    },
    rows: {
      requests: 0,
      turns: 0,
      agent_runs: 0,
      workflow_runs: 0,
      workflow_phases: 0,
      task_events: 0,
    },
    parse: { lines: 0, blank: 0, parsed: 0, malformed: 0, truncatedTail: 0 },
    files_incomplete: 0,
    sidechain_replays: 0,
    anomalies: { recorded: 0, alerting: 0, by_kind: {} },
    vanished: { total: vanished.length, lt_60d: vanishedLt60d, paths: vanished },
  };

  // --- buffered ingest, flushed in bounded chunks ---------------------------
  let buffer = emptyBatch();
  let pendingFiles: FileFingerprint[] = [];
  const pendingAnomalies: IngestAnomaly[] = [
    ...toIngestAnomalies(corpus.anomalies),
    ...plan.anomalies,
  ];
  const writtenAnomalies: IngestAnomaly[] = [];
  /** The D3 fork index: one entry per transcript this sweep actually read. */
  const forkFiles: TranscriptIndexEntry[] = [];

  const flush = (): void => {
    const batch = buffer;
    const files = pendingFiles;
    // Ingest's OWN anomalies (torn tails, malformed lines, rid collisions,
    // unusable usage lines, unmapped phases) travel in the batch and must be
    // written too — dropping them would be the silent failure §2 forbids. They
    // join the discovery/sweep-level ones here so a single insertAnomalies()
    // call de-duplicates across both sources.
    const anomalies = [...pendingAnomalies, ...batch.anomalies];
    if (
      batch.requests.length === 0 &&
      batch.turns.length === 0 &&
      batch.agentRuns.length === 0 &&
      batch.workflowRuns.length === 0 &&
      batch.taskEvents.length === 0 &&
      files.length === 0 &&
      anomalies.length === 0
    ) {
      return;
    }
    buffer = emptyBatch();
    pendingFiles = [];
    pendingAnomalies.length = 0;

    db.transaction(() => {
      // `writeBatch` writes rows only; anomalies go through insertAnomalies(), the
      // single writer, so the (kind, detail) de-duplication above applies to
      // ingest's anomalies too.
      writeBatch(db, batch);
      writtenAnomalies.push(...insertAnomalies(db, anomalies, sweptAt));
      const stmt = db.prepare(UPSERT_SWEEP_STATE_SQL);
      for (const f of files) {
        stmt.run({
          $path: f.path,
          $inode: f.inode,
          $bytes_read: f.bytes,
          $last_swept: sweptAt,
        } as never);
      }
    }).immediate();

    report.rows.requests += batch.requests.length;
    report.rows.turns += batch.turns.length;
    report.rows.agent_runs += batch.agentRuns.length;
    report.rows.workflow_runs += batch.workflowRuns.length;
    report.rows.workflow_phases += batch.workflowPhases.length;
    report.rows.task_events += batch.taskEvents.length;
    report.parse.lines += batch.stats.lines;
    report.parse.blank += batch.stats.blank;
    report.parse.parsed += batch.stats.parsed;
    report.parse.malformed += batch.stats.malformed;
    report.parse.truncatedTail += batch.stats.truncatedTail;
  };

  let sinceFlush = 0;
  for (const session of corpus.sessions) {
    if (overBudget()) {
      report.budget_exceeded = true;
      break;
    }

    const prints: FileFingerprint[] = [];
    for (const p of sessionFiles(session)) {
      const fp = fingerprint(p);
      if (fp !== null) prints.push(fp);
    }

    const unchanged =
      !full &&
      prints.length > 0 &&
      prints.every((f) => {
        const was = prior.get(f.path);
        return was !== undefined && was.inode === f.inode && was.bytes === f.bytes;
      });

    if (prints.length === 0) {
      report.sessions.empty += 1;
      continue;
    }
    if (unchanged) {
      report.sessions.skipped += 1;
      continue;
    }

    const ingested = await ingestSession(session, plan);
    mergeBatch(buffer, ingested);
    forkFiles.push(...ingested.files);
    // Two reasons a fingerprint must not become a watermark, and they are the same
    // reason: this session did not read those bytes. `incompleteFiles` is a read
    // that aborted; `skippedFiles` is a symlink-shared transcript another session
    // owns — and if THAT session is cut off by the budget, a watermark written here
    // would freeze the file out of every future incremental sweep.
    pendingFiles.push(
      ...watermarkable(prints, [...ingested.incompleteFiles, ...ingested.skippedFiles]),
    );
    report.files_incomplete += new Set(ingested.incompleteFiles).size;
    report.sessions.ingested += 1;
    sinceFlush += 1;
    if (sinceFlush >= chunkSessions) {
      flush();
      sinceFlush = 0;
    }
  }

  // §5.8: shrinkage is loud, and the stale rows are dropped so the NEXT census
  // reports the delta rather than re-reporting the same loss forever.
  if (vanished.length > 0) {
    pendingAnomalies.push({
      kind: "corpus_shrink",
      detail: `${vanished.length} previously-swept file(s) vanished (${vanishedLt60d} last seen inside 60d): ${vanished
        .slice(0, 20)
        .join(", ")}${vanished.length > 20 ? ` … +${vanished.length - 20} more` : ""}`,
    });
  }
  if (report.budget_exceeded) {
    pendingAnomalies.push({
      kind: "sweep_budget_exceeded",
      detail: `sweep stopped after ${Date.now() - t0} ms (budget ${budgetMs} ms) with ${
        report.sessions.total -
        report.sessions.ingested -
        report.sessions.skipped -
        report.sessions.empty
      } session(s) unswept; partial commit is safe — the next sweep finishes the job`,
    });
  }

  flush();

  // §5.2 / G-FORK §7 rec 2 — the D3 fork detector. It runs over every transcript
  // THIS sweep read, so it belongs here rather than inside a session: the two
  // halves of a fork are by definition in different sessions, and on the real
  // corpus every single cross-file requestId crossed a session boundary. One hash
  // pass over uuids already gathered; no file is re-read.
  pendingAnomalies.push(...detectForkReplays(forkFiles));

  // §5.2 SECOND dedup pass — the ccusage message_id fallback. It runs HERE, after
  // every request row of this sweep is committed and before anything reads a sum,
  // because the two rows sharing a `message.id` routinely come from different
  // files and, on an incremental sweep, from different sweeps. Whole-table and
  // idempotent: the winner is recomputed from the same inputs every time.
  const replayGroups: ReplayGroup[] = [];
  db.transaction(() => {
    replayGroups.push(...markSidechainReplays(db));
  }).immediate();
  report.sidechain_replays = replayGroups.reduce((n, g) => n + g.n_losers, 0);
  pendingAnomalies.push(...replayAnomalies(replayGroups));

  // §4.3 loud failure: a model family with no price row silently drops out of
  // v_priced (an INNER JOIN, deliberately) and would otherwise be invisible until
  // someone read a report and wondered why it was small. `sync()` only raises
  // unpriced_model for ids it could not RESOLVE, which misses the case where the
  // observed family and the priced family disagree on normalisation — so the
  // sweeper checks the actual join, which is the thing that matters.
  const unpricedFamilies = db
    .query<{ model_family: string; n: number }, []>(
      "SELECT model_family, COUNT(*) AS n FROM v_unpriced GROUP BY model_family ORDER BY n DESC",
    )
    .all();
  if (unpricedFamilies.length > 0) {
    pendingAnomalies.push(
      ...unpricedFamilies.map((f) => ({
        kind: "unpriced_model" as const,
        detail: `no model_price row for family "${f.model_family}" (${f.n} request(s) excluded from every sum); run \`est prices --sync\``,
      })),
    );
  }
  const preEpoch = db.query<{ n: number }, []>(PRE_EPOCH_SQL).get()?.n ?? 0;
  if (preEpoch > 0) {
    pendingAnomalies.push({
      kind: "unpriced_model",
      detail: `${preEpoch} request(s) predate the earliest effective_from of their own model family — dropped by v_priced's \`effective_from <= ts\` join and NOT counted by v_unpriced`,
    });
  }
  if (pendingAnomalies.length > 0) flush();

  db.transaction(() => {
    if (vanished.length > 0) {
      const del = db.prepare("DELETE FROM sweep_state WHERE path = ?");
      for (const p of vanished) del.run(p);
    }
    db.query(UPSERT_CENSUS_SQL).run({
      $swept_at: sweptAt,
      $n_files: corpus.census.files,
      $n_bytes: corpus.census.bytes,
      $n_sessions: corpus.census.sessions,
      // NOT NULL. An empty corpus has no oldest file; the sweep time is the
      // truthful degenerate answer ("nothing older than now") and keeps MIN()
      // over the census history meaningful.
      $oldest_mtime: corpus.census.oldestMtime ?? sweptAt,
      $vanished_total: vanished.length,
      $vanished_lt_60d: vanishedLt60d,
    } as never);
  }).immediate();

  for (const a of writtenAnomalies) {
    report.anomalies.by_kind[a.kind] = (report.anomalies.by_kind[a.kind] ?? 0) + 1;
  }
  report.anomalies.recorded = writtenAnomalies.length;
  report.anomalies.alerting = writtenAnomalies.filter((a) => !BENIGN_ANOMALY_KINDS.has(a.kind)).length;
  report.elapsed_ms = Date.now() - t0;
  return report;
}

// ---------------------------------------------------------------------------
// spend read models — `est backfill`'s summary tables
// ---------------------------------------------------------------------------

export interface SpendRow {
  key: string;
  n_req: number;
  in_tok: number;
  out_tok: number;
  cw_tok: number;
  cr_tok: number;
  /** Work-CET: price-weighted (output + cache_creation) / ref_model output price. */
  wcet: number;
  /** Spend-CET: all four counters, same normaliser. */
  scet: number;
  usd: number;
}

const SPEND_SELECT = `
SELECT %KEY% AS key,
  COUNT(*) AS n_req,
  COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(out_tok),0) AS out_tok,
  COALESCE(SUM(cw_tok),0) AS cw_tok, COALESCE(SUM(cr_tok),0) AS cr_tok,
  COALESCE(SUM(wcet),0) AS wcet, COALESCE(SUM(scet),0) AS scet,
  COALESCE(SUM((in_tok*usd_in + out_tok*usd_out + cw_tok*usd_cw + cr_tok*usd_cr) / 1000000.0),0) AS usd
FROM v_wcet GROUP BY %KEY% ORDER BY wcet DESC, n_req DESC
`;

function spendBy(db: Database, key: "model_family" | "origin"): SpendRow[] {
  return db.query<SpendRow, []>(SPEND_SELECT.replaceAll("%KEY%", key)).all();
}

/** Per-model Work-CET / Spend-CET / USD over every priced, non-replay request. */
export function spendByModel(db: Database): SpendRow[] {
  return spendBy(db, "model_family");
}

/** Per-origin (orchestrator / sub-agent / auxiliary) — the §4.6 split. */
export function spendByOrigin(db: Database): SpendRow[] {
  return spendBy(db, "origin");
}

export interface UnpricedSummary {
  n_req: number;
  families: string[];
  /**
   * Requests whose family IS priced but whose `ts` predates that family's earliest
   * `effective_from`. `v_priced` drops them (the join is `effective_from <= ts`)
   * and `v_unpriced` does not catch them (the family exists), so without this
   * count they would be invisible in both directions — the exact silent-zero the
   * design forbids (§2, §4.3).
   */
  n_pre_epoch: number;
  /** Priced rows whose Work-CET is NULL: the ref_model itself has no price row. */
  n_no_ref: number;
  ref_model: string | null;
}

const PRE_EPOCH_SQL = `
SELECT COUNT(*) AS n FROM v_request_live r
WHERE r.model_family IN (SELECT family FROM model_price)
  AND NOT EXISTS (SELECT 1 FROM model_price p
                  WHERE p.family = r.model_family AND p.effective_from <= r.ts)
`;

/** §4.3: unpriced rows degrade a ROW's usability, never the pipeline. Counted here. */
export function unpricedSummary(db: Database): UnpricedSummary {
  const n =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_unpriced").get()?.n ?? 0;
  const families = db
    .query<{ model_family: string }, []>(
      "SELECT DISTINCT model_family FROM v_unpriced ORDER BY model_family",
    )
    .all()
    .map((r) => r.model_family);
  const preEpoch = db.query<{ n: number }, []>(PRE_EPOCH_SQL).get()?.n ?? 0;
  const noRef =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_wcet WHERE wcet IS NULL").get()?.n ?? 0;
  return {
    n_req: n,
    families,
    n_pre_epoch: preEpoch,
    n_no_ref: noRef,
    ref_model: getConfig(db, "ref_model"),
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const NUM = new Intl.NumberFormat("en-US");

function num(n: number): string {
  return NUM.format(Math.round(n));
}
function usd(n: number): string {
  return n >= 100 ? `$${NUM.format(Math.round(n))}` : `$${n.toFixed(2)}`;
}
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Fixed-width table. Column 0 left-aligned (labels), the rest right (numbers). */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length), 0),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function spendTable(title: string, rows: readonly SpendRow[]): string {
  if (rows.length === 0) return `${title}\n  (no priced requests — see the unpriced note below)`;
  const body = rows.map((r) => [
    r.key,
    num(r.n_req),
    num(r.wcet),
    num(r.scet),
    usd(r.usd),
    num(r.in_tok),
    num(r.out_tok),
    num(r.cw_tok),
    num(r.cr_tok),
  ]);
  const total = rows.reduce(
    (a, r) => ({
      n_req: a.n_req + r.n_req,
      wcet: a.wcet + r.wcet,
      scet: a.scet + r.scet,
      usd: a.usd + r.usd,
      in_tok: a.in_tok + r.in_tok,
      out_tok: a.out_tok + r.out_tok,
      cw_tok: a.cw_tok + r.cw_tok,
      cr_tok: a.cr_tok + r.cr_tok,
    }),
    { n_req: 0, wcet: 0, scet: 0, usd: 0, in_tok: 0, out_tok: 0, cw_tok: 0, cr_tok: 0 },
  );
  body.push([
    "TOTAL",
    num(total.n_req),
    num(total.wcet),
    num(total.scet),
    usd(total.usd),
    num(total.in_tok),
    num(total.out_tok),
    num(total.cw_tok),
    num(total.cr_tok),
  ]);
  const table = renderTable(
    ["", "requests", "Work-CET", "Spend-CET", "USD", "input", "output", "cache_w", "cache_r"],
    body,
  );
  return `${title}\n${table.replace(/^/gm, "  ")}`;
}

function sweepSummary(r: SweepReport): string {
  const lines = [
    `swept ${r.sessions.ingested}/${r.sessions.total} session(s) in ${r.elapsed_ms} ms` +
      (r.sessions.skipped > 0 ? ` (${r.sessions.skipped} unchanged)` : "") +
      (r.sessions.empty > 0 ? ` (${r.sessions.empty} with no readable artefact)` : "") +
      (r.full ? " [full re-read]" : ""),
    `corpus  ${num(r.corpus.files)} files, ${bytes(r.corpus.bytes)}, ${num(r.corpus.sessions)} sessions` +
      (r.corpus.oldest_mtime === null ? "" : `, oldest ${r.corpus.oldest_mtime.slice(0, 10)}`),
    `rows    ${num(r.rows.requests)} request, ${num(r.rows.turns)} turn, ${num(r.rows.agent_runs)} agent_run, ` +
      `${num(r.rows.workflow_runs)} workflow_run, ${num(r.rows.workflow_phases)} workflow_phase, ` +
      `${num(r.rows.task_events)} task_event`,
    `parsed  ${num(r.parse.parsed)}/${num(r.parse.lines)} lines` +
      (r.parse.malformed > 0 ? `, ${r.parse.malformed} malformed` : "") +
      (r.parse.truncatedTail > 0 ? `, ${r.parse.truncatedTail} truncated tail(s)` : ""),
  ];
  if (r.sidechain_replays > 0) {
    lines.push(
      `replay  ${num(r.sidechain_replays)} request(s) demoted to attr='replay' (§5.2 message_id pass) — kept for audit, excluded from every sum`,
    );
  }
  if (r.files_incomplete > 0) {
    lines.push(
      `PARTIAL ${r.files_incomplete} file(s) could not be read to EOF; their watermarks were NOT advanced, so the next sweep re-reads them`,
    );
  }
  if (r.anomalies.recorded > 0) {
    const kinds = Object.entries(r.anomalies.by_kind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(" ");
    lines.push(`anomaly ${r.anomalies.recorded} new (${kinds})`);
  }
  if (r.vanished.total > 0) {
    lines.push(
      `SHRINK  ${r.vanished.total} previously-swept file(s) vanished, ${r.vanished.lt_60d} seen alive inside 60d — §5.8 expects ZERO`,
    );
  }
  if (r.budget_exceeded) {
    lines.push(`BUDGET  exceeded ${r.budget_ms} ms; committed what was read — the next sweep finishes the job`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export interface Ctx {
  parsed: Parsed;
  dbPath: string;
  /** Writer lock. One per database — a second corpus needs a second lock. */
  lockPath: string;
  quiet: boolean;
  json: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
}

function lockNote(verb: string): string {
  return `est ${verb} (pid ${process.pid})`;
}

/**
 * Runtime scratch directories `est` writes into. Both are gitignored, so a fresh
 * clone lacks them and they are created here. `gates/` is deliberately absent:
 * it is committed source, and conjuring an empty one would paper over a broken
 * checkout instead of failing loudly (§2).
 */
function ensureDirs(): void {
  for (const d of ["spool", "backups"]) mkdirSync(join(ROOT, d), { recursive: true });
}

async function cmdInit(ctx: Ctx): Promise<number> {
  ensureDirs();
  // openDb() applies schema.sql when the file is uninitialised — a write, so it
  // belongs under the writer lock like every other write path (§2), and the lock
  // has to be taken BEFORE the connection is opened for that to mean anything.
  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const version = getConfig(db, "schema_version");
        const counts = db
          .query<{ requests: number; anomalies: number }, []>(
            "SELECT (SELECT COUNT(*) FROM request) AS requests, (SELECT COUNT(*) FROM anomaly) AS anomalies",
          )
          .get()!;
        if (ctx.json) {
          ctx.out(JSON.stringify({ db: ctx.dbPath, schema_version: version, ...counts }, null, 2));
        } else if (!ctx.quiet) {
          ctx.out(`estimator ready: ${ctx.dbPath} (schema_version ${version}, ${num(counts.requests)} requests)`);
        }
        return 0;
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("init") },
  );
}

async function cmdSweep(ctx: Ctx, full: boolean): Promise<number> {
  const p = ctx.parsed;
  const budgetText = flagString(p, "budget");
  let budgetMs: number | null = null;
  if (budgetText !== null) {
    budgetMs = parseDuration(budgetText);
    if (budgetMs === null) {
      ctx.err(`est: --budget: cannot parse duration "${budgetText}" (try 20s, 500ms, 2m)`);
      return 1;
    }
  }
  const root = flagString(p, "root") ?? PROJECTS_ROOT;
  const strict = flagBool(p, "strict");
  const blocking = flagBool(p, "blocking");
  const chunk = flagInt(p, "chunk", 25);

  const db = openDb({ path: ctx.dbPath });
  try {
    // --blocking waits for the lock instead of stepping aside — the SessionEnd
    // hook must not silently skip. Waiting is capped at HALF the budget so a
    // contended lock cannot eat the whole 20 s and leave nothing for the sweep;
    // whatever the wait costs is then subtracted from the sweep's own budget.
    const timeoutMs = blocking ? (budgetMs === null ? 30_000 : Math.min(budgetMs / 2, 10_000)) : 0;
    const tStart = Date.now();
    let report: SweepReport;
    try {
      report = await withLock(
        (): Promise<SweepReport> =>
          runSweep(db, {
            root,
            budgetMs: budgetMs === null ? null : Math.max(budgetMs - (Date.now() - tStart), 1),
            full,
            chunkSessions: chunk,
          }),
        { path: ctx.lockPath, timeoutMs, note: lockNote(full ? "backfill" : "sweep") },
      );
    } catch (e) {
      if (e instanceof LockBusyError) {
        // Not an error for a detached micro-sweep: another writer is already
        // doing this work, and every write path is idempotent.
        if (!ctx.quiet) ctx.err(`est: ${e.message}; skipping (this sweep is a no-op)`);
        return 4;
      }
      throw e;
    }

    if (ctx.json) ctx.out(JSON.stringify(report, null, 2));
    else if (!ctx.quiet) ctx.out(sweepSummary(report));

    if (full) {
      const top = flagInt(p, "top", 40);
      const models = spendByModel(db).slice(0, top);
      const origins = spendByOrigin(db);
      const unpriced = unpricedSummary(db);
      if (ctx.json) {
        ctx.out(JSON.stringify({ by_model: models, by_origin: origins, unpriced }, null, 2));
      } else if (!ctx.quiet) {
        ctx.out("");
        ctx.out(spendTable(`Work-CET / Spend-CET by model (ref_model = ${unpriced.ref_model ?? "unset"})`, models));
        ctx.out("");
        ctx.out(spendTable("Work-CET / Spend-CET by origin (§4.6)", origins));
        ctx.out("");
        if (unpriced.n_req > 0) {
          ctx.out(
            `unpriced: ${num(unpriced.n_req)} request(s) across ${unpriced.families.length} family(ies) ` +
              `are excluded from the tables above — ${unpriced.families.join(", ")}\n` +
              `          run \`est prices --sync\` and re-run \`est backfill\` (no re-parse: the DB already has the rows)`,
          );
          // A bracketed family reaching this list means `--sync` has not run since
          // the row was ingested (or the base family itself is unpriced) — NOT the
          // old structural dead end, where ingest kept the suffix and the price
          // table dropped it so no sync could ever produce a joinable row.
          const bracketed = unpriced.families.filter((f) => /\[[^\]]*\]$/.test(f));
          if (bracketed.length > 0) {
            ctx.out(
              `          NOTE: ${bracketed.join(", ")} carr${bracketed.length === 1 ? "ies" : "y"} a "[...]" context suffix. ` +
                `\`est prices --sync\` resolves these against the base family's rate (its >200k tier when the ` +
                `suffix names a window past 200k), so a sync should clear them; if it does not, the BASE family ` +
                `has no price row either.`,
            );
          }
        } else {
          ctx.out("unpriced: 0 requests — every observed model family has a price row.");
        }
        if (unpriced.n_pre_epoch > 0) {
          ctx.out(
            `pre-epoch: ${num(unpriced.n_pre_epoch)} request(s) are older than the earliest price row for their ` +
              `own family, so they fall out of BOTH tables above and out of the unpriced count. ` +
              `Backdate a price row (\`est prices --set\`) if that spend needs to be included.`,
          );
        }
        if (unpriced.n_no_ref > 0) {
          ctx.out(
            `WARNING:  ${num(unpriced.n_no_ref)} priced request(s) yield a NULL Work-CET because ref_model ` +
              `"${unpriced.ref_model ?? "unset"}" has no model_price row. Fix with \`est prices --sync\` ` +
              `or point config.ref_model at a family that does.`,
          );
        }
      }
    }

    if (report.budget_exceeded) return 3;
    if (report.anomalies.alerting > 0) return 3;
    if (strict && report.anomalies.recorded > 0) return 3;
    return 0;
  } finally {
    db.close();
  }
}

async function cmdPrices(ctx: Ctx): Promise<number> {
  const p = ctx.parsed;
  const wantSync = flagBool(p, "sync");
  const wantShow = flagBool(p, "show");
  const setModel = flagString(p, "set");

  if (!wantSync && !wantShow && setModel === null) {
    ctx.err("est prices: nothing to do — pass --sync, --show or --set <model> --in .. --out .. --cw .. --cr ..");
    return 1;
  }

  // `--at` names a VINTAGE, and both verbs that have one take it: --show reports
  // the rates in force then, --set makes a rate take effect then. It is parsed
  // ONCE, here, and rejected if unparseable, because every `effective_from <= ?`
  // in this codebase is a LEXICAL string comparison against an ISO instant —
  // a value SQLite cannot compare correctly is a wrong answer, not an error, and
  // silently reaching the wrong price row is the failure mode this whole file is
  // built to prevent. Normalised to the second, the format the DB is written in.
  const atRaw = flagString(p, "at");
  let at: Date | null = null;
  if (atRaw !== null && atRaw.trim() !== "") {
    const t = Date.parse(atRaw.trim());
    if (!Number.isFinite(t)) {
      ctx.err(
        `est prices --at: expected an ISO instant (2026-07-01 or 2026-07-01T12:00:00Z), got "${atRaw}"`,
      );
      return 1;
    }
    at = new Date(t);
  }

  const db = openDb({ path: ctx.dbPath });
  try {
    let result: SyncResult | null = null;

    if (setModel !== null) {
      // Read through a null check, not `Number(flagString(...))`: Number(null)
      // is 0, so a missing --cr would silently become a free cache-read rate.
      const rate = (name: string): number | null => {
        const raw = flagString(p, name);
        if (raw === null || raw.trim() === "") return null;
        const v = Number(raw);
        return Number.isFinite(v) && v >= 0 ? v : null;
      };
      const usd_in = rate("in");
      const usd_out = rate("out");
      const usd_cw = rate("cw");
      const usd_cr = rate("cr");
      if (usd_in === null || usd_out === null || usd_cw === null || usd_cr === null) {
        ctx.err(
          "est prices --set: all four rates are required and must be non-negative numbers: --in --out --cw --cr (USD per Mtok)",
        );
        return 1;
      }
      const rates = { usd_in, usd_out, usd_cw, usd_cr };
      const set = await withLock(
        () => setManualPrice(db, setModel, rates, { at: at ?? undefined }),
        {
          path: ctx.lockPath,
          timeoutMs: 5000,
          note: lockNote("prices --set"),
        },
      );
      if (ctx.json) {
        ctx.out(JSON.stringify(set, null, 2));
      } else if (!ctx.quiet) {
        // The vintage is printed, always. `--set` exists mostly to answer the
        // "pre-epoch" line `est backfill` prints, and the only thing that makes
        // it work is WHICH instant the row takes effect from — reporting just
        // the family left the user to guess whether the old spend got priced.
        ctx.out(
          `set manual price for family ${set.family}, effective ${set.effective_from}` +
            (set.backdated
              ? ` (backdated — it prices every request from that instant on; re-run \`est backfill\` to see them)`
              : ""),
        );
      }
    }

    if (wantSync) {
      const sourceFlag = flagString(p, "source");
      const source =
        sourceFlag === "live" || sourceFlag === "fixture" || sourceFlag === "auto" ? sourceFlag : "auto";
      if (sourceFlag !== null && source !== sourceFlag) {
        ctx.err(`est prices --source: expected auto|live|fixture, got "${sourceFlag}"`);
        return 1;
      }
      result = await withLock(() => sync(db, { source }), {
        path: ctx.lockPath,
        timeoutMs: 30_000,
        note: lockNote("prices --sync"),
      });
      if (ctx.json) {
        ctx.out(JSON.stringify(result, null, 2));
      } else if (!ctx.quiet) {
        ctx.out(
          `price sync ${result.ok ? "ok" : "FAILED"}: epoch ${result.price_epoch}, source ${result.source}, ` +
            `${result.n_families} families (${result.n_provisional} provisional), ${result.n_rows_written} row(s) written`,
        );
        for (const a of result.attempts) {
          ctx.out(`  ${a.ok ? "ok  " : "fail"} ${a.leg} n=${a.n}${a.error === undefined ? "" : ` (${a.error})`}`);
        }
        if (result.unmatched.length > 0) {
          ctx.out(`  UNMATCHED (anomaly(unpriced_model) written): ${result.unmatched.join(", ")}`);
        }
      }
    }

    if (wantShow) {
      // The same parsed instant --set uses, normalised to the second so it
      // compares against `effective_from` the way SQLite actually compares it.
      const rows = showPrices(db, at === null ? undefined : isoSeconds(at));
      if (ctx.json) {
        ctx.out(JSON.stringify(rows, null, 2));
      } else {
        ctx.out(
          renderTable(
            ["family", "from", "in", "out", "cache_w", "cache_r", "src", "prov"],
            rows.map((r) => [
              r.family,
              r.effective_from.slice(0, 10),
              String(r.usd_in),
              String(r.usd_out),
              String(r.usd_cw),
              String(r.usd_cr),
              r.source,
              r.provisional ? "yes" : "",
            ]),
          ),
        );
      }
    }

    if (result !== null && !result.ok) return 3;
    return 0;
  } finally {
    db.close();
  }
}

async function cmdCensus(ctx: Ctx): Promise<number> {
  const limit = flagInt(ctx.parsed, "limit", 10);
  const root = flagString(ctx.parsed, "root") ?? PROJECTS_ROOT;

  const db = openDb({ path: ctx.dbPath, readonly: true });
  try {
    const history = db
      .query<
        {
          swept_at: string;
          n_files: number;
          n_bytes: number;
          n_sessions: number;
          oldest_mtime: string;
          vanished_total: number;
          vanished_lt_60d: number;
        },
        [number]
      >("SELECT * FROM sweep_census ORDER BY swept_at DESC LIMIT ?")
      .all(limit);

    const counts = db
      .query<
        {
          request: number;
          turn: number;
          agent_run: number;
          workflow_run: number;
          workflow_phase: number;
          task_event: number;
          anomaly: number;
          model_price: number;
          sweep_state: number;
        },
        []
      >(
        `SELECT (SELECT COUNT(*) FROM request) AS request,
                (SELECT COUNT(*) FROM turn) AS turn,
                (SELECT COUNT(*) FROM agent_run) AS agent_run,
                (SELECT COUNT(*) FROM workflow_run) AS workflow_run,
                (SELECT COUNT(*) FROM workflow_phase) AS workflow_phase,
                (SELECT COUNT(*) FROM task_event) AS task_event,
                (SELECT COUNT(*) FROM anomaly) AS anomaly,
                (SELECT COUNT(*) FROM model_price) AS model_price,
                (SELECT COUNT(*) FROM sweep_state) AS sweep_state`,
      )
      .get()!;

    const live = discoverCorpus(root).census;
    const anomalies = db
      .query<{ kind: string; n: number }, []>(
        "SELECT kind, COUNT(*) AS n FROM anomaly GROUP BY kind ORDER BY n DESC",
      )
      .all();

    if (ctx.json) {
      ctx.out(JSON.stringify({ root, live, db: counts, anomalies, history }, null, 2));
      return 0;
    }

    ctx.out(`corpus on disk (${root})`);
    ctx.out(
      `  ${num(live.files)} files, ${bytes(live.bytes)}, ${num(live.sessions)} sessions` +
        (live.oldestMtime === null ? "" : `, oldest ${live.oldestMtime.slice(0, 10)}`),
    );
    ctx.out("");
    ctx.out("database rows");
    ctx.out(
      renderTable(
        ["table", "rows"],
        Object.entries(counts).map(([k, v]) => [k, num(v)]),
      ).replace(/^/gm, "  "),
    );
    ctx.out("");
    if (anomalies.length > 0) {
      ctx.out("anomaly ledger");
      ctx.out(renderTable(["kind", "n"], anomalies.map((a) => [a.kind, num(a.n)])).replace(/^/gm, "  "));
      ctx.out("");
    }
    ctx.out(`sweep_census (last ${history.length}; §5.8 expects vanished = 0 while both pruners are stood down)`);
    if (history.length === 0) {
      ctx.out("  (no sweeps recorded yet — run `est sweep`)");
    } else {
      ctx.out(
        renderTable(
          ["swept_at", "files", "bytes", "sessions", "oldest", "vanished", "<60d"],
          history.map((h) => [
            h.swept_at.replace("T", " ").slice(0, 19),
            num(h.n_files),
            bytes(h.n_bytes),
            num(h.n_sessions),
            h.oldest_mtime.slice(0, 10),
            num(h.vanished_total),
            num(h.vanished_lt_60d),
          ]),
        ).replace(/^/gm, "  "),
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

export const HELP = `est — token-based task estimation and tracking for Claude Code (Phase 0)

usage: est <command> [flags]

commands:
  init                    create/verify ~/.claude/estimator and the database (idempotent)
  sweep                   incremental single-writer sweep of the transcript corpus
  backfill                full re-sweep over every surviving transcript, plus a spend report
  prices                  model price table: --sync, --show, --set
  census                  sweep_census history, corpus counts and the anomaly ledger
  help, version

global flags:
  --db <path>             database file (default: $EST_DB or <estimator>/estimator.db)
  --lock <path>           writer lock file (default: $EST_LOCK or <estimator>/sweep.lock).
                          One lock per database; a second corpus needs a second lock.
  -q, --quiet             suppress the human summary (hooks)
  --json                  machine-readable output
  -h, --help              this text

sweep / backfill:
  --blocking              wait for the sweep lock instead of stepping aside (SessionEnd hook)
  --budget <dur>          wall-clock budget, e.g. 20s. On expiry the sweep COMMITS what it has
                          and logs anomaly(sweep_budget_exceeded); the next sweep finishes.
  --root <path>           corpus root (default: $EST_PROJECTS or ~/.claude/projects)
  --chunk <n>             sessions per write transaction (default 25)
  --strict                exit non-zero for ANY new anomaly, not just alerting ones
  --top <n>               (backfill) rows per summary table

prices:
  --sync                  refresh from LiteLLM (primary) / models.dev (secondary) / snapshots
  --source auto|live|fixture
  --show [--at <iso>]     the rate in force per family, at that vintage (default: now)
  --set <model> --in <usd> --out <usd> --cw <usd> --cr <usd>   manual override, USD per Mtok
  --at <iso>              (with --set) the vintage the rate takes effect FROM — this is how
                          you answer backfill's "pre-epoch" line and price old requests.
                          Omitted: a family's first-ever rate covers all history, a later
                          one takes effect now.

census:
  --limit <n>             sweep_census rows to show (default 10)
  --root <path>

exit codes: 0 ok · 1 usage/fatal · 3 anomalies recorded or budget exceeded · 4 lock held
`;

export interface RunOptions {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/** The whole CLI, minus process exit — importable, so tests drive it directly. */
export async function run(argv: readonly string[], io: RunOptions = {}): Promise<number> {
  const out = io.out ?? ((s: string) => console.log(s));
  const err = io.err ?? ((s: string) => console.error(s));
  const parsed = parseArgs(argv);

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) err(`est: ${e}`);
    err("run `est help` for usage");
    return 1;
  }
  if (flagBool(parsed, "version") || parsed.command === "version") {
    out("est 0.1.0 (estimator Phase 0)");
    return 0;
  }
  if (parsed.command === null || parsed.command === "help" || flagBool(parsed, "help")) {
    out(HELP);
    return parsed.command === null && !flagBool(parsed, "help") ? 1 : 0;
  }

  const ctx: Ctx = {
    parsed,
    dbPath: flagString(parsed, "db") ?? DB_PATH,
    lockPath: flagString(parsed, "lock") ?? LOCK_PATH,
    quiet: flagBool(parsed, "quiet"),
    json: flagBool(parsed, "json"),
    out,
    err,
  };

  try {
    switch (parsed.command) {
      case "init":
        return await cmdInit(ctx);
      case "sweep":
        return await cmdSweep(ctx, false);
      case "backfill":
        return await cmdSweep(ctx, true);
      case "prices":
        return await cmdPrices(ctx);
      case "census":
        return await cmdCensus(ctx);
      default:
        out(HELP);
        return 1;
    }
  } catch (e) {
    // §2 loud failures: never a stack trace swallowed into a zero exit.
    err(`est: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}

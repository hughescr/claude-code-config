/**
 * src/census.ts — the corpus-loss ledger (§5.8 v9 fix) and the discovery-side
 * probe (D2) beyond the sweep's pre-existing watermark diff (D1, still in
 * `runSweep`, src/cli.ts).
 *
 * ROOT CAUSE (§5.8, DECISIONS.md finding 6): D1 diffs `sweep_state` — paths this
 * database has already watermarked — against what discovery finds today. A
 * transcript deleted BEFORE it was ever watermarked leaves no `sweep_state` row to
 * diff against, so its loss was UNREPRESENTABLE, not merely unreported. Evidence
 * from the live corpus: 9 sessions retained only their sub-agent transcript (never
 * their main), each with exactly one `sweep_state` row (the survivor), and 35
 * sweeps recorded `vanished_total = 0` for all of them.
 *
 * D2 (this module) consumes `Corpus.lostSessions` (src/discover.ts): a session-id
 * shaped artefact dir survives with zero main transcripts anywhere in the corpus,
 * computed CORPUS-WIDE so a session spanning several munged project dirs is not a
 * false positive. D2 needs the artefact dir to still exist; it cannot see a
 * session whose whole directory was also removed — that is the reserved D3 shape
 * (a ledger-wide session probe), deliberately NOT implemented here because it
 * requires comparing the WHOLE `request`/`agent_run` ledger against ONE sweep's
 * `--root`, which is unsound unless that root is provably the entire real corpus
 * (see the module doc on `censusCollapseGuard` for the guard D2 gets instead).
 *
 * Both write to `corpus_loss`, a durable ledger of ONE OPEN EPISODE PER PATH: a
 * path is recorded lost by the first sweep that notices, every later sweep is a
 * no-op while that episode stays open (the idempotence promise §2 makes for
 * `sweep_state`/`anomaly`), a restore RETRACTS it by setting `resolved_at`, and a
 * later re-loss of the same path RE-OPENS the row with fresh evidence. A false
 * positive is never DELETEd: `corpus_loss` is a sweeper-observation ledger, and
 * erasing "we saw it gone" is the same category of act the append-only doctrine
 * forbids on `estimate`/`outcome`. Retraction is symmetric with detection — D2's
 * session-keyed rows retract on discovery finding the main again, D1's path-keyed
 * rows on the path being back in the sweep's `onDisk` set.
 */

import type { Database } from "bun:sqlite";
import { getConfig } from "./db.ts";
import { SESSION_ID_RE, type Corpus } from "./discover.ts";

export type LossKind = "main" | "agent" | "state" | "unknown";
export type DetectedBy = "watermark_diff" | "discovery_probe" | "ledger_probe";
export type AgeSource = "mtime" | "last_swept" | "ledger_ts" | "unknown";

export interface LossCandidate {
  path: string;
  sessionId: string | null;
  kind: LossKind;
  detectedBy: DetectedBy;
  /** When THIS sweep first noticed the absence — usually `swept_at`. */
  firstMissingAt: string;
  /** Best "last known alive" instant available, for age classification only. */
  lastSeenAt: string | null;
  mtime: string | null;
  ageSource: AgeSource;
}

export interface ClassifiedLoss extends LossCandidate {
  /** age >= config.retention_days at detection time. */
  expected: boolean;
}

export interface CensusConfig {
  retentionDays: number;
  vanishAlarmDays: number;
  collapsePct: number;
}

const DEFAULTS: CensusConfig = { retentionDays: 365, vanishAlarmDays: 60, collapsePct: 20 };

/** Every calibration constant here is a CONVENTION seeded in schema.sql (§1.1);
 *  this reads the live values so `est config set` takes effect without a redeploy. */
export function readCensusConfig(db: Database): CensusConfig {
  const num = (key: string, fallback: number): number => {
    const raw = getConfig(db, key);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    retentionDays: num("retention_days", DEFAULTS.retentionDays),
    vanishAlarmDays: num("vanish_alarm_days", DEFAULTS.vanishAlarmDays),
    collapsePct: num("census_collapse_pct", DEFAULTS.collapsePct),
  };
}

/**
 * age >= retentionDays => EXPECTED (retention reaping, benign). An UNKNOWN age is
 * never expected — the same conservative choice D1's pre-fix comment already
 * makes (cli.ts): the failure mode of guessing wrong must be a false ALARM, never
 * a missed one.
 */
export function isExpected(ageDays: number | null, cfg: CensusConfig): boolean {
  return ageDays !== null && ageDays >= cfg.retentionDays;
}

/** Age in days from an ISO instant to `now`. Null when unparseable/absent — the
 *  caller must treat that as UNKNOWN, not as zero (which would read as fresh and
 *  therefore maximally alarming; the deliberately conservative direction). */
export function ageDaysFrom(instant: string | null, now: Date): number | null {
  if (instant === null) return null;
  const ms = now.getTime() - Date.parse(instant);
  return Number.isFinite(ms) ? ms / 86_400_000 : null;
}

/**
 * Classify a session-id-shaped path's role from its shape alone (no file exists
 * to stat) — main transcript, agent transcript, workflow state, or unrecognised.
 * Mirrors the shapes `sessionFiles` (src/discover.ts) enumerates.
 */
export function classifyPathKind(path: string): LossKind {
  const base = path.split("/").pop() ?? path;
  if (SESSION_ID_RE.test(base.replace(/\.jsonl$/, ""))) return "main";
  if (/^agent-.+\.jsonl$/.test(base) && path.includes("/subagents/")) return "agent";
  if (/\.json$/.test(base) && path.includes("/workflows/")) return "state";
  return "unknown";
}

export interface CollapseGuardResult {
  collapsed: boolean;
  detail: string | null;
}

/**
 * D2's sanity precondition (§5.8 risk #1, the mirror-image failure of the bug
 * this module fixes): a discovery outage — bad `--root`, unmounted volume, wrong
 * `EST_PROJECTS` — must not be laundered into hundreds of durable `corpus_loss`
 * rows and one enormous `corpus_shrink`. Trips when the session count dropped
 * more than `collapsePct`% against the PREVIOUS `sweep_census` row (read before
 * this sweep's own row is written).
 *
 * NO PRIOR ROW, or a prior row that was ALREADY at zero sessions, is never a
 * collapse — it is either this database's first-ever sweep, or a corpus that
 * has genuinely always been empty (a fresh `--root`, a test fixture with no
 * transcripts yet). Both are ordinary, not evidence of an outage; there is
 * nothing to drop FROM. A real collapse (session count going from N > 0 to 0)
 * is already a 100% drop, which the percentage check below catches on its own —
 * there is deliberately no separate "discovery found zero files" branch, because
 * that branch could not tell "first sweep of nothing" from "just lost everything"
 * apart, and the sweep_census comparison already can.
 */
export function checkCensusCollapse(
  db: Database,
  corpus: Corpus,
  cfg: CensusConfig,
): CollapseGuardResult {
  const prev = db
    .query<{ n_sessions: number }, []>(
      "SELECT n_sessions FROM sweep_census ORDER BY swept_at DESC LIMIT 1",
    )
    .get();
  if (prev === null || prev.n_sessions === 0) return { collapsed: false, detail: null };
  const dropPct = ((prev.n_sessions - corpus.census.sessions) / prev.n_sessions) * 100;
  if (dropPct > cfg.collapsePct) {
    return {
      collapsed: true,
      detail: `discovered ${corpus.census.sessions} session(s), down ${dropPct.toFixed(1)}% from the previous sweep's ${prev.n_sessions} (guard: census_collapse_pct=${cfg.collapsePct})`,
    };
  }
  return { collapsed: false, detail: null };
}

/**
 * Best-effort "last known alive" bound from the ledger a lost session already fed
 * (`request`/`agent_run`), for AGE CLASSIFICATION ONLY. This is narrower than the
 * reserved D3 (a full ledger-wide session probe cross-referenced against
 * discovery): it is keyed on a session id D2 already knows discovery found
 * artefacts for, so it carries none of D3's "compares the whole ledger against
 * one root" scoping hazard and needs no extra guard.
 */
function ledgerLastSeen(db: Database, sessionId: string): string | null {
  const row = db
    .query<{ ts: string | null }, [string, string]>(
      `SELECT MAX(ts) AS ts FROM (
         SELECT MAX(ts) AS ts FROM request WHERE session_id = ?
         UNION ALL
         SELECT MAX(started_at) AS ts FROM agent_run WHERE session_id = ?
       )`,
    )
    .get(sessionId, sessionId);
  return row?.ts ?? null;
}

/**
 * D2 — build one loss candidate per `corpus.lostSessions` entry. Pure function of
 * `corpus` plus one narrow, per-id ledger lookup for age purposes; call
 * `checkCensusCollapse` first and skip this entirely when it trips.
 */
export function discoveryLossCandidates(
  db: Database,
  corpus: Corpus,
  sweptAt: string,
): LossCandidate[] {
  return corpus.lostSessions.map((s) => {
    const lastSeen = ledgerLastSeen(db, s.sessionId);
    return {
      path: s.expectedPath,
      sessionId: s.sessionId,
      kind: "main" as const,
      detectedBy: "discovery_probe" as const,
      firstMissingAt: sweptAt,
      lastSeenAt: lastSeen,
      mtime: null,
      ageSource: lastSeen === null ? ("unknown" as const) : ("ledger_ts" as const),
    };
  });
}

/** Apply `isExpected` using each candidate's own best age bound. */
export function classifyLosses(
  candidates: readonly LossCandidate[],
  cfg: CensusConfig,
  now: Date,
): ClassifiedLoss[] {
  return candidates.map((c) => {
    const days = ageDaysFrom(c.mtime ?? c.lastSeenAt, now);
    return { ...c, expected: isExpected(days, cfg) };
  });
}

const INSERT_CORPUS_LOSS_SQL = `
INSERT INTO corpus_loss
  (path, session_id, kind, detected_by, first_missing_at, last_seen_at, mtime, age_source, expected)
VALUES
  ($path, $session_id, $kind, $detected_by, $first_missing_at, $last_seen_at, $mtime, $age_source, $expected)
ON CONFLICT(path) DO UPDATE SET
  session_id = excluded.session_id,
  kind = excluded.kind,
  detected_by = excluded.detected_by,
  first_missing_at = excluded.first_missing_at,
  last_seen_at = excluded.last_seen_at,
  mtime = excluded.mtime,
  age_source = excluded.age_source,
  expected = excluded.expected,
  resolved_at = NULL
WHERE corpus_loss.resolved_at IS NOT NULL
`;

/**
 * Write every classified loss to `corpus_loss`, one OPEN EPISODE per path.
 *
 * The conflict clause is the whole subtlety. `DO NOTHING` gave idempotence — the
 * first sweep to see a path records it, every later sweep no-ops — but it also
 * made a path's SECOND disappearance unrepresentable: once a restore had set
 * `resolved_at`, a genuine re-loss hit the conflict, changed nothing, and the row
 * went on reading "resolved" while the file was gone. The loss was not merely
 * unreported, it was contradicted by the ledger, and `est retro`'s
 * `WHERE resolved_at IS NULL` count agreed with the ledger rather than with disk.
 *
 * `DO UPDATE ... WHERE corpus_loss.resolved_at IS NOT NULL` re-opens exactly that
 * row and no other: an OPEN row is left byte-for-byte alone (so a re-sweep is
 * still a no-op and `insertedCount` still answers "did anything change"), and a
 * RESOLVED row is restated as a fresh episode with this sweep's own evidence.
 * The invariant `corpus_loss` now carries is "one row per path, describing its
 * CURRENT episode" — see the table's comment in schema.sql.
 *
 * Still not `INSERT OR IGNORE`, for the original reason: that would also swallow a
 * CHECK violation on a bad `kind`/`age_source`, which is a real bug rather than a
 * benign duplicate.
 *
 * Returns how many rows were newly inserted OR re-opened by this call, which is
 * what makes "a re-sweep adds no `corpus_loss` row" (T2) assertable.
 */
export function writeCorpusLoss(db: Database, losses: readonly ClassifiedLoss[]): number {
  if (losses.length === 0) return 0;
  const stmt = db.prepare(INSERT_CORPUS_LOSS_SQL);
  let inserted = 0;
  for (const l of losses) {
    const res = stmt.run({
      $path: l.path,
      $session_id: l.sessionId,
      $kind: l.kind,
      $detected_by: l.detectedBy,
      $first_missing_at: l.firstMissingAt,
      $last_seen_at: l.lastSeenAt,
      $mtime: l.mtime,
      $age_source: l.ageSource,
      $expected: l.expected ? 1 : 0,
    } as never);
    if (Number(res.changes ?? 0) > 0) inserted += 1;
  }
  return inserted;
}

const RESOLVE_BY_SESSION_SQL = `
UPDATE corpus_loss SET resolved_at = $resolved_at
WHERE detected_by = 'discovery_probe' AND resolved_at IS NULL AND session_id = $session_id
`;

const RESOLVE_BY_PATH_SQL = `
UPDATE corpus_loss SET resolved_at = $resolved_at
WHERE detected_by <> 'discovery_probe' AND resolved_at IS NULL AND path = $path
`;

/**
 * Retract a loss the moment the thing it describes is back — a restore, a
 * remount, a false positive from an earlier bug. Append, never DELETE (see the
 * module doc).
 *
 * TWO retraction rules, because the two detectors record two different KINDS of
 * evidence and a single rule could only ever serve one of them:
 *
 *  - **D2 (`discovery_probe`) is session-keyed.** Its claim is "this session has
 *    no main transcript anywhere in the corpus", so the retraction is "discovery
 *    found one this sweep". Only sessions discovery ACTUALLY found a main for are
 *    resolved; a session simply outside this sweep's `--root` must not read as
 *    "found again".
 *  - **D1 (`watermark_diff`) is path-keyed, and may carry a NULL `session_id`
 *    entirely** (a sub-agent transcript or a workflow state file resolves to no
 *    session). Retracting it by session reached none of those rows, so a D1 row
 *    could never be resolved by anything — including the false positives a
 *    discovery outage used to manufacture, which then sat in `est retro`'s
 *    `corpus_loss_unexplained` forever for files demonstrably back on disk. The
 *    retraction is therefore PATH presence: `onDisk` is the same discovery-derived
 *    set D1 itself diffs against, so "back on disk" is decided by exactly the
 *    evidence that decided "gone", and a path outside this sweep's root is absent
 *    from it and correctly left alone.
 */
export function resolveReappeared(
  db: Database,
  corpus: Corpus,
  sweptAt: string,
  onDisk: ReadonlySet<string> = new Set(),
): number {
  let resolved = 0;

  const stillLost = new Set(corpus.lostSessions.map((s) => s.sessionId));
  const openSessions = db
    .query<{ session_id: string }, []>(
      `SELECT DISTINCT session_id FROM corpus_loss
       WHERE detected_by = 'discovery_probe' AND resolved_at IS NULL AND session_id IS NOT NULL`,
    )
    .all();
  if (openSessions.length > 0) {
    const foundMain = new Map(
      corpus.sessions.map((s) => [s.sessionId, s.mainTranscripts.length > 0]),
    );
    const stmt = db.prepare(RESOLVE_BY_SESSION_SQL);
    for (const row of openSessions) {
      if (stillLost.has(row.session_id)) continue;
      if (foundMain.get(row.session_id) !== true) continue; // not this sweep's business
      const res = stmt.run({ $resolved_at: sweptAt, $session_id: row.session_id } as never);
      if (Number(res.changes ?? 0) > 0) resolved += 1;
    }
  }

  const openPaths = db
    .query<{ path: string }, []>(
      `SELECT path FROM corpus_loss
       WHERE detected_by <> 'discovery_probe' AND resolved_at IS NULL`,
    )
    .all();
  if (openPaths.length > 0 && onDisk.size > 0) {
    const stmt = db.prepare(RESOLVE_BY_PATH_SQL);
    for (const row of openPaths) {
      if (!onDisk.has(row.path)) continue;
      const res = stmt.run({ $resolved_at: sweptAt, $path: row.path } as never);
      if (Number(res.changes ?? 0) > 0) resolved += 1;
    }
  }

  return resolved;
}

export interface CorpusLossProbeResult {
  /** Losses newly recorded THIS sweep (excludes paths `corpus_loss` already had). */
  newLosses: ClassifiedLoss[];
  insertedCount: number;
  resolvedCount: number;
  collapsed: boolean;
  collapseDetail: string | null;
}

export interface CorpusLossProbeOptions {
  /**
   * Every path discovery found this sweep — `runSweep`'s own `onDisk` set. Used
   * ONLY to retract path-keyed (D1) losses; absent, those rows are left open,
   * which is the same conservative direction the rest of this module takes.
   */
  onDisk?: ReadonlySet<string>;
  /**
   * The collapse guard, already evaluated by the caller. `runSweep` must gate D1's
   * OWN persistence on the same verdict, so it computes it once and hands it in
   * rather than letting this function reach a second, independent conclusion.
   * Omitted, the guard is evaluated here — the standalone/test path.
   */
  guard?: CollapseGuardResult;
}

/**
 * D2, end to end: guard, detect, classify, write, retract. Call from inside the
 * sweep's own write transaction (`runSweep`, src/cli.ts) so a `corpus_loss` write
 * commits atomically with the `sweep_census` row it is reported alongside.
 */
export function runCorpusLossProbe(
  db: Database,
  corpus: Corpus,
  sweptAt: string,
  now: Date,
  opts: CorpusLossProbeOptions = {},
): CorpusLossProbeResult {
  const cfg = readCensusConfig(db);
  const guard = opts.guard ?? checkCensusCollapse(db, corpus, cfg);
  if (guard.collapsed) {
    return {
      newLosses: [],
      insertedCount: 0,
      resolvedCount: 0,
      collapsed: true,
      collapseDetail: guard.detail,
    };
  }

  // OPEN losses only. Built from every row (resolved ones included), a path whose
  // resolution had already been recorded could never become "new" again, so a
  // genuine second disappearance raised no `corpus_shrink` and never reached
  // `report.vanished` — the ledger's own re-open path (see `writeCorpusLoss`) had
  // no observable effect.
  const alreadyKnown = new Set(
    db
      .query<{ path: string }, []>("SELECT path FROM corpus_loss WHERE resolved_at IS NULL")
      .all()
      .map((r) => r.path),
  );
  const classified = classifyLosses(discoveryLossCandidates(db, corpus, sweptAt), cfg, now);
  const newLosses = classified.filter((c) => !alreadyKnown.has(c.path));
  const insertedCount = writeCorpusLoss(db, classified);
  const resolvedCount = resolveReappeared(db, corpus, sweptAt, opts.onDisk ?? new Set());

  return { newLosses, insertedCount, resolvedCount, collapsed: false, collapseDetail: null };
}

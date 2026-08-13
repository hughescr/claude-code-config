/**
 * G-ATTR — the LIVE re-gate (design/GATE-LIVE-SEMANTICS.md, "GLS" below).
 *
 * Question: does the pipeline that is ACTUALLY RUNNING — `src/attribute.ts`, over
 * `est`-opened tasks, reading the DB's own `request.attr` — attribute enough Work-CET
 * to tasks to license calibration? Threshold: `exclusive ∪ sticky` Work-CET coverage
 * < 70% ⇒ P2.11 (calibration maturation) stays deferred.
 *
 * This is a REWRITE, not a re-run of the 2026-07-28 gate (`gates/g-attr.json`, frozen;
 * never overwritten by this file). That gate measured a hypothesis — R3's sticky
 * last-touched rule, inferred from the harness `TaskCreate`/`TaskUpdate` stream — on a
 * corpus with no `est` ceremony in it. Every one of its defining choices is now
 * contradicted by the shipped pass (GLS §0):
 *
 *   - the candidate task set is `task_alias`, not every harness `TaskCreate` (GLS D6);
 *   - `sticky` has no writer in `src/attribute.ts` at all — it is carried in the
 *     `Attr` union and in this gate's predicates for when one arrives, and is
 *     reported as identically zero until then (GLS §7.1);
 *   - the headline is `request.attr`, the column calibration actually reads, not a
 *     second implementation of the turn walk built to grade it (GLS D1/D2).
 *
 * **What changed from the July script, decision by decision:**
 *
 *  - D1/D2 — headline = `request.attr` in the live DB. The transcript recompute is
 *    DROPPED as a coverage variant (two implementations of one rule is two answers,
 *    and the second is untested); transcripts are still read, but only for the X1
 *    ingest-completeness cross-check below.
 *  - D3 — denominator = tracked sessions, `origin IN ('main','subagent')`, non-replay,
 *    non-overhead (`src/retro.ts`'s `attrBaseFilter`, exported and imported here so the
 *    number that licenses calibration is defined exactly once).
 *  - D4 — currency = priced Work-CET (`v_wcet.wcet`), because that is what
 *    `v_task_actual`/calibration consume; unweighted counters are a sensitivity row.
 *  - D5 — window = `--since` (default: the story-point cutover, 2026-08-01), reported
 *    per epoch when `--hook-merge <ts>` is given.
 *  - D6-D8 — the candidate set is `task_alias`, not a harness todo census; the gate
 *    reports the task-population census (opened/finalized/still-open/alias mix/never
 *    attributed) instead of todo-list hygiene.
 *  - D9 — `coverage_ex_hook` (a shadow copy with `source='hook'` aliases deleted, then
 *    `attributeTasks` re-run — never a contaminated "does the tid match" query, GLS
 *    §3/HOOK-BINDING-SPEC §9.3 V7) and `hook_lift = live − ex_hook`. PASS additionally
 *    requires `hook_bind_conflict = 0` and `alias_split_identity = 0`.
 *  - D10 — staleness is measured at the SHIPPED config, plus a small sensitivity grid
 *    over `attr_stale_turns`/`attr_stale_minutes`, each on its own temp copy, plus
 *    `stale_closed_share`.
 *  - D11-D12 — the 2026-07 ladder is FROZEN. `--legacy-r3` reproduces it verbatim on
 *    today's corpus (unrelated to the live headline); the live series' first
 *    comparable point is `E′` (bridge rung, printed alongside the live ladder).
 *  - D14 — PASS prints the licensing text verbatim; it licenses nothing about the
 *    binder, nothing about velocity alone, and nothing about `ambiguous` (L3 vs L4 are
 *    both reported, and disagreeing is the open, blocking question GLS §5 names).
 *
 * **Read-only over the live DB and transcripts.** The live DB is opened
 * `readonly: true` and never written; every recompute that needs to WRITE (the D9
 * shadow, the D10 grid) runs against a `VACUUM INTO` temp copy, made once per run and
 * deleted before exit. Writes nothing but its own stdout and, if `--json <path>` is
 * given, that one file — never `gates/g-attr.json`, the 2026-07-28 baseline.
 *
 * Usage:
 *   bun run gates/g-attr.ts [--db path] [--since ISO] [--hook-merge ISO]
 *                           [--json out.json] [--skip-x1] [--limit-sessions N]
 *   bun run gates/g-attr.ts --legacy-r3 [--json out.json] [--limit N]   # frozen 2026-07 ladder
 *
 * `--json` refuses to target the frozen `gates/g-attr.json` baseline (this file's own
 * directory) unless `--force` is also given — see `guardJsonOut`/`FROZEN_BASELINE_PATH`.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, getConfig, setConfig, DB_PATH } from "../src/db.ts";
import { attributeTasks, attrWindow } from "../src/attribute.ts";
import {
  attrBaseFilter,
  ATTR_COVERAGE_CLASSES,
  ATTR_COVERAGE_GATE,
  LIVE_TRACKED_SESSIONS_SQL,
} from "../src/retro.ts";
import { discoverCorpus, type SessionCorpus } from "../src/discover.ts";
import { ingestSession, readJsonl, type RequestRow } from "../src/ingest.ts";
import { TurnSegmenter, type TranscriptLine } from "../src/segment.ts";

const CUTOVER_DEFAULT = "2026-08-01T00:00:00Z";

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

function num(db: Database, sql: string, params: (string | number)[] = []): number {
  const row = db.query<{ v: number | null }, (string | number)[]>(sql).get(...params);
  return row?.v ?? 0;
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---------------------------------------------------------------------------
// frozen-baseline write guard — see file header: "never gates/g-attr.json, the
// 2026-07-28 baseline". Nothing upstream of `--json` enforced that promise; a
// habitual `--json gates/g-attr.json` from the `estimator/` cwd (the most natural
// name for THIS gate's own output) silently destroys the one artifact the whole
// D11/D12 comparability story depends on, and it is gitignored — unrecoverable
// from git. Resolved from `import.meta.dir` (this file's own directory), not the
// process cwd, so the guard holds regardless of where the gate is invoked from.
// ---------------------------------------------------------------------------

export const FROZEN_BASELINE_PATH = resolve(import.meta.dir, "g-attr.json");

export class FrozenBaselineWriteError extends Error {
  constructor(target: string) {
    super(
      `refusing to write ${target} -- this resolves to the frozen 2026-07-28 G-ATTR ` +
        `baseline (${FROZEN_BASELINE_PATH}). Overwriting it destroys the D11/D12 ` +
        `comparability story this gate depends on, and it is gitignored (unrecoverable ` +
        `from git). Pass --force to overwrite it anyway, or choose a different --json path.`,
    );
    this.name = "FrozenBaselineWriteError";
  }
}

/** Throws unless `force` is set and `jsonOut` does not resolve to the frozen baseline. */
export function guardJsonOut(jsonOut: string, force: boolean): void {
  if (resolve(jsonOut) === FROZEN_BASELINE_PATH && !force) {
    throw new FrozenBaselineWriteError(jsonOut);
  }
}

// ---------------------------------------------------------------------------
// D1-D5: the live headline, computed straight off `v_wcet`/`request.attr`
// ---------------------------------------------------------------------------

export interface AttrWindowArg {
  since: string;
  /** Exclusive — a half-open window, so `[cutover, hook-merge)` + `[hook-merge, now]` tile. */
  until?: string;
}

export interface ClassTotals {
  exclusive: number;
  sticky: number;
  ambiguous: number;
  pre_task: number;
  none: number;
  overhead: number;
  total: number;
}

function zeroTotals(): ClassTotals {
  return { exclusive: 0, sticky: 0, ambiguous: 0, pre_task: 0, none: 0, overhead: 0, total: 0 };
}

const COVERAGE_KEYS: readonly (keyof ClassTotals)[] = ATTR_COVERAGE_CLASSES;

function coverageNumerator(t: ClassTotals): number {
  let n = 0;
  for (const k of COVERAGE_KEYS) n += t[k];
  return n;
}

/** `SUM(<expr>)` grouped by `attr`, over an arbitrary WHERE clause on `v_wcet`. */
function classTotalsExpr(
  db: Database,
  expr: string,
  whereSql: string,
  params: (string | number)[],
): ClassTotals {
  const rows = db
    .query<{ attr: string; v: number | null }, (string | number)[]>(
      `SELECT attr, SUM(${expr}) AS v FROM v_wcet WHERE ${whereSql} GROUP BY attr`,
    )
    .all(...params);
  const t = zeroTotals();
  const byClass = t as unknown as Record<string, number>;
  for (const r of rows) {
    const v = r.v ?? 0;
    if (r.attr in t) byClass[r.attr] = v;
    t.total += v;
  }
  return t;
}

function classTotals(db: Database, whereSql: string, params: (string | number)[]): ClassTotals {
  return classTotalsExpr(db, "wcet", whereSql, params);
}

export interface Headline {
  window: AttrWindowArg;
  /** L0 — all window Work-CET, tracked AND untracked sessions, all origins, `replay` excluded. */
  L0: ClassTotals;
  /** L1 — L0 restricted to tracked sessions (GLS D3's re-base). */
  L1: ClassTotals;
  /** L2 — the calibration-eligible base (GLS D3): + non-overhead, origins main/subagent. */
  L2: ClassTotals;
  /** L3 — `exclusive ∪ sticky` over L2. THE HEADLINE. */
  coverage_pct: number;
  /** L4 — L3 + `ambiguous` over L2 — what `v_task_actual` actually sums today (GLS §5 cl.4). */
  ambiguous_incl_pct: number;
  /** E′ — the one rung comparable to 2026-07's 18.7% (GLS D12): `exclusive ∪ sticky`
   *  over L0's whole-window denominator, live attribution rule, in the SAME currency
   *  as the frozen July number (`out_tok + cw_tok`, unweighted — July had no price
   *  table, D4). D12 promises this rung changes ONLY the attribution rule; moving the
   *  currency too would make it a two-variable comparison wearing a one-variable
   *  label. `e_prime_priced_pct` is the priced-wcet variant of the SAME L0 population,
   *  reported alongside as the sensitivity row that separates a currency shift from a
   *  rule shift on this rung — it is NOT what "E′" means elsewhere in this file. */
  e_prime_pct: number;
  /** L0, `exclusive ∪ sticky`, priced Work-CET — E′'s currency-sensitivity companion. */
  e_prime_priced_pct: number;
}

export function computeHeadline(
  db: Database,
  w: AttrWindowArg,
  opts: { trackedSessionsSql?: string } = {},
): Headline {
  const untilClause = w.until !== undefined ? " AND ts < ?" : "";
  const winParams: (string | number)[] = w.until !== undefined ? [w.since, w.until] : [w.since];
  const trackedSessionsSql = opts.trackedSessionsSql ?? LIVE_TRACKED_SESSIONS_SQL;
  const l0Where = `ts >= ?${untilClause} AND attr <> 'replay'`;

  const L0 = classTotals(db, l0Where, winParams);
  const L1 = classTotals(
    db,
    `ts >= ?${untilClause} AND attr <> 'replay'
       AND session_id IN (${trackedSessionsSql})`,
    winParams,
  );
  const base = attrBaseFilter(w, opts);
  const L2 = classTotals(db, base.sql, base.params);
  // The legacy-currency twin of L0 — same population, `out_tok + cw_tok` instead of
  // `wcet` — so E′ can hold currency fixed while L0 above stays priced for every
  // OTHER reader of `Headline.L0` (the ladder printout's total_wcet, byDimension, …).
  const L0legacy = classTotalsExpr(db, "out_tok + cw_tok", l0Where, winParams);

  return {
    window: w,
    L0,
    L1,
    L2,
    coverage_pct: 100 * ratio(coverageNumerator(L2), L2.total),
    ambiguous_incl_pct: 100 * ratio(coverageNumerator(L2) + L2.ambiguous, L2.total),
    e_prime_pct: 100 * ratio(coverageNumerator(L0legacy), L0legacy.total),
    e_prime_priced_pct: 100 * ratio(coverageNumerator(L0), L0.total),
  };
}

function summarizeTotals(t: ClassTotals): Record<string, number> {
  const pct = (n: number): number => 100 * ratio(n, t.total);
  return {
    total_wcet: t.total,
    exclusive_pct: pct(t.exclusive),
    sticky_pct: pct(t.sticky),
    ambiguous_pct: pct(t.ambiguous),
    pre_task_pct: pct(t.pre_task),
    none_pct: pct(t.none),
    overhead_pct: pct(t.overhead),
  };
}

// ---------------------------------------------------------------------------
// D4: currency sensitivity — priced Work-CET is the headline, counters are variants
// ---------------------------------------------------------------------------

export interface CurrencyPoint {
  coverage_pct: number;
  total: number;
}

export function currencySensitivity(db: Database, w: AttrWindowArg): Record<string, CurrencyPoint> {
  const base = attrBaseFilter(w);
  const exprs: Record<string, string> = {
    wcet_priced: "wcet",
    out_plus_cw: "out_tok + cw_tok",
    in_out_cw: "in_tok + out_tok + cw_tok",
    out_only: "out_tok",
  };
  const out: Record<string, CurrencyPoint> = {};
  for (const [name, expr] of Object.entries(exprs)) {
    const t = classTotalsExpr(db, expr, base.sql, base.params);
    out[name] = { coverage_pct: 100 * ratio(coverageNumerator(t), t.total), total: t.total };
  }
  const reqRows = db
    .query<{ attr: string; n: number }, (string | number)[]>(
      `SELECT attr, COUNT(*) AS n FROM v_wcet WHERE ${base.sql} GROUP BY attr`,
    )
    .all(...base.params);
  let covReq = 0;
  let totReq = 0;
  for (const r of reqRows) {
    totReq += r.n;
    if ((COVERAGE_KEYS as readonly string[]).includes(r.attr)) covReq += r.n;
  }
  out.request_count = { coverage_pct: 100 * ratio(covReq, totReq), total: totReq };
  return out;
}

// ---------------------------------------------------------------------------
// unpriced spend — every quantity above is `v_wcet`/`v_priced`, which INNER JOINs
// `model_price` twice over: once on `family` membership, once on `effective_from <=
// r.ts` (schema.sql's `v_priced`). A model family missing a price row OUTRIGHT is
// what `v_unpriced` (schema.sql) reports — but a family that IS priced, just not as
// of a request predating its earliest `effective_from` (e.g. `est prices --set --at
// <iso>` stamping a vintage that starts after some already-ingested spend), joins to
// nothing (`MAX(effective_from) <= r.ts` is NULL) and falls out of `v_priced`/`v_wcet`
// while staying invisible to `v_unpriced`, which only checks family membership. This
// is exactly the "(or predating its first effective_from)" class named below, so the
// guard is computed directly off `v_wcet` absence — a request is unpriced here iff no
// `v_wcet` row exists for it (`w.request_id` unmatched), OR a `v_wcet` row exists but
// its `wcet` is NULL — regardless of WHY the join or the arithmetic failed.
//
// The second half of that OR is not hypothetical: `v_wcet`'s ref-model normaliser
// (schema.sql, `ref_out`) is a SCALAR SUBSELECT keyed on `config.ref_model` and
// `effective_from <= p.ts`, uncorrelated with whether the REQUEST's own family
// priced successfully. When the ref model's earliest vintage postdates a request,
// that subselect returns NULL (not zero rows) — `v_priced p` already produced a row
// for the request (its own family joined fine), so `v_wcet` STILL EMITS A ROW for
// `request_id`, just with `wcet = CAST(x / NULL) = NULL`. A `NOT EXISTS` guard sees
// that row and calls the request priced, while every `SUM(wcet)` numerator and
// denominator elsewhere in this file silently drops it (SQL's `SUM` ignores NULL) —
// PASS becomes reachable with that request's spend invisible on both sides at once.
// Requiring `w.wcet IS NOT NULL` for "priced" closes both drop classes with one
// predicate: absent row and present-but-NULL row are the same failure to a caller
// that just wants to know whether this request's mass landed anywhere.
// ---------------------------------------------------------------------------

export interface UnpricedShare {
  /** in-window request rows with no corresponding priced `v_wcet` row — family
   *  missing from `model_price` entirely, priced only from a vintage that postdates
   *  the request, OR (ref-model class) the `v_wcet` row exists but `wcet` is NULL
   *  because the REF model's earliest vintage postdates the request. */
  count: number;
  /** their out_tok+cw_tok mass — the same currency `currencySensitivity`'s
   *  `out_plus_cw` row uses, so this is directly comparable to it. */
  out_plus_cw: number;
  /** window total out_tok+cw_tok over ALL non-replay requests (priced or not) —
   *  the denominator `share_pct` is against. */
  window_total_out_plus_cw: number;
  share_pct: number;
}

export function unpricedShare(db: Database, w: AttrWindowArg): UnpricedShare {
  const untilClause = w.until !== undefined ? " AND r.ts < ?" : "";
  const winParams: (string | number)[] = w.until !== undefined ? [w.since, w.until] : [w.since];
  const u = db
    .query<{ n: number; mass: number | null }, (string | number)[]>(
      `SELECT COUNT(*) AS n, SUM(r.out_tok + r.cw_tok) AS mass
         FROM v_request_live r
        WHERE r.ts >= ?${untilClause}
          AND NOT EXISTS (
            SELECT 1 FROM v_wcet w WHERE w.request_id = r.request_id AND w.wcet IS NOT NULL
          )`,
    )
    .get(...winParams) ?? { n: 0, mass: 0 };
  const totalRow = db
    .query<{ mass: number | null }, (string | number)[]>(
      `SELECT SUM(r.out_tok + r.cw_tok) AS mass FROM v_request_live r WHERE r.ts >= ?${untilClause}`,
    )
    .get(...winParams);
  const mass = u.mass ?? 0;
  const total = totalRow?.mass ?? 0;
  return {
    count: u.n,
    out_plus_cw: mass,
    window_total_out_plus_cw: total,
    share_pct: 100 * ratio(mass, total),
  };
}

// ---------------------------------------------------------------------------
// by origin / by model family — the reweighting-sensitivity panel
// ---------------------------------------------------------------------------

export interface DimensionPoint {
  key: string;
  coverage_pct: number;
  share_pct: number;
  total: number;
}

export function byDimension(
  db: Database,
  dim: "origin" | "model_family",
  w: AttrWindowArg,
): DimensionPoint[] {
  const base = attrBaseFilter(w);
  const rows = db
    .query<{ k: string; attr: string; v: number }, (string | number)[]>(
      `SELECT ${dim} AS k, attr, SUM(wcet) AS v FROM v_wcet WHERE ${base.sql} GROUP BY ${dim}, attr`,
    )
    .all(...base.params);
  const byKey = new Map<string, ClassTotals>();
  for (const r of rows) {
    let t = byKey.get(r.k);
    if (t === undefined) {
      t = zeroTotals();
      byKey.set(r.k, t);
    }
    const bc = t as unknown as Record<string, number>;
    if (r.attr in t) bc[r.attr] = r.v;
    t.total += r.v;
  }
  const grand = [...byKey.values()].reduce((a, t) => a + t.total, 0);
  return [...byKey.entries()]
    .map(([key, t]) => ({
      key,
      coverage_pct: 100 * ratio(coverageNumerator(t), t.total),
      share_pct: 100 * ratio(t.total, grand),
      total: t.total,
    }))
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// D7: task population census — over `task_alias`, not harness todo hygiene
// ---------------------------------------------------------------------------

export interface TaskCensus {
  opened_in_window: number;
  finalized_in_window: number;
  still_open_now: number;
  never_attributed_pct: number;
  alias_counts: Array<{ id_kind: string; source: string; n: number }>;
}

export function taskCensus(db: Database, w: AttrWindowArg): TaskCensus {
  const untilClause = w.until !== undefined ? " AND created_at < ?" : "";
  const winParams: (string | number)[] = w.until !== undefined ? [w.since, w.until] : [w.since];

  // One query, batched: for every task OPENED in the window, whether it has since
  // reached a non-reopened outcome and whether any (non-replay) request ever named it.
  const rows = db
    .query<{ tid: string; finalized: number; n_req: number }, (string | number)[]>(
      `SELECT t.tid AS tid,
              (SELECT COUNT(*) FROM v_outcome_current o
                WHERE o.tid = t.tid AND o.final_status <> 'reopened') AS finalized,
              (SELECT COUNT(*) FROM request r WHERE r.tid = t.tid AND r.attr <> 'replay') AS n_req
         FROM task t WHERE t.created_at >= ?${untilClause}`,
    )
    .all(...winParams);

  const finUntil = w.until !== undefined ? " AND finalized_at < ?" : "";
  const finalizedInWindow = num(
    db,
    `SELECT COUNT(DISTINCT tid) AS v FROM v_outcome_current
      WHERE final_status <> 'reopened' AND finalized_at >= ?${finUntil}`,
    winParams,
  );

  const opened = rows.length;
  const stillOpen = rows.filter((r) => r.finalized === 0).length;
  const neverAttributed = rows.filter((r) => r.n_req === 0).length;

  const aliasRows = db
    .query<{ id_kind: string; source: string; n: number }, []>(
      "SELECT id_kind, source, COUNT(*) AS n FROM task_alias GROUP BY id_kind, source ORDER BY id_kind, source",
    )
    .all();

  return {
    opened_in_window: opened,
    finalized_in_window: finalizedInWindow,
    still_open_now: stillOpen,
    never_attributed_pct: 100 * ratio(neverAttributed, opened),
    alias_counts: aliasRows,
  };
}

// ---------------------------------------------------------------------------
// D9: anomaly preconditions and the hook-lift precondition text
// ---------------------------------------------------------------------------

export interface AnomalyPreconditions {
  hook_bind_conflict: number;
  alias_split_identity: number;
}

export function anomalyPreconditions(db: Database): AnomalyPreconditions {
  const rows = db
    .query<{ kind: string; n: number }, []>(
      "SELECT kind, COUNT(*) AS n FROM anomaly WHERE kind IN ('hook_bind_conflict','alias_split_identity') GROUP BY kind",
    )
    .all();
  const m = new Map(rows.map((r) => [r.kind, r.n]));
  return {
    hook_bind_conflict: m.get("hook_bind_conflict") ?? 0,
    alias_split_identity: m.get("alias_split_identity") ?? 0,
  };
}

// ---------------------------------------------------------------------------
// D9/D10: temp-copy machinery. Never writes the live DB — every mutation below
// runs against a `VACUUM INTO` copy, and the copy is discarded before this
// process exits.
// ---------------------------------------------------------------------------

/**
 * `VACUUM INTO` a temp copy of the live DB. Takes a PATH, not the already-open
 * `db` handle: `openDb({ readonly: true })` additionally sets `PRAGMA query_only
 * = ON` (`src/db.ts`'s "belt to the connection flag's braces"), which blocks
 * `VACUUM INTO` too, so this opens its own short-lived connection with only the
 * SQLite-level `SQLITE_OPEN_READONLY` flag — still structurally incapable of
 * writing the SOURCE file (verified: this is the same mechanism `sqlite3
 * -readonly db.sqlite "VACUUM INTO ..."` uses), and closed immediately after.
 */
function vacuumInto(dbPath: string, destPath: string): void {
  const quoted = destPath.replace(/'/g, "''");
  const src = new Database(dbPath, { readonly: true });
  try {
    src.exec(`VACUUM INTO '${quoted}'`);
  } finally {
    src.close();
  }
}

function withTempCopy<T>(masterPath: string, fn: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "g-attr-live-"));
  const copyPath = join(dir, "copy.db");
  try {
    copyFileSync(masterPath, copyPath);
    const db = new Database(copyPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * D9 / HOOK-BINDING-SPEC §9.3 V7 — the uncontaminated hook-lift check. A hook alias
 * contributes a `boundSpan` and a bound-agent touch that reset the bound task's
 * `quietTurns` on every turn it covers, so a query that asks "does the hook's tid
 * match the turn walk's answer" is graded by an answer the hook partly created. The
 * only clean comparison is a turn walk that never saw a hook alias at all: delete
 * every `source='hook'` row on a throwaway copy and let `attributeTasks` recompute
 * every claim from scratch.
 *
 * The DELETE must not also move the DENOMINATOR. A session whose only `task_alias`
 * row was the hook binding (the ~79%-subagent-mass topology HOOK-BINDING-SPEC
 * targets: the agent runs in a session distinct from the one that opened the task)
 * has no OTHER alias to keep it "tracked" once that row is gone — left to
 * `attrBaseFilter`'s live subquery, such a session would silently leave L1/L2's
 * population in the ex-hook run instead of staying in it as now-uncovered spend,
 * shrinking the base and masking `hook_lift` for exactly the pass D9 exists to catch.
 * So the tracked-session set is frozen from `task_alias` BEFORE the delete, into a
 * temp table, and threaded into `computeHeadline` as the denominator's session
 * predicate — only the attribution ANSWER (`attr` per row) is allowed to differ
 * between live and ex-hook; the population it is measured over may not.
 */
export function coverageExHook(masterPath: string, w: AttrWindowArg): number {
  return withTempCopy(masterPath, (db) => {
    db.exec(
      `CREATE TEMP TABLE frozen_tracked_session AS
         SELECT DISTINCT session_id FROM task_alias WHERE session_id <> ''`,
    );
    db.exec("DELETE FROM task_alias WHERE source = 'hook'");
    attributeTasks(db);
    return computeHeadline(db, w, {
      trackedSessionsSql: "SELECT session_id FROM frozen_tracked_session",
    }).coverage_pct;
  });
}

export interface StaleGridPoint {
  turns: number;
  minutes: number;
  coverage_pct: number;
}

/**
 * D10 — the staleness free parameter, gridded rather than tuned. Each point is its
 * own temp copy (never the live DB, never the master shared with other points, since
 * `attributeTasks` mutates `tid`/`attr` in place).
 */
export function stalenessGrid(
  masterPath: string,
  w: AttrWindowArg,
  turnsGrid: readonly number[],
  minutesGrid: readonly number[],
): StaleGridPoint[] {
  const out: StaleGridPoint[] = [];
  for (const turns of turnsGrid) {
    for (const minutes of minutesGrid) {
      const coverage_pct = withTempCopy(masterPath, (db) => {
        setConfig(db, "attr_stale_turns", String(turns));
        setConfig(db, "attr_stale_minutes", String(minutes));
        attributeTasks(db);
        return computeHeadline(db, w).coverage_pct;
      });
      out.push({ turns, minutes, coverage_pct });
    }
  }
  return out;
}

/** D10 — the `pre_task` mass that falls INSIDE some bound task's window: spend the
 *  staleness rule closed off, as distinct from genuinely pre-task spend. */
export function staleClosedShare(db: Database, w: AttrWindowArg): number {
  const untilClause = w.until !== undefined ? " AND v.ts < ?" : "";
  const winParams: (string | number)[] = w.until !== undefined ? [w.since, w.until] : [w.since];
  const stale = num(
    db,
    `SELECT SUM(v.wcet) AS v FROM v_wcet v
      WHERE v.attr = 'pre_task' AND v.ts >= ?${untilClause}
        AND EXISTS (SELECT 1 FROM task t JOIN task_alias a
                       ON a.tid = t.tid AND a.session_id = v.session_id
                     WHERE v.ts >= t.created_at)`,
    winParams,
  );
  const base = attrBaseFilter(w);
  const denom = num(db, `SELECT SUM(wcet) AS v FROM v_wcet WHERE ${base.sql}`, base.params);
  return 100 * ratio(stale, denom);
}

// ---------------------------------------------------------------------------
// X1 — ingest completeness cross-check (GLS D2): "is the DB's request set the
// corpus's request set?" The one failure mode a DB-only headline cannot see —
// spend that never arrived is invisible in `request.attr`.
// ---------------------------------------------------------------------------

interface DedupCounters {
  in: number;
  out: number;
  cw: number;
  cr: number;
}

interface DedupReq extends DedupCounters {
  request_id: string;
  message_id: string | null;
  is_sidechain: number;
  origin: string;
  prompt_id: string | null;
  replay: boolean;
}

/** MAX per `(request_id, counter)` (§5.2) — a request re-ingested from a second copy
 *  of the same transcript (munged project dirs) must not double the counters. */
function upsertMax(into: Map<string, DedupReq>, row: RequestRow): void {
  const cur = into.get(row.request_id);
  if (cur === undefined) {
    into.set(row.request_id, {
      request_id: row.request_id,
      message_id: row.message_id,
      is_sidechain: row.is_sidechain,
      origin: row.origin,
      prompt_id: row.prompt_id,
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
  if (cur.prompt_id === null && row.prompt_id !== null) cur.prompt_id = row.prompt_id;
}

/** ccusage's sidechain-replay tie-break (§5.2), verbatim. Marks losers `replay`. */
function markSidechainReplays(reqs: Map<string, DedupReq>): number {
  const byMessage = new Map<string, DedupReq[]>();
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

export interface JoinQualityX1 {
  sessions: number;
  transcript_unique_requests: number;
  db_unique_requests: number;
  unjoined_subagent_pct: number;
  malformed_lines: number;
  truncated_tails: number;
  sidechain_replays_marked: number;
}

export async function ingestCompleteness(db: Database, limit: number = Infinity): Promise<JoinQualityX1> {
  const corpus = discoverCorpus();
  const sessions = corpus.sessions.slice(0, limit);
  const requests = new Map<string, DedupReq>();
  let malformed = 0;
  let truncated = 0;
  for (const session of sessions) {
    const batch = await ingestSession(session);
    for (const row of batch.requests) upsertMax(requests, row);
    malformed += batch.stats.malformed;
    truncated += batch.stats.truncatedTail;
  }
  const replays = markSidechainReplays(requests);

  let subagentTotal = 0;
  let subagentUnjoined = 0;
  let uniqueLive = 0;
  for (const r of requests.values()) {
    if (r.replay) continue;
    uniqueLive += 1;
    if (r.origin === "subagent") {
      subagentTotal += 1;
      if (r.prompt_id === null) subagentUnjoined += 1;
    }
  }

  const dbCount = num(db, "SELECT COUNT(*) AS v FROM request WHERE attr <> 'replay'");

  return {
    sessions: sessions.length,
    transcript_unique_requests: uniqueLive,
    db_unique_requests: dbCount,
    unjoined_subagent_pct: 100 * ratio(subagentUnjoined, subagentTotal),
    malformed_lines: malformed,
    truncated_tails: truncated,
    sidechain_replays_marked: replays,
  };
}

// ---------------------------------------------------------------------------
// D14: verdict + the licence text, printed verbatim on PASS
// ---------------------------------------------------------------------------

export type Verdict = "PASS" | "ESCALATE";

/**
 * GLS §3's self-validation: `coverage_ex_hook` is always a FULL `attributeTasks`
 * re-sweep on a copy with `source='hook'` rows deleted, never a query gated on
 * whether that delete did anything. When there are no hook aliases to delete, the
 * delete is a no-op — but the re-sweep is not: it still re-derives every row's `attr`
 * from scratch, and can diverge from the stored `request.attr` on sweeper/config skew
 * (a stale attr column, a config value that has moved since the last live sweep, or a
 * fixture that set `attr` directly rather than through `attributeTasks`). In that
 * regime `hook_lift` is NOT "0 by construction" — it is unconstrained, and a large
 * value would currently be captioned as if it were zero. `HOOK_LIFT_SELF_CHECK_TOLERANCE_PP`
 * is the "should reproduce the §1 baseline" tolerance: with no hook aliases present,
 * |hook_lift| above it means the shadow harness (or the live attr column) is wrong
 * before any PASS conclusion is drawn from it.
 */
export const HOOK_LIFT_SELF_CHECK_TOLERANCE_PP = 0.1;

export interface HookSelfCheck {
  hookAliasesPresent: boolean;
  hookLiftPct: number;
}

/**
 * `unpricedCount` defaults to 0 so existing callers (and the D9/D10 shadow recomputes,
 * which never touch `model_price`) are unaffected. A nonzero count means the headline
 * above was computed over a base population that silently dropped some in-window
 * spend class entirely (`v_priced`'s INNER JOIN on `model_price` — see
 * `unpricedShare`); that is not a corpus-quality condition D14 can license through,
 * so it gates PASS the same way the two anomaly counts already do.
 *
 * `hookSelfCheck` defaults to a trivially-passing shape (`hookAliasesPresent: true`) so
 * existing 2-/3-arg callers are unaffected. When hook aliases are ABSENT, GLS §3
 * requires `coverage_ex_hook` to reproduce the live baseline (the delete was a no-op);
 * a divergence beyond `HOOK_LIFT_SELF_CHECK_TOLERANCE_PP` means the D9 shadow harness
 * cannot be trusted, so it gates PASS the same way the two anomaly counts already do.
 */
export function verdictOf(
  headlinePct: number,
  preconds: AnomalyPreconditions,
  unpricedCount: number = 0,
  hookSelfCheck: HookSelfCheck = { hookAliasesPresent: true, hookLiftPct: 0 },
): Verdict {
  if (headlinePct < ATTR_COVERAGE_GATE * 100) return "ESCALATE";
  if (preconds.hook_bind_conflict !== 0 || preconds.alias_split_identity !== 0) return "ESCALATE";
  if (unpricedCount !== 0) return "ESCALATE";
  if (
    !hookSelfCheck.hookAliasesPresent &&
    Math.abs(hookSelfCheck.hookLiftPct) > HOOK_LIFT_SELF_CHECK_TOLERANCE_PP
  ) {
    return "ESCALATE";
  }
  return "PASS";
}

const D14_TEXT = [
  "Coverage >= 70% on the live window re-opens P2.11: calibration maturation",
  "(bootstrap CIs, shrinkage tuning, model-family decay, pinball-gated splits) is no",
  "longer deferred, and the live G-ATTR re-gate -- the Phase 1 exit criterion -- is met.",
  "",
  "It licenses NOTHING ELSE:",
  " 1. Not a retro-fit licence. The historical corpus stays cost-history-only; no",
  "    multiplier may be fitted to pre-cutover attribution.",
  " 2. Not sufficient for velocity. Calibration additionally needs >=10",
  "    estimated-then-scored tasks -- coverage is a corpus-quality condition, not a",
  "    sample-size one. Both must hold.",
  " 3. Not a validation of the binder. A pass with a large hook_lift and an unclean",
  "    anomaly ledger (hook_bind_conflict / alias_split_identity nonzero) is a fail --",
  "    enforced above, not left to this text.",
  " 4. A licence over `exclusive` spend only. `v_task_actual` sums every attr except",
  "    `overhead`, so `ambiguous` is ALREADY inside the actuals calibration would fit.",
  "    L3 vs L4 above is the open, blocking question: before any multiplier moves,",
  "    either the actuals views exclude `ambiguous`, or the design is corrected to",
  "    admit it and coverage is restated as exclusive+sticky+ambiguous.",
].join("\n");

// ---------------------------------------------------------------------------
// live main
// ---------------------------------------------------------------------------

interface LiveReport {
  generated_at: string;
  elapsed_ms: number;
  db: string;
  window: { since: string; hook_merge: string | null };
  headline: {
    coverage_pct: number;
    threshold_pct: number;
    exclusive_pct: number;
    sticky_pct: number;
    ambiguous_pct: number;
  };
  ladder: {
    L0_all_window: Record<string, number>;
    L1_tracked_sessions: Record<string, number>;
    L2_calibration_eligible_base: Record<string, number>;
    L3_headline_coverage_pct: number;
    L4_plus_ambiguous_pct: number;
    /** SAME currency as the frozen July number (out_tok+cw_tok, unweighted) — the
     *  true bridge rung; only the attribution rule differs from 2026-07 here. */
    E_prime_bridge_to_2026_07_pct: number;
    /** L0 restated in priced wcet — E′'s currency-sensitivity companion, NOT itself
     *  comparable to July's 18.7% (see `Headline.e_prime_priced_pct`). */
    E_prime_priced_wcet_pct: number;
  };
  epochs: { pre_hook_merge: Headline; post_hook_merge: Headline } | null;
  coverage_ex_hook_pct: number | null;
  hook_lift_pct: number | null;
  hook_aliases_present: boolean;
  /** GLS §3 self-validation: true unless `hook_aliases_present` is false AND
   *  `hook_lift_pct` exceeds `HOOK_LIFT_SELF_CHECK_TOLERANCE_PP` — see `verdictOf`. */
  hook_self_check_ok: boolean;
  staleness_grid: StaleGridPoint[];
  stale_closed_share_pct: number;
  task_census: TaskCensus;
  by_origin: DimensionPoint[];
  by_model_family: DimensionPoint[];
  currency_sensitivity: Record<string, CurrencyPoint>;
  unpriced_window: UnpricedShare;
  anomaly_preconditions: AnomalyPreconditions;
  join_quality_x1: JoinQualityX1 | null;
  verdict: Verdict;
  licenses: string | null;
}

/**
 * Runs the whole live gate against an already-open `Database`. Exported so tests can
 * drive it against a fixture DB without going through `openDb`/CLI argv parsing; the
 * caller owns `db`'s lifecycle (open + close) either way.
 */
export async function runLive(
  db: Database,
  opts: {
    dbLabel?: string;
    since?: string;
    hookMerge?: string;
    skipX1?: boolean;
    ingestLimit?: number;
  } = {},
): Promise<LiveReport> {
  const t0 = Date.now();
  const since = opts.since ?? CUTOVER_DEFAULT;
  const now = new Date().toISOString();

  const headline = computeHeadline(db, { since });
  const epochs =
    opts.hookMerge !== undefined
      ? {
          pre_hook_merge: computeHeadline(db, { since, until: opts.hookMerge }),
          post_hook_merge: computeHeadline(db, { since: opts.hookMerge, until: now }),
        }
      : null;

  const census = taskCensus(db, { since });
  const preconds = anomalyPreconditions(db);
  const staleShare = staleClosedShare(db, { since });
  const origins = byDimension(db, "origin", { since });
  const families = byDimension(db, "model_family", { since });
  const currencies = currencySensitivity(db, { since });
  const unpriced = unpricedShare(db, { since });
  const hadHookAliases = num(db, "SELECT COUNT(*) AS v FROM task_alias WHERE source='hook'") > 0;

  // The master temp copy: one VACUUM INTO of the live DB, reused as the pristine base
  // for every mutating recompute below (cheap `cp` per grid point, not a second
  // VACUUM INTO per point).
  const workDir = mkdtempSync(join(tmpdir(), "g-attr-live-master-"));
  const masterPath = join(workDir, "master.db");
  let exHookPct: number;
  let grid: StaleGridPoint[];
  try {
    vacuumInto(db.filename, masterPath);
    exHookPct = coverageExHook(masterPath, { since });
    const w = attrWindow(db);
    const curTurns = w.maxQuietTurns;
    const curMinutes = w.staleMs / 60_000;
    const turnsGrid = [...new Set([Math.max(1, curTurns - 2), curTurns, curTurns + 3])].sort(
      (a, b) => a - b,
    );
    const minutesGrid = [
      ...new Set([Math.max(15, Math.round(curMinutes / 2)), Math.round(curMinutes), curMinutes * 2]),
    ].sort((a, b) => a - b);
    grid = stalenessGrid(masterPath, { since }, turnsGrid, minutesGrid);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const x1 = opts.skipX1 === true ? null : await ingestCompleteness(db, opts.ingestLimit ?? Infinity);

  const hookLiftPct = headline.coverage_pct - exHookPct;
  const hookSelfCheckOk =
    hadHookAliases || Math.abs(hookLiftPct) <= HOOK_LIFT_SELF_CHECK_TOLERANCE_PP;
  const verdict = verdictOf(headline.coverage_pct, preconds, unpriced.count, {
    hookAliasesPresent: hadHookAliases,
    hookLiftPct,
  });

  return {
    generated_at: now,
    elapsed_ms: Date.now() - t0,
    db: opts.dbLabel ?? DB_PATH,
    window: { since, hook_merge: opts.hookMerge ?? null },
    headline: {
      coverage_pct: headline.coverage_pct,
      threshold_pct: ATTR_COVERAGE_GATE * 100,
      exclusive_pct: 100 * ratio(headline.L2.exclusive, headline.L2.total),
      sticky_pct: 100 * ratio(headline.L2.sticky, headline.L2.total),
      ambiguous_pct: 100 * ratio(headline.L2.ambiguous, headline.L2.total),
    },
    ladder: {
      L0_all_window: summarizeTotals(headline.L0),
      L1_tracked_sessions: summarizeTotals(headline.L1),
      L2_calibration_eligible_base: summarizeTotals(headline.L2),
      L3_headline_coverage_pct: headline.coverage_pct,
      L4_plus_ambiguous_pct: headline.ambiguous_incl_pct,
      E_prime_bridge_to_2026_07_pct: headline.e_prime_pct,
      E_prime_priced_wcet_pct: headline.e_prime_priced_pct,
    },
    epochs,
    coverage_ex_hook_pct: exHookPct,
    hook_lift_pct: hookLiftPct,
    hook_aliases_present: hadHookAliases,
    hook_self_check_ok: hookSelfCheckOk,
    staleness_grid: grid,
    stale_closed_share_pct: staleShare,
    task_census: census,
    by_origin: origins,
    by_model_family: families,
    currency_sensitivity: currencies,
    unpriced_window: unpriced,
    anomaly_preconditions: preconds,
    join_quality_x1: x1,
    verdict,
    licenses: verdict === "PASS" ? D14_TEXT : null,
  };
}

function pct(x: number): string {
  return x.toFixed(1).padStart(5) + "%";
}

function printLiveReport(r: LiveReport): void {
  const L = (s: string): void => {
    process.stdout.write(s + "\n");
  };
  L("=== G-ATTR — live re-gate (design/GATE-LIVE-SEMANTICS.md) ===");
  L(`db: ${r.db}  window: ${r.window.since} .. ${r.window.hook_merge ?? "(no epoch split)"}  (${r.elapsed_ms} ms)`);
  L("");
  L("headline — priced Work-CET, live request.attr, D3 base population:");
  L(`  exclusive        ${pct(r.headline.exclusive_pct)}`);
  L(`  sticky           ${pct(r.headline.sticky_pct)}`);
  L(`  ------------------------`);
  L(`  COVERAGE         ${pct(r.headline.coverage_pct)}   (threshold ${r.headline.threshold_pct.toFixed(0)}%)`);
  L(`  ambiguous        ${pct(r.headline.ambiguous_pct)}`);
  L("");
  L("ladder:");
  L(`  L0 all window Work-CET ............... total ${r.ladder.L0_all_window.total_wcet}`);
  L(`  L1 + tracked sessions only ........... total ${r.ladder.L1_tracked_sessions.total_wcet}`);
  L(`  L2 + non-overhead, main/subagent ..... total ${r.ladder.L2_calibration_eligible_base.total_wcet}`);
  L(`  L3 exclusive∪sticky / L2 == HEADLINE . ${pct(r.ladder.L3_headline_coverage_pct)}`);
  L(`  L4 + ambiguous / L2 ................... ${pct(r.ladder.L4_plus_ambiguous_pct)}`);
  L(
    `  E′ bridge to 2026-07 (exclusive∪sticky / L0, out+cw unweighted -- July's currency) ${pct(r.ladder.E_prime_bridge_to_2026_07_pct)}`,
  );
  L(
    `  E′ priced-wcet variant (same L0 population, live currency -- NOT the July bridge) ${pct(r.ladder.E_prime_priced_wcet_pct)}`,
  );
  L("");
  L("hook lift (D9) — coverage with vs without source='hook' aliases, uncontaminated shadow run:");
  L(
    `  coverage_ex_hook ${pct(r.coverage_ex_hook_pct ?? 0)}   hook_lift ${((r.hook_lift_pct ?? 0) >= 0 ? "+" : "") + (r.hook_lift_pct ?? 0).toFixed(1)}pp` +
      (r.hook_aliases_present
        ? ""
        : r.hook_self_check_ok
          ? "   (no source='hook' aliases yet — GLS §3 self-check: lift ~0 as expected)"
          : "   (no source='hook' aliases yet — GLS §3 self-check FAILED: nonzero lift with no hook rows to delete — shadow harness/attr column is suspect -- BLOCKS PASS)"),
  );
  L(
    `  anomaly preconditions: hook_bind_conflict=${r.anomaly_preconditions.hook_bind_conflict}  alias_split_identity=${r.anomaly_preconditions.alias_split_identity}`,
  );
  L("");
  L("staleness sensitivity grid (D10):");
  for (const g of r.staleness_grid) {
    L(`  turns=${String(g.turns).padStart(2)}  minutes=${String(g.minutes).padStart(4)}  coverage ${pct(g.coverage_pct)}`);
  }
  L(`  stale_closed_share (pre_task inside a bound window) ${pct(r.stale_closed_share_pct)}`);
  L("");
  L("task census (D7 — task_alias population, not harness todo hygiene):");
  L(
    `  opened_in_window=${r.task_census.opened_in_window}  finalized_in_window=${r.task_census.finalized_in_window}  ` +
      `still_open_now=${r.task_census.still_open_now}  never_attributed=${pct(r.task_census.never_attributed_pct)}`,
  );
  for (const a of r.task_census.alias_counts) {
    L(`    alias ${a.id_kind.padEnd(14)} source=${a.source.padEnd(10)} n=${a.n}`);
  }
  L("");
  L("currency sensitivity:");
  for (const [name, p] of Object.entries(r.currency_sensitivity)) {
    L(`  ${name.padEnd(14)} coverage ${pct(p.coverage_pct)}  total ${p.total}`);
  }
  L("");
  L("unpriced window spend (v_priced INNER JOINs model_price; this mass is in NEITHER numerator NOR denominator above):");
  L(
    `  count=${r.unpriced_window.count}  out+cw=${r.unpriced_window.out_plus_cw}  ` +
      `share ${pct(r.unpriced_window.share_pct)} of window out+cw` +
      (r.unpriced_window.count !== 0 ? "   -- BLOCKS PASS (est prices --sync?)" : ""),
  );
  L("");
  L("by origin:");
  for (const o of r.by_origin) L(`  ${o.key.padEnd(10)} ${pct(o.share_pct)} of base   coverage ${pct(o.coverage_pct)}`);
  L("");
  L("by model family:");
  for (const f of r.by_model_family) {
    if (f.share_pct < 0.05) continue;
    L(`  ${f.key.padEnd(26)} ${pct(f.share_pct)} of base   coverage ${pct(f.coverage_pct)}`);
  }
  if (r.join_quality_x1 !== null) {
    L("");
    L("X1 — ingest completeness cross-check (transcripts vs DB, GLS D2):");
    L(
      `  sessions=${r.join_quality_x1.sessions}  transcript_unique=${r.join_quality_x1.transcript_unique_requests}  ` +
        `db_unique(non-replay)=${r.join_quality_x1.db_unique_requests}`,
    );
    L(
      `  unjoined_subagent ${pct(r.join_quality_x1.unjoined_subagent_pct)}  malformed=${r.join_quality_x1.malformed_lines}  ` +
        `truncated=${r.join_quality_x1.truncated_tails}  sidechain_replays=${r.join_quality_x1.sidechain_replays_marked}`,
    );
  }
  L("");
  L(`VERDICT: ${r.verdict}`);
  if (r.licenses !== null) {
    L("");
    L(r.licenses);
  }
}

async function runLiveMain(argv: string[]): Promise<void> {
  const dbPath = flag(argv, "--db") ?? DB_PATH;
  const since = flag(argv, "--since") ?? CUTOVER_DEFAULT;
  const hookMerge = flag(argv, "--hook-merge");
  const jsonOut = flag(argv, "--json");
  const limitFlag = flag(argv, "--limit-sessions");
  const ingestLimit = limitFlag !== undefined ? Number(limitFlag) : Infinity;
  const skipX1 = argv.includes("--skip-x1");
  const force = argv.includes("--force");

  if (jsonOut !== undefined) guardJsonOut(jsonOut, force);

  const live = openDb({ path: dbPath, readonly: true });
  let report: LiveReport;
  try {
    report = await runLive(live, { dbLabel: dbPath, since, hookMerge, skipX1, ingestLimit });
  } finally {
    live.close();
  }

  printLiveReport(report);
  if (jsonOut !== undefined) {
    await Bun.write(jsonOut, JSON.stringify(report, null, 2));
    process.stderr.write(`wrote ${jsonOut}\n`);
  }
}

// ===========================================================================
// --legacy-r3 — the FROZEN 2026-07 ladder (GLS D11), unrelated to the live
// headline above and retained ONLY to reproduce `gates/g-attr.json`'s numbers
// on today's transcript corpus. Do not read this as G-ATTR's answer: the
// task grain here (harness `TaskCreate`) is exactly what D6 forbids for the
// live measurement.
// ===========================================================================

interface LegacyCounters {
  in: number;
  out: number;
  cw: number;
  cr: number;
}

const LEGACY_CURRENCIES = {
  wcet_unweighted: (r: LegacyCounters) => r.out + r.cw,
  attr2_in_out_cw: (r: LegacyCounters) => r.in + r.out + r.cw,
  out_only: (r: LegacyCounters) => r.out,
  requests: () => 1,
} as const;
type LegacyCurrencyName = keyof typeof LEGACY_CURRENCIES;
const LEGACY_CURRENCY_NAMES = Object.keys(LEGACY_CURRENCIES) as LegacyCurrencyName[];

interface LegacyReq extends LegacyCounters {
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

type LegacyTaskEventKind = "create" | "status" | "touch";
interface LegacyTaskEvent {
  ts: string;
  taskId: string;
  kind: LegacyTaskEventKind;
  to: string | null;
}

function lstr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function readTaskStream(
  path: string,
): Promise<{ events: LegacyTaskEvent[]; turnStarts: Map<string, string> }> {
  const events: LegacyTaskEvent[] = [];
  const turnStarts = new Map<string, string>();
  const seg = new TurnSegmenter(null);

  await readJsonl(path, (raw) => {
    const line = JSON.parse(raw) as TranscriptLine;
    seg.push(line);

    const ts = lstr(line.timestamp);
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
      const id = lstr((task as Record<string, unknown>).id);
      if (id !== null) {
        events.push({ ts, taskId: id, kind: "create", to: "pending" });
        return;
      }
    }

    const sc = r.statusChange;
    if (sc !== null && typeof sc === "object") {
      const s = sc as Record<string, unknown>;
      const id = lstr(r.taskId) ?? lstr(s.taskId);
      if (id !== null) {
        events.push({
          ts,
          taskId: id,
          kind: "status",
          to: lstr(s.to) ?? lstr(s.toStatus) ?? lstr(s.status),
        });
        return;
      }
    }

    if (Array.isArray(r.updatedFields)) {
      const id = lstr(r.taskId);
      if (id !== null) events.push({ ts, taskId: id, kind: "touch", to: null });
    }
  });

  return { events, turnStarts };
}

type LegacyAttrClass = "overhead" | "exclusive" | "sticky" | "ambiguous" | "pre_task";
const LEGACY_CLOSED = new Set(["completed", "deleted", "cancelled", "canceled"]);

interface LegacyTurnInfo {
  promptId: string;
  startedAt: string;
  events: LegacyTaskEvent[];
}
interface LegacyClassifiedTurn {
  promptId: string;
  cls: LegacyAttrClass;
}

function classifySession(turns: LegacyTurnInfo[]): LegacyClassifiedTurn[] {
  const open: string[] = [];
  let lastTouched: string | null = null;

  const isOpening = (e: LegacyTaskEvent): boolean =>
    e.kind === "create" || (e.to !== null && !LEGACY_CLOSED.has(e.to));
  const isClosing = (e: LegacyTaskEvent): boolean => e.to !== null && LEGACY_CLOSED.has(e.to);

  const apply = (e: LegacyTaskEvent): void => {
    if (isClosing(e)) {
      const i = open.indexOf(e.taskId);
      if (i >= 0) open.splice(i, 1);
    } else if (isOpening(e)) {
      if (!open.includes(e.taskId)) open.push(e.taskId);
    }
    lastTouched = e.taskId;
  };

  const label = (): LegacyAttrClass => {
    if (open.length === 1) return "exclusive";
    if (open.length > 1) return "ambiguous";
    return lastTouched === null ? "pre_task" : "sticky";
  };

  const out: LegacyClassifiedTurn[] = [];
  for (const t of turns) {
    for (const e of t.events) apply(e);
    out.push({ promptId: t.promptId, cls: label() });
  }
  return out;
}

class LegacyTally {
  readonly byClass = new Map<string, Record<LegacyCurrencyName, number>>();
  total: Record<LegacyCurrencyName, number> = zeroLegacyBucket();

  add(cls: string, r: LegacyCounters): void {
    let b = this.byClass.get(cls);
    if (b === undefined) {
      b = zeroLegacyBucket();
      this.byClass.set(cls, b);
    }
    addToLegacy(b, r);
    addToLegacy(this.total, r);
  }

  share(cls: string | string[], cur: LegacyCurrencyName): number {
    const keys = Array.isArray(cls) ? cls : [cls];
    const denom = this.total[cur];
    if (denom === 0) return 0;
    let n = 0;
    for (const k of keys) n += this.byClass.get(k)?.[cur] ?? 0;
    return (100 * n) / denom;
  }
}
function zeroLegacyBucket(): Record<LegacyCurrencyName, number> {
  return { wcet_unweighted: 0, attr2_in_out_cw: 0, out_only: 0, requests: 0 };
}
function addToLegacy(b: Record<LegacyCurrencyName, number>, r: LegacyCounters): void {
  for (const n of LEGACY_CURRENCY_NAMES) b[n] += LEGACY_CURRENCIES[n](r);
}

function legacyUpsertMax(into: Map<string, LegacyReq>, row: RequestRow): void {
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
  if (cur.prompt_id === null && row.prompt_id !== null) cur.prompt_id = row.prompt_id;
}

function legacyMarkReplays(reqs: Map<string, LegacyReq>): number {
  const byMessage = new Map<string, LegacyReq[]>();
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

async function runLegacyR3(argv: string[]): Promise<void> {
  const jsonOut = flag(argv, "--json");
  const limitFlag = flag(argv, "--limit");
  const limit = limitFlag !== undefined ? Number(limitFlag) : Infinity;
  const force = argv.includes("--force");

  if (jsonOut !== undefined) guardJsonOut(jsonOut, force);

  const t0 = Date.now();
  const corpus = discoverCorpus();
  const sessions = corpus.sessions.slice(0, limit);
  process.stderr.write(
    `[legacy-r3] discovered ${corpus.sessions.length} sessions, ${corpus.census.files} files, ` +
      `${(corpus.census.bytes / 1e6).toFixed(0)} MB\n`,
  );

  const cls = new Map<string, LegacyAttrClass>();
  const sessionsWithNoTasks = new Set<string>();
  const requests = new Map<string, LegacyReq>();
  let malformed = 0;
  let truncated = 0;

  for (const session of sessions) {
    await processLegacySession(session);
  }

  async function processLegacySession(session: SessionCorpus): Promise<void> {
    const events: LegacyTaskEvent[] = [];
    const seen = new Set<string>();
    const turnStarts = new Map<string, string>();
    for (const path of session.mainTranscripts) {
      const { events: evs, turnStarts: ts } = await readTaskStream(path);
      for (const e of evs) {
        const k = `${e.ts}|${e.taskId}|${e.kind}|${e.to ?? ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        events.push(e);
      }
      for (const [p, t] of ts) {
        const prev = turnStarts.get(p);
        if (prev === undefined || t < prev) turnStarts.set(p, t);
      }
    }
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    const ordered = [...turnStarts.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const turns: LegacyTurnInfo[] = ordered.map(([promptId, startedAt]) => ({
      promptId,
      startedAt,
      events: [],
    }));
    let ti = 0;
    for (const e of events) {
      while (ti + 1 < turns.length && turns[ti + 1]!.startedAt <= e.ts) ti += 1;
      if (turns.length > 0) turns[ti]!.events.push(e);
    }
    if (events.length === 0) sessionsWithNoTasks.add(session.sessionId);

    for (const c of classifySession(turns)) cls.set(`${session.sessionId}|${c.promptId}`, c.cls);

    const batch = await ingestSession(session);
    for (const row of batch.requests) legacyUpsertMax(requests, row);
    malformed += batch.stats.malformed;
    truncated += batch.stats.truncatedTail;
  }

  const replays = legacyMarkReplays(requests);

  const all = new LegacyTally();
  const ladderC = new LegacyTally(); // + sub-agent tokens, in_progress-style def not reproduced here
  const attr2 = new LegacyTally(); // main-only, task-bearing sessions

  const classOf = (r: LegacyReq): LegacyAttrClass | null => {
    if (r.prompt_id === null) return null;
    return cls.get(`${r.session_id}|${r.prompt_id}`) ?? null;
  };

  for (const r of requests.values()) {
    if (r.replay) continue;
    const c = classOf(r);
    if (c === null) {
      all.add("pre_task", r);
    } else {
      all.add(c, r);
    }
    if (!sessionsWithNoTasks.has(r.session_id)) ladderC.add(c ?? "pre_task", r);
    if (r.origin === "main" && !sessionsWithNoTasks.has(r.session_id)) {
      attr2.add(c ?? "pre_task", r);
    }
  }

  const COV = ["exclusive", "sticky"];
  const cur: LegacyCurrencyName = "wcet_unweighted";

  const report = {
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    note: "FROZEN 2026-07 ladder reproduction (design/GATE-LIVE-SEMANTICS.md D11) — not the live headline",
    corpus: {
      sessions: sessions.length,
      files: corpus.census.files,
      bytes: corpus.census.bytes,
      unique_requests: requests.size,
      sidechain_replays_marked: replays,
      malformed_lines: malformed,
      truncated_tails: truncated,
    },
    headline: {
      coverage_pct: all.share(COV, cur),
      exclusive_pct: all.share("exclusive", cur),
      sticky_pct: all.share("sticky", cur),
      ambiguous_pct: all.share("ambiguous", cur),
      pre_task_pct: all.share("pre_task", cur),
    },
    ladder: {
      A_attr2_own_headline_incl_ambiguous: attr2.share(["exclusive", "sticky", "ambiguous"], "attr2_in_out_cw"),
      B_same_data_r3_coverage_def: attr2.share(COV, cur),
      C_plus_subagent_tokens: ladderC.share(COV, cur),
      E_r3_open_def_HEADLINE: all.share(COV, cur),
    },
    verdict: all.share(COV, cur) < ATTR_COVERAGE_GATE * 100 ? "ESCALATE" : "PASS",
  };

  const L = (s: string): void => {
    process.stdout.write(s + "\n");
  };
  L("=== G-ATTR --legacy-r3 — frozen 2026-07 ladder reproduction ===");
  L(`corpus: ${report.corpus.sessions} sessions, ${report.corpus.unique_requests} unique requests`);
  L(`  COVERAGE ${pct(report.headline.coverage_pct)}  exclusive ${pct(report.headline.exclusive_pct)}  sticky ${pct(report.headline.sticky_pct)}`);
  L(`  ambiguous ${pct(report.headline.ambiguous_pct)}  pre_task ${pct(report.headline.pre_task_pct)}`);
  L(`VERDICT: ${report.verdict}`);

  if (jsonOut !== undefined) {
    await Bun.write(jsonOut, JSON.stringify(report, null, 2));
    process.stderr.write(`wrote ${jsonOut}\n`);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.includes("--legacy-r3")) {
    await runLegacyR3(argv);
    return;
  }
  await runLiveMain(argv);
}

if (import.meta.main) {
  await main();
}

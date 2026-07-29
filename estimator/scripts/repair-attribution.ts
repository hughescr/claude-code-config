#!/usr/bin/env bun
/**
 * scripts/repair-attribution.ts — the one-shot, idempotent land step for the
 * attribution repair (F1–F4) and the anomaly reclassification.
 *
 * Run it AFTER the code fix is on disk, never before: the anomaly retractions below
 * remove rows the pre-fix ingest would immediately write again, and `phase_unmapped`'s
 * old detail string interpolated a wave count that moves between sweeps, so the
 * rewritten rows would not even dedup against what was left.
 *
 *     bun run scripts/repair-attribution.ts              # DRY RUN, writes nothing
 *     bun run scripts/repair-attribution.ts --apply
 *
 * **What it does, in order.**
 *  1. Snapshots the database with `VACUUM INTO backups/` (a read; the live file is
 *     not touched) and dumps every anomaly row it is about to delete to a JSON file
 *     beside it. Deleting from `anomaly` is destructive and irreversible in place;
 *     `src/audit.ts` already establishes deletion-with-a-ledger-row as sanctioned for
 *     this table, and this follows it at file grain so the retraction does not itself
 *     re-flood the ledger with hundreds of `audit_removed` rows.
 *  2. Records the "before" numbers, so the correction is auditable rather than
 *     asserted.
 *  3. Retracts the three anomaly shapes the classifier no longer produces, keeps the
 *     genuine ones untouched, and appends ONE `audit_removed` row naming the counts
 *     and the dump file.
 *  4. Re-runs attribution and everything downstream of it (status promotion, run
 *     segments, burn cache). With F4's clear-then-write this both ADDS and REMOVES
 *     claims, which is what makes the repair a plain re-attribution rather than a
 *     bespoke migration.
 *  5. Asserts the conservation invariants that would catch a double-count — INSIDE the
 *     same transaction as steps 3 and 4, so a violation rolls the whole repair back
 *     rather than reporting on a database it has already rewritten — and prints
 *     before/after.
 *
 * **Idempotent.** Every deletion predicate is false once applied, the retraction row
 * goes through the same (kind, detail) dedup `insertAnomalies` uses, and attribution
 * is idempotent by construction. Running it twice is a no-op on the second pass, and
 * the script says so.
 *
 * **What it deliberately does NOT do.** It never touches `estimate`, `estimate_block`,
 * `outcome`, `task_scope`, `refclass` or `eta_run` — the six append-only ledgers, each
 * with ABORT triggers. If a wrong actual has already been frozen into `outcome`, the
 * correction is a NEW revision through `est close`, never an UPDATE. It also never
 * re-points an existing `task_alias` row: that is the one operation `est bind` refuses
 * by design, and doing it here silently would be worse.
 *
 * It does not re-read the corpus either. `est backfill` is the follow-up, and it
 * is what re-emits the classified `agent_never_returned` / `wf_relaunch_orphan` rows
 * for the agents whose old rows this script retracts. The script prints the command.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DB_PATH, ROOT, openDb } from "../src/db.ts";
import { withLock } from "../src/lock.ts";
import { attributeTasks } from "../src/attribute.ts";
import { promoteStartedTasks } from "../src/promote.ts";
import { refreshSegments } from "../src/eta.ts";
import { refreshBurnCache } from "../src/burn.ts";

// ---------------------------------------------------------------------------
// the retraction predicates
// ---------------------------------------------------------------------------

/**
 * The three shapes the fixed ingest no longer writes, each matched on the OLD
 * wording so a row written by the new classifier can never be caught by one.
 *
 * `keep` names the two shapes that are real and stay: a `phaseIndex` that resolves
 * to nothing in `phases[]` (the only signal in the corpus for a workflow whose
 * script calls `phase()` outside `meta.phases`), and a `workflow_agent` record with
 * no `agentId`.
 */
const RETRACTIONS: ReadonlyArray<{ kind: string; like: string; why: string }> = [
  {
    kind: "wf_record_mismatch",
    like: "%has no label — the §3.2 authoring rule%",
    why: "false in 100% of cases: not one workflowProgress record in the corpus has a null label, so every one of these named an agent with NO record at all",
  },
  {
    kind: "wf_record_mismatch",
    like: "%in journal.jsonl but absent from workflowProgress%",
    why: "a duplicate of the ingest classifier's own row for the same agent; the discovery cross-check no longer writes it",
  },
  {
    kind: "wf_record_mismatch",
    like: "% launches share this runId%",
    why: "a real fact under the wrong kind, re-keyed to the benign wf_relaunch_detected with a detail that does not move between sweeps",
  },
  {
    kind: "phase_unmapped",
    like: "%clustering produced%",
    why: "the detail interpolated a wave count that changed between sweeps, defeating insertAnomalies' (kind, detail) dedup; the classifier rewrites the survivors with a stable detail and the right reason",
  },
];

const KEEP_MARKERS = ["matches no entry in phases[]", "has no agentId"] as const;

interface Counts {
  anomalies_total: number;
  by_kind: Record<string, number>;
  turns_bound: number;
  agents_bound: number;
  runs_bound: number;
  segments_bound: number;
  requests_by_attr: Record<string, number>;
  wcet_by_tid: Record<string, number>;
}

function snapshotCounts(db: Database): Counts {
  const byKind: Record<string, number> = {};
  for (const r of db
    .query<{ kind: string; n: number }, []>("SELECT kind, COUNT(*) AS n FROM anomaly GROUP BY kind")
    .all()) {
    byKind[r.kind] = r.n;
  }
  const byAttr: Record<string, number> = {};
  for (const r of db
    .query<{ attr: string; n: number }, []>("SELECT attr, COUNT(*) AS n FROM request GROUP BY attr")
    .all()) {
    byAttr[r.attr] = r.n;
  }
  const byTid: Record<string, number> = {};
  for (const r of db
    .query<{ tid: string; wcet: number }, []>(
      "SELECT tid, ROUND(COALESCE(SUM(wcet), 0)) AS wcet FROM v_wcet WHERE tid IS NOT NULL GROUP BY tid",
    )
    .all()) {
    byTid[r.tid] = r.wcet;
  }
  const scalar = (sql: string): number => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  return {
    anomalies_total: scalar("SELECT COUNT(*) AS n FROM anomaly"),
    by_kind: byKind,
    turns_bound: scalar("SELECT COUNT(*) AS n FROM turn WHERE tid IS NOT NULL"),
    agents_bound: scalar("SELECT COUNT(*) AS n FROM agent_run WHERE tid IS NOT NULL"),
    runs_bound: scalar("SELECT COUNT(*) AS n FROM workflow_run WHERE tid IS NOT NULL"),
    segments_bound: scalar("SELECT COUNT(*) AS n FROM run_segment WHERE tid IS NOT NULL"),
    requests_by_attr: byAttr,
    wcet_by_tid: byTid,
  };
}

interface AnomalyRow {
  id: number;
  ts: string;
  kind: string;
  detail: string;
  tid: string | null;
}

function doomedRows(db: Database): AnomalyRow[] {
  const out: AnomalyRow[] = [];
  const seen = new Set<number>();
  for (const r of RETRACTIONS) {
    for (const row of db
      .query<AnomalyRow, [string, string]>(
        "SELECT id, ts, kind, detail, tid FROM anomaly WHERE kind = ? AND detail LIKE ? ORDER BY id",
      )
      .all(r.kind, r.like)) {
      // A row that carries a keep-marker is never doomed, whatever else it matches.
      if (KEEP_MARKERS.some((m) => row.detail.includes(m))) continue;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

/**
 * The invariants that catch a double-count. Each is a fact that must hold AFTER the
 * repair regardless of how much spend moved, so a violation is a bug in the pass
 * rather than a surprise about the corpus.
 */
function assertConservation(db: Database): string[] {
  const problems: string[] = [];
  const dupRequests =
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM (SELECT request_id FROM request GROUP BY request_id HAVING COUNT(*) > 1)",
      )
      .get()?.n ?? 0;
  if (dupRequests > 0) problems.push(`${dupRequests} duplicated request_id(s)`);

  const replayBound =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM request WHERE attr = 'replay' AND tid IS NOT NULL").get()
      ?.n ?? 0;
  if (replayBound > 0) problems.push(`${replayBound} replay row(s) carry a tid — §5.2 excludes them from every sum`);

  // The denominator must be every session ATTRIBUTION IS ALLOWED TO REACH, not just
  // the session-aliased ones. `src/attribute.ts` resolves a request through its agent
  // and through its workflow run as well as through its turn, and both of those
  // routinely live in a DIFFERENT session from the task's anchor — `est bind --run`
  // exists for exactly that case (a run's transcripts under one session, its state
  // file under another), and the module's own F4 test builds it. Restricted to
  // `id_kind='session'`, a single legitimate `est bind --run` put the numerator above
  // the denominator and this invariant reported "the shape a double-count has" about
  // a correctly attributed database — a safety net that cries wolf on the supported
  // binding path is worse than none, because the next real violation reads as noise.
  const reachableSessions = `
    SELECT session_id FROM task_alias WHERE id_kind = 'session'
    UNION
    SELECT session_id FROM workflow_run
     WHERE run_id IN (SELECT local_id FROM task_alias WHERE id_kind = 'workflow_run')
    UNION
    SELECT session_id FROM agent_run
     WHERE agent_id IN (SELECT local_id FROM task_alias WHERE id_kind = 'agent')
        OR run_id IN (SELECT local_id FROM task_alias WHERE id_kind = 'workflow_run')`;
  const ok =
    db
      .query<{ ok: number }, []>(
        `SELECT ((SELECT COALESCE(SUM(wcet), 0) FROM v_wcet WHERE tid IS NOT NULL)
              <= (SELECT COALESCE(SUM(wcet), 0) FROM v_wcet
                   WHERE session_id IN (${reachableSessions}))) AS ok`,
      )
      .get()?.ok ?? 0;
  if (ok !== 1) {
    problems.push(
      "attributed WCET exceeds the WCET of the sessions the tasks are bound to — the shape a double-count has",
    );
  }
  return problems;
}

/**
 * Thrown to roll steps 2–4 back when conservation fails. Carries the problems so the
 * caller can report them after the transaction has been undone.
 */
class ConservationFailure extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "ConservationFailure";
  }
}

// ---------------------------------------------------------------------------

function isoStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface RepairOptions {
  dbPath?: string;
  backupDir?: string;
  apply?: boolean;
  now?: Date;
  out?: (s: string) => void;
}

export interface RepairResult {
  applied: boolean;
  snapshot: string | null;
  dump: string | null;
  retracted: number;
  retracted_by_kind: Record<string, number>;
  kept: number;
  before: Counts;
  after: Counts | null;
  problems: string[];
}

export function repairAttribution(db: Database, options: RepairOptions = {}): RepairResult {
  const apply = options.apply ?? false;
  const now = options.now ?? new Date();
  const out = options.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const backupDir = options.backupDir ?? join(ROOT, "backups");
  const stamp = isoStamp(now);

  const before = snapshotCounts(db);
  const doomed = doomedRows(db);
  const retractedByKind: Record<string, number> = {};
  for (const r of doomed) retractedByKind[r.kind] = (retractedByKind[r.kind] ?? 0) + 1;
  const kept =
    db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'wf_record_mismatch'
           AND (detail LIKE '%matches no entry in phases[]%' OR detail LIKE '%has no agentId%')`,
      )
      .get()?.n ?? 0;

  out(`anomaly ledger: ${before.anomalies_total} row(s)`);
  for (const [kind, n] of Object.entries(before.by_kind).sort((a, b) => b[1] - a[1])) {
    out(`  ${kind.padEnd(26)} ${n}`);
  }
  out("");
  out(`retracting ${doomed.length} row(s):`);
  for (const r of RETRACTIONS) {
    const n = doomed.filter((d) => d.kind === r.kind && matches(d.detail, r.like)).length;
    out(`  ${n.toString().padStart(4)}  ${r.kind}  — ${r.why}`);
  }
  out(`keeping ${kept} genuine wf_record_mismatch row(s) (plan/authoring mismatches)`);
  out("");
  out(`binding before: ${before.turns_bound} turn, ${before.agents_bound} agent, ${before.runs_bound} run, ${before.segments_bound} segment`);

  if (!apply) {
    out("");
    out("DRY RUN — nothing written. Re-run with --apply.");
    return {
      applied: false,
      snapshot: null,
      dump: null,
      retracted: doomed.length,
      retracted_by_kind: retractedByKind,
      kept,
      before,
      after: null,
      problems: [],
    };
  }

  // --- 1. snapshot + dump, before a single row is removed --------------------
  mkdirSync(backupDir, { recursive: true });
  const snapshot = join(backupDir, `pre-attr-repair-${stamp}.db`);
  db.query("VACUUM INTO ?").run(snapshot);
  const dump = join(backupDir, `anomaly-reclass-${stamp}.json`);
  writeFileSync(dump, `${JSON.stringify(doomed, null, 1)}\n`, "utf8");
  out(`snapshot: ${snapshot}`);
  out(`retracted rows dumped to: ${dump}`);

  // --- 2-4. retract, re-attribute, ASSERT — one enclosing transaction --------
  // The invariant is checked INSIDE the write, and a violation throws so SQLite
  // undoes every step of it. Previously each step committed on its own and the
  // assertion ran afterwards, so "CONSERVATION CHECK FAILED" was a report about a
  // database that had ALREADY been rewritten — exit 3 named the damage instead of
  // preventing it, and the only way back was the snapshot taken in step 1. Nested
  // `db.transaction()` calls (attribution, segments, burn cache each open their own)
  // become SAVEPOINTs inside this one, so they roll back with it.
  let attribution = { tasks: 0, turns_assigned: 0, agents_assigned: 0, runs_assigned: 0, requests_assigned: 0 };
  let burnRows = 0;
  let problems: string[] = [];
  const body = (): void => {
    if (doomed.length > 0) {
      const del = db.prepare("DELETE FROM anomaly WHERE id = ?");
      for (const r of doomed) del.run(r.id);
      const detail =
        `attribution repair: retracted ${doomed.length} anomaly row(s) ` +
        `(${Object.entries(retractedByKind)
          .map(([k, n]) => `${k}=${n}`)
          .sort()
          .join(", ")}) — in-flight sweep races, a duplicated journal cross-check and ` +
        `wave-count dedup failures. Full rows dumped beside the pre-repair snapshot in backups/. ` +
        `The classifier re-emits the correct, benign rows on the next \`est backfill\`.`;
      const already =
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'audit_removed' AND detail = ?",
          )
          .get(detail)?.n ?? 0;
      if (already === 0) {
        db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES (?, 'audit_removed', ?, NULL)").run(
          now.toISOString(),
          detail,
        );
      }
    }

    // --- 3. re-attribute, and everything downstream of attribution -----------
    attribution = attributeTasks(db);
    out("");
    out(
      `attribution: ${attribution.tasks} task(s) — ${attribution.turns_assigned} turn, ` +
        `${attribution.agents_assigned} agent, ${attribution.runs_assigned} run, ` +
        `${attribution.requests_assigned} request row(s) changed`,
    );
    const promotion = promoteStartedTasks(db);
    out(
      `promotion: ${promotion.promoted} promoted, ${promotion.started_at_set} started_at set, ` +
        `${promotion.started_at_backdated} backdated`,
    );
    db.transaction(() => {
      refreshSegments(db, { now, all: true });
    }).immediate();
    db.transaction(() => {
      burnRows = refreshBurnCache(db, now);
    }).immediate();
    out(`burn_cache: ${burnRows} row(s) refreshed`);

    // --- 4. assert, INSIDE the write ----------------------------------------
    const found = assertConservation(db);
    if (found.length > 0) throw new ConservationFailure(found);
  };

  try {
    db.transaction(body).immediate();
  } catch (e) {
    if (!(e instanceof ConservationFailure)) throw e;
    problems = e.problems;
  }

  // Read AFTER the transaction settled, so these are the numbers actually on disk —
  // the pre-repair ones when it rolled back, the repaired ones when it committed.
  const after = snapshotCounts(db);

  out("");
  out(`binding after:  ${after.turns_bound} turn, ${after.agents_bound} agent, ${after.runs_bound} run, ${after.segments_bound} segment`);
  const tids = new Set([...Object.keys(before.wcet_by_tid), ...Object.keys(after.wcet_by_tid)]);
  if (tids.size > 0) {
    out("");
    out("WCET per tid (before -> after):");
    for (const tid of [...tids].sort()) {
      const b = before.wcet_by_tid[tid] ?? 0;
      const a = after.wcet_by_tid[tid] ?? 0;
      if (b === a) continue;
      const ratio = b === 0 ? "new" : `${(a / b).toFixed(2)}x`;
      out(`  ${tid}  ${b} -> ${a}  (${ratio})`);
    }
  }
  if (problems.length > 0) {
    out("");
    out("CONSERVATION CHECK FAILED — every change above was ROLLED BACK:");
    for (const p of problems) out(`  ${p}`);
    out(`the database is unchanged; the pre-repair snapshot is still at ${snapshot}`);
  }
  out("");
  out("next: `bun run src/cli.ts backfill` — the corpus re-read that re-emits the");
  out("      classified anomaly rows, then run it a SECOND time and confirm it writes none.");

  return {
    applied: true,
    snapshot,
    dump,
    retracted: doomed.length,
    retracted_by_kind: retractedByKind,
    kept,
    before,
    after,
    problems,
  };
}

/** SQL LIKE with only `%` wildcards, which is all {@link RETRACTIONS} uses. */
function matches(detail: string, like: string): boolean {
  const parts = like.split("%").filter((p) => p.length > 0);
  let at = 0;
  for (const part of parts) {
    const i = detail.indexOf(part, at);
    if (i < 0) return false;
    at = i + part.length;
  }
  return true;
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dbFlag = argv.indexOf("--db");
  const dbPath = dbFlag >= 0 ? (argv[dbFlag + 1] ?? DB_PATH) : DB_PATH;

  const code = await withLock(() => {
    const db = openDb({ path: dbPath });
    try {
      const result = repairAttribution(db, { apply });
      return result.problems.length > 0 ? 3 : 0;
    } finally {
      db.close();
    }
  });
  process.exit(code);
}

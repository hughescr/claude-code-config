/**
 * src/audit.ts — P2.12, the mandated DB audit: `est audit [--json] [--fix]`.
 *
 * **Why this exists as a COMMAND rather than as a one-off.** The live calibration
 * database once contained rows fabricated by a review pass — a `task_event` from a
 * session that does not exist, plus pipe-test `anomaly` rows. Those rows were small;
 * the principle is not. `estimator.db` is the ledger velocity is fitted from, and a row
 * in it that cannot be traced to the corpus is indistinguishable from a measurement.
 * The forensic pass that removed them was a hand-run exercise. This is that pass made
 * repeatable, so the next one is a command.
 *
 * ## Read-only by default. The report is the product; the fix is the exception.
 *
 * ## `--fix` is bounded by the doctrine, not by judgement
 *
 * It may delete **only** from the derived and ledger tables — {@link FIXABLE}:
 * `task_event`, `anomaly`, `burn_cache`, `sweep_state`, `run_segment` — every one of
 * which any sweep can reconstruct. Each deletion writes one
 * `anomaly(kind='audit_removed')` carrying the **full deleted row as JSON**, so the
 * cleanup is itself recorded in the ledger it cleaned; an audit whose own work leaves
 * no trace is the same class of thing as the rows it exists to remove.
 *
 * The append-only spine (`estimate`, `estimate_block`, `task_scope`, `outcome`,
 * `refclass`, `eta_run`) is **reported and never fixed**, and asking `--fix` while a
 * spine finding stands exits `2` — P1.12's rule applied to the one tool most likely to
 * want to break it. A wrong estimate is corrected by appending a better one.
 *
 * ## What "unknown session" means, and why it takes two sources
 *
 * A session is KNOWN if a transcript for it is on disk right now, **or** if some
 * `sweep_state.path` names it. Either alone is wrong in a way that manufactures
 * findings: disk alone condemns every session the retention window has since pruned
 * (most of the corpus, on an old database), and `sweep_state` alone condemns anything
 * ingested through a path that has since been rewritten. Both together answer the
 * question actually being asked — "did this row ever correspond to something real?"
 */

import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { discoverCorpus, PROJECTS_ROOT } from "./discover.ts";

/**
 * The five tables `--fix` may delete from, with the columns that identify one row.
 *
 * The list is a doctrine statement, not a convenience: every table here is DERIVED
 * (a sweep rebuilds it) or a LEDGER of the sweeper's own observations. Nothing that
 * carries an authored number is reachable from this map, and nothing may be added to
 * it without the same argument.
 */
export const FIXABLE: Readonly<Record<string, readonly string[]>> = {
  task_event: ["ev"],
  anomaly: ["id"],
  burn_cache: ["tid"],
  sweep_state: ["path"],
  run_segment: ["session_id", "started_at", "gap_min"],
};

/** The append-only spine. Reported, never fixed — the whole point of P1.12. */
export const SPINE = ["estimate", "estimate_block", "task_scope", "outcome", "refclass", "eta_run"] as const;

export type AuditCheck = 1 | 2 | 3 | 4 | 5;

export interface AuditFinding {
  check: AuditCheck;
  table: string;
  /** Why these rows are a finding, in one sentence a reader can act on. */
  reason: string;
  /** True iff `table` is in {@link FIXABLE}: `--fix` can delete these. */
  fixable: boolean;
  /** True iff `table` is on the append-only spine: `--fix` must REFUSE. */
  spine: boolean;
  n: number;
  /** The full rows, so the report carries its own evidence and `--fix` its own input. */
  rows: Array<Record<string, unknown>>;
}

export interface AuditReport {
  as_of: string;
  root: string;
  /** Sessions the corpus/`sweep_state` pair vouches for — the denominator of check 1. */
  known_sessions: number;
  findings: AuditFinding[];
  /** Rows deleted by `--fix`, by table. Empty (and all-zero) on a read-only run. */
  removed: Record<string, number>;
  fixed: boolean;
  /** True when a spine finding stood while `--fix` was asked for (exit 2). */
  spine_refused: boolean;
}

/** Rows carried per finding. A finding is evidence; an unbounded dump is a hazard. */
const MAX_ROWS_PER_FINDING = 500;

/**
 * Sessions that ever corresponded to something real: on disk now, or named by a
 * `sweep_state` path. See the module doc for why one source alone is not enough.
 */
export function knownSessions(db: Database, root: string = PROJECTS_ROOT): Set<string> {
  const known = new Set<string>();
  for (const s of discoverCorpus(root).sessions) known.add(s.sessionId);
  for (const r of db.query<{ path: string }, []>("SELECT path FROM sweep_state").all()) {
    // `<sessionId>.jsonl` for a main transcript; anything under `<sessionId>/` carries
    // the id in a directory component, so both forms are harvested.
    const base = basename(r.path);
    known.add(base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base);
    for (const part of r.path.split("/")) if (part !== "") known.add(part);
  }
  return known;
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

/**
 * Rows in `table` whose `session_id` is not in `known`.
 *
 * Batched against SQLite's parameter ceiling by filtering in JS rather than binding
 * the whole known-set into a `NOT IN (...)`: the known set is the size of the corpus,
 * which is exactly the quantity that must not become a query's parameter count.
 */
function unknownSessionRows(
  db: Database,
  table: string,
  known: ReadonlySet<string>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all()) {
    const sid = row.session_id;
    if (typeof sid !== "string" || sid === "") continue; // NOT NULL sentinels are not sessions
    if (known.has(sid)) continue;
    out.push(row);
    if (out.length >= MAX_ROWS_PER_FINDING) break;
  }
  return out;
}

function finding(
  check: AuditCheck,
  table: string,
  reason: string,
  rows: Array<Record<string, unknown>>,
): AuditFinding | null {
  if (rows.length === 0) return null;
  return {
    check,
    table,
    reason,
    fixable: table in FIXABLE,
    spine: (SPINE as readonly string[]).includes(table),
    n: rows.length,
    rows,
  };
}

/**
 * The five checks. Read-only: {@link applyFix} is the only thing that deletes, and it
 * takes this report as its input rather than re-deriving anything.
 */
export function auditReport(
  db: Database,
  opts: { root?: string; now?: Date } = {},
): AuditReport {
  const root = opts.root ?? PROJECTS_ROOT;
  const now = opts.now ?? new Date();
  const known = knownSessions(db, root);
  const findings: AuditFinding[] = [];
  const push = (f: AuditFinding | null): void => {
    if (f !== null) findings.push(f);
  };

  // ---- check 1: a session_id nothing on disk and no sweep ever saw -----------
  // `run_segment` is deliberately absent: check 4 owns it, so a row is reported once.
  for (const table of ["task_event", "request", "turn", "agent_run", "workflow_run", "job_run", "otel_request"]) {
    push(
      finding(
        1,
        table,
        `session_id appears in no sweep_state path and matches no transcript on disk — the advisory-41 shape (a row that cannot be traced to the corpus is indistinguishable from a measurement)`,
        unknownSessionRows(db, table, known),
      ),
    );
  }

  // ---- check 2: task_alias pointing at nothing ------------------------------
  push(
    finding(
      2,
      "task_alias",
      "the (session_id, local_id) this alias binds resolves to no session on disk and to no swept path — the tid is bound to an identity that never existed",
      unknownSessionRows(db, "task_alias", known),
    ),
  );

  // ---- check 3: a nullable tid pointing at no task --------------------------
  // `request.tid` is FK-protected and CANNOT dangle; these three are nullable and are
  // written by the attribution pass, so they can.
  for (const table of ["turn", "agent_run", "task_event"]) {
    push(
      finding(
        3,
        table,
        "tid is set but names no `task` row — `request.tid` is FK-protected and cannot do this, these columns are nullable and can",
        db
          .query<Record<string, unknown>, []>(
            `SELECT * FROM ${table}
              WHERE tid IS NOT NULL AND tid NOT IN (SELECT tid FROM task)
              LIMIT ${MAX_ROWS_PER_FINDING}`,
          )
          .all(),
      ),
    );
  }

  // ---- check 4: derived rows that outlived what derived them ----------------
  push(
    finding(
      4,
      "burn_cache",
      "a burn_cache row for a TERMINAL task — the cache exists to answer `est burn` for work in flight, and a finalized task's numbers come from `outcome`",
      db
        .query<Record<string, unknown>, []>(
          `SELECT b.* FROM burn_cache b JOIN task t USING (tid)
            WHERE t.status IN ('completed','abandoned','deleted')
            LIMIT ${MAX_ROWS_PER_FINDING}`,
        )
        .all(),
    ),
  );
  push(
    finding(
      4,
      "run_segment",
      "run_segment for a session nothing on disk and no sweep ever saw — segments are the check-back fitting corpus, so a phantom one is a phantom observation",
      unknownSessionRows(db, "run_segment", known),
    ),
  );

  // ---- check 5: the append-only spine, REPORTED ONLY ------------------------
  // Every spine row hangs off a tid, and the tid's anchor session is what ties it to
  // the corpus. `refclass` and `eta_run` are corpus-level snapshots with no anchor
  // session at all, so there is nothing here for them to fail — they are named in
  // {@link SPINE} because `--fix` must refuse them, not because they are checkable.
  const spineAnchor: Record<string, string> = {
    estimate: "SELECT e.* FROM estimate e JOIN task t USING (tid)",
    task_scope: "SELECT s.* FROM task_scope s JOIN task t USING (tid)",
    outcome: "SELECT o.* FROM outcome o JOIN task t USING (tid)",
  };
  for (const [table, sql] of Object.entries(spineAnchor)) {
    const anchors = db
      .query<Record<string, unknown> & { anchor_session: string | null }, []>(
        `${sql.replace(/SELECT (\w)\.\*/, "SELECT $1.*, t.anchor_session AS anchor_session")}
          WHERE t.anchor_session IS NOT NULL`,
      )
      .all();
    const bad: Array<Record<string, unknown>> = [];
    for (const row of anchors) {
      if (known.has(String(row.anchor_session))) continue;
      bad.push(row);
      if (bad.length >= MAX_ROWS_PER_FINDING) break;
    }
    push(
      finding(
        5,
        table,
        "the anchoring task's session matches no transcript and no swept path — REPORTED ONLY: this table is append-only, and the repair is to append a correction, never to delete the row",
        bad,
      ),
    );
  }

  return {
    as_of: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    root,
    known_sessions: known.size,
    findings,
    removed: {},
    fixed: false,
    spine_refused: false,
  };
}

/**
 * Delete the fixable findings, recording each removal as `anomaly('audit_removed')`
 * with the full deleted row as JSON.
 *
 * Call INSIDE a transaction, under the writer lock — the deletion and its ledger row
 * are one fact, and a crash between them would leave the database cleaner than its own
 * record of it. Returns per-table counts; mutates nothing in `report` (the caller
 * folds the result in), so a dry read of the report stays a dry read.
 */
export function applyFix(db: Database, report: AuditReport, nowIso: string): Record<string, number> {
  const removed: Record<string, number> = {};
  const insertAnomaly = db.prepare(
    "INSERT INTO anomaly (ts, kind, detail, tid) VALUES ($ts, 'audit_removed', $detail, NULL)",
  );

  for (const f of report.findings) {
    const keys = FIXABLE[f.table];
    if (keys === undefined) continue;
    const where = keys.map((k) => `${k} IS ?`).join(" AND ");
    const del = db.prepare(`DELETE FROM ${f.table} WHERE ${where}`);
    for (const row of f.rows) {
      // The ledger row goes in FIRST: if the delete then fails the transaction rolls
      // both back, whereas the other order can commit a deletion whose record failed.
      insertAnomaly.run({
        $ts: nowIso,
        $detail: `audit removed 1 row from ${f.table} (check ${f.check}): ${JSON.stringify(row)}`,
      } as never);
      del.run(...keys.map((k) => row[k] as never));
      removed[f.table] = (removed[f.table] ?? 0) + 1;
    }
  }
  return removed;
}

/** The human report. One line per finding, then what `--fix` would or did do. */
export function renderAudit(r: AuditReport): string {
  const lines: string[] = [`est audit  ${r.as_of}  ·  ${r.known_sessions} known session(s)  ·  root ${r.root}`];
  if (r.findings.length === 0) {
    lines.push("  clean — every row traces to the corpus");
    return lines.join("\n");
  }
  for (const f of r.findings) {
    const tag = f.spine ? "APPEND-ONLY" : f.fixable ? "fixable" : "reported";
    lines.push(`  [${f.check}] ${f.table.padEnd(14)} ${String(f.n).padStart(5)} row(s)  (${tag})`);
    lines.push(`      ${f.reason}`);
  }
  const removedTotal = Object.values(r.removed).reduce((a, b) => a + b, 0);
  if (r.fixed) {
    lines.push(
      removedTotal === 0
        ? "  --fix: nothing was deletable (every finding is outside the five derived/ledger tables)"
        : `  --fix: removed ${removedTotal} row(s) — ${Object.entries(r.removed)
            .map(([t, n]) => `${t} ${n}`)
            .join(", ")}; each one recorded as anomaly(audit_removed)`,
    );
  }
  if (r.spine_refused) {
    lines.push(
      "  --fix REFUSED on the append-only spine: correct a spine row by APPENDING a better one" +
        " (`est open --tid <tid> --reason …`, `est scope`, `est close`), never by deleting it.",
    );
  }
  return lines.join("\n");
}

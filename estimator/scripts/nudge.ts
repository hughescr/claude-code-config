#!/usr/bin/env bun
/**
 * scripts/nudge.ts — PostToolUse hook body for matcher `Task|Workflow`
 * (design R4 §Phase 1 interfaces, P1.10; enforcement rationale in §3.3).
 *
 * ADVISORY ONLY. Every path through this file ends in `process.exit(0)` — a
 * hook that fails Craig's hot path is strictly worse than one that does
 * nothing (P1.0: "Hooks never exit non-zero"). Nothing in here ever takes the
 * sweep lock or opens the database for write.
 *
 * Three jobs, deliberately split by cost:
 *
 *   1. Foreground, decide: one read-only indexed query — does an open,
 *      non-terminal task have a `task_alias` binding to this session? If not,
 *      emit a budgeted nudge naming the `estimating` skill.
 *   2. Foreground, record: append ONE line to spool/compliance.jsonl,
 *      regardless of the decision above. A single O_APPEND write, no lock,
 *      no DB. The next sweep drains it; a line that survives a crash is
 *      drained on the next sweep, which is the point.
 *   3. Background, micro-sweep: spawn a throttled, DETACHED `est sweep` so it
 *      cannot consume this hook's timeout. Throttled by an mtime check on a
 *      spool marker file — a filesystem stat, not a database read.
 *
 * A fourth, best-effort job piggybacks on job 1 when a task IS bound: the
 * overrun nudge against `burn_cache` (P1.9). `burn_cache` is schema v5 and
 * does not exist on a v4 database yet (built concurrently) — that lookup is
 * wrapped and treated as "nothing to report" on any failure, per the no-op
 * requirement this file is tested against.
 *
 * Every DB access opens **read-only** and is independently wrapped: a missing
 * database, a schema-version mismatch, a locked file, or a missing table are
 * all "no binding found" / "no overrun to report", never a crash.
 */

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DB_PATH, ROOT, openDb } from "../src/db.ts";

// `EST_DB` already overrides the database path (db.ts); this mirrors that
// convention for the spool directory so tests never have to touch the real
// spool/ under estimator/ — production is unaffected since the var is unset.
const SPOOL_DIR = process.env.EST_SPOOL_DIR ?? join(ROOT, "spool");
const COMPLIANCE_LOG = join(SPOOL_DIR, "compliance.jsonl");
const NUDGE_BUDGET = 500; // P1.10 job 1: "budgeted to <=500 characters"
const OVERRUN_BUDGET = 300; // P1.10 job 4: "a <=300-character additionalContext"
const MIN_MICROSWEEP_INTERVAL_S = Number.parseInt(
  process.env.EST_MICROSWEEP_MIN_INTERVAL_S ?? "20",
  10,
);

const NUDGE_TEXT =
  "est: no open estimate is bound to this session. If this Task/Workflow launch is " +
  "substantial (T1-T4, see CLAUDE.md), run the `estimating` skill before continuing.";

interface HookInput {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

function readStdin(): string {
  try {
    return require("node:fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** `text` must already be budgeted by the caller (job 1: <=500 chars, job 4: <=300). */
function nudgePayload(text: string): Record<string, unknown> {
  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
    // Unverified whether additionalContext is honoured on PostToolUse (§3.3, P1.10) —
    // systemMessage rides alongside it as a documented-elsewhere fallback surface.
    systemMessage: text,
  };
}

/**
 * Does an open, non-terminal task have a task_alias binding to this session?
 * Read-only. A session can host several (schema v6), so this picks the newest — the
 * same task `est burn --session` puts on the statusline, which is what keeps the
 * overrun nudge and the band it is nudging about about the same piece of work.
 */
function findBoundTid(sessionId: string): string | null {
  const db = openDb({ readonly: true });
  try {
    const row = db
      .query<{ tid: string }, [string]>(
        `SELECT t.tid AS tid
           FROM task_alias a
           JOIN task t ON t.tid = a.tid
          WHERE a.session_id = ?
            AND t.status NOT IN ('completed','abandoned','deleted')
          ORDER BY a.first_seen DESC, a.tid DESC
          LIMIT 1`,
      )
      .get(sessionId);
    return row?.tid ?? null;
  } finally {
    db.close();
  }
}

/**
 * Best-effort overrun check against burn_cache (P1.9, schema v5). Returns the
 * nudge text once per threshold crossing per task, or null when there is
 * nothing to report — including "the table doesn't exist yet".
 */
function tryOverrunNudge(tid: string): string | null {
  try {
    const db = openDb({ readonly: true });
    try {
      const row = db
        .query<{ consumed_wcet: number; cal_p90_wcet: number }, [string]>(
          `SELECT bc.consumed_wcet AS consumed_wcet, e.cal_p90_wcet AS cal_p90_wcet
             FROM burn_cache bc
             JOIN estimate e
               ON e.tid = bc.tid
              AND e.version = (SELECT MAX(version) FROM estimate WHERE tid = bc.tid)
            WHERE bc.tid = ?`,
        )
        .get(tid);
      if (!row || row.cal_p90_wcet <= 0) return null;
      if (row.consumed_wcet < row.cal_p90_wcet) return null;

      // Once per threshold crossing per task (§6.3, P1.10 job 4).
      const marker = join(SPOOL_DIR, `.overrun-notified.${sanitizeForFilename(tid)}`);
      if (existsSync(marker)) return null;
      mkdirSync(SPOOL_DIR, { recursive: true });
      writeFileSync(marker, new Date().toISOString());

      return (
        `est: task ${tid} is over its p90 band ` +
        `(consumed ${row.consumed_wcet} vs p90 ${row.cal_p90_wcet} Work-CET). ` +
        "Run `est open --reason refinement` or `est scope` + `--reason scope_change`."
      );
    } finally {
      db.close();
    }
  } catch {
    // burn_cache absent (v4 db, schema v5 not yet migrated), db locked/missing,
    // or any other failure: no overrun feature yet. Fail open, report nothing.
    return null;
  }
}

function sanitizeForFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
}

function recordCompliance(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  boundTid: string | null,
  nudged: boolean,
): void {
  try {
    const sha256 = createHash("sha256").update(JSON.stringify(toolInput ?? null)).digest("hex");
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool_name: toolName,
      tool_input_sha256: sha256,
      bound_tid: boundTid,
      nudged,
    });
    mkdirSync(SPOOL_DIR, { recursive: true });
    // Single O_APPEND write of one short line: atomic without a lock (§3.3, P1.10).
    appendFileSync(COMPLIANCE_LOG, `${line}\n`, { flag: "a" });
  } catch {
    // A lost compliance line is not worth failing the hook over.
  }
}

function findBun(): string | null {
  const explicit = process.env.EST_BUN;
  if (explicit && existsSync(explicit)) return explicit;
  const onPath = Bun.which("bun");
  if (onPath) return onPath;
  for (const candidate of [
    join(homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Spawn a throttled, DETACHED sweep so this hook process never waits on it.
 *
 * DESIGN.md P1.10 specifies `est sweep --session <sid> --since <watermark>` —
 * a scoped micro-sweep. Those flags do not exist on `est sweep` yet (the
 * Phase 1 CLI verb surface is built concurrently with this file); passing
 * them today would make cli.ts's flag validator reject the call outright and
 * do NO sweep at all, which is worse than the corpus-wide fallback. So this
 * spawns the existing, idempotent, ~3s full-corpus `est sweep --quiet`
 * instead. When `--session`/`--since` land, this is the only line to change.
 */
function maybeSpawnMicrosweep(sessionId: string): void {
  // Test-only escape hatch: unset (the production default) leaves this job
  // fully active. A real sweep is slow and corpus-wide (see comment above),
  // which makes it unsuitable to actually exec from unit tests.
  if (process.env.EST_DISABLE_MICROSWEEP === "1") return;
  try {
    mkdirSync(SPOOL_DIR, { recursive: true });
    const marker = join(SPOOL_DIR, `.microsweep.${sanitizeForFilename(sessionId)}`);
    let lastMs = 0;
    try {
      lastMs = statSync(marker).mtimeMs;
    } catch {
      lastMs = 0;
    }
    if (Date.now() - lastMs < MIN_MICROSWEEP_INTERVAL_S * 1000) return; // throttled

    // Touch the marker BEFORE spawning so a burst of hook fires within the
    // window collapses to at most one spawn even if the spawn itself is slow.
    writeFileSync(marker, String(Date.now()));

    const bun = findBun();
    if (bun === null) return;
    const cliPath = join(ROOT, "src", "cli.ts");
    const child = spawn(bun, ["run", cliPath, "sweep", "--quiet"], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Fail open: no sweep this time. The next hook fire, the daily cron, or a
    // manual `est sweep` catches it. Never let this block or throw.
  }
}

function main(): void {
  let input: HookInput = {};
  try {
    const raw = readStdin();
    if (raw.trim().length > 0) input = JSON.parse(raw) as HookInput;
  } catch {
    process.exit(0); // unparseable stdin: fail open, print nothing
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id : null;
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = input.tool_input;

  if (sessionId === null || sessionId.length === 0) {
    process.exit(0); // nothing to check, nothing to log
  }

  let boundTid: string | null = null;
  try {
    boundTid = findBoundTid(sessionId);
  } catch {
    boundTid = null; // missing/locked/uninitialised DB: treat as "no binding found"
  }

  const nudged = boundTid === null;
  recordCompliance(sessionId, toolName, toolInput, boundTid, nudged);

  let payload: Record<string, unknown> | null = null;
  if (boundTid === null) {
    payload = nudgePayload(truncate(NUDGE_TEXT, NUDGE_BUDGET));
  } else {
    const overrun = tryOverrunNudge(boundTid);
    if (overrun !== null) payload = nudgePayload(truncate(overrun, OVERRUN_BUDGET));
  }

  if (payload !== null) {
    process.stdout.write(JSON.stringify(payload));
  }

  maybeSpawnMicrosweep(sessionId);

  process.exit(0);
}

if (import.meta.main) {
  try {
    main();
  } catch {
    // Exhaustive fail-open (P1.10): any thrown exception -> print nothing, exit 0.
    process.exit(0);
  }
}

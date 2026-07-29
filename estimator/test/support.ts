/**
 * test/support.ts — the synthetic corpus the Phase 1 verb tests are written against.
 *
 * NOT a test file (no `.test.ts` suffix), so `bun test` never collects it.
 *
 * **Everything here is invented.** No session id, agent id, run id, subject, token
 * count or price in this file came from a real transcript, and none may: the repo is
 * public and the design's committable/local boundary (§4) forbids a real id, a real
 * path or an absolute token figure from real usage in tracked files. The ids are
 * `s1`/`p1`/`a1`-shaped and the prices are round numbers chosen so the arithmetic in
 * an assertion can be done in the head.
 *
 * The one non-obvious rule: prices are seeded from the epoch (`1970-01-01`) because
 * `v_task_actual_epoch` joins `model_price` at the ESTIMATE's `price_epoch`, which is
 * "now" when no `price_sync` row exists. A price effective from 1970 covers every
 * vintage a test can produce; a price effective "now" would race the estimate's own
 * timestamp and leave `actual_wcet_at_epoch` NULL for reasons that have nothing to do
 * with what the test is about.
 */

import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { run } from "../src/cli.ts";

/** The model every synthetic request is billed at. Deliberately not a real family. */
export const TEST_FAMILY = "claude-test-1";
/** Must equal `config.ref_model`'s seed — Work-CET is denominated in its output tokens. */
export const REF_MODEL = "claude-sonnet-4-5";

export interface Harness {
  dir: string;
  dbPath: string;
  lockPath: string;
  db: Database;
  /** Drive the real CLI, capturing stdout/stderr. `--db`/`--lock` are prepended. */
  cli: (...argv: string[]) => Promise<CliResult>;
  close: () => void;
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
  /** stdout parsed as JSON — for the `--json` contract (P1.0: exactly one object). */
  json: <T = Record<string, unknown>>() => T;
}

export function makeHarness(prefix = "est-phase1-"): Harness {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, "estimator.db");
  const lockPath = join(dir, "sweep.lock");
  const db = openDb({ path: dbPath });

  const cli = async (...argv: string[]): Promise<CliResult> => {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const code = await run(["--db", dbPath, "--lock", lockPath, ...argv], {
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
    });
    const out = outLines.join("\n");
    return {
      code,
      out,
      err: errLines.join("\n"),
      json: <T,>() => JSON.parse(out) as T,
    };
  };

  return {
    dir,
    dbPath,
    lockPath,
    db,
    cli,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** USD per Mtok, effective from the epoch so every vintage joins (see the header). */
export function price(
  db: Database,
  family: string,
  rates: { in: number; out: number; cw: number; cr: number },
  from = "1970-01-01T00:00:00Z",
): void {
  db.query(
    `INSERT OR REPLACE INTO model_price
       (family, effective_from, usd_in, usd_out, usd_cw, usd_cr, provisional, source, synced_epoch, ingested_at)
     VALUES (?,?,?,?,?,?,0,'manual',NULL,'1970-01-01T00:00:00Z')`,
  ).run(family, from, rates.in, rates.out, rates.cw, rates.cr);
}

/**
 * Both prices every priced test needs: the request family and the ref model.
 *
 * `usd_out` is 1.0 for both, which makes Work-CET numerically equal to
 * `out_tok + cw_tok` — the arithmetic an assertion wants to state directly rather than
 * re-deriving the normaliser.
 */
export function seedPrices(db: Database): void {
  price(db, TEST_FAMILY, { in: 1, out: 1, cw: 1, cr: 1 });
  price(db, REF_MODEL, { in: 1, out: 1, cw: 1, cr: 1 });
}

export interface TurnSpec {
  session?: string;
  prompt?: string;
  at?: string;
  durationMs?: number | null;
}

export function turn(db: Database, spec: TurnSpec = {}): { session: string; prompt: string } {
  const session = spec.session ?? "s1";
  const prompt = spec.prompt ?? "p1";
  db.query(
    `INSERT OR REPLACE INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid)
     VALUES (?,?,?,?,NULL,NULL,NULL)`,
  ).run(session, prompt, spec.at ?? "2026-01-01T00:00:00Z", spec.durationMs === undefined ? 1000 : spec.durationMs);
  return { session, prompt };
}

export interface RequestSpec {
  session?: string;
  prompt?: string | null;
  origin?: "main" | "subagent" | "auxiliary";
  agent?: string | null;
  run?: string | null;
  /** The relaunch discriminator, as `request.wf_launch_id` carries it. */
  launchId?: string | null;
  out?: number;
  cw?: number;
  in?: number;
  cr?: number;
  ts?: string;
  family?: string;
  skill?: string | null;
  attr?: string;
  durationMs?: number | null;
}

/** One priced request. `out`/`cw` are what Work-CET is made of (§4.1). */
export function request(db: Database, id: string, spec: RequestSpec = {}): void {
  const family = spec.family ?? TEST_FAMILY;
  db.query(
    `INSERT INTO request (request_id, message_id, is_sidechain, session_id, prompt_id, origin,
                          agent_id, run_id, wf_launch_id, model, model_family,
                          attribution_agent, attribution_skill, ts,
                          in_tok, out_tok, cw_tok, cr_tok, duration_ms, tid, attr)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    `msg-${id}`,
    spec.session ?? "s1",
    spec.prompt === undefined ? "p1" : spec.prompt,
    spec.origin ?? "main",
    spec.agent ?? null,
    spec.run ?? null,
    spec.launchId ?? null,
    family,
    family,
    spec.skill ?? null,
    spec.ts ?? "2026-01-01T00:00:00Z",
    spec.in ?? 0,
    spec.out ?? 0,
    spec.cw ?? 0,
    spec.cr ?? 0,
    spec.durationMs ?? null,
    spec.attr ?? "none",
  );
}

export interface AgentSpec {
  session?: string;
  launchPrompt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  runId?: string | null;
  /** The relaunch discriminator. Default NULL — pass it to build a multi-launch run. */
  launchId?: string | null;
  phaseIdx?: number | null;
  phaseConf?: "exact" | "inferred" | "unmapped" | null;
}

export function agentRun(db: Database, agentId: string, spec: AgentSpec = {}): void {
  db.query(
    `INSERT INTO agent_run (agent_id, session_id, run_id, wf_launch_id, agent_type, spawn_depth,
                            launch_prompt_id, transcript_path, status, label,
                            started_at, ended_at, interval_src, queued_at, attempt,
                            reported_tokens, phase_idx, phase_title, phase_conf, tid)
     VALUES (?, ?, ?, ?, 'general-purpose', 1, ?, NULL, 'completed', 'demo',
             ?, ?, 'transcript', NULL, NULL, NULL, ?, NULL, ?, NULL)`,
  ).run(
    agentId,
    spec.session ?? "s1",
    spec.runId ?? null,
    spec.launchId ?? null,
    spec.launchPrompt === undefined ? "p1" : spec.launchPrompt,
    spec.startedAt === undefined ? "2026-01-01T00:00:00Z" : spec.startedAt,
    spec.endedAt === undefined ? "2026-01-01T00:10:00Z" : spec.endedAt,
    spec.phaseIdx ?? null,
    spec.phaseConf ?? null,
  );
}

/** The seven driver flags `est open` requires, with harmless defaults. */
export function openArgs(over: Partial<Record<string, string | number>> = {}): string[] {
  const flags: Record<string, string | number> = {
    kind: "implement",
    subject: "widget pipeline rewrite",
    "raw-p50": 1000,
    "raw-p90": 3000,
    "exp-agents": 2,
    "exp-wf-phases": 0,
    "exp-files-write": 4,
    "exp-turns": 6,
    "exp-requests": 40,
    ...over,
  };
  const argv: string[] = ["open"];
  for (const [k, v] of Object.entries(flags)) {
    if (v === "") continue;
    argv.push(`--${k}`, String(v));
  }
  return argv;
}

#!/usr/bin/env bun
/**
 * Gate G-SMOKE — the Phase 2 end-to-end smoke gate.
 *
 * `bun test` proves the units; this proves the three Phase 2 deliverables work as
 * PROCESSES, over a socket and a filesystem, the way they are actually deployed:
 *
 *   1. **receiver** — start `scripts/otel-receiver.ts` on an ephemeral port, POST a
 *      synthetic OTLP/JSON `claude_code.api_request` export, assert it spools, then
 *      run a real `est sweep` and assert `duration_ms` reached `request`.
 *   2. **board** — build a fixture database with one task in every board column,
 *      render `board.html` + `board.md` through `est board --html --md`, assert both
 *      are non-empty, offline, and carry a populated card per column.
 *   3. **statusline** — run `scripts/statusline-burn.ts` exactly as ccstatusline runs
 *      it (hook JSON on stdin), assert it renders the check-back ETA, exits 0, and
 *      stays inside its render budget — plus the `est burn --json` contract the
 *      segment parses.
 *
 * **Everything is synthetic and everything is temporary.** Every database, spool and
 * output directory this gate touches is a fresh `mkdtemp`; no path here resolves to
 * the live `estimator.db`, the live spool or the real corpus, and the receiver leg
 * additionally asserts that the receiver never created a database at all. That is a
 * hard rule (P2.12): no gate may point at the live database.
 *
 * Unlike the other gates this one writes NO report file — its whole output is an exit
 * code and a transcript on stdout, so it is safe to run from a pre-commit leg.
 *
 * Usage: `bun gates/g-smoke.ts [receiver|board|statusline|all]`   (default: all)
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { attributeTasks } from "../src/attribute.ts";
import { refreshBurnCache } from "../src/burn.ts";
import { BOARD_COLUMNS } from "../src/retro.ts";
import { OTEL_LOGS_FILE, OTEL_REJECT_FILE } from "../src/otel.ts";
import { formatSegment } from "../scripts/statusline-burn.ts";

/** Repo root, derived from this file — never a hardcoded absolute path. */
const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.ts");

/** The statusline runs on every prompt render, so its budget is a hard number. */
const STATUSLINE_BUDGET_MS = 100;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let failures = 0;

function check(ok: boolean, what: string, extra = ""): boolean {
  if (ok) {
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${extra === "" ? "" : ` — ${extra}`}`);
  }
  return ok;
}

function info(s: string): void {
  console.log(`  info ${s}`);
}

interface Scratch {
  dir: string;
  dbPath: string;
  lockPath: string;
  spoolDir: string;
  /** Drive the real CLI as a subprocess, against the scratch database only. */
  est: (...argv: string[]) => Promise<{ code: number; out: string; err: string }>;
  dispose: () => void;
}

function makeScratch(prefix: string): Scratch {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, "estimator.db");
  const lockPath = join(dir, "sweep.lock");
  const spoolDir = join(dir, "spool");
  mkdirSync(spoolDir, { recursive: true });
  // EST_DB / EST_SPOOL_DIR are belt and braces: `--db` already redirects the CLI, but
  // any module that reads the module-level default must land in the scratch too.
  const env = { ...process.env, EST_DB: dbPath, EST_SPOOL_DIR: spoolDir };
  return {
    dir,
    dbPath,
    lockPath,
    spoolDir,
    est: async (...argv: string[]) => {
      const p = Bun.spawn(["bun", "run", CLI, "--db", dbPath, "--lock", lockPath, ...argv], {
        cwd: ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The seven driver flags `est open` requires, with harmless synthetic values. */
function openArgv(subject: string, session: string): string[] {
  return [
    "open",
    "--kind", "implement",
    "--subject", subject,
    "--raw-p50", "1000",
    "--raw-p90", "3000",
    "--exp-agents", "2",
    "--exp-wf-phases", "0",
    "--exp-files-write", "4",
    "--exp-turns", "6",
    "--exp-requests", "40",
    "--session", session,
    "--prompt", `${session}-p1`,
    "--json",
  ];
}

/** Epoch-effective prices, so every vintage joins (same rule as `test/support.ts`). */
function seedPrices(db: Database): void {
  for (const family of ["claude-test-1", "claude-sonnet-4-5"]) {
    db.query(
      `INSERT OR REPLACE INTO model_price
         (family, effective_from, usd_in, usd_out, usd_cw, usd_cr, provisional, source, synced_epoch, ingested_at)
       VALUES (?, '1970-01-01T00:00:00Z', 1, 1, 1, 1, 0, 'manual', NULL, '1970-01-01T00:00:00Z')`,
    ).run(family);
  }
}

const INSERT_REQUEST = `
INSERT INTO request (request_id, message_id, is_sidechain, session_id, prompt_id, origin,
                     agent_id, run_id, wf_launch_id, model, model_family,
                     attribution_agent, attribution_skill, ts,
                     in_tok, out_tok, cw_tok, cr_tok, duration_ms, tid, attr)
VALUES ($rid, NULL, 0, $sid, $pid, 'main', NULL, NULL, NULL, 'claude-test-1', 'claude-test-1',
        NULL, NULL, $ts, $in, $out, $cw, $cr, $dur, $tid, $attr)`;

function isoAt(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// 1. receiver
// ---------------------------------------------------------------------------

/**
 * The synthetic export. Every int64 is QUOTED, which is the OTLP/JSON canonical
 * encoding and the #1 silent failure of a hand-rolled parser (P2.13) — a receiver that
 * only handles the unquoted form passes every hand-written fixture and drops every real
 * payload.
 */
function otlpLogsBody(requestId: string, sessionId: string, durationMs: number): string {
  const attr = (key: string, value: Record<string, string>): Record<string, unknown> => ({ key, value });
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [attr("service.name", { stringValue: "claude-code" })] },
        scopeLogs: [
          {
            scope: { name: "com.anthropic.claude_code.events" },
            logRecords: [
              {
                eventName: "claude_code.api_request",
                timeUnixNano: "1772366400000000000",
                observedTimeUnixNano: "1772366400000000000",
                attributes: [
                  attr("request_id", { stringValue: requestId }),
                  attr("session.id", { stringValue: sessionId }),
                  attr("prompt.id", { stringValue: `${sessionId}-p1` }),
                  attr("model", { stringValue: "claude-test-1" }),
                  attr("query_source", { stringValue: "main" }),
                  attr("duration_ms", { intValue: String(durationMs) }),
                  attr("input_tokens", { intValue: "0" }),
                  attr("output_tokens", { intValue: "0" }),
                  attr("cache_creation_tokens", { intValue: "0" }),
                  attr("cache_read_tokens", { intValue: "0" }),
                  attr("attempt", { intValue: "1" }),
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

async function gateReceiver(): Promise<void> {
  console.log("\n[g-smoke] 1/3 receiver — OTLP over a real socket, then a real sweep");
  const s = makeScratch("est-smoke-receiver-");
  const REQ_ID = "smoke-req-0001";
  const SESSION = "smoke-session-0001";
  const DURATION_MS = 4242;

  const proc = Bun.spawn(["bun", "run", join(ROOT, "scripts/otel-receiver.ts"), "--port", "0"], {
    cwd: ROOT,
    env: { ...process.env, EST_SPOOL_DIR: s.spoolDir, EST_DB: s.dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });

  // `--port 0` asks the kernel to choose; the receiver announces what it actually bound,
  // and that announcement is the only authority on where to POST.
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  let banner = "";
  let port = 0;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    banner += dec.decode(chunk.value, { stream: true });
    const m = banner.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (m !== null && m[1] !== undefined) {
      port = Number(m[1]);
      break;
    }
  }
  reader.releaseLock();

  try {
    if (!check(port > 0, "receiver bound an ephemeral port", banner.slice(0, 300))) return;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    check(health.status === 200, "GET /healthz is 200", String(health.status));
    const healthBody = (await health.json()) as Record<string, unknown>;
    check(healthBody.port === port, "healthz reports the SOCKET's port, not the flag", JSON.stringify(healthBody));

    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: otlpLogsBody(REQ_ID, SESSION, DURATION_MS),
    });
    check(res.status === 200, "POST /v1/logs is 200", String(res.status));
    check(JSON.stringify(await res.json()) === "{}", "OTLP success body is an EMPTY response");

    // Fail-open (P2.13's mandated case): a 4xx here is an unbounded exporter retry loop.
    const poison = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    check(poison.status === 200, "an unparseable body is 200, parked — never a retry storm", String(poison.status));

    const logsPath = join(s.spoolDir, OTEL_LOGS_FILE);
    for (let i = 0; i < 100 && !existsSync(logsPath); i++) await Bun.sleep(20);
    check(existsSync(logsPath), `spool/${OTEL_LOGS_FILE} exists`);
    const lines = existsSync(logsPath)
      ? readFileSync(logsPath, "utf8").split("\n").filter((l) => l.trim() !== "")
      : [];
    check(lines.length === 1, "exactly one spooled log record", String(lines.length));
    const first = lines[0];
    if (first !== undefined) {
      const rec = JSON.parse(first) as { name?: string; attrs?: Record<string, unknown> };
      check(rec.name === "claude_code.api_request", "record classified as api_request", String(rec.name));
      check(rec.attrs?.duration_ms === DURATION_MS, "a QUOTED intValue decoded to a number", String(rec.attrs?.duration_ms));
      check(rec.attrs?.request_id === REQ_ID, "request_id survived the parse");
    }
    check(existsSync(join(s.spoolDir, OTEL_REJECT_FILE)), `poison body parked in ${OTEL_REJECT_FILE}`);
    check(!existsSync(s.dbPath), "the receiver never created or opened a database");

    // --- the sweep leg: spool -> otel_request -> request.duration_ms ---------------
    check((await s.est("init")).code === 0, "est init on the TEMP database");
    {
      const db = new Database(s.dbPath);
      seedPrices(db);
      db.query(INSERT_REQUEST).run({
        $rid: REQ_ID, $sid: SESSION, $pid: `${SESSION}-p1`, $ts: "2026-03-01T12:00:00Z",
        $in: 0, $out: 0, $cw: 0, $cr: 0, $dur: null, $tid: null, $attr: "none",
      } as never);
      db.close();
    }

    const sweep = await s.est("sweep", "--root", join(ROOT, "test/fixtures/corpus"), "--json");
    // 0 clean · 3 anomalies recorded. The deliberate poison body guarantees at least
    // one (`otel_reject`), so 3 is the expected outcome here; 1/2/4 are failures.
    check(sweep.code === 0 || sweep.code === 3, "est sweep exits 0 or 3", `code=${sweep.code} ${sweep.err.slice(0, 400)}`);
    let otel: Record<string, unknown> | undefined;
    try {
      otel = (JSON.parse(sweep.out) as { otel?: Record<string, unknown> }).otel;
      check(true, "sweep --json parses");
    } catch (e) {
      check(false, "sweep --json parses", String(e));
    }
    check(otel !== undefined, "sweep report carries an `otel` block");
    check(otel?.durations_filled === 1, "sweep filled exactly one duration", JSON.stringify(otel));

    {
      const db = new Database(s.dbPath, { readonly: true });
      const row = db
        .query<{ d: number | null }, [string]>("SELECT duration_ms AS d FROM request WHERE request_id = ?")
        .get(REQ_ID);
      check(row?.d === DURATION_MS, `request.duration_ms === ${DURATION_MS} in the TEMP database`, String(row?.d));
      const orow = db
        .query<{ n: number; d: number | null }, [string]>(
          "SELECT COUNT(*) AS n, MAX(duration_ms) AS d FROM otel_request WHERE request_id = ?",
        )
        .get(REQ_ID);
      check(orow?.n === 1 && orow?.d === DURATION_MS, "otel_request row upserted", JSON.stringify(orow));
      const kinds = db
        .query<{ kind: string; n: number }, []>("SELECT kind, COUNT(*) AS n FROM anomaly GROUP BY kind ORDER BY n DESC")
        .all();
      info(`anomaly kinds: ${kinds.map((k) => `${k.kind}=${k.n}`).join(", ") || "(none)"}`);
      db.close();
    }
    check(!existsSync(logsPath), "the spool was DRAINED, not merely read");
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
    s.dispose();
  }
}

// ---------------------------------------------------------------------------
// 2. board
// ---------------------------------------------------------------------------

async function gateBoard(): Promise<void> {
  console.log("\n[g-smoke] 2/3 board — one card per column, rendered to disk");
  const s = makeScratch("est-smoke-board-");
  try {
    check((await s.est("init")).code === 0, "est init on the TEMP fixture database");
    {
      const db = new Database(s.dbPath);
      seedPrices(db);
      db.close();
    }

    const tids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await s.est(...openArgv(`fixture widget task ${i}`, `fixture-session-${i}`));
      if (r.code !== 0) {
        check(false, `est open #${i}`, `code=${r.code} ${r.err.slice(0, 400)}`);
        break;
      }
      tids.push((JSON.parse(r.out) as { tid: string }).tid);
    }
    if (!check(tids.length === 5, "five fixture tasks opened", String(tids.length))) return;

    // One task per column. `task` carries no append-only trigger, so a fixture may set
    // `status` directly; `outcome` does, so the Done and Abandoned cards are produced by
    // the real `est close`. `--force` because the quiescence gate correctly refuses a
    // task minted seconds ago — the gate under test here is the BOARD, not the closer.
    {
      const db = new Database(s.dbPath);
      const now = isoAt(new Date());
      db.query("UPDATE task SET status='in_progress', started_at=? WHERE tid=?").run(now, tids[1]!);
      db.query("UPDATE task SET status='pending_verification', started_at=? WHERE tid=?").run(now, tids[2]!);
      for (const [n, tid] of [tids[1]!, tids[2]!].entries()) {
        db.query(INSERT_REQUEST).run({
          $rid: `fixture-req-${n}`, $sid: `fixture-session-${n + 1}`, $pid: `fixture-session-${n + 1}-p1`,
          $ts: now, $in: 100, $out: 200, $cw: 50, $cr: 10, $dur: 1500, $tid: tid, $attr: "exclusive",
        } as never);
      }
      db.close();
    }
    check((await s.est("close", tids[3]!, "--status", "completed", "--force", "--json")).code === 0,
      "est close --status completed -> a Done (7d) card");
    check((await s.est("close", tids[4]!, "--status", "abandoned", "--force", "--json")).code === 0,
      "est close --status abandoned -> an Abandoned card");

    const outDir = join(s.dir, "board");
    mkdirSync(outDir, { recursive: true });
    const rendered = await s.est("board", "--html", "--md", "--out", outDir, "--json");
    check(rendered.code === 0, "est board --html --md exits 0", rendered.err.slice(0, 400));
    check(!/render\/write failed/.test(rendered.err), "no render/write failure on stderr", rendered.err.slice(0, 300));

    const htmlPath = join(outDir, "board.html");
    const mdPath = join(outDir, "board.md");
    check(existsSync(htmlPath), "board.html written");
    check(existsSync(mdPath), "board.md written");
    const html = existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : "";
    const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
    check(html.length > 500 && statSync(htmlPath).size > 0, "board.html is non-empty", `${html.length} bytes`);
    check(md.length > 100, "board.md is non-empty", `${md.length} bytes`);

    const jsonBoard = await s.est("board", "--json");
    check(jsonBoard.code === 0, "est board --json exits 0", jsonBoard.err.slice(0, 300));
    const model = JSON.parse(jsonBoard.out) as {
      columns: Array<{ column: string; cards: Array<{ subject: string }> }>;
    };
    check(model.columns.length === BOARD_COLUMNS.length, "all status columns present in --json", String(model.columns.length));
    for (const col of model.columns) {
      check(html.includes(col.column) && md.includes(col.column), `both files render the "${col.column}" heading`);
      // POPULATED, not merely present: an empty board renders every heading too.
      if (!check(col.cards.length >= 1, `column "${col.column}" has >= 1 card`, String(col.cards.length))) continue;
      const subject = col.cards[0]?.subject ?? "";
      check(subject !== "" && html.includes(escapeHtml(subject)), `board.html renders a card for "${col.column}"`, subject);
      check(subject !== "" && md.includes(subject), `board.md renders a card for "${col.column}"`, subject);
    }

    // Self-contained and offline: the board is a local file, not a page with a network
    // dependency that leaks a request every time Craig opens it.
    check(!/<script/i.test(html), "board.html contains no <script>");
    check(!/https?:\/\//i.test(html.replace(/https?:\/\/www\.w3\.org[^"']*/g, "")), "board.html names no network host");
  } finally {
    s.dispose();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// 3. statusline + the `est burn --json` contract
// ---------------------------------------------------------------------------

async function gateStatusline(): Promise<void> {
  console.log("\n[g-smoke] 3/3 statusline — the check-back ETA, under budget, plus the burn contract");
  const s = makeScratch("est-smoke-statusline-");
  const SESSION = "fixture-session-statusline";
  const now = new Date();
  try {
    check((await s.est("init")).code === 0, "est init on the TEMP fixture database");
    {
      const db = new Database(s.dbPath);
      seedPrices(db);
      db.close();
    }

    const opened = await s.est(...openArgv("fixture statusline task", SESSION));
    if (!check(opened.code === 0, "est open", opened.err.slice(0, 400))) return;
    const tid = (JSON.parse(opened.out) as { tid: string }).tid;
    check((await s.est("bind", tid, "--session", SESSION)).code === 0, "est bind <tid> --session");

    {
      const db = new Database(s.dbPath);
      const ts = isoAt(new Date(now.getTime() - 120_000));
      db.query("UPDATE task SET status='in_progress', started_at=? WHERE tid=?").run(ts, tid);
      db.query(
        `INSERT INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf, tid)
         VALUES (?, ?, ?, 60000, NULL, NULL, NULL)`,
      ).run(SESSION, `${SESSION}-p1`, ts);
      db.query(INSERT_REQUEST).run({
        $rid: "fixture-r-main", $sid: SESSION, $pid: `${SESSION}-p1`, $ts: ts,
        $in: 100, $out: 150, $cw: 50, $cr: 10, $dur: 2000, $tid: null, $attr: "none",
      } as never);
      attributeTasks(db);
      refreshBurnCache(db, now);
      // The check-back forecast is written straight into the cache ROW. That is not a
      // shortcut around the fitter: the read path's whole contract is that it is bounded
      // by the row and never re-derives a forecast at render time (P1.9), so the row IS
      // the interface this gate is testing. 1620 s -> `~27m`, and `eta_probation = 1`
      // must surface as the trailing `?`.
      const n = db
        .query(
          `UPDATE burn_cache SET seg_started_at = ?, seg_elapsed_s = 120,
              check_back_p50_s = 1620, check_back_p90_s = 5400,
              eta_model = 'residual_life', eta_probation = 1, eta_n_seg = 12
            WHERE tid = ?`,
        )
        .run(isoAt(new Date(now.getTime() - 120_000)), tid);
      check(n.changes === 1, "burn_cache row seeded with a check-back", JSON.stringify(n));
      db.close();
    }

    // --- the JSON contract the segment parses -------------------------------------
    // `--session` is what the statusline supplies (from the hook payload's `session_id`);
    // without it the target is a GUESS and `formatSegment` correctly renders nothing.
    const burn = await s.est("burn", "--session", SESSION, "--json");
    check(burn.code === 0, "est burn --json exits 0", burn.err.slice(0, 300));
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(burn.out) as Record<string, unknown>;
      check(true, "est burn --json emits exactly one parseable object");
    } catch (e) {
      check(false, "est burn --json emits exactly one parseable object", String(e));
      return;
    }
    check(payload.schema === 1, "burn payload schema === 1", String(payload.schema));
    check(payload.active === true, "burn payload is active", JSON.stringify(payload).slice(0, 200));
    for (const key of ["wcet", "agents", "warn", "target", "check_back", "unvalidated"]) {
      check(key in payload, `burn payload carries \`${key}\` (the segment reads it)`);
    }
    const cb = payload.check_back as Record<string, unknown> | null;
    check(cb !== null && typeof cb === "object", "check_back is an object, not null");
    check(typeof cb?.p50_min === "number", "check_back.p50_min is a number", String(cb?.p50_min));
    check(typeof cb?.probation === "boolean", "check_back.probation is a boolean");
    // The contract end to end: feed the CLI's own JSON to the shipped formatter.
    const seg = formatSegment(payload as never);
    check(/check back ~/.test(seg), "formatSegment(est burn --json) renders a check-back", seg);
    check(!/p50_s|p90_s/.test(seg), "the segment prints no token-derived clock figure (P2.2)", seg);

    // --- the process, exactly as ccstatusline runs it ------------------------------
    const stdinPayload = JSON.stringify({
      hook_event_name: "Status",
      session_id: SESSION,
      transcript_path: "/dev/null",
      cwd: s.dir,
      model: { id: "claude-test-1", display_name: "Test" },
      workspace: { current_dir: s.dir, project_dir: s.dir },
    });
    const script = join(ROOT, "scripts/statusline-burn.ts");
    const runOnce = async (
      stdin: string,
    ): Promise<{ code: number; out: string; err: string; ms: number }> => {
      const t0 = performance.now();
      const p = Bun.spawn(["bun", "run", script], {
        cwd: ROOT,
        env: { ...process.env, EST_DB: s.dbPath, EST_SPOOL_DIR: s.spoolDir },
        stdin: new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err, ms: performance.now() - t0 };
    };

    // Warm once, then best-of-five: the segment renders on every prompt, so the
    // steady-state cost is the one with a budget, not the first-touch cost.
    await runOnce(stdinPayload);
    const runs: Array<{ code: number; out: string; err: string; ms: number }> = [];
    for (let i = 0; i < 5; i++) runs.push(await runOnce(stdinPayload));
    const best = runs.reduce((a, b) => (a.ms < b.ms ? a : b));

    check(runs.every((r) => r.code === 0), "statusline exits 0 on every run", runs.map((r) => r.code).join(","));
    check(runs.every((r) => r.err === ""), "statusline writes nothing to stderr", best.err.slice(0, 300));
    check(best.out.startsWith("task "), "statusline renders the task segment", best.out);
    check(/check back ~27m\?/.test(best.out), "statusline renders the check-back ETA and its probation `?`", best.out);
    info(`statusline render (ms): ${runs.map((r) => r.ms.toFixed(1)).join(", ")}`);
    check(best.ms < STATUSLINE_BUDGET_MS, `statusline renders in < ${STATUSLINE_BUDGET_MS} ms`, `best ${best.ms.toFixed(1)} ms`);

    // Fail-open (file header rule 2): every failure mode is an EMPTY segment, exit 0.
    const garbage = await runOnce("{ this is not json");
    check(garbage.code === 0 && garbage.out === "", "malformed stdin -> empty segment, exit 0",
      `code=${garbage.code} out=${JSON.stringify(garbage.out)}`);
  } finally {
    s.dispose();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const which = process.argv[2] ?? "all";
const legs: Record<string, () => Promise<void>> = {
  receiver: gateReceiver,
  board: gateBoard,
  statusline: gateStatusline,
};

if (which !== "all" && legs[which] === undefined) {
  console.error(`usage: bun gates/g-smoke.ts [${Object.keys(legs).join("|")}|all]`);
  process.exit(2);
}

for (const [name, leg] of Object.entries(legs)) {
  if (which !== "all" && which !== name) continue;
  await leg();
}

console.log(failures === 0 ? "\n[g-smoke] PASS" : `\n[g-smoke] FAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

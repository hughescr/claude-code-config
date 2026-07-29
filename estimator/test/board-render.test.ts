/**
 * `src/board-render.ts` (P2.7) and the additive fields `board()` (`src/retro.ts`)
 * gained to feed it: the per-phase strip, the check-back forecast, and the two
 * clocks (`active_s`/`wall_s`).
 *
 * Four things are pinned here that P1.8's own test file (`test/retro.test.ts`)
 * cannot cover, because they did not exist before this phase:
 *
 *  1. `--json`'s view model is EXACTLY what the file renderer draws from (P2.7's
 *     own stated reason `--json` is testable without parsing HTML) — so the render
 *     tests build their `BoardReport` by calling the real `board()`, never a
 *     hand-built fixture.
 *  2. The renderer never reaches the network and is fully readable as plain text —
 *     asserted by grepping the OUTPUT for `<script`/`http` rather than trusting the
 *     source not to grow one.
 *  3. Atomicity and the throttle are filesystem properties, not arithmetic — they
 *     get their own isolated tmp directories, never `SPOOL_DIR`/the real board dir.
 *  4. A render failure never destroys a good board and never inflates a sweep's
 *     `report.anomalies` (the design's "never fails the sweep").
 *
 * Fixtures are synthetic throughout (`test/support.ts`): no real id, path or token
 * figure may appear in a tracked file (§4).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, openArgs, request, seedPrices, turn, type Harness } from "./support.ts";
import { attributeTasks } from "../src/attribute.ts";
import { openDb } from "../src/db.ts";
import { formatEta } from "../src/eta.ts";
import { board } from "../src/retro.ts";
import {
  boardDue,
  BOARD_MARKER,
  burnZone,
  fmtCheckBack,
  fmtDuration,
  fmtWcet,
  reapBoardTemp,
  regenerateBoardIfDue,
  renderBoardHtml,
  renderBoardMd,
  touchBoardMarker,
  writeAtomic,
} from "../src/board-render.ts";

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-board-render-");
  seedPrices(h.db);
});

afterEach(() => {
  h.close();
});

// ---------------------------------------------------------------------------
// formatting helpers — pure, no DB
// ---------------------------------------------------------------------------

describe("formatting helpers", () => {
  test("fmtWcet: k/M suffix, statusline style", () => {
    expect(fmtWcet(null)).toBe("—");
    expect(fmtWcet(undefined)).toBe("—");
    expect(fmtWcet(0)).toBe("0");
    expect(fmtWcet(999)).toBe("999");
    expect(fmtWcet(1000)).toBe("1k");
    expect(fmtWcet(340_000)).toBe("340k");
    expect(fmtWcet(1_200_000)).toBe("1.2M");
  });

  test("fmtDuration: seconds/minutes/hours, never fabricates precision", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(45)).toBe("45s");
    expect(fmtDuration(125)).toBe("2m");
    expect(fmtDuration(7_200)).toBe("2.0h");
  });

  test("fmtCheckBack: ~Nm below 90 minutes, ~N.Nh at or above (P2.2's exact rule)", () => {
    expect(fmtCheckBack(57 * 60)).toBe("~57m");
    expect(fmtCheckBack(89 * 60)).toBe("~89m");
    expect(fmtCheckBack(90 * 60)).toBe("~1.5h");
    expect(fmtCheckBack(214 * 60)).toBe("~3.6h");
  });

  test("fmtCheckBack IS formatEta: one rounding rule, `<1m` and `?` included", () => {
    // The board had its own copy of the rule and the copy was missing two branches, so
    // an imminent check-back rendered as `~0m` — which reads as "done" — and a bad
    // input as `~NaNm`. Pinned against `formatEta` itself rather than against literals,
    // so the two can never drift apart again.
    for (const s of [0, 10, 29, 59, 60, 61, 3600, 5340, 5400, 12840, -1, Number.NaN]) {
      expect(fmtCheckBack(s)).toBe(formatEta(s / 60));
    }
    expect(fmtCheckBack(0)).toBe("<1m");
    expect(fmtCheckBack(59)).toBe("<1m");
    expect(fmtCheckBack(-1)).toBe("?");
    expect(fmtCheckBack(Number.NaN)).toBe("?");
  });

  test("burnZone: good under p50, warning between p50/p90, critical past p90", () => {
    expect(burnZone(400, 1000, 3000)).toBe("good");
    expect(burnZone(1500, 1000, 3000)).toBe("warning");
    expect(burnZone(3500, 1000, 3000)).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// board() — the P2.7 additive fields
// ---------------------------------------------------------------------------

async function openTask(subject: string, extra: string[] = []): Promise<string> {
  const session = `s-${subject}`;
  turn(h.db, { session, prompt: "p1", at: "2026-02-01T00:00:00Z" });
  const r = await h.cli(...openArgs({ subject }), "--session", session, "--prompt", "p1", "--json", ...extra);
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

/**
 * The task's OWN anchor session. `openTask` names it after the subject, not after
 * the tid, and seeding a workflow into a `s-<tid>` session instead left the run and
 * its agent in a session no `task_alias` covered: `attributeTasks` could not derive
 * their tids, and only the pre-repair SET-only writer made the hand-written ones
 * survive the pass. Attribution is the sole writer of `agent_run.tid` /
 * `workflow_run.tid` and recomputes every claim from scratch, so a fixture has to be
 * DERIVABLE, not merely written down.
 */
function anchorSession(tid: string): string {
  return h.db
    .query<{ anchor_session: string }, [string]>("SELECT anchor_session FROM task WHERE tid = ?")
    .get(tid)!.anchor_session;
}

/** One phase-0 agent + one declared block for phase 1, on a fresh workflow task. */
function seedWorkflow(tid: string): void {
  const session = anchorSession(tid);
  h.db
    .query(
      `INSERT INTO workflow_run (run_id, wf_launch_id, session_id, workflow_name, transcript_dir,
                                 default_model, launch_prompt_id, n_phases_planned, started_at, ended_at, tid)
       VALUES ('wf-1','launch-1',?,'demo',NULL,NULL,'p1',2,'2026-02-01T00:00:00Z',NULL,?)`,
    )
    .run(session, tid);
  for (const [idx, title] of [[0, "survey"], [1, "build"]] as const) {
    h.db
      .query(
        "INSERT INTO workflow_phase (run_id, wf_launch_id, phase_idx, title, detail, model) VALUES ('wf-1','launch-1',?,?,NULL,NULL)",
      )
      .run(idx, title);
  }
  h.db
    .query(
      `INSERT INTO agent_run (agent_id, session_id, run_id, wf_launch_id, agent_type, spawn_depth,
                              launch_prompt_id, status, label, started_at, ended_at, interval_src,
                              phase_idx, phase_conf, tid)
       VALUES ('a1', ?, 'wf-1', 'launch-1', 'general-purpose', 1, 'p1', 'completed', 'demo',
               '2026-02-01T00:01:00Z', '2026-02-01T00:05:00Z', 'transcript', 0, 'exact', ?)`,
    )
    .run(session, tid);
}

describe("board() — P2.7 per-phase strip", () => {
  test("merges execution (v_phase_actual) and declared blocks (v_block_accuracy) by phase_idx", async () => {
    const tid = await openTask("wf task");
    seedWorkflow(tid);
    expect((await h.cli("block", tid, "--phase", "0", "--title", "survey", "--p50", "100", "--p90", "300")).code).toBe(0);
    expect((await h.cli("block", tid, "--phase", "1", "--title", "build", "--p50", "400", "--p90", "900")).code).toBe(0);
    request(h.db, "rq-1", { session: anchorSession(tid), agent: "a1", origin: "subagent", out: 500 });
    attributeTasks(h.db);

    const r = board(h.db, { now: new Date("2026-02-01T00:10:00Z") });
    const card = r.columns.flatMap((c) => c.cards).find((c) => c.tid === tid)!;
    expect(card.phases).toHaveLength(2);

    const [p0, p1] = card.phases;
    expect(p0).toMatchObject({ phase_idx: 0, phase_conf: "exact", n_agents: 1, block_p50: 100, block_p90: 300 });
    expect(p0!.actual_wcet).toBe(500);
    // Phase 1 was DECLARED (a block estimate exists) but no agent has run it yet.
    expect(p1).toMatchObject({
      phase_idx: 1,
      phase_conf: null,
      actual_wcet: null,
      n_agents: 0,
      block_p50: 400,
      block_p90: 900,
    });
  });

  test("a non-workflow task carries an empty phase strip", async () => {
    const tid = await openTask("plain task");
    const r = board(h.db, { now: new Date() });
    const card = r.columns.flatMap((c) => c.cards).find((c) => c.tid === tid)!;
    expect(card.phases).toEqual([]);
  });
});

describe("board() — check-back and the two clocks", () => {
  test("check_back is populated ONLY on an in_progress card with a fitted forecast", async () => {
    const tid = await openTask("live task");
    h.db.query("UPDATE task SET status = 'in_progress', started_at = ? WHERE tid = ?").run(
      "2026-02-01T00:00:00Z",
      tid,
    );
    h.db
      .query(
        `INSERT INTO burn_cache (tid, as_of, active_s, check_back_p50_s, check_back_p90_s, eta_model, eta_probation)
         VALUES (?, '2026-02-01T00:57:00Z', 3420, 3420, 12840, 'residual_life', 1)`,
      )
      .run(tid);

    const now = new Date("2026-02-01T00:57:00Z");
    const r = board(h.db, { now });
    const card = r.columns.flatMap((c) => c.cards).find((c) => c.tid === tid)!;
    expect(card.check_back).toEqual({ p50_s: 3420, p90_s: 12840, eta_model: "residual_life", probation: true });
    expect(card.active_s).toBe(3420);
    // wall_s: no outcome row yet, so it is derived from `now - started_at`.
    expect(card.wall_s).toBe(3420);
  });

  test("a burn_cache row on a card that is NOT in_progress does not leak check_back", async () => {
    const tid = await openTask("estimating task");
    h.db
      .query(
        `INSERT INTO burn_cache (tid, as_of, check_back_p50_s, check_back_p90_s, eta_model, eta_probation)
         VALUES (?, '2026-02-01T00:00:00Z', 100, 200, 'const_median', 0)`,
      )
      .run(tid);
    const r = board(h.db, { now: new Date() });
    const card = r.columns.flatMap((c) => c.cards).find((c) => c.tid === tid)!;
    expect(card.status).toBe("estimating");
    expect(card.check_back).toBeNull();
  });

  test("active_s/wall_s come from the outcome once a task is finalized, never from burn_cache", async () => {
    const tid = await openTask("done task");
    h.db
      .query(
        `INSERT INTO outcome (tid, revision, finalized_at, final_status, eid_at_start, eid_final,
                              actual_wcet, actual_scet, actual_in, actual_out, actual_cw, actual_cr,
                              n_requests, n_agents, active_s, wall_s)
         VALUES (?, 1, '2026-02-02T00:00:00Z', 'completed',
                 (SELECT MIN(eid) FROM estimate WHERE tid = ?), (SELECT MAX(eid) FROM estimate WHERE tid = ?),
                 0, 0, 0, 0, 0, 0, 0, 0, 555, 999)`,
      )
      .run(tid, tid, tid);
    h.db.query("UPDATE task SET status = 'completed' WHERE tid = ?").run(tid);

    const r = board(h.db, { now: new Date("2026-02-02T01:00:00Z") });
    const card = r.columns.flatMap((c) => c.cards).find((c) => c.tid === tid)!;
    expect(card.active_s).toBe(555);
    expect(card.wall_s).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// renderBoardHtml / renderBoardMd — the view model IS the file
// ---------------------------------------------------------------------------

describe("renderBoardHtml / renderBoardMd", () => {
  test("HTML: no network reference, no <script>, escapes an adversarial subject", async () => {
    await openTask(`<script>alert(1)</script> & "quotes" 'ok'`);
    const r = board(h.db, { now: new Date() });
    const html = renderBoardHtml(r);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("</html>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("fetch(");
    // The subject must be present only in its escaped form.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quotes&quot;");
  });

  test("HTML: an uncalibrated card carries the cold-start marker and every column renders", async () => {
    await openTask("cold start");
    const r = board(h.db, { now: new Date() });
    const html = renderBoardHtml(r);
    expect(html).toContain("uncalibrated band (cold start)");
    for (const col of ["Estimating", "In Progress", "Pending Verification", "Abandoned"]) {
      expect(html).toContain(col);
    }
  });

  test("HTML: the per-phase strip and check-back render for an in_progress workflow card", async () => {
    const tid = await openTask("wf render");
    seedWorkflow(tid);
    h.db.query("UPDATE task SET status = 'in_progress', started_at = ? WHERE tid = ?").run(
      "2026-02-01T00:00:00Z",
      tid,
    );
    h.db
      .query(
        `INSERT INTO burn_cache (tid, as_of, proj_total_wcet, check_back_p50_s, check_back_p90_s, eta_model, eta_probation)
         VALUES (?, '2026-02-01T01:00:00Z', 21000, 3420, 12840, 'residual_life', 1)`,
      )
      .run(tid);
    const r = board(h.db, { now: new Date("2026-02-01T01:00:00Z") });
    const html = renderBoardHtml(r);
    expect(html).toContain("P0");
    // §7.1's own example is `~57m ? (p90 3.6h)` — a SPACE before the `?`.
    expect(html).toContain("check back ~57m ");
    expect(html).toContain('class="probation">?</span>');
    expect(html).toContain("(p90 ~3.6h)");
    // The ccusage-pattern projection, explicitly labelled crude (§6.3, §7.1).
    expect(html).toContain("proj 21k (crude)");
  });

  test("Markdown: one heading per column and a bullet per card", async () => {
    await openTask("md task");
    const r = board(h.db, { now: new Date() });
    const md = renderBoardMd(r);
    expect(md).toContain("# est board");
    expect(md).toContain("## Estimating (1)");
    expect(md).toContain("- **md task**");
    expect(md).toContain("## Abandoned (0)");
    expect(md).toContain("_none_");
  });
});

// ---------------------------------------------------------------------------
// atomic write + throttle — filesystem properties, isolated tmp dirs only
// ---------------------------------------------------------------------------

describe("writeAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "est-board-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes the exact content and leaves no .tmp files behind", () => {
    const path = join(dir, "board.html");
    writeAtomic(path, "<html>v1</html>");
    expect(readFileSync(path, "utf8")).toBe("<html>v1</html>");
    writeAtomic(path, "<html>v2</html>");
    expect(readFileSync(path, "utf8")).toBe("<html>v2</html>");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });
});

describe("boardDue / touchBoardMarker — the P1.10-style throttle", () => {
  let spoolDir: string;
  beforeEach(() => {
    spoolDir = mkdtempSync(join(tmpdir(), "est-board-spool-"));
  });
  afterEach(() => {
    rmSync(spoolDir, { recursive: true, force: true });
  });

  test("due with no marker; not due immediately after touching; due again past the window", () => {
    const t0 = new Date("2026-02-01T00:00:00Z");
    expect(boardDue(spoolDir, 30, t0)).toBe(true);

    touchBoardMarker(spoolDir, t0);
    expect(existsSync(join(spoolDir, BOARD_MARKER))).toBe(true);
    expect(boardDue(spoolDir, 30, new Date(t0.getTime() + 10_000))).toBe(false);
    expect(boardDue(spoolDir, 30, new Date(t0.getTime() + 30_000))).toBe(true);
  });
});

describe("regenerateBoardIfDue", () => {
  test("renders both files, throttles the immediate re-call, and re-renders past the window", async () => {
    const boardDir = mkdtempSync(join(tmpdir(), "est-board-out-"));
    const spoolDir = mkdtempSync(join(tmpdir(), "est-board-spool2-"));
    try {
      await openTask("regen task");
      const t0 = new Date("2026-02-01T00:00:00Z");

      const first = regenerateBoardIfDue(h.db, { boardDir, spoolDir, now: t0 });
      expect(first).toMatchObject({ attempted: true, ok: true, anomaly: null });
      expect(existsSync(join(boardDir, "board.html"))).toBe(true);
      expect(existsSync(join(boardDir, "board.md"))).toBe(true);
      const htmlV1 = readFileSync(join(boardDir, "board.html"), "utf8");
      expect(htmlV1).toContain("regen task");

      // Immediately again: throttled, nothing read or written.
      const second = regenerateBoardIfDue(h.db, {
        boardDir,
        spoolDir,
        now: new Date(t0.getTime() + 1000),
      });
      expect(second).toMatchObject({ attempted: false, ok: true, anomaly: null });
      expect(readFileSync(join(boardDir, "board.html"), "utf8")).toBe(htmlV1);

      // Past the (default) throttle window: due again.
      const third = regenerateBoardIfDue(h.db, {
        boardDir,
        spoolDir,
        now: new Date(t0.getTime() + 31_000),
      });
      expect(third).toMatchObject({ attempted: true, ok: true, anomaly: null });
    } finally {
      rmSync(boardDir, { recursive: true, force: true });
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  test("a render failure leaves the previous good board.html/board.md untouched and reports the anomaly", async () => {
    const boardDir = mkdtempSync(join(tmpdir(), "est-board-fail-"));
    const spoolDir = mkdtempSync(join(tmpdir(), "est-board-fail-spool-"));
    // A second, independent connection to the SAME database file, so it can be
    // closed to force `board()` to throw without touching the shared `h.db` the
    // `afterEach` hook closes for every other test in this file.
    const failDb = openDb({ path: h.dbPath });
    try {
      await openTask("about to fail");
      const t0 = new Date("2026-02-01T00:00:00Z");
      const good = regenerateBoardIfDue(failDb, { boardDir, spoolDir, now: t0 });
      expect(good.ok).toBe(true);
      const htmlBefore = readFileSync(join(boardDir, "board.html"), "utf8");
      const mdBefore = readFileSync(join(boardDir, "board.md"), "utf8");

      failDb.close(); // every query against this handle now throws

      const failed = regenerateBoardIfDue(failDb, {
        boardDir,
        spoolDir,
        now: new Date(t0.getTime() + 31_000), // past the throttle, so it actually attempts
      });
      expect(failed.attempted).toBe(true);
      expect(failed.ok).toBe(false);
      expect(failed.anomaly).not.toBeNull();
      expect(failed.anomaly!.kind).toBe("board_render_failed");

      expect(readFileSync(join(boardDir, "board.html"), "utf8")).toBe(htmlBefore);
      expect(readFileSync(join(boardDir, "board.md"), "utf8")).toBe(mdBefore);
    } finally {
      rmSync(boardDir, { recursive: true, force: true });
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  test("`dirty: false` skips BEFORE the throttle — no marker, no read, no write", async () => {
    // P2.7 regenerates "at the end of any sweep whose transaction CHANGED a task,
    // estimate, outcome or burn_cache row". The mtime throttle answers a different
    // question (how often), and on its own it made every sweep past the window pay for
    // a full `board()` plus two fsync'd writes to produce a byte-identical file.
    const boardDir = mkdtempSync(join(tmpdir(), "est-board-clean-"));
    const spoolDir = mkdtempSync(join(tmpdir(), "est-board-clean-spool-"));
    try {
      await openTask("unchanged task");
      const t0 = new Date("2026-02-01T00:00:00Z");

      const skipped = regenerateBoardIfDue(h.db, { boardDir, spoolDir, now: t0, dirty: false });
      expect(skipped).toMatchObject({ attempted: false, ok: true, anomaly: null });
      expect(existsSync(join(boardDir, "board.html"))).toBe(false);
      // No marker either: a skip must not buy itself a throttle window, or the first
      // sweep that DOES change something would be throttled out by a no-op.
      expect(existsSync(join(spoolDir, BOARD_MARKER))).toBe(false);

      // Same instant, dirty: renders. The two gates are independent.
      expect(regenerateBoardIfDue(h.db, { boardDir, spoolDir, now: t0, dirty: true })).toMatchObject({
        attempted: true,
        ok: true,
      });
      expect(existsSync(join(boardDir, "board.html"))).toBe(true);

      // Omitting `dirty` renders — an omission errs toward a fresh board, never a
      // silently stale one.
      expect(
        regenerateBoardIfDue(h.db, { boardDir, spoolDir, now: new Date(t0.getTime() + 31_000) }),
      ).toMatchObject({ attempted: true, ok: true });
    } finally {
      rmSync(boardDir, { recursive: true, force: true });
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });
});

describe("reapBoardTemp — writeAtomic's staging files have an owner", () => {
  test("reaps only aged board.*.tmp.* and never a live render's file or the board itself", () => {
    // `pruneMarkers` scans the SPOOL directory; the boards live in `boardDir`, so
    // without this reap every crash between `writeSync` and `renameSync` leaks a
    // full board-sized file into the directory a human is most likely to `ls`.
    const dir = mkdtempSync(join(tmpdir(), "est-board-tmp-"));
    try {
      const t0 = new Date("2026-02-01T00:00:00Z");
      const stale = join(dir, "board.html.tmp.999.1");
      const staleMd = join(dir, "board.md.tmp.999.2");
      const fresh = join(dir, "board.html.tmp.1000.3");
      const unrelated = join(dir, "notes.tmp.1");
      for (const f of [stale, staleMd, fresh, unrelated]) writeFileSync(f, "x");
      writeAtomic(join(dir, "board.html"), "<html>good</html>");

      const old = new Date(t0.getTime() - 2 * 60 * 60 * 1000);
      for (const f of [stale, staleMd, unrelated]) utimesSync(f, old, old);
      utimesSync(fresh, t0, t0);

      expect(reapBoardTemp(dir, t0)).toBe(2);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(staleMd)).toBe(false);
      // A render in flight is not residue, and a file this module does not name is
      // not its business.
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(readFileSync(join(dir, "board.html"), "utf8")).toBe("<html>good</html>");

      // A missing directory is 0, never a throw: housekeeping never fails a render.
      expect(reapBoardTemp(join(dir, "nope"), t0)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI wiring — `est board --html` (untethered from the throttle) and `est sweep`
// (throttled, board dir defaults alongside the database — never the real repo)
// ---------------------------------------------------------------------------

describe("est board --html/--md/--out — the manual, unthrottled render", () => {
  test("writes board.html and board.md into --out, bypassing the sweep throttle entirely", async () => {
    await openTask("cli render");
    const out = mkdtempSync(join(tmpdir(), "est-board-cli-"));
    try {
      const r1 = await h.cli("board", "--html", "--md", "--out", out, "--json");
      expect(r1.code).toBe(0);
      expect(existsSync(join(out, "board.html"))).toBe(true);
      expect(existsSync(join(out, "board.md"))).toBe(true);
      expect(readFileSync(join(out, "board.html"), "utf8")).toContain("cli render");

      // A SECOND immediate call still writes — no throttle marker governs this path.
      writeFileSync(join(out, "board.html"), "SENTINEL");
      const r2 = await h.cli("board", "--html", "--out", out);
      expect(r2.code).toBe(0);
      expect(readFileSync(join(out, "board.html"), "utf8")).not.toBe("SENTINEL");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("--html alone writes only board.html; --md alone writes only board.md", async () => {
    await openTask("selective render");
    const out = mkdtempSync(join(tmpdir(), "est-board-cli2-"));
    try {
      expect((await h.cli("board", "--html", "--out", out)).code).toBe(0);
      expect(existsSync(join(out, "board.html"))).toBe(true);
      expect(existsSync(join(out, "board.md"))).toBe(false);

      expect((await h.cli("board", "--md", "--out", out)).code).toBe(0);
      expect(existsSync(join(out, "board.md"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("a render failure exits 0 and records board_render_failed — never exit 1", async () => {
    // P2.7's contract is "`0` always (a render failure is an anomaly, not a failed
    // command) · `1` usage". Exiting 1 here made a manual render failure BOTH invisible
    // to the anomaly-based alerting P2.14 depends on and indistinguishable from a
    // mistyped flag — the two things a caller most needs to tell apart.
    await openTask("render will fail");
    const blocker = join(h.dir, "not-a-directory");
    writeFileSync(blocker, "a file where the --out dir's parent should be");

    const r = await h.cli("board", "--html", "--md", "--out", join(blocker, "boards"));
    expect(r.code).toBe(0);
    expect(r.err).toContain("render/write failed");

    const rows = h.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'board_render_failed'")
      .all();
    expect(rows[0]!.n).toBe(1);

    // Repeating it does not multiply the row: `insertAnomalies` de-duplicates on
    // (kind, detail), so a board that fails on every invocation is one signal.
    expect((await h.cli("board", "--html", "--out", join(blocker, "boards"))).code).toBe(0);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'board_render_failed'").get()!.n,
    ).toBe(1);
  });
});

describe("est sweep — P2.7 wiring", () => {
  test("a sweep regenerates the board next to the database, and the very next sweep is throttled", async () => {
    await openTask("swept task");
    const boardDir = h.dir; // `dirname(ctx.dbPath)`, per SweepOptions.boardDir's default
    const emptyRoot = join(h.dir, "empty-projects");
    mkdirSync(emptyRoot, { recursive: true });
    const r1 = await h.cli("sweep", "--root", emptyRoot, "--json");
    expect(r1.code).toBeLessThan(3); // 0 or 1/2/4 are usage/lock states; never a board failure
    const report1 = r1.json<{ board: { attempted: boolean; ok: boolean } }>();
    expect(report1.board).toEqual({ attempted: true, ok: true });
    expect(existsSync(join(boardDir, "board.html"))).toBe(true);
    expect(existsSync(join(boardDir, "board.md"))).toBe(true);

    const r2 = await h.cli("sweep", "--root", emptyRoot, "--json");
    const report2 = r2.json<{ board: { attempted: boolean; ok: boolean } }>();
    expect(report2.board).toEqual({ attempted: false, ok: true });
  });

  test("a sweep that changed nothing does not render at all, even with no throttle marker", async () => {
    // No task exists, so `refreshBurnCache` writes no row and the promotion pass moves
    // nothing: the board would be byte-identical, and P2.7 says regenerate at the end
    // of a sweep "whose transaction CHANGED a task/estimate/outcome/burn_cache row".
    // The mtime throttle cannot express that — with the marker absent it always says
    // "due", so on an idle machine every cron sweep paid for a full `board()` plus two
    // fsync'd writes to reproduce the file it already had.
    const boardDir = h.dir;
    const emptyRoot = join(h.dir, "empty-projects-clean");
    mkdirSync(emptyRoot, { recursive: true });

    const r = await h.cli("sweep", "--root", emptyRoot, "--json");
    expect(r.json<{ board: { attempted: boolean; ok: boolean } }>().board).toEqual({
      attempted: false,
      ok: true,
    });
    expect(existsSync(join(boardDir, "board.html"))).toBe(false);

    // Open a task — now `burn_cache` moves, and the very next sweep renders.
    await openTask("now it changes");
    const r2 = await h.cli("sweep", "--root", emptyRoot, "--json");
    expect(r2.json<{ board: { attempted: boolean } }>().board.attempted).toBe(true);
    expect(existsSync(join(boardDir, "board.html"))).toBe(true);
  });
});

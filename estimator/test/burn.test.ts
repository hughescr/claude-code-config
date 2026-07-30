/**
 * `est burn` — consumption against the band, and the statusline contract (P1.6, P1.9).
 *
 * The statusline calls `est burn --json` at a >= 5 s cadence, on Craig's screen,
 * forever. Three properties are non-negotiable and each has tests here:
 *
 *  - **It never writes.** Not the database, not the cache, not a lock file.
 *  - **It never shows an error.** No open estimate, no cache row, a busy database and
 *    a missing database are ALL the same well-formed `{"active": false, "reason": …}`
 *    answer at exit code 0. A statusline that shows a wrong number is worse than one
 *    that shows nothing, and a stale band from a task that closed yesterday is a wrong
 *    number — so a closed task's cache row is deleted, not left to rot.
 *  - **It is fast**, which is bought by reading one indexed `burn_cache` row rather
 *    than aggregating `v_wcet`. The cache is a CACHE: `--refresh` recomputes the same
 *    numbers live, and the two must agree.
 *
 * Fixtures are synthetic (`test/support.ts`). Prices are $1/Mtok on both the request
 * family and the ref model, which makes Work-CET numerically `out_tok + cw_tok`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  agentRun,
  makeHarness,
  openArgs,
  request,
  seedPrices,
  turn,
  type Harness,
} from "./support.ts";
import {
  aggregateBurn,
  burnJson,
  burnRead,
  intervalUnion,
  refreshBurnCache,
  renderBurn,
  taskIntervals,
  type BurnActive,
  type BurnEmpty,
} from "../src/burn.ts";
import { attributeTasks } from "../src/attribute.ts";
import { openDb } from "../src/db.ts";
import { formatSegment } from "../scripts/statusline-burn.ts";

let h: Harness;

beforeEach(() => {
  h = makeHarness("est-burn-");
  seedPrices(h.db);
  turn(h.db, { session: "s1", prompt: "p1", at: "2026-01-01T00:00:00Z", durationMs: 60_000 });
});

afterEach(() => {
  h.close();
});

async function openTask(): Promise<string> {
  const r = await h.cli(...openArgs(), "--session", "s1", "--prompt", "p1", "--json");
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

/** A task with attributed spend: 200 main + 800 sub Work-CET, one live agent. */
async function taskWithSpend(): Promise<string> {
  const tid = await openTask();
  request(h.db, "r-main", { origin: "main", out: 150, cw: 50, ts: "2026-01-01T00:01:00Z" });
  agentRun(h.db, "a1", { session: "s1", launchPrompt: "p1", startedAt: "2026-01-01T00:01:00Z", endedAt: null });
  request(h.db, "r-sub", {
    origin: "subagent",
    agent: "a1",
    prompt: null,
    out: 700,
    cw: 100,
    ts: "2026-01-01T00:02:00Z",
  });
  attributeTasks(h.db);
  return tid;
}

// ---------------------------------------------------------------------------
// P1.9 — the empty result, which is the case that decides whether this is usable
// ---------------------------------------------------------------------------

describe("est burn — P1.9 the empty result", () => {
  test("no open estimate: active false, reason no_open_estimate, exit 0", async () => {
    const r = await h.cli("burn", "--json");
    expect(r.code).toBe(0);
    const body = r.json<BurnEmpty>();
    expect(body).toMatchObject({ schema: 1, active: false, reason: "no_open_estimate" });
  });

  test("an open estimate with no cache row: reason no_cache, exit 0", async () => {
    await openTask();
    const r = await h.cli("burn", "--json");
    expect(r.code).toBe(0);
    expect(r.json<BurnEmpty>().reason).toBe("no_cache");
  });

  test("a missing database file is reason db_missing at exit 0, never a stack trace", () => {
    const body = burnRead(join(h.dir, "does-not-exist.db")) as BurnEmpty;
    expect(body).toMatchObject({ schema: 1, active: false, reason: "db_missing" });
  });

  test("a file that is not a database at all is still db_missing at exit 0", async () => {
    const path = join(h.dir, "garbage.db");
    await Bun.write(path, "this is not a sqlite file");
    expect((burnRead(path) as BurnEmpty).reason).toBe("db_missing");
  });

  test("a database the code cannot read (schema from the future) is an empty result, not a throw", () => {
    const path = join(h.dir, "future.db");
    const future = makeHarness("est-burn-future-");
    try {
      future.db.query("UPDATE config SET v = '999' WHERE k = 'schema_version'").run();
      future.db.close();
      const body = burnRead(future.dbPath) as BurnEmpty;
      expect(body.active).toBe(false);
      expect(["db_missing", "db_busy"]).toContain(body.reason);
    } finally {
      try {
        future.close();
      } catch {
        /* already closed above */
      }
    }
    expect(path).toContain("future.db");
  });

  test("a closed task's cache row is DELETED, so burn can never render a yesterday band", async () => {
    const tid = await taskWithSpend();
    refreshBurnCache(h.db, new Date("2026-01-01T00:05:00Z"));
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM burn_cache").get()?.n).toBe(1);

    h.db.query("UPDATE task SET status = 'completed' WHERE tid = ?").run(tid);
    refreshBurnCache(h.db, new Date("2026-01-01T00:06:00Z"));
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM burn_cache").get()?.n).toBe(0);

    const r = await h.cli("burn", "--json");
    expect(r.code).toBe(0);
    expect(r.json<BurnEmpty>().active).toBe(false);
  });

  test("a database an exclusive writer is holding is db_busy, not db_missing", () => {
    // `openDb` probes sqlite_master for the `config` table before it can report a
    // version, and that probe needs a shared lock — so a sweeper holding the file
    // makes the OPEN throw, not the query. The first catch used to hardcode
    // db_missing, which made db_busy unreachable and left the reason unable to tell
    // "never initialised" from "the sweeper has it for a moment".
    const path = join(h.dir, "busy.db");
    openDb({ path }).close(); // a real, fully initialised database

    const writer = new Database(path);
    try {
      writer.exec("PRAGMA locking_mode = EXCLUSIVE;");
      writer.exec("BEGIN IMMEDIATE;");
      writer.query("UPDATE config SET v = v WHERE k = 'schema_version'").run();

      const body = burnRead(path) as BurnEmpty;
      expect(body.active).toBe(false);
      expect(body.reason).toBe("db_busy");
    } finally {
      try {
        writer.exec("ROLLBACK;");
      } catch {
        /* nothing to roll back */
      }
      writer.close();
    }
  });

  test("the human renderer says nothing-to-show rather than printing a zero band", () => {
    const text = renderBurn({ schema: 1, active: false, as_of: "2026-01-01T00:00:00Z", reason: "no_cache" });
    expect(text).toContain("nothing to show");
    expect(text).toContain("no_cache");
  });
});

// ---------------------------------------------------------------------------
// P1.9 — the field list
// ---------------------------------------------------------------------------

describe("est burn --json — P1.9 the contract", () => {
  test("carries every documented field, with unvalidated:true and the crude-projection marker", async () => {
    await taskWithSpend();
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));

    const r = await h.cli("burn", "--json");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    const b = r.json<BurnActive>();
    expect(b.schema).toBe(1);
    expect(b.active).toBe(true);
    expect(typeof b.stale_s).toBe("number");
    expect(Object.keys(b.wcet).sort()).toEqual(["consumed", "p50", "p90", "pct_p50", "pct_p90"]);
    expect(Object.keys(b.split).sort()).toEqual(["aux", "main", "sub"]);
    expect(Object.keys(b.agents).sort()).toEqual(["live", "total"]);
    expect(b.projection.method).toBe("linear");
    expect(b.projection.crude).toBe(true);
    expect(b.unvalidated).toBe(true);
    expect(Array.isArray(b.warn)).toBe(true);
    // §7.3: no active-time band is issued in Phase 1, so the segment reports
    // consumption and never time remaining.
    expect(b.time.p50_s).toBeNull();
    expect(b.time.p90_s).toBeNull();
  });

  test("consumed Work-CET and the origin split are the arithmetic, not a self-report", async () => {
    await taskWithSpend();
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    const b = (await h.cli("burn", "--json")).json<BurnActive>();
    expect(b.wcet.consumed).toBe(1000); // (150+50) + (700+100)
    expect(b.split.main).toBe(200);
    expect(b.split.sub).toBe(800);
    expect(b.split.aux).toBe(0);
    expect(b.requests.n).toBe(2);
    expect(b.agents.live).toBe(1);
    expect(b.agents.total).toBe(1);
  });

  test("ceremony overhead is excluded from consumed spend (§3.2)", async () => {
    const tid = await openTask();
    request(h.db, "r-work", { out: 500, ts: "2026-01-01T00:01:00Z" });
    request(h.db, "r-ceremony", { out: 400, ts: "2026-01-01T00:01:30Z", skill: "estimating" });
    attributeTasks(h.db);
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));

    const b = (await h.cli("burn", tid, "--json")).json<BurnActive>();
    // Improving the ceremony must not worsen the numbers the ceremony produces.
    expect(b.wcet.consumed).toBe(500);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM request WHERE attr = 'overhead'").get()?.n,
    ).toBe(1);
  });

  test("ceremony overhead is out of the DOLLAR terms too, so $/h stays per unit of work", async () => {
    // `usd_per_hour` and `projection.total_usd` are both `usd / consumed_wcet` scaled.
    // The Work-CET denominator has always excluded overhead; the dollar numerator did
    // not, so §5.4's ceremony requests — booked to the SAME tid with attr='overhead' —
    // inflated a rate per unit of work with spend no unit of work produced.
    const tid = await openTask();
    request(h.db, "r-work1", { out: 300, ts: "2026-01-01T00:01:00Z" });
    request(h.db, "r-work2", { out: 200, ts: "2026-01-01T00:02:00Z" });
    attributeTasks(h.db);
    const now = new Date("2026-01-01T00:03:00Z");
    refreshBurnCache(h.db, now);
    const before = burnJson(h.db, { tid, now }) as BurnActive;
    expect(before.wcet.consumed).toBe(500);
    expect(before.burn.usd_per_hour).toBeGreaterThan(0);

    // One ceremony request, at an instant the task was already active so the burn
    // window's observed span — and therefore the rate — cannot move. Everything the
    // payload reports about work must be identical.
    request(h.db, "r-ceremony", { out: 900, ts: "2026-01-01T00:02:00Z", skill: "estimating" });
    attributeTasks(h.db);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM request WHERE attr = 'overhead'").get()?.n,
    ).toBe(1);
    refreshBurnCache(h.db, now);
    const after = burnJson(h.db, { tid, now }) as BurnActive;

    expect(after.wcet.consumed).toBe(500);
    expect(after.burn.usd_per_hour).toBe(before.burn.usd_per_hour);
    expect(after.projection.total_usd).toBe(before.projection.total_usd);
    // ...and the cached dollars are the overhead-exclusive figure the ratio divides.
    const cached = h.db
      .query<{ usd: number; consumed_wcet: number }, [string]>(
        "SELECT usd, consumed_wcet FROM burn_cache WHERE tid = ?",
      )
      .get(tid)!;
    expect(cached.usd).toBeCloseTo(500 / 1_000_000, 12); // $1/Mtok on 500 Work-CET of work
    expect(cached.consumed_wcet).toBe(500);
  });

  test("warns over_p50 then over_p90 as consumption crosses the band", async () => {
    const tid = await openTask(); // band 1000 / 3000
    request(h.db, "r1", { out: 1500, ts: "2026-01-01T00:01:00Z" });
    attributeTasks(h.db);
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    expect((await h.cli("burn", "--json")).json<BurnActive>().warn).toContain("over_p50");

    request(h.db, "r2", { out: 2000, ts: "2026-01-01T00:02:00Z" });
    attributeTasks(h.db);
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    const warn = (await h.cli("burn", tid, "--json")).json<BurnActive>().warn;
    expect(warn).toContain("over_p90");
    expect(warn).not.toContain("over_p50");
  });

  test("reports staleness rather than implying freshness", async () => {
    const tid = await taskWithSpend();
    refreshBurnCache(h.db, new Date(Date.now() - 3600_000));
    const b = burnJson(h.db, { tid }) as BurnActive;
    expect(b.stale_s).toBeGreaterThan(3000);
    expect(b.warn).toContain("stale");
  });

  test("an unpriced model is warned about, never silently dropped to a smaller number", async () => {
    const tid = await openTask();
    request(h.db, "r-unpriced", { family: "claude-unknown-0", out: 900, ts: "2026-01-01T00:01:00Z" });
    attributeTasks(h.db);
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    const b = burnJson(h.db, { tid }) as BurnActive;
    expect(b.warn).toContain("unpriced");
  });

  test("the subject is truncated to the documented 80 characters", async () => {
    const long = "w".repeat(200);
    const r = await h.cli(...openArgs({ subject: long }), "--session", "s1", "--prompt", "p1", "--json");
    const tid = r.json<{ tid: string }>().tid;
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    const b = burnJson(h.db, { tid }) as BurnActive;
    expect(b.subject.length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// P1.6 — target resolution, the cache, and --refresh
// ---------------------------------------------------------------------------

describe("est burn — P1.6 resolution and the cache", () => {
  test("an explicit tid wins; a terminal tid resolves to the empty result", async () => {
    const tid = await taskWithSpend();
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    expect(((await h.cli("burn", tid, "--json")).json<BurnActive>()).tid).toBe(tid);

    h.db.query("UPDATE task SET status = 'abandoned' WHERE tid = ?").run(tid);
    expect(((await h.cli("burn", tid, "--json")).json<BurnEmpty>()).active).toBe(false);
  });

  test("--session resolves through task_alias", async () => {
    const tid = await taskWithSpend();
    await h.cli("bind", tid, "--session", "s7");
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    const b = (await h.cli("burn", "--session", "s7", "--json")).json<BurnActive>();
    expect(b.tid).toBe(tid);
  });

  test("--session on a session hosting two tasks resolves to the NEWER one", async () => {
    // A statusline showing the first task's band while Craig works on the second is
    // the wrong number P1.9 exists to prevent — and the first task's band would be
    // inflated by the second's spend on top of it.
    const first = await taskWithSpend();
    const second = (
      await h.cli(...openArgs({ subject: "the next thing" }), "--session", "s1", "--prompt", "p1", "--json")
    ).json<{ tid: string }>().tid;
    expect(second).not.toBe(first);
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    const b = (await h.cli("burn", "--session", "s1", "--json")).json<BurnActive>();
    expect(b.tid).toBe(second);
  });

  test("the payload says HOW the task was chosen, so a guess is not read as an answer", async () => {
    const tid = await taskWithSpend();
    await h.cli("bind", tid, "--session", "s7");
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));

    expect((burnJson(h.db, { tid }) as BurnActive).target).toBe("explicit");
    expect((burnJson(h.db, { session: "s7" }) as BurnActive).target).toBe("session");

    // A session nothing is bound to still resolves — P1.6's order ends at "the most
    // recently touched non-terminal task", which is the right answer for a human
    // typing `est burn` — but the payload must not present it as this session's work.
    const guess = burnJson(h.db, { session: "a-session-with-no-binding" }) as BurnActive;
    expect(guess.tid).toBe(tid);
    expect(guess.target).toBe("fallback");
    expect(renderBurn(guess)).toContain("GUESSED TARGET");
  });

  test("the cached read path answers from the ROW, not from a live count", async () => {
    // P1.9's budget is one indexed row read. Agent totals and the price warnings used
    // to be per-render queries over `agent_run` / the priced views — unbounded in
    // corpus size. They are columns now, and the proof is that the cached answer does
    // not move until a sweep rewrites the row.
    const tid = await taskWithSpend();
    const now = new Date("2026-01-01T00:03:00Z");
    refreshBurnCache(h.db, now);
    expect((burnJson(h.db, { tid, now }) as BurnActive).agents).toEqual({ live: 1, total: 1 });

    agentRun(h.db, "a2", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: "2026-01-01T00:02:30Z",
      endedAt: null,
    });
    attributeTasks(h.db);
    // Cached: still the swept row. Live: the new agent.
    expect((burnJson(h.db, { tid, now }) as BurnActive).agents).toEqual({ live: 1, total: 1 });
    expect((burnJson(h.db, { tid, now, refresh: true }) as BurnActive).agents).toEqual({
      live: 2,
      total: 2,
    });
    refreshBurnCache(h.db, now);
    expect((burnJson(h.db, { tid, now }) as BurnActive).agents).toEqual({ live: 2, total: 2 });
  });

  test("--refresh reproduces the cached numbers without reading the cache", async () => {
    const tid = await taskWithSpend();
    const now = new Date("2026-01-01T00:03:00Z");
    refreshBurnCache(h.db, now);
    const cached = burnJson(h.db, { tid, now }) as BurnActive;
    // Poison the cache: --refresh must not be able to see it.
    h.db.query("UPDATE burn_cache SET consumed_wcet = 999999 WHERE tid = ?").run(tid);
    const live = burnJson(h.db, { tid, now, refresh: true }) as BurnActive;
    expect(live.wcet.consumed).toBe(cached.wcet.consumed);
    expect(live.split).toEqual(cached.split);
    // The derived counts are cached too, so the two paths must agree on them as well.
    expect(live.agents).toEqual(cached.agents);
    expect(live.warn).toEqual(cached.warn);
    expect(live.burn.usd_per_hour).toBe(cached.burn.usd_per_hour);
  });

  test("the cache is a cache: dropping every row costs exactly one refresh", async () => {
    const tid = await taskWithSpend();
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    const before = (burnJson(h.db, { tid }) as BurnActive).wcet.consumed;
    h.db.query("DELETE FROM burn_cache").run();
    expect((burnJson(h.db, { tid }) as BurnEmpty).reason).toBe("no_cache");
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    expect((burnJson(h.db, { tid }) as BurnActive).wcet.consumed).toBe(before);
  });

  test("burn writes nothing: no cache row, no anomaly, no lock file", async () => {
    await taskWithSpend();
    refreshBurnCache(h.db, new Date("2026-01-01T00:03:00Z"));
    const anomaliesBefore = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n;
    const cacheBefore = h.db.query<{ as_of: string }, []>("SELECT as_of FROM burn_cache").get()!.as_of;

    for (let i = 0; i < 3; i += 1) expect((await h.cli("burn", "--json")).code).toBe(0);

    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly").get()!.n).toBe(anomaliesBefore);
    expect(h.db.query<{ as_of: string }, []>("SELECT as_of FROM burn_cache").get()!.as_of).toBe(cacheBefore);
    expect(await Bun.file(h.lockPath).exists()).toBe(false);
  });

  test("the burn rate divides by the OBSERVED span, not the nominal window", async () => {
    const tid = await openTask();
    // 600 Work-CET across a two-minute span => 300/min. Dividing by the 300-minute
    // window instead would report 2/min and never fire the overrun nudge.
    request(h.db, "r1", { out: 300, ts: "2026-01-01T00:01:00Z" });
    request(h.db, "r2", { out: 300, ts: "2026-01-01T00:03:00Z" });
    attributeTasks(h.db);
    const agg = aggregateBurn(h.db, tid, new Date("2026-01-01T00:03:00Z"));
    expect(agg.burn_wcet_per_min).toBeCloseTo(300, 5);
    expect(agg.proj_total_wcet).toBeGreaterThan(agg.consumed_wcet);
  });

  test("a task with no spend at all projects its own consumption, not a fabricated rate", async () => {
    const tid = await openTask();
    const agg = aggregateBurn(h.db, tid, new Date("2026-01-01T00:03:00Z"));
    expect(agg.consumed_wcet).toBe(0);
    expect(agg.burn_wcet_per_min).toBe(0);
    expect(agg.proj_total_wcet).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P1.9 — the statusline segment, where "wrong number" costs the most
// ---------------------------------------------------------------------------

describe("the ccstatusline segment — P1.9", () => {
  /** A bound, freshly swept task: the one case the segment is allowed to render. */
  async function boundAndSwept(now: Date): Promise<string> {
    const tid = await taskWithSpend();
    await h.cli("bind", tid, "--session", "s7");
    refreshBurnCache(h.db, now);
    return tid;
  }

  test("renders the band for a session-bound, freshly swept task", async () => {
    const now = new Date("2026-01-01T00:03:00Z");
    await boundAndSwept(now);
    const text = formatSegment(burnJson(h.db, { session: "s7", now }));
    expect(text).toContain("WCET");
    expect(text).toContain("[unvalidated]");
  });

  test("renders NOTHING from a stale cache row rather than a number from the past", async () => {
    // `stale_s` exists so the display can show staleness instead of implying
    // freshness; the segment has one line of budget and no room to qualify a number,
    // so its honest rendering of a stale row is no row at all. It comes back on the
    // next sweep.
    const swept = new Date("2026-01-01T00:03:00Z");
    await boundAndSwept(swept);
    const later = new Date("2026-01-01T06:00:00Z");
    const b = burnJson(h.db, { session: "s7", now: later }) as BurnActive;
    expect(b.warn).toContain("stale");
    expect(formatSegment(b)).toBe("");
  });

  test("renders NOTHING when the target was GUESSED — that band may be another session's", async () => {
    // The statusline always supplies a session. If nothing is bound to it, P1.6's
    // last step hands back the most recently touched open task in the whole database:
    // a fine answer at a terminal, and someone else's number in Craig's prompt.
    const now = new Date("2026-01-01T00:03:00Z");
    await boundAndSwept(now);
    const b = burnJson(h.db, { session: "some-other-session", now }) as BurnActive;
    expect(b.target).toBe("fallback");
    expect(formatSegment(b)).toBe("");
  });

  test("renders nothing for every empty result", () => {
    for (const reason of ["no_open_estimate", "no_cache", "db_busy", "db_missing"] as const) {
      expect(formatSegment({ schema: 1, active: false, as_of: "2026-01-01T00:00:00Z", reason })).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// the [unvalidated] marker, in BOTH renderers
// ---------------------------------------------------------------------------

describe("the [unvalidated] marker — P2.6", () => {
  /**
   * The terminal renderer and the statusline segment must agree, because they are two
   * views of ONE fact. `formatSegment` gated its `[unvalidated]` suffix on the payload
   * flag from day one; `renderBurn` pushed its sentence unconditionally, so once `est
   * recon --certify` had written `config.unvalidated_retired_at` the statusline and
   * `--json` said certified while `est burn` went on saying the numbers were
   * unreconciled. One reader of a fact is a fact; two that disagree is a bug on screen.
   */
  async function payload(now: Date): Promise<BurnActive> {
    const tid = await taskWithSpend();
    await h.cli("bind", tid, "--session", "s7");
    refreshBurnCache(h.db, now);
    return burnJson(h.db, { session: "s7", now }) as BurnActive;
  }

  const SENTENCE = "unvalidated: this number is ours and is not yet reconciled";
  const now = new Date("2026-01-01T00:03:00Z");

  test("the sentence is PRESENT while the marker stands", async () => {
    const b = await payload(now);
    expect(b.unvalidated).toBe(true);
    expect(renderBurn(b)).toContain(SENTENCE);
    expect(formatSegment(b)).toContain("[unvalidated]");
  });

  test("the sentence is ABSENT once the marker is retired", async () => {
    const b = await payload(now);
    const certified: BurnActive = { ...b, unvalidated: false };
    expect(renderBurn(certified)).not.toContain(SENTENCE);
    expect(formatSegment(certified)).not.toContain("[unvalidated]");
  });

  test("the warn list survives the gating — it was concatenated onto the sentence", async () => {
    // The warnings used to be appended to the very string that now sometimes vanishes,
    // so gating alone would have taken `over_p90` / `stale` / `unpriced` with it.
    const b = await payload(now);
    const warned: BurnActive = { ...b, unvalidated: false, warn: ["over_p90", "unpriced"] };
    const text = renderBurn(warned);
    expect(text).not.toContain(SENTENCE);
    expect(text).toContain("warn: over_p90, unpriced");
  });
});

// ---------------------------------------------------------------------------
// the cached read path is bounded by the ROW — every field of it
// ---------------------------------------------------------------------------

describe("check_back.n_seg comes out of burn_cache — P1.9", () => {
  test("the cached answer reads the column, never a COUNT(*) over run_segment", async () => {
    // The LAST field of the payload that was still an aggregate at render time:
    // `COUNT(*) FROM run_segment WHERE gap_min = ?`, which no index covered, inside the
    // one read path that promises to be bounded by the row. The proof is the same one
    // the sibling test above uses for the agent and price counts — write a value into
    // the row that disagrees with the table, and watch the render report the ROW.
    const now = new Date("2026-01-01T00:03:00Z");
    const tid = await taskWithSpend();
    await h.cli("bind", tid, "--session", "s7");
    refreshBurnCache(h.db, now);

    h.db
      .query(
        // `eta_waiting_on_input = 0` is part of the fiction, not decoration: the sweep
        // above found an idle session and set the flag, which outranks every forecast
        // column by design. This row is pretending to be a session with work in flight.
        `UPDATE burn_cache SET seg_started_at = ?, seg_elapsed_s = 60,
            check_back_p50_s = 600, check_back_p90_s = 1800,
            eta_model = 'residual_life', eta_probation = 1, eta_n_seg = 41,
            eta_waiting_on_input = 0
          WHERE tid = ?`,
      )
      .run("2026-01-01T00:02:00Z", tid);
    // The table says nothing at all; the row says 41.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_segment").get()?.n).toBe(0);

    const b = burnJson(h.db, { session: "s7", now }) as BurnActive;
    expect(b.check_back).not.toBeNull();
    expect((b.check_back as { n_seg: number }).n_seg).toBe(41);
    expect(renderBurn(b)).toContain("over 41 closed segment(s)");
  });

  test("a row written before the column existed reads as 0, not as a crash", async () => {
    const now = new Date("2026-01-01T00:03:00Z");
    const tid = await taskWithSpend();
    await h.cli("bind", tid, "--session", "s7");
    refreshBurnCache(h.db, now);
    h.db
      .query(
        `UPDATE burn_cache SET seg_started_at = ?, check_back_p50_s = 600,
            eta_model = 'residual_life', eta_n_seg = NULL, eta_waiting_on_input = 0
          WHERE tid = ?`,
      )
      .run("2026-01-01T00:02:00Z", tid);
    const cb = (burnJson(h.db, { session: "s7", now }) as BurnActive).check_back;
    expect((cb as { n_seg: number }).n_seg).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §7.3 — the interval union, which is what makes async fan-out visible
// ---------------------------------------------------------------------------

describe("intervalUnion — §7.3", () => {
  test("overlapping intervals count once in active_s and twice in busy_s", () => {
    const u = intervalUnion([
      { start: 0, end: 10_000 },
      { start: 5_000, end: 15_000 },
    ]);
    expect(u.activeS).toBe(15);
    expect(u.busyS).toBe(20);
    expect(u.maxConcurrency).toBe(2);
  });

  test("back-to-back intervals are one continuous stretch at depth 1", () => {
    const u = intervalUnion([
      { start: 0, end: 10_000 },
      { start: 10_000, end: 20_000 },
    ]);
    expect(u.activeS).toBe(20);
    expect(u.maxConcurrency).toBe(1);
  });

  test("disjoint intervals do not charge the idle gap", () => {
    const u = intervalUnion([
      { start: 0, end: 1_000 },
      { start: 3_600_000, end: 3_601_000 },
    ]);
    expect(u.activeS).toBe(2);
    expect(u.busyS).toBe(2);
  });

  test("degenerate and malformed intervals are ignored, never negative", () => {
    expect(intervalUnion([])).toEqual({ activeS: 0, busyS: 0, maxConcurrency: 0 });
    expect(intervalUnion([{ start: 10, end: 10 }]).activeS).toBe(0);
    expect(intervalUnion([{ start: 10, end: 1 }]).busyS).toBe(0);
    expect(intervalUnion([{ start: Number.NaN, end: 5 }]).activeS).toBe(0);
  });

  test("an agent outliving its launching turn contributes its whole interval", async () => {
    const tid = await openTask();
    // The turn is 60 s; the agent runs for an hour past it. R1's sum-of-turn-durations
    // would have reported 60 s of active time for a task that occupied an hour.
    agentRun(h.db, "a-long", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: "2026-01-01T00:00:30Z",
      endedAt: "2026-01-01T01:00:30Z",
    });
    attributeTasks(h.db);
    const u = intervalUnion(taskIntervals(h.db, tid));
    expect(u.activeS).toBe(3630);
    expect(u.maxConcurrency).toBe(2);
  });
});

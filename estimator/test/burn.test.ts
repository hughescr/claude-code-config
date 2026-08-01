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
  BURN_SCHEMA,
  intervalUnion,
  resolveBurnTarget,
  refreshBurnCache,
  renderBurn,
  taskAttribState,
  taskIntervals,
  type BurnActive,
  type BurnEmpty,
} from "../src/burn.ts";
import { attributeTasks } from "../src/attribute.ts";
import { run } from "../src/cli.ts";
import { openDb, setConfig } from "../src/db.ts";
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
    expect(body).toMatchObject({ schema: BURN_SCHEMA, active: false, reason: "no_open_estimate" });
  });

  test("an open estimate with no cache row: reason no_cache, exit 0", async () => {
    await openTask();
    const r = await h.cli("burn", "--json");
    expect(r.code).toBe(0);
    expect(r.json<BurnEmpty>().reason).toBe("no_cache");
  });

  test("a missing database file is reason db_missing at exit 0, never a stack trace", () => {
    const body = burnRead(join(h.dir, "does-not-exist.db")) as BurnEmpty;
    expect(body).toMatchObject({ schema: BURN_SCHEMA, active: false, reason: "db_missing" });
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

  test("--refresh against a locked database announces BURN_SCHEMA, never a hardcoded version", async () => {
    // `est burn --refresh` opens its OWN connection, so it owns its own catch — the one
    // burn payload assembled outside `src/burn.ts`. It used to build `{ schema: 1 }` by
    // hand, and nothing covered it, so the literal survived the move to 2: a schema-1
    // claim about a schema-2 contract, handed to the consumer least able to notice
    // (the statusline, mid-sweep). The payload is now typed at the declaration, which
    // makes a stale literal a compile error rather than a thing tests must catch.
    // The unreadable file rather than an exclusively-locked one: it is the SAME catch
    // and the same `classifyOpenError` (whose db_busy vs db_missing split is pinned
    // separately above), reached instantly instead of after the refresh connection's
    // 5 s `busy_timeout`. What is under test here is the version the catch announces.
    const path = join(h.dir, "not-a-database.db");
    await Bun.write(path, "this is not a sqlite file");

    const out: string[] = [];
    const code = await run(["--db", path, "--lock", join(h.dir, "refresh.lock"), "burn", "--json", "--refresh"], {
      out: (s) => out.push(s),
      err: () => {},
    });
    expect(code).toBe(0);
    const body = JSON.parse(out.join("\n")) as BurnEmpty;
    expect(body).toMatchObject({ schema: BURN_SCHEMA, active: false, reason: "db_missing" });
    // Stated as the consumer sees it: whatever the constant is, the refresh error path
    // must never be the one place that disagrees with it.
    expect(body.schema).not.toBe(1);
  });

  test("the human renderer says nothing-to-show rather than printing a zero band", () => {
    const text = renderBurn({ schema: BURN_SCHEMA, active: false, as_of: "2026-01-01T00:00:00Z", reason: "no_cache" });
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
    expect(b.schema).toBe(BURN_SCHEMA);
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

  test("renders no NUMBER when the target was GUESSED — that band may be another session's", async () => {
    // The statusline always supplies a session. If nothing is bound to it, P1.6's
    // last step hands back the most recently touched open task in the whole database:
    // a fine answer at a terminal, and someone else's number in Craig's prompt.
    //
    // Craig, 2026-07-30: the guessed target is also, in this session's terms, exactly
    // `task_attrib: "none"` — nothing here is being metered — so the segment now SAYS
    // that where it used to go blank. The invariant the test protects is unchanged and
    // asserted below: not one figure from the other session's band reaches the line.
    const now = new Date("2026-01-01T00:03:00Z");
    await boundAndSwept(now);
    const b = burnJson(h.db, { session: "some-other-session", now }) as BurnActive;
    expect(b.target).toBe("fallback");
    expect(b.task_attrib).toBe("none");
    expect(formatSegment(b)).toBe("no tracked task");
    expect(formatSegment(b)).not.toContain("WCET");
  });

  test("renders nothing for every empty result", () => {
    for (const reason of ["no_open_estimate", "no_cache", "db_busy", "db_missing"] as const) {
      expect(formatSegment({ schema: BURN_SCHEMA, active: false, as_of: "2026-01-01T00:00:00Z", reason })).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// task_attrib — "am I on a tracked task right now" (Craig, 2026-07-30)
// ---------------------------------------------------------------------------

describe("task_attrib — the tracked-task state", () => {
  /**
   * A task bound to `s1` with attributed spend and NO live delegation, so the only
   * thing that can make it `active` is the attribution window itself. The anchor turn
   * sits at 00:00, which is what every `now` below is measured against.
   */
  async function boundTask(now: Date): Promise<string> {
    const tid = await openTask();
    request(h.db, "r-main", { origin: "main", out: 150, cw: 50, ts: "2026-01-01T00:01:00Z" });
    attributeTasks(h.db);
    refreshBurnCache(h.db, now);
    return tid;
  }

  test("active: a bound task with an attributed turn inside the window", async () => {
    const now = new Date("2026-01-01T00:30:00Z");
    await boundTask(now);
    const b = burnJson(h.db, { session: "s1", now }) as BurnActive;
    expect(b.task_attrib).toBe("active");
    expect(b.pending_close).toBe(0);
    // The band renders exactly as it always did — this state changes nothing.
    expect(formatSegment(b)).toContain("WCET");
  });

  test("quiet: the same task once the attribution window has lapsed", async () => {
    // 5 hours on from the anchor turn, against the default `attr_stale_minutes` of
    // 120. The task is still open and still bound; nothing said since is booking to
    // it, which is the whole complaint — a finished task's percentage sitting on
    // screen all morning while unrelated chatter meters nowhere.
    const now = new Date("2026-01-01T05:00:00Z");
    await boundTask(now);
    const b = burnJson(h.db, { session: "s1", now }) as BurnActive;
    expect(b.task_attrib).toBe("quiet");
    expect(b.pending_close).toBe(1);
    expect(formatSegment(b)).toBe("no tracked task · 1 pending close");
    expect(formatSegment(b)).not.toContain("%");
  });

  test("none: a session with no open task bound to it", async () => {
    const now = new Date("2026-01-01T00:30:00Z");
    await boundTask(now);
    const b = burnJson(h.db, { session: "s-unrelated", now }) as BurnActive;
    expect(b.task_attrib).toBe("none");
    // Nothing is bound HERE, so there is nothing here to close either — the pending
    // count is about this session's own tasks, never the database's.
    expect(b.pending_close).toBe(0);
    expect(formatSegment(b)).toBe("no tracked task");
  });

  test("two open tasks in one session: the ACTIVE one is rendered, not the newest", async () => {
    // The failure this pins: a session hosts many tasks (schema v6), the older one is
    // absorbing work (here through a delegation still in flight) and the newer one is
    // quiet. `resolveBurnTarget` takes the NEWEST binding, so the payload carried the
    // quiet task's band — and once the state existed, the segment printed
    // "no tracked task · 1 pending close" while spend was accruing. Both halves are
    // wrong on screen, which is the one thing P1.9 forbids.
    const now = new Date("2026-01-01T06:00:00Z");
    const older = await boundTask(now);
    // FRESH, not merely unfinished: `countLiveAgents` ages a silent delegation out at
    // `eta_live_agent_max_min`, so a corpse cannot pin a task as active forever.
    agentRun(h.db, "a-live", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: "2026-01-01T05:50:00Z",
      endedAt: null,
    });

    turn(h.db, { session: "s1", prompt: "p2", at: "2026-01-01T00:05:00Z", durationMs: 60_000 });
    const opened = await h.cli(
      ...openArgs({ subject: "the second task" }),
      "--session",
      "s1",
      "--prompt",
      "p2",
      "--json",
    );
    expect(opened.code).toBe(0);
    const newer = opened.json<{ tid: string }>().tid;
    attributeTasks(h.db);
    // Hand the second turn to the newer task directly. Attribution's delegation touch
    // keeps giving BOTH turns to the older one here, and what this test is about is the
    // reader, not the walk: the fixture states the shape the reader has to handle —
    // each task with a turn of its own, one still live and one long since quiet.
    h.db.query("UPDATE turn SET tid = ? WHERE session_id = 's1' AND prompt_id = 'p2'").run(newer);
    refreshBurnCache(h.db, now);

    // The resolver on its own still answers "the newest binding" — that is its
    // documented job, and the reason the state has to name the task instead.
    expect(resolveBurnTarget(h.db, { session: "s1" })).toEqual({ tid: newer, target: "session" });

    const b = burnJson(h.db, { session: "s1", now }) as BurnActive;
    expect(b.task_attrib).toBe("active");
    expect(b.tid).toBe(older);
    expect(b.pending_close).toBe(1);
    expect(formatSegment(b)).toContain("WCET");
    expect(formatSegment(b)).not.toContain("no tracked task");
  });

  test("a long single turn stays active: attribution timestamps a turn by its START", async () => {
    // §6.2 protects the 20.9-hour turn by construction, and the statusline has to agree:
    // measuring from the turn's start alone would age a still-running turn into `quiet`
    // and blank the band exactly while it was burning. Only the session's NEWEST turn
    // counts — a NULL duration in history is what a killed session leaves behind.
    const now = new Date("2026-01-01T09:00:00Z");
    const tid = await boundTask(now);
    turn(h.db, { session: "s1", prompt: "p-long", at: "2026-01-01T01:00:00Z", durationMs: null });
    h.db.query("UPDATE turn SET tid = ? WHERE prompt_id = 'p-long'").run(tid);
    refreshBurnCache(h.db, now);

    const b = burnJson(h.db, { session: "s1", now }) as BurnActive;
    expect(b.task_attrib).toBe("active");
    expect(b.pending_close).toBe(0);
  });

  test("intervening turns retire it even inside the minutes window — attr_stale_turns", async () => {
    // The other arm of attribution's own predicate, which a minutes-only copy of this
    // logic silently dropped: five turns that booked somewhere else IS the session
    // having moved on, whatever the clock says.
    const now = new Date("2026-01-01T00:40:00Z");
    await boundTask(now);
    for (let i = 0; i < 5; i += 1) {
      turn(h.db, {
        session: "s1",
        prompt: `p-chat-${i}`,
        at: `2026-01-01T00:${10 + i}:00Z`,
        durationMs: 1000,
      });
    }
    refreshBurnCache(h.db, now);
    const b = burnJson(h.db, { session: "s1", now }) as BurnActive;
    expect(b.task_attrib).toBe("quiet");
    expect(formatSegment(b)).toBe("no tracked task · 1 pending close");
  });

  test("a live delegation keeps it active with no turn inside the window at all", async () => {
    // §5.4's third touch, on the statusline: the orchestrator's own session goes quiet
    // for hours while a background agent burns tokens against the task. That is the
    // pattern this system exists to measure, and blanking the band through it would
    // hide the number exactly when it is moving fastest.
    const now = new Date("2026-01-01T05:00:00Z");
    const tid = await boundTask(now);
    agentRun(h.db, "a-live", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: "2026-01-01T04:50:00Z",
      endedAt: null,
    });
    attributeTasks(h.db);
    refreshBurnCache(h.db, now);
    const b = burnJson(h.db, { session: "s1", now }) as BurnActive;
    expect(b.agents.live).toBeGreaterThan(0);
    expect(b.task_attrib).toBe("active");
    expect(tid).toBe(b.tid);
  });

  test("the boundary is `attr_stale_minutes` — the SAME key attribution closes on", async () => {
    // Not a threshold of its own: the claim `quiet` makes is "the attribution pass has
    // stopped booking turns here", so a second window could only make the statusline
    // disagree with the ledger it reports on.
    const now = new Date("2026-01-01T00:30:00Z");
    await boundTask(now);
    expect((burnJson(h.db, { session: "s1", now }) as BurnActive).task_attrib).toBe("active");

    setConfig(h.db, "attr_stale_minutes", "5");
    expect((burnJson(h.db, { session: "s1", now }) as BurnActive).task_attrib).toBe("quiet");
  });

  test("a stale cache row still blanks the segment, whatever the state says", async () => {
    // P1.9's blanking rule is untouched: with no sweep inside the staleness window
    // every number on the payload is from the past, and so is the state derived from
    // it. The segment comes back on the next sweep, saying whichever it then is.
    const swept = new Date("2026-01-01T00:03:00Z");
    await boundTask(swept);
    const later = new Date("2026-01-01T06:00:00Z");
    const b = burnJson(h.db, { session: "s1", now: later }) as BurnActive;
    expect(b.warn).toContain("stale");
    expect(b.task_attrib).toBe("quiet");
    expect(formatSegment(b)).toBe("");
  });

  test("a task with no cache row reads as zero live agents — no per-render query", async () => {
    // P1.9's budget is ONE indexed row read, and `liveAgents` is a count over an
    // unbounded table. A missing cache row is a one-sweep condition (a task opened
    // seconds ago), so the cached path treats it as zero and lets the next micro-sweep
    // fix it — `--refresh`, the live path by contract, still asks for the real count.
    const now = new Date("2026-01-01T09:00:00Z");
    const tid = await boundTask(now);
    agentRun(h.db, "a-live", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: "2026-01-01T08:55:00Z",
      endedAt: null,
    });
    attributeTasks(h.db);
    h.db.query("DELETE FROM burn_cache WHERE tid = ?").run(tid);

    expect(taskAttribState(h.db, { session: "s1", now })).toMatchObject({
      state: "quiet",
      active_tid: null,
    });
    expect(taskAttribState(h.db, { session: "s1", now, live: "fresh" })).toMatchObject({
      state: "active",
      active_tid: tid,
    });
  });

  test("active_tid names the task the session is metering, even on an explicit --tid", async () => {
    // `task_attrib` is session-wide, so an explicit `est burn <quiet-tid>` can report
    // `active` about a DIFFERENT task. Without `active_tid` a consumer cannot tell that
    // apart from "the task you asked about is the live one".
    const now = new Date("2026-01-01T06:00:00Z");
    const older = await boundTask(now);
    agentRun(h.db, "a-live", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: "2026-01-01T05:50:00Z",
      endedAt: null,
    });
    turn(h.db, { session: "s1", prompt: "p2", at: "2026-01-01T00:05:00Z", durationMs: 60_000 });
    const opened = await h.cli(
      ...openArgs({ subject: "the quiet one" }),
      "--session",
      "s1",
      "--prompt",
      "p2",
      "--json",
    );
    const quiet = opened.json<{ tid: string }>().tid;
    attributeTasks(h.db);
    h.db.query("UPDATE turn SET tid = ? WHERE session_id = 's1' AND prompt_id = 'p2'").run(quiet);
    refreshBurnCache(h.db, now);

    const b = burnJson(h.db, { tid: quiet, session: "s1", now }) as BurnActive;
    // The explicit tid is honoured — the payload is about the task that was named...
    expect(b.tid).toBe(quiet);
    expect(b.target).toBe("explicit");
    // ...and the state says, unambiguously, that the session is on the other one.
    expect(b.task_attrib).toBe("active");
    expect(b.active_tid).toBe(older);
    expect(renderBurn(b)).toContain("NOT THIS TASK");
    expect(renderBurn(b)).toContain(older);
  });

  test("an older binary's payload — no task_attrib at all — renders the band", async () => {
    // P2.0's additive rule from the consumer's side: an absent field means the producer
    // has nothing to say, never "there is no tracked task".
    const now = new Date("2026-01-01T00:30:00Z");
    await boundTask(now);
    const legacy = { ...(burnJson(h.db, { session: "s1", now }) as BurnActive) } as Partial<BurnActive>;
    delete legacy.task_attrib;
    delete legacy.pending_close;
    expect(formatSegment(legacy as BurnActive)).toContain("WCET");
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

/**
 * Price sync tests — token-estimation-design-r3.md §4.3–4.4.
 *
 * Everything runs against the committed fixtures in test/fixtures/, never the
 * network: the sandbox has no route to raw.githubusercontent.com, and a test
 * that silently depends on one would be a test that fails for the wrong reason.
 * The live leg is exercised with an injected `fetchImpl` in both directions —
 * succeeding and throwing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { run } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { modelFamily } from "../src/ingest.ts";
import {
  ABOVE_200K_SUFFIX,
  compareGeneration,
  contextSuffixTokens,
  currentPrice,
  EPOCH_ZERO,
  fillCw1h,
  FIXTURE_DIR,
  LITELLM_URL,
  newestSnapshot,
  normalizeModelId,
  parseLiteLLM,
  priceFamily,
  resolveCw1h,
  setManualPrice,
  showPrices,
  sync,
  tierPeer,
} from "../src/prices.ts";

let dir: string;
let db: Database;

/** A fetch that always fails, i.e. the sandbox. Cast like every other stub here:
 *  `typeof fetch` carries statics (`preconnect`) a call-only stub has no use for. */
const deadFetch = (() =>
  Promise.reject(new Error("ENETUNREACH (sandboxed)"))) as unknown as typeof fetch;

/** Every sync in this file is offline unless a test says otherwise. */
const offline = { fetchImpl: deadFetch } as const;

const T0 = new Date("2026-07-01T00:00:00Z");
const T1 = new Date("2026-07-15T00:00:00Z");
const T2 = new Date("2026-07-20T00:00:00Z");

function anomalies(kind?: string): Array<{ kind: string; detail: string }> {
  const sql = kind
    ? "SELECT kind, detail FROM anomaly WHERE kind = ? ORDER BY id"
    : "SELECT kind, detail FROM anomaly ORDER BY id";
  const q = db.query<{ kind: string; detail: string }, string[]>(sql);
  return kind ? q.all(kind) : q.all();
}

function syncRows() {
  return db
    .query<
      { price_epoch: string; source: string; ok: number; n_families: number; n_provisional: number },
      []
    >("SELECT price_epoch, source, ok, n_families, n_provisional FROM price_sync ORDER BY price_epoch")
    .all();
}

/** One corpus row, the shape the sweeper writes — the thing prices exist to price. */
function request(
  id: string,
  family: string,
  ts: string,
  tok: { in_tok?: number; out_tok?: number; cw_tok?: number; cr_tok?: number } = {},
): void {
  db.query(
    `INSERT INTO request (request_id, session_id, origin, model, model_family, ts,
                          in_tok, out_tok, cw_tok, cr_tok)
     VALUES (?,?, 'main', ?, ?, ?, ?,?,?,?)`,
  ).run(
    id,
    "s1",
    family,
    family,
    ts,
    tok.in_tok ?? 1000,
    tok.out_tok ?? 100,
    tok.cw_tok ?? 0,
    tok.cr_tok ?? 0,
  );
}

/** How `v_priced` — the INNER JOIN every USD figure rests on — resolves a request. */
function priced(id: string): { usd_out: number; provisional: number } | null {
  return (
    db
      .query<{ usd_out: number; provisional: number }, [string]>(
        "SELECT usd_out, provisional FROM v_priced WHERE request_id = ?",
      )
      .get(id) ?? null
  );
}

/** Every vintage on file for a family, oldest first. */
function vintages(family: string) {
  return db
    .query<{ effective_from: string; usd_out: number; provisional: number }, [string]>(
      "SELECT effective_from, usd_out, provisional FROM model_price WHERE family = ? ORDER BY effective_from",
    )
    .all(family);
}

/** The Work-CET a request contributes, at its own vintage (v_wcet). */
function wcet(id: string): number | null {
  return (
    db.query<{ wcet: number }, [string]>("SELECT wcet FROM v_wcet WHERE request_id = ?").get(id)
      ?.wcet ?? null
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "estimator-prices-test-"));
  db = openDb({ path: join(dir, "estimator.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("normalizeModelId", () => {
  test("strips the bracket suffix Claude Code appends for context/effort", () => {
    const n = normalizeModelId("claude-opus-5[1m]");
    expect(n.family).toBe("claude-opus-5");
    expect(n.contextSuffix).toBe("1m");
    expect(n.tier).toBe("opus");
    expect(n.generation).toEqual([5]);
  });

  test("a bracket suffix never leaks into the family key", () => {
    for (const raw of ["claude-opus-5[1m]", "claude-sonnet-5[xhigh]", "claude-fable-5[]"]) {
      expect(normalizeModelId(raw).family).not.toContain("[");
      expect(normalizeModelId(raw).family).not.toContain("]");
    }
    expect(normalizeModelId("claude-sonnet-5[xhigh]").family).toBe("claude-sonnet-5");
    expect(normalizeModelId("claude-fable-5[]").contextSuffix).toBeNull();
  });

  test("collapses dated aliases, vendor prefixes and bedrock version tails", () => {
    expect(normalizeModelId("claude-sonnet-4-5-20250929").family).toBe("claude-sonnet-4-5");
    expect(normalizeModelId("us.anthropic.claude-opus-5").family).toBe("claude-opus-5");
    expect(normalizeModelId("global.anthropic.claude-fable-5").family).toBe("claude-fable-5");
    expect(normalizeModelId("anthropic.claude-sonnet-4-5-20250929-v1:0").family).toBe(
      "claude-sonnet-4-5",
    );
    expect(normalizeModelId("bedrock/anthropic.claude-haiku-4-5@20251001").family).toBe(
      "claude-haiku-4-5",
    );
  });

  test("reads the tier out of either name order, and never from a date", () => {
    expect(normalizeModelId("claude-3-5-sonnet-20241022")).toMatchObject({
      family: "claude-3-5-sonnet",
      tier: "sonnet",
      generation: [3, 5],
    });
    expect(normalizeModelId("claude-4-opus-20250514")).toMatchObject({
      tier: "opus",
      generation: [4],
    });
    // The three Claude Code 5-generation ids named in the design.
    expect(normalizeModelId("claude-opus-5").tier).toBe("opus");
    expect(normalizeModelId("claude-fable-5").tier).toBe("fable");
    expect(normalizeModelId("claude-sonnet-5").tier).toBe("sonnet");
  });

  test("keeps the bare tier aliases the transcripts actually contain", () => {
    // ~200 real lines in ~/.claude/projects carry "opus"/"sonnet"/"haiku"/"fable".
    expect(normalizeModelId("opus")).toMatchObject({ tier: "opus", generation: [] });
    expect(normalizeModelId("fable")).toMatchObject({ tier: "fable", generation: [] });
  });
});

describe("compareGeneration", () => {
  test("orders 5 above 4-8 above 4-5 above 4", () => {
    expect(compareGeneration([5], [4, 8])).toBe(1);
    expect(compareGeneration([4, 8], [4, 5])).toBe(1);
    expect(compareGeneration([4, 5], [4])).toBe(1);
    expect(compareGeneration([4, 5], [4, 5])).toBe(0);
    expect(compareGeneration([3, 5], [5])).toBe(-1);
  });
});

// ---------------------------------------------------------------------------

describe("the committed LiteLLM fixture", () => {
  test("carries the ids Claude Code actually reports", () => {
    const path = newestSnapshot(FIXTURE_DIR, "litellm-snapshot");
    expect(path).not.toBeNull();
    const table = parseLiteLLM(JSON.parse(require("node:fs").readFileSync(path!, "utf8")));
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8"]) {
      expect(table.has(id)).toBe(true);
    }
  });

  test("converts per-token costs to the per-Mtok unit model_price declares", () => {
    const path = newestSnapshot(FIXTURE_DIR, "litellm-snapshot")!;
    const table = parseLiteLLM(JSON.parse(require("node:fs").readFileSync(path, "utf8")));
    // Upstream: input 5e-6/token. model_price stores USD per MILLION tokens.
    expect(table.get("claude-opus-5")!.rates).toEqual({
      usd_in: 5,
      usd_out: 25,
      usd_cw: 6.25,
      usd_cr: 0.5,
      // CACHE-TTL-PRICING.md D5: 0.00001/token upstream -> 10/Mtok, exactly 2x
      // usd_in, so this is the RAW candidate parseLiteLLM reports (ungated).
      usd_cw1h: 10,
    });
    expect(table.get("claude-sonnet-5")!.rates).toEqual({
      usd_in: 2,
      usd_out: 10,
      usd_cw: 2.5,
      usd_cr: 0.2,
      usd_cw1h: 4,
    });
    expect(table.get("claude-fable-5")!.rates.usd_out).toBe(50);
  });

  test("dated aliases collapse into one family, as model_price requires", () => {
    const path = newestSnapshot(FIXTURE_DIR, "litellm-snapshot")!;
    const raw = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as Record<string, unknown>;
    const table = parseLiteLLM(raw);

    // The fixture carries both claude-sonnet-4-5 and claude-sonnet-4-5-20250929
    // (and a -v1:0 alias); all three are one family.
    expect(Object.keys(raw).length).toBeGreaterThan(table.size);
    expect(table.has("claude-sonnet-4-5")).toBe(true);
    expect(table.has("claude-sonnet-4-5-20250929")).toBe(false);
    expect([...table.keys()].some((k) => /\d{8}/.test(k))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("sync — a known id prices correctly, per epoch", () => {
  test("writes one price_sync epoch and authoritative model_price rows", async () => {
    const res = await sync(db, { ...offline, now: T0 });

    expect(res.ok).toBe(true);
    expect(res.source).toBe("litellm");
    expect(res.price_epoch).toBe("2026-07-01T00:00:00Z");
    expect(res.n_families).toBeGreaterThanOrEqual(15);

    const rows = syncRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ price_epoch: res.price_epoch, source: "litellm", ok: 1 });

    const opus = currentPrice(db, "claude-opus-5")!;
    expect(opus).toMatchObject({ usd_in: 5, usd_out: 25, usd_cw: 6.25, usd_cr: 0.5 });
    expect(opus.provisional).toBe(0);
    expect(opus.source).toBe("litellm");
  });

  test("backdates a family's FIRST rate so the backfilled corpus is priceable", async () => {
    await sync(db, { ...offline, now: T0 });
    // v_priced resolves MAX(effective_from) <= request.ts; a first row stamped
    // at the sync epoch would leave every historical request unpriced.
    expect(currentPrice(db, "claude-opus-5")!.effective_from).toBe(EPOCH_ZERO);
    expect(currentPrice(db, "claude-opus-5", "2025-01-01T00:00:00Z")).not.toBeNull();
  });

  test("a rate CHANGE opens a new epoch and the old epoch still resolves the old rate", async () => {
    await sync(db, { ...offline, now: T0 });
    expect(currentPrice(db, "claude-opus-5")!.usd_out).toBe(25);

    // Upstream reprices opus-5 output from $25 to $30 per Mtok.
    const snapDir = join(dir, "snap");
    require("node:fs").mkdirSync(snapDir, { recursive: true });
    writeFileSync(
      join(snapDir, "litellm-snapshot.json"),
      JSON.stringify({
        "claude-opus-5": {
          litellm_provider: "anthropic",
          input_cost_per_token: 5e-6,
          output_cost_per_token: 3e-5,
          cache_creation_input_token_cost: 6.25e-6,
          cache_read_input_token_cost: 5e-7,
        },
      }),
    );

    const res = await sync(db, { ...offline, now: T1, fixtureDir: snapDir, source: "fixture" });
    expect(res.ok).toBe(true);
    expect(res.n_rows_written).toBe(1);

    // §4.4: an estimate issued under the T0 epoch must still see the T0 price.
    expect(currentPrice(db, "claude-opus-5", "2026-07-01T00:00:00Z")!.usd_out).toBe(25);
    expect(currentPrice(db, "claude-opus-5", "2026-07-15T00:00:00Z")!.usd_out).toBe(30);
    expect(currentPrice(db, "claude-opus-5")!.usd_out).toBe(30);

    // Untouched families keep their earlier rate — a partial table is not a purge.
    expect(currentPrice(db, "claude-sonnet-5")!.usd_out).toBe(10);
    expect(syncRows()).toHaveLength(2);
  });

  test("an unchanged re-sync writes no history but still opens an epoch", async () => {
    await sync(db, { ...offline, now: T0 });
    const second = await sync(db, { ...offline, now: T1 });
    expect(second.ok).toBe(true);
    expect(second.n_rows_written).toBe(0);
    expect(syncRows()).toHaveLength(2);
    expect(currentPrice(db, "claude-opus-5")!.effective_from).toBe(EPOCH_ZERO);
  });

  test("two syncs inside one second do not collide on the price_epoch PK", async () => {
    await sync(db, { ...offline, now: T0 });
    const b = await sync(db, { ...offline, now: T0 });
    expect(b.price_epoch).not.toBe("2026-07-01T00:00:00Z");
    expect(syncRows()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("sync — an unknown new family gets provisional tier-peer pricing", () => {
  test("claude-opus-6 is priced from claude-opus-5 and flagged", async () => {
    await sync(db, { ...offline, now: T0 });
    const res = await sync(db, { ...offline, now: T1, models: ["claude-opus-6"] });

    expect(res.n_provisional).toBe(1);
    expect(res.unmatched).toEqual([]);

    const p = currentPrice(db, "claude-opus-6")!;
    expect(p.provisional).toBe(1);
    // Same tier, newest generation: opus-5, not opus-4-8 or opus-4-5.
    expect(p).toMatchObject({ usd_in: 5, usd_out: 25, usd_cw: 6.25, usd_cr: 0.5 });

    const flagged = anomalies("provisional_price");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.detail).toContain("claude-opus-6");
    expect(flagged[0]!.detail).toContain("claude-opus-5");
  });

  test("a bare tier alias resolves to the newest model of that tier", async () => {
    await sync(db, { ...offline, now: T0, models: ["opus", "fable"] });
    expect(currentPrice(db, "opus")).toMatchObject({ usd_out: 25, provisional: 1 });
    expect(currentPrice(db, "fable")).toMatchObject({ usd_out: 50, provisional: 1 });
  });

  test("tierPeer refuses to guess across tiers", () => {
    const pool = [
      {
        family: "claude-opus-5",
        tier: "opus",
        generation: [5],
        rates: { usd_in: 5, usd_out: 25, usd_cw: 6.25, usd_cr: 0.5 },
        above200k: null,
        source: "litellm" as const,
        provisional: false,
      },
    ];
    expect(tierPeer(normalizeModelId("claude-opus-9"), pool)?.family).toBe("claude-opus-5");
    expect(tierPeer(normalizeModelId("claude-sonnet-9"), pool)).toBeNull();
    expect(tierPeer(normalizeModelId("gpt-6"), pool)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("sync — never a silent zero", () => {
  test("an unresolvable id writes an anomaly and NO price row", async () => {
    const res = await sync(db, { ...offline, now: T0, models: ["gpt-6-turbo"] });

    expect(res.unmatched).toEqual(["gpt-6-turbo"]);
    expect(currentPrice(db, "gpt-6-turbo")).toBeNull();

    const flagged = anomalies("unpriced_model");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.detail).toContain("gpt-6-turbo");
    expect(flagged[0]!.detail).toContain("NO price row");
  });

  test("<synthetic> is not an API model and raises nothing", async () => {
    const res = await sync(db, { ...offline, now: T0, models: ["<synthetic>"] });
    expect(res.unmatched).toEqual([]);
    expect(anomalies("unpriced_model")).toHaveLength(0);
    expect(currentPrice(db, "<synthetic>")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("sync — the fallback chain never blocks on the network", () => {
  test("a dead live fetch degrades to the local snapshot and records the failure", async () => {
    const res = await sync(db, { fetchImpl: deadFetch, now: T0 });

    expect(res.ok).toBe(true);
    expect(currentPrice(db, "claude-opus-5")!.usd_out).toBe(25);

    const live = res.attempts.find((a) => a.leg === "live-litellm")!;
    expect(live.ok).toBe(false);
    expect(live.error).toContain("sandboxed");
    expect(res.attempts.some((a) => a.leg === "fixture-litellm" && a.ok)).toBe(true);
  });

  test("a live fetch that works is preferred over the snapshot", async () => {
    const liveTable = {
      "claude-opus-5": {
        input_cost_per_token: 9e-6,
        output_cost_per_token: 4.5e-5,
        cache_creation_input_token_cost: 1.125e-5,
        cache_read_input_token_cost: 9e-7,
      },
    };
    const liveFetch = ((url: string) =>
      Promise.resolve(
        url === LITELLM_URL
          ? new Response(JSON.stringify(liveTable), { status: 200 })
          : new Response("{}", { status: 404, statusText: "Not Found" }),
      )) as unknown as typeof fetch;

    const res = await sync(db, { fetchImpl: liveFetch, now: T0 });
    expect(res.attempts[0]).toMatchObject({ leg: "live-litellm", ok: true });
    expect(currentPrice(db, "claude-opus-5")!.usd_out).toBe(45);
    // The live primary carried one family, and the LiteLLM snapshot was never
    // consulted — a family only the snapshot knows about must not appear.
    expect(res.attempts.some((a) => a.leg === "fixture-litellm")).toBe(false);
    expect(currentPrice(db, "claude-opus-4-1")).toBeNull();
  });

  test("the models.dev snapshot still fills in when only the secondary leg is down", async () => {
    // Live primary up, live secondary down: the secondary degrades to its own
    // snapshot rather than the whole sync losing its fill source.
    const liveFetch = ((url: string) =>
      Promise.resolve(
        url === LITELLM_URL
          ? new Response(JSON.stringify({ "claude-opus-5": { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 } }))
          : new Response("nope", { status: 503, statusText: "Service Unavailable" }),
      )) as unknown as typeof fetch;

    const res = await sync(db, { fetchImpl: liveFetch, now: T0 });
    expect(res.attempts.find((a) => a.leg === "live-models-dev")!.ok).toBe(false);
    expect(res.attempts.find((a) => a.leg === "fixture-models-dev")!.ok).toBe(true);
    expect(currentPrice(db, "claude-sonnet-5")!.source).toBe("models_dev");
  });

  test("a total failure writes price_sync(ok=0) and changes nothing else", async () => {
    await sync(db, { ...offline, now: T0 });
    const before = showPrices(db);

    const empty = join(dir, "empty");
    require("node:fs").mkdirSync(empty, { recursive: true });
    const res = await sync(db, { fetchImpl: deadFetch, now: T2, fixtureDir: empty });

    expect(res.ok).toBe(false);
    expect(res.n_families).toBe(0);
    expect(res.n_rows_written).toBe(0);
    expect(showPrices(db)).toEqual(before);

    const rows = syncRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.ok).toBe(0);
  });

  test("models.dev fills a family LiteLLM does not carry", async () => {
    const liveFetch = ((url: string) =>
      Promise.resolve(
        url === LITELLM_URL
          ? new Response(JSON.stringify({ "claude-zzz-1": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }))
          : new Response(
              JSON.stringify({
                providers: {
                  anthropic: {
                    models: {
                      "claude-sonnet-5": {
                        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
                      },
                    },
                  },
                },
              }),
            ),
      )) as unknown as typeof fetch;

    await sync(db, { fetchImpl: liveFetch, now: T0 });
    const p = currentPrice(db, "claude-sonnet-5")!;
    expect(p.source).toBe("models_dev");
    expect(p).toMatchObject({ usd_in: 2, usd_out: 10, usd_cw: 2.5, usd_cr: 0.2 });
  });
});

// ---------------------------------------------------------------------------

describe("long-context tier", () => {
  test("above-200k rates are persisted as a companion family", async () => {
    await sync(db, { ...offline, now: T0 });
    const hi = currentPrice(db, "claude-sonnet-4-5" + ABOVE_200K_SUFFIX);
    expect(hi).not.toBeNull();
    expect(hi!.usd_in).toBe(6);
    expect(hi!.usd_out).toBe(22.5);
    // The base tier is untouched by the companion row.
    expect(currentPrice(db, "claude-sonnet-4-5")!.usd_in).toBe(3);
  });

  test("the companion rows are consumed per-REQUEST by v_priced — SQL is their only reader", async () => {
    await sync(db, { ...offline, now: T0 });
    // One model id, two prompt sizes. A transcript never says "1m": the premium
    // is a property of THIS call's prompt, so the view reads it off the counters.
    // There is deliberately no TypeScript twin of that rule — `familyForContext`
    // was one, nothing on the pricing path called it, and it ignored vintage.
    request("small", "claude-sonnet-4-5", "2026-07-05T00:00:00Z", { in_tok: 150_000 });
    request("big", "claude-sonnet-4-5", "2026-07-05T00:00:00Z", { in_tok: 300_000 });
    request("opus_big", "claude-opus-5", "2026-07-05T00:00:00Z", { in_tok: 900_000 });

    expect(priced("small")!.usd_out).toBe(currentPrice(db, "claude-sonnet-4-5")!.usd_out);
    expect(priced("big")!.usd_out).toBe(
      currentPrice(db, "claude-sonnet-4-5" + ABOVE_200K_SUFFIX)!.usd_out,
    );
    expect(priced("big")!.usd_out).not.toBe(priced("small")!.usd_out);
    // opus-5 publishes no long-context tier: the base row stands, never a fabricated one.
    expect(priced("opus_big")!.usd_out).toBe(currentPrice(db, "claude-opus-5")!.usd_out);
  });

  test("a GUESSED bracketed family leaves no companion for the published rate to fight", async () => {
    // The one composition that made the companion rows dangerous. A bracketed
    // family whose base is unpublished falls through to the tier-peer guess,
    // which used to copy the PEER's `@above_200k` companion under the bracketed
    // name. `model_price` is append-only, so the later sync that publishes the
    // real rate opens a new vintage of `claude-opus-9[1m]` but CANNOT supersede
    // that companion — and `v_request_tiered` preferred the companion. Result:
    // every >200k call billed at 150 instead of 50, and provisional=1, which via
    // outcome.price_provisional keeps its whole task out of v_velocity forever.
    const empty = join(dir, "no-fixtures");
    require("node:fs").mkdirSync(empty, { recursive: true });
    const upstream = (extra: Record<string, unknown>): typeof fetch =>
      ((url: string) =>
        Promise.resolve(
          url === LITELLM_URL
            ? new Response(
                JSON.stringify({
                  "claude-opus-4-1": {
                    input_cost_per_token: 15e-6,
                    output_cost_per_token: 75e-6,
                    cache_creation_input_token_cost: 18.75e-6,
                    cache_read_input_token_cost: 1.5e-6,
                    input_cost_per_token_above_200k_tokens: 30e-6,
                    output_cost_per_token_above_200k_tokens: 150e-6,
                  },
                  ...extra,
                }),
              )
            : new Response("{}", { status: 404, statusText: "Not Found" }),
        )) as unknown as typeof fetch;

    request("r_1m", "claude-opus-9[1m]", "2026-12-01T00:00:00Z", { in_tok: 300_000, out_tok: 1000 });

    // Sync 1 — nothing upstream publishes claude-opus-9, so the [1m] family is a
    // tier-peer guess. The peer HAS a >200k tier; it is baked into the bracketed
    // row (which is what `[1m]` means) and no companion is written.
    await sync(db, { fetchImpl: upstream({}), now: T0, fixtureDir: empty });
    expect(currentPrice(db, "claude-opus-9[1m]")).toMatchObject({ usd_out: 150, provisional: 1 });
    expect(currentPrice(db, "claude-opus-9[1m]" + ABOVE_200K_SUFFIX)).toBeNull();

    // Sync 2 — upstream now publishes claude-opus-9, long-context tier and all.
    await sync(db, {
      fetchImpl: upstream({
        "claude-opus-9": {
          input_cost_per_token: 5e-6,
          output_cost_per_token: 25e-6,
          cache_creation_input_token_cost: 6.25e-6,
          cache_read_input_token_cost: 0.5e-6,
          input_cost_per_token_above_200k_tokens: 10e-6,
          output_cost_per_token_above_200k_tokens: 50e-6,
        },
      }),
      now: T1,
      fixtureDir: empty,
    });

    // The published long-context rate wins, and it is authoritative — so the
    // request stays eligible for calibration instead of being poisoned.
    expect(priced("r_1m")).toEqual({ usd_out: 50, provisional: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("price epochs are immutable — repricing is never retroactive", () => {
  /** Upstream starts publishing claude-opus-6 at $6/$30 per Mtok. */
  function publishOpus6(): string {
    const snapDir = join(dir, "snap");
    require("node:fs").mkdirSync(snapDir, { recursive: true });
    writeFileSync(
      join(snapDir, "litellm-snapshot.json"),
      JSON.stringify({
        "claude-opus-6": {
          input_cost_per_token: 6e-6,
          output_cost_per_token: 3e-5,
          cache_creation_input_token_cost: 7.5e-6,
          cache_read_input_token_cost: 6e-7,
        },
      }),
    );
    return snapDir;
  }

  test("an authoritative rate arriving later opens a NEW vintage and leaves the guess standing", async () => {
    await sync(db, { ...offline, now: T0, models: ["claude-opus-6"] });
    expect(currentPrice(db, "claude-opus-6")).toMatchObject({
      provisional: 1,
      usd_out: 25,
      effective_from: EPOCH_ZERO,
    });

    const res = await sync(db, {
      ...offline,
      now: T1,
      fixtureDir: publishOpus6(),
      source: "fixture",
    });
    expect(res.ok).toBe(true);

    // The published rate is a NEW row, from the epoch it actually arrived in…
    expect(currentPrice(db, "claude-opus-6")).toMatchObject({
      provisional: 0,
      usd_out: 30,
      effective_from: "2026-07-15T00:00:00Z",
    });
    // …and the guess survives as the historical vintage. Rewriting it in place —
    // which is what this used to do — restated every estimate ever issued under
    // it at a rate that did not exist when it was issued.
    expect(currentPrice(db, "claude-opus-6", "2026-07-10T00:00:00Z")).toMatchObject({
      provisional: 1,
      usd_out: 25,
      effective_from: EPOCH_ZERO,
    });
    expect(vintages("claude-opus-6")).toHaveLength(2);
  });

  test("a request priced under the guess is NOT repriced by the upgrade (v_wcet vintage)", async () => {
    await sync(db, { ...offline, now: T0, models: ["claude-opus-6"] });
    request("old", "claude-opus-6", "2026-07-05T00:00:00Z", { out_tok: 1_000_000 });

    const before = priced("old")!;
    const wcetBefore = wcet("old")!;
    expect(before).toMatchObject({ usd_out: 25, provisional: 1 });
    expect(wcetBefore).toBeGreaterThan(0);

    await sync(db, { ...offline, now: T1, fixtureDir: publishOpus6(), source: "fixture" });
    request("new", "claude-opus-6", "2026-07-16T00:00:00Z", { out_tok: 1_000_000 });

    // Same request, same counters, after a real rate landed: the number it
    // contributed to every finalised estimate has not moved.
    expect(priced("old")).toEqual(before);
    expect(wcet("old")).toBe(wcetBefore);
    // The later request gets the published rate, and is no longer a guess.
    expect(priced("new")).toMatchObject({ usd_out: 30, provisional: 0 });
    expect(wcet("new")).toBeGreaterThan(wcetBefore);
  });

  test("an unchanged re-sync after the upgrade adds no further vintage", async () => {
    await sync(db, { ...offline, now: T0, models: ["claude-opus-6"] });
    const snapDir = publishOpus6();
    await sync(db, { ...offline, now: T1, fixtureDir: snapDir, source: "fixture" });
    const res = await sync(db, { ...offline, now: T2, fixtureDir: snapDir, source: "fixture" });
    expect(res.n_rows_written).toBe(0);
    expect(vintages("claude-opus-6")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("the anomaly ledger does not grow on re-sync", () => {
  const guessed = ["claude-opus-6", "gpt-6-turbo"];

  test("the same guess and the same unmatched id are logged ONCE, not once per epoch", async () => {
    await sync(db, { ...offline, now: T0, models: guessed });
    expect(anomalies("provisional_price")).toHaveLength(1);
    expect(anomalies("unpriced_model")).toHaveLength(1);

    // The weekly cron, twice. Nothing upstream changed, so nothing new is true —
    // and an epoch in the detail text used to make every run a fresh row, which
    // grew the ledger forever and buried the findings that WERE new.
    await sync(db, { ...offline, now: T1, models: guessed });
    await sync(db, { ...offline, now: T2, models: guessed });

    expect(syncRows()).toHaveLength(3);
    expect(anomalies("provisional_price")).toHaveLength(1);
    expect(anomalies("unpriced_model")).toHaveLength(1);
  });

  test("details are epoch-free, so (kind, detail) is a stable key", async () => {
    await sync(db, { ...offline, now: T0, models: guessed });
    for (const a of anomalies()) {
      expect(a.detail).not.toContain("epoch");
      expect(a.detail).not.toContain("2026-07-01");
    }
    // The epoch is not lost — it lives where it can be joined on.
    expect(syncRows()[0]!.price_epoch).toBe("2026-07-01T00:00:00Z");
    expect(
      db
        .query<{ synced_epoch: string }, [string]>(
          "SELECT synced_epoch FROM model_price WHERE family = ?",
        )
        .get("claude-opus-6")!.synced_epoch,
    ).toBe("2026-07-01T00:00:00Z");
  });

  test("a genuinely new finding still lands", async () => {
    await sync(db, { ...offline, now: T0, models: ["claude-opus-6"] });
    await sync(db, { ...offline, now: T1, models: ["claude-opus-6", "claude-opus-7"] });

    const flagged = anomalies("provisional_price");
    expect(flagged).toHaveLength(2);
    expect(flagged.some((a) => a.detail.startsWith("claude-opus-6 "))).toBe(true);
    expect(flagged.some((a) => a.detail.startsWith("claude-opus-7 "))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the join key — `model_price.family` IS `request.model_family`", () => {
  test("priceFamily and ingest.modelFamily are the same function", () => {
    // They were written twice and disagreed on the bracket suffix, which made a
    // bracketed family unpriceable BY CONSTRUCTION: v_priced is an INNER JOIN, so
    // 100% of its spend left every USD figure with no residue.
    for (const id of [
      "claude-opus-5[1m]",
      "claude-opus-5",
      "claude-opus-5-20260101[1m]",
      "claude-sonnet-4-5-20250929",
      "us.anthropic.claude-opus-5",
      "bedrock/anthropic.claude-haiku-4-5@20251001",
      "claude-sonnet-5[xhigh]",
    ]) {
      expect(modelFamily(id)).toBe(priceFamily(id));
    }
    // …and the suffix still discriminates, because it can price differently.
    expect(priceFamily("claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(priceFamily("claude-opus-5[1m]")).not.toBe(priceFamily("claude-opus-5"));
  });

  test("contextSuffixTokens reads a window and refuses an effort marker", () => {
    expect(contextSuffixTokens("1m")).toBe(1_000_000);
    expect(contextSuffixTokens("500k")).toBe(500_000);
    expect(contextSuffixTokens("200000")).toBe(200_000);
    expect(contextSuffixTokens("xhigh")).toBeNull();
    expect(contextSuffixTokens("")).toBeNull();
  });

  test("sync writes a row for an OBSERVED bracketed family, so it can be priced", async () => {
    // The sweeper has seen `claude-opus-5[1m]`; nothing upstream publishes that
    // id. Before the fix, `observedFamilies` was piped through normalizeModelId,
    // the target collapsed onto the already-present `claude-opus-5`, and no
    // `[1m]` row was ever written by any verb.
    db.query(
      `INSERT INTO request (request_id, session_id, origin, model, model_family, ts)
       VALUES ('r1', 's1', 'main', 'claude-opus-5[1m]', 'claude-opus-5[1m]', '2026-07-01T00:00:00Z')`,
    ).run();

    await sync(db, { ...offline, now: T0 });

    const row = currentPrice(db, "claude-opus-5[1m]");
    expect(row).not.toBeNull();
    // opus-5 publishes no >200k tier in the fixture, so the base rate is used and
    // the row is honestly marked provisional rather than passed off as exact.
    const base = currentPrice(db, "claude-opus-5")!;
    expect(row!.usd_out).toBe(base.usd_out);
    expect(row!.provisional).toBe(1);
    expect(anomalies("provisional_price").some((a) => a.detail.includes("claude-opus-5[1m]"))).toBe(
      true,
    );

    // The join the whole USD stack rests on now actually hits.
    const priced = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_priced WHERE request_id = 'r1'")
      .get()!;
    expect(priced.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_unpriced").get()!.n).toBe(0);
  });

  test("a long-context suffix takes the published >200k tier when there is one", async () => {
    db.query(
      `INSERT INTO request (request_id, session_id, origin, model, model_family, ts)
       VALUES ('r2', 's1', 'main', 'claude-sonnet-4-5[1m]', 'claude-sonnet-4-5[1m]', '2026-07-01T00:00:00Z')`,
    ).run();

    await sync(db, { ...offline, now: T0 });

    const hi = currentPrice(db, "claude-sonnet-4-5" + ABOVE_200K_SUFFIX)!;
    const row = currentPrice(db, "claude-sonnet-4-5[1m]")!;
    // The `@above_200k` companion rows finally feed the pricing path instead of
    // being written on every sync and read by nothing.
    expect(row.usd_in).toBe(hi.usd_in);
    expect(row.usd_out).toBe(hi.usd_out);
    // An exact published rate is authoritative — not a tier-peer guess.
    expect(row.provisional).toBe(0);
    expect(currentPrice(db, "claude-sonnet-4-5")!.usd_in).toBe(3); // base untouched
  });

  test("a non-context suffix prices at the base rate, exactly", async () => {
    db.query(
      `INSERT INTO request (request_id, session_id, origin, model, model_family, ts)
       VALUES ('r3', 's1', 'main', 'claude-sonnet-5[xhigh]', 'claude-sonnet-5[xhigh]', '2026-07-01T00:00:00Z')`,
    ).run();

    await sync(db, { ...offline, now: T0 });

    const row = currentPrice(db, "claude-sonnet-5[xhigh]")!;
    const base = currentPrice(db, "claude-sonnet-5")!;
    expect(row.usd_in).toBe(base.usd_in);
    expect(row.usd_out).toBe(base.usd_out);
    // Reasoning effort is not a rate change: nothing provisional about this one.
    expect(row.provisional).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("manual override — `est prices --set`", () => {
  const RATES = { usd_in: 1, usd_out: 2, usd_cw: 3, usd_cr: 4 };

  test("it lands on the key the sweeper looks up, and is authoritative", async () => {
    await sync(db, { ...offline, now: T0 });
    const set = setManualPrice(db, "claude-opus-5[1m]", RATES, { now: T1 });

    // The override lands on the key the sweeper actually looks up for a `[1m]`
    // request — suffix and all. Stripping it here wrote a row the INNER JOIN in
    // v_priced could never see, which is a silent no-op, not an override.
    expect(set.family).toBe("claude-opus-5[1m]");
    expect(currentPrice(db, "claude-opus-5[1m]")).toMatchObject({
      usd_in: 1,
      usd_out: 2,
      source: "manual",
      provisional: 0,
    });
    // …and the un-suffixed family is a DIFFERENT rate, left exactly as synced.
    expect(currentPrice(db, "claude-opus-5")!.usd_out).toBe(25);
    expect(currentPrice(db, "claude-opus-5", "2026-07-01T00:00:00Z")!.usd_out).toBe(25);
  });

  test("a family's FIRST manual rate covers all prior history, exactly like sync's first rate", async () => {
    // A family the sweeper saw and nothing upstream prices: tier 'zeta' has no
    // peer, so `--sync` writes NO row and every one of its requests is unpriced.
    request("z1", "claude-zeta-1", "2026-05-01T00:00:00Z");
    await sync(db, { ...offline, now: T0 });
    expect(priced("z1")).toBeNull();

    const set = setManualPrice(db, "claude-zeta-1", RATES, { now: T1 });
    expect(set).toMatchObject({
      family: "claude-zeta-1",
      effective_from: EPOCH_ZERO,
      price_epoch: "2026-07-15T00:00:00Z",
      backdated: true,
    });
    // The old corpus row is priced now — the entire point of backdating.
    expect(priced("z1")).toMatchObject({ usd_out: 2, provisional: 0 });
  });

  test("--at stamps the vintage, and reaches rows older than every row on file", async () => {
    request("old", "claude-zeta-1", "2026-05-01T00:00:00Z");
    request("new", "claude-zeta-1", "2026-06-15T00:00:00Z");

    // An explicit --at is honoured even for a family's first row: the human named
    // the vintage, and `--set` reports back which one it wrote.
    const june = setManualPrice(db, "claude-zeta-1", RATES, {
      at: new Date("2026-06-01T00:00:00Z"),
      now: T1,
    });
    expect(june.effective_from).toBe("2026-06-01T00:00:00Z");
    expect(priced("new")).toMatchObject({ usd_out: 2 });
    // `old` predates every vintage on file: this is `est backfill`'s "pre-epoch"
    // line, which advises exactly the command below — and used to be unfollowable,
    // because --set ignored --at and stamped now, landing AFTER the rows it
    // was meant to cover.
    expect(priced("old")).toBeNull();

    const back = setManualPrice(db, "claude-zeta-1", { ...RATES, usd_out: 7 }, {
      at: new Date("2026-01-01T00:00:00Z"),
      now: T2,
    });
    expect(back).toMatchObject({ effective_from: "2026-01-01T00:00:00Z", backdated: true });
    expect(priced("old")).toMatchObject({ usd_out: 7, provisional: 0 });
    // The later vintage still wins for the later row: a backdate is not a rewrite.
    expect(priced("new")).toMatchObject({ usd_out: 2 });
    expect(vintages("claude-zeta-1")).toHaveLength(2);
  });

  test("without --at, an override on a family that HAS history takes effect now", async () => {
    await sync(db, { ...offline, now: T0 });
    request("before", "claude-opus-5", "2026-07-10T00:00:00Z");
    request("after", "claude-opus-5", "2026-07-20T00:00:00Z");

    const set = setManualPrice(db, "claude-opus-5", RATES, { now: T1 });
    expect(set).toMatchObject({ effective_from: "2026-07-15T00:00:00Z", backdated: false });
    expect(priced("before")).toMatchObject({ usd_out: 25 }); // history untouched
    expect(priced("after")).toMatchObject({ usd_out: 2 });
  });

  test("two overrides in the same second do not collide on the price_sync PK", () => {
    setManualPrice(db, "claude-zeta-1", RATES, { now: T1 });
    const b = setManualPrice(db, "claude-zeta-2", RATES, { now: T1 });
    expect(b.price_epoch).not.toBe("2026-07-15T00:00:00Z");
    expect(syncRows()).toHaveLength(2);
  });

  test("the CLI reads --at for --set, not only for --show", async () => {
    const cliDb = join(dir, "cli.db");
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    const argv = (...rest: string[]) => [
      "prices",
      "--db",
      cliDb,
      "--lock",
      join(dir, "cli.lock"),
      ...rest,
    ];
    const rates = ["--in", "1", "--out", "2", "--cw", "3", "--cr", "4"];

    expect(await run(argv("--set", "claude-zeta-1", ...rates, "--at", "2026-01-01"), io)).toBe(0);
    expect(out.join("\n")).toContain("effective 2026-01-01T00:00:00Z");
    expect(out.join("\n")).toContain("backdated");

    const other = openDb({ path: cliDb });
    try {
      expect(currentPrice(other, "claude-zeta-1")!.effective_from).toBe("2026-01-01T00:00:00Z");
    } finally {
      other.close();
    }

    // An unparseable vintage is a usage error, not a string SQLite compares wrong.
    expect(await run(argv("--set", "claude-zeta-1", ...rates, "--at", "yesterday"), io)).toBe(1);
    expect(err.join("\n")).toContain("--at");
  });
});

// ---------------------------------------------------------------------------
// CACHE-TTL-PRICING.md D5 — resolveCw1h, the plausibility gate
// ---------------------------------------------------------------------------

describe("resolveCw1h — the D5 plausibility gate", () => {
  const BAND = { min: 1.5, max: 2.5, dflt: 2 };

  test("a plausible published candidate (exactly 2x usd_in) is accepted at face value", () => {
    const r = resolveCw1h(10, 5, 6.25, BAND, "litellm");
    expect(r).toEqual({ rate: 10, src: "litellm", implausible: false });
  });

  test("an implausible published candidate (the claude-3-haiku 24x case) is rejected and reported", () => {
    // usd_in=0.25, usd_cw=0.3: a candidate of 6 is 24x usd_in, way outside [1.5x,2.5x].
    const r = resolveCw1h(6, 0.25, 0.3, BAND, "litellm");
    expect(r).toEqual({ rate: 0.5, src: "derived_from_input", implausible: true }); // 2 * 0.25
  });

  test("an implausible candidate BELOW the family's own 5m rate is rejected too (the claude-3-opus case)", () => {
    // usd_cw (5m) = 18.75, candidate = 6 — below its own 5m rate, plainly wrong.
    const r = resolveCw1h(6, 15, 18.75, BAND, "litellm");
    expect(r.src).toBe("derived_from_input");
    expect(r.implausible).toBe(true);
  });

  test("an ABSENT key falls back the same way but is NOT reported implausible", () => {
    const r = resolveCw1h(null, 3, 3.75, BAND, "litellm");
    expect(r).toEqual({ rate: 6, src: "derived_from_input", implausible: false }); // 2 * 3
  });

  test("usd_cw = 0 (a pre-caching family) writes NOTHING, whatever the candidate says", () => {
    const r = resolveCw1h(999, 5, 0, BAND, "litellm");
    expect(r).toEqual({ rate: null, src: "unrecorded", implausible: false });
  });

  test("the gate is against the ROW'S OWN usd_in, not a fixed number", () => {
    const cheap = resolveCw1h(4, 2, 2.5, BAND, "litellm"); // 2x a small usd_in
    const rich = resolveCw1h(4, 100, 125, BAND, "litellm"); // same absolute candidate, huge usd_in
    expect(cheap.implausible).toBe(false);
    expect(rich.implausible).toBe(true); // 4 is nowhere near 1.5-2.5x of 100
  });
});

// ---------------------------------------------------------------------------
// CACHE-TTL-PRICING.md D2/D5 — sync() writes the gated 1h rate
// ---------------------------------------------------------------------------

describe("sync — the cache-write 1h rate (D2/D5)", () => {
  test("the committed fixture's published 1h rate is accepted at face value for a plausible family", async () => {
    await sync(db, { ...offline, now: T0 });
    const opus = currentPrice(db, "claude-opus-5")!;
    // Fixture: cache_creation_input_token_cost_above_1hr = 0.00001/token = 10/Mtok,
    // exactly 2x usd_in(5) — inside [1.5x, 2.5x] of usd_in(5).
    expect(opus.usd_cw1h).toBe(10);
    expect(opus.usd_cw1h_src).toBe("litellm");
  });

  test("an implausible published rate is rejected, falls back to derived_from_input, and raises price_cw_1h_implausible exactly once", async () => {
    const liveTable = {
      "claude-3-haiku-20240307": {
        input_cost_per_token: 2.5e-7,
        output_cost_per_token: 1.25e-6,
        cache_creation_input_token_cost: 3e-7,
        cache_creation_input_token_cost_above_1hr: 6e-6, // 24x usd_in — the real upstream bug
        cache_read_input_token_cost: 3e-8,
      },
    };
    const liveFetch = ((url: string) =>
      Promise.resolve(
        url === LITELLM_URL
          ? new Response(JSON.stringify(liveTable), { status: 200 })
          : new Response("{}", { status: 404, statusText: "Not Found" }),
      )) as unknown as typeof fetch;

    await sync(db, { fetchImpl: liveFetch, now: T0 });
    const haiku = currentPrice(db, "claude-3-haiku")!;
    expect(haiku.usd_cw1h_src).toBe("derived_from_input");
    expect(haiku.usd_cw1h).toBe(2 * haiku.usd_in); // config.price_cw_1h_default_multiple

    const implausible = anomalies("price_cw_1h_implausible");
    expect(implausible).toHaveLength(1);
    expect(implausible[0]!.detail).toContain("claude-3-haiku");

    // A second, unchanged sync must not re-raise the same finding.
    await sync(db, { fetchImpl: liveFetch, now: T1 });
    expect(anomalies("price_cw_1h_implausible")).toHaveLength(1);
  });

  test("a family with NO published 1h key falls back to derived_from_input and raises NO anomaly", async () => {
    const liveTable = {
      "claude-4-opus-20250514": {
        input_cost_per_token: 1.5e-5,
        output_cost_per_token: 7.5e-5,
        cache_creation_input_token_cost: 1.875e-5,
        cache_read_input_token_cost: 1.5e-6,
        // no cache_creation_input_token_cost_above_1hr key at all
      },
    };
    const liveFetch = ((url: string) =>
      Promise.resolve(
        url === LITELLM_URL
          ? new Response(JSON.stringify(liveTable), { status: 200 })
          : new Response("{}", { status: 404, statusText: "Not Found" }),
      )) as unknown as typeof fetch;

    await sync(db, { fetchImpl: liveFetch, now: T0 });
    const row = currentPrice(db, "claude-4-opus")!;
    expect(row.usd_cw1h_src).toBe("derived_from_input");
    expect(row.usd_cw1h).toBe(2 * row.usd_in);
    expect(anomalies("price_cw_1h_implausible")).toHaveLength(0);

    // Twice over, per the design's explicit test requirement.
    await sync(db, { fetchImpl: liveFetch, now: T1 });
    expect(anomalies("price_cw_1h_implausible")).toHaveLength(0);
  });

  test("a family with usd_cw = 0 (pre-caching) stays usd_cw1h NULL / 'unrecorded'", async () => {
    const liveTable = {
      "claude-instant-1": {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
        // no cache cost keys at all -> usd_cw resolves to 0
      },
    };
    const liveFetch = ((url: string) =>
      Promise.resolve(
        url === LITELLM_URL
          ? new Response(JSON.stringify(liveTable), { status: 200 })
          : new Response("{}", { status: 404, statusText: "Not Found" }),
      )) as unknown as typeof fetch;

    await sync(db, { fetchImpl: liveFetch, now: T0 });
    const row = currentPrice(db, "claude-instant-1")!;
    expect(row.usd_cw).toBe(0);
    expect(row.usd_cw1h).toBeNull();
    expect(row.usd_cw1h_src).toBe("unrecorded");
  });

  test("ratesEqual compares usd_cw1h too: a re-sync that changes ONLY the 1h rate opens a new vintage", async () => {
    await sync(db, { ...offline, now: T0 });
    const before = currentPrice(db, "claude-opus-5")!;

    const liveTable = {
      "claude-opus-5": {
        input_cost_per_token: 5e-6, // unchanged
        output_cost_per_token: 2.5e-5, // unchanged
        cache_creation_input_token_cost: 6.25e-6, // unchanged
        cache_creation_input_token_cost_above_1hr: 1.1e-5, // CHANGED: 11/Mtok now
        cache_read_input_token_cost: 5e-7, // unchanged
      },
    };
    const liveFetch = ((url: string) =>
      Promise.resolve(
        url === LITELLM_URL
          ? new Response(JSON.stringify(liveTable), { status: 200 })
          : new Response("{}", { status: 404, statusText: "Not Found" }),
      )) as unknown as typeof fetch;

    await sync(db, { fetchImpl: liveFetch, now: T1 });
    const after = currentPrice(db, "claude-opus-5")!;
    expect(after.usd_cw1h).toBe(11);
    expect(after.effective_from).not.toBe(before.effective_from);
    expect(vintages("claude-opus-5").length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// CACHE-TTL-PRICING.md D6 — est prices --fill-cw-1h
// ---------------------------------------------------------------------------

describe("fillCw1h — the one-shot historical fill (D6)", () => {
  test("fills every usd_cw1h IS NULL vintage from the source chain, and is idempotent on a second run", async () => {
    // A manual, unpriced-1h vintage, exactly the "48 days of pre-fix history" shape.
    setManualPrice(db, "claude-opus-5", { usd_in: 5, usd_out: 25, usd_cw: 6.25, usd_cr: 0.5 }, {
      at: EPOCH_ZERO === "1970-01-01T00:00:00Z" ? new Date(0) : undefined,
      now: T0,
    });
    expect(currentPrice(db, "claude-opus-5")!.usd_cw1h).toBeNull();

    const first = await fillCw1h(db, { ...offline, now: T1 });
    expect(first.n_filled).toBe(1);
    const filled = currentPrice(db, "claude-opus-5")!;
    // The committed LiteLLM fixture publishes a plausible 2x rate for this family.
    expect(filled.usd_cw1h).toBe(10);
    expect(filled.usd_cw1h_src).toBe("litellm");
    // Every OTHER column is untouched.
    expect(filled.usd_in).toBe(5);
    expect(filled.usd_out).toBe(25);
    expect(filled.usd_cw).toBe(6.25);
    expect(filled.provisional).toBe(0);
    expect(filled.source).toBe("manual");

    const stampAfterFirst = db
      .query<{ v: string }, []>("SELECT v FROM config WHERE k = 'cw_ttl_price_fix_at'")
      .get()!.v;

    const second = await fillCw1h(db, { ...offline, now: T2 });
    expect(second.n_filled).toBe(0); // nothing left to fill — no recorded rate overwritten
    expect(currentPrice(db, "claude-opus-5")!.usd_cw1h).toBe(10); // unchanged
    // Both a price_sync row AND the watermark advance on EVERY call, including a no-op.
    expect(syncRows().filter((r) => r.source === "manual").length).toBeGreaterThanOrEqual(2);
    const stampAfterSecond = db
      .query<{ v: string }, []>("SELECT v FROM config WHERE k = 'cw_ttl_price_fix_at'")
      .get()!.v;
    expect(stampAfterSecond).not.toBe(stampAfterFirst);
  });

  test("one anomaly(cw_1h_price_backfilled) is recorded per run — a ts-keyed audit trail, not deduped", async () => {
    setManualPrice(db, "claude-opus-5", { usd_in: 5, usd_out: 25, usd_cw: 6.25, usd_cr: 0.5 }, { now: T0 });
    await fillCw1h(db, { ...offline, now: T1 });
    await fillCw1h(db, { ...offline, now: T2 });
    expect(anomalies("cw_1h_price_backfilled").length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// CACHE-TTL-PRICING.md D5 — `est prices --set` and `--cw-1h`
// ---------------------------------------------------------------------------

describe("est prices --set --cw-1h (D5)", () => {
  const cliRun = async (cliDb: string, ...rest: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["prices", "--db", cliDb, "--lock", `${cliDb}.lock`, ...rest],
      { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  test("--set without --cw-1h on a family whose latest vintage HAS a recorded 1h rate is refused", async () => {
    const cliDb = join(dir, "cli2.db");
    const r1 = await cliRun(cliDb, "--sync", "--source", "fixture"); // seeds claude-opus-5 with a recorded 1h rate
    expect(r1.code).toBe(0);

    const rates = ["--in", "1", "--out", "2", "--cw", "3", "--cr", "0.5"];
    const r2 = await cliRun(cliDb, "--set", "claude-opus-5", ...rates);
    expect(r2.code).toBe(1);
    expect(r2.err).toContain("--cw-1h");
  });

  test("--cw-1h-unrecorded is the explicit escape hatch, and the vintage shows up in v_cw_1h_price_gap", async () => {
    const cliDb = join(dir, "cli3.db");
    await cliRun(cliDb, "--sync", "--source", "fixture");
    const rates = ["--in", "1", "--out", "2", "--cw", "3", "--cr", "0.5"];
    const r = await cliRun(cliDb, "--set", "claude-opus-5", ...rates, "--cw-1h-unrecorded");
    expect(r.code).toBe(0);

    const other = openDb({ path: cliDb });
    try {
      expect(currentPrice(other, "claude-opus-5")!.usd_cw1h).toBeNull();
      other
        .query(
          `INSERT INTO request (request_id, session_id, origin, model, model_family, ts, cw_tok)
           VALUES ('g1', 's1', 'main', 'claude-opus-5', 'claude-opus-5', '2026-08-01T00:00:00Z', 10)`,
        )
        .run();
      const gap = other
        .query<{ family: string }, []>("SELECT family FROM v_cw_1h_price_gap WHERE family = 'claude-opus-5'")
        .all();
      expect(gap).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  test("on a family with NO prior recorded rate, --cw-1h stays optional", async () => {
    const cliDb = join(dir, "cli4.db");
    const rates = ["--in", "1", "--out", "2", "--cw", "3", "--cr", "0.5"];
    const r = await cliRun(cliDb, "--set", "claude-zeta-9", ...rates);
    expect(r.code).toBe(0);
    const other = openDb({ path: cliDb });
    try {
      expect(currentPrice(other, "claude-zeta-9")!.usd_cw1h).toBeNull();
      expect(currentPrice(other, "claude-zeta-9")!.usd_cw1h_src).toBe("unrecorded");
    } finally {
      other.close();
    }
  });
});

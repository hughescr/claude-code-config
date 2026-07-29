/**
 * Price sync — token-estimation-design-r3.md §4.3 (price lifecycle) and §4.4
 * (price-epoch enforcement).
 *
 * Source of truth is LiteLLM's upstream table — ccusage's OWN upstream, so price
 * agreement with ccusage comes for free rather than being reverse-engineered:
 *
 *   https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 *
 * `models.dev/api.json` is the SECONDARY source, consulted only for families
 * LiteLLM does not carry. The DB is the local snapshot/cache: ccusage 20.x is a
 * Rust binary embedding a compact snapshot and keeps no on-disk cache to read.
 *
 * Fallback chain, in order (§4.3):
 *   live fetch -> last good snapshot (already in `model_price`; a no-op)
 *              -> newest local snapshot fixture
 *              -> tier-peer provisional pricing (`provisional=1`)
 *
 * Two invariants this file exists to uphold:
 *   - NOTHING BLOCKS ON THE NETWORK. A failed fetch writes `price_sync(ok=0)`
 *     and changes nothing else; the previous snapshot stays in force.
 *   - NEVER A SILENT ZERO. A model id that cannot be resolved to a real rate
 *     produces an `anomaly` row and NO `model_price` row, so `v_unpriced`
 *     counts it and `v_velocity` excludes the task. It is never priced at 0.
 *
 * Zero npm dependencies: bun:sqlite + node:fs only.
 */

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./db.ts";

/** Primary upstream — the table ccusage itself prices from. */
export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Secondary upstream, consulted only for families LiteLLM lacks. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** Where committed snapshot fixtures live. */
export const FIXTURE_DIR: string = join(ROOT, "test", "fixtures");

/**
 * `effective_from` for a family's FIRST observed rate.
 *
 * `v_priced` resolves a request's price with `MAX(effective_from) <= r.ts`, so a
 * first row stamped with the sync's own epoch would leave the entire backfilled
 * corpus unpriced — every request predates the first sync. The first observation
 * of a rate is therefore backdated to cover all prior history; only genuine rate
 * CHANGES are stamped with the sync epoch, which is what §4.4's cross-epoch
 * accounting actually cares about.
 */
export const EPOCH_ZERO = "1970-01-01T00:00:00Z";

/**
 * Companion-family suffix for the above-200k-context rate tier.
 *
 * `model_price`'s PK is `(family, effective_from)` — there is no context-tier
 * column — so the long-context rates are persisted as a sibling family rather
 * than dropped. The rows are purely additive and cannot make `v_unpriced` lie.
 *
 * THE READER IS SQL, AND IT IS THE ONLY ONE. `v_request_tiered` picks
 * `family || '@above_200k'` per REQUEST from that request's own prompt counters
 * at that request's own vintage, and `v_task_actual_epoch` repeats the choice at
 * the estimate's `price_epoch`. The premium is a property of how big THIS call's
 * prompt was, not of the model id, so a TypeScript helper taking a family and a
 * token count could only ever be a second, drifting definition of the same rule —
 * there was one (`familyForContext`), nothing on the pricing path ever called it,
 * and it had already drifted (it ignored vintage entirely).
 *
 * The literals in those views are a CONTRACT with this constant and
 * {@link LONG_CONTEXT_THRESHOLD}; SQL cannot import them, so test/schema.test.ts
 * asserts the two sides still agree.
 */
export const ABOVE_200K_SUFFIX = "@above_200k";

/**
 * The context length above which the long-context tier applies. Mirrored as the
 * literal `200000` in `v_request_tiered` / `v_task_actual_epoch` — see
 * {@link ABOVE_200K_SUFFIX}.
 */
export const LONG_CONTEXT_THRESHOLD = 200_000;

/**
 * Model ids that are not API models and must not raise `unpriced_model`.
 * `<synthetic>` is Claude Code's marker for locally generated assistant
 * messages: they carry no usage block and never reach the API.
 */
const NON_API_MODELS = new Set(["", "<synthetic>", "synthetic", "unknown"]);

const DEFAULT_TIMEOUT_MS = 10_000;

/** Numeric segments this wide are dates (20250929), not generations. */
const DATE_DIGITS = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `model_price.source` — the R3 vocabulary. */
export type PriceSourceName = "litellm" | "models_dev" | "manual" | "otel";

/** USD per MILLION tokens, matching `model_price`'s stated unit. */
export interface Rates {
  usd_in: number;
  usd_out: number;
  usd_cw: number;
  usd_cr: number;
}

export interface NormalizedModel {
  /** The id exactly as the transcript recorded it. */
  raw: string;
  /** Vendor prefix, bracket suffix, bedrock version and trailing date removed. */
  family: string;
  /** Non-numeric name tokens, e.g. `opus`, `sonnet`, `fable`. `''` if none. */
  tier: string;
  /** Numeric name segments, e.g. `claude-opus-4-5` -> `[4, 5]`. */
  generation: number[];
  /** Contents of a trailing `[...]`, e.g. `1m` from `claude-opus-5[1m]`. */
  contextSuffix: string | null;
}

export interface ResolvedFamily {
  family: string;
  tier: string;
  generation: number[];
  rates: Rates;
  /** Long-context tier when upstream publishes one. */
  above200k: Rates | null;
  source: PriceSourceName;
  /** True when priced from a same-tier sibling rather than a published rate. */
  provisional: boolean;
  /** The sibling a provisional rate was copied from. */
  peer?: string;
}

/** One leg of the fallback chain, recorded so `est prices --sync` can explain itself. */
export interface SyncAttempt {
  leg: "live-litellm" | "live-models-dev" | "fixture-litellm" | "fixture-models-dev";
  url: string;
  ok: boolean;
  /** Families the leg yielded. */
  n: number;
  error?: string;
}

export interface SyncOptions {
  /** Force one leg instead of walking the chain. Default `"auto"`. */
  source?: "auto" | "live" | "fixture";
  /** Extra ids to resolve beyond those already present in `request`. */
  models?: string[];
  /** Injected clock — the sync epoch. */
  now?: Date;
  /** Injected fetch, for testing the live leg without a network. */
  fetchImpl?: typeof fetch;
  /** Snapshot directory. Default {@link FIXTURE_DIR}. */
  fixtureDir?: string;
  timeoutMs?: number;
}

export interface SyncResult {
  /** The `price_sync.price_epoch` this run wrote. */
  price_epoch: string;
  source: PriceSourceName;
  url: string | null;
  ok: boolean;
  /** Families this sync established a rate for. */
  n_families: number;
  /** How many of those are tier-peer provisional. */
  n_provisional: number;
  /** Ids that resolved to nothing and raised `anomaly(unpriced_model)`. */
  unmatched: string[];
  /** `model_price` rows actually written (unchanged rates are not rewritten). */
  n_rows_written: number;
  attempts: SyncAttempt[];
}

// ---------------------------------------------------------------------------
// Model-id normalisation
// ---------------------------------------------------------------------------

/**
 * `2026-07-28T17:23:45Z` — the format schema.sql's own `strftime` seeds use.
 *
 * Exported because every `effective_from <= ?` comparison in the schema is a
 * LEXICAL string compare: an instant that reaches the DB in any other shape
 * (`2026-07-01`, or with milliseconds) sorts against the stored rows wrongly and
 * silently selects the wrong price row. The CLI normalises `--at` through this
 * same function rather than growing a second, nearly-identical formatter.
 */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * `price_sync.price_epoch` is the PK at one-second resolution, and two syncs can
 * legitimately land in the same second (the weekly cron plus the `v_unpriced`
 * trigger). Walk forward to the next free second rather than throwing.
 */
function uniqueEpoch(db: Database, start: string): string {
  const taken = db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM price_sync WHERE price_epoch = ?",
  );
  let epoch = start;
  let t = Date.parse(start);
  while (taken.get(epoch)!.n > 0) {
    t += 1000;
    epoch = isoSeconds(new Date(t));
  }
  return epoch;
}

/**
 * Reduce any observed model id to the `model_price.family` key.
 *
 * Handles, in order: a trailing `[...]` effort/context suffix (Claude Code's
 * `claude-opus-5[1m]`), a routing prefix (`bedrock/`, `us.anthropic.`,
 * `global.anthropic.`), a bedrock version tail (`-v1:0`, `@20251001`), and the
 * trailing `-YYYYMMDD` date the schema requires be stripped at ingest.
 */
export function normalizeModelId(raw: string): NormalizedModel {
  let s = raw.trim();

  // 1. Trailing bracket suffix: claude-opus-5[1m] -> claude-opus-5, "1m".
  let contextSuffix: string | null = null;
  const bracket = s.match(/\[([^\]]*)\]\s*$/);
  if (bracket) {
    contextSuffix = bracket[1]!.toLowerCase() || null;
    s = s.slice(0, bracket.index).trim();
  }

  s = s.toLowerCase();

  // 2. Routing prefixes: openrouter/anthropic/…, bedrock/…, us.anthropic.…
  const lastSlash = s.lastIndexOf("/");
  if (lastSlash >= 0) s = s.slice(lastSlash + 1);
  s = s.replace(/^(us|eu|au|jp|apac|global|ca|sa)\./, "");
  s = s.replace(/^anthropic\./, "");

  // 3. Bedrock/Vertex version tails: -v1:0, :0, @20251001.
  s = s.replace(/-v\d+(?::\d+)?$/, "");
  s = s.replace(/:\d+$/, "");
  s = s.replace(/@(\d{8})$/, "-$1");

  // 4. Trailing release date — schema.sql: "trailing -YYYYMMDD stripped at ingest".
  s = s.replace(/-\d{8}$/, "");

  const family = s;

  // Tier is every non-numeric token that is not the literal "claude"; the
  // generation is every short numeric token. Deriving both from the name rather
  // than a hardcoded tier list means a brand-new tier upstream still matches its
  // own siblings without a code change.
  const segments = family.split("-").filter((t) => t.length > 0);
  const tierTokens: string[] = [];
  const generation: number[] = [];
  for (const seg of segments) {
    if (seg === "claude") continue;
    if (/^\d+$/.test(seg)) {
      if (seg.length < DATE_DIGITS) generation.push(Number(seg));
      continue;
    }
    tierTokens.push(seg);
  }

  return { raw, family, tier: tierTokens.join("-"), generation, contextSuffix };
}

/**
 * THE `model_price.family` / `request.model_family` key — one definition, used by
 * both sides of the join.
 *
 * `v_priced` is an INNER JOIN on `model_price.family = request.model_family`, so
 * the ingest normaliser and the price normaliser agreeing is not a nicety: any
 * disagreement drops 100% of that family's spend out of every USD figure, and
 * silently, because an INNER JOIN has no residue. They used to disagree on the
 * bracket suffix — ingest kept `claude-opus-5[1m]`, prices reduced it to
 * `claude-opus-5` — which made a bracketed family unpriceable by construction and
 * unfixable by `est prices --sync`. `ingest.modelFamily()` now delegates here.
 *
 * The suffix is KEPT (§4.3): `claude-opus-5[1m]` is the 1M-context invocation and
 * can price differently from the same model at 200k. `sync()` resolves it against
 * the base family's long-context tier — see the `contextSuffix` branch there.
 */
export function priceFamily(raw: string): string {
  const n = normalizeModelId(raw);
  return n.contextSuffix === null ? n.family : `${n.family}[${n.contextSuffix}]`;
}

/**
 * A bracket suffix's context window in tokens, or null when it names something
 * else (`[xhigh]` is a reasoning-effort marker, not a window). `1m` -> 1e6.
 */
export function contextSuffixTokens(suffix: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(suffix.trim().toLowerCase());
  if (m === null) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const scale = m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1;
  return Math.round(n * scale);
}

/** Order two generation vectors: `[5] > [4,8] > [4,5] > [4] > []`. */
export function compareGeneration(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Upstream parsers
// ---------------------------------------------------------------------------

function perMtok(perToken: number): number {
  // Kill binary-float dust: 3e-6 * 1e6 is not exactly 3 in IEEE 754.
  return Math.round(perToken * 1e6 * 1e9) / 1e9;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

type RawTable = Record<string, unknown>;

/**
 * LiteLLM's map: keys are model ids, costs are PER TOKEN.
 *
 * Only `claude*` keys are read — the file carries ~3000 models across every
 * provider and none of the rest can ever appear in a Claude Code transcript.
 *
 * Missing cache costs are stored as 0 rather than raising: pre-caching models
 * (claude-instant, claude-v1) genuinely cannot emit cache tokens, so 0 is the
 * true rate, not an unknown one. An UNKNOWN rate is the case where the whole
 * family is absent, and that path writes no row at all.
 */
export function parseLiteLLM(table: RawTable): Map<string, ResolvedFamily> {
  const out = new Map<string, ResolvedFamily>();
  for (const [id, value] of Object.entries(table)) {
    if (!id.startsWith("claude")) continue;
    if (typeof value !== "object" || value === null) continue;
    const e = value as Record<string, unknown>;

    const inTok = finite(e.input_cost_per_token);
    const outTok = finite(e.output_cost_per_token);
    if (inTok === null || outTok === null) continue;

    const norm = normalizeModelId(id);
    const rates: Rates = {
      usd_in: perMtok(inTok),
      usd_out: perMtok(outTok),
      usd_cw: perMtok(finite(e.cache_creation_input_token_cost) ?? 0),
      usd_cr: perMtok(finite(e.cache_read_input_token_cost) ?? 0),
    };

    const inHi = finite(e.input_cost_per_token_above_200k_tokens);
    const outHi = finite(e.output_cost_per_token_above_200k_tokens);
    const above200k: Rates | null =
      inHi !== null && outHi !== null
        ? {
            usd_in: perMtok(inHi),
            usd_out: perMtok(outHi),
            usd_cw: perMtok(
              finite(e.cache_creation_input_token_cost_above_200k_tokens) ?? rates.usd_cw,
            ),
            usd_cr: perMtok(
              finite(e.cache_read_input_token_cost_above_200k_tokens) ?? rates.usd_cr,
            ),
          }
        : null;

    // Dated and undated aliases collapse to one family (schema §4.2). Prefer the
    // entry that carries a long-context tier, then the one with more detail.
    const prior = out.get(norm.family);
    if (prior && !(above200k && !prior.above200k)) continue;

    out.set(norm.family, {
      family: norm.family,
      tier: norm.tier,
      generation: norm.generation,
      rates,
      above200k,
      source: "litellm",
      provisional: false,
    });
  }
  return out;
}

/**
 * models.dev's shape: `providers.anthropic.models[id].cost`, already PER MILLION
 * tokens. Secondary source — only consulted for families LiteLLM lacks.
 */
export function parseModelsDev(doc: RawTable): Map<string, ResolvedFamily> {
  const out = new Map<string, ResolvedFamily>();
  const providers = (doc.providers as RawTable | undefined) ?? doc;
  const anthropic = providers?.anthropic as Record<string, unknown> | undefined;
  const models = anthropic?.models as RawTable | undefined;
  if (!models) return out;

  for (const [id, value] of Object.entries(models)) {
    if (typeof value !== "object" || value === null) continue;
    const cost = (value as Record<string, unknown>).cost as Record<string, unknown> | undefined;
    if (!cost) continue;
    const inM = finite(cost.input);
    const outM = finite(cost.output);
    if (inM === null || outM === null) continue;

    const norm = normalizeModelId(id);
    out.set(norm.family, {
      family: norm.family,
      tier: norm.tier,
      generation: norm.generation,
      rates: {
        usd_in: inM,
        usd_out: outM,
        usd_cw: finite(cost.cache_write) ?? 0,
        usd_cr: finite(cost.cache_read) ?? 0,
      },
      above200k: null,
      source: "models_dev",
      provisional: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source chain
// ---------------------------------------------------------------------------

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<RawTable> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return (await res.json()) as RawTable;
}

/** Newest snapshot in `dir` whose name matches `prefix`, by mtime. */
export function newestSnapshot(dir: string, prefix: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .map((n) => join(dir, n))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.p ?? null;
}

function readSnapshot(path: string): RawTable {
  return JSON.parse(readFileSync(path, "utf8")) as RawTable;
}

interface ChainResult {
  primary: Map<string, ResolvedFamily>;
  secondary: Map<string, ResolvedFamily>;
  source: PriceSourceName;
  url: string | null;
  attempts: SyncAttempt[];
}

async function walkChain(opts: SyncOptions): Promise<ChainResult> {
  const mode = opts.source ?? "auto";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fixtureDir = opts.fixtureDir ?? FIXTURE_DIR;
  const attempts: SyncAttempt[] = [];

  let primary = new Map<string, ResolvedFamily>();
  let secondary = new Map<string, ResolvedFamily>();
  let source: PriceSourceName = "litellm";
  let url: string | null = null;

  // Leg 1 — live LiteLLM. Expected to fail inside a network sandbox; that is a
  // normal outcome, recorded and walked past, never thrown.
  if (mode === "auto" || mode === "live") {
    try {
      primary = parseLiteLLM(await fetchJson(LITELLM_URL, fetchImpl, timeoutMs));
      url = LITELLM_URL;
      attempts.push({ leg: "live-litellm", url: LITELLM_URL, ok: true, n: primary.size });
    } catch (err) {
      attempts.push({
        leg: "live-litellm",
        url: LITELLM_URL,
        ok: false,
        n: 0,
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  // Leg 2 — live models.dev, the secondary fill.
  if ((mode === "auto" || mode === "live") && primary.size > 0) {
    try {
      secondary = parseModelsDev(await fetchJson(MODELS_DEV_URL, fetchImpl, timeoutMs));
      attempts.push({
        leg: "live-models-dev",
        url: MODELS_DEV_URL,
        ok: true,
        n: secondary.size,
      });
    } catch (err) {
      attempts.push({
        leg: "live-models-dev",
        url: MODELS_DEV_URL,
        ok: false,
        n: 0,
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  // Leg 3 — newest local snapshot, for both sources.
  if (primary.size === 0 && (mode === "auto" || mode === "fixture")) {
    const path = newestSnapshot(fixtureDir, "litellm-snapshot");
    if (path) {
      try {
        primary = parseLiteLLM(readSnapshot(path));
        url = path;
        attempts.push({ leg: "fixture-litellm", url: path, ok: true, n: primary.size });
      } catch (err) {
        attempts.push({
          leg: "fixture-litellm",
          url: path,
          ok: false,
          n: 0,
          error: String((err as Error)?.message ?? err),
        });
      }
    } else {
      attempts.push({ leg: "fixture-litellm", url: fixtureDir, ok: false, n: 0, error: "no snapshot" });
    }
  }

  // `source: "live"` means live: a forced-live sync must never quietly read a
  // snapshot, or "the network is down" becomes indistinguishable from success.
  if (secondary.size === 0 && mode !== "live") {
    const path = newestSnapshot(fixtureDir, "modelsdev-snapshot");
    if (path) {
      try {
        secondary = parseModelsDev(readSnapshot(path));
        attempts.push({ leg: "fixture-models-dev", url: path, ok: true, n: secondary.size });
      } catch (err) {
        attempts.push({
          leg: "fixture-models-dev",
          url: path,
          ok: false,
          n: 0,
          error: String((err as Error)?.message ?? err),
        });
      }
    }
  }

  if (primary.size === 0 && secondary.size > 0) {
    source = "models_dev";
    url = attempts.find((a) => a.leg.endsWith("models-dev") && a.ok)?.url ?? null;
  }

  return { primary, secondary, source, url, attempts };
}

// ---------------------------------------------------------------------------
// Tier-peer provisional pricing
// ---------------------------------------------------------------------------

/**
 * Price an unknown family from its newest same-tier sibling (§4.3, last leg of
 * the fallback chain). `claude-opus-6` prices like `claude-opus-5`; a bare
 * `opus` alias prices like the newest opus.
 *
 * Returns null when no sibling shares the tier — the caller must then raise
 * `anomaly(unpriced_model)` and write NO row, because a wrong tier is a wrong
 * number and a wrong number is worse than a missing one.
 */
export function tierPeer(
  target: NormalizedModel,
  pool: Iterable<ResolvedFamily>,
): ResolvedFamily | null {
  if (!target.tier) return null;
  let best: ResolvedFamily | null = null;
  for (const cand of pool) {
    if (cand.provisional) continue;
    if (cand.tier !== target.tier) continue;
    if (cand.family === target.family) continue;
    if (best === null || compareGeneration(cand.generation, best.generation) > 0) best = cand;
  }
  return best;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface PriceRow {
  family: string;
  effective_from: string;
  usd_in: number;
  usd_out: number;
  usd_cw: number;
  usd_cr: number;
  provisional: number;
  source: string;
}

/** The rate in force for `family` at `at` (default: latest). */
export function currentPrice(db: Database, family: string, at?: string): PriceRow | null {
  const sql = at
    ? `SELECT family, effective_from, usd_in, usd_out, usd_cw, usd_cr, provisional, source
         FROM model_price WHERE family = ? AND effective_from <= ?
        ORDER BY effective_from DESC LIMIT 1`
    : `SELECT family, effective_from, usd_in, usd_out, usd_cw, usd_cr, provisional, source
         FROM model_price WHERE family = ?
        ORDER BY effective_from DESC LIMIT 1`;
  const q = db.query<PriceRow, string[]>(sql);
  return (at ? q.get(family, at) : q.get(family)) ?? null;
}

function ratesEqual(a: Rates, b: PriceRow): boolean {
  return (
    a.usd_in === b.usd_in &&
    a.usd_out === b.usd_out &&
    a.usd_cw === b.usd_cw &&
    a.usd_cr === b.usd_cr
  );
}

/** The two `anomaly.kind`s this file writes — the dedup scope, and nothing else's. */
const PRICE_ANOMALY_KINDS = ["provisional_price", "unpriced_model"] as const;

interface AnomalyRow {
  kind: (typeof PRICE_ANOMALY_KINDS)[number];
  detail: string;
}

/**
 * Append anomalies, skipping `(kind, detail)` pairs already in the ledger.
 *
 * `anomaly` has no natural key, so an unguarded INSERT re-logs the same finding
 * on every run. The weekly price cron re-derives exactly the same guesses every
 * week: a family upstream never publishes would otherwise add a row a week
 * forever, and the ledger `est census` prints would drown the anomalies that are
 * genuinely new. The DETAILS this file writes are deliberately epoch-free so
 * this guard can actually collapse them — see the call site in `sync`.
 *
 * Batch-first, like `cli.ts:insertAnomalies`: ONE select of the existing keys for
 * the kinds written here, then a filtered insert loop — never a `WHERE NOT
 * EXISTS` per row, which is a table scan per anomaly.
 */
function recordAnomalies(db: Database, ts: string, rows: readonly AnomalyRow[]): void {
  if (rows.length === 0) return;

  const seen = new Set<string>();
  const placeholders = PRICE_ANOMALY_KINDS.map(() => "?").join(",");
  for (const r of db
    .query<{ kind: string; detail: string }, string[]>(
      `SELECT kind, detail FROM anomaly WHERE tid IS NULL AND kind IN (${placeholders})`,
    )
    .all(...PRICE_ANOMALY_KINDS)) {
    seen.add(`${r.kind} ${r.detail}`);
  }

  const stmt = db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES (?,?,?,NULL)");
  for (const a of rows) {
    const key = `${a.kind} ${a.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stmt.run(ts, a.kind, a.detail);
  }
}

/** Existing authoritative families, so a provisional can be derived offline. */
function poolFromDb(db: Database): ResolvedFamily[] {
  const rows = db
    .query<{ family: string; usd_in: number; usd_out: number; usd_cw: number; usd_cr: number }, []>(
      `SELECT family, usd_in, usd_out, usd_cw, usd_cr FROM model_price p
        WHERE provisional = 0
          AND effective_from = (SELECT MAX(effective_from) FROM model_price
                                 WHERE family = p.family)`,
    )
    .all();
  return rows.map((r) => {
    const norm = normalizeModelId(r.family);
    return {
      family: r.family,
      tier: norm.tier,
      generation: norm.generation,
      rates: { usd_in: r.usd_in, usd_out: r.usd_out, usd_cw: r.usd_cw, usd_cr: r.usd_cr },
      above200k: null,
      source: "litellm" as PriceSourceName,
      provisional: false,
    };
  });
}

/** Distinct model families the sweeper has already recorded. */
function observedFamilies(db: Database): string[] {
  return db
    .query<{ model_family: string }, []>("SELECT DISTINCT model_family FROM request")
    .all()
    .map((r) => r.model_family);
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

/**
 * Refresh prices and open a new price epoch.
 *
 * Writes exactly one `price_sync` row per call. `model_price` rows are written
 * only when a family is new or its rate actually CHANGED — an unchanged re-sync
 * adds no history, so an `effective_from` in the table always means "the price
 * moved here", which is what §4.4's cross-epoch reporting reads.
 */
export async function sync(db: Database, opts: SyncOptions = {}): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const epoch = uniqueEpoch(db, isoSeconds(now));
  const { primary, secondary, source, url, attempts } = await walkChain(opts);

  // Total failure: keep the last good snapshot in force and say so loudly in
  // price_sync. §4.3 — "a failed fetch writes price_sync(ok=0) and changes
  // nothing else"; the estimator never blocks on the network.
  if (primary.size === 0 && secondary.size === 0) {
    db.query(
      `INSERT INTO price_sync (price_epoch, synced_at, source, url, etag, n_families, n_provisional, ok)
       VALUES (?,?,?,?,NULL,0,0,0)`,
    ).run(epoch, epoch, source, url);
    return {
      price_epoch: epoch,
      source,
      url,
      ok: false,
      n_families: 0,
      n_provisional: 0,
      unmatched: [],
      n_rows_written: 0,
      attempts,
    };
  }

  // Everything upstream published, plus everything we have actually observed,
  // plus anything the caller named. Pricing the whole published table is cheap
  // and means a model Craig has not used yet is already priced when he does.
  const targets = new Map<string, NormalizedModel>();
  for (const family of primary.keys()) targets.set(family, normalizeModelId(family));
  for (const family of secondary.keys()) if (!targets.has(family)) targets.set(family, normalizeModelId(family));
  for (const id of [...observedFamilies(db), ...(opts.models ?? [])]) {
    if (NON_API_MODELS.has(id.trim().toLowerCase())) continue;
    const norm = normalizeModelId(id);
    // Keyed by `priceFamily`, NOT `norm.family`: the key has to be byte-identical
    // to the `request.model_family` this row must join, suffix and all. Keying on
    // the stripped family is what made `claude-opus-5[1m]` collapse onto the
    // already-present `claude-opus-5` target so that no `[1m]` row was ever
    // written and none of its spend could be priced.
    const key = priceFamily(id);
    if (!targets.has(key)) targets.set(key, norm);
  }

  const pool: ResolvedFamily[] = [...primary.values(), ...secondary.values(), ...poolFromDb(db)];
  const resolved: ResolvedFamily[] = [];
  const provisionalNotes: Array<{ family: string; peer: string }> = [];
  const unmatched: string[] = [];

  /** The base family's published rates, from this sync or from an earlier one. */
  const baseRates = (base: string): ResolvedFamily | null => {
    const upstream = primary.get(base) ?? secondary.get(base);
    if (upstream) return upstream;
    const cur = currentPrice(db, base);
    if (cur === null) return null;
    const hi = currentPrice(db, base + ABOVE_200K_SUFFIX);
    const norm = normalizeModelId(base);
    return {
      family: base,
      tier: norm.tier,
      generation: norm.generation,
      rates: { usd_in: cur.usd_in, usd_out: cur.usd_out, usd_cw: cur.usd_cw, usd_cr: cur.usd_cr },
      above200k:
        hi === null
          ? null
          : { usd_in: hi.usd_in, usd_out: hi.usd_out, usd_cw: hi.usd_cw, usd_cr: hi.usd_cr },
      source: cur.source as PriceSourceName,
      provisional: cur.provisional === 1,
    };
  };

  for (const [family, norm] of targets) {
    const authoritative = primary.get(family) ?? secondary.get(family);
    if (authoritative) {
      resolved.push(authoritative);
      continue;
    }
    // Already carries an authoritative rate from an earlier sync: leave it be.
    const existing = currentPrice(db, family);
    if (existing && existing.provisional === 0) continue;

    // A bracket suffix names the SAME published model invoked differently, so the
    // base family's own rate is a far better answer than a tier-peer guess.
    // A suffix that denotes a window past 200k takes the long-context tier when
    // upstream publishes one — which is the only thing that ever reads the
    // `@above_200k` companion rows in the pricing path.
    //
    // EITHER WAY THE WINDOW IS BAKED INTO THE BRACKETED ROW ITSELF and `above200k`
    // stays null — including down the tier-peer fallback below, which used to copy
    // the peer's companion under the bracketed name. `v_request_tiered` refuses to
    // append `@above_200k` to a family whose name already ends in `]`, so such a
    // row is at best unreadable; before that guard existed it was worse than that,
    // because history here is append-only: a later sync publishing the real rate
    // wrote a new authoritative vintage of `X[1m]` but could not supersede the
    // guessed `X[1m]@above_200k`, and every >200k call kept paying the guess.
    const window = norm.contextSuffix === null ? null : contextSuffixTokens(norm.contextSuffix);
    const long = window !== null && window > LONG_CONTEXT_THRESHOLD;

    if (norm.contextSuffix !== null) {
      const base = baseRates(norm.family);
      if (base !== null) {
        const rates = long && base.above200k !== null ? base.above200k : base.rates;
        // Honest about what we know: an exact rate (the long-context tier, or a
        // suffix that is not about context at all) is authoritative; guessing a
        // long-context invocation at the standard rate is not.
        const guessed = base.provisional || (long && base.above200k === null);
        resolved.push({
          family,
          tier: norm.tier,
          generation: norm.generation,
          rates,
          above200k: null,
          source: base.source,
          provisional: guessed,
          peer: base.family,
        });
        if (guessed) {
          provisionalNotes.push({
            family,
            peer:
              long && base.above200k === null
                ? `${base.family} at its STANDARD-context rate (no >200k rate published)`
                : base.family,
          });
        }
        continue;
      }
    }

    const peer = tierPeer(norm, pool);
    if (!peer) {
      unmatched.push(family);
      continue;
    }
    resolved.push({
      family,
      tier: norm.tier,
      generation: norm.generation,
      rates: long && peer.above200k !== null ? peer.above200k : peer.rates,
      above200k: norm.contextSuffix === null ? peer.above200k : null,
      source: peer.source,
      provisional: true,
      peer: peer.family,
    });
    provisionalNotes.push({ family, peer: peer.family });
  }

  const insert = db.query(
    `INSERT INTO model_price
       (family, effective_from, usd_in, usd_out, usd_cw, usd_cr, provisional, source, synced_epoch, ingested_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(family, effective_from) DO UPDATE SET
       usd_in = excluded.usd_in, usd_out = excluded.usd_out,
       usd_cw = excluded.usd_cw, usd_cr = excluded.usd_cr,
       provisional = excluded.provisional, source = excluded.source,
       synced_epoch = excluded.synced_epoch, ingested_at = excluded.ingested_at
     WHERE excluded.provisional <= model_price.provisional`,
  );

  let written = 0;

  /** Write one family/tier row iff its rate is new or has moved. */
  const put = (family: string, rates: Rates, provisional: boolean, src: PriceSourceName): void => {
    const existing = currentPrice(db, family);

    if (existing && ratesEqual(rates, existing) && existing.provisional === (provisional ? 1 : 0)) {
      return; // unchanged — do not manufacture price history
    }
    // A family's first rate covers all prior history; only real changes get the
    // sync epoch, so `effective_from` always marks a genuine price move.
    //
    // A PUBLISHED RATE ARRIVING FOR A FAMILY WE HAD ONLY GUESSED IS ONE OF THOSE
    // MOVES and takes this same path: a NEW row at this epoch, provisional=0,
    // with the guessed vintage left exactly as it was written. This used to
    // rewrite every provisional row for the family IN PLACE, on the theory that
    // the published rate "was true all along" — but the ROW does not record what
    // was true, it records what we were pricing at, and mutating it made
    // repricing retroactive: every historical estimate silently restated at a
    // rate that did not exist when it was issued, `v_wcet`'s "each request at ITS
    // OWN vintage" promise broken by the one writer that exists to keep it, and
    // an `estimate.price_epoch` pointing at numbers that had since changed under
    // it. History is append-only here.
    //
    // The cost is real and accepted: requests predating the upgrade keep their
    // provisional price and stay out of `v_velocity`, which is the honest record
    // — what we had then WAS a guess. `est prices --set --at <ts>` is the
    // deliberate, human, audited way to assert otherwise for a vintage.
    const effectiveFrom = existing ? epoch : EPOCH_ZERO;
    insert.run(
      family,
      effectiveFrom,
      rates.usd_in,
      rates.usd_out,
      rates.usd_cw,
      rates.usd_cr,
      provisional ? 1 : 0,
      src,
      epoch,
      epoch,
    );
    written++;
  };

  // BEGIN IMMEDIATE (§2): take the write lock up front rather than discovering
  // mid-transaction that the sweeper holds it and having to roll back.
  db.transaction(() => {
    for (const r of resolved) {
      put(r.family, r.rates, r.provisional, r.source);
      if (r.above200k) put(r.family + ABOVE_200K_SUFFIX, r.above200k, r.provisional, r.source);
    }

    // Loud failures (§2). A provisional rate is honest-to-within-a-tier and
    // still excluded from v_velocity; an unmatched id is priced at NOTHING.
    //
    // THE DETAILS ARE EPOCH-FREE ON PURPOSE. The ledger's only key is
    // (kind, detail), and this runs weekly off cron over an upstream table that
    // changes rarely: stamping the epoch into the text made every re-sync a
    // fresh row for the same unchanging fact, so one family upstream never
    // publishes grew the ledger without bound. WHICH sync observed it is
    // recorded where it belongs and joins properly — `price_sync`, plus
    // `model_price.synced_epoch` on the row this describes. What varies here is
    // only family + reason, which is exactly what a reader wants collapsed.
    recordAnomalies(db, epoch, [
      ...provisionalNotes.map((p) => ({
        kind: "provisional_price" as const,
        detail: `${p.family} priced from tier peer ${p.peer} (provisional=1)`,
      })),
      ...unmatched.map((family) => ({
        kind: "unpriced_model" as const,
        detail: `${family} matched no upstream entry and has no same-tier peer; NO price row written`,
      })),
    ]);

    db.query(
      `INSERT INTO price_sync (price_epoch, synced_at, source, url, etag, n_families, n_provisional, ok)
       VALUES (?,?,?,?,NULL,?,?,1)`,
    ).run(epoch, epoch, source, url, resolved.length, provisionalNotes.length);
  }).immediate();

  return {
    price_epoch: epoch,
    source,
    url,
    ok: true,
    n_families: resolved.length,
    n_provisional: provisionalNotes.length,
    unmatched,
    n_rows_written: written,
    attempts,
  };
}

export interface ManualPriceOptions {
  /**
   * `est prices --set --at <iso>`: the vintage the rate takes effect from.
   * Omitted, see {@link setManualPrice} for the backdating rule.
   */
  at?: Date;
  /** Injected clock — when the override was RECORDED, not when it takes effect. */
  now?: Date;
}

export interface ManualPriceResult {
  /** The `model_price.family` key the row landed on. */
  family: string;
  /** `model_price.effective_from` — the vintage this rate takes effect from. */
  effective_from: string;
  /** The `price_sync` row this override opened. */
  price_epoch: string;
  /** True when the rate takes effect before it was recorded, i.e. it prices old requests. */
  backdated: boolean;
}

/**
 * Manual override (`est prices --set`), §4.3's surviving role for prices.toml.
 * Always authoritative: `provisional = 0`, `source = 'manual'`.
 *
 * WHEN it takes effect is the whole point of the verb, so it is explicit:
 *
 *   - `at` (the CLI's `--at <iso>`) stamps `effective_from` directly. `est
 *     backfill` prints exactly this advice when it finds requests older than the
 *     earliest price row for their own family — "Backdate a price row (`est
 *     prices --set`) if that spend needs to be included" — and the advice was
 *     unfollowable while this function ignored the flag and stamped now
 *     regardless: the new row simply landed after the requests it was meant to
 *     cover and `v_priced`'s `MAX(effective_from) <= r.ts` never reached it.
 *   - Without `at`, a family's FIRST-ever row is backdated to {@link EPOCH_ZERO},
 *     the rule `sync` applies for the same reason: a first row stamped now
 *     leaves the entire backfilled corpus unpriced. Once the family HAS history,
 *     a bare `--set` is a change as of now and opens its own vintage rather than
 *     restating the old one — same append-only history `sync` keeps.
 *
 * The `price_sync` row is always stamped at `now`, walked forward past a taken
 * PK exactly like a sync: it records when the human ran the command, not which
 * vintage they were asserting. Only `effective_from` moves.
 *
 * The one in-place update left in this file is the `ON CONFLICT` below, which
 * fires only when a human re-asserts a rate at an instant they already stamped.
 * That is a person correcting their own row, by name, with the value in front of
 * them — not a background job silently restating history.
 */
export function setManualPrice(
  db: Database,
  model: string,
  rates: Rates,
  opts: ManualPriceOptions = {},
): ManualPriceResult {
  // `priceFamily`, not `normalizeModelId().family`: an override typed as
  // `claude-opus-5[1m]` has to land on the key the sweeper actually looks up for
  // a `[1m]` request. Stripping the suffix here wrote a row the join never sees.
  const family = priceFamily(model);
  const epoch = uniqueEpoch(db, isoSeconds(opts.now ?? new Date()));
  const hasHistory = currentPrice(db, family) !== null;
  const effectiveFrom =
    opts.at !== undefined ? isoSeconds(opts.at) : hasHistory ? epoch : EPOCH_ZERO;

  db.transaction(() => {
    db.query(
      `INSERT INTO price_sync (price_epoch, synced_at, source, url, etag, n_families, n_provisional, ok)
       VALUES (?,?, 'manual', NULL, NULL, 1, 0, 1)`,
    ).run(epoch, epoch);
    db.query(
      `INSERT INTO model_price
         (family, effective_from, usd_in, usd_out, usd_cw, usd_cr, provisional, source, synced_epoch, ingested_at)
       VALUES (?,?,?,?,?,?,0,'manual',?,?)
       ON CONFLICT(family, effective_from) DO UPDATE SET
         usd_in = excluded.usd_in, usd_out = excluded.usd_out,
         usd_cw = excluded.usd_cw, usd_cr = excluded.usd_cr,
         provisional = 0, source = 'manual',
         synced_epoch = excluded.synced_epoch, ingested_at = excluded.ingested_at`,
    ).run(
      family,
      effectiveFrom,
      rates.usd_in,
      rates.usd_out,
      rates.usd_cw,
      rates.usd_cr,
      epoch,
      epoch,
    );
  }).immediate();

  return { family, effective_from: effectiveFrom, price_epoch: epoch, backdated: effectiveFrom < epoch };
}

/** `est prices --show`: the rate in force per family, newest first. */
export function showPrices(db: Database, at?: string): PriceRow[] {
  const rows = db
    .query<{ family: string }, []>("SELECT DISTINCT family FROM model_price ORDER BY family")
    .all();
  const out: PriceRow[] = [];
  for (const { family } of rows) {
    const p = currentPrice(db, family, at);
    if (p) out.push(p);
  }
  return out;
}

/**
 * src/otel.ts — the OTLP/JSON decoder and the spool→database ingest (P2.3, P2.4).
 *
 * Two halves that deliberately live in one file, because they are two ends of one
 * wire format:
 *
 *  1. **The decoder** turns an OTLP/HTTP JSON export body into flat, allowlisted
 *     records. `scripts/otel-receiver.ts` runs it in-process and appends one line per
 *     record to `spool/otel-*.jsonl`; nothing else in the receiver understands OTLP.
 *  2. **The ingest** drains those lines into `otel_request` / `otel_metric` and
 *     performs the ONE join OTEL is allowed to make into `request`.
 *
 * ## Why JSON and not protobuf
 *
 * Decoding protobuf needs a library and the estimator has zero npm dependencies
 * (P2.0). OTLP/HTTP with a JSON payload is a first-class, documented Claude Code
 * option and `JSON.parse` is in the runtime. Every awkward thing below — quoted
 * int64s, the `anyValue` wrappers — is a consequence of that trade and is cheaper
 * than the dependency.
 *
 * ## The four things a hand-rolled OTLP/JSON parser gets wrong, all silent
 *
 *  1. **int64 fields arrive as JSON STRINGS.** `timeUnixNano`, `observedTimeUnixNano`
 *     and `intValue` are quoted per the protobuf JSON mapping, and a nanosecond
 *     timestamp exceeds `Number.MAX_SAFE_INTEGER` — so `Number(x) / 1e6` silently
 *     loses precision on every timestamp. {@link nanosToIso} goes through `BigInt`.
 *  2. **Attribute values are WRAPPED** in a one-key `anyValue` object. One unwrapper
 *     ({@link unwrapAnyValue}), applied everywhere, so no call site can invent its own.
 *  3. **The event name may be a `LogRecord` field OR an `event.name` attribute**,
 *     depending on SDK vintage. Both are accepted; a record where neither resolves is
 *     rejected INTACT rather than guessed at.
 *  4. **Temporality decides whether summing is legal.** DELTA points sum; CUMULATIVE
 *     points must be differenced per series. The value travels on every row and
 *     `est recon` refuses to sum a mixed window — the same class of bug as the
 *     MAX-vs-first dedup rule that cost 88% of sub-agent output (§5.2).
 *
 * ## The attribute ALLOWLIST is a privacy mechanism, not an optimisation
 *
 * `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_CONTENT`
 * and friends all default to disabled, and every one of them would put prompt or
 * response TEXT into the spool — the exact material §4's privacy rule forbids from
 * ever reaching the repository. Defaults change upstream; an allowlist does not. An
 * attribute nobody asked for is dropped here, at parse time, rather than persisted
 * and discovered later.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IngestAnomaly } from "./ingest.ts";
import { modelFamily } from "./ingest.ts";

// ---------------------------------------------------------------------------
// Wire types — the flat record shape the spool carries
// ---------------------------------------------------------------------------

/** Scalar an OTLP `anyValue` can carry once unwrapped. Arrays collapse to JSON text. */
export type AttrValue = string | number | boolean;

export interface OtelLogRecord {
  sig: "log";
  /** `claude_code.api_request`, `claude_code.api_error`, … */
  name: string;
  /** Event time, ISO seconds, derived from `timeUnixNano` through BigInt. */
  ts: string;
  /** When the receiver spooled it. Drift against `ts` is export latency. */
  received_at: string;
  attrs: Record<string, AttrValue>;
}

export interface OtelMetricRecord {
  sig: "metric";
  metric: string;
  ts: string;
  received_at: string;
  value: number;
  unit: string | null;
  temporality: Temporality;
  attrs: Record<string, AttrValue>;
  /**
   * The exact `timeUnixNano` as it arrived, verbatim. `ts` is truncated to SECONDS
   * because every window predicate in this schema is an ISO-second string compare, so
   * two points of one series 250 ms apart carry the same `ts` — and a stored identity
   * narrower than the wire identity is data loss, not deduplication. This column is the
   * sub-second half of the point's identity; nothing aggregates over it.
   */
  ts_nanos: string;
  /**
   * A digest of the point's FULL dimension set — every resource, scope and point
   * attribute as it arrived, plus the unit — not just the allowlisted ones.
   *
   * {@link collectAttrs} keeps only allowlisted attributes, which is the privacy
   * boundary and stays that way; but it means two genuinely distinct series
   * (`tool=Edit,decision=accept` and `tool=Write,decision=reject`, neither key
   * allowlisted) decode to the SAME stored dimensions and the second silently replaces
   * the first. The digest restores the distinction without persisting the values: it is
   * one-way, computed over METRIC point attributes only (never log records, which are
   * the ones the content flags could put prompt text on), and no consumer can read a
   * dimension back out of it.
   */
  dim_digest: string;
}

export type Temporality = "delta" | "cumulative" | "unspecified";

export type OtelRecord = OtelLogRecord | OtelMetricRecord;

export interface DecodeResult<T> {
  records: T[];
  /**
   * Records the decoder could not classify. They are NOT dropped: the receiver parks
   * the raw body in `otel-reject.jsonl` and answers 200, because a 4xx makes the
   * exporter retry the same bad payload forever (P2.3).
   */
  rejected: number;
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * Unwrap one OTLP `anyValue`.
 *
 * `intValue` is a quoted int64 and is converted through `BigInt`, so a value beyond
 * 2^53 is either exact or `null` — never a plausible-looking wrong number.
 */
export function unwrapAnyValue(v: unknown): AttrValue | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.stringValue === "string") return o.stringValue;
  if (typeof o.boolValue === "boolean") return o.boolValue;
  if (typeof o.doubleValue === "number") return o.doubleValue;
  if (o.intValue !== undefined) return int64(o.intValue);
  if (o.arrayValue !== undefined) {
    const arr = (o.arrayValue as { values?: unknown[] }).values ?? [];
    // Arrays are rare on these events and no consumer indexes into one, so they are
    // kept as text rather than given a nested representation nothing would read.
    return JSON.stringify(arr.map((x) => unwrapAnyValue(x)));
  }
  return null;
}

/** A protobuf-JSON int64: a quoted string, or (from a lenient encoder) a number. */
export function int64(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  try {
    const n = BigInt(v);
    // Counters and durations are small; a value that does not survive the round trip
    // is a parse we do not understand, and a wrong number is worse than no number.
    if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(-Number.MAX_SAFE_INTEGER)) return null;
    return Number(n);
  } catch {
    return null;
  }
}

/**
 * `timeUnixNano` → ISO-seconds UTC.
 *
 * Through `BigInt`, never through float division: `Number("1753800000123456789")`
 * has already lost the low digits before any division happens, and the corrupted
 * value still looks like a timestamp.
 */
export function nanosToIso(nano: unknown): string | null {
  let n: bigint;
  if (typeof nano === "bigint") n = nano;
  else if (typeof nano === "number") {
    if (!Number.isFinite(nano)) return null;
    n = BigInt(Math.trunc(nano));
  } else if (typeof nano === "string" && /^-?\d+$/.test(nano.trim())) {
    n = BigInt(nano.trim());
  } else return null;
  const ms = n / 1000000n;
  const asNumber = Number(ms);
  if (!Number.isFinite(asNumber) || Math.abs(asNumber) > 8.64e15) return null;
  return `${new Date(asNumber).toISOString().slice(0, 19)}Z`;
}

/** ISO seconds, the timestamp format every other table in this schema uses. */
export function isoNow(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

/**
 * Attributes we consume, by their documented Claude Code names. Anything else is
 * dropped at parse time — see the header: this is the belt to the content flags'
 * braces, and it is what stops an upstream default change from putting prompt text
 * in the spool.
 *
 * **EVERY ENTRY HAS A NAMED CONSUMER**, and that is a rule rather than a coincidence:
 * an allowlist that accumulates entries nobody reads stops being a privacy boundary and
 * becomes a habit. The consumer is a column of `otel_request` (`schema.sql`) unless
 * noted, and `test/otel.test.ts` pins the exact set so a re-add has to be argued for.
 *
 * Removed, deliberately, and what to do if one is wanted back:
 *  - `organization.id` — the one stable ACCOUNT-scoped identifier the harness emits.
 *    It was allowlisted, reached `attrs`, and was written to the spool by the receiver,
 *    while being read by no column, no view and no report. That is the exact class the
 *    account-UUID exclusion was reasoned about, so it is dropped at parse time again.
 *  - `app.version` / `service.version` / `terminal.type` — environment strings with no
 *    consumer either. Harmless individually; kept only because they were easy to add,
 *    which is how the boundary erodes. Re-add one WITH the consumer, in the same commit.
 *  - `error` — no consumer, and the one dropped entry that is free-form SERVER text
 *    rather than an enumeration. `status_code` is kept and carries the classification an
 *    `api_error` event is actually read for.
 */
export const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  // common resource/log attributes
  "session.id",
  "prompt.id",
  "message.uuid",
  "client_request_id",
  "workflow.run_id",
  "workflow.name",
  // api_request / api_error
  "model",
  "query_source",
  "request_id",
  "attempt",
  "speed",
  "effort",
  "duration_ms",
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "status_code",
  // metric dimensions: `type`/`token_type` are otel_metric.token_type (the two spellings
  // are SDK vintages of one dimension, resolved at ingest).
  "type",
  "token_type",
]);

/**
 * The point's full wire identity, canonicalised: `key=value` for EVERY attribute as it
 * arrived, sorted, with no allowlist applied.
 *
 * Fed only to {@link dimensionDigest}, and only for METRIC points. The values never
 * reach the spool, the database or a log line — the digest is one-way and 64 bits of
 * hex, which is enough to tell two label sets apart and not enough to read one back.
 */
function attrIdentity(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const kv of raw) {
    if (kv === null || typeof kv !== "object") continue;
    const key = (kv as { key?: unknown }).key;
    if (typeof key !== "string") continue;
    const value = unwrapAnyValue((kv as { value?: unknown }).value);
    out.push(`${key}=${value === null ? "" : String(value)}`);
  }
  out.sort();
  return out;
}

/**
 * Stable 64-bit hex digest of an ordered list of identity parts.
 *
 * Joined on US (0x1f), never concatenated: `["a=1","b=2"]` and `["a=1b=2"]` are the same
 * byte string under a bare join, and an identity function two different label sets can
 * fool is an identity function that silently merges two series — which is the bug this
 * digest exists to close, reintroduced one layer down.
 */
export function dimensionDigest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
}

function collectAttrs(
  raw: unknown,
  into: Record<string, AttrValue>,
): void {
  if (!Array.isArray(raw)) return;
  for (const kv of raw) {
    if (kv === null || typeof kv !== "object") continue;
    const key = (kv as { key?: unknown }).key;
    if (typeof key !== "string") continue;
    if (!ALLOWED_ATTRS.has(key)) continue;
    const value = unwrapAnyValue((kv as { value?: unknown }).value);
    if (value === null) continue;
    into[key] = value;
  }
}

/** `event.name` is read even though it is not an allowlisted ATTRIBUTE — it is the name. */
function eventName(record: Record<string, unknown>): string | null {
  const direct = record.eventName ?? record.name;
  if (typeof direct === "string" && direct !== "") return direct;
  const attrs = record.attributes;
  if (Array.isArray(attrs)) {
    for (const kv of attrs) {
      if (kv !== null && typeof kv === "object" && (kv as { key?: unknown }).key === "event.name") {
        const v = unwrapAnyValue((kv as { value?: unknown }).value);
        if (typeof v === "string" && v !== "") return v;
      }
    }
  }
  // A `body` that is a bare string is how some SDK vintages carry the event name.
  const body = record.body;
  if (body !== null && typeof body === "object") {
    const s = (body as { stringValue?: unknown }).stringValue;
    if (typeof s === "string" && s !== "") return s;
  }
  return null;
}

function temporality(v: unknown): Temporality {
  if (v === 1 || v === "1" || v === "AGGREGATION_TEMPORALITY_DELTA") return "delta";
  if (v === 2 || v === "2" || v === "AGGREGATION_TEMPORALITY_CUMULATIVE") return "cumulative";
  return "unspecified";
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/** `POST /v1/logs` — an `ExportLogsServiceRequest` as OTLP/JSON. */
export function decodeLogs(body: unknown, receivedAt: string): DecodeResult<OtelLogRecord> {
  const records: OtelLogRecord[] = [];
  let rejected = 0;
  const resourceLogs = arr((body as Record<string, unknown> | null)?.resourceLogs);
  for (const rl of resourceLogs) {
    const resourceAttrs: Record<string, AttrValue> = {};
    collectAttrs(((rl as Record<string, unknown>).resource as Record<string, unknown>)?.attributes, resourceAttrs);
    for (const sl of arr((rl as Record<string, unknown>).scopeLogs)) {
      for (const lr of arr((sl as Record<string, unknown>).logRecords)) {
        if (lr === null || typeof lr !== "object") {
          rejected += 1;
          continue;
        }
        const record = lr as Record<string, unknown>;
        const name = eventName(record);
        const ts = nanosToIso(record.timeUnixNano) ?? nanosToIso(record.observedTimeUnixNano);
        if (name === null || ts === null) {
          // Neither guessed at nor dropped: the caller parks it and counts it.
          rejected += 1;
          continue;
        }
        // Resource attributes first so a record-level attribute of the same name wins:
        // the record is the more specific statement about itself.
        const attrs: Record<string, AttrValue> = { ...resourceAttrs };
        collectAttrs(record.attributes, attrs);
        // The event body may repeat the attributes as a kvlist on some vintages.
        const body2 = record.body as Record<string, unknown> | undefined;
        if (body2 !== undefined && body2 !== null && body2.kvlistValue !== undefined) {
          collectAttrs((body2.kvlistValue as { values?: unknown }).values, attrs);
        }
        records.push({ sig: "log", name, ts, received_at: receivedAt, attrs });
      }
    }
  }
  return { records, rejected };
}

/** `POST /v1/metrics` — an `ExportMetricsServiceRequest` as OTLP/JSON. */
export function decodeMetrics(body: unknown, receivedAt: string): DecodeResult<OtelMetricRecord> {
  const records: OtelMetricRecord[] = [];
  let rejected = 0;
  for (const rm of arr((body as Record<string, unknown> | null)?.resourceMetrics)) {
    const resourceAttrs: Record<string, AttrValue> = {};
    const rawResource = ((rm as Record<string, unknown>).resource as Record<string, unknown>)?.attributes;
    collectAttrs(rawResource, resourceAttrs);
    // Hoisted out of the point loop on purpose: the identity of a resource is a property
    // of the resource, and re-canonicalising it per data point would be per-item work in
    // the only loop here that is unbounded in corpus size.
    const resourceIdentity = attrIdentity(rawResource);
    for (const sm of arr((rm as Record<string, unknown>).scopeMetrics)) {
      const scopeIdentity = attrIdentity(
        ((sm as Record<string, unknown>).scope as Record<string, unknown>)?.attributes,
      );
      for (const m of arr((sm as Record<string, unknown>).metrics)) {
        if (m === null || typeof m !== "object") {
          rejected += 1;
          continue;
        }
        const metric = m as Record<string, unknown>;
        const name = typeof metric.name === "string" ? metric.name : null;
        const unit = typeof metric.unit === "string" && metric.unit !== "" ? metric.unit : null;
        // `sum` and `gauge` are the two shapes Claude Code emits; a histogram would
        // need a different row shape entirely, so it is rejected rather than flattened.
        const sum = metric.sum as Record<string, unknown> | undefined;
        const gauge = metric.gauge as Record<string, unknown> | undefined;
        const holder = sum ?? gauge;
        if (name === null || holder === undefined || holder === null) {
          rejected += 1;
          continue;
        }
        // Temporality is a property of the SUM, not of the point — but a lenient
        // encoder may stamp it on the point, so both are read and the point wins.
        const holderTemporality = temporality(holder.aggregationTemporality);
        for (const dp of arr(holder.dataPoints)) {
          if (dp === null || typeof dp !== "object") {
            rejected += 1;
            continue;
          }
          const point = dp as Record<string, unknown>;
          const ts = nanosToIso(point.timeUnixNano) ?? nanosToIso(point.startTimeUnixNano);
          const value =
            typeof point.asDouble === "number"
              ? point.asDouble
              : point.asInt !== undefined
                ? int64(point.asInt)
                : null;
          if (ts === null || value === null) {
            rejected += 1;
            continue;
          }
          const attrs: Record<string, AttrValue> = { ...resourceAttrs };
          collectAttrs(point.attributes, attrs);
          const pointTemporality =
            point.aggregationTemporality === undefined
              ? holderTemporality
              : temporality(point.aggregationTemporality);
          records.push({
            sig: "metric",
            metric: name,
            ts,
            received_at: receivedAt,
            value,
            unit,
            // A GAUGE has no temporality; calling it 'delta' would licence a SUM over
            // points that are not summable. 'unspecified' is the honest label and
            // `est recon` treats it as unsummable.
            temporality: sum === undefined ? "unspecified" : pointTemporality,
            attrs,
            // The two halves of the identity `attrs` cannot carry. `ts_nanos` keeps the
            // sub-second the ISO-seconds `ts` drops; the digest keeps the dimensions the
            // allowlist drops. `startTimeUnixNano` is in the digest because a restarted
            // exporter begins a NEW cumulative stream, and two streams of one series are
            // not the same series however identical their labels look.
            ts_nanos: typeof point.timeUnixNano === "string" ? point.timeUnixNano : String(point.timeUnixNano ?? ""),
            dim_digest: dimensionDigest([
              `unit=${unit ?? ""}`,
              `start=${String(point.startTimeUnixNano ?? "")}`,
              ...resourceIdentity,
              ...scopeIdentity,
              ...attrIdentity(point.attributes),
            ]),
          });
        }
      }
    }
  }
  return { records, rejected };
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// Spool file names — shared by the receiver (writer) and the sweeper (reader)
// ---------------------------------------------------------------------------

export const OTEL_LOGS_FILE = "otel-logs.jsonl";
export const OTEL_METRICS_FILE = "otel-metrics.jsonl";
export const OTEL_TRACES_FILE = "otel-traces.jsonl";
export const OTEL_REJECT_FILE = "otel-reject.jsonl";
export const OTEL_RAW_FILE = "otel-raw.jsonl";
const DRAINING_SUFFIX = ".draining";

/** `otel-logs.2026-07-29T12-00-00Z.jsonl` — a rotated file, drained in name order. */
export function rotatedName(base: string, at: Date = new Date()): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[:.]/g, "-");
  return base.replace(/\.jsonl$/, `.${stamp}Z.jsonl`);
}

/**
 * Every spool file for one signal, oldest first: leftover `.draining` residue, then
 * rotated files in name order, then the live file. Time order is preserved, which is
 * what makes the `attempt` tie-break below deterministic.
 */
export function otelSpoolFiles(dir: string, base: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const stem = base.replace(/\.jsonl$/, "");
  const draining: string[] = [];
  const rotated: string[] = [];
  let live: string | null = null;
  for (const name of entries) {
    if (name === base) live = name;
    else if (name === `${base}${DRAINING_SUFFIX}`) draining.push(name);
    else if (name.startsWith(`${stem}.`) && name.endsWith(".jsonl")) rotated.push(name);
    else if (name.startsWith(`${stem}.`) && name.endsWith(`.jsonl${DRAINING_SUFFIX}`)) draining.push(name);
  }
  draining.sort();
  rotated.sort();
  return [...draining, ...rotated, ...(live === null ? [] : [live])].map((n) => join(dir, n));
}

// ---------------------------------------------------------------------------
// Ingest (P2.4)
// ---------------------------------------------------------------------------

export interface OtelIngestResult {
  logs_read: number;
  metrics_read: number;
  malformed: number;
  otel_requests_upserted: number;
  otel_metrics_inserted: number;
  /** `request.duration_ms` rows filled from OTEL — the ONE column OTEL may write. */
  durations_filled: number;
  /**
   * `request.duration_ms` rows REPLACED because a strictly higher `attempt` arrived on a
   * LATER drain than the one that filled them. Separate from `durations_filled` because
   * they answer different questions: filled is coverage, refreshed is the retry
   * correction, and a non-zero refresh count on a steady corpus means retries are
   * landing across sweep boundaries.
   */
  durations_refreshed: number;
  /** `origin='auxiliary'` rows inserted; they have no transcript by construction. */
  auxiliary_inserted: number;
  /**
   * Auxiliary rows this drain SUPERSEDED with a strictly higher attempt's counters. Not
   * a collision: it is the same request at a later attempt, and the earlier attempt's
   * numbers were never the billed ones.
   */
  auxiliary_superseded: number;
  /**
   * Auxiliary inserts suppressed by a request row THIS INGEST DID NOT WRITE. This is the
   * number that turns "auxiliary requests never appear in transcripts" from an
   * assumption in the code into a fact in the retro — which is exactly why a retry
   * landing on our own earlier auxiliary row must NOT be counted here. It would inflate
   * the very counter whose whole job is to measure transcript overlap.
   */
  auxiliary_collisions: number;
  unjoined: number;
  /** A true `COUNT(*)`, not the size of the anomaly sample below it. */
  counter_mismatches: number;
  /** A true `COUNT(*)`, not the size of the anomaly sample below it. */
  prompt_mismatches: number;
  /** Reject-spool records the receiver could not classify, awaiting a parser. */
  rejects_read: number;
  /** Trace summaries claimed and dropped — Phase 2 spools traces but consumes none. */
  traces_dropped: number;
  /** Reject/raw spool files reaped by age (`otel_spool_retention_days`). */
  spool_pruned: number;
  anomalies: IngestAnomaly[];
  /** Delete the claimed `.draining` files — call AFTER the transaction commits. */
  cleanup: () => void;
}

export function emptyOtelIngest(): OtelIngestResult {
  return {
    logs_read: 0,
    metrics_read: 0,
    malformed: 0,
    otel_requests_upserted: 0,
    otel_metrics_inserted: 0,
    durations_filled: 0,
    durations_refreshed: 0,
    auxiliary_inserted: 0,
    auxiliary_superseded: 0,
    auxiliary_collisions: 0,
    unjoined: 0,
    counter_mismatches: 0,
    prompt_mismatches: 0,
    rejects_read: 0,
    traces_dropped: 0,
    spool_pruned: 0,
    anomalies: [],
    cleanup: () => {},
  };
}

/**
 * `otel_request` upsert. **On conflict the higher `attempt` wins** — a retried call
 * reports twice and the last attempt is the one that produced the billed result.
 * Otherwise first-seen wins, matching `request`'s rule.
 *
 * `joined` is deliberately NOT part of the upsert: it is set by the join pass below,
 * and letting a re-drain reset it would make `join_pct` oscillate with sweep order.
 */
const UPSERT_OTEL_REQUEST_SQL = `
INSERT INTO otel_request (
  request_id, session_id, prompt_id, message_uuid, client_request_id,
  model, query_source, ts, received_at, duration_ms, cost_usd_micros,
  in_tok, out_tok, cw_tok, cr_tok, attempt, speed, effort, status_code,
  workflow_run_id, workflow_name, joined)
VALUES (
  $request_id, $session_id, $prompt_id, $message_uuid, $client_request_id,
  $model, $query_source, $ts, $received_at, $duration_ms, $cost_usd_micros,
  $in_tok, $out_tok, $cw_tok, $cr_tok, $attempt, $speed, $effort, $status_code,
  $workflow_run_id, $workflow_name, 0)
ON CONFLICT(request_id) DO UPDATE SET
  session_id      = CASE WHEN NEWER THEN excluded.session_id      ELSE otel_request.session_id END,
  prompt_id       = CASE WHEN NEWER THEN excluded.prompt_id       ELSE otel_request.prompt_id END,
  message_uuid    = CASE WHEN NEWER THEN excluded.message_uuid    ELSE otel_request.message_uuid END,
  client_request_id = CASE WHEN NEWER THEN excluded.client_request_id ELSE otel_request.client_request_id END,
  model           = CASE WHEN NEWER THEN excluded.model           ELSE otel_request.model END,
  query_source    = CASE WHEN NEWER THEN excluded.query_source    ELSE otel_request.query_source END,
  ts              = CASE WHEN NEWER THEN excluded.ts              ELSE otel_request.ts END,
  received_at     = CASE WHEN NEWER THEN excluded.received_at     ELSE otel_request.received_at END,
  duration_ms     = CASE WHEN NEWER THEN excluded.duration_ms     ELSE otel_request.duration_ms END,
  cost_usd_micros = CASE WHEN NEWER THEN excluded.cost_usd_micros ELSE otel_request.cost_usd_micros END,
  in_tok          = CASE WHEN NEWER THEN excluded.in_tok          ELSE otel_request.in_tok END,
  out_tok         = CASE WHEN NEWER THEN excluded.out_tok         ELSE otel_request.out_tok END,
  cw_tok          = CASE WHEN NEWER THEN excluded.cw_tok          ELSE otel_request.cw_tok END,
  cr_tok          = CASE WHEN NEWER THEN excluded.cr_tok          ELSE otel_request.cr_tok END,
  attempt         = CASE WHEN NEWER THEN excluded.attempt         ELSE otel_request.attempt END,
  speed           = CASE WHEN NEWER THEN excluded.speed           ELSE otel_request.speed END,
  effort          = CASE WHEN NEWER THEN excluded.effort          ELSE otel_request.effort END,
  status_code     = CASE WHEN NEWER THEN excluded.status_code     ELSE otel_request.status_code END,
  workflow_run_id = CASE WHEN NEWER THEN excluded.workflow_run_id ELSE otel_request.workflow_run_id END,
  workflow_name   = CASE WHEN NEWER THEN excluded.workflow_name   ELSE otel_request.workflow_name END
`.replaceAll(
  "NEWER",
  "COALESCE(excluded.attempt, 0) > COALESCE(otel_request.attempt, 0)",
);

/**
 * The join, and the hard boundary on it.
 *
 * **INVARIANT: OTEL may write `request.duration_ms` and NOTHING ELSE.** Not a token
 * counter, not a cost, not `origin`, not `tid`, not `attr`. The transcript is the
 * token source of truth (§2), and a second writer for the same counter is how two
 * sources silently disagree and neither is discoverable as wrong. A counter that
 * DIFFERS is reported as `otel_counter_mismatch`, never merged.
 */
const FILL_DURATION_SQL = `
UPDATE request
   SET duration_ms = (SELECT o.duration_ms FROM otel_request o
                       WHERE o.request_id = request.request_id)
 WHERE duration_ms IS NULL
   AND EXISTS (SELECT 1 FROM otel_request o
                WHERE o.request_id = request.request_id AND o.duration_ms IS NOT NULL)
`;

/**
 * The retry correction to {@link FILL_DURATION_SQL}, and the reason it needs one.
 *
 * `WHERE duration_ms IS NULL` fills once and never again. But `otel_request` is upserted
 * under "higher attempt wins", so attempt 1 (say 1 s) can materialise a duration on one
 * drain and attempt 2 (45 s) supersede `otel_request` on the NEXT drain, leaving
 * `request` pinned to an attempt that was never billed — a divergence `v_wcet`'s spend
 * and `windowIntervals()`'s active seconds both read from the losing side.
 *
 * Provenance without a provenance column: the caller passes only ids where `request`
 * still holds EXACTLY the duration the superseded attempt reported. If it holds anything
 * else the transcript owns that value, and the P2.4 invariant — OTEL never overwrites a
 * duration the transcript already had — is preserved by construction rather than by
 * hope.
 */
function refreshDurationSql(placeholders: string): string {
  return `
UPDATE request
   SET duration_ms = (SELECT o.duration_ms FROM otel_request o
                       WHERE o.request_id = request.request_id)
 WHERE request_id IN (${placeholders})
   AND EXISTS (SELECT 1 FROM otel_request o
                WHERE o.request_id = request.request_id AND o.duration_ms IS NOT NULL)
`;
}

const MARK_JOINED_SQL = `
UPDATE otel_request SET joined = 1
 WHERE joined = 0
   AND EXISTS (SELECT 1 FROM request r WHERE r.request_id = otel_request.request_id)
`;

/**
 * The one exception to "OTEL never inserts a request", and it was anticipated:
 * `origin='auxiliary'` spend — title generation, quota checks, background cheap-model
 * calls — has NO transcript row at all, which is why `outcome.wcet_aux` reads 0 "by
 * construction, not by omission". `ON CONFLICT DO NOTHING` and a reported collision
 * count keep that a measured claim rather than an assumption.
 *
 * `attr='none'` and `tid` NULL: attribution is the sweeper's pass, not OTEL's, and
 * `v_velocity`'s `origin IN ('main','subagent')` filter means this spend can never
 * reach a calibration multiplier however it is later attributed.
 */
export const INSERT_AUXILIARY_SQL = `
INSERT INTO request (request_id, message_id, is_sidechain, session_id, prompt_id, origin,
                     agent_id, run_id, wf_launch_id, model, model_family,
                     attribution_agent, attribution_skill, ts,
                     in_tok, out_tok, cw_tok, cr_tok, duration_ms, tid, attr)
VALUES ($request_id, NULL, 0, $session_id, $prompt_id, 'auxiliary',
        NULL, NULL, NULL, $model, $model_family,
        NULL, NULL, $ts,
        $in_tok, $out_tok, $cw_tok, $cr_tok, $duration_ms, NULL, 'none')
ON CONFLICT(request_id) DO NOTHING
`;

/**
 * Supersede an auxiliary row THIS INGEST materialised, with a strictly higher attempt's
 * numbers.
 *
 * `WHERE origin = 'auxiliary'` is the whole safety argument, and it holds because
 * `origin='auxiliary'` is a PROVENANCE MARKER: {@link INSERT_AUXILIARY_SQL} is the only
 * statement in the repository that writes it (`src/ingest.ts` classifies transcript rows
 * as `main` or `subagent` and never `auxiliary`). So this — the only place OTEL writes a
 * token counter into `request` at all — can only reach rows OTEL itself created. A retry
 * landing on a transcript row is still a collision and is still only counted, because
 * the transcript stays the source of truth for every counter (§2).
 */
export const SUPERSEDE_AUXILIARY_SQL = `
UPDATE request
   SET ts = $ts, in_tok = $in_tok, out_tok = $out_tok, cw_tok = $cw_tok, cr_tok = $cr_tok,
       duration_ms = $duration_ms
 WHERE request_id = $request_id AND origin = 'auxiliary'
`;

/**
 * `otel_metric` upsert.
 *
 * The conflict target is the point's FULL identity, which is what makes the DO UPDATE a
 * re-drain idempotence rule rather than a data-loss rule. `ts` is ISO SECONDS (every
 * window predicate in this schema is a string compare on it) and the four named
 * dimensions are the allowlisted ones, so on their own they are NARROWER than the wire:
 * two points 250 ms apart whose distinguishing labels are not allowlisted collapse to
 * one key, and `value = excluded.value` then overwrites rather than keeping both.
 * `ts_nanos` and `dim_digest` carry the rest of the identity, so a genuine re-delivery
 * still replaces and two distinct points can no longer replace one another.
 */
const INSERT_OTEL_METRIC_SQL = `
INSERT INTO otel_metric (metric, ts, ts_nanos, session_id, model, query_source, token_type,
                         dim_digest, value, unit, temporality, received_at)
VALUES ($metric, $ts, $ts_nanos, $session_id, $model, $query_source, $token_type,
        $dim_digest, $value, $unit, $temporality, $received_at)
ON CONFLICT(metric, ts, ts_nanos, session_id, model, query_source, token_type, dim_digest)
DO UPDATE SET
  value = excluded.value, unit = excluded.unit,
  temporality = excluded.temporality, received_at = excluded.received_at
`;

function s(v: AttrValue | undefined): string | null {
  if (v === undefined) return null;
  const t = typeof v === "string" ? v : String(v);
  return t === "" ? null : t;
}

function n(v: AttrValue | undefined): number | null {
  if (v === undefined) return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : null;
}

/** USD → integer micros. Money summed across 10^5 rows should not accumulate float error. */
export function usdToMicros(v: AttrValue | undefined): number | null {
  if (v === undefined) return null;
  const x = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(x) || x < 0) return null;
  return Math.round(x * 1e6);
}

function parseSpoolFile(path: string): { records: OtelRecord[]; malformed: number } {
  const records: OtelRecord[] = [];
  let malformed = 0;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { records, malformed };
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as OtelRecord;
      if (v !== null && typeof v === "object" && (v.sig === "log" || v.sig === "metric")) records.push(v);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

/**
 * Claim every spool file for one signal by `rename()` to `.draining`, exactly as
 * `drainSpool` does: a receiver appending concurrently lands in a fresh file, and a
 * drain that dies leaves the `.draining` residue for the next sweep rather than
 * losing it.
 */
function claimAll(dir: string, base: string): { paths: string[]; records: OtelRecord[]; malformed: number } {
  const paths: string[] = [];
  const records: OtelRecord[] = [];
  let malformed = 0;
  for (const path of otelSpoolFiles(dir, base)) {
    let claimedPath = path;
    if (!path.endsWith(DRAINING_SUFFIX)) {
      claimedPath = `${path}${DRAINING_SUFFIX}`;
      try {
        renameSync(path, claimedPath);
      } catch {
        continue; // another sweep claimed it, or it vanished; next sweep tries again
      }
    }
    paths.push(claimedPath);
    const parsed = parseSpoolFile(claimedPath);
    records.push(...parsed.records);
    malformed += parsed.malformed;
  }
  return { paths, records, malformed };
}

/**
 * Claim a spool signal and COUNT its records without parsing them.
 *
 * For the two signals nothing decodes: `otel-traces.jsonl` (spooled as a one-line
 * summary so enabling the tracing beta is a settings change, not a code change) and
 * `otel-reject.jsonl` (raw bodies, deliberately NOT in the flat record shape). Running
 * them through {@link parseSpoolFile} would count every line as `malformed`, which is
 * how a working reject spool would come to look like a broken log spool.
 */
function claimLines(dir: string, base: string): { paths: string[]; lines: number } {
  const paths: string[] = [];
  let lines = 0;
  for (const path of otelSpoolFiles(dir, base)) {
    let claimedPath = path;
    if (!path.endsWith(DRAINING_SUFFIX)) {
      claimedPath = `${path}${DRAINING_SUFFIX}`;
      try {
        renameSync(path, claimedPath);
      } catch {
        continue;
      }
    }
    paths.push(claimedPath);
    try {
      for (const line of readFileSync(claimedPath, "utf8").split("\n")) {
        if (line.trim() !== "") lines += 1;
      }
    } catch {
      // Unreadable residue is not a failed sweep; the file is still claimed and dropped.
    }
  }
  return { paths, lines };
}

/** Count the records in a spool signal without claiming or parsing it. */
function countOtelLines(dir: string, base: string): number {
  let lines = 0;
  for (const path of otelSpoolFiles(dir, base)) {
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim() !== "") lines += 1;
      }
    } catch {
      /* raced with a rotation; the next sweep counts it */
    }
  }
  return lines;
}

/** Default for `otel_spool_retention_days` when the config row is absent. */
export const DEFAULT_OTEL_SPOOL_RETENTION_DAYS = 14;

/**
 * Reap the two spools nothing drains, by AGE.
 *
 * `otel-reject.jsonl` and `otel-raw.jsonl` are written by the receiver and read by a
 * human, so neither can be claim-and-deleted the way logs and metrics are — the bytes
 * ARE the artefact. But `SpoolWriter` rotates at 64 MiB and the ROTATED files were
 * reachable by nothing at all: with `--dump` left on, or a persistent mis-shaped
 * exporter, the spool directory grew without bound and no code path in this repository
 * could ever shrink it again.
 *
 * Two deliberate limits:
 *  - **Age, not total bytes.** A size quota deletes the NEWEST evidence under exactly
 *    the conditions that produced it (a flood), which is backwards.
 *  - **Rotated files only, never the live one.** The receiver holds an `O_APPEND` handle
 *    on the live file; unlinking it out from under that handle sends every subsequent
 *    record to an inode with no name, which is silent loss dressed up as housekeeping.
 *    A rotated file has already been closed, and the live file is bounded by rotation.
 */
export function pruneOtelSpool(dir: string, retentionDays: number, now: Date = new Date()): number {
  if (!(retentionDays > 0)) return 0;
  const cutoff = now.getTime() - retentionDays * 86400_000;
  let pruned = 0;
  for (const base of [OTEL_REJECT_FILE, OTEL_RAW_FILE]) {
    for (const path of otelSpoolFiles(dir, base)) {
      if (path.endsWith(`/${base}`)) continue; // the live file: still open in the receiver
      try {
        if (statSync(path).mtimeMs >= cutoff) continue;
        rmSync(path, { force: true });
        pruned += 1;
      } catch {
        // Raced with the receiver or already gone; the next sweep tries again.
      }
    }
  }
  return pruned;
}

/**
 * The attempt and duration `otel_request` held for these ids BEFORE this drain's upsert.
 *
 * Read in CHUNKS with one query per chunk rather than one query per id: the id list is
 * the size of a drain, and a per-row `SELECT` here is the per-item call in a hot path
 * that the rest of this file is careful not to make.
 */
function priorOtelState(
  db: Database,
  ids: readonly string[],
): Map<string, { attempt: number; duration_ms: number | null }> {
  const out = new Map<string, { attempt: number; duration_ms: number | null }>();
  for (const slice of chunks(ids)) {
    const rows = db
      .query<{ request_id: string; attempt: number; duration_ms: number | null }, string[]>(
        `SELECT request_id, COALESCE(attempt, 0) AS attempt, duration_ms FROM otel_request
          WHERE request_id IN (${placeholders(slice.length)})`,
      )
      .all(...slice);
    for (const r of rows) out.set(r.request_id, { attempt: r.attempt, duration_ms: r.duration_ms });
  }
  return out;
}

/** The `request` rows these ids already have, batched for the same reason. */
function existingRequests(
  db: Database,
  ids: readonly string[],
): Map<string, { origin: string; duration_ms: number | null }> {
  const out = new Map<string, { origin: string; duration_ms: number | null }>();
  for (const slice of chunks(ids)) {
    const rows = db
      .query<{ request_id: string; origin: string; duration_ms: number | null }, string[]>(
        `SELECT request_id, origin, duration_ms FROM request
          WHERE request_id IN (${placeholders(slice.length)})`,
      )
      .all(...slice);
    for (const r of rows) out.set(r.request_id, { origin: r.origin, duration_ms: r.duration_ms });
  }
  return out;
}

/** SQLITE_MAX_VARIABLE_NUMBER is 32766 on a modern build; 400 keeps a wide margin. */
const ID_CHUNK = 400;

function* chunks(ids: readonly string[]): Generator<string[]> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) yield ids.slice(i, i + ID_CHUNK);
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

export interface DrainOtelOptions {
  /** `config.otel_spool_retention_days`; the caller reads it, this module never opens config. */
  retentionDays?: number;
  now?: Date;
}

/**
 * Drain `spool/otel-*.jsonl` into `otel_request` / `otel_metric`, then perform the one
 * join OTEL is allowed to make. **Call INSIDE the sweep's transaction**; run
 * `cleanup()` only after it commits.
 */
export function drainOtel(db: Database, dir: string, options: DrainOtelOptions = {}): OtelIngestResult {
  const result = emptyOtelIngest();
  if (!existsSync(dir)) return result;

  const logs = claimAll(dir, OTEL_LOGS_FILE);
  const metrics = claimAll(dir, OTEL_METRICS_FILE);
  // Traces are ACCEPTED by the receiver so enabling the tracing beta is a settings
  // change, and consumed by nothing in Phase 2. Claimed and dropped rather than left:
  // an un-drained spool is not "reserved for later", it is a file that grows until the
  // disk says otherwise. The count is reported so "nothing consumes traces" stays a
  // visible fact.
  const traces = claimLines(dir, OTEL_TRACES_FILE);
  const claimed = [...logs.paths, ...metrics.paths, ...traces.paths];
  result.cleanup = (): void => {
    for (const p of claimed) rmSync(p, { force: true });
  };
  result.malformed = logs.malformed + metrics.malformed;
  result.traces_dropped = traces.lines;
  // Rejects are COUNTED, never claimed and never deleted here. The receiver's own
  // contract is that a body it could not classify is still on disk to write a parser
  // against, so draining it would destroy the artefact the anomaly points at; growth is
  // bounded by rotation plus `pruneOtelSpool` instead.
  result.rejects_read = countOtelLines(dir, OTEL_REJECT_FILE);
  result.spool_pruned = pruneOtelSpool(
    dir,
    options.retentionDays ?? DEFAULT_OTEL_SPOOL_RETENTION_DAYS,
    options.now ?? new Date(),
  );

  // ---- log records -> otel_request ---------------------------------------
  const upsert = db.prepare(UPSERT_OTEL_REQUEST_SQL);
  const seen = new Map<string, OtelLogRecord>();
  for (const rec of logs.records) {
    if (rec.sig !== "log") continue;
    result.logs_read += 1;
    if (rec.name !== "claude_code.api_request" && rec.name !== "claude_code.api_error") continue;
    const requestId = s(rec.attrs.request_id);
    // A request with no id cannot be joined, deduped or reconciled against anything.
    // It is counted as malformed rather than stored under an invented key.
    if (requestId === null) {
      result.malformed += 1;
      continue;
    }
    // Within one drain the higher attempt wins too, so the batch and the table agree.
    const prior = seen.get(requestId);
    if (prior !== undefined && (n(prior.attrs.attempt) ?? 0) >= (n(rec.attrs.attempt) ?? 0)) continue;
    seen.set(requestId, rec);
  }
  // Read BEFORE the upsert: "higher attempt wins" is an `otel_request` rule, and the
  // values this ingest already materialised into `request` on an EARLIER drain can only
  // be recognised as superseded by comparing against the attempt that produced them.
  // After the upsert that attempt is gone.
  const ids = [...seen.keys()];
  const priorOtel = priorOtelState(db, ids);
  const priorRequest = existingRequests(db, ids);
  for (const [requestId, rec] of seen) {
    upsert.run({
      $request_id: requestId,
      $session_id: s(rec.attrs["session.id"]),
      $prompt_id: s(rec.attrs["prompt.id"]),
      $message_uuid: s(rec.attrs["message.uuid"]),
      $client_request_id: s(rec.attrs.client_request_id),
      $model: s(rec.attrs.model),
      $query_source: s(rec.attrs.query_source),
      $ts: rec.ts,
      $received_at: rec.received_at,
      $duration_ms: n(rec.attrs.duration_ms),
      $cost_usd_micros: usdToMicros(rec.attrs.cost_usd),
      $in_tok: n(rec.attrs.input_tokens),
      $out_tok: n(rec.attrs.output_tokens),
      $cw_tok: n(rec.attrs.cache_creation_tokens),
      $cr_tok: n(rec.attrs.cache_read_tokens),
      $attempt: n(rec.attrs.attempt),
      $speed: s(rec.attrs.speed),
      $effort: s(rec.attrs.effort),
      $status_code: n(rec.attrs.status_code),
      $workflow_run_id: s(rec.attrs["workflow.run_id"]),
      $workflow_name: s(rec.attrs["workflow.name"]),
    } as never);
    result.otel_requests_upserted += 1;
  }

  // ---- metric records -> otel_metric --------------------------------------
  const insertMetric = db.prepare(INSERT_OTEL_METRIC_SQL);
  for (const rec of metrics.records) {
    if (rec.sig !== "metric") continue;
    result.metrics_read += 1;
    insertMetric.run({
      $metric: rec.metric,
      $ts: rec.ts,
      // A spool line written before these two existed carries neither, and '' is the
      // honest answer: it degrades to the OLD (narrower) identity for those rows rather
      // than inventing a digest that would claim a distinction nobody measured.
      $ts_nanos: typeof rec.ts_nanos === "string" ? rec.ts_nanos : "",
      $session_id: s(rec.attrs["session.id"]) ?? "",
      $model: s(rec.attrs.model) ?? "",
      $query_source: s(rec.attrs.query_source) ?? "",
      $token_type: s(rec.attrs.token_type) ?? s(rec.attrs.type) ?? "",
      $dim_digest: typeof rec.dim_digest === "string" ? rec.dim_digest : "",
      $value: rec.value,
      $unit: rec.unit,
      $temporality: rec.temporality,
      $received_at: rec.received_at,
    } as never);
    result.otel_metrics_inserted += 1;
  }

  // ---- auxiliary inserts, then the join ----------------------------------
  // Auxiliary FIRST: those rows must exist before `joined` is computed, or every
  // auxiliary request would be reported as unjoined on the sweep that discovered it.
  const insertAux = db.prepare(INSERT_AUXILIARY_SQL);
  const supersedeAux = db.prepare(SUPERSEDE_AUXILIARY_SQL);
  /** Ids where a strictly higher attempt arrived than the one already on file. */
  const superseded = new Set<string>();
  for (const [requestId, rec] of seen) {
    const prior = priorOtel.get(requestId);
    if (prior !== undefined && (n(rec.attrs.attempt) ?? 0) > prior.attempt) superseded.add(requestId);
  }
  for (const [requestId, rec] of seen) {
    if (s(rec.attrs.query_source) !== "auxiliary") continue;
    const sessionId = s(rec.attrs["session.id"]);
    const model = s(rec.attrs.model);
    // `request.session_id` is NOT NULL, and an auxiliary call the harness did not stamp
    // with one cannot be placed in any session. Skipped rather than filed under a
    // sentinel that would pollute every per-session sum.
    if (sessionId === null || model === null) continue;
    const existing = priorRequest.get(requestId);
    if (existing !== undefined && existing.origin === "auxiliary") {
      // OUR OWN earlier materialisation, not a transcript. A collision count that
      // included this would stop measuring transcript overlap and start measuring how
      // often retries straddle a sweep boundary — and the retro reads it as the former.
      if (superseded.has(requestId)) {
        supersedeAux.run({
          $request_id: requestId,
          $ts: rec.ts,
          $in_tok: n(rec.attrs.input_tokens) ?? 0,
          $out_tok: n(rec.attrs.output_tokens) ?? 0,
          $cw_tok: n(rec.attrs.cache_creation_tokens) ?? 0,
          $cr_tok: n(rec.attrs.cache_read_tokens) ?? 0,
          $duration_ms: n(rec.attrs.duration_ms),
        } as never);
        result.auxiliary_superseded += 1;
      }
      continue;
    }
    // Attempted for EVERY auxiliary record a transcript row might already cover — the
    // suppressed insert is the measurement. Filtering the collisions out with a
    // `NOT EXISTS` would make the count structurally zero and turn "auxiliary requests
    // never appear in transcripts" back into an assumption.
    const changes = Number(
      insertAux.run({
        $request_id: requestId,
        $session_id: sessionId,
        $prompt_id: s(rec.attrs["prompt.id"]),
        $model: model,
        $model_family: modelFamily(model),
        $ts: rec.ts,
        $in_tok: n(rec.attrs.input_tokens) ?? 0,
        $out_tok: n(rec.attrs.output_tokens) ?? 0,
        $cw_tok: n(rec.attrs.cache_creation_tokens) ?? 0,
        $cr_tok: n(rec.attrs.cache_read_tokens) ?? 0,
        $duration_ms: n(rec.attrs.duration_ms),
      } as never).changes ?? 0,
    );
    if (changes > 0) result.auxiliary_inserted += 1;
    else result.auxiliary_collisions += 1;
  }

  result.durations_filled = Number(db.query(FILL_DURATION_SQL).run().changes ?? 0);
  // …and then the retry correction the `IS NULL` guard above structurally cannot make.
  // Only ids whose `request.duration_ms` is still EXACTLY what the superseded attempt
  // reported: anything else is a transcript-owned value, which OTEL never overwrites.
  const refreshIds = [...superseded].filter((id) => {
    const prior = priorOtel.get(id);
    const row = priorRequest.get(id);
    if (prior === undefined || row === undefined) return false;
    if (prior.duration_ms === null || row.duration_ms === null) return false;
    if (row.duration_ms !== prior.duration_ms) return false;
    const fresh = n(seen.get(id)?.attrs.duration_ms);
    return fresh !== null && fresh !== row.duration_ms;
  });
  for (const slice of chunks(refreshIds)) {
    result.durations_refreshed += Number(
      db.query(refreshDurationSql(placeholders(slice.length))).run(...slice).changes ?? 0,
    );
  }
  db.query(MARK_JOINED_SQL).run();

  // ---- the three findings this receiver exists to produce -----------------
  result.unjoined =
    db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM otel_request WHERE joined = 0")
      .get()?.n ?? 0;
  if (result.unjoined > 0) {
    result.anomalies.push({
      kind: "otel_unjoined",
      // COUNT-FREE, for the reason `receiverDownAnomaly` spells out: `insertAnomalies`
      // dedups on (kind, detail), and this count is structurally never-zero on a live
      // corpus (records with no session.id are skipped above; a pruned transcript can
      // never be joined) and drifts UPWARD. Interpolating it wrote a fresh ledger row on
      // every sweep and pinned the sweep at exit 3 forever — "a ledger that cries wolf
      // is a ledger nobody reads" (§4.2), arrived at by accident. The number lives on
      // `result.unjoined` and in `est recon`, where a trend is readable.
      detail:
        "OTEL request(s) match no transcript row; this is join_pct's complement, and a RISING " +
        "count means the transcript corpus is being read incompletely — see `est recon` for the count and trend",
    });
  }

  // A counter that DIFFERS between the two sources is the single most valuable thing
  // this receiver can produce: an independent audit of the dedup chain, which §7.5
  // says nothing else in the system performs. Reported per request, never merged.
  //
  // The TOTAL and the SAMPLE are two queries on purpose. `mismatches` is capped at 50 so
  // one bad drain cannot write thousands of ledger rows; assigning its `.length` to the
  // reported total made the field saturate at 50 while sitting in the result beside
  // `unjoined`, which is a true COUNT(*) — a number that reads as a total and silently
  // is not is worse than no number.
  const MISMATCH_SAMPLE = 50;
  result.counter_mismatches =
    db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM v_otel_join
          WHERE joined = 1
            AND (COALESCE(d_in,0) <> 0 OR COALESCE(d_out,0) <> 0
              OR COALESCE(d_cw,0) <> 0 OR COALESCE(d_cr,0) <> 0)`,
      )
      .get()?.n ?? 0;
  const mismatches = db
    .query<
      { request_id: string; d_in: number; d_out: number; d_cw: number; d_cr: number },
      []
    >(
      // `ts DESC` rather than `request_id`: id order is stable, so the same first 50 ids
      // were sampled on every sweep forever and a mismatch on any later id could never
      // reach the ledger at all. Newest-first at least moves.
      `SELECT request_id, d_in, d_out, d_cw, d_cr FROM v_otel_join
        WHERE joined = 1
          AND (COALESCE(d_in,0) <> 0 OR COALESCE(d_out,0) <> 0
            OR COALESCE(d_cw,0) <> 0 OR COALESCE(d_cr,0) <> 0)
        ORDER BY ts DESC, request_id LIMIT ${MISMATCH_SAMPLE}`,
    )
    .all();
  for (const m of mismatches) {
    result.anomalies.push({
      kind: "otel_counter_mismatch",
      detail:
        `request ${m.request_id}: OTEL minus transcript = in ${m.d_in} / out ${m.d_out} / ` +
        `cw ${m.d_cw} / cr ${m.d_cr}; the transcript stays the source of truth and NOTHING was merged`,
    });
  }

  result.prompt_mismatches =
    db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM v_otel_join
          WHERE joined = 1 AND our_prompt_id IS NOT NULL AND otel_prompt_id IS NOT NULL
            AND our_prompt_id <> otel_prompt_id`,
      )
      .get()?.n ?? 0;
  const promptMismatches = db
    .query<{ request_id: string; ours: string; theirs: string }, []>(
      `SELECT request_id, our_prompt_id AS ours, otel_prompt_id AS theirs FROM v_otel_join
        WHERE joined = 1 AND our_prompt_id IS NOT NULL AND otel_prompt_id IS NOT NULL
          AND our_prompt_id <> otel_prompt_id
        ORDER BY ts DESC, request_id LIMIT ${MISMATCH_SAMPLE}`,
    )
    .all();
  for (const p of promptMismatches) {
    result.anomalies.push({
      kind: "otel_prompt_mismatch",
      detail:
        `request ${p.request_id}: our prompt_id ${p.ours} vs the harness's ${p.theirs}; ` +
        `ours is propagated forward from user lines (§5.3), so a non-trivial rate here means ` +
        `turn segmentation — which attribution and the interval union both rest on — is wrong`,
    });
  }

  if (result.malformed > 0) {
    result.anomalies.push({
      kind: "malformed_line",
      detail: `${result.malformed} unusable line(s) in the OTEL spool`,
    });
  }

  if (result.rejects_read > 0) {
    // The fourth leg of P2.3's "accept it, park it, count it, and let the sweeper raise
    // the anomaly" — declared in schema.sql since the table existed and pushed by
    // nothing, so a mis-shaped OTLP envelope was invisible to the ledger. COUNT-FREE for
    // the same dedup reason as `otel_unjoined` and `otel_receiver_down`: the reject
    // spool is not drained (the bytes ARE the artefact), so the tally only ever grows.
    result.anomalies.push({
      kind: "otel_reject",
      detail:
        "the receiver parked OTLP bodies it could not classify in `spool/otel-reject.jsonl` " +
        "(it answers 200 so the exporter does not retry a poison payload forever); read them and " +
        "extend the decoder — they are pruned by `otel_spool_retention_days` once rotated",
    });
  }

  return result;
}

/**
 * `anomaly(kind='otel_receiver_down')`: telemetry is configured and nothing has been
 * spooled for `otel_stale_min` minutes.
 *
 * The SWEEPER raises this, not the receiver — a process cannot report its own death,
 * and the sweeper is the component that already owns loud failures. Returns null when
 * telemetry is not configured at all, because "no receiver" is the documented
 * degrade-to-Phase-1 state and not a fault.
 */
export function receiverDownAnomaly(
  db: Database,
  telemetryConfigured: boolean,
  staleMinutes: number,
  now: Date = new Date(),
): IngestAnomaly | null {
  if (!telemetryConfigured) return null;
  const last = db
    .query<{ ts: string | null }, []>("SELECT MAX(received_at) AS ts FROM otel_request")
    .get()?.ts;
  const lastMetric = db
    .query<{ ts: string | null }, []>("SELECT MAX(received_at) AS ts FROM otel_metric")
    .get()?.ts;
  const newest = [last, lastMetric].filter((x): x is string => typeof x === "string").sort().pop();
  const ageMin =
    newest === undefined
      ? Number.POSITIVE_INFINITY
      : (now.getTime() - Date.parse(newest)) / 60000;
  if (ageMin < staleMinutes) return null;
  // The detail is deliberately FREE of the measured age: `insertAnomalies` dedups on
  // (kind, detail), and an age that ticks up by one minute per sweep would defeat it
  // and grow the ledger by a row per sweep for as long as the receiver stays down —
  // which is precisely the "a ledger that cries wolf is a ledger nobody reads" failure
  // §4.2 warns about, arrived at by accident.
  return {
    kind: "otel_receiver_down",
    detail:
      (newest === undefined
        ? "telemetry is configured in settings.json but NO OTEL record has ever been spooled"
        : `telemetry is configured but nothing has been spooled for at least ${staleMinutes} min`) +
      "; check `launchctl print gui/$(id -u)/com.craig.estimator.otel` and `curl -s http://127.0.0.1:4318/healthz`",
  };
}

/**
 * Is Claude Code actually exporting telemetry?
 *
 * Read from `~/.claude/settings.json` because that is where the `env` block lives and
 * because the answer decides whether SILENCE is a fault. With no telemetry configured
 * the whole phase degrades to Phase 1 by design (P2.0), and raising
 * `otel_receiver_down` in that state would be alerting on a decision rather than a
 * failure. Never throws: an unreadable or absent settings file reads as "not
 * configured", which is the conservative answer.
 */
export function telemetryConfigured(settingsPath?: string): boolean {
  const path =
    settingsPath ?? process.env.EST_SETTINGS_JSON ?? join(homedir(), ".claude", "settings.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { env?: Record<string, unknown> };
    const v = parsed.env?.CLAUDE_CODE_ENABLE_TELEMETRY;
    return v === "1" || v === 1 || v === true;
  } catch {
    return false;
  }
}

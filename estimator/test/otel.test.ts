/**
 * test/otel.test.ts — the OTLP/JSON decoder and the spool→database ingest (P2.3, P2.4).
 *
 * Every payload here is SYNTHETIC. No session id, request id, model name, token count
 * or cost in this file came from a real export, and none may: §4's committable/local
 * boundary applies to fixtures exactly as it applies to code.
 *
 * The four tests P2.13 mandates for this file, and the silent failure each one covers:
 *
 *  - **int64-as-string**: a quoted `timeUnixNano`/`intValue` must parse to the same
 *    value an unquoted one does. This is the #1 silent failure of a hand-rolled
 *    OTLP/JSON parser — `Number("1753...")` loses digits before any division happens
 *    and the corrupted result still looks like a timestamp.
 *  - **temporality**: a delta series sums, a cumulative series is differenced, and a
 *    mixed window is REFUSED (that one lives in `test/recon.test.ts`, where the summing
 *    happens).
 *  - **OTEL writes `duration_ms` and nothing else**: a token counter that disagrees
 *    becomes an anomaly, never a merge.
 *  - **auxiliary spend**: inserted, because it has no transcript row by construction —
 *    with the collision count that keeps that a measurement rather than an assumption.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { computeRecon } from "../src/recon.ts";
import {
  ALLOWED_ATTRS,
  decodeLogs,
  decodeMetrics,
  drainOtel,
  int64,
  nanosToIso,
  OTEL_LOGS_FILE,
  OTEL_METRICS_FILE,
  otelSpoolFiles,
  pruneOtelSpool,
  receiverDownAnomaly,
  telemetryConfigured,
  unwrapAnyValue,
  usdToMicros,
  type OtelLogRecord,
  type OtelMetricRecord,
} from "../src/otel.ts";

let dir: string;
let spool: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "estimator-otel-test-"));
  spool = join(dir, "spool");
  mkdirSync(spool, { recursive: true });
  db = openDb({ path: join(dir, "estimator.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const RECEIVED = "2026-03-01T12:00:05Z";

/** A `claude_code.api_request` log record in OTLP/JSON, with int64s QUOTED. */
function logsBody(
  attrs: Record<string, unknown>,
  opts: { nano?: string | number; name?: string | null; nameAsAttr?: boolean } = {},
): unknown {
  const kv = Object.entries(attrs).map(([key, value]) => ({ key, value }));
  const record: Record<string, unknown> = {
    timeUnixNano: opts.nano ?? "1772366400000000000",
    attributes: opts.nameAsAttr === true
      ? [...kv, { key: "event.name", value: { stringValue: opts.name ?? "claude_code.api_request" } }]
      : kv,
  };
  if (opts.nameAsAttr !== true && opts.name !== null) {
    record.eventName = opts.name ?? "claude_code.api_request";
  }
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.version", value: { stringValue: "test" } }] },
        scopeLogs: [{ logRecords: [record] }],
      },
    ],
  };
}

function str(v: string): unknown {
  return { stringValue: v };
}
function int(v: string): unknown {
  return { intValue: v };
}
function dbl(v: number): unknown {
  return { doubleValue: v };
}

function writeSpool(file: string, records: ReadonlyArray<OtelLogRecord | OtelMetricRecord>): void {
  writeFileSync(join(spool, file), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

function logRecord(attrs: Record<string, string | number | boolean>, ts = "2026-03-01T12:00:00Z"): OtelLogRecord {
  return { sig: "log", name: "claude_code.api_request", ts, received_at: RECEIVED, attrs };
}

function request(id: string, over: Record<string, unknown> = {}): void {
  db.query(
    `INSERT INTO request (request_id, message_id, is_sidechain, session_id, prompt_id, origin,
                          agent_id, run_id, wf_launch_id, model, model_family,
                          attribution_agent, attribution_skill, ts,
                          in_tok, out_tok, cw_tok, cr_tok, duration_ms, tid, attr)
     VALUES ($rid, NULL, 0, $sid, $pid, $origin, NULL, NULL, NULL, $model, $model,
             NULL, NULL, $ts, $in, $out, $cw, $cr, $dur, NULL, 'none')`,
  ).run({
    $rid: id,
    $sid: over.session_id ?? "s1",
    $pid: over.prompt_id ?? "p1",
    $origin: over.origin ?? "main",
    $model: over.model ?? "claude-test-1",
    $ts: over.ts ?? "2026-03-01T12:00:00Z",
    $in: over.in_tok ?? 0,
    $out: over.out_tok ?? 0,
    $cw: over.cw_tok ?? 0,
    $cr: over.cr_tok ?? 0,
    $dur: over.duration_ms ?? null,
  } as never);
}

// ---------------------------------------------------------------------------
// scalars — the four things a hand-rolled OTLP/JSON parser gets wrong
// ---------------------------------------------------------------------------

describe("int64 as a JSON string", () => {
  test("a quoted nanosecond timestamp parses to the same instant an unquoted one does", () => {
    // The MANDATED test (P2.13). 1772366400000000000 ns = 2026-03-01T12:00:00Z, and
    // the value is well past Number.MAX_SAFE_INTEGER (9007199254740991).
    const quoted = nanosToIso("1772366400000000000");
    expect(quoted).toBe("2026-03-01T12:00:00Z");
    expect(nanosToIso(1772366400000000000)).toBe(quoted);
  });

  test("nanosecond precision is not lost to a float division", () => {
    // Number("1772366400123456789") rounds to ...123456768 BEFORE any division: the
    // naive parse is off by a fraction of a millisecond here and by more as the
    // magnitude grows. Truncation to whole seconds is what makes this observable at
    // all, so the test asserts the exact instant rather than "close enough".
    expect(nanosToIso("1772366400999999999")).toBe("2026-03-01T12:00:00Z");
    expect(nanosToIso("1772366401000000000")).toBe("2026-03-01T12:00:01Z");
  });

  test("a quoted intValue parses exactly, and an unrepresentable one is refused", () => {
    expect(int64("12345")).toBe(12345);
    expect(int64(12345)).toBe(12345);
    // Beyond 2^53 there is no exact double. A wrong number is worse than no number.
    expect(int64("9007199254740993")).toBeNull();
    expect(int64("not-a-number")).toBeNull();
    expect(int64("")).toBeNull();
  });

  test("a non-numeric timestamp yields null rather than the epoch", () => {
    expect(nanosToIso("")).toBeNull();
    expect(nanosToIso(undefined)).toBeNull();
    expect(nanosToIso("2026-03-01T12:00:00Z")).toBeNull();
  });
});

describe("the anyValue unwrapper", () => {
  test("unwraps every scalar shape the wire uses", () => {
    expect(unwrapAnyValue(str("x"))).toBe("x");
    expect(unwrapAnyValue(int("7"))).toBe(7);
    expect(unwrapAnyValue(dbl(1.5))).toBe(1.5);
    expect(unwrapAnyValue({ boolValue: false })).toBe(false);
    expect(unwrapAnyValue({ arrayValue: { values: [str("a"), int("2")] } })).toBe('["a",2]');
  });

  test("an unknown wrapper is null, not a stringified object", () => {
    expect(unwrapAnyValue({ bytesValue: "AA==" })).toBeNull();
    expect(unwrapAnyValue(null)).toBeNull();
    expect(unwrapAnyValue("bare")).toBeNull();
  });
});

describe("usd -> integer micros", () => {
  test("money is stored as integer micros, so a sum cannot accumulate float error", () => {
    expect(usdToMicros(0.000123)).toBe(123);
    expect(usdToMicros(1.5)).toBe(1500000);
    expect(usdToMicros(-1)).toBeNull();
    expect(usdToMicros(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

describe("decodeLogs", () => {
  test("reads the event name from the LogRecord field", () => {
    const r = decodeLogs(logsBody({ request_id: str("r1") }), RECEIVED);
    expect(r.rejected).toBe(0);
    expect(r.records[0]?.name).toBe("claude_code.api_request");
    expect(r.records[0]?.ts).toBe("2026-03-01T12:00:00Z");
    expect(r.records[0]?.received_at).toBe(RECEIVED);
  });

  test("reads it from an `event.name` ATTRIBUTE when the field is absent", () => {
    // Which one arrives depends on SDK vintage; accepting only one silently drops the
    // entire corpus produced by the other.
    const r = decodeLogs(logsBody({ request_id: str("r1") }, { nameAsAttr: true }), RECEIVED);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.name).toBe("claude_code.api_request");
  });

  test("a record with NEITHER a name nor a timestamp is REJECTED, not guessed at", () => {
    const r = decodeLogs(logsBody({ request_id: str("r1") }, { name: null }), RECEIVED);
    expect(r.records).toHaveLength(0);
    expect(r.rejected).toBe(1);
  });

  test("`organization.id` is not allowlisted, and never reaches a decoded record", () => {
    // It WAS, and it reached `attrs`, and the receiver wrote it verbatim to the spool —
    // while being read by no column, no view and no report. An account-scoped identifier
    // with no consumer is exactly the class the account-UUID exclusion was about, and an
    // allowlist whose entries nobody reads has stopped being a privacy boundary.
    const r = decodeLogs(
      logsBody({
        request_id: str("r1"),
        "organization.id": str("00000000-0000-0000-0000-000000000000"),
        "app.version": str("9.9.9"),
        "terminal.type": str("test-term"),
      }),
      RECEIVED,
    );
    const attrs = r.records[0]?.attrs ?? {};
    expect(attrs["organization.id"]).toBeUndefined();
    expect(attrs["app.version"]).toBeUndefined();
    expect(attrs["terminal.type"]).toBeUndefined();
    expect(ALLOWED_ATTRS.has("organization.id")).toBe(false);
  });

  test("every allowlisted attribute has a consumer — the set is pinned, not append-only", () => {
    // The list below is the boundary. A new entry has to be argued for HERE, next to the
    // column or decode decision that reads it, rather than added to a set nobody diffs.
    expect([...ALLOWED_ATTRS].sort()).toEqual([
      "attempt",
      "cache_creation_tokens",
      "cache_read_tokens",
      "client_request_id",
      "cost_usd",
      "duration_ms",
      "effort",
      "input_tokens",
      "message.uuid",
      "model",
      "output_tokens",
      "prompt.id",
      "query_source",
      "request_id",
      "session.id",
      "speed",
      "status_code",
      "token_type",
      "type",
      "workflow.name",
      "workflow.run_id",
    ]);
  });

  test("an attribute outside the allowlist never reaches the spool", () => {
    // The privacy mechanism, not an optimisation: OTEL_LOG_USER_PROMPTS and friends
    // default off, but a default can change upstream and an allowlist cannot.
    const r = decodeLogs(
      logsBody({
        request_id: str("r1"),
        prompt: str("the user's actual words"),
        "user.prompt": str("the user's actual words"),
        model: str("claude-test-1"),
      }),
      RECEIVED,
    );
    const attrs = r.records[0]?.attrs ?? {};
    expect(attrs.model).toBe("claude-test-1");
    expect(attrs.prompt).toBeUndefined();
    expect(attrs["user.prompt"]).toBeUndefined();
    expect(ALLOWED_ATTRS.has("prompt")).toBe(false);
  });

  test("resource attributes are merged, and a record-level attribute of the same name wins", () => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: "session.id", value: str("resource-session") }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "claude_code.api_request",
                  timeUnixNano: "1772366400000000000",
                  attributes: [
                    { key: "request_id", value: str("r1") },
                    { key: "session.id", value: str("record-session") },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(decodeLogs(body, RECEIVED).records[0]?.attrs["session.id"]).toBe("record-session");
  });

  test("an empty or malformed envelope decodes to nothing rather than throwing", () => {
    expect(decodeLogs({}, RECEIVED).records).toHaveLength(0);
    expect(decodeLogs(null, RECEIVED).records).toHaveLength(0);
    expect(decodeLogs({ resourceLogs: "nope" }, RECEIVED).records).toHaveLength(0);
  });
});

describe("decodeMetrics", () => {
  const metricBody = (
    name: string,
    points: unknown[],
    temporality: unknown,
    shape: "sum" | "gauge" = "sum",
  ): unknown => ({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name,
                unit: "USD",
                [shape]: shape === "sum" ? { aggregationTemporality: temporality, dataPoints: points } : { dataPoints: points },
              },
            ],
          },
        ],
      },
    ],
  });

  const point = (value: number, attrs: Array<{ key: string; value: unknown }> = []): unknown => ({
    timeUnixNano: "1772366400000000000",
    asDouble: value,
    attributes: attrs,
  });

  test("DELTA is labelled delta and CUMULATIVE is labelled cumulative", () => {
    expect(decodeMetrics(metricBody("claude_code.cost.usage", [point(1)], 1), RECEIVED).records[0]?.temporality).toBe(
      "delta",
    );
    expect(decodeMetrics(metricBody("claude_code.cost.usage", [point(1)], 2), RECEIVED).records[0]?.temporality).toBe(
      "cumulative",
    );
    // The enum may arrive spelled out rather than numeric.
    expect(
      decodeMetrics(
        metricBody("claude_code.cost.usage", [point(1)], "AGGREGATION_TEMPORALITY_DELTA"),
        RECEIVED,
      ).records[0]?.temporality,
    ).toBe("delta");
  });

  test("a GAUGE is 'unspecified' — it has no temporality and its points are not summable", () => {
    const r = decodeMetrics(metricBody("claude_code.active_time.total", [point(5)], 1, "gauge"), RECEIVED);
    expect(r.records[0]?.temporality).toBe("unspecified");
  });

  test("an integer point arrives as a QUOTED asInt and parses exactly", () => {
    const body = metricBody("claude_code.token.usage", [
      { timeUnixNano: "1772366400000000000", asInt: "4096", attributes: [{ key: "type", value: str("input") }] },
    ], 1);
    const r = decodeMetrics(body, RECEIVED);
    expect(r.records[0]?.value).toBe(4096);
    expect(r.records[0]?.attrs.type).toBe("input");
  });

  test("a histogram (no sum, no gauge) is rejected rather than flattened", () => {
    const body = {
      resourceMetrics: [
        { scopeMetrics: [{ metrics: [{ name: "x", histogram: { dataPoints: [{}] } }] }] },
      ],
    };
    const r = decodeMetrics(body, RECEIVED);
    expect(r.records).toHaveLength(0);
    expect(r.rejected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ingest — the join, and the boundary on it
// ---------------------------------------------------------------------------

describe("drainOtel", () => {
  test("fills request.duration_ms and NOTHING else", () => {
    // The INVARIANT (P2.4). OTEL disagrees with the transcript on every counter here;
    // the transcript must win on all of them and OTEL must still supply the duration.
    request("r1", { in_tok: 10, out_tok: 20, cw_tok: 30, cr_tok: 40, origin: "main" });
    writeSpool(OTEL_LOGS_FILE, [
      logRecord({
        request_id: "r1",
        "session.id": "s1",
        duration_ms: 1234,
        input_tokens: 999,
        output_tokens: 999,
        cache_creation_tokens: 999,
        cache_read_tokens: 999,
        query_source: "main",
        model: "claude-test-1",
      }),
    ]);
    const r = drainOtel(db, spool);
    r.cleanup();

    const row = db
      .query<
        { duration_ms: number | null; in_tok: number; out_tok: number; cw_tok: number; cr_tok: number; origin: string },
        []
      >("SELECT duration_ms, in_tok, out_tok, cw_tok, cr_tok, origin FROM request WHERE request_id='r1'")
      .get();
    expect(row?.duration_ms).toBe(1234);
    expect(row?.in_tok).toBe(10);
    expect(row?.out_tok).toBe(20);
    expect(row?.cw_tok).toBe(30);
    expect(row?.cr_tok).toBe(40);
    expect(row?.origin).toBe("main");
    expect(r.durations_filled).toBe(1);

    // …and the disagreement is REPORTED, per request, per counter.
    expect(r.counter_mismatches).toBe(1);
    const anomaly = r.anomalies.find((a) => a.kind === "otel_counter_mismatch");
    expect(anomaly?.detail).toContain("r1");
    expect(anomaly?.detail).toContain("NOTHING was merged");
  });

  test("never overwrites a duration the transcript already had", () => {
    request("r1", { duration_ms: 500 });
    writeSpool(OTEL_LOGS_FILE, [logRecord({ request_id: "r1", "session.id": "s1", duration_ms: 9999 })]);
    drainOtel(db, spool).cleanup();
    expect(
      db.query<{ d: number }, []>("SELECT duration_ms AS d FROM request WHERE request_id='r1'").get()?.d,
    ).toBe(500);
  });

  test("the HIGHER attempt wins on conflict, whether it arrives first or second", () => {
    // A retried call reports twice and the last attempt produced the billed result.
    writeSpool(OTEL_LOGS_FILE, [
      logRecord({ request_id: "r1", attempt: 2, duration_ms: 200 }),
      logRecord({ request_id: "r1", attempt: 1, duration_ms: 100 }),
    ]);
    drainOtel(db, spool).cleanup();
    expect(
      db.query<{ d: number }, []>("SELECT duration_ms AS d FROM otel_request WHERE request_id='r1'").get()?.d,
    ).toBe(200);

    writeSpool(OTEL_LOGS_FILE, [logRecord({ request_id: "r1", attempt: 3, duration_ms: 300 })]);
    drainOtel(db, spool).cleanup();
    expect(
      db.query<{ d: number }, []>("SELECT duration_ms AS d FROM otel_request WHERE request_id='r1'").get()?.d,
    ).toBe(300);

    // A LOWER attempt on a later drain must not win it back.
    writeSpool(OTEL_LOGS_FILE, [logRecord({ request_id: "r1", attempt: 1, duration_ms: 111 })]);
    drainOtel(db, spool).cleanup();
    expect(
      db.query<{ d: number }, []>("SELECT duration_ms AS d FROM otel_request WHERE request_id='r1'").get()?.d,
    ).toBe(300);
  });

  test("auxiliary spend is INSERTED, because it has no transcript row by construction", () => {
    writeSpool(OTEL_LOGS_FILE, [
      logRecord({
        request_id: "aux-1",
        "session.id": "s1",
        query_source: "auxiliary",
        model: "claude-haiku-test-20260101",
        output_tokens: 12,
        duration_ms: 40,
      }),
    ]);
    const r = drainOtel(db, spool);
    r.cleanup();
    expect(r.auxiliary_inserted).toBe(1);
    const row = db
      .query<{ origin: string; attr: string; family: string; tid: string | null; out_tok: number }, []>(
        "SELECT origin, attr, model_family AS family, tid, out_tok FROM request WHERE request_id='aux-1'",
      )
      .get();
    expect(row?.origin).toBe("auxiliary");
    expect(row?.attr).toBe("none");
    expect(row?.tid).toBeNull();
    // The dated alias collapses to the pricing family, like every other request row.
    expect(row?.family).toBe("claude-haiku-test");
    expect(row?.out_tok).toBe(12);
  });

  test("an auxiliary request that DOES have a transcript row is counted, not overwritten", () => {
    // "auxiliary requests never appear in transcripts" stays a number in the retro
    // rather than an assumption in the code.
    request("aux-1", { out_tok: 5, origin: "main" });
    writeSpool(OTEL_LOGS_FILE, [
      logRecord({ request_id: "aux-1", "session.id": "s1", query_source: "auxiliary", model: "m", output_tokens: 99 }),
    ]);
    const r = drainOtel(db, spool);
    r.cleanup();
    expect(r.auxiliary_inserted).toBe(0);
    expect(r.auxiliary_collisions).toBe(1);
    const row = db
      .query<{ origin: string; out_tok: number }, []>(
        "SELECT origin, out_tok FROM request WHERE request_id='aux-1'",
      )
      .get();
    expect(row?.origin).toBe("main");
    expect(row?.out_tok).toBe(5);
  });

  test("a retry on a LATER drain supersedes the auxiliary row the first attempt materialised", () => {
    // The gap the `seen` map hides: WITHIN one drain the higher attempt already wins, so
    // the two attempts have to land in different drains for the bug to show. Attempt 1
    // materialises the request row; attempt 2 wins in `otel_request` under "higher
    // attempt wins" and used to leave `request` on the losing attempt's numbers forever,
    // because ON CONFLICT DO NOTHING cannot update — an 8900-token, 44 s divergence that
    // v_wcet's spend and windowIntervals()'s active seconds both read from the wrong side.
    const aux = (attempt: number, inTok: number, dur: number): Record<string, string | number> => ({
      request_id: "aux-retry",
      "session.id": "s1",
      query_source: "auxiliary",
      model: "claude-test-1",
      attempt,
      input_tokens: inTok,
      duration_ms: dur,
    });

    writeSpool(OTEL_LOGS_FILE, [logRecord(aux(1, 100, 1000))]);
    const first = drainOtel(db, spool);
    first.cleanup();
    expect(first.auxiliary_inserted).toBe(1);
    expect(first.auxiliary_collisions).toBe(0);

    writeSpool(OTEL_LOGS_FILE, [logRecord(aux(2, 9000, 45000))]);
    const second = drainOtel(db, spool);
    second.cleanup();
    expect(second.auxiliary_superseded).toBe(1);
    // …and NOT counted as a collision: that counter measures transcript overlap, and a
    // retry landing on our own row would inflate the one number that keeps "auxiliary
    // requests never appear in transcripts" a measurement.
    expect(second.auxiliary_collisions).toBe(0);
    expect(second.auxiliary_inserted).toBe(0);

    expect(
      db
        .query<{ in_tok: number; duration_ms: number | null }, []>(
          "SELECT in_tok, duration_ms FROM request WHERE request_id='aux-retry'",
        )
        .get(),
    ).toEqual({ in_tok: 9000, duration_ms: 45000 });
  });

  test("a retry on a LATER drain refreshes a duration OTEL itself filled", () => {
    request("r1"); // duration_ms NULL: the transcript did not carry one
    writeSpool(OTEL_LOGS_FILE, [
      logRecord({ request_id: "r1", "session.id": "s1", attempt: 1, duration_ms: 1000 }),
    ]);
    const first = drainOtel(db, spool);
    first.cleanup();
    expect(first.durations_filled).toBe(1);

    writeSpool(OTEL_LOGS_FILE, [
      logRecord({ request_id: "r1", "session.id": "s1", attempt: 2, duration_ms: 45000 }),
    ]);
    const second = drainOtel(db, spool);
    second.cleanup();
    // `WHERE duration_ms IS NULL` fills once and never again, so this reported 0 and left
    // request.duration_ms at 1000 against otel_request.duration_ms of 45000.
    expect(second.durations_filled).toBe(0);
    expect(second.durations_refreshed).toBe(1);
    expect(
      db.query<{ d: number }, []>("SELECT duration_ms AS d FROM request WHERE request_id='r1'").get()?.d,
    ).toBe(45000);
  });

  test("a HIGHER attempt still never overwrites a duration the TRANSCRIPT supplied", () => {
    // The other half of the invariant: the refresh is allowed only where `request` still
    // holds exactly what the superseded attempt reported. A transcript-owned value does
    // not match, so it stands — P2.4's boundary survives the retry correction.
    request("r1", { duration_ms: 500 });
    writeSpool(OTEL_LOGS_FILE, [
      logRecord({ request_id: "r1", "session.id": "s1", attempt: 1, duration_ms: 1000 }),
    ]);
    drainOtel(db, spool).cleanup();
    writeSpool(OTEL_LOGS_FILE, [
      logRecord({ request_id: "r1", "session.id": "s1", attempt: 2, duration_ms: 45000 }),
    ]);
    const second = drainOtel(db, spool);
    second.cleanup();
    expect(second.durations_refreshed).toBe(0);
    expect(
      db.query<{ d: number }, []>("SELECT duration_ms AS d FROM request WHERE request_id='r1'").get()?.d,
    ).toBe(500);
  });

  test("an OTEL request with no transcript match is reported as unjoined", () => {
    writeSpool(OTEL_LOGS_FILE, [logRecord({ request_id: "ghost", "session.id": "s9", query_source: "main" })]);
    const r = drainOtel(db, spool);
    r.cleanup();
    expect(r.unjoined).toBe(1);
    expect(r.anomalies.some((a) => a.kind === "otel_unjoined")).toBe(true);
  });

  test("three sweeps with a GROWING unjoined count write exactly ONE ledger row", () => {
    // The detail used to interpolate the count, and `insertAnomalies` dedups on
    // (kind, detail): a count that is structurally never-zero and drifts upward wrote a
    // fresh row on every sweep and pinned the sweep at exit 3 forever. The sibling
    // `receiverDownAnomaly` documents this exact trap and keeps its measured age out.
    const details = new Set<string>();
    for (let i = 1; i <= 3; i += 1) {
      writeSpool(OTEL_LOGS_FILE, [logRecord({ request_id: `ghost-${i}`, "session.id": "s9" })]);
      const r = drainOtel(db, spool);
      r.cleanup();
      expect(r.unjoined).toBe(i); // the COUNT still climbs — it is the report's job
      const detail = r.anomalies.find((a) => a.kind === "otel_unjoined")?.detail;
      expect(detail).toBeDefined();
      details.add(detail as string);
    }
    expect(details.size).toBe(1);
    expect([...details][0]).not.toMatch(/\d/);
  });

  test("counter_mismatches is the TRUE count, not the size of the 50-row sample", () => {
    // It was `mismatches.length` against a `LIMIT 50` query, sitting in the result beside
    // `unjoined` — which IS a true COUNT(*) — with nothing marking it a sample. Seeded
    // above the cap, the reported figure saturated while the real one kept going.
    const records = [];
    for (let i = 0; i < 60; i += 1) {
      const id = `r${String(i).padStart(3, "0")}`;
      request(id, { in_tok: 1 });
      records.push(logRecord({ request_id: id, "session.id": "s1", input_tokens: 999 }));
    }
    writeSpool(OTEL_LOGS_FILE, records);
    const r = drainOtel(db, spool);
    r.cleanup();
    expect(r.counter_mismatches).toBe(60);
    // The ANOMALY sample stays capped, so one bad drain cannot write 60 ledger rows.
    expect(r.anomalies.filter((a) => a.kind === "otel_counter_mismatch")).toHaveLength(50);
  });

  test("a prompt_id disagreement is an anomaly — the two are stamped by different code", () => {
    request("r1", { prompt_id: "p-ours" });
    writeSpool(OTEL_LOGS_FILE, [
      logRecord({ request_id: "r1", "session.id": "s1", "prompt.id": "p-theirs" }),
    ]);
    const r = drainOtel(db, spool);
    r.cleanup();
    expect(r.prompt_mismatches).toBe(1);
    expect(r.anomalies.find((a) => a.kind === "otel_prompt_mismatch")?.detail).toContain("p-ours");
  });

  test("metric rows dedup on re-drain — the NOT NULL sentinels do their job", () => {
    const m: OtelMetricRecord = {
      sig: "metric",
      metric: "claude_code.cost.usage",
      ts: "2026-03-01T12:00:00Z",
      received_at: RECEIVED,
      value: 0.5,
      unit: "USD",
      temporality: "delta",
      // No session.id, no model: every dimension falls to its '' sentinel. Under
      // nullable columns SQLite would treat each NULL as DISTINCT and every re-drain
      // would insert a fresh duplicate — the §4.2 delta-6 trap.
      attrs: {},
      ts_nanos: "1772366400000000000",
      dim_digest: "deadbeefdeadbeef",
    };
    writeSpool(OTEL_METRICS_FILE, [m]);
    drainOtel(db, spool).cleanup();
    writeSpool(OTEL_METRICS_FILE, [m]);
    drainOtel(db, spool).cleanup();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM otel_metric").get()?.n).toBe(1);
    expect(
      db.query<{ s: string; m: string }, []>("SELECT session_id AS s, model AS m FROM otel_metric").get(),
    ).toEqual({ s: "", m: "" });
  });

  test("two distinct series in the same SECOND are two rows, not one overwriting the other", () => {
    // `collectAttrs` drops every non-allowlisted attribute, so `tool`/`decision` never
    // reach `attrs`; `nanosToIso` truncates to seconds, so points 250 ms apart share a
    // `ts`. Under the old primary key both points collapsed to ONE row and the DO UPDATE
    // overwrote rather than summed: `otel_metrics_inserted` said 2 and the table held 5
    // against a true total of 12. Decoded through the real decoder, because the digest is
    // computed there and a hand-written fixture would not exercise it.
    const point = (
      nano: string,
      value: number,
      tool: string,
      decision: string,
    ): unknown => ({
      timeUnixNano: nano,
      asInt: String(value),
      attributes: [
        { key: "tool", value: str(tool) },
        { key: "decision", value: str(decision) },
      ],
    });
    const body = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.code_edit_tool.decision",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      point("1772366400000000000", 7, "Edit", "accept"),
                      point("1772366400250000000", 5, "Write", "reject"),
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const decoded = decodeMetrics(body, RECEIVED);
    expect(decoded.records).toHaveLength(2);
    expect(decoded.records[0]?.ts).toBe(decoded.records[1]?.ts); // same truncated second
    expect(decoded.records[0]?.dim_digest).not.toBe(decoded.records[1]?.dim_digest);

    writeSpool(OTEL_METRICS_FILE, decoded.records);
    drainOtel(db, spool).cleanup();
    expect(
      db
        .query<{ n: number; total: number }, []>(
          "SELECT COUNT(*) AS n, SUM(value) AS total FROM otel_metric",
        )
        .get(),
    ).toEqual({ n: 2, total: 12 });

    // …and a re-drain of the SAME points is still idempotent: identity is what the DO
    // UPDATE keys on, and widening it must not turn a replay into a double count.
    writeSpool(OTEL_METRICS_FILE, decoded.records);
    drainOtel(db, spool).cleanup();
    expect(
      db
        .query<{ n: number; total: number }, []>(
          "SELECT COUNT(*) AS n, SUM(value) AS total FROM otel_metric",
        )
        .get(),
    ).toEqual({ n: 2, total: 12 });
  });

  test("reject bodies are COUNTED and raise one count-free anomaly, and are not deleted", () => {
    // `otel_reject` was declared in schema.sql and in the anomaly-kind union and pushed by
    // NOTHING, while the receiver dutifully parked bodies nobody read — the fourth leg of
    // P2.3's "accept it, park it, count it, and let the sweeper raise the anomaly".
    writeFileSync(
      join(spool, "otel-reject.jsonl"),
      `${JSON.stringify({ ts: RECEIVED, signal: "logs", reason: "unparseable JSON", body: "{oops" })}\n`,
      "utf8",
    );
    const r = drainOtel(db, spool);
    r.cleanup();
    expect(r.rejects_read).toBe(1);
    // Not counted as `malformed`: a working reject spool must not read as a broken log spool.
    expect(r.malformed).toBe(0);
    expect(r.anomalies.filter((a) => a.kind === "otel_reject")).toHaveLength(1);
    // The bytes SURVIVE the drain — they are the artefact the anomaly points at.
    expect(readFileSync(join(spool, "otel-reject.jsonl"), "utf8")).toContain("oops");

    const again = drainOtel(db, spool);
    again.cleanup();
    // Count-free, so the ledger's (kind, detail) dedup collapses every sweep to one row.
    expect(again.anomalies.find((a) => a.kind === "otel_reject")?.detail).toBe(
      r.anomalies.find((a) => a.kind === "otel_reject")?.detail,
    );
  });

  test("the trace spool is claimed and dropped rather than growing forever", () => {
    writeFileSync(
      join(spool, "otel-traces.jsonl"),
      `${JSON.stringify({ sig: "trace", received_at: RECEIVED, body: 42 })}\n`,
      "utf8",
    );
    const r = drainOtel(db, spool);
    r.cleanup();
    expect(r.traces_dropped).toBe(1);
    expect(r.malformed).toBe(0);
    expect(otelSpoolFiles(spool, "otel-traces.jsonl")).toHaveLength(0);
  });

  test("rotated reject/raw files are reaped by age; the LIVE file never is", () => {
    const rotated = join(spool, "otel-raw.2026-01-01T00-00-00Z.jsonl");
    const live = join(spool, "otel-raw.jsonl");
    writeFileSync(rotated, "{}\n", "utf8");
    writeFileSync(live, "{}\n", "utf8");
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(rotated, old, old);
    utimesSync(live, old, old);

    expect(pruneOtelSpool(spool, 14, new Date("2026-03-01T00:00:00Z"))).toBe(1);
    expect(existsSync(rotated)).toBe(false);
    // The receiver holds an O_APPEND handle on the live file; unlinking it out from under
    // that handle sends every later record to an inode with no name.
    expect(existsSync(live)).toBe(true);
    // A retention of 0 disables the reaper entirely rather than deleting everything.
    expect(pruneOtelSpool(spool, 0, new Date("2036-01-01T00:00:00Z"))).toBe(0);
  });

  test("a malformed spool line is counted, never fatal", () => {
    writeFileSync(join(spool, OTEL_LOGS_FILE), '{"sig":"log"\nnot json\n', "utf8");
    const r = drainOtel(db, spool);
    r.cleanup();
    expect(r.malformed).toBeGreaterThan(0);
    expect(r.anomalies.some((a) => a.kind === "malformed_line")).toBe(true);
  });

  test("the drain claims by rename, so a crash before cleanup loses nothing", () => {
    writeSpool(OTEL_LOGS_FILE, [logRecord({ request_id: "r1" })]);
    const r = drainOtel(db, spool); // deliberately NOT cleaned up: simulate a crash
    expect(readFileSync(join(spool, `${OTEL_LOGS_FILE}.draining`), "utf8")).toContain("r1");
    // The next sweep finds the residue FIRST and finishes it.
    expect(otelSpoolFiles(spool, OTEL_LOGS_FILE)[0]).toContain(".draining");
    r.cleanup();
    expect(otelSpoolFiles(spool, OTEL_LOGS_FILE)).toHaveLength(0);
  });

  test("rotated files drain before the live one, so time order survives rotation", () => {
    const files = ["otel-logs.2026-03-01T00-00-00Z.jsonl", OTEL_LOGS_FILE, "otel-logs.jsonl.draining"];
    for (const f of files) writeFileSync(join(spool, f), "", "utf8");
    expect(otelSpoolFiles(spool, OTEL_LOGS_FILE).map((p) => p.split("/").pop())).toEqual([
      "otel-logs.jsonl.draining",
      "otel-logs.2026-03-01T00-00-00Z.jsonl",
      "otel-logs.jsonl",
    ]);
  });

  test("a missing spool directory is a no-op, not an error", () => {
    const r = drainOtel(db, join(dir, "nope"));
    expect(r.logs_read).toBe(0);
    expect(r.anomalies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// join_pct — the clause that stops self-certification, and the rows that used to
// let the ingest certify itself
// ---------------------------------------------------------------------------

describe("auxiliary rows and join_pct", () => {
  test("a drain of pure auxiliary spend cannot move join_pct", () => {
    // The rows OTEL inserts are joined BY CONSTRUCTION — MARK_JOINED_SQL finds the
    // `request` row the same drain just created — and `v_request_live` includes them, so
    // they landed in both the numerator and the denominator. Ten transcript requests of
    // which OTEL saw five is 50% coverage; a routine drain of 90 auxiliary records used
    // to report 95%, which is exactly `unvalidated_min_join_pct`'s floor, on data the
    // estimator synthesised.
    const window = { window: "2026-02-01T00:00:00Z/2026-04-01T00:00:00Z" };
    for (let i = 0; i < 10; i += 1) request(`t${i}`, { origin: "main" });
    writeSpool(
      OTEL_LOGS_FILE,
      Array.from({ length: 5 }, (_, i) => logRecord({ request_id: `t${i}`, "session.id": "s1" })),
    );
    drainOtel(db, spool).cleanup();
    const before = computeRecon(db, window);
    expect(before.join_pct).toBe(50);

    writeSpool(
      OTEL_LOGS_FILE,
      Array.from({ length: 90 }, (_, i) =>
        logRecord({
          request_id: `aux${i}`,
          "session.id": "s1",
          query_source: "auxiliary",
          model: "claude-test-1",
        }),
      ),
    );
    const drain = drainOtel(db, spool);
    drain.cleanup();
    expect(drain.auxiliary_inserted).toBe(90);

    const after = computeRecon(db, window);
    expect(after.join_pct).toBe(50);
    // The requests AXIS still counts them — it is comparing our request count to OTEL's,
    // and hiding rows there would move a different number for a different reason.
    expect(after.n_our_requests).toBe(100);
    expect(after.n_join_denom).toBe(10);
    expect(after.n_auxiliary_requests).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// the sweeper's watchdog
// ---------------------------------------------------------------------------

describe("receiverDownAnomaly", () => {
  test("says nothing when telemetry is not configured — that is the documented degrade", () => {
    expect(receiverDownAnomaly(db, false, 15)).toBeNull();
  });

  test("fires when telemetry is configured and nothing has ever been spooled", () => {
    const a = receiverDownAnomaly(db, true, 15);
    expect(a?.kind).toBe("otel_receiver_down");
    expect(a?.detail).toContain("NO OTEL record has ever been spooled");
  });

  test("stays quiet while records are arriving, and the detail carries NO ticking age", () => {
    const now = new Date("2026-03-01T12:00:00Z");
    db.query(
      `INSERT INTO otel_request (request_id, ts, received_at) VALUES ('r1','2026-03-01T11:59:00Z','2026-03-01T11:59:00Z')`,
    ).run();
    expect(receiverDownAnomaly(db, true, 15, now)).toBeNull();

    const later = new Date("2026-03-01T13:00:00Z");
    const a = receiverDownAnomaly(db, true, 15, later);
    const b = receiverDownAnomaly(db, true, 15, new Date("2026-03-01T14:00:00Z"));
    expect(a).not.toBeNull();
    // `insertAnomalies` dedups on (kind, detail). An age in the message would defeat
    // that and grow the ledger by a row per sweep for as long as the receiver is down.
    expect(a?.detail).toBe(b?.detail);
  });
});

describe("telemetryConfigured", () => {
  test("reads the env block, and an absent or unreadable file is 'not configured'", () => {
    const settings = join(dir, "settings.json");
    expect(telemetryConfigured(settings)).toBe(false);
    writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" } }), "utf8");
    expect(telemetryConfigured(settings)).toBe(true);
    writeFileSync(settings, JSON.stringify({ env: {} }), "utf8");
    expect(telemetryConfigured(settings)).toBe(false);
    writeFileSync(settings, "{ not json", "utf8");
    expect(telemetryConfigured(settings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wiring — the drain has to actually run inside a sweep
// ---------------------------------------------------------------------------

describe("the sweep reports the OTEL drain", () => {
  test("`est sweep --json` carries the otel block, zeroed when no receiver has ever run", async () => {
    // The degrade-to-Phase-1 state (P2.0), asserted rather than assumed: with no
    // receiver every field reads 0, nothing errors and the exit code is unchanged.
    const emptyRoot = join(dir, "projects");
    mkdirSync(emptyRoot, { recursive: true });
    const { run } = await import("../src/cli.ts");
    const out: string[] = [];
    const code = await run(
      ["--db", join(dir, "estimator.db"), "--lock", join(dir, "sweep.lock"), "sweep", "--root", emptyRoot, "--json"],
      { out: (s) => out.push(s), err: () => {} },
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n")) as { otel: Record<string, number> };
    expect(report.otel).toEqual({
      logs_read: 0,
      metrics_read: 0,
      requests_upserted: 0,
      metrics_inserted: 0,
      durations_filled: 0,
      durations_refreshed: 0,
      auxiliary_inserted: 0,
      auxiliary_superseded: 0,
      auxiliary_collisions: 0,
      unjoined: 0,
      counter_mismatches: 0,
      prompt_mismatches: 0,
      malformed: 0,
      rejects_read: 0,
      traces_dropped: 0,
      spool_pruned: 0,
    });
  });
});

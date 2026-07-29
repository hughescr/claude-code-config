/**
 * test/otel-receiver.test.ts — the OTLP/HTTP receiver's response contract (P2.3).
 *
 * The handler is driven directly rather than over a socket: `createReceiver()` returns
 * the exact function `Bun.serve` calls, so these tests exercise the shipped code path
 * without binding a port (and without a test that fails on a busy machine).
 *
 * The mandated test here (P2.13) is **fail-open**: an unparseable body must produce a
 * `200` and a parked copy, not a 4xx. The peer is an exporter that retries; a 4xx makes
 * it retry the same poison payload forever, turning one bad record into an unbounded
 * write loop against Craig's disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiver, SpoolWriter, type Receiver } from "../scripts/otel-receiver.ts";
import { OTEL_LOGS_FILE, OTEL_METRICS_FILE, OTEL_RAW_FILE, OTEL_REJECT_FILE, otelSpoolFiles } from "../src/otel.ts";

let dir: string;
let receiver: Receiver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "estimator-receiver-test-"));
  receiver = createReceiver({ spoolDir: dir });
});

afterEach(() => {
  receiver.close();
  rmSync(dir, { recursive: true, force: true });
});

function post(path: string, body: string, ctype = "application/json"): Promise<Response> {
  return receiver.handle(
    new Request(`http://127.0.0.1:4318${path}`, {
      method: "POST",
      headers: { "content-type": ctype },
      body,
    }),
  );
}

/**
 * A body with NO `content-length` — the shape a chunked OTLP export arrives in, and the
 * one the header pre-check by construction cannot bound.
 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function spoolLines(file: string): string[] {
  const path = join(dir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
}

const LOGS_BODY = JSON.stringify({
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: [
            {
              eventName: "claude_code.api_request",
              timeUnixNano: "1772366400000000000",
              attributes: [
                { key: "request_id", value: { stringValue: "r1" } },
                { key: "duration_ms", value: { intValue: "1234" } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe("the response contract", () => {
  test("a well-formed export is 200 with an EMPTY OTLP success body", () => {
    return post("/v1/logs", LOGS_BODY).then(async (res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      // OTLP success is an empty Export*ServiceResponse, not an arbitrary 2xx body.
      expect(await res.json()).toEqual({});
      expect(spoolLines(OTEL_LOGS_FILE)).toHaveLength(1);
      expect(receiver.stats.received.logs).toBe(1);
    });
  });

  test("an UNPARSEABLE body is 200, parked and counted — never a retry storm", async () => {
    // The MANDATED test (P2.13). A 4xx here would make the exporter resend the same
    // bytes forever; accept, park, count, and let the sweeper raise the anomaly.
    const res = await post("/v1/logs", "{ this is not json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(receiver.stats.rejected).toBe(1);
    const parked = spoolLines(OTEL_REJECT_FILE);
    expect(parked).toHaveLength(1);
    // INTACT: the point of the reject spool is that the bytes are still there to write
    // a parser against.
    expect(JSON.parse(parked[0]!).body).toBe("{ this is not json");
    expect(spoolLines(OTEL_LOGS_FILE)).toHaveLength(0);
  });

  test("a body that parses but classifies to nothing is ALSO 200 and parked", async () => {
    const res = await post(
      "/v1/logs",
      JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [] }] }] }] }),
    );
    expect(res.status).toBe(200);
    expect(receiver.stats.rejected).toBe(1);
    expect(JSON.parse(spoolLines(OTEL_REJECT_FILE)[0]!).reason).toContain("unclassifiable");
  });

  test("a wrong content type is 415 — a mis-set OTEL_EXPORTER_OTLP_PROTOCOL must be visible", async () => {
    const res = await post("/v1/logs", LOGS_BODY, "application/x-protobuf");
    expect(res.status).toBe(415);
    expect(spoolLines(OTEL_LOGS_FILE)).toHaveLength(0);
  });

  test("an oversized body is 413, by declared length and by actual length", async () => {
    const small = createReceiver({ spoolDir: dir, maxBodyBytes: 16 });
    try {
      const byHeader = await small.handle(
        new Request("http://127.0.0.1:4318/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": "1048576" },
          body: "x".repeat(8),
        }),
      );
      expect(byHeader.status).toBe(413);
      // A lying or absent Content-Length must not get past the cap either: memory is
      // bounded by what we actually read, always.
      const byBody = await small.handle(
        new Request("http://127.0.0.1:4318/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(64),
        }),
      );
      expect(byBody.status).toBe(413);

      // NO content-length at all — a chunked export. `Number(null)` is NaN and
      // `Number("")` is 0, so the header check cannot speak to this case; the read
      // itself has to be the bound.
      const chunked = await small.handle(
        new Request("http://127.0.0.1:4318/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: streamOf("x".repeat(64)),
          duplex: "half",
        }),
      );
      expect(chunked.status).toBe(413);

      // BYTES, not UTF-16 code units. Eight `中` are 8 units and 24 bytes; the cap is
      // 16. Comparing `text.length` let a multi-byte body up to 3× the cap through.
      const wide = await small.handle(
        new Request("http://127.0.0.1:4318/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: streamOf("中".repeat(8)),
          duplex: "half",
        }),
      );
      expect(wide.status).toBe(413);

      // …and a body that fits in BYTES is still accepted, so the cap did not just
      // become "refuse everything".
      const fits = await small.handle(
        new Request("http://127.0.0.1:4318/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: streamOf("中".repeat(4)), // 12 bytes
          duplex: "half",
        }),
      );
      expect(fits.status).toBe(200);
    } finally {
      small.close();
    }
  });

  test("an unknown path is 404 — which is exactly what a doubled /v1/logs suffix looks like", async () => {
    // OTEL_EXPORTER_OTLP_ENDPOINT with a path suffix produces `…/v1/logs/v1/logs`.
    expect((await post("/v1/logs/v1/logs", LOGS_BODY)).status).toBe(404);
    expect((await post("/", LOGS_BODY)).status).toBe(404);
    const get = await receiver.handle(new Request("http://127.0.0.1:4318/v1/logs"));
    expect(get.status).toBe(404);
  });

  test("metrics and traces have their own spool files, and traces are accepted but not parsed", async () => {
    await post(
      "/v1/metrics",
      JSON.stringify({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "claude_code.cost.usage",
                    unit: "USD",
                    sum: {
                      aggregationTemporality: 1,
                      dataPoints: [{ timeUnixNano: "1772366400000000000", asDouble: 0.25 }],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(spoolLines(OTEL_METRICS_FILE)).toHaveLength(1);
    expect(JSON.parse(spoolLines(OTEL_METRICS_FILE)[0]!).temporality).toBe("delta");

    // /v1/traces exists so enabling the tracing beta later is a settings change, not a
    // code change. Phase 2 consumes nothing from it.
    const res = await post("/v1/traces", JSON.stringify({ resourceSpans: [] }));
    expect(res.status).toBe(200);
    expect(receiver.stats.received.traces).toBe(1);
  });
});

describe("/healthz", () => {
  test("reports counters with no side effects — the endpoint `est otel --status` will read", async () => {
    await post("/v1/logs", LOGS_BODY);
    await post("/v1/logs", "nonsense");
    const res = await receiver.handle(new Request("http://127.0.0.1:4318/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      received: { logs: number };
      rejected: number;
      dropped: number;
      last_write_ts: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.received.logs).toBe(1);
    expect(body.rejected).toBe(1);
    expect(body.dropped).toBe(0);
    expect(body.last_write_ts).not.toBeNull();
  });

  /**
   * The port is a DIAGNOSTIC, and a diagnostic that reports the env default while the
   * socket is somewhere else describes a receiver other than the one answering. Pinned
   * against the socket, never against `EST_OTEL_PORT`.
   */
  test("reports the port it was actually given, not the env default", async () => {
    const previous = process.env.EST_OTEL_PORT;
    process.env.EST_OTEL_PORT = "4318";
    const moved = createReceiver({ spoolDir: dir, port: 4321 });
    try {
      const body = (await (await moved.handle(new Request("http://127.0.0.1:4321/healthz"))).json()) as {
        port: number;
      };
      expect(body.port).toBe(4321);
      // `main()` overwrites the seed with `server.port` once the socket exists.
      moved.boundPort = 4399;
      const after = (await (await moved.handle(new Request("http://127.0.0.1:4399/healthz"))).json()) as {
        port: number;
      };
      expect(after.port).toBe(4399);
    } finally {
      moved.close();
      if (previous === undefined) delete process.env.EST_OTEL_PORT;
      else process.env.EST_OTEL_PORT = previous;
    }
  });

  /** A stalled sweeper is only visible from outside the database as a growing spool. */
  test("reports spool_bytes, counting rotated files", async () => {
    const empty = (await (await receiver.handle(new Request("http://127.0.0.1:4318/healthz"))).json()) as {
      spool_bytes: number;
    };
    expect(empty.spool_bytes).toBe(0);

    await post("/v1/logs", LOGS_BODY);
    const live = (await (await receiver.handle(new Request("http://127.0.0.1:4318/healthz"))).json()) as {
      spool_bytes: number;
    };
    expect(live.spool_bytes).toBeGreaterThan(0);

    // A backlog is exactly what rotation produces, so a rotated file must count.
    writeFileSync(join(dir, "otel-logs.2026-01-01T00-00-00Z.jsonl"), "x".repeat(1000));
    const rotated = (await (await receiver.handle(new Request("http://127.0.0.1:4318/healthz"))).json()) as {
      spool_bytes: number;
    };
    expect(rotated.spool_bytes).toBe(live.spool_bytes + 1000);
  });
});

describe("--dump", () => {
  test("parks raw bodies while the window is open and stops when it closes", async () => {
    const dumping = createReceiver({ spoolDir: dir, dumpUntil: Date.now() + 60_000 });
    try {
      await dumping.handle(
        new Request("http://127.0.0.1:4318/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: LOGS_BODY,
        }),
      );
      // The raw file is what the parser gets written against: the OTLP/JSON envelope
      // this harness emits is documented but was never observed on this machine.
      expect(JSON.parse(spoolLines(OTEL_RAW_FILE)[0]!).body).toBe(LOGS_BODY);
    } finally {
      dumping.close();
    }

    const expired = createReceiver({ spoolDir: join(dir, "b"), dumpUntil: Date.now() - 1 });
    try {
      await expired.handle(
        new Request("http://127.0.0.1:4318/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: LOGS_BODY,
        }),
      );
      expect(existsSync(join(dir, "b", OTEL_RAW_FILE))).toBe(false);
    } finally {
      expired.close();
    }
  });

  /**
   * `--dump` at LAUNCH time is no use once launchd owns the process: restarting it to
   * observe an envelope loses the export interval you were trying to see. `POST /dump`
   * is the same switch reachable from `est otel --dump <seconds>`.
   */
  test("POST /dump arms raw parking on a receiver that is ALREADY running", async () => {
    const armed = await receiver.handle(
      new Request("http://127.0.0.1:4318/dump?seconds=60", { method: "POST" }),
    );
    expect(armed.status).toBe(200);
    expect(((await armed.json()) as { dump_until: string | null }).dump_until).not.toBeNull();

    await post("/v1/logs", LOGS_BODY);
    expect(JSON.parse(spoolLines(OTEL_RAW_FILE)[0]!).body).toBe(LOGS_BODY);

    // …and `seconds=0` turns it off again. Raw bodies are prompt text on disk, so
    // "armed until someone remembers" is not a state this may be left in.
    const off = await receiver.handle(
      new Request("http://127.0.0.1:4318/dump?seconds=0", { method: "POST" }),
    );
    expect(((await off.json()) as { dump_until: string | null }).dump_until).toBeNull();
    await post("/v1/logs", LOGS_BODY);
    expect(spoolLines(OTEL_RAW_FILE)).toHaveLength(1);
  });

  test("the dump window is BOUNDED — an unbounded one writes prompts to disk forever", async () => {
    for (const bad of ["seconds=99999", "seconds=-1", "seconds=forever", ""]) {
      const res = await receiver.handle(
        new Request(`http://127.0.0.1:4318/dump?${bad}`, { method: "POST" }),
      );
      expect(res.status).toBe(400);
    }
    // /healthz reports the armed state, so an operator can SEE that prompt text is
    // being written rather than having to remember arming it.
    const before = (await (await receiver.handle(new Request("http://127.0.0.1:4318/healthz"))).json()) as {
      dump_until: string | null;
    };
    expect(before.dump_until).toBeNull();
    await receiver.handle(new Request("http://127.0.0.1:4318/dump?seconds=30", { method: "POST" }));
    const after = (await (await receiver.handle(new Request("http://127.0.0.1:4318/healthz"))).json()) as {
      dump_until: string | null;
    };
    expect(after.dump_until).not.toBeNull();
  });
});

describe("SpoolWriter", () => {
  test("rotates at the byte cap, and the rotated file drains BEFORE the live one", () => {
    const w = new SpoolWriter(dir, OTEL_LOGS_FILE, 32);
    try {
      w.write("x".repeat(40)); // over the cap in one line -> rotate after writing
      w.write("second");
      const files = otelSpoolFiles(dir, OTEL_LOGS_FILE).map((p) => p.split("/").pop() ?? "");
      expect(files).toHaveLength(2);
      expect(files[0]).toMatch(/^otel-logs\.\d{4}-\d{2}-\d{2}T/);
      expect(files[1]).toBe(OTEL_LOGS_FILE);
      // Nothing is lost across the rotation: the first record is in the rotated file
      // and the second in the live one.
      expect(readFileSync(join(dir, files[0]!), "utf8")).toContain("x".repeat(40));
      expect(readFileSync(join(dir, OTEL_LOGS_FILE), "utf8")).toContain("second");
    } finally {
      w.close();
    }
  });

  /**
   * The one that lost every record after the first sweep.
   *
   * A descriptor follows the INODE, not the path. `drainOtel` claims the live spool by
   * renaming it to `.draining` and `rmSync`s it once the transaction commits — so a
   * writer that trusts a non-null `fd` forever goes on appending, successfully and with
   * nothing counted as dropped, into an inode nothing will ever read again. launchd
   * keeps this process alive indefinitely, so "after the first sweep" meant "until
   * someone noticed", and the only symptom was `otel_receiver_down` firing at a
   * receiver that was demonstrably up.
   */
  test("follows the PATH across the sweeper's rename+unlink claim", () => {
    const live = join(dir, OTEL_LOGS_FILE);
    const w = new SpoolWriter(dir, OTEL_LOGS_FILE, 1024 * 1024);
    try {
      expect(w.write("before")).toBe(true);

      // Exactly what a sweep does: claim the live file, read it, delete it.
      const claimed = join(dir, `${OTEL_LOGS_FILE}.draining`);
      renameSync(live, claimed);
      rmSync(claimed);
      expect(existsSync(live)).toBe(false);

      expect(w.write("after")).toBe(true);
      // The record is in the LIVE file, not in a deleted inode.
      expect(existsSync(live)).toBe(true);
      expect(readFileSync(live, "utf8")).toContain("after");
      // …and the byte counter was re-seeded from the new file, so rotation still
      // measures the file it is about to rotate.
      expect(readFileSync(live, "utf8")).not.toContain("before");
    } finally {
      w.close();
    }
  });

  test("a bare rename (rotation by someone else) also reopens", () => {
    const live = join(dir, OTEL_LOGS_FILE);
    const w = new SpoolWriter(dir, OTEL_LOGS_FILE, 1024 * 1024);
    try {
      w.write("first");
      renameSync(live, join(dir, "otel-logs.2026-01-01T00-00-00Z.jsonl"));
      w.write("second");
      expect(readFileSync(live, "utf8").trim()).toBe("second");
    } finally {
      w.close();
    }
  });

  test("a write to an impossible path is DROPPED and reported, never buffered", () => {
    // The failure mode of an unattended process holding telemetry in RAM is worse than
    // the failure mode of losing it.
    // A regular FILE where the writer expects a directory: `mkdirSync` fails, the write
    // is refused, and the caller counts a drop.
    writeFileSync(join(dir, "a-file-not-a-dir"), "block", "utf8");
    const w = new SpoolWriter(join(dir, "a-file-not-a-dir"), "x.jsonl", 1024);
    expect(w.write("dropped")).toBe(false);
    w.close();
  });
});

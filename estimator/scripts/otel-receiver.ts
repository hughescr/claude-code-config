#!/usr/bin/env bun
/**
 * scripts/otel-receiver.ts — the OTLP/HTTP receiver (P2.3).
 *
 * A long-lived `Bun.serve` that accepts Claude Code's OTLP/JSON export and appends one
 * line per record to `spool/otel-*.jsonl`. Started by launchd
 * (`com.craig.estimator.otel`), never by a hook and never by hand on the hot path.
 *
 *   bun run scripts/otel-receiver.ts               # serve
 *   bun run scripts/otel-receiver.ts --dump 600    # ALSO park raw bodies for 600 s
 *   bun run scripts/otel-receiver.ts --port 4319
 *
 * ## Three properties this file is responsible for
 *
 * 1. **It NEVER opens the database.** P1.10/P1.11's rule extended to a long-lived
 *    unattended process: it must never contend for the writer lock, so it writes only
 *    to the spool and the sweeper stays the single writer. The consequence is visible
 *    here — `otel_max_body_mb` is a `config` row that this process cannot read, so the
 *    cap arrives as `EST_OTEL_MAX_BODY_MB` (the plist passes it) with the same default
 *    as the seed. A receiver that opened the database to read one integer would be
 *    trading the entire single-writer story for a tuning knob.
 *
 * 2. **It binds 127.0.0.1 EXPLICITLY.** Never `0.0.0.0`, never a hostname that could
 *    resolve off-loopback. This process accepts unauthenticated JSON and writes it to
 *    disk; the only acceptable peer is a process on this machine.
 *
 * 3. **A response is a FLOW-CONTROL decision, not a courtesy.** The peer is an
 *    exporter that RETRIES. An unparseable body therefore gets **200**, with the raw
 *    bytes parked in `otel-reject.jsonl` and a counter incremented — a 4xx/5xx would
 *    make the exporter retry the same poison payload forever, which converts one bad
 *    record into an unbounded write loop. The cases that DO get an error code are the
 *    ones where retrying is the correct behaviour or where silence would hide a
 *    misconfiguration: a wrong content type (415, a mis-set
 *    `OTEL_EXPORTER_OTLP_PROTOCOL` must be visible), an oversized body (413, bounded
 *    memory always) and an unknown path (404, which is what a `…/v1/logs/v1/logs`
 *    double-suffix looks like).
 *
 * Exit: 0 on clean shutdown (SIGTERM/SIGINT) · non-zero on bind failure. A receiver
 * silently listening on another port is a receiver whose data nobody finds.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/db.ts";
import {
  decodeLogs,
  decodeMetrics,
  isoNow,
  OTEL_LOGS_FILE,
  OTEL_METRICS_FILE,
  OTEL_RAW_FILE,
  OTEL_REJECT_FILE,
  OTEL_TRACES_FILE,
  rotatedName,
} from "../src/otel.ts";
import { spoolDirFrom } from "../src/spool.ts";

export const DEFAULT_PORT = 4318;
/** Matches the `otel_max_body_mb` config seed; the plist passes the tuned value. */
export const DEFAULT_MAX_BODY_MB = 8;
/** A drain must always read bounded files, and a stalled sweeper must not produce an unreadable one. */
export const DEFAULT_SPOOL_MAX_BYTES = 64 * 1024 * 1024;
/**
 * Ceiling on `POST /dump`, one hour. Raw bodies are prompts, file paths and tool
 * arguments written to disk in the clear; the mode exists to observe ONE session's
 * envelope and then stop, so the API refuses to leave it on indefinitely.
 */
export const MAX_DUMP_SECONDS = 3600;

export type Signal = "logs" | "metrics" | "traces";

export interface ReceiverOptions {
  spoolDir?: string;
  maxBodyBytes?: number;
  spoolMaxBytes?: number;
  /** Park raw request bodies in `otel-raw.jsonl` until this instant (`--dump <seconds>`). */
  dumpUntil?: number;
  /**
   * The port `/healthz` reports. Only a SEED: `main()` overwrites it with the socket's
   * actual `server.port` once `Bun.serve` has bound, because that is the only number a
   * diagnostic may print. Reporting the env/default instead makes `--port 4321` answer
   * "4318" — a health check that describes a receiver other than the one answering it.
   */
  port?: number;
  now?: () => Date;
}

export interface ReceiverStats {
  received: Record<Signal, number>;
  rejected: number;
  dropped: number;
  lastWriteTs: string | null;
}

/**
 * An append-only spool writer with rotation.
 *
 * One `O_APPEND` handle per file, held open: the cost of reopening per request is
 * paid on every export interval forever, and `O_APPEND` makes each `write` atomic
 * against the sweeper's `rename()` claim without a lock. If a write FAILS the record
 * is dropped and counted — never buffered in memory without a bound, because the
 * failure mode of an unattended process holding telemetry in RAM is worse than the
 * failure mode of losing it.
 */
export class SpoolWriter {
  private fd: number | null = null;
  private bytes = 0;
  /** Identity of the inode {@link fd} was opened on; 0 when nothing is open. */
  private dev = 0;
  private ino = 0;

  constructor(
    private readonly dir: string,
    private readonly base: string,
    private readonly maxBytes: number,
  ) {}

  /** Returns false when the record was dropped; the caller counts it. */
  write(line: string): boolean {
    try {
      this.ensureOpen();
      const buf = Buffer.from(`${line}\n`, "utf8");
      writeSync(this.fd as number, buf);
      this.bytes += buf.byteLength;
      if (this.bytes >= this.maxBytes) this.rotate();
      return true;
    } catch {
      this.closeQuietly();
      return false;
    }
  }

  close(): void {
    this.closeQuietly();
  }

  /**
   * Open the live file, or REOPEN it when the handle we hold no longer refers to it.
   *
   * The revalidation is the whole point. `O_APPEND` makes each `write` atomic against
   * the sweeper's `rename()` claim, but atomicity is not identity: a descriptor follows
   * the INODE, not the path, so once `drainOtel` renamed `otel-logs.jsonl` to
   * `.draining` and `rmSync`'d it after the commit, this writer went on appending —
   * successfully, with no error and nothing counted as dropped — into an unlinked inode
   * that no drain would ever read again. Every record after the FIRST sweep was lost,
   * for the life of a process launchd keeps alive indefinitely, and the only external
   * symptom was `otel_receiver_down` firing while `/healthz` reported a healthy climb.
   *
   * One `stat` of the path per record, compared against the identity recorded at open:
   * a missing file (ENOENT) is the same signal as a different inode, and both mean
   * "reopen". Cheap enough to do unconditionally — a syscall per spooled record against
   * a write that is already a syscall — and any cheaper scheme is a window in which
   * telemetry disappears silently, which is the failure this exists to end.
   */
  private ensureOpen(): void {
    if (this.fd !== null && this.stillLive()) return;
    this.closeQuietly();
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, this.base);
    this.fd = openSync(path, "a");
    const st = fstatSync(this.fd);
    this.bytes = st.size;
    this.dev = st.dev;
    this.ino = st.ino;
  }

  /** Does `dir/base` still name the inode {@link fd} is open on? */
  private stillLive(): boolean {
    try {
      const live = statSync(join(this.dir, this.base));
      return live.dev === this.dev && live.ino === this.ino;
    } catch {
      return false; // ENOENT — claimed, rotated or removed under us
    }
  }

  /**
   * Rotate the live file out from under the appender. The sweeper drains rotated
   * files in name order BEFORE the live one, so time order survives the rotation.
   */
  private rotate(): void {
    this.closeQuietly();
    try {
      const from = join(this.dir, this.base);
      if (existsSync(from)) renameSync(from, join(this.dir, rotatedName(this.base)));
    } catch {
      // A failed rotation is not a failed receive: the next write reopens the live
      // file and it simply grows past the threshold until the rename can succeed.
    }
    this.bytes = 0;
  }

  private closeQuietly(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      /* already gone */
    }
    this.fd = null;
    this.dev = 0;
    this.ino = 0;
  }
}

const SPOOL_FILE: Record<Signal, string> = {
  logs: OTEL_LOGS_FILE,
  metrics: OTEL_METRICS_FILE,
  traces: OTEL_TRACES_FILE,
};

export interface Receiver {
  handle: (req: Request) => Promise<Response>;
  stats: ReceiverStats;
  close: () => void;
  startedAt: number;
  /** Mutable on purpose — `main()` writes the bound port here after `Bun.serve`. */
  boundPort: number;
}

/**
 * Bytes currently sitting in the spool, live files and rotated ones alike.
 *
 * `/healthz` is the ONLY place a stalled sweeper is visible from outside the database:
 * the receiver keeps appending whether or not anything drains, so a spool that is
 * growing without bound is the receiver's single most useful health signal and it had
 * no reading. Rotated files count — they are exactly what a backlog looks like — and a
 * file that vanished between `readdir` and `stat` reads as 0 rather than throwing,
 * because a health endpoint that can fail is one more thing to diagnose.
 */
export function spoolBytes(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // no spool directory yet: nothing spooled
  }
  for (const name of names) {
    if (!name.startsWith("otel-")) continue;
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // raced with a rotation or the sweeper's claim; the next poll sees the truth
    }
  }
  return total;
}

/**
 * Build the request handler and its writers. Exported without a listening socket so a
 * test can drive the exact code path the server does, and so `Bun.serve` below owns
 * nothing but the socket.
 */
export function createReceiver(options: ReceiverOptions = {}): Receiver {
  const dir = options.spoolDir ?? spoolDirFrom(process.env, ROOT);
  const maxBody = options.maxBodyBytes ?? envInt("EST_OTEL_MAX_BODY_MB", DEFAULT_MAX_BODY_MB) * 1024 * 1024;
  const spoolMax = options.spoolMaxBytes ?? envInt("EST_OTEL_SPOOL_MAX_BYTES", DEFAULT_SPOOL_MAX_BYTES);
  const now = options.now ?? ((): Date => new Date());

  const writers: Record<Signal, SpoolWriter> = {
    logs: new SpoolWriter(dir, SPOOL_FILE.logs, spoolMax),
    metrics: new SpoolWriter(dir, SPOOL_FILE.metrics, spoolMax),
    traces: new SpoolWriter(dir, SPOOL_FILE.traces, spoolMax),
  };
  const rejects = new SpoolWriter(dir, OTEL_REJECT_FILE, spoolMax);
  const raw = new SpoolWriter(dir, OTEL_RAW_FILE, spoolMax);

  const stats: ReceiverStats = {
    received: { logs: 0, metrics: 0, traces: 0 },
    rejected: 0,
    dropped: 0,
    lastWriteTs: null,
  };
  const startedAt = Date.now();
  // Seeded from the env/default so a receiver driven directly by a test still reports
  // something truthful; `main()` replaces it with the socket's own port.
  const state = {
    boundPort: options.port ?? envInt("EST_OTEL_PORT", DEFAULT_PORT),
    // MUTABLE, because the only receiver anybody needs to put into dump mode is one
    // that is ALREADY RUNNING. `--dump` is the launch-time form and is no use once
    // launchd owns the process: stopping and restarting it to observe an envelope
    // loses exactly the export interval you were trying to see. `POST /dump` — which
    // `est otel --dump <seconds>` calls — is the same switch reachable from outside.
    dumpUntil: options.dumpUntil ?? 0,
  };

  const emit = (signal: Signal, line: string): void => {
    if (writers[signal].write(line)) {
      stats.received[signal] += 1;
      stats.lastWriteTs = isoNow(now());
    } else {
      stats.dropped += 1;
    }
  };

  const reject = (signal: Signal, body: string, reason: string): void => {
    // INTACT, not summarised, and now actually intact: the body reaching this point has
    // already been bounded by `maxBody` (default `otel_max_body_mb` = 8 MiB, 413 above
    // that), so the extra `.slice(0, 1_000_000)` that used to sit here truncated up to
    // seven eighths of a legal body — silently discarding exactly the tail a parser
    // would be written against, two lines below a comment promising it was kept.
    if (!rejects.write(JSON.stringify({ ts: isoNow(now()), signal, reason, body }))) {
      stats.dropped += 1;
    }
    stats.rejected += 1;
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json({
        ok: true,
        pid: process.pid,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        port: state.boundPort,
        received: stats.received,
        rejected: stats.rejected,
        dropped: stats.dropped,
        spool_dir: dir,
        spool_bytes: spoolBytes(dir),
        last_write_ts: stats.lastWriteTs,
        dump_until: state.dumpUntil === 0 ? null : isoNow(new Date(state.dumpUntil)),
      });
    }

    // Arm (or disarm, at `seconds=0`) raw-body parking on a receiver that is already
    // running. BOUNDED at {@link MAX_DUMP_SECONDS}: raw bodies are prompts and file
    // paths on disk in the clear, so "on until someone remembers" is not an option this
    // endpoint is allowed to offer.
    if (req.method === "POST" && url.pathname === "/dump") {
      // EXPLICIT, always: an omitted `seconds` is a caller that has not decided, and
      // defaulting it either way is this endpoint guessing about writing prompt text to
      // disk. `seconds=0` is how you say "off".
      const raw = url.searchParams.get("seconds");
      const seconds = raw === null ? Number.NaN : Number(raw);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DUMP_SECONDS) {
        return json({ error: `seconds must be a number in 0..${MAX_DUMP_SECONDS}` }, 400);
      }
      state.dumpUntil = seconds === 0 ? 0 : Date.now() + seconds * 1000;
      return json({
        ok: true,
        dump_until: state.dumpUntil === 0 ? null : isoNow(new Date(state.dumpUntil)),
      });
    }

    const signal: Signal | null =
      url.pathname === "/v1/logs"
        ? "logs"
        : url.pathname === "/v1/metrics"
          ? "metrics"
          : url.pathname === "/v1/traces"
            ? "traces"
            : null;
    if (signal === null || req.method !== "POST") {
      // 404 rather than a guess. `OTEL_EXPORTER_OTLP_ENDPOINT` with a path suffix
      // produces `…/v1/logs/v1/logs`, which is indistinguishable from a dead receiver
      // unless this code refuses it loudly.
      return json({ error: "not found" }, 404);
    }

    const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!ctype.includes("application/json")) {
      // Never guess at protobuf: a mis-set OTEL_EXPORTER_OTLP_PROTOCOL must be visible
      // as an error rather than silently producing an empty corpus.
      return json({ error: "this receiver speaks OTLP/JSON only; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json" }, 415);
    }

    // A cheap early out ONLY, and "absent" is UNKNOWN rather than zero: the header used
    // to be read as `Number(h ?? "")`, and `Number("")` is 0, which sails past this
    // check — so a chunked export with no content-length reached the unbounded read
    // below with nothing standing in front of it.
    const declaredRaw = req.headers.get("content-length");
    const declared = declaredRaw === null ? Number.NaN : Number(declaredRaw);
    if (Number.isFinite(declared) && declared > maxBody) {
      return json({ error: "body too large" }, 413);
    }

    let text: string;
    try {
      const body = await readBounded(req, maxBody);
      if (body === null) return json({ error: "body too large" }, 413);
      text = body;
    } catch {
      stats.rejected += 1;
      return json({}, 200);
    }

    if (Date.now() < state.dumpUntil) {
      // `--dump` is the FIRST implementation step for a reason: the OTLP/JSON envelope
      // this harness emits is documented but was not observed on this machine, and a
      // parser written against documentation alone is a parser with silent gaps.
      raw.write(JSON.stringify({ ts: isoNow(now()), signal, body: text }));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      reject(signal, text, "unparseable JSON");
      return json({}, 200);
    }

    const receivedAt = isoNow(now());
    if (signal === "logs") {
      const decoded = decodeLogs(parsed, receivedAt);
      for (const r of decoded.records) emit("logs", JSON.stringify(r));
      if (decoded.rejected > 0) reject(signal, text, `${decoded.rejected} unclassifiable log record(s)`);
    } else if (signal === "metrics") {
      const decoded = decodeMetrics(parsed, receivedAt);
      for (const r of decoded.records) emit("metrics", JSON.stringify(r));
      if (decoded.rejected > 0) reject(signal, text, `${decoded.rejected} unclassifiable metric point(s)`);
    } else {
      // Traces are ACCEPTED and spooled but not consumed in Phase 2 — enabling the
      // tracing beta later is then a settings change and not a code change.
      emit("traces", JSON.stringify({ sig: "trace", received_at: receivedAt, body: text.length }));
    }

    // OTLP success is an EMPTY Export*ServiceResponse, not an arbitrary 2xx body.
    return json({}, 200);
  };

  return {
    handle,
    stats,
    startedAt,
    get boundPort(): number {
      return state.boundPort;
    },
    set boundPort(p: number) {
      state.boundPort = p;
    },
    close: (): void => {
      for (const w of Object.values(writers)) w.close();
      rejects.close();
      raw.close();
    },
  };
}

/**
 * The request body as text, or `null` the moment it exceeds `maxBytes`.
 *
 * BYTES, and bounded DURING the read rather than after it. Both halves were wrong:
 * `await req.text()` materialised the entire body before anything checked it, and
 * `text.length` then counted UTF-16 CODE UNITS against a BYTE cap. So a chunked body
 * with no content-length was buffered in full first (measured at ~3× the body in RSS,
 * an order of magnitude past the configured cap) and a body of three-byte characters up
 * to 3× the cap was never refused at all. "bounded memory always" is in this file's
 * header as a property, not an aspiration, and this is the process that has to honour
 * it: unattended, long-lived, restarted by launchd, accepting whatever the local
 * exporter sends.
 *
 * The stream is CANCELLED on overflow rather than drained — there is nothing to learn
 * from the rest of a body already known to be refused.
 */
async function readBounded(req: Request, maxBytes: number): Promise<string | null> {
  const stream = req.body;
  if (stream === null) {
    // No stream to bound (an empty body, or a Request built from a string in a test):
    // one measurement, still in bytes.
    const buf = new Uint8Array(await req.arrayBuffer());
    return buf.byteLength > maxBytes ? null : new TextDecoder().decode(buf);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : dflt;
}

function parseFlag(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1] ?? null;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? null : eq.slice(name.length + 3);
}

export async function main(argv: readonly string[]): Promise<number> {
  const portFlag = parseFlag(argv, "port");
  const port = portFlag !== null ? Number(portFlag) : envInt("EST_OTEL_PORT", DEFAULT_PORT);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    console.error(`otel-receiver: invalid port: ${portFlag ?? port}`);
    return 1;
  }
  const dumpFlag = parseFlag(argv, "dump");
  const dumpSeconds = dumpFlag === null ? 0 : Number(dumpFlag);
  const maxBody = envInt("EST_OTEL_MAX_BODY_MB", DEFAULT_MAX_BODY_MB) * 1024 * 1024;
  const receiver = createReceiver({
    dumpUntil: dumpSeconds > 0 ? Date.now() + dumpSeconds * 1000 : undefined,
    maxBodyBytes: maxBody,
    port,
  });

  let server: { stop: (closeActive?: boolean) => void; port?: number };
  try {
    server = Bun.serve({
      // EXPLICITLY loopback. Never 0.0.0.0, never a resolvable hostname.
      hostname: "127.0.0.1",
      port,
      // The SOCKET enforces the same cap the handler documents. `readBounded` bounds
      // what this process holds in memory; this bounds what the runtime is willing to
      // accept on our behalf before the handler ever runs. Leaving it unset made
      // Bun.serve's own multi-hundred-megabyte default the real ceiling.
      maxRequestBodySize: maxBody,
      fetch: (req) => receiver.handle(req),
      error: () => json({ error: "internal" }, 500),
    });
  } catch (e) {
    // A port conflict must be loud and must NOT be retried by drifting to another
    // port: a receiver listening somewhere nobody exports to looks exactly like a
    // healthy one.
    console.error(`otel-receiver: cannot bind 127.0.0.1:${port}: ${e instanceof Error ? e.message : String(e)}`);
    receiver.close();
    return 1;
  }

  // `port: 0` asks the kernel to choose, and even a fixed request is only a request —
  // the SOCKET is the authority on what got bound, so both the log line and `/healthz`
  // read from it rather than from what was asked for.
  receiver.boundPort = server.port ?? port;

  console.error(
    `otel-receiver: listening on http://127.0.0.1:${receiver.boundPort} (pid ${process.pid})` +
      (dumpSeconds > 0 ? ` — dumping raw bodies for ${dumpSeconds}s` : ""),
  );

  return await new Promise<number>((resolve) => {
    const shutdown = (): void => {
      server.stop(true);
      receiver.close();
      resolve(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

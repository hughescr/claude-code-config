/**
 * src/otel-status.ts — `est otel`, the operator's view of the OTLP receiver (P2.3).
 *
 * The receiver is the one component of this system that is a LONG-LIVED PROCESS rather
 * than a verb: launchd starts it, it never opens the database, and nothing about it is
 * visible in `estimator.db` except a `otel_receiver_down` anomaly that the SWEEPER
 * raises after the fact. So the only way to ask "is it up, on which port, and is its
 * spool draining" was to read a launchd log — and the failure this is written against is
 * precisely the one that looks healthy from every other angle: a receiver listening on a
 * port nobody exports to, or one whose spool is growing because no sweep is draining it.
 *
 * TWO deliberate constraints:
 *
 *  1. **It reads `/healthz`, never the process table.** A pid that matches a name proves
 *     a process exists; it does not prove the socket is bound, that the port is the one
 *     `OTEL_EXPORTER_OTLP_ENDPOINT` points at, or that a write to the spool would
 *     succeed. The endpoint answers all three, and it is the endpoint the receiver
 *     itself keeps honest (`port` comes from `server.port`, not from the env).
 *
 *  2. **It NEVER opens the database.** `est otel` is a diagnostic about a process, and
 *     the whole point of that process is that it does not contend for the writer lock.
 *     A diagnostic that took the lock to report on the thing built to avoid it would be
 *     the joke writing itself.
 *
 * "Not reachable" is a WELL-FORMED ANSWER, not an error: the receiver being down is the
 * single most likely thing this command is run to find out, so it renders a diagnosis
 * rather than a stack trace. The exit code still distinguishes them (`3`, the same code
 * every other verb uses for "completed, and what it found is bad news").
 */

import { DEFAULT_PORT, MAX_DUMP_SECONDS } from "../scripts/otel-receiver.ts";

export { DEFAULT_PORT, MAX_DUMP_SECONDS };

/** The `/healthz` payload, exactly as DESIGN.md §P2.3 pins it. */
export interface OtelHealth {
  ok: boolean;
  pid: number;
  uptime_s: number;
  port: number;
  received: { logs: number; metrics: number; traces: number };
  rejected: number;
  dropped: number;
  spool_bytes: number;
  last_write_ts: string | null;
  dump_until?: string | null;
}

export interface OtelStatus {
  schema: 1;
  /** Did `/healthz` answer? Everything else is meaningless when this is false. */
  reachable: boolean;
  port: number;
  endpoint: string;
  health: OtelHealth | null;
  /** Why it did not answer, in the words the operator needs; null when it did. */
  error: string | null;
}

export interface OtelDumpResult {
  schema: 1;
  ok: boolean;
  port: number;
  seconds: number;
  /** When raw-body parking stops, or null once it is off. */
  dump_until: string | null;
  error: string | null;
}

/** The port `est otel` talks to: the flag, then `EST_OTEL_PORT`, then the convention. */
export function otelPort(env: NodeJS.ProcessEnv, flag: number | null): number {
  if (flag !== null && Number.isFinite(flag) && flag > 0 && flag <= 65535) return flag;
  const raw = env.EST_OTEL_PORT;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.trunc(n) : DEFAULT_PORT;
}

/**
 * LOOPBACK ONLY, and constructed here rather than taken from a caller.
 *
 * The receiver binds `127.0.0.1` explicitly and refuses to drift; its client has the
 * same obligation for the mirror-image reason. A `--host` flag would make it possible to
 * point this at something off-machine, and the first thing anyone would do with that is
 * accidentally report another machine's receiver as this one's.
 */
function urlFor(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

/** Turn a fetch failure into the sentence an operator can act on. */
function diagnose(port: number, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/timed out|timeout|abort/i.test(msg)) {
    return `no answer from 127.0.0.1:${port} within the timeout — the process may be wedged rather than dead`;
  }
  return (
    `nothing is listening on 127.0.0.1:${port} (${msg}) — ` +
    `check \`launchctl list | grep com.craig.estimator.otel\`, and that OTEL_EXPORTER_OTLP_ENDPOINT names this port`
  );
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** `est otel --status`: read `/healthz` and say what it says. */
export async function otelStatus(port: number, timeoutMs = 2000): Promise<OtelStatus> {
  const endpoint = urlFor(port, "/healthz");
  try {
    const health = (await getJson(endpoint, timeoutMs)) as OtelHealth;
    return { schema: 1, reachable: true, port, endpoint, health, error: null };
  } catch (e) {
    return { schema: 1, reachable: false, port, endpoint, health: null, error: diagnose(port, e) };
  }
}

/** `est otel --dump <seconds>`: arm raw-body parking on the RUNNING receiver. */
export async function otelDump(
  port: number,
  seconds: number,
  timeoutMs = 2000,
): Promise<OtelDumpResult> {
  const base = { schema: 1 as const, port, seconds };
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DUMP_SECONDS) {
    return {
      ...base,
      ok: false,
      dump_until: null,
      error: `--dump takes a number of seconds in 0..${MAX_DUMP_SECONDS} (0 turns it off)`,
    };
  }
  try {
    const res = await fetch(urlFor(port, `/dump?seconds=${seconds}`), {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { ok?: boolean; dump_until?: string | null; error?: string };
    if (!res.ok) {
      return { ...base, ok: false, dump_until: null, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ...base, ok: true, dump_until: body.dump_until ?? null, error: null };
  } catch (e) {
    return { ...base, ok: false, dump_until: null, error: diagnose(port, e) };
  }
}

function human(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function duration(s: number): string {
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

export function renderOtelStatus(s: OtelStatus): string {
  if (!s.reachable || s.health === null) {
    return `otel receiver: DOWN — ${s.error ?? "unreachable"}`;
  }
  const h = s.health;
  const total = h.received.logs + h.received.metrics + h.received.traces;
  const lines = [
    `otel receiver: up on 127.0.0.1:${h.port} (pid ${h.pid}, ${duration(h.uptime_s)})`,
    `received ${total} (${h.received.logs} logs · ${h.received.metrics} metrics · ${h.received.traces} traces) · ` +
      `rejected ${h.rejected} · dropped ${h.dropped}`,
    // The spool is the ONLY externally visible sign of a stalled sweeper: the receiver
    // keeps appending whether or not anything drains, so a spool that only grows is the
    // signal, and `last_write_ts` says whether anything is arriving at all.
    `spool ${human(h.spool_bytes)} · last write ${h.last_write_ts ?? "never"}` +
      (h.dropped > 0 ? `  ·  DROPPED ${h.dropped} record(s) — the spool write failed` : ""),
  ];
  if (h.dump_until !== undefined && h.dump_until !== null) {
    lines.push(`RAW BODY DUMP ARMED until ${h.dump_until} — prompts are being written to spool/otel-raw.jsonl`);
  }
  return lines.join("\n");
}

export function renderOtelDump(r: OtelDumpResult): string {
  if (!r.ok) return `est otel --dump: ${r.error ?? "failed"}`;
  return r.dump_until === null
    ? `raw-body dump OFF on 127.0.0.1:${r.port}`
    : `raw-body dump armed on 127.0.0.1:${r.port} until ${r.dump_until} — ` +
        `bodies land in spool/otel-raw.jsonl, and they contain prompt text`;
}

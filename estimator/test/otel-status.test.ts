/**
 * test/otel-status.test.ts — `est otel`, the operator's view of the receiver (P2.3).
 *
 * This is the ONE place a real socket is bound, and it has to be: the whole value of
 * `est otel --status` is that it asks the SOCKET rather than the process table, so a
 * test that stubbed the transport would be pinning the thing that was never in doubt.
 * Port `0` lets the kernel pick, which is also the case that proves `/healthz` reports
 * the port it BOUND rather than the one it was asked for.
 *
 * Never opens the database — neither does the verb, which is the point of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiver, type Receiver } from "../scripts/otel-receiver.ts";
import {
  otelDump,
  otelPort,
  otelStatus,
  renderOtelDump,
  renderOtelStatus,
  DEFAULT_PORT,
  MAX_DUMP_SECONDS,
} from "../src/otel-status.ts";
import { run } from "../src/cli.ts";

let dir: string;
let receiver: Receiver;
let server: { stop: (closeActive?: boolean) => void; port: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "estimator-otel-status-"));
  receiver = createReceiver({ spoolDir: dir });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // the kernel picks; nothing here may depend on 4318 being free
    fetch: (req) => receiver.handle(req),
  }) as unknown as { stop: (closeActive?: boolean) => void; port: number };
  receiver.boundPort = server.port;
});

afterEach(() => {
  server.stop(true);
  receiver.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Collect a `run()` invocation's stdout, exactly as a caller would see it. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await run(argv, {
    out: (s) => {
      out += `${s}\n`;
    },
    err: (s) => {
      err += `${s}\n`;
    },
  });
  return { code, out, err };
}

describe("otelPort", () => {
  test("the flag beats the env beats the OTLP convention", () => {
    expect(otelPort({}, 4319)).toBe(4319);
    expect(otelPort({ EST_OTEL_PORT: "4400" }, null)).toBe(4400);
    expect(otelPort({}, null)).toBe(DEFAULT_PORT);
    // Junk in the env is not a reason to talk to a port nobody meant.
    expect(otelPort({ EST_OTEL_PORT: "" }, null)).toBe(DEFAULT_PORT);
    expect(otelPort({ EST_OTEL_PORT: "not-a-port" }, null)).toBe(DEFAULT_PORT);
    expect(otelPort({ EST_OTEL_PORT: "99999" }, null)).toBe(DEFAULT_PORT);
  });
});

describe("est otel --status", () => {
  test("reads /healthz off the real socket and exits 0", async () => {
    const s = await otelStatus(server.port);
    expect(s.reachable).toBe(true);
    expect(s.error).toBeNull();
    expect(s.health?.ok).toBe(true);
    // The port in the payload is the BOUND one, which under `port: 0` is a number
    // nobody could have guessed — the strongest form of "not the env default".
    expect(s.health?.port).toBe(server.port);
    expect(s.health?.spool_bytes).toBe(0);
    expect(renderOtelStatus(s)).toContain(`up on 127.0.0.1:${server.port}`);

    const r = await cli("otel", "--status", "--port", String(server.port), "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).reachable).toBe(true);
  });

  test("a bare `est otel` is the status form", async () => {
    const r = await cli("otel", "--port", String(server.port), "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).reachable).toBe(true);
  });

  /**
   * A receiver that is down is the single most likely thing this command is run to
   * find out, so it is a WELL-FORMED ANSWER carrying a diagnosis — and exit `3`, the
   * code every other verb uses for "ran fine, the news is bad", so a cron leg can alert
   * on it without parsing anything. `1` stays "you typed it wrong".
   */
  test("a dead receiver is a diagnosis at exit 3, not a stack trace at exit 1", async () => {
    server.stop(true);
    const r = await cli("otel", "--status", "--port", String(server.port));
    expect(r.code).toBe(3);
    expect(r.out).toContain("DOWN");
    expect(r.out).toContain("com.craig.estimator.otel");
    expect(r.err).toBe("");
  });

  test("--status is a BOOLEAN for this verb, even though it takes a value for others", async () => {
    // `est close --status completed` and `est board --status <column>` put `status` in
    // the CLI's union of value flags, which made `est otel --status` swallow the next
    // token — or fail with "requires a value" when there was none.
    const r = await cli("otel", "--status", "--port", String(server.port), "--json");
    expect(r.code).toBe(0);
    // The neighbours still parse their own `--status` as a value.
    const board = await cli("board", "--status", "in_progress", "--db", join(dir, "nope.db"));
    expect(board.err).not.toContain("--status requires a value");
  });
});

describe("est otel --dump", () => {
  test("arms and disarms raw parking on the running receiver", async () => {
    const on = await otelDump(server.port, 30);
    expect(on.ok).toBe(true);
    expect(on.dump_until).not.toBeNull();
    expect(renderOtelDump(on)).toContain("prompt text");

    const off = await otelDump(server.port, 0);
    expect(off.ok).toBe(true);
    expect(off.dump_until).toBeNull();
    expect(renderOtelDump(off)).toContain("OFF");
  });

  test("the window is bounded, and the refusal never reaches the socket", async () => {
    const tooLong = await otelDump(server.port, MAX_DUMP_SECONDS + 1);
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error).toContain(String(MAX_DUMP_SECONDS));
    // Still armed-free: a rejected request must not have changed anything.
    expect((await otelStatus(server.port)).health?.dump_until ?? null).toBeNull();
  });

  test("--dump and --status together are a usage error, not a silent pick", async () => {
    const r = await cli("otel", "--status", "--dump", "30", "--port", String(server.port));
    expect(r.code).toBe(1);
    expect(r.err).toContain("one at a time");
  });
});

/**
 * src/lock.ts — the single-writer guarantee (§2).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  inspectLock,
  LockBusyError,
  tryAcquireLock,
  withLock,
} from "../src/lock.ts";

let dir: string;
let path: string;

/**
 * Injected clock. Time-dependent behaviour (staleness, the retry deadline) is
 * driven explicitly rather than waited out: no real timer, no wall-clock, no
 * flake under load — the testing-standards rule for anything time-dependent.
 */
interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

function fakeClock(start: number = Date.parse("2026-01-01T00:00:00.000Z")): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "estimator-lock-test-"));
  path = join(dir, "sweep.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tryAcquireLock", () => {
  test("acquires a free lock and writes an identifiable holder record", () => {
    const lock = tryAcquireLock({ path });
    expect(lock).not.toBeNull();
    expect(existsSync(path)).toBe(true);

    const held = inspectLock(path)!;
    expect(held.pid).toBe(process.pid);
    expect(held.host).toBe(hostname());
    expect(held.token).toBe(lock!.info.token);

    lock!.release();
    expect(existsSync(path)).toBe(false);
  });

  test("refuses a lock held by a live process — this is the whole point", () => {
    const first = tryAcquireLock({ path })!;
    expect(tryAcquireLock({ path })).toBeNull();
    first.release();
    expect(tryAcquireLock({ path })).not.toBeNull();
  });

  test("breaks a lock whose PID is dead (the crashed-sweeper case)", () => {
    const clock = fakeClock();
    // PID 2^22+1 is above every default pid_max, so it cannot be running.
    writeFileSync(
      path,
      JSON.stringify({
        pid: 4194305,
        host: hostname(),
        token: "dead",
        acquiredAt: new Date(clock.now()).toISOString(),
      }),
    );
    // Brand new by age, yet stolen anyway: on this host the PID is the answer.
    const lock = tryAcquireLock({ path, staleMs: 600_000, now: clock.now });
    expect(lock).not.toBeNull();
    expect(inspectLock(path)!.pid).toBe(process.pid);
    lock!.release();
  });

  test("never age-steals a live holder on this host — a cold backfill keeps its lock", () => {
    const clock = fakeClock();
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid, // demonstrably alive
        host: hostname(),
        token: "backfill",
        acquiredAt: new Date(clock.now()).toISOString(),
      }),
    );
    // An hour into a legitimate backfill, a thousand times past staleMs: still
    // not stealable. Two writers is the one outcome §2 forbids.
    clock.advance(60 * 60_000);
    expect(tryAcquireLock({ path, staleMs: 1_000, now: clock.now })).toBeNull();
    expect(inspectLock(path)!.token).toBe("backfill");
  });

  test("ages out a lock held on another host, where the PID proves nothing", () => {
    const clock = fakeClock();
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid, // alive *here*, but it is not this host's PID space
        host: `${hostname()}-elsewhere`,
        token: "foreign",
        acquiredAt: new Date(clock.now()).toISOString(),
      }),
    );
    clock.advance(60_000);
    expect(tryAcquireLock({ path, staleMs: 600_000, now: clock.now })).toBeNull();
    const lock = tryAcquireLock({ path, staleMs: 1_000, now: clock.now });
    expect(lock).not.toBeNull();
    lock!.release();
  });

  test("ages out a corrupt lock file instead of wedging forever", () => {
    const clock = fakeClock(Date.now());
    writeFileSync(path, "{ this is not json");
    // Young + unreadable reads as a concurrent write, so it is respected...
    expect(tryAcquireLock({ path, staleMs: 600_000, now: clock.now })).toBeNull();
    // ...but it cannot block the sweeper indefinitely: age is measured off the
    // file's mtime when the content cannot be parsed.
    clock.advance(24 * 60 * 60_000);
    const lock = tryAcquireLock({ path, staleMs: 600_000, now: clock.now });
    expect(lock).not.toBeNull();
    lock!.release();
  });

  test("release() will not delete a lock that was stolen and re-taken", () => {
    const mine = tryAcquireLock({ path })!;
    // Someone judged it stale and took it over.
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: "someone-else",
        acquiredAt: new Date().toISOString(),
      }),
    );
    mine.release();
    expect(existsSync(path)).toBe(true);
    expect(inspectLock(path)!.token).toBe("someone-else");
  });

  test("release() is idempotent", () => {
    const lock = tryAcquireLock({ path })!;
    lock.release();
    expect(lock.held).toBe(false);
    expect(() => lock.release()).not.toThrow();
  });
});

describe("acquireLock / withLock", () => {
  test("throws LockBusyError rather than proceeding without the lock", async () => {
    const first = tryAcquireLock({ path })!;
    const clock = fakeClock();
    let retries = 0;
    const sleep = async (ms: number): Promise<void> => {
      clock.advance(ms);
      retries += 1;
    };
    await expect(
      acquireLock({ path, timeoutMs: 50, retryMs: 10, now: clock.now, sleep }),
    ).rejects.toThrow(LockBusyError);
    // The deadline is read off the injected clock, so the retry budget is exact:
    // 50 ms of budget at 10 ms a retry sleeps five times, then throws rather
    // than sleeping past the deadline.
    expect(retries).toBe(5);
    first.release();
  });

  test("waits for a lock that is released in flight", async () => {
    const first = tryAcquireLock({ path })!;
    const clock = fakeClock();
    let retries = 0;
    const sleep = async (ms: number): Promise<void> => {
      clock.advance(ms);
      retries += 1;
      if (retries === 3) first.release(); // the holder finishes mid-wait
    };
    const second = await acquireLock({ path, timeoutMs: 2_000, retryMs: 10, now: clock.now, sleep });
    expect(second.held).toBe(true);
    expect(retries).toBe(3);
    second.release();
  });

  test("withLock releases even when the body throws", async () => {
    await expect(
      withLock(() => {
        throw new Error("sweep exploded");
      }, { path }),
    ).rejects.toThrow("sweep exploded");
    expect(existsSync(path)).toBe(false);
    expect(tryAcquireLock({ path })).not.toBeNull();
  });

  test("serialises concurrent bodies — never two writers at once", async () => {
    const clock = fakeClock();
    const sleep = async (ms: number): Promise<void> => {
      clock.advance(ms);
    };
    let inFlight = 0;
    let maxInFlight = 0;
    let ran = 0;
    const body = async (): Promise<void> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield repeatedly so every waiter gets a turn on the event loop: if the
      // lock let a second body in, this is where it would be observed. Yielding
      // beats sleeping — same interleaving, no wall-clock.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      inFlight -= 1;
      ran += 1;
    };
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withLock(body, { path, timeoutMs: 5_000, retryMs: 2, now: clock.now, sleep }),
      ),
    );
    expect(ran).toBe(6);
    expect(maxInFlight).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test("leaves no `.stale.*` sidecars behind after a steal", () => {
    writeFileSync(
      path,
      JSON.stringify({
        pid: 4194305,
        host: hostname(),
        token: "x",
        acquiredAt: "1970-01-01T00:00:00.000Z",
      }),
    );
    tryAcquireLock({ path })!.release();
    expect(readdirSync(dir).filter((f) => f.includes(".stale."))).toEqual([]);
  });
});

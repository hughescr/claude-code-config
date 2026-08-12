/**
 * Single-writer lock — token-estimation-design-r3.md §2, §4.
 *
 * "Single writer. Sweeper holds `flock`" — the sweeper takes an exclusive lock on
 * `~/.claude/estimator-data/sweep.lock` so two sweeps can never interleave their
 * upserts. Everything the lock protects is idempotent anyway (§5.2 upsert-with-MAX),
 * so the lock buys serialisation and a clean single transaction per sweep, not
 * correctness of last resort.
 *
 * Why a lockfile and not `flock(2)`: bun exposes no stable `flock` binding, and
 * pulling in an npm addon violates the zero-dependency rule. A lockfile created
 * with `O_EXCL` is atomic on every filesystem this runs on, and O_EXCL's known
 * weakness — a holder that dies without unlinking — is exactly what stale-PID
 * detection fixes. The result is strictly more debuggable than flock: the lock
 * file names the process holding it.
 *
 * Stale detection, in order — liveness first, age only where liveness is
 * unknowable:
 *   1. same host: ask the OS. PID alive -> held, and NEVER stolen however old
 *      the lock is (a cold backfill legitimately holds it for far longer than
 *      staleMs; stealing it would put two writers on the database, which is the
 *      one thing §2 forbids). PID dead -> stale (the common crash case).
 *   2. foreign host, or a lock file we cannot parse -> stale once older than
 *      staleMs. There is no liveness signal to consult, so age is all there is.
 * The case this deliberately leaves wedged is a same-host PID recycled onto an
 * unrelated process: that lock looks alive forever and has to be removed by
 * hand. LockBusyError names the pid, host and acquisition time so the operator
 * can see exactly what to remove (§2 loud failures) — far cheaper than the
 * alternative, which silently runs a second writer over a live backfill.
 * Breaking a stale lock is done by `rename()`, never by `unlink()`: rename of a
 * missing source fails with ENOENT, so when two sweepers both judge a lock stale
 * exactly one wins the steal and the loser retries. An unlink-then-create race
 * would let the loser delete the winner's fresh lock.
 *
 * Zero npm dependencies: node:fs + node:os only.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { DATA_ROOT } from "./db.ts";

/** Canonical sweep lock. `EST_LOCK` overrides it (tests, parallel corpora). */
export const LOCK_PATH: string = process.env.EST_LOCK ?? join(DATA_ROOT, "sweep.lock");

/**
 * A lock whose holder we cannot check for liveness (foreign host, unparseable
 * file) is presumed abandoned once older than this. It is NOT applied to a
 * same-host holder whose PID is alive — see the staleness order above. A
 * full-corpus sweep is ~3 s [CA] and the SessionEnd sweep is budgeted at 20 s,
 * so ten minutes is ~200x headroom for the holders it does apply to.
 */
export const DEFAULT_STALE_MS = 10 * 60 * 1000;

export interface LockOptions {
  /** Lock file path. Defaults to LOCK_PATH. */
  path?: string;
  /** Age past which a lock is presumed abandoned. Defaults to DEFAULT_STALE_MS. */
  staleMs?: number;
  /** Total time to keep retrying before giving up. 0 = try once. */
  timeoutMs?: number;
  /** Delay between retries. */
  retryMs?: number;
  /** Free-text note stored in the lock file, for humans debugging a stuck sweep. */
  note?: string;
  /**
   * Clock. Injectable so time-dependent tests drive staleness and the retry
   * deadline explicitly instead of sleeping. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * How acquireLock waits between retries. Injectable for the same reason.
   * Defaults to `Bun.sleep`.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** What is written inside the lock file — purely diagnostic, except `pid`/`host`/`token`. */
export interface LockInfo {
  pid: number;
  host: string;
  /** Random per-acquisition id: release() refuses to unlink a lock it does not own. */
  token: string;
  acquiredAt: string;
  note?: string;
}

export class LockBusyError extends Error {
  readonly holder: LockInfo | null;
  constructor(path: string, holder: LockInfo | null) {
    const who = holder ? `pid ${holder.pid} on ${holder.host} since ${holder.acquiredAt}` : "unknown";
    super(`estimator: sweep lock ${path} is held by ${who}`);
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

export interface SweepLock {
  readonly path: string;
  readonly info: LockInfo;
  /** True until release() succeeds. */
  readonly held: boolean;
  /** Idempotent: releasing twice is a no-op, and so is releasing a stolen lock. */
  release(): void;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: alive, owned by another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockInfo(path: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.pid !== "number" || typeof o.host !== "string") return null;
    return {
      pid: o.pid,
      host: o.host,
      token: typeof o.token === "string" ? o.token : "",
      acquiredAt: typeof o.acquiredAt === "string" ? o.acquiredAt : "",
      note: typeof o.note === "string" ? o.note : undefined,
    };
  } catch {
    // Missing, unreadable, or garbage (a half-written lock from a process killed
    // mid-write). Garbage is handled by the age check in isStale().
    return null;
  }
}

function lockAgeMs(path: string, info: LockInfo | null, now: () => number): number {
  if (info?.acquiredAt) {
    const t = Date.parse(info.acquiredAt);
    if (!Number.isNaN(t)) return now() - t;
  }
  try {
    // Unparseable content: fall back to the file's own mtime so a corrupt lock
    // still ages out instead of wedging the sweeper forever.
    return now() - Bun.file(path).lastModified;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Liveness beats age. A same-host PID is an answer the OS gives us, so it is
 * consulted first and it is final: an alive holder keeps its lock no matter how
 * long it has held it, because "held for a long time" is what a cold backfill
 * looks like, not what a crash looks like. Age is the fallback for holders whose
 * liveness cannot be established at all.
 */
function isStale(path: string, info: LockInfo | null, staleMs: number, now: () => number): boolean {
  // Same host: the PID decides, and only the PID. Never age-steal a live holder.
  if (info !== null && info.host === hostname()) return !pidAlive(info.pid);
  // Foreign host (a PID we can neither see nor kill), or a lock file we could
  // not parse (young + unreadable reads as a concurrent write, so it is
  // respected until it ages out). Age is the only signal left.
  return lockAgeMs(path, info, now) > staleMs;
}

/**
 * Break a lock judged stale. Uses rename, so only one racing stealer wins:
 * the loser's rename fails with ENOENT and it simply retries the acquire.
 * Returns true when this process performed the steal.
 */
function stealStale(path: string): boolean {
  const parked = `${path}.stale.${process.pid}.${Date.now()}`;
  try {
    renameSync(path, parked);
  } catch {
    return false;
  }
  rmSync(parked, { force: true });
  return true;
}

function createExclusive(path: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx"); // O_CREAT | O_EXCL | O_WRONLY — atomic
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function makeLock(path: string, info: LockInfo): SweepLock {
  let held = true;
  return {
    path,
    info,
    get held() {
      return held;
    },
    release(): void {
      if (!held) return;
      held = false;
      // Only unlink a lock still carrying our token: if a stale-check stole it
      // from under us and someone else re-created it, that lock is not ours to
      // remove.
      const current = readLockInfo(path);
      if (current !== null && current.token !== info.token) return;
      rmSync(path, { force: true });
    },
  };
}

/**
 * Take the lock if it is free (or stale). Returns null when another live process
 * holds it. Never blocks.
 */
export function tryAcquireLock(options: LockOptions = {}): SweepLock | null {
  const path = options.path ?? LOCK_PATH;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = options.now ?? Date.now;

  mkdirSync(dirname(path), { recursive: true });

  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    token: crypto.randomUUID(),
    acquiredAt: new Date(now()).toISOString(),
    ...(options.note === undefined ? {} : { note: options.note }),
  };

  if (createExclusive(path, info)) return makeLock(path, info);

  const holder = readLockInfo(path);
  if (!isStale(path, holder, staleMs, now)) return null;
  if (!stealStale(path)) return null; // another stealer won; caller retries
  if (createExclusive(path, info)) return makeLock(path, info);
  return null;
}

/**
 * Take the lock, retrying until `timeoutMs` elapses. Throws LockBusyError rather
 * than proceeding without it — a second concurrent writer is exactly what the
 * single-writer design forbids (§2).
 */
export async function acquireLock(options: LockOptions = {}): Promise<SweepLock> {
  const path = options.path ?? LOCK_PATH;
  const timeoutMs = options.timeoutMs ?? 0;
  const retryMs = options.retryMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms));
  const deadline = now() + timeoutMs;

  for (;;) {
    const lock = tryAcquireLock(options);
    if (lock !== null) return lock;
    if (now() + retryMs > deadline) {
      throw new LockBusyError(path, readLockInfo(path));
    }
    await sleep(retryMs);
  }
}

/** Run `fn` under the lock, releasing it even if `fn` throws. */
export async function withLock<T>(
  fn: (lock: SweepLock) => T | Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lock = await acquireLock(options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/** Who holds the lock right now, or null. Read-only; never steals. */
export function inspectLock(path: string = LOCK_PATH): LockInfo | null {
  return readLockInfo(path);
}

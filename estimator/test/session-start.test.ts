/**
 * scripts/session-start.ts — the SessionStart micro-sweep hook.
 *
 * Run as a REAL subprocess with synthesized stdin, exactly as Claude Code's hook runner
 * invokes it (cf. test/prompt-sweep.test.ts, whose shape this deliberately mirrors —
 * the two hooks share `src/microsweep.ts` and must not drift apart).
 *
 * **Silence is asserted harder here than for any other hook, and it is the point of
 * this file.** A `SessionStart` hook's stdout is injected into the model's context AS
 * ADDITIONAL CONTEXT FOR THE SESSION — that is the documented purpose of the stream, not
 * an accident of it. Anything this hook prints therefore becomes an unattributable
 * instruction sitting at the top of every session Craig ever starts, forever. So
 * "prints nothing" is checked on every case, including through the shell wrapper, and
 * including when the child process itself fails.
 *
 * Every id and figure below is synthetic (§4: no real id may enter a tracked file).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MICROSWEEP_MARKER } from "../src/spool.ts";

const SESSION_START_SCRIPT = join(import.meta.dir, "..", "scripts", "session-start.ts");
const SESSION_START_HOOK = join(import.meta.dir, "..", "scripts", "session-start-hook.sh");

/** Synthetic. Shaped like a session id, belongs to no session that ever existed. */
const SESSION = "0000ses-0000-4000-8000-0000000015ea";

let dir: string;
let spoolDir: string;
let corpusDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "est-session-start-"));
  spoolDir = join(dir, "spool");
  corpusDir = join(dir, "projects");
  mkdirSync(spoolDir, { recursive: true });
  mkdirSync(corpusDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The environment that keeps everything the hook could touch inside `dir`. */
function isolatedEnv(): Record<string, string> {
  return {
    EST_DB: join(dir, "estimator.db"),
    EST_LOCK: join(dir, "sweep.lock"),
    EST_SPOOL_DIR: spoolDir,
    EST_PROJECTS: corpusDir, // empty: discovery finds nothing, so any sweep is trivial
    EST_TASKS: join(dir, "tasks"), // absent on purpose
  };
}

function runSessionStart(stdin: string, env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SESSION_START_SCRIPT], {
    stdin: Buffer.from(stdin, "utf8"),
    env: { ...process.env, ...isolatedEnv(), EST_DISABLE_MICROSWEEP: "1", ...env },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  };
}

/** Drive the deployed shell wrapper, which is what settings.json actually invokes. */
function runHookWrapper(stdin: string, env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync(["/bin/sh", SESSION_START_HOOK], {
    stdin: Buffer.from(stdin, "utf8"),
    env: {
      ...process.env,
      // est-lib.sh resolves scripts/ under EST_HOME — point it at THIS checkout, never
      // the deployed one, or the test exercises whatever is installed on the machine.
      EST_HOME: join(import.meta.dir, ".."),
      ...isolatedEnv(),
      EST_DISABLE_MICROSWEEP: "1",
      ...env,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  };
}

describe("session-start.ts — silence (SessionStart stdout IS the model's context)", () => {
  test("prints NOTHING on the happy path, for every documented `source`", () => {
    for (const source of ["startup", "resume", "clear", "compact"]) {
      const r = runSessionStart(JSON.stringify({ session_id: SESSION, source }));
      expect({ source, code: r.exitCode, out: r.stdout }).toEqual({ source, code: 0, out: "" });
    }
  });

  test("the shell wrapper emits nothing on either stream", () => {
    const r = runHookWrapper(JSON.stringify({ session_id: SESSION, source: "startup" }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("the shell wrapper stays silent and exits 0 when the child itself fails", () => {
    // EST_HOME pointed at a directory with no scripts/session-start.ts: bun exits
    // non-zero with a resolution error on stderr. The wrapper must swallow both — a
    // leaked stack trace here is prepended to the model's context for the whole session.
    const r = runHookWrapper(JSON.stringify({ session_id: SESSION }), { EST_HOME: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });
});

describe("session-start.ts — fail-open contract", () => {
  test("exits 0, silently, on unparseable stdin", () => {
    const r = runSessionStart("{not json");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("exits 0, silently, on empty stdin", () => {
    const r = runSessionStart("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("exits 0 and sweeps nothing when the payload carries no session_id", () => {
    const r = runSessionStart(JSON.stringify({ source: "startup" }), {
      EST_DISABLE_MICROSWEEP: "",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    // No marker: the throttle was never consulted, because nothing was spawned.
    expect(existsSync(join(spoolDir, MICROSWEEP_MARKER))).toBe(false);
  });

  test("exits 0, silently, when the database does not exist at all", () => {
    const r = runSessionStart(JSON.stringify({ session_id: SESSION, source: "resume" }), {
      EST_DB: join(dir, "does-not-exist.db"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("session-start.ts — the SHARED throttle", () => {
  test("a fresh marker suppresses the sweep — the window is global, not per hook", () => {
    writeFileSync(join(spoolDir, MICROSWEEP_MARKER), String(Date.now()));
    const before = statSync(join(spoolDir, MICROSWEEP_MARKER)).mtimeMs;

    const r = runSessionStart(JSON.stringify({ session_id: SESSION, source: "startup" }), {
      EST_DISABLE_MICROSWEEP: "",
      EST_MICROSWEEP_MIN_INTERVAL_S: "3600",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    // Not re-touched => nothing was spawned. A session start arriving inside another
    // hook's fresher window correctly declines: the caches were just refreshed.
    expect(statSync(join(spoolDir, MICROSWEEP_MARKER)).mtimeMs).toBe(before);
  });

  test("with no marker, a session start DOES stamp the shared global one", () => {
    expect(existsSync(join(spoolDir, MICROSWEEP_MARKER))).toBe(false);
    const r = runSessionStart(JSON.stringify({ session_id: SESSION, source: "startup" }), {
      EST_DISABLE_MICROSWEEP: "",
      // Long window: the assertion is that the marker appears, not that a sweep finishes.
      EST_MICROSWEEP_MIN_INTERVAL_S: "3600",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(spoolDir, MICROSWEEP_MARKER))).toBe(true);
    // ONE file, never `.microsweep.<sid>`: N concurrent sessions must collapse to one
    // sweep per window, which is the whole reason the marker is global.
    expect(existsSync(join(spoolDir, `${MICROSWEEP_MARKER}.${SESSION}`))).toBe(false);
  });
});

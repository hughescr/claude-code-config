/**
 * scripts/prompt-sweep.ts — the UserPromptSubmit micro-sweep hook.
 *
 * Run as a REAL subprocess with synthesized stdin, exactly as Claude Code's hook runner
 * invokes it (cf. test/nudge.test.ts): the hook's whole contract IS "a process fed JSON
 * on stdin", so that is what is exercised.
 *
 * Two things here are deliberately different from the nudge's tests:
 *
 *  1. **Silence is asserted as a property, not a side note.** UserPromptSubmit stdout is
 *     injected into the model's context on every prompt, so "prints nothing" is the
 *     single most important thing about this hook and is checked on every case,
 *     including through the shell wrapper (which must also swallow stderr).
 *  2. **One case runs the REAL micro-sweep**, which test/nudge.test.ts explicitly
 *     declines to do. It is safe here only because every root the sweeper touches is
 *     redirected into a temp directory — database, lock, corpus (`EST_PROJECTS`), task
 *     dirs (`EST_TASKS`), spool, and (via test/preload.ts) jobs/sessions/settings — so
 *     the sweep walks an EMPTY corpus and writes to a throwaway file. That is what makes
 *     it fast enough to assert on, and it is the only way to show the thing the hook
 *     exists for: `burn_cache.as_of` actually moves.
 *
 * Every id, task and figure below is synthetic (§4: no real id may enter a tracked file).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { MICROSWEEP_MARKER } from "../src/spool.ts";

const PROMPT_SWEEP_SCRIPT = join(import.meta.dir, "..", "scripts", "prompt-sweep.ts");
const PROMPT_SWEEP_HOOK = join(import.meta.dir, "..", "scripts", "prompt-sweep-hook.sh");

/** Synthetic. Shaped like a session id, belongs to no session that ever existed. */
const SESSION = "0000ses-0000-4000-8000-00000000cafe";
const TID = "t-prompt-sweep";
/** Old enough that any refresh at all is unambiguous, and stable across the run. */
const ANCIENT = "2000-01-01T00:00:00.000Z";

let dir: string;
let dbPath: string;
let spoolDir: string;
let corpusDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "est-prompt-sweep-"));
  dbPath = join(dir, "estimator.db");
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

/** The environment that keeps a REAL sweep entirely inside `dir`. */
function isolatedEnv(): Record<string, string> {
  return {
    EST_DB: dbPath,
    EST_LOCK: join(dir, "sweep.lock"),
    EST_SPOOL_DIR: spoolDir,
    EST_PROJECTS: corpusDir, // empty: discovery finds nothing, so the sweep is trivial
    EST_TASKS: join(dir, "tasks"), // absent on purpose
  };
}

function runPromptSweep(stdin: string, env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", PROMPT_SWEEP_SCRIPT], {
    stdin: Buffer.from(stdin, "utf8"),
    env: {
      ...process.env,
      ...isolatedEnv(),
      // Default OFF for the cheap cases; the one end-to-end case clears it explicitly.
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

/** Drive the deployed shell wrapper, which is what settings.json actually invokes. */
function runHookWrapper(stdin: string, env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync(["/bin/sh", PROMPT_SWEEP_HOOK], {
    stdin: Buffer.from(stdin, "utf8"),
    env: {
      ...process.env,
      // est-lib.sh resolves scripts/ under EST_HOME — point it at THIS checkout, not the
      // deployed one, or the test would exercise whatever is installed on the machine.
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

/** An open task bound to `SESSION`, with a deliberately ancient `burn_cache` row. */
function seedBoundTask(): void {
  const db = openDb({ path: dbPath });
  const now = new Date().toISOString();
  try {
    db.run(
      `INSERT INTO task (tid,kind,status,created_at,anchor_session,anchor_prompt) VALUES (?,?,?,?,?,?)`,
      [TID, "implement", "in_progress", now, SESSION, "prompt-1"],
    );
    db.run(
      `INSERT INTO task_scope (tid,seq,ts,subject,description,dod_json,scope_hash,source) VALUES (?,1,?,?,?,?,?,?)`,
      [TID, now, "test task", null, "[]", "deadbeef", "est_open"],
    );
    db.run(
      `INSERT INTO task_alias (tid,id_kind,session_id,local_id,first_seen,source) VALUES (?,?,?,?,?,?)`,
      [TID, "session", SESSION, SESSION, now, "est_bind"],
    );
    db.run(
      `INSERT INTO burn_cache (tid,as_of,consumed_wcet,wcet_main,wcet_sub,wcet_aux,usd,n_req,
         n_agents_live,active_s,burn_wcet_per_min,proj_total_wcet)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [TID, ANCIENT, 100, 100, 0, 0, 1.0, 10, 0, 60, 1.0, 100],
    );
  } finally {
    db.close();
  }
}

function readAsOf(): string | null {
  try {
    const db = openDb({ path: dbPath, readonly: true, busyTimeoutMs: 200 });
    try {
      const row = db
        .query<{ as_of: string }, [string]>("SELECT as_of FROM burn_cache WHERE tid = ?")
        .get(TID);
      return row?.as_of ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null; // mid-sweep contention: just poll again
  }
}

/** The sweep is DETACHED by design, so the only way to observe it is to wait for it. */
async function waitForAsOfChange(fromValue: string, timeoutMs = 45_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = readAsOf();
    if (seen !== null && seen !== fromValue) return seen;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

describe("prompt-sweep.ts — silence (UserPromptSubmit stdout is model context)", () => {
  test("prints NOTHING on the happy path", () => {
    seedBoundTask();
    const r = runPromptSweep(JSON.stringify({ session_id: SESSION, prompt: "hello" }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("the shell wrapper emits nothing on either stream", () => {
    seedBoundTask();
    const r = runHookWrapper(JSON.stringify({ session_id: SESSION, prompt: "hello" }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("the shell wrapper stays silent and exits 0 when the child itself fails", () => {
    // EST_HOME pointed at a directory with no scripts/prompt-sweep.ts: bun exits
    // non-zero with a resolution error on stderr. The wrapper must swallow both and
    // still exit 0 — a leaked stack trace here lands in the conversation on EVERY
    // prompt, and a non-zero exit can block the prompt outright.
    const r = runHookWrapper(JSON.stringify({ session_id: SESSION }), { EST_HOME: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });
});

describe("prompt-sweep.ts — fail-open contract", () => {
  test("exits 0, silently, on unparseable stdin", () => {
    const r = runPromptSweep("{not json");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("exits 0, silently, on empty stdin", () => {
    const r = runPromptSweep("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("exits 0 and sweeps nothing when the payload carries no session_id", () => {
    const r = runPromptSweep(JSON.stringify({ prompt: "orphaned" }), {
      EST_DISABLE_MICROSWEEP: "",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    // No marker: the throttle was never even consulted, because nothing was spawned.
    expect(existsSync(join(spoolDir, MICROSWEEP_MARKER))).toBe(false);
  });

  test("exits 0, silently, when the database does not exist at all", () => {
    const r = runPromptSweep(JSON.stringify({ session_id: SESSION, prompt: "x" }), {
      EST_DB: join(dir, "does-not-exist.db"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("prompt-sweep.ts — throttle", () => {
  test("a fresh marker suppresses the sweep, and burn_cache is left untouched", () => {
    seedBoundTask();
    writeFileSync(join(spoolDir, MICROSWEEP_MARKER), String(Date.now()));
    const before = statSync(join(spoolDir, MICROSWEEP_MARKER)).mtimeMs;

    // The real path, with the throttle window widened so the test cannot race it.
    for (const prompt of ["one", "two", "three"]) {
      const r = runPromptSweep(JSON.stringify({ session_id: SESSION, prompt }), {
        EST_DISABLE_MICROSWEEP: "",
        EST_MICROSWEEP_MIN_INTERVAL_S: "3600",
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
    }

    // Not re-touched => nothing was spawned; the cache still holds the ancient stamp.
    expect(statSync(join(spoolDir, MICROSWEEP_MARKER)).mtimeMs).toBe(before);
    expect(readAsOf()).toBe(ANCIENT);
  });

  test("the marker is the SHARED global one, so no per-session marker appears", () => {
    seedBoundTask();
    writeFileSync(join(spoolDir, MICROSWEEP_MARKER), String(Date.now()));
    runPromptSweep(JSON.stringify({ session_id: SESSION, prompt: "x" }), {
      EST_DISABLE_MICROSWEEP: "",
      EST_MICROSWEEP_MIN_INTERVAL_S: "3600",
    });
    expect(existsSync(join(spoolDir, `${MICROSWEEP_MARKER}.${SESSION}`))).toBe(false);
  });
});

describe("prompt-sweep.ts — the point of the hook", () => {
  test(
    "a prompt refreshes burn_cache.as_of for the bound session's open task",
    async () => {
      seedBoundTask();
      expect(readAsOf()).toBe(ANCIENT);

      const r = runPromptSweep(JSON.stringify({ session_id: SESSION, prompt: "still here" }), {
        EST_DISABLE_MICROSWEEP: "", // the REAL micro-sweep, against the temp corpus
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(""); // even the end-to-end path says nothing

      const refreshed = await waitForAsOfChange(ANCIENT);
      expect(refreshed).not.toBeNull();
      // Freshly stamped: this is what lets statusline-burn.ts render instead of blanking.
      const ageS = (Date.now() - Date.parse(refreshed!)) / 1000;
      expect(ageS).toBeLessThan(120);
      expect(ageS).toBeGreaterThan(-5); // clock sanity, not a real bound
    },
    60_000,
  );
});

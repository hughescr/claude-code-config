/**
 * `est close` — finalize by arithmetic (P1.7, P1.12).
 *
 * The load-bearing claim of this verb is a negative one: **there is no flag that
 * accepts a token count, a cost, or a velocity, and there never will be.** No agent
 * grades its own work; the actual is deterministic SQL over harness logs. The first
 * test in this file asserts that about the FLAG TABLE rather than about prose, because
 * prose does not fail a build.
 *
 * The rest is the quiescence gate (§6.2) — which exists so a task cannot be closed
 * while its own agents are still spending — and the append-only outcome history: a
 * reopen is `revision + 1`, never an edit, and accuracy is judged against `MIN(eid)`
 * no matter how many refinements followed.
 *
 * All fixtures are synthetic (`test/support.ts`); the "live pid" leg of the gate is
 * exercised through session ids (`s1`) that cannot collide with a real session file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentRun,
  makeHarness,
  openArgs,
  request,
  seedPrices,
  turn,
  type Harness,
} from "./support.ts";
import { BENIGN_ANOMALY_KINDS, COMMAND_FLAGS, runSweep } from "../src/cli.ts";
import { closeTask, MIN_ACCEPTANCE_CHARS, quiescence } from "../src/close.ts";
import { attributeTasks } from "../src/attribute.ts";

let h: Harness;

/** Every fixture request lands here; "now" in the tests is months later. */
const LONG_AGO = "2026-01-01T00:00:00Z";
const NOW = new Date("2026-02-01T00:00:00Z");

/**
 * The acceptance every `--accept` fixture uses.
 *
 * INVENTED, like every other fixture here, and deliberately an unambiguous
 * FIRST-PERSON acceptance of completion: a committed test is a de facto boundary spec,
 * so a borderline phrase sitting in one would read as a ruling that borderline phrases
 * are enough. SKILL.md's rule is the same sentence shape, and says to ask rather than
 * construe anything weaker.
 */
const ACCEPTANCE = "I accept the gizmo refactor work as complete, close it out";

const corpusRoots: string[] = [];

/**
 * Put words in a bound session's transcript — the evidence `--accept` verifies against.
 *
 * `EST_PROJECTS` is how every corpus reader in this project is pointed at a fixture,
 * and `closeTask` resolves it at call time so a test driving the real CLI in-process
 * can redirect it. `asToolResult` writes the same words as a HARNESS-written user line
 * instead, which must not count: that is the shape an agent could manufacture by
 * printing the sentence itself.
 */
function saidInTranscript(
  words: string,
  opts: { asToolResult?: boolean; at?: string } = {},
): void {
  const root = mkdtempSync(join(tmpdir(), "est-close-corpus-"));
  corpusRoots.push(root);
  const dir = join(root, "-Users-craig-demo");
  mkdirSync(dir, { recursive: true });
  const message = opts.asToolResult === true
    ? { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: words }] }
    : { role: "user", content: words };
  const line = JSON.stringify({
    type: "user",
    uuid: "u-accept",
    sessionId: "s1",
    isSidechain: false,
    userType: "external",
    promptId: "p1",
    // AFTER the task was minted, which is what the verification requires: `est open`
    // stamps `created_at` at real wall-clock time, so the fixture's evidence has to be
    // later than that rather than at the fixtures' synthetic `LONG_AGO`.
    timestamp: opts.at ?? new Date(Date.now() + 1000).toISOString(),
    message,
    ...(opts.asToolResult === true ? { toolUseResult: { stdout: words } } : {}),
  });
  writeFileSync(join(dir, "s1.jsonl"), `${line}\n`);
  process.env.EST_PROJECTS = root;
}

const minutesBefore = (at: Date, minutes: number): string =>
  new Date(at.getTime() - minutes * 60_000).toISOString();

const noCorpus = process.env.EST_PROJECTS;

beforeEach(() => {
  h = makeHarness("est-close-");
  seedPrices(h.db);
  turn(h.db, { session: "s1", prompt: "p1", at: LONG_AGO, durationMs: 60_000 });
});

afterEach(() => {
  h.close();
  // Back to the preload's guaranteed-absent root, so one test's evidence is never
  // another's — an acceptance must be verified against the corpus its own test wrote.
  if (noCorpus === undefined) delete process.env.EST_PROJECTS;
  else process.env.EST_PROJECTS = noCorpus;
  for (const r of corpusRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function openTask(over: Record<string, string | number> = {}): Promise<string> {
  const r = await h.cli(...openArgs(over), "--session", "s1", "--prompt", "p1", "--json");
  expect(r.code).toBe(0);
  return r.json<{ tid: string }>().tid;
}

/** A quiescent task carrying 200 main + 800 sub Work-CET across two requests. */
async function quietTask(): Promise<string> {
  const tid = await openTask();
  request(h.db, "r-main", { origin: "main", out: 150, cw: 50, ts: "2026-01-01T00:01:00Z", durationMs: 4000 });
  agentRun(h.db, "a1", {
    session: "s1",
    launchPrompt: "p1",
    startedAt: "2026-01-01T00:01:00Z",
    endedAt: "2026-01-01T00:06:00Z",
  });
  request(h.db, "r-sub", {
    origin: "subagent",
    agent: "a1",
    prompt: null,
    out: 700,
    cw: 100,
    ts: "2026-01-01T00:02:00Z",
    durationMs: 6000,
  });
  attributeTasks(h.db);
  return tid;
}

// ---------------------------------------------------------------------------
// P1.12 — the anti-Goodhart shape of the verb itself
// ---------------------------------------------------------------------------

describe("est close — P1.12 accepts no measured quantity", () => {
  test("the flag table has no token, cost or velocity input, and no --amend", () => {
    // `accept` carries WORDS, never a quantity: it is the human's own acceptance,
    // quoted, and the actual is still deterministic SQL over the harness's logs.
    expect(COMMAND_FLAGS.close).toEqual({ booleans: ["force"], values: ["status", "accept"] });
    const everyFlag = Object.values(COMMAND_FLAGS).flatMap((s) => [...s.booleans, ...s.values]);
    for (const forbidden of ["amend", "force-overwrite", "wcet", "actual", "tokens", "velocity", "cost"]) {
      expect(everyFlag).not.toContain(forbidden);
    }
  });

  test("`--fix` exists on exactly ONE verb, and that verb cannot touch the spine", async () => {
    // P2.12's `est audit --fix` is the single sanctioned repair path in the whole CLI,
    // and the guard here is that it stays single AND stays bounded. A `--fix` on any
    // verb that writes the append-only spine would be `--amend` under another name.
    const withFix = Object.entries(COMMAND_FLAGS)
      .filter(([, spec]) => spec.booleans.includes("fix") || spec.values.includes("fix"))
      .map(([verb]) => verb);
    expect(withFix).toEqual(["audit"]);

    const { FIXABLE, SPINE } = await import("../src/audit.ts");
    for (const table of SPINE) expect(table in FIXABLE).toBe(false);
  });

  test("`est delete` does not exist anywhere in the verb surface", () => {
    expect(Object.keys(COMMAND_FLAGS)).not.toContain("delete");
  });

  test("outcome is append-only in the database, not only in the CLI", async () => {
    const tid = await quietTask();
    closeTask(h.db, { tid, now: NOW });
    expect(() => h.db.query("UPDATE outcome SET actual_wcet = 1").run()).toThrow(/append-only/);
    expect(() => h.db.query("DELETE FROM outcome").run()).toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// P1.7 — the quiescence gate
// ---------------------------------------------------------------------------

describe("est close — P1.7 quiescence", () => {
  test("a live task is REJECTED (exit 2) and the message names the failing condition", async () => {
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    const r = await h.cli("close", tid);
    expect(r.code).toBe(2);
    expect(r.err).toContain("quiescence");
    expect(r.err).toMatch(/no completion signal|last attributed request/);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(0);
  });

  test("an open turn blocks the close even when everything else is quiet", async () => {
    const tid = await quietTask();
    turn(h.db, { session: "s1", prompt: "p2", at: minutesBefore(NOW, 5), durationMs: null });
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.ok).toBe(false);
    expect(gate.open_turns).toBe(1);
    expect(gate.failing.join(" ")).toContain("open turn");
  });

  test("a long-running turn is held open by its SESSION's activity, not by its start time", async () => {
    const tid = await quietTask();
    // The case the condition exists for: a turn 20 h in and still going. Its start is
    // far outside the quiet window; the requests it is still making are not.
    turn(h.db, { session: "s1", prompt: "p2", at: minutesBefore(NOW, 20 * 60), durationMs: null });
    request(h.db, "r-live", { prompt: "p2", out: 10, ts: minutesBefore(NOW, 10) });
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.open_turns).toBe(1);
    expect(gate.failing.join(" ")).toContain("open turn");
  });

  test("a NULL duration_ms in the session's HISTORY is not an open turn", async () => {
    const tid = await quietTask();
    // The harness writes `turn_duration` at turn end; a turn it never wrote one for
    // keeps `duration_ms IS NULL` for ever. Counting those would mean a single missing
    // record blocks every future close in that session — and later turns that closed
    // normally prove this one is not running.
    turn(h.db, { session: "s1", prompt: "p0", at: "2025-06-01T00:00:00Z", durationMs: null });
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.open_turns).toBe(0);
    expect(gate.ok).toBe(true);
  });

  test("a session whose LAST turn never got a turn_duration still closes once it goes quiet", async () => {
    const tid = await quietTask();
    // The shape a killed or crashed session leaves behind, and the common one: the
    // newest turn has no duration record and never will. Quiet for a month, it is a
    // dead record rather than a live turn, and `--force` must not be the only way out.
    turn(h.db, { session: "s1", prompt: "p2", at: "2026-01-01T00:05:00Z", durationMs: null });
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.open_turns).toBe(0);
    expect(gate.ok).toBe(true);
    expect((await h.cli("close", tid)).code).toBe(0);
  });

  test("a bound agent that is still LIVE blocks the close", async () => {
    const tid = await quietTask();
    // FRESH, not merely unfinished: arm 5 now uses the same activity clock P2.1's idle
    // suppression does (`countLiveAgents`, `eta_live_agent_max_min` = 120 min).
    agentRun(h.db, "a-live", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      endedAt: null,
    });
    attributeTasks(h.db);
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.ok).toBe(false);
    expect(gate.nonterminal_agents).toBe(1);
  });

  test("a DANGLING agent no longer blocks it forever (Craig, 2026-07-30)", async () => {
    // "Started and never ended" is what a live agent looks like AND what a DEAD one
    // looks like — §5.6's `agent_never_returned` population, 54 rows on the live corpus
    // with 49 of them older than six hours. Under the old unbounded arm, one corpse made
    // its task permanently un-closeable by anyone: `--force` for it forever, and the
    // sweeper's close pass unable to reach the exact population it exists for.
    const tid = await quietTask();
    agentRun(h.db, "a-dead", { session: "s1", launchPrompt: "p1", startedAt: LONG_AGO, endedAt: null });
    attributeTasks(h.db);
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.nonterminal_agents).toBe(0);
    expect(gate.ok).toBe(true);
    expect((await h.cli("close", tid)).code).toBeLessThanOrEqual(3);
  });

  test("...but one still EMITTING requests is not aged out", async () => {
    // The clock is `MAX(started_at, the agent's own last request)`, so a genuinely long
    // delegation keeps blocking. Bounding on `started_at` alone would close live work,
    // which is the one direction this must not fail in.
    const tid = await quietTask();
    agentRun(h.db, "a-long", { session: "s1", launchPrompt: "p1", startedAt: LONG_AGO, endedAt: null });
    request(h.db, "r-still-going", {
      origin: "subagent",
      agent: "a-long",
      prompt: null,
      out: 10,
      ts: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    attributeTasks(h.db);
    const gate = quiescence(h.db, tid, NOW);
    expect(gate.nonterminal_agents).toBe(1);
    expect(gate.ok).toBe(false);
  });

  test("--force overrides the gate, records anomaly(forced_close), and says FORCED", async () => {
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    const r = await h.cli("close", tid, "--force");
    expect(r.code).toBeLessThanOrEqual(3);
    expect(r.out).toContain("FORCED");
    const anomaly = h.db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'forced_close' AND tid = ?",
    ).get(tid);
    expect(anomaly?.n).toBe(1);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(1);
  });

  test("the exit-2 message names the sweeper and the accept path, and still refuses --force to Claude", async () => {
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    const r = await h.cli("close", tid);
    expect(r.code).toBe(2);
    expect(r.err).toContain("quiescence gate not met");
    // The remedy used to say "wait for the task to go quiet", which reads as an
    // instruction to POLL and pointed, in its second half, at a sweeper close pass that
    // did not exist. Since 2026-07-30 it does, so the honest advice is to do nothing —
    // and the message has to state the CONSEQUENCE of that, or it is only half true.
    expect(r.err).toContain("do nothing");
    expect(r.err).toContain("close pass");
    expect(r.err).toContain("abandoned");
    expect(r.err).toContain("--accept");
    expect(r.err).toContain("never Claude's");
  });

  test("the gate refusal is identifiable by CLASS, not by matching its prose", async () => {
    // `src/autoclose.ts` has to tell "the gate said no" (designed; retried next pass)
    // from "this task is broken" (counted, and eventually alerting). A regex over the
    // message made that discrimination hostage to the wording of an error string.
    const { QuiescenceError } = await import("../src/close.ts");
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    let thrown: unknown;
    try {
      closeTask(h.db, { tid, now: NOW });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(QuiescenceError);
    // Still exit 2, so every existing caller behaves identically.
    expect((thrown as { exitCode: number }).exitCode).toBe(2);
    expect((thrown as { report: { ok: boolean } }).report.ok).toBe(false);
  });

  test("--accept closes on the human's words and records anomaly(accepted_close)", async () => {
    // Craig's ruling (2026-07-30): terminal access can't be assumed — acceptance
    // arrives in conversation, so the CLI must accept a relayed quote.
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    saidInTranscript(ACCEPTANCE);

    const r = await h.cli("close", tid, "--accept", ACCEPTANCE);
    expect(r.code).toBeLessThanOrEqual(3);
    expect(r.out).toContain("ACCEPTED");
    expect(r.out).not.toContain("FORCED");

    const row = h.db
      .query<{ detail: string }, [string]>(
        "SELECT detail FROM anomaly WHERE kind = 'accepted_close' AND tid = ?",
      )
      .get(tid);
    // Verbatim: the quote IS the audit trail for a close no arithmetic authorised.
    expect(row?.detail).toContain(ACCEPTANCE);
    expect(row?.detail).toContain("verified against a bound session's transcript");
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(1);
    // A DISTINCT kind from --force, which stays what it always was.
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'forced_close'").get()?.n,
    ).toBe(0);
    // BENIGN: a human ending their own task is the system working.
    expect(BENIGN_ANOMALY_KINDS.has("accepted_close")).toBe(true);
    expect(BENIGN_ANOMALY_KINDS.has("forced_close")).toBe(false);
  });

  test("--accept is not blocked by the accepting conversation's own open turn", async () => {
    // Consent arrives mid-conversation, so the turn Craig says it in is open by
    // construction. A gate that blocked on it would make the flag unreachable in the
    // only situation it exists for; the final turn's trailing spend lands in a later
    // revision, which is what `outcome` being append-only is for.
    const tid = await openTask();
    turn(h.db, { session: "s1", prompt: "p2", at: minutesBefore(new Date(), 2), durationMs: null });
    request(h.db, "r-live", { prompt: "p2", out: 10, ts: minutesBefore(new Date(), 1) });
    attributeTasks(h.db);
    const gate = quiescence(h.db, tid, new Date());
    expect(gate.open_turns).toBe(1);

    saidInTranscript(ACCEPTANCE);
    const r = await h.cli("close", tid, "--accept", ACCEPTANCE);
    expect(r.code).toBeLessThanOrEqual(3);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(1);
  });

  test("an acceptance nobody said is REFUSED — the agent is not the evidence", async () => {
    // §P1.12 applied to consent. The transcript holds a different sentence entirely;
    // an agent that supplies words the human never typed gets exit 2, not a close.
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    saidInTranscript("how is the estimator work going?");

    const r = await h.cli("close", tid, "--accept", ACCEPTANCE);
    expect(r.code).toBe(2);
    expect(r.err).toContain("appear in no bound session's transcript");
    expect(r.err).toContain("never supply one they did not give");
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(0);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'accepted_close'").get()?.n,
    ).toBe(0);
  });

  test("the agent cannot manufacture its own evidence out of a tool_result", async () => {
    // A `tool_result` is a user-ROLE line the harness wrote, and this CLI's own output
    // lands in one. Without the exclusion, printing the sentence would create the
    // record that "verifies" it on the next attempt.
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    saidInTranscript(ACCEPTANCE, { asToolResult: true });

    const r = await h.cli("close", tid, "--accept", ACCEPTANCE);
    expect(r.code).toBe(2);
    expect(r.err).toContain("appear in no bound session's transcript");
  });

  test("a short or common quote is not consent, however truly it was said", async () => {
    // A bare substring test verifies `--accept "ok"` against the "ok" inside "token" and
    // against essentially any transcript ever written, which is the assertion this check
    // exists to replace. The floor is stated against SKILL.md's criterion: a first-person
    // acceptance of completion is a sentence, not two syllables.
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    saidInTranscript("ok, that token looks good — done");

    for (const tooShort of ["ok", "done", "looks good"]) {
      expect(tooShort.length).toBeLessThan(MIN_ACCEPTANCE_CHARS);
      const r = await h.cli("close", tid, "--accept", tooShort);
      expect(r.code).toBe(2);
    }
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(0);
  });

  test("a quote that only appears INSIDE a longer word is not a match", async () => {
    // Whole-phrase matching, bounded by non-word characters: the floor stops the
    // trivially common needle, this stops the accidental one, and neither guard covers
    // the other's case.
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    saidInTranscript("the unacceptedness of it all is remarkable");

    const r = await h.cli("close", tid, "--accept", "accepted");
    expect(r.code).toBe(2);
    // And the canonical sentence, in the same corpus shape, still verifies.
    saidInTranscript(ACCEPTANCE);
    expect((await h.cli("close", tid, "--accept", ACCEPTANCE)).code).toBeLessThanOrEqual(3);
  });

  test("an acceptance said BEFORE the task existed does not verify it", async () => {
    // A session is long-lived and hosts many tasks. Without the floor, one acceptance
    // typed in the morning would verify every task opened in that session afterwards —
    // real consent, attached to work that had not been conceived of when it was given.
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    saidInTranscript(ACCEPTANCE, { at: LONG_AGO });

    const r = await h.cli("close", tid, "--accept", ACCEPTANCE);
    expect(r.code).toBe(2);
    expect(r.err).toContain("after it was opened");

    // The same words, said after the task was opened, verify normally.
    saidInTranscript(ACCEPTANCE);
    expect((await h.cli("close", tid, "--accept", ACCEPTANCE)).code).toBeLessThanOrEqual(3);
  });

  test("the match survives smart quotes, casing and re-wrapped whitespace", async () => {
    // A chat client curls the apostrophe the agent relays straight. Comparing raw text
    // would refuse a consent that was plainly given — and the fix must not go further:
    // stripping punctuation would start matching sentences nobody said.
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    saidInTranscript("Yes — I accept   this task\nas complete, that’s done");

    const r = await h.cli("close", tid, "--accept", "I ACCEPT this task as complete, that's done");
    expect(r.code).toBeLessThanOrEqual(3);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(1);
  });

  test("--accept and --force together is a usage error at BOTH layers", async () => {
    const tid = await openTask();
    saidInTranscript(ACCEPTANCE);
    const r = await h.cli("close", tid, "--accept", ACCEPTANCE, "--force");
    expect(r.code).toBe(1);
    expect(r.err).toContain("never both");
    // And the library refuses it too, so no other caller can reach the state.
    expect(() => closeTask(h.db, { tid, accept: ACCEPTANCE, force: true })).toThrow(
      /two different claims/,
    );
  });

  test("--accept cannot close as reopened or deleted: it asserts COMPLETION", async () => {
    const tid = await openTask();
    saidInTranscript(ACCEPTANCE);
    for (const status of ["reopened", "deleted"] as const) {
      const r = await h.cli("close", tid, "--accept", ACCEPTANCE, "--status", status);
      expect(r.code).toBe(1);
      expect(r.err).toContain("asserts the work is COMPLETE");
      expect(() => closeTask(h.db, { tid, accept: ACCEPTANCE, status })).toThrow(/COMPLETE/);
    }
  });

  test("re-accepting an already-closed task is exit 2, pointing at --status reopened", async () => {
    const tid = await quietTask();
    expect((await h.cli("close", tid)).code).toBe(0);
    saidInTranscript(ACCEPTANCE);

    const r = await h.cli("close", tid, "--accept", ACCEPTANCE);
    expect(r.code).toBe(2);
    expect(r.err).toContain("already completed");
    expect(r.err).toContain("--status reopened");
    // Still exactly one outcome revision: the refusal wrote nothing.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(1);
  });

  test("an acceptance on a task that was ALREADY quiet is audited, but not marked a bypass", async () => {
    // `accepted` is symmetric with `forced`: true only when the flag actually overrode
    // something. The audit row is written either way — the provenance of a close is
    // worth recording whether or not it needed the bypass — and says which it was.
    const tid = await quietTask();
    saidInTranscript(ACCEPTANCE);
    const r = closeTask(h.db, { tid, accept: ACCEPTANCE, now: NOW });
    expect(r.quiescence.ok).toBe(true);
    expect(r.accepted).toBe(false);

    const row = h.db
      .query<{ detail: string }, [string]>(
        "SELECT detail FROM anomaly WHERE kind = 'accepted_close' AND tid = ?",
      )
      .get(tid);
    expect(row?.detail).toContain("the quiescence gate was already met");
  });

  test("the audit row is de-duplicated: one sentence, one consent in the ledger", async () => {
    // `est close` exits 3 when it finalizes WITH alerts, and a caller that reads 3 as
    // failure and retries must not leave a ledger showing two consents. The terminal
    // guard now catches the simple retry, so this drives the path that is still
    // reachable — accept, reopen, accept the same sentence again — and it collapses.
    // That is the intended trade: an identical quote is one decision on the record.
    const tid = await quietTask();
    saidInTranscript(ACCEPTANCE);
    closeTask(h.db, { tid, accept: ACCEPTANCE, now: NOW });
    closeTask(h.db, { tid, status: "reopened", now: NOW });
    closeTask(h.db, { tid, accept: ACCEPTANCE, now: NOW });
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'accepted_close'").get()?.n,
    ).toBe(1);
  });

  test("the sweeper appends the corrective revision when late spend lands after an accept", async () => {
    // The accepting turn is still streaming when the close runs — that is what
    // "consent arrives mid-conversation" MEANS — so an accepted close under-reports by
    // construction. "A close is a revision" was true only in the sense that a human
    // could close again; nothing did. Now the sweeper does.
    const tid = await openTask();
    request(h.db, "r-1", { out: 100, ts: minutesBefore(new Date(), 5) });
    attributeTasks(h.db);
    saidInTranscript(ACCEPTANCE);
    const first = closeTask(h.db, { tid, accept: ACCEPTANCE, now: new Date() });
    expect(first.revision).toBe(1);
    expect(first.actual_wcet).toBe(100);

    // The tail of that same turn: requests the sweep only sees afterwards.
    request(h.db, "r-late", { out: 400, ts: new Date(Date.now() + 1000).toISOString() });
    attributeTasks(h.db);

    const root = mkdtempSync(join(tmpdir(), "est-close-empty-corpus-"));
    corpusRoots.push(root);
    const report = await runSweep(h.db, { root });
    expect(report.outcomes_healed).toBe(1);

    const revisions = h.db
      .query<{ revision: number; actual_wcet: number; final_status: string }, [string]>(
        "SELECT revision, actual_wcet, final_status FROM outcome WHERE tid = ? ORDER BY revision",
      )
      .all(tid);
    expect(revisions).toHaveLength(2);
    // Appended, never edited: revision 1 still says what it said.
    expect(revisions[0]).toMatchObject({ revision: 1, actual_wcet: 100 });
    expect(revisions[1]).toMatchObject({ revision: 2, actual_wcet: 500, final_status: "completed" });

    // The correction is the sweeper's own arithmetic, so it records no anomaly of its
    // own and does not re-append the consent.
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'accepted_close'").get()?.n,
    ).toBe(1);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'forced_close'").get()?.n,
    ).toBe(0);

    // Idempotent: a second sweep with nothing new appends nothing.
    const again = await runSweep(h.db, { root });
    expect(again.outcomes_healed).toBe(0);
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM outcome WHERE tid = ?").get(tid)?.n,
    ).toBe(2);
  });

  test("a healing sweep appends the revision and NOT another judgment anomaly", async () => {
    // The heal path used to reach `closeTask`'s blind inserts for `scope_undeclared` and
    // `tid_unplanted`, so every healing sweep re-appended both — and `tid_unplanted` is
    // ALERTING, so the nightly sweep exited 3 on rows the sweeper had just written
    // itself, about a fact nobody could act on. A heal re-runs arithmetic over finished
    // work; it is not a second judgment of how the task was run.
    const tid = await openTask();
    request(h.db, "r-1", { out: 100, ts: minutesBefore(new Date(), 5) });
    // A Task-tool task existed in the anchor session and nothing planted the tid — the
    // condition behind `tid_unplanted`.
    h.db.query(
      `INSERT INTO task_event (session_id, task_num, ts, kind, from_status, to_status, source)
       VALUES ('s1', '4', ?, 'create', NULL, 'pending', 'transcript')`,
    ).run(LONG_AGO);
    attributeTasks(h.db);
    saidInTranscript(ACCEPTANCE);
    closeTask(h.db, { tid, accept: ACCEPTANCE, now: new Date() });

    // Scope drifted after the close, detected and never declared.
    h.db.query(
      `INSERT INTO task_scope (tid, seq, ts, subject, description, dod_json, scope_hash, source, reason, diff_summary)
       VALUES (?, 2, ?, 'widget pipeline rewrite, plus the migration', NULL, '[]', 'hash2', 'sweeper_diff', NULL, NULL)`,
    ).run(tid, LONG_AGO);

    // Only the CLOSE's own kinds are pinned: a sweep legitimately writes others of its
    // own (the v10 identity repair, for one), and this test is about what the heal path
    // must not re-say.
    const closeAnomalies = (): Array<{ kind: string; n: number }> =>
      h.db
        .query<{ kind: string; n: number }, []>(
          `SELECT kind, COUNT(*) AS n FROM anomaly
            WHERE kind IN ('tid_unplanted','scope_undeclared','accepted_close','forced_close')
            GROUP BY kind ORDER BY kind`,
        )
        .all();
    const before = closeAnomalies();
    expect(before.find((r) => r.kind === "tid_unplanted")?.n).toBe(1);

    request(h.db, "r-late", { out: 400, ts: new Date(Date.now() + 1000).toISOString() });
    attributeTasks(h.db);
    const root = mkdtempSync(join(tmpdir(), "est-close-empty-corpus-"));
    corpusRoots.push(root);
    const report = await runSweep(h.db, { root });

    expect(report.outcomes_healed).toBe(1);
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM outcome WHERE tid = ?").get(tid)?.n,
    ).toBe(2);
    // Not one new judgment row: no duplicate finding, and nothing that would make the
    // sweep exit 3 on a row its own repair had just written.
    expect(closeAnomalies()).toEqual(before);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'scope_undeclared'").get()?.n,
    ).toBe(0);
  });

  test("the judgment anomalies are de-duplicated on the normal path too", async () => {
    // A reopen/re-close cycle re-evaluates the same condition, and neither row carries a
    // count or a timestamp in its detail — an identical row is the same observation
    // restated, not a second finding.
    const tid = await quietTask();
    h.db.query(
      `INSERT INTO task_event (session_id, task_num, ts, kind, from_status, to_status, source)
       VALUES ('s1', '4', ?, 'create', NULL, 'pending', 'transcript')`,
    ).run(LONG_AGO);
    closeTask(h.db, { tid, now: NOW });
    closeTask(h.db, { tid, status: "reopened", now: NOW });
    closeTask(h.db, { tid, now: NOW });
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'tid_unplanted'").get()?.n,
    ).toBe(1);
  });

  test("an empty --accept is a usage error, not a silent override", async () => {
    const tid = await openTask();
    request(h.db, "r-now", { out: 100, ts: new Date().toISOString() });
    attributeTasks(h.db);
    const r = await h.cli("close", tid, "--accept", "   ");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--accept");
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outcome").get()?.n).toBe(0);
    expect(
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM anomaly WHERE kind = 'accepted_close'").get()?.n,
    ).toBe(0);
  });

  test("a quiet task closes cleanly at exit 0", async () => {
    const tid = await quietTask();
    const r = await h.cli("close", tid);
    expect(r.code).toBe(0);
    expect(r.out).toContain("closed");
    expect(r.out).not.toContain("FORCED");
  });

  test("an unknown tid is REJECTED (exit 2)", async () => {
    expect((await h.cli("close", "no-such-tid")).code).toBe(2);
  });

  test("a task with no estimate is REJECTED: an outcome with no baseline is not a measurement", () => {
    // Built by hand rather than by deleting an estimate, because `estimate` is
    // append-only BY TRIGGER — the delete this test would otherwise need is itself
    // one of the operations the design forbids.
    h.db.query(
      `INSERT INTO task (tid, kind, status, created_at, anchor_session, anchor_prompt)
       VALUES ('bare-tid', 'implement', 'estimating', ?, 's1', 'p1')`,
    ).run(LONG_AGO);
    h.db.query(
      `INSERT INTO task_scope (tid, seq, ts, subject, description, dod_json, scope_hash, source, reason, diff_summary)
       VALUES ('bare-tid', 1, ?, 'no estimate here', NULL, '[]', 'aaaa', 'est_open', NULL, NULL)`,
    ).run(LONG_AGO);
    expect(() => closeTask(h.db, { tid: "bare-tid", now: NOW })).toThrow(/no estimate/);
  });

  test("--status is validated against the closed set", async () => {
    const tid = await quietTask();
    expect((await h.cli("close", tid, "--status", "finished")).code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P1.7 — the arithmetic
// ---------------------------------------------------------------------------

describe("est close — P1.7 the actual is arithmetic", () => {
  test("actual_wcet, the origin split, request and agent counts all come from the logs", async () => {
    const tid = await quietTask();
    const r = closeTask(h.db, { tid, now: NOW });
    expect(r.actual_wcet).toBe(1000);
    expect(r.wcet_main).toBe(200);
    expect(r.wcet_sub).toBe(800);
    expect(r.wcet_aux).toBe(0);
    expect(r.n_requests).toBe(2);
    expect(r.n_agents).toBe(1);
  });

  test("the three clocks are the interval UNION, with parallelism reported", async () => {
    const tid = await quietTask();
    const r = closeTask(h.db, { tid, now: NOW });
    // turn 00:00:00–00:01:00 and agent 00:01:00–00:06:00 are back to back: 360 s of
    // union at concurrency 1, and busy == active because nothing overlapped.
    expect(r.active_s).toBe(360);
    expect(r.busy_s).toBe(360);
    expect(r.max_concurrency).toBe(1);
    expect(r.parallelism_factor).toBeCloseTo(1, 5);
  });

  test("velocity is computed from actual_wcet_at_epoch and judged against the FIRST estimate", async () => {
    const tid = await quietTask();
    // A refinement that moves the band must not become the baseline. BOTH ends move:
    // `est open` refuses a p90 below the p50, so the fixture cannot raise p50 alone.
    await h.cli(
      ...openArgs({ subject: "", "raw-p50": 1_000_000, "raw-p90": 3_000_000 }),
      "--tid",
      tid,
      "--reason",
      "refinement",
    );
    const r = closeTask(h.db, { tid, now: NOW });

    const eids = h.db.query<{ eid: number }, [string]>(
      "SELECT eid FROM estimate WHERE tid = ? ORDER BY eid",
    ).all(tid).map((x) => x.eid);
    expect(r.eid_at_start).toBe(eids[0]!);
    expect(r.eid_final).toBe(eids[1]!);
    // raw p50 was 1,000 and the actual is 1,000 Work-CET => velocity 1.0 against the
    // BASELINE. Against the refinement it would have been 0.001, which is the number
    // an estimator could manufacture if refinements re-pointed the baseline.
    expect(r.velocity_raw).toBeCloseTo(1, 6);
    expect(r.in_band).toBe(true);
  });

  test("velocity stays NULL rather than joining under a vintage that never existed", async () => {
    const tid = await quietTask();
    // Remove the ref model's price: `v_task_actual_epoch` can no longer normalise, so
    // the honest answer is "not computable" and the task drops out of the corpus.
    h.db.query("DELETE FROM model_price WHERE family = 'claude-sonnet-4-5'").run();
    const r = closeTask(h.db, { tid, now: NOW });
    expect(r.actual_wcet_at_epoch).toBeNull();
    expect(r.velocity_raw).toBeNull();
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM v_velocity WHERE bucket = 'global' AND velocity_raw IS NOT NULL").get("")?.n ?? 0,
    ).toBe(0);
  });

  test("ceremony overhead is reported separately and excluded from the actual", async () => {
    const tid = await openTask();
    request(h.db, "r-work", { out: 500, ts: "2026-01-01T00:01:00Z" });
    request(h.db, "r-ceremony", { out: 400, ts: "2026-01-01T00:01:30Z", skill: "estimating" });
    attributeTasks(h.db);
    const r = closeTask(h.db, { tid, now: NOW });
    expect(r.actual_wcet).toBe(500);
    expect(r.overhead_wcet).toBe(400);
  });

  test("an unpriced request is an alerting condition (exit 3), never a silently smaller actual", async () => {
    const tid = await openTask();
    request(h.db, "r-priced", { out: 500, ts: "2026-01-01T00:01:00Z" });
    request(h.db, "r-unpriced", { family: "claude-unknown-0", out: 5000, ts: "2026-01-01T00:01:30Z" });
    attributeTasks(h.db);
    const r = await h.cli("close", tid);
    expect(r.code).toBe(3);
    expect(r.out).toContain("unpriced_share");
    const row = h.db.query<{ unpriced_share: number }, [string]>(
      "SELECT unpriced_share FROM outcome WHERE tid = ?",
    ).get(tid)!;
    expect(row.unpriced_share).toBeCloseTo(0.5, 6);
  });

  test("abandoned and deleted are right-censored: the actual is a LOWER bound", async () => {
    const tid = await quietTask();
    const r = closeTask(h.db, { tid, status: "abandoned", now: NOW });
    expect(r.censored).toBe(true);
    expect(h.db.query<{ status: string }, [string]>("SELECT status FROM task WHERE tid = ?").get(tid)!.status).toBe("abandoned");
    // Censored rows are kept for the cost distribution and excluded from velocity.
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_velocity").get()?.n).toBe(0);
  });

  test("a scope revision since the baseline is recorded, and an undeclared drift is an anomaly", async () => {
    const tid = await quietTask();
    // Drift with no `est scope` call: appended directly, the way the sweeper would
    // discover it. The close must notice that the scope moved without a declaration.
    h.db.query(
      `INSERT INTO task_scope (tid, seq, ts, subject, description, dod_json, scope_hash, source, reason, diff_summary)
       VALUES (?, 2, ?, 'drifted subject', NULL, '[]', 'deadbeef', 'sweeper_diff', NULL, NULL)`,
    ).run(tid, LONG_AGO);
    const r = closeTask(h.db, { tid, now: NOW });
    expect(r.scope_changed).toBe(true);
    expect(r.scope_declared).toBe(false);
    expect(
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM anomaly WHERE kind='scope_undeclared' AND tid = ?").get(tid)?.n,
    ).toBe(1);
  });

  test("the burn cache row is dropped on close, so the statusline cannot show a closed band", async () => {
    const tid = await quietTask();
    h.db.query(
      "INSERT INTO burn_cache (tid, as_of, consumed_wcet) VALUES (?, ?, 1)",
    ).run(tid, LONG_AGO);
    closeTask(h.db, { tid, now: NOW });
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM burn_cache").get()?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P1.7 — the close's attribution pass never moves a sibling's spend
// ---------------------------------------------------------------------------

describe("est close — P1.7 the attribution pass is global", () => {
  test("closing one task leaves a SIBLING task's agent spend where it was", async () => {
    const a = await quietTask();

    // A second task in the same session, owning a sub-agent of its own — the shape
    // `est bind --agent` produces, and the one an attribution pass that could see only
    // the closing task would resolve to "nobody claims this agent, so the session's
    // one task must own it".
    const open = await h.cli(
      ...openArgs({ subject: "sibling work" }), "--session", "s1", "--prompt", "p1", "--json",
    );
    expect(open.code).toBe(0);
    const b = open.json<{ tid: string }>().tid;
    agentRun(h.db, "ag-b", {
      session: "s1",
      launchPrompt: "p1",
      startedAt: "2026-01-01T00:03:00Z",
      endedAt: "2026-01-01T00:04:00Z",
    });
    expect((await h.cli("bind", b, "--agent", "ag-b")).code).toBe(0);
    request(h.db, "r-b", {
      origin: "subagent",
      agent: "ag-b",
      prompt: null,
      out: 500,
      ts: "2026-01-01T00:03:30Z",
    });
    attributeTasks(h.db);

    const ownerOf = (rid: string): string | null =>
      h.db.query<{ tid: string | null }, [string]>("SELECT tid FROM request WHERE request_id = ?").get(rid)!.tid;
    expect(ownerOf("r-b")).toBe(b);

    const closed = closeTask(h.db, { tid: a, now: NOW });
    // `outcome` is append-only, so a stolen request here would be permanently wrong.
    expect(closed.actual_wcet).toBe(1000);
    expect(closed.n_requests).toBe(2);
    expect(ownerOf("r-b")).toBe(b);
    expect(
      h.db.query<{ tid: string | null }, [string]>("SELECT tid FROM agent_run WHERE agent_id = ?").get("ag-b")!.tid,
    ).toBe(b);
    expect(
      h.db.query<{ wcet: number | null }, [string]>("SELECT wcet FROM v_task_actual WHERE tid = ?").get(b)?.wcet,
    ).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// P1.7 — reopen is a revision, never an edit
// ---------------------------------------------------------------------------

describe("est close — P1.7 reopen", () => {
  test("a second close appends revision 2 and v_outcome_current reads only the latest", async () => {
    const tid = await quietTask();
    expect(closeTask(h.db, { tid, now: NOW }).revision).toBe(1);
    const reopened = closeTask(h.db, { tid, status: "reopened", now: NOW });
    expect(reopened.revision).toBe(2);

    expect(h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM outcome WHERE tid = ?").get(tid)?.n).toBe(2);
    const current = h.db.query<{ revision: number; final_status: string }, [string]>(
      "SELECT revision, final_status FROM v_outcome_current WHERE tid = ?",
    ).get(tid)!;
    expect(current).toMatchObject({ revision: 2, final_status: "reopened" });
    // A reopened task is workable again: its status returns to in_progress.
    expect(h.db.query<{ status: string }, [string]>("SELECT status FROM task WHERE tid = ?").get(tid)!.status).toBe("in_progress");
  });

  test("estimates may be appended again after a reopen, but not while terminal", async () => {
    const tid = await quietTask();
    closeTask(h.db, { tid, now: NOW });
    const blocked = await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "refinement");
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain("finalized");

    closeTask(h.db, { tid, status: "reopened", now: NOW });
    const allowed = await h.cli(...openArgs({ subject: "" }), "--tid", tid, "--reason", "refinement");
    expect(allowed.code).toBe(0);
  });

  test("closing twice never overwrites the first outcome's numbers", async () => {
    const tid = await quietTask();
    const first = closeTask(h.db, { tid, now: NOW });
    request(h.db, "r-late", { out: 5000, ts: "2026-01-10T00:00:00Z" });
    closeTask(h.db, { tid, status: "reopened", now: NOW });
    const stored = h.db.query<{ actual_wcet: number }, [string]>(
      "SELECT actual_wcet FROM outcome WHERE tid = ? AND revision = 1",
    ).get(tid)!;
    expect(stored.actual_wcet).toBe(first.actual_wcet);
  });
});

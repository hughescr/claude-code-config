/**
 * src/identity.ts — WHO estimated, resolved once and the same way everywhere.
 *
 * `estimate.estimator_model` is a CALIBRATION KEY, not a label. `est retro` groups
 * `v_velocity` on `priceFamily(estimator_model)` and `est open` looks the reference
 * class up with the same string (`newestRefclass`), so two ceremonies that disagree
 * about the answer do not merely mis-label a row — they fit multipliers in one bucket
 * and read them out of another.
 *
 * The rule this file replaces was:
 *
 *     SELECT model_family FROM request
 *      WHERE session_id = ? AND origin = 'main' ORDER BY ts DESC LIMIT 1
 *
 * which is non-deterministic in three independent ways:
 *
 *  1. **Ingest lag.** `request` is written by the SWEEP (SessionEnd hook, launchd cron,
 *     throttled nudge micro-sweep). `est open` runs at the START of the anchoring turn
 *     — prompt read, plan formed, nothing launched — so the turn's own rows are not on
 *     disk yet, and a brand-new or freshly-resumed session has none at all.
 *     `resolveAnchor` already documents this exact state (its synthetic anchor).
 *  2. **`ORDER BY ts DESC` has no upper bound.** A `/model` switch or a fallback AFTER
 *     the ceremony retroactively changes what the same `est open` would have recorded.
 *  3. **Two resolvers.** `openTask` resolved the session through `resolveAnchor`
 *     (explicit flags -> env -> newest turn, refusing on ambiguity); `refclass` resolved
 *     it independently (env -> newest turn anywhere). Pass `--session` to one and not
 *     the other and step 1 of the ceremony prints one family's history while step 7
 *     stamps another's.
 *
 * ## The resolution rule (documented once, implemented once)
 *
 * {@link resolveEstimatorIdentity} answers in this strict order, and reports WHICH leg
 * answered so a config-pinned row is distinguishable from a derived one:
 *
 *   1. `env`           — `EST_ESTIMATOR_MODEL`.
 *   2. `config`        — `config.estimator_model`. An ESCAPE HATCH ONLY: it is
 *                        machine-wide and sits above the derivation, so setting it
 *                        mislabels every session not running that model, permanently
 *                        and invisibly. `est config set` warns.
 *   3. `statusline`    — `session_model`, upserted by the statusline shim from the
 *                        harness payload. Ingest-INDEPENDENT: fresh within one render.
 *   4. `anchor_prompt` — the FIRST `origin='main'` request of the ANCHORING TURN
 *                        (`session_id = ? AND prompt_id = ?`, `ORDER BY ts ASC`). Not
 *                        "newest": anchored to the turn being estimated, so it cannot
 *                        move afterwards.
 *   5. `at_created`    — the newest `origin='main'` request of the session at or before
 *                        the estimate's own `created_at`. Bounded above, so it is a
 *                        fixed function of the row rather than of the clock.
 *   6. `pending`       — `'unknown'`. NOT a failure and NOT an identity: a REPAIRABLE
 *                        SENTINEL. {@link repairEstimatorIdentity} revisits it once the
 *                        sweep has ingested the turn.
 *
 * Legs 4 and 5 read `origin = 'main'` only. A subagent request names the model the
 * orchestrator DELEGATED to, which is the single most confusing wrong answer available
 * here — it is how `DECISIONS.md`'s "that ceremony was run by an opus-5 orchestrator"
 * claim came to be written by an opus-5 SUBAGENT of a fable-5 orchestrator.
 *
 * ## Why corrections are appended beside the ledger, never into it
 *
 * `estimate` is append-only (physically: `est_ro_u` / `est_ro_d`), and every
 * calibration consumer joins on `outcome.eid_at_start`, which is `MIN(eid)` per task
 * ("first-estimate-wins", src/close.ts). So appending a corrected estimate VERSION
 * looks like a fix and changes nothing downstream. The correction therefore lives in
 * `estimate_identity_repair` (append-only, current = `MAX(seq)`), is projected by
 * `v_estimate_identity`, and `v_velocity` reads through that view. The ledger row is
 * never touched — `SELECT estimator_model FROM estimate` still returns what was
 * believed at the time.
 */

import type { Database } from "bun:sqlite";
import { getConfig } from "./db.ts";
import { NON_API_MODELS, priceFamily } from "./prices.ts";

/** The value written when no leg can answer. A sentinel, not a model. */
export const UNKNOWN_ESTIMATOR = "unknown";

/**
 * Is this string a model IDENTITY, as opposed to a placeholder that happens to be
 * stored in a model column?
 *
 * `request.model_family` is not a closed vocabulary of API models: a locally
 * generated assistant line carries `'<synthetic>'`, and a line whose model could not
 * be read carries the literal string `'unknown'` — byte-identical to
 * {@link UNKNOWN_ESTIMATOR}, this file's own "no leg could answer" sentinel.
 *
 * That collision was not theoretical. The repair pass selects its candidates with
 * `WHERE i.estimator_model = 'unknown'` and rejects only `method='pending'`, so an
 * anchor turn whose first main request had `model_family='unknown'` resolved with
 * `method='anchor_prompt'`, was "repaired" from `'unknown'` to `'unknown'`, and
 * remained a candidate — one append-only `estimate_identity_repair` row and one
 * `estimator_identity_repaired` anomaly per sweep, forever, on a table with a
 * `RAISE(ABORT,'append-only')` DELETE trigger. The pass's stated property is that a
 * second run writes nothing; this predicate is what makes that true.
 */
export function isModelIdentity(model: string): boolean {
  const m = model.trim();
  return m !== "" && !NON_API_MODELS.has(m.toLowerCase()) && m !== UNKNOWN_ESTIMATOR;
}

/** Which leg of the resolution order produced the answer. */
export type IdentityMethod =
  | "env"
  | "config"
  | "statusline"
  | "anchor_prompt"
  | "at_created"
  | "manual"
  | "pending";

/** The legs `estimate_identity_repair.method` accepts — a repair may not claim `env`. */
export const REPAIR_METHODS = ["anchor_prompt", "at_created", "statusline", "manual"] as const;
export type RepairMethod = (typeof REPAIR_METHODS)[number];

/**
 * What the answer was read off. Stored verbatim as the repair row's `evidence`, so a
 * correction can be re-derived (or refuted) from the ledger alone.
 *
 * `families` is the DISTINCT main-chain families in the window examined, and it is the
 * ambiguity test: more than one means the window spans a model switch and the repair
 * pass must refuse rather than pick.
 */
export interface IdentityEvidence {
  session: string | null;
  prompt_id: string | null;
  request_id: string | null;
  /** `origin='main'` requests in the window examined. */
  n_main: number;
  families: string[];
}

export interface EstimatorIdentity {
  /** The value to STORE in `estimate.estimator_model` / a repair row. */
  model: string;
  /** `priceFamily(model)` — the key `retro` groups on and `newestRefclass` looks up. */
  family: string;
  method: IdentityMethod;
  evidence: IdentityEvidence;
}

export interface ResolveOptions {
  /** The anchor session. Callers with an `Anchor` MUST pass `anchor.sessionId`. */
  session?: string | null;
  /** The anchoring turn. Callers with an `Anchor` MUST pass `anchor.promptId`. */
  promptId?: string | null;
  /** ISO instant the identity is resolved AT — the estimate's own `created_at`. */
  at?: string | null;
  /**
   * Restrict which legs may answer. Defaults to all of them.
   *
   * The repair pass passes `['anchor_prompt','at_created']` deliberately: `env`,
   * `config` and `statusline` describe the machine NOW, and using them to date a
   * historical row would be inventing evidence rather than recovering it.
   */
  sources?: readonly IdentityMethod[];
}

const ALL_SOURCES: readonly IdentityMethod[] = [
  "env",
  "config",
  "statusline",
  "anchor_prompt",
  "at_created",
];

interface MainRow {
  request_id: string;
  model_family: string;
}

/** Distinct, non-empty, sorted — a stable `families` list for the evidence blob. */
function distinctFamilies(rows: readonly MainRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const f = r.model_family.trim();
    if (f !== "") seen.add(f);
  }
  return [...seen].sort();
}

/**
 * The main-chain requests of one turn, oldest first.
 *
 * `request_id` breaks `ts` ties so two rows written in the same second cannot make the
 * answer depend on SQLite's row order — the whole point of this module is that the
 * same inputs give the same answer.
 */
function turnMainRows(db: Database, session: string, promptId: string): MainRow[] {
  return db
    .query<MainRow, [string, string]>(
      `SELECT request_id, model_family FROM request
        WHERE session_id = ? AND origin = 'main' AND prompt_id = ?
        ORDER BY ts ASC, request_id ASC`,
    )
    .all(session, promptId);
}

/** The session's main-chain requests at or before `at`, NEWEST first. */
function priorMainRows(db: Database, session: string, at: string): MainRow[] {
  return db
    .query<MainRow, [string, string]>(
      `SELECT request_id, model_family FROM request
        WHERE session_id = ? AND origin = 'main' AND ts <= ?
        ORDER BY ts DESC, request_id DESC`,
    )
    .all(session, at);
}

function identity(
  model: string,
  method: IdentityMethod,
  evidence: IdentityEvidence,
): EstimatorIdentity {
  return { model, family: priceFamily(model), method, evidence };
}

/**
 * The estimator identity, resolved by the documented order above.
 *
 * NEVER throws and never returns an empty string: the worst case is
 * `{ model: 'unknown', method: 'pending' }`, which is a bucket key like any other and
 * keeps every band comparable to the other bands issued under the same
 * not-yet-known model.
 */
export function resolveEstimatorIdentity(
  db: Database,
  opts: ResolveOptions = {},
): EstimatorIdentity {
  const sources = opts.sources ?? ALL_SOURCES;
  const allow = (m: IdentityMethod): boolean => sources.includes(m);

  const session = (opts.session ?? "").trim() === "" ? null : (opts.session as string).trim();
  const promptId = (opts.promptId ?? "").trim() === "" ? null : (opts.promptId as string).trim();
  const at = (opts.at ?? "").trim() === "" ? null : (opts.at as string).trim();

  const base: IdentityEvidence = {
    session,
    prompt_id: promptId,
    request_id: null,
    n_main: 0,
    families: [],
  };

  if (allow("env")) {
    const env = process.env.EST_ESTIMATOR_MODEL;
    if (env !== undefined && env.trim() !== "") {
      return identity(env.trim(), "env", { ...base, families: [env.trim()] });
    }
  }

  if (allow("config")) {
    const cfg = getConfig(db, "estimator_model");
    if (cfg !== null && cfg.trim() !== "") {
      return identity(cfg.trim(), "config", { ...base, families: [cfg.trim()] });
    }
  }

  if (allow("statusline") && session !== null) {
    const row = db
      .query<{ model_family: string }, [string]>(
        "SELECT model_family FROM session_model WHERE session_id = ?",
      )
      .get(session);
    if (row !== null && row !== undefined && row.model_family.trim() !== "") {
      const fam = row.model_family.trim();
      return identity(fam, "statusline", { ...base, families: [fam] });
    }
  }

  if (allow("anchor_prompt") && session !== null && promptId !== null) {
    const rows = turnMainRows(db, session, promptId);
    const first = rows.find((r) => r.model_family.trim() !== "");
    if (first !== undefined) {
      return identity(first.model_family.trim(), "anchor_prompt", {
        ...base,
        request_id: first.request_id,
        n_main: rows.length,
        families: distinctFamilies(rows),
      });
    }
  }

  if (allow("at_created") && session !== null && at !== null) {
    const rows = priorMainRows(db, session, at);
    const newest = rows.find((r) => r.model_family.trim() !== "");
    if (newest !== undefined) {
      return identity(newest.model_family.trim(), "at_created", {
        ...base,
        request_id: newest.request_id,
        n_main: rows.length,
        families: distinctFamilies(rows),
      });
    }
  }

  return identity(UNKNOWN_ESTIMATOR, "pending", base);
}

/**
 * The `session_model` upsert — the ingest-independent leg's only writer.
 *
 * Called from `scripts/statusline-burn.ts` behind `EST_SESSION_MODEL_CAPTURE=1`. The
 * gate is not timidity: the statusline payload's model field is not a documented
 * harness contract, and the P1.9 read path promises one indexed row read per render.
 * Turn it on once a real payload has been dumped and the field confirmed; until then
 * the resolver simply falls through to the transcript legs.
 */
export function recordSessionModel(
  db: Database,
  sessionId: string,
  model: string,
  now: Date = new Date(),
): void {
  const sid = sessionId.trim();
  const m = model.trim();
  if (sid === "" || m === "") return;
  db.query(
    `INSERT INTO session_model (session_id, model, model_family, seen_at)
     VALUES ($session_id, $model, $model_family, $seen_at)
     ON CONFLICT(session_id) DO UPDATE SET
       model = excluded.model,
       model_family = excluded.model_family,
       seen_at = excluded.seen_at`,
  ).run({
    $session_id: sid,
    $model: m,
    $model_family: priceFamily(m),
    $seen_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  } as never);
}

// ---------------------------------------------------------------------------
// the repair pass
// ---------------------------------------------------------------------------

export interface RepairProposal {
  eid: number;
  tid: string;
  from: string;
  to: string;
  method: RepairMethod;
  evidence: IdentityEvidence;
}

export interface RepairReport {
  /** Estimates whose EFFECTIVE identity is still the sentinel. */
  candidates: number;
  /** What would be (or was) written — one entry per repairable row. */
  proposals: RepairProposal[];
  /** Repair rows actually appended. 0 unless `apply` was set. */
  applied: number;
  /** Refused: the window examined held more than one main-chain family. */
  ambiguous: number;
  /** Left alone: no main-chain request is on disk yet. Retried next sweep. */
  pending: number;
}

export const ANOMALY_REPAIRED = "estimator_identity_repaired";
export const ANOMALY_AMBIGUOUS = "estimator_identity_ambiguous";

/**
 * Give every estimate whose EFFECTIVE estimator family is still `'unknown'` a concrete
 * one, by appending to `estimate_identity_repair`. Idempotent and conservative.
 *
 * Four rules, and every one of them is enforced in code rather than by convention:
 *
 *  1. **Only the sentinel is ever touched.** A recorded family may have come from an
 *     `EST_ESTIMATOR_MODEL` override that leaves no trace in `request`; silently
 *     "correcting" it to whatever the transcript says would be unsound AND would make
 *     the pass flip-flop the row on every sweep. Overriding a concrete value is
 *     `method='manual'` with a human-supplied note, which this function never does.
 *  2. **Only transcript legs may answer.** `env`/`config`/`statusline` describe the
 *     machine NOW. Dating a historical row from them is inventing evidence.
 *  3. **Unambiguous or nothing.** The resolved family must be the ONLY main-chain
 *     family in the window examined. Otherwise the row keeps `'unknown'` and one
 *     `estimator_identity_ambiguous` anomaly is written — ONCE per eid, because
 *     `anomaly` is already dominated by two chatty kinds and a third would make the
 *     ledger less readable rather than more.
 *  4. **No main request yet is not an error.** A resumed session can legitimately hold
 *     zero `origin='main'` rows for a while (the global `request_id` PK collapses
 *     replayed lines onto the first-ingested `session_id`, gate G-FORK). Those rows are
 *     counted as `pending` and retried, never reached into another session for. A
 *     main request that names no MODEL (`model_family` of `'unknown'`,
 *     `'<synthetic>'`, empty) is the same state and counted the same way — see
 *     {@link isModelIdentity} for the loop this closes.
 *
 * Idempotence is the property to assert: a second run over the same database writes
 * zero repair rows and zero anomalies, because a repaired row's EFFECTIVE value is no
 * longer the sentinel and so it is no longer a candidate.
 *
 * The caller owns the transaction and the lock: `runSweep` and `est repair-identity
 * --apply` each wrap this in an IMMEDIATE transaction, so a repair row and the anomaly
 * recording it land together or not at all.
 */
export function repairEstimatorIdentity(
  db: Database,
  opts: { now?: Date; apply?: boolean } = {},
): RepairReport {
  const now = opts.now ?? new Date();
  const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const apply = opts.apply === true;

  const candidates = db
    .query<
      {
        eid: number;
        tid: string;
        created_at: string;
        anchor_session: string | null;
        anchor_prompt: string | null;
        effective: string;
      },
      [string]
    >(
      `SELECT e.eid, e.tid, e.created_at,
              t.anchor_session, t.anchor_prompt,
              i.estimator_model AS effective
         FROM estimate e
         JOIN task t ON t.tid = e.tid
         JOIN v_estimate_identity i ON i.eid = e.eid
        WHERE i.estimator_model = ?
        ORDER BY e.eid ASC`,
    )
    .all(UNKNOWN_ESTIMATOR);

  const report: RepairReport = {
    candidates: candidates.length,
    proposals: [],
    applied: 0,
    ambiguous: 0,
    pending: 0,
  };

  for (const c of candidates) {
    const resolved = resolveEstimatorIdentity(db, {
      session: c.anchor_session,
      promptId: c.anchor_prompt,
      at: c.created_at,
      sources: ["anchor_prompt", "at_created"],
    });

    // `pending` by declaration, or `pending` in substance: a transcript leg that
    // answers with a placeholder (`'unknown'`, `'<synthetic>'`, empty) has not
    // identified anybody, and adopting it would repair the sentinel INTO the sentinel
    // — leaving the row a candidate and writing one unprunable repair row plus one
    // anomaly on every sweep from then on. Both are the same state: no evidence yet,
    // try again next sweep. See {@link isModelIdentity}.
    if (resolved.method === "pending" || !isModelIdentity(resolved.model)) {
      report.pending += 1;
      continue;
    }
    if (resolved.evidence.families.length !== 1) {
      report.ambiguous += 1;
      if (apply) writeAmbiguousOnce(db, ts, c.eid, c.tid, resolved.evidence);
      continue;
    }

    const method = resolved.method as RepairMethod;
    report.proposals.push({
      eid: c.eid,
      tid: c.tid,
      from: c.effective,
      to: resolved.model,
      method,
      evidence: resolved.evidence,
    });
    if (!apply) continue;

    const seq =
      (db
        .query<{ s: number | null }, [number]>(
          "SELECT MAX(seq) AS s FROM estimate_identity_repair WHERE eid = ?",
        )
        .get(c.eid)?.s ?? 0) + 1;
    db.query(
      `INSERT INTO estimate_identity_repair
         (eid, seq, repaired_at, estimator_model, method, evidence, note)
       VALUES ($eid, $seq, $repaired_at, $estimator_model, $method, $evidence, $note)`,
    ).run({
      $eid: c.eid,
      $seq: seq,
      $repaired_at: ts,
      $estimator_model: resolved.model,
      $method: method,
      $evidence: JSON.stringify(resolved.evidence),
      $note: null,
    } as never);
    db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES ($ts, $kind, $detail, $tid)").run({
      $ts: ts,
      $kind: ANOMALY_REPAIRED,
      $detail: `eid=${c.eid} ${c.effective} -> ${resolved.model} method=${method} n_main=${resolved.evidence.n_main}`,
      $tid: c.tid,
    } as never);
    report.applied += 1;
  }

  return report;
}

/**
 * One ambiguity anomaly per eid, ever.
 *
 * The detail is keyed by `eid=<n> ` so the dedup probe is an exact prefix rather than a
 * fuzzy match on prose that will be reworded one day.
 */
function writeAmbiguousOnce(
  db: Database,
  ts: string,
  eid: number,
  tid: string,
  evidence: IdentityEvidence,
): void {
  const already = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM anomaly WHERE kind = ? AND detail LIKE ?",
    )
    .get(ANOMALY_AMBIGUOUS, `eid=${eid} %`);
  if ((already?.n ?? 0) > 0) return;
  db.query("INSERT INTO anomaly (ts, kind, detail, tid) VALUES ($ts, $kind, $detail, $tid)").run({
    $ts: ts,
    $kind: ANOMALY_AMBIGUOUS,
    $detail: `eid=${eid} left 'unknown': the window examined held ${evidence.families.length} main-chain families [${evidence.families.join(", ")}] over ${evidence.n_main} request(s)`,
    $tid: tid,
  } as never);
}

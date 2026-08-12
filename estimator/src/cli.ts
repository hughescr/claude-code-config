#!/usr/bin/env bun
/**
 * src/cli.ts — the `est` command. Phase 0 collection + Phase 1 estimation (§8).
 *
 *   est init                    bootstrap ~/.claude/estimator + the database (idempotent)
 *   est sweep                   single-writer incremental sweep of the transcript corpus
 *   est backfill                full re-sweep over every surviving transcript + spend report
 *   est prices --sync           refresh model_price from the upstream pricing JSON
 *   est census                  sweep_census history + live corpus counts
 *   est config                  read/tune the calibration constants (§1.1 lives in `config`)
 *   est refclass                the reference class, shown BEFORE any number is stated
 *   est open                    mint or re-estimate a task; prints the calibrated band
 *   est block                   one per declared workflow phase, before the launch
 *   est bind                    attach a harness identity (session/task/run/agent) to a tid
 *   est scope                   append a scope revision (the `scope_change` precondition)
 *   est burn                    consumption against the band; --json is the statusline contract
 *   est close                   finalize by arithmetic — no flag accepts a token count
 *   est board                   the terminal/JSON read model, or --html/--md the file renderer
 *   est recon                   our number vs an Anthropic-computed one, on four axes
 *   est segments                the check-back corpus, and the knob that shapes it
 *   est retro                   weekly calibration + the write-back that makes it non-inert
 *   est repair-identity         append-only correction of a still-'unknown' estimator identity
 *   est anchor                  the story-point anchor registry, by id — list / define
 *
 * Three properties this file is responsible for (§2):
 *
 *  1. **Single writer.** Every path that writes takes the `flock`-style sweep lock
 *     from src/lock.ts, and takes it BEFORE opening a writable connection — `openDb()`
 *     applies pending migrations the moment it sees a stale `schema_version`, so a
 *     handle opened outside the lock is a schema write outside the lock, on a command
 *     that may never get the lock at all. Read-only paths (`census`, `refclass`,
 *     `burn`, `board`, `prices --show`, `retro --dry-run`) open `readonly: true`, which
 *     never migrates and never takes the lock. Nothing else in Phase 0 writes.
 *  2. **Idempotence.** A re-sweep of an unchanged corpus is a no-op: row writes go
 *     through the upsert-with-MAX statements in src/ingest.ts, `sweep_state` is a
 *     pure performance watermark, and anomalies are de-duplicated on (kind, detail)
 *     before insert so a daily cron does not grow the ledger by a copy per day.
 *  3. **Loud failures.** Nothing unparseable is dropped or zeroed — it lands in
 *     `anomaly`, is counted in the report, and raises the process exit code.
 *
 * Exit codes:
 *   0  success — INCLUDING a well-formed empty result
 *   1  usage error, or a fatal error (unreadable schema, schema_version mismatch)
 *   2  rejected by an invariant. The command was well-formed and the operation is
 *      not permitted. This is the ANTI-GOODHART code (P1.0/P1.12) and it must never
 *      be retried, worked around, or downgraded to a warning; its message names the
 *      append path that IS allowed.
 *   3  completed, but alerting anomalies were recorded (or the budget was exceeded)
 *   4  the sweep lock is held by another writer and `--blocking` was not given
 *
 * Zero npm dependencies: bun:sqlite + node builtins only.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ANCHOR_ID_KEY,
  ANCHOR_TEXT_KEY,
  DATA_ROOT,
  DB_PATH,
  SCHEMA_VERSION,
  anchorDefinition,
  getConfig,
  openDb,
  registerAnchor,
  repairAnchor,
  setConfig,
} from "./db.ts";
import {
  PROJECTS_ROOT,
  discoverCorpus,
  sessionFiles,
  sessionIdFromPath,
  type Corpus,
} from "./discover.ts";
import {
  ageDaysFrom,
  checkCensusCollapse,
  classifyPathKind,
  isExpected,
  readCensusConfig,
  runCorpusLossProbe,
  writeCorpusLoss,
  type ClassifiedLoss,
  type CorpusLossProbeResult,
} from "./census.ts";
import { applyFix, auditReport, renderAudit, type AuditReport } from "./audit.ts";
import {
  INSERT_ANOMALY_SQL,
  backfillTaskEventTids,
  detectForkReplays,
  ingestSession,
  markSidechainReplays,
  planCorpus,
  replayAnomalies,
  toIngestAnomalies,
  writeBatch,
  type IngestAnomaly,
  type IngestBatch,
  type ParseStats,
  type ReplayGroup,
  type TranscriptIndexEntry,
} from "./ingest.ts";
import { LOCK_PATH, LockBusyError, withLock } from "./lock.ts";
import {
  currentPrice,
  fillCw1h,
  isoSeconds,
  priceFamily,
  setManualPrice,
  showPrices,
  sync,
  type FillCw1hResult,
  type SyncResult,
} from "./prices.ts";
import { attributeTasks } from "./attribute.ts";
import {
  BURN_SCHEMA,
  burnJson,
  burnRead,
  classifyOpenError,
  refreshBurnCache,
  renderBurn,
  type BurnJson,
} from "./burn.ts";
import { closeTask, healClosedOutcomes, type FinalStatus } from "./close.ts";
import { closePassMarkerFile, runClosePass } from "./autoclose.ts";
import { board, retro, type RetroReport } from "./retro.ts";
import { DEFAULT_BOARD_LIMIT, regenerateBoardIfDue, renderBoardFiles } from "./board-render.ts";
import { promoteStartedTasks } from "./promote.ts";
import { emptyJobsResult, JOBS_ROOT, reconcileJobs } from "./jobs.ts";
import { otelDump, otelPort, otelStatus, renderOtelDump, renderOtelStatus } from "./otel-status.ts";
import { drainSpool, emptyDrain, ensureSpool, spoolDirFrom, SPOOL_DIR } from "./spool.ts";
import {
  DEFAULT_OTEL_SPOOL_RETENTION_DAYS,
  drainOtel,
  emptyOtelIngest,
  receiverDownAnomaly,
  telemetryConfigured,
} from "./otel.ts";
import {
  refreshSegments,
  scoreEtaModels,
  segmentsReport,
  writeEtaRuns,
  type SegmentsReport,
} from "./eta.ts";
import {
  computeRecon,
  evaluateCertification,
  renderRecon,
  writeRecon,
  type ReconAxis,
} from "./recon.ts";
import { repairEstimatorIdentity, type RepairReport } from "./identity.ts";
import {
  addBlock,
  appendScope,
  bindTask,
  COLD_START_N,
  InvariantError,
  isoNow,
  isPointsEstimand,
  openTask,
  POINTS_ESTIMAND,
  pointsToWcet,
  storyPointAnchor,
  parseDod,
  PLANT_MARKER,
  refclass,
  REFCLASS_BUDGET_CHARS,
  TASK_KINDS,
  UsageError,
  type EstimateReason,
  type TaskKind,
} from "./tasks.ts";

// ---------------------------------------------------------------------------
// argument parsing — pure, exported, and tested without running any command
// ---------------------------------------------------------------------------

export const COMMANDS = [
  "init",
  "sweep",
  "backfill",
  "prices",
  "census",
  "config",
  // v19: the story-point anchor REGISTRY, by id. `est config set sp_anchor_text` can
  // only ever define the anchor currently in force, which left every OTHER id — a legacy
  // one named by bands on disk, or one the v18 migration could not vouch for — with no
  // way in through the CLI at all.
  "anchor",
  // Phase 1 (§Phase 1 interfaces).
  "refclass",
  "open",
  "block",
  "bind",
  "scope",
  "burn",
  "close",
  "board",
  "retro",
  // v10: the append-only correction path for `estimate.estimator_model` (src/identity.ts).
  "repair-identity",
  // Phase 2 (§Phase 2 interfaces).
  "recon",
  "segments",
  "otel",
  "audit",
  "help",
  "version",
] as const;
export type Command = (typeof COMMANDS)[number];

export interface FlagSpec {
  /** `--x` / `--no-x`; value is `true` / `false`. */
  readonly booleans: readonly string[];
  /** `--x v` or `--x=v`; value is the string. */
  readonly values: readonly string[];
}

/** Accepted by every command; a hook or a cron line may put them anywhere. */
export const GLOBAL_FLAGS: FlagSpec = {
  booleans: ["help", "quiet", "json", "version"],
  values: ["db", "lock"],
};

export const COMMAND_FLAGS: Record<Command, FlagSpec> = {
  init: { booleans: [], values: [] },
  sweep: { booleans: ["blocking", "strict"], values: ["budget", "root", "chunk"] },
  backfill: { booleans: ["strict"], values: ["budget", "root", "chunk", "top"] },
  prices: {
    booleans: ["sync", "show", "fill-cw-1h", "cw-1h-unrecorded"],
    values: ["source", "set", "in", "out", "cw", "cr", "cw-1h", "at"],
  },
  census: { booleans: [], values: ["limit", "root"] },
  config: { booleans: [], values: [] },
  anchor: { booleans: [], values: ["note"] },
  refclass: {
    booleans: ["full"],
    // `session`/`prompt` are not a nicety: they are how step 1 of the ceremony is
    // pinned to the SAME anchor step 7 will use (src/identity.ts).
    values: ["kind", "fanout", "text", "limit", "session", "prompt"],
  },
  "repair-identity": { booleans: ["apply", "dry-run"], values: [] },
  open: {
    // `--from-blocks`: take the raw band from SUM(estimate_block) instead of from
    // --raw-p50/--raw-p90. For decomposed work the decomposition IS the estimate.
    booleans: ["from-blocks"],
    values: [
      "kind",
      "subject",
      "description",
      "dod",
      "raw-p50",
      "raw-p90",
      "exp-agents",
      "exp-wf-phases",
      "exp-files-write",
      "exp-turns",
      "exp-requests",
      "tid",
      "reason",
      "session",
      "prompt",
      "continue",
    ],
  },
  block: { booleans: [], values: ["phase", "title", "p50", "p90", "exp-agents", "model"] },
  bind: { booleans: [], values: ["session", "task", "run", "agent"] },
  scope: { booleans: [], values: ["reason", "subject", "description", "dod"] },
  burn: { booleans: ["refresh"], values: ["session"] },
  // `accept` takes a VALUE — the human's verbatim acceptance — because a boolean
  // "the human agreed" is exactly the unattributable override `--force` already is.
  close: { booleans: ["force"], values: ["status", "accept"] },
  board: { booleans: ["html", "md"], values: ["status", "limit", "out"] },
  retro: { booleans: ["dry-run"], values: ["as-of"] },
  recon: { booleans: ["certify", "dry-run"], values: ["window", "source"] },
  segments: { booleans: [], values: ["session", "gap", "since", "limit"] },
  audit: { booleans: ["fix"], values: ["root"] },
  otel: { booleans: ["status"], values: ["dump", "port"] },
  help: { booleans: [], values: [] },
  version: { booleans: [], values: [] },
};

const ALIASES: Readonly<Record<string, string>> = { h: "help", q: "quiet", v: "version" };

/**
 * Tokenising needs to know which flags take a value BEFORE the command is known
 * (`est --db /tmp/x.db sweep`), so the tokeniser uses the union and the resolved
 * command validates afterwards. That ordering is why an unknown flag and a
 * misplaced flag are two distinct error messages.
 */
const ALL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...GLOBAL_FLAGS.values,
  ...Object.values(COMMAND_FLAGS).flatMap((s) => s.values),
]);
const ALL_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  ...GLOBAL_FLAGS.booleans,
  ...Object.values(COMMAND_FLAGS).flatMap((s) => s.booleans),
]);

export interface Parsed {
  command: Command | null;
  flags: Record<string, string | boolean>;
  positionals: string[];
  errors: string[];
}

export function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = { command: null, flags: {}, positionals: [], errors: [] };
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]!;

    if (literal || tok === "-" || !tok.startsWith("-")) {
      if (!literal && out.command === null && !tok.startsWith("-")) {
        if ((COMMANDS as readonly string[]).includes(tok)) out.command = tok as Command;
        else out.errors.push(`unknown command: ${tok}`);
        continue;
      }
      out.positionals.push(tok);
      continue;
    }

    if (tok === "--") {
      literal = true;
      continue;
    }

    // -h / -q / -v, and -hq bundles.
    if (!tok.startsWith("--")) {
      for (const ch of tok.slice(1)) {
        const name = ALIASES[ch];
        if (name === undefined) out.errors.push(`unknown flag: -${ch}`);
        else out.flags[name] = true;
      }
      continue;
    }

    const body = tok.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? null : body.slice(eq + 1);

    if (name.startsWith("no-") && ALL_BOOLEAN_FLAGS.has(name.slice(3))) {
      if (inlineValue !== null) out.errors.push(`--${name} takes no value`);
      else out.flags[name.slice(3)] = false;
      continue;
    }

    // The value/boolean sets are a UNION over every verb, so one verb's value flag
    // shadows another verb's boolean of the same name: `--status` takes a value for
    // `est close` and `est board`, which made `est otel --status` swallow the next token
    // (or fail with "--status requires a value" when there was none). The verb in hand
    // breaks the tie when it declares the name as a boolean — and only then, so a flag
    // belonging to some OTHER command still parses exactly as before and still gets the
    // more useful "not valid for `est X`" message from the pass below.
    const spec = out.command === null ? null : COMMAND_FLAGS[out.command];
    const declaredBoolean = spec !== null && spec.booleans.includes(name);

    if (!declaredBoolean && ALL_VALUE_FLAGS.has(name)) {
      if (inlineValue !== null) {
        out.flags[name] = inlineValue;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        out.errors.push(`--${name} requires a value`);
        continue;
      }
      out.flags[name] = next;
      i += 1;
      continue;
    }

    if (ALL_BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null && inlineValue !== "true" && inlineValue !== "false") {
        out.errors.push(`--${name} is a boolean flag; got --${name}=${inlineValue}`);
      } else {
        out.flags[name] = inlineValue !== "false";
      }
      continue;
    }

    out.errors.push(`unknown flag: --${name}`);
  }

  // Flags valid for some OTHER command are a distinct, more useful error than
  // "unknown flag" — `est init --budget 20s` should say so plainly.
  if (out.command !== null) {
    const spec = COMMAND_FLAGS[out.command];
    const allowed = new Set([
      ...GLOBAL_FLAGS.booleans,
      ...GLOBAL_FLAGS.values,
      ...spec.booleans,
      ...spec.values,
    ]);
    for (const key of Object.keys(out.flags)) {
      if (!allowed.has(key)) out.errors.push(`--${key} is not valid for \`est ${out.command}\``);
    }
  }

  return out;
}

/** `20s`, `500ms`, `2m`, `1h`, or a bare number of seconds. Null when unparseable. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(text.trim());
  if (m === null) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(Number(m[1]) * mult);
}

function flagString(p: Parsed, name: string): string | null {
  const v = p.flags[name];
  return typeof v === "string" ? v : null;
}
/**
 * "Absent" and "empty" are different answers, and `est scope` is where the difference
 * bites: `appendScope` preserves the previous value only for `undefined`, so passing
 * `flagString`'s `null` for an omitted `--description` DELETES the description — and,
 * worse, that deletion changes `scope_hash`, which turns a re-submitted identical
 * subject into an "accepted" revision and manufactures the `scope_change` precondition
 * the no-op guard exists to make unforgeable (P1.12).
 */
function flagStringOpt(p: Parsed, name: string): string | undefined {
  return name in p.flags ? (flagString(p, name) ?? "") : undefined;
}
function flagBool(p: Parsed, name: string, dflt = false): boolean {
  const v = p.flags[name];
  return typeof v === "boolean" ? v : dflt;
}
function flagInt(p: Parsed, name: string, dflt: number): number {
  const v = flagString(p, name);
  if (v === null) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ---------------------------------------------------------------------------
// anomaly ledger — de-duplicated, so a daily cron does not grow it linearly
// ---------------------------------------------------------------------------

/**
 * Anomaly kinds that are EXPECTED against a live corpus and therefore do not on
 * their own make a sweep "failed":
 *   - `truncated_tail`: every session being written to right now has one;
 *   - `unpriced_model`: normal until `est prices --sync` has run once;
 *   - the three fork/compaction shapes below, which are what a real corpus of
 *     forked sessions LOOKS like, not damage taken by one.
 * They are still recorded and still reported — `--strict` promotes them.
 */
export const BENIGN_ANOMALY_KINDS: ReadonlySet<string> = new Set([
  "truncated_tail",
  "unpriced_model",
  // A `/compact` boundary is a normal event, recorded because Phase 1's
  // `outcome.compactions` needs the feed and §5.5 needs the preTokens depth — not
  // because anything went wrong. Alerting on it would make every long session's
  // nightly sweep exit 3 (see `compactionAnomalies` in src/ingest.ts).
  "compaction_continuation",
  // The other two structural facts of a FORKED corpus, benign for the same
  // reason and decided the same way. `symlink_alias` is one physical transcript
  // reachable from two session dirs after a fork with a sub-agent in flight;
  // `fork_replay` is a child session replaying its parent's history. Neither is
  // a failure: `planCorpus` resolves the alias to the link target and the global
  // `request` PK plus the §5.2 replay pass keep the duplicate out of every sum.
  // They are recorded because they are EVIDENCE — Phase 1 wants the shapes — and
  // because `insertAnomalies` dedups on (kind, detail), a steady-state nightly
  // sweep writes none of them. Alerting would fire 46 times on the first
  // backfill of the live tree and once per fork forever after.
  "symlink_alias",
  "fork_replay",
  // P2.8: a later sweep discovering an EARLIER attributed request than the
  // `started_at` already on file — a fork/alias resolving after the fact, same
  // shape as the two above. Reported because it is evidence (`est retro`'s
  // `never_started_share`-style honesty), not because moving a timestamp backwards
  // to a truer value is damage.
  "promotion_backdated",
  // §5.6 [R4]: the three shapes a corpus of BACKGROUND workflow agents has, decided
  // the same way and for the same reason as the two fork shapes above.
  // `agent_never_returned` is an agent the journal started and no `result` ever came
  // back for; `wf_relaunch_orphan` is an agent from an earlier launch under a runId
  // the harness reused, whose progress the state file overwrote;
  // `wf_relaunch_detected` is that reuse itself. None is damage: they are what
  // relaunching and killing agents LOOKS like, and the design's own promotion
  // condition (ii) is that these populations be "classified rather than counted as
  // join failures". Before this, they were 83% of the live ledger and made every
  // sweep exit 3 — the exact "must not cry wolf" failure §4.2 warns about.
  // `phase_unmapped` and `wf_record_mismatch` stay ALERTING: post-classifier they
  // fire only on a real plan or authoring mismatch, which is the whole point.
  "agent_never_returned",
  "wf_relaunch_orphan",
  "wf_relaunch_detected",
  // §5.8 v9 / P2.10 delta-9 (the split that never landed before this fix): a
  // `corpus_loss` row whose age is >= config.retention_days is an EXPECTED reap —
  // the built-in cleanup or the hook GC doing its job — not damage. Without this,
  // the first cron sweep after `cleanupPeriodDays` first reaps would exit 3 daily
  // forever, training the watchdog to be ignored (the exact failure this note's
  // sibling kinds above were added to avoid). A loss inside `vanish_alarm_days`,
  // or of unknown age, still raises the ALERTING `corpus_shrink` — see
  // src/census.ts and the `runSweep` block that classifies `newLosses`.
  "corpus_shrink_expected",
  // §5.8 v9, the other half of that split. `main_transcript_missing` is raised by
  // DISCOVERY (src/discover.ts), which sees only "no <sid>.jsonl under any project
  // dir" and has no age evidence at all. D2 then classifies the SAME loss with the
  // ledger's `last_seen` bound and splits it into `corpus_shrink` (alerting) vs
  // `corpus_shrink_expected` (benign). Leaving discovery's kind alerting defeated
  // that split for exactly the population it was built for: a transcript reaped past
  // `retention_days` produced `corpus_shrink_expected` AND `main_transcript_missing`,
  // and the sweep exited 3 anyway. The alerting decision for a missing main belongs
  // to D2, which has the evidence; this row stays recorded and reported, and
  // `--strict` still promotes it.
  "main_transcript_missing",
  // P2.1: a terminal `run_segment` restated or removed by a later re-cut. It is EVIDENCE
  // that the check-back fitting corpus moved — which the design insists must never happen
  // silently — and not damage, decided the same way and for the same reason as
  // `promotion_backdated` above: the recompute moved a number to a truer value. Two
  // populations produce it in normal life, one steady and one one-off. Steadily: the P2.4
  // OTEL drain fills `request.duration_ms` where there was none, and a filled gap either
  // merges two segments or moves a start earlier. Once: the 2026-07-30 boundary rule
  // re-cut the whole corpus, which is precisely the event this ledger row exists to
  // record. Alerting on either would exit 3 on every backfill and on every sweep that
  // drains a late duration — the "must not cry wolf" failure this set exists to prevent.
  // `insertAnomalies` dedups on (kind, detail) and the detail carries the CLASS rather
  // than the values, so a segment contributes at most two rows for its whole life.
  "segment_recut",
  // Craig, 2026-07-30: `est close --accept` — the human said the work is done, in the
  // conversation, and the agent relayed their words. BENIGN, and pointedly not
  // `forced_close`'s severity: `forced_close` is alerting because an override with no
  // one named behind it is a hole in the corpus's provenance, and this row is the
  // opposite — it exists to CARRY the provenance. It is also the ordinary path now
  // that the gate's completion signal can fire, so alerting on it would train the
  // watchdog to be ignored, which is what this whole set exists to prevent.
  "accepted_close",
  // Craig, 2026-07-30: the sweeper close pass (src/autoclose.ts) finalized a task nobody
  // ran `est close` on, on the strength of a terminal `task_event` the gate observed.
  // Same reading as `accepted_close` above, one step further: the row is PROVENANCE for a
  // close, not a report of an override, because the pass has no bypass — every arm of
  // §6.2's gate was met. It fires on the ORDINARY path (a task going quiet with its work
  // signalled done is the normal end of work, not an incident) and it fires from the
  // daily cron, so alerting on it would exit 3 on a routine leg forever.
  //
  // Its sibling `swept_abandon` is deliberately NOT in this set. The two rows record
  // opposite epistemic situations: `swept_close` says the corpus gained a measurement,
  // `swept_abandon` says it gained a right-censored lower bound and a task's attribution
  // window was permanently sealed on no evidence either way. That is worth an exit 3, and
  // it cannot cry wolf because it takes `close_abandon_after_h` (a week) of silence to
  // fire. `close_failed` is alerting for the same reason: a task that cannot be finalized
  // never enters the corpus at all, and nothing else in the system would ever say so.
  "swept_close",
  // The bookkeeping half of `close_failed` — one bounded breadcrumb per failed attempt,
  // capped at `close_fail_alert_after` rows per tid. Benign because a single failed
  // attempt is genuinely transient (a busy snapshot, a row another writer is mid-way
  // through); the ALERTING row is what the third one raises.
  "close_attempt_failed",
  // A candidate the gate has refused for over `close_blocked_after_h`. The gate refusing
  // is the gate WORKING, so this is evidence rather than damage — same reading as
  // `plant_unlinked` below. It exists so a refusal that has stopped being temporary is
  // visible; the ledger's (kind, detail, tid) dedup holds it to one row per failing arm.
  "close_blocked",
  // §3.2 step 6: a planted `est_tid` naming a tid with no `task` row. The alias is
  // correctly REFUSED (a transcript is untrusted input), so the row is evidence rather
  // than damage — same reading as `promotion_backdated` above. It is still worth a
  // ledger row: it is the only visible difference between "nobody planted" and
  // "somebody planted something this database cannot resolve".
  "plant_unlinked",
  // NOTE: `board_render_failed` (P2.7) is deliberately ABSENT from this set — it
  // does not go through `report.anomalies` at all (see the sweep's board-regen
  // step). The design's "never fails the sweep" is unconditional: `--strict`
  // promotes every kind IN this set, which a benign-but-still-counted board
  // failure would defeat.
]);

/**
 * Insert anomalies, skipping (kind, detail) pairs already in the ledger.
 *
 * `anomaly` has no natural key and `INSERT_ANOMALY_SQL` is a plain INSERT, so an
 * unguarded sweeper would re-log every dangling symlink and every torn tail on
 * every run — breaking "a re-sweep is a no-op" (§2). The guard is done batch-first
 * (one SELECT of existing keys, one filtered insert loop) rather than with a
 * per-row `WHERE NOT EXISTS`, which would be a table scan per anomaly.
 *
 * Returns the rows actually written.
 */
export function insertAnomalies(db: Database, rows: readonly IngestAnomaly[], now: string): IngestAnomaly[] {
  if (rows.length === 0) return [];

  const seen = new Set<string>();
  for (const r of db
    .query<{ kind: string; detail: string }, []>("SELECT kind, detail FROM anomaly WHERE tid IS NULL")
    .all()) {
    seen.add(`${r.kind} ${r.detail}`);
  }

  const stmt = db.prepare(INSERT_ANOMALY_SQL);
  const written: IngestAnomaly[] = [];
  for (const a of rows) {
    const detail = a.path === undefined ? a.detail : `${a.detail} [${a.path}]`;
    const key = `${a.kind} ${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stmt.run({ $ts: now, $kind: a.kind, $detail: detail } as never);
    written.push(a);
  }
  return written;
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

export interface SweepOptions {
  /** Corpus root. Defaults to {@link PROJECTS_ROOT}. */
  root?: string;
  /** P2.9: `~/.claude/jobs`. Defaults to {@link JOBS_ROOT}. */
  jobsRoot?: string;
  /** Wall-clock budget; the sweep commits what it has and stops. Null = unlimited. */
  budgetMs?: number | null;
  /** Ignore `sweep_state` watermarks and re-read every file (`est backfill`). */
  full?: boolean;
  /** Sessions per write transaction. Bounds memory on a large corpus. */
  chunkSessions?: number;
  /** Injected clock. */
  now?: Date;
  /**
   * P2.7: where `board.html`/`board.md` land. Defaults to `dirname(db.filename)` —
   * the same directory the database itself lives in, so a test opened against a
   * harness's own tmp `estimator.db` writes its board there too, never into this
   * checkout's real estimator dir.
   */
  boardDir?: string;
  /**
   * The hook / OTEL spool this sweep DRAINS, and the directory `.microsweep` and the
   * overrun markers are pruned from. Defaults to `spoolDirFrom(process.env,
   * dirname(db.filename))` — computed the SAME way as `SPOOL_DIR` but relative to THIS
   * database's own directory rather than the frozen module-level constant.
   *
   * **That default is a data-safety property, not a tidiness one.** `drainSpool` and
   * `drainOtel` both CONSUME what they read: they rename the jsonl to `.draining` and
   * `rmSync` it after the commit, and the spool is the only copy of those records until
   * a sweep turns them into rows. Passing the frozen `SPOOL_DIR` meant a sweep against
   * ANY database — a test harness's throwaway one, a copy someone was poking at —
   * drained the live spool into itself and deleted it, losing telemetry that had no
   * second home. A spool now belongs to the database it is drained into.
   */
  spoolDir?: string;
  /**
   * P2.7's throttle marker directory — where `.board` is stamped and read.
   *
   * Defaults to `<dirname(db.filename)>/spool`, deliberately WITHOUT consulting the
   * environment: `.board` is per-DATABASE render state (it throttles renders of THAT
   * database's board), whereas the hook spool is per-INSTALLATION and therefore
   * `EST_SPOOL_DIR`-overridable. In production the two resolve to the same directory —
   * the database lives in the estimator dir whose `spool/` the hooks write to — so
   * `pruneMarkers` still reaps the marker. They diverge only where an `EST_SPOOL_DIR`
   * is set, and there the divergence is the point: two databases must not share one
   * throttle.
   */
  boardSpoolDir?: string;
}

export interface SweepReport {
  root: string;
  swept_at: string;
  elapsed_ms: number;
  budget_ms: number | null;
  budget_exceeded: boolean;
  full: boolean;
  sessions: {
    total: number;
    ingested: number;
    /** Every file unchanged since the last sweep (watermark hit). */
    skipped: number;
    /** Discovered but carrying no readable artefact at all — nothing to ingest. */
    empty: number;
  };
  corpus: { files: number; bytes: number; sessions: number; oldest_mtime: string | null };
  rows: {
    requests: number;
    turns: number;
    agent_runs: number;
    workflow_runs: number;
    workflow_phases: number;
    /** `task_event` rows — TaskCreate AND TaskUpdate statusChange (§6.1). */
    task_events: number;
    /** Planted `est_tid`s seen — `task_alias(session_task)` candidates (§3.2 step 6).
     *  Seen, not minted: a plant naming a tid this database has never minted is
     *  dropped by `INSERT_TASK_ALIAS_SQL`'s existence guard. */
    task_plants: number;
    /** `task_event` rows this sweep linked to a tid via those aliases. */
    task_event_tids: number;
  };
  parse: ParseStats;
  /** Files whose read aborted before EOF; their watermark was deliberately NOT
   *  advanced, so the next sweep re-reads them (§5.2's watermark invariant). */
  files_incomplete: number;
  /** §5.2 second dedup pass: rows demoted to `attr='replay'` this sweep. */
  sidechain_replays: number;
  anomalies: { recorded: number; alerting: number; by_kind: Record<string, number> };
  /**
   * §5.8 v9: `total`/`lt_60d`/`paths` are D1 (the watermark diff) alone, preserved
   * byte-for-byte for the existing JSON contract. `sessions_lost` and `expected`
   * add D2 (src/census.ts's discovery-side probe) ON TOP: a session whose main
   * transcript vanished before it was ever watermarked has no `sweep_state` row to
   * diff, so D1 cannot see it and it would never appear in `total`/`paths` at all —
   * see src/census.ts's module doc for why a second detector is necessary.
   */
  vanished: {
    total: number;
    lt_60d: number;
    paths: string[];
    /** Session ids D2 recorded as newly lost THIS sweep (not previously known to `corpus_loss`). */
    sessions_lost: string[];
    /** Of every loss newly recorded this sweep (D1 + D2), how many are `expected`
     *  (age >= config.retention_days) — the P2.10 benign/alerting split. */
    expected: number;
  };
  /** P1.10/P1.11: what the hook spool contributed to this sweep. */
  spool: {
    task_events_read: number;
    task_events_inserted: number;
    compliance_read: number;
    compliance_unbound: number;
    /** Hook lines written with no readable database — not compliance evidence (P1.10). */
    compliance_db_unavailable: number;
    malformed: number;
    /** Stale `.microsweep` / `.overrun-notified.*` marker files reaped this sweep. */
    markers_pruned: number;
  };
  /**
   * P2.3/P2.4: what the OTEL spool contributed. Every field is 0 when no receiver is
   * running, which is the documented degrade-to-Phase-1 state and not a fault —
   * nothing errors, nothing blocks, no verb changes its exit code.
   */
  otel: {
    logs_read: number;
    metrics_read: number;
    requests_upserted: number;
    metrics_inserted: number;
    /** `request.duration_ms` filled — the ONE column OTEL may write (P2.4). */
    durations_filled: number;
    /** …and replaced, when a strictly higher `attempt` landed on a later drain. */
    durations_refreshed: number;
    /** `origin='auxiliary'` rows that have no transcript row by construction (§4.6). */
    auxiliary_inserted: number;
    /** Auxiliary rows this ingest superseded with a higher attempt's counters. */
    auxiliary_superseded: number;
    /** Auxiliary inserts suppressed by a row THIS INGEST DID NOT WRITE: the measured
     *  version of "auxiliary requests never appear in transcripts". */
    auxiliary_collisions: number;
    unjoined: number;
    /** True totals, not the size of the 50-row anomaly sample they drive. */
    counter_mismatches: number;
    prompt_mismatches: number;
    malformed: number;
    /** Bodies the receiver could not classify, still on disk awaiting a parser. */
    rejects_read: number;
    /** Trace summaries claimed and dropped — Phase 2 consumes no traces. */
    traces_dropped: number;
    /** Rotated reject/raw spool files reaped by `otel_spool_retention_days`. */
    spool_pruned: number;
  };
  /** §5.4: what the binding-driven attribution pass assigned. */
  attribution: {
    tasks: number;
    turns: number;
    agents: number;
    /** `workflow_run` rows that resolved a tid. Was structurally 0 before the F3 fix. */
    runs: number;
    requests: number;
    by_attr: Record<string, number>;
  };
  /** P1.9: non-terminal tasks whose materialised burn row was rewritten. */
  burn_cache_rows: number;
  /**
   * §6.2: corrective `outcome` revisions appended for closed tasks whose actual moved
   * after finalization — the late spend of an `--accept` close, chiefly. 0 in a steady
   * state, and a non-zero count is a correction that happened, not a warning.
   */
  outcomes_healed: number;
  /**
   * P1.7/§6.2 (Craig 2026-07-30): the SWEEPER CLOSE PASS — the thing the gate's
   * "leave it for the sweeper" refusal has always promised. `attempted: false` means the
   * `close_pass_min_interval_min` throttle skipped it, which is not a failure and costs
   * nothing (no query runs at all). `blocked` counts candidates the FULL quiescence gate
   * refused: they stay open and the next due pass asks again. See src/autoclose.ts.
   */
  close_pass: {
    attempted: boolean;
    /** Why it did not run: `"throttled"`, `"incomplete_sweep"`, or `null` when it did. */
    skipped: "throttled" | "incomplete_sweep" | null;
    candidates: number;
    completed: number;
    abandoned: number;
    deleted: number;
    blocked: number;
    failed: number;
    /** Gate-eligible, but inside the `close_abandon_after_h` safety margin. */
    awaiting_abandon: number;
  };
  /** P2.1: the check-back corpus — sessions revisited, segments cut, still open. */
  segments: { sessions: number; segments: number; open: number };
  /** P2.8: the sweeper's one status edge, and the `started_at` corrections beside it. */
  promotion: { promoted: number; started_at_set: number; started_at_backdated: number };
  /**
   * v10: estimator-identity repairs APPENDED beside the append-only ledger. `repaired`
   * is a one-way count — an eid stops being a candidate the moment it is repaired — so
   * a steady non-zero value across sweeps means the resolver is flip-flopping and is a
   * bug, not a workload.
   */
  identity_repair: { candidates: number; repaired: number; ambiguous: number; pending: number };
  /** P2.9: the `~/.claude/jobs` reconcile. Every field is 0 when `jobsRoot` does not
   *  exist — the same degrade-to-Phase-1 shape as `otel` above; nothing errors,
   *  nothing blocks, no verb changes its exit code because of this alone. */
  jobs: {
    dirs_read: number;
    parsed: number;
    malformed: number;
    bound: number;
    already_bound: number;
    unjoined: number;
    n_items: number;
    n_items_started: number;
  };
  /** P2.7: what `board.html`/`board.md` did this sweep. `attempted: false` means the
   *  throttle skipped it — not a failure, and the previous files are untouched either
   *  way. A failed render is `ok: false` and lives in `anomaly`, NOT in this sweep's
   *  exit code (the board is a convenience; the sweep is the system). */
  board: { attempted: boolean; ok: boolean };
}

export interface FileFingerprint {
  path: string;
  inode: number;
  bytes: number;
  /** ISO mtime at the moment of this stat. v9: written into `sweep_state.mtime` so
   *  a later vanish-age computation is exact rather than `last_swept`-inferred. */
  mtime: string;
}

function fingerprint(path: string): FileFingerprint | null {
  try {
    const st = statSync(path);
    return { path, inode: Number(st.ino), bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null; // vanished between discovery and ingest (GC race, §3.4)
  }
}

/**
 * The fingerprints that may become `sweep_state` watermarks: every file the
 * session touched, MINUS any whose read aborted before EOF.
 *
 * This is the whole fix for the watermark trap, so it is a named function rather
 * than an inline filter. A watermark says "these bytes are accounted for"; a file
 * whose stream errored has bytes nobody parsed. Writing it anyway means the next
 * incremental sweep computes (same inode, same bytes) -> `unchanged` -> skips the
 * session, and the unread tail is frozen out of every future sweep — recoverable
 * only by `est backfill --full`, which the cron never runs. Dropping the
 * fingerprint costs one re-read; every write path is idempotent (§2).
 */
export function watermarkable(
  prints: readonly FileFingerprint[],
  incompleteFiles: readonly string[],
): FileFingerprint[] {
  if (incompleteFiles.length === 0) return [...prints];
  const vetoed = new Set(incompleteFiles);
  return prints.filter((f) => !vetoed.has(f.path));
}

function emptyBatch(): IngestBatch {
  return {
    requests: [],
    turns: [],
    agentRuns: [],
    workflowRuns: [],
    workflowPhases: [],
    taskEvents: [],
    taskPlants: [],
    anomalies: [],
    files: [],
    stats: { lines: 0, blank: 0, parsed: 0, malformed: 0, truncatedTail: 0 },
    incompleteFiles: [],
    skippedFiles: [],
  };
}

/**
 * Accumulate what a flush WRITES. `files` is excluded on purpose: it is the D3
 * fork index, it is not rows, and it has to outlive every flush of the sweep (the
 * two halves of a fork are routinely in different chunks), so `runSweep` collects
 * it separately instead of letting `emptyBatch()` throw it away.
 */
function mergeBatch(into: IngestBatch, from: IngestBatch): void {
  into.requests.push(...from.requests);
  into.turns.push(...from.turns);
  into.agentRuns.push(...from.agentRuns);
  into.workflowRuns.push(...from.workflowRuns);
  into.workflowPhases.push(...from.workflowPhases);
  into.taskEvents.push(...from.taskEvents);
  into.taskPlants.push(...from.taskPlants);
  into.anomalies.push(...from.anomalies);
  into.incompleteFiles.push(...from.incompleteFiles);
  into.skippedFiles.push(...from.skippedFiles);
  into.stats.lines += from.stats.lines;
  into.stats.blank += from.stats.blank;
  into.stats.parsed += from.stats.parsed;
  into.stats.malformed += from.stats.malformed;
  into.stats.truncatedTail += from.stats.truncatedTail;
}

const UPSERT_SWEEP_STATE_SQL = `
INSERT INTO sweep_state (path, inode, bytes_read, last_swept, mtime)
VALUES ($path, $inode, $bytes_read, $last_swept, $mtime)
ON CONFLICT(path) DO UPDATE SET
  inode = excluded.inode, bytes_read = excluded.bytes_read, last_swept = excluded.last_swept,
  mtime = excluded.mtime
`;

const UPSERT_CENSUS_SQL = `
INSERT INTO sweep_census (swept_at, n_files, n_bytes, n_sessions, oldest_mtime, vanished_total, vanished_lt_60d)
VALUES ($swept_at, $n_files, $n_bytes, $n_sessions, $oldest_mtime, $vanished_total, $vanished_lt_60d)
ON CONFLICT(swept_at) DO UPDATE SET
  n_files = excluded.n_files, n_bytes = excluded.n_bytes, n_sessions = excluded.n_sessions,
  oldest_mtime = excluded.oldest_mtime,
  vanished_total = excluded.vanished_total, vanished_lt_60d = excluded.vanished_lt_60d
`;

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * discover -> ingest (which segments) -> write -> census. Must be called with the
 * sweep lock held; `sweepCommand` is the only caller that does that.
 *
 * The budget is checked between sessions, never inside one: a half-ingested
 * session would still be correct (upserts are idempotent) but leaving the
 * granularity at "whole sessions" keeps `sweep_state` truthful, which is what
 * makes the NEXT sweep cheap.
 */
export async function runSweep(db: Database, opts: SweepOptions = {}): Promise<SweepReport> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const sweptAt = now.toISOString();
  const root = opts.root ?? PROJECTS_ROOT;
  const jobsRoot = opts.jobsRoot ?? JOBS_ROOT;
  const budgetMs = opts.budgetMs ?? null;
  const full = opts.full ?? false;
  const chunkSessions = opts.chunkSessions ?? 25;
  const overBudget = (): boolean => budgetMs !== null && Date.now() - t0 > budgetMs;
  // P2.7: both default off THIS database's own directory, never off the frozen
  // module-level `ROOT`/`SPOOL_DIR` constants — see the doc comment on
  // `SweepOptions.boardDir` for why that is what keeps a test harness's sweep from
  // writing into this checkout's real estimator dir.
  const dbDir = dirname(db.filename);
  const boardDir = opts.boardDir ?? dbDir;
  const sweepSpoolDir = opts.spoolDir ?? spoolDirFrom(process.env, dbDir);
  // `{}`, not `process.env`: see SweepOptions.boardSpoolDir for why the marker is
  // db-relative where the drained spool is environment-overridable.
  const boardSpoolDir = opts.boardSpoolDir ?? spoolDirFrom({}, dbDir);

  const corpus: Corpus = discoverCorpus(root);
  // Corpus-wide before per-session: who owns a symlink-shared transcript, and
  // which state file describes each runId. Both answers are order-dependent if
  // left to `ingestSession` (G-FORK §3.4, G-PHASE §2b).
  const plan = planCorpus(corpus);

  // --- watermarks, scoped to THIS corpus root -------------------------------
  // A test corpus and the real one share one database only by accident, but the
  // vanished-file diff must never read one root's absence as the other's loss.
  const prefix = realRoot(root);
  const prior = new Map<string, { inode: number; bytes: number; lastSwept: string; mtime: string | null }>();
  for (const row of db
    .query<
      { path: string; inode: number; bytes_read: number; last_swept: string; mtime: string | null },
      []
    >("SELECT path, inode, bytes_read, last_swept, mtime FROM sweep_state")
    .all()) {
    if (!row.path.startsWith(prefix)) continue;
    prior.set(row.path, {
      inode: row.inode,
      bytes: row.bytes_read,
      lastSwept: row.last_swept,
      mtime: row.mtime,
    });
  }

  const onDisk = new Set<string>();
  for (const s of corpus.sessions) for (const p of sessionFiles(s)) onDisk.add(p);

  // --- §5.8 corpus shrinkage: D1, the watermark diff -------------------------
  // KNOWN IMPRECISION, stated rather than hidden: pre-v9 `sweep_state` carried no
  // column for the file's own mtime, so a vanished file's AGE was unknowable after
  // the fact and `last_swept` only bounded it from below. v9 adds `sweep_state.mtime`
  // (backfilled by `est backfill --full`); until a path has one, the age falls back
  // to `last_swept` — still a lower bound, so the failure mode stays a false ALARM,
  // never a missed one (`age_source` on the `corpus_loss` row says which was used).
  //
  // NOTE — this is D1 ALONE, and by construction: a path this database never
  // watermarked (deleted before its first sweep) is not in `prior` and cannot be
  // diffed here at all. That is the §5.8 root cause; D2 (src/census.ts,
  // `runCorpusLossProbe`, below) closes it from the discovery side.
  const censusCfg = readCensusConfig(db);
  // §5.8 risk #1, evaluated ONCE and BEFORE anything is classified, because it has
  // to gate BOTH detectors. It used to live inside `runCorpusLossProbe`, which runs
  // after `writeCorpusLoss(db, d1Losses)` — so a discovery outage (unmounted volume,
  // bad `EST_PROJECTS`, a project subtree moved aside while `--root` survives) was
  // laundered into exactly the durable `corpus_loss` rows the guard's own docstring
  // says must not exist: D2 was skipped and `census_collapse` raised, while D1 had
  // already written one `watermark_diff` row per watermarked path, reported them all
  // as `vanished`, and then DELETEd every `sweep_state` row so the next sweep had to
  // re-read the whole corpus. Those rows were also irrecoverable, since retraction
  // only ever covered `discovery_probe` (now fixed too, src/census.ts).
  //
  // `checkCensusCollapse` reads only `sweep_census` (this sweep's own row is written
  // at the very end) and `corpus.census`, so it is answerable here.
  const collapseGuard = checkCensusCollapse(db, corpus, censusCfg);
  const vanishAlarmMs = censusCfg.vanishAlarmDays * 24 * 3600 * 1000;
  const vanished: string[] = [];
  let vanishedLt60d = 0;
  const d1Losses: ClassifiedLoss[] = [];
  // A collapsed census means discovery is not a trustworthy witness to ABSENCE this
  // sweep, so D1 does not run at all: `vanished` stays empty, no `corpus_loss` row is
  // written, and — just as important — the `DELETE FROM sweep_state` at the end of
  // the sweep finds nothing to delete, which is what keeps recovery incremental.
  if (!collapseGuard.collapsed) {
    for (const [path, st] of prior) {
      if (onDisk.has(path)) continue;
      if (fingerprint(path) !== null) continue; // present but not discovered: not a loss
      vanished.push(path);
      const seenAgo = now.getTime() - Date.parse(st.lastSwept);
      if (!Number.isFinite(seenAgo) || seenAgo < vanishAlarmMs) vanishedLt60d += 1;
      const ageDays = ageDaysFrom(st.mtime ?? st.lastSwept, now);
      d1Losses.push({
        path,
        sessionId: sessionIdFromPath(path),
        kind: classifyPathKind(path),
        detectedBy: "watermark_diff",
        firstMissingAt: sweptAt,
        lastSeenAt: st.lastSwept,
        mtime: st.mtime,
        ageSource: st.mtime !== null ? "mtime" : "last_swept",
        expected: isExpected(ageDays, censusCfg),
      });
    }
  }

  const report: SweepReport = {
    root,
    swept_at: sweptAt,
    elapsed_ms: 0,
    budget_ms: budgetMs,
    budget_exceeded: false,
    full,
    sessions: { total: corpus.sessions.length, ingested: 0, skipped: 0, empty: 0 },
    corpus: {
      files: corpus.census.files,
      bytes: corpus.census.bytes,
      sessions: corpus.census.sessions,
      oldest_mtime: corpus.census.oldestMtime,
    },
    rows: {
      requests: 0,
      turns: 0,
      agent_runs: 0,
      workflow_runs: 0,
      workflow_phases: 0,
      task_events: 0,
      task_plants: 0,
      task_event_tids: 0,
    },
    parse: { lines: 0, blank: 0, parsed: 0, malformed: 0, truncatedTail: 0 },
    files_incomplete: 0,
    sidechain_replays: 0,
    anomalies: { recorded: 0, alerting: 0, by_kind: {} },
    // `sessions_lost`/`expected` are filled in once the D2 probe (below) runs —
    // placeholders here so `report` has its final shape from construction.
    vanished: {
      total: vanished.length,
      lt_60d: vanishedLt60d,
      paths: vanished,
      sessions_lost: [],
      expected: 0,
    },
    spool: {
      task_events_read: 0,
      task_events_inserted: 0,
      compliance_read: 0,
      compliance_unbound: 0,
      compliance_db_unavailable: 0,
      malformed: 0,
      markers_pruned: 0,
    },
    otel: {
      logs_read: 0,
      metrics_read: 0,
      requests_upserted: 0,
      metrics_inserted: 0,
      durations_filled: 0,
      durations_refreshed: 0,
      auxiliary_inserted: 0,
      auxiliary_superseded: 0,
      auxiliary_collisions: 0,
      unjoined: 0,
      counter_mismatches: 0,
      prompt_mismatches: 0,
      malformed: 0,
      rejects_read: 0,
      traces_dropped: 0,
      spool_pruned: 0,
    },
    attribution: { tasks: 0, turns: 0, agents: 0, runs: 0, requests: 0, by_attr: {} },
    burn_cache_rows: 0,
    outcomes_healed: 0,
    close_pass: {
      attempted: false,
      skipped: null,
      candidates: 0,
      completed: 0,
      abandoned: 0,
      deleted: 0,
      blocked: 0,
      failed: 0,
      awaiting_abandon: 0,
    },
    segments: { sessions: 0, segments: 0, open: 0 },
    promotion: { promoted: 0, started_at_set: 0, started_at_backdated: 0 },
    identity_repair: { candidates: 0, repaired: 0, ambiguous: 0, pending: 0 },
    jobs: {
      dirs_read: 0,
      parsed: 0,
      malformed: 0,
      bound: 0,
      already_bound: 0,
      unjoined: 0,
      n_items: 0,
      n_items_started: 0,
    },
    board: { attempted: false, ok: true },
  };

  // --- buffered ingest, flushed in bounded chunks ---------------------------
  let buffer = emptyBatch();
  let pendingFiles: FileFingerprint[] = [];
  const pendingAnomalies: IngestAnomaly[] = [
    ...toIngestAnomalies(corpus.anomalies),
    ...plan.anomalies,
  ];
  const writtenAnomalies: IngestAnomaly[] = [];
  /** The D3 fork index: one entry per transcript this sweep actually read. */
  const forkFiles: TranscriptIndexEntry[] = [];

  const flush = (): void => {
    const batch = buffer;
    const files = pendingFiles;
    // Ingest's OWN anomalies (torn tails, malformed lines, rid collisions,
    // unusable usage lines, unmapped phases) travel in the batch and must be
    // written too — dropping them would be the silent failure §2 forbids. They
    // join the discovery/sweep-level ones here so a single insertAnomalies()
    // call de-duplicates across both sources.
    const anomalies = [...pendingAnomalies, ...batch.anomalies];
    if (
      batch.requests.length === 0 &&
      batch.turns.length === 0 &&
      batch.agentRuns.length === 0 &&
      batch.workflowRuns.length === 0 &&
      batch.taskEvents.length === 0 &&
      // A `TaskUpdate` that plants a tid without changing status writes a plant and
      // no event, so the plants are their own reason to open a transaction.
      batch.taskPlants.length === 0 &&
      files.length === 0 &&
      anomalies.length === 0
    ) {
      return;
    }
    buffer = emptyBatch();
    pendingFiles = [];
    pendingAnomalies.length = 0;

    db.transaction(() => {
      // `writeBatch` writes rows only; anomalies go through insertAnomalies(), the
      // single writer, so the (kind, detail) de-duplication above applies to
      // ingest's anomalies too.
      // `writeBatch` returns the anomalies only the WRITER can see — a planted
      // est_tid whose task row does not exist is a fact about the database, not
      // about the file, so ingest cannot raise it and the writer must.
      const written = writeBatch(db, batch);
      writtenAnomalies.push(...insertAnomalies(db, [...anomalies, ...written.anomalies], sweptAt));
      const stmt = db.prepare(UPSERT_SWEEP_STATE_SQL);
      for (const f of files) {
        stmt.run({
          $path: f.path,
          $inode: f.inode,
          $bytes_read: f.bytes,
          $last_swept: sweptAt,
          // v9. NOT optional, and bun:sqlite will not tell you if you forget it: a
          // named parameter that is never bound is silently NULL rather than an
          // error, so omitting this left `sweep_state.mtime` NULL on every row
          // forever and D1's exact retention-age split (`ageSource: 'mtime'`) could
          // never engage — every `corpus_loss` row fell back to the `last_swept`
          // lower bound. `test/census.test.ts` pins `mtime IS NULL` at zero.
          $mtime: f.mtime,
        } as never);
      }
    }).immediate();

    report.rows.requests += batch.requests.length;
    report.rows.turns += batch.turns.length;
    report.rows.agent_runs += batch.agentRuns.length;
    report.rows.workflow_runs += batch.workflowRuns.length;
    report.rows.workflow_phases += batch.workflowPhases.length;
    report.rows.task_events += batch.taskEvents.length;
    report.rows.task_plants += batch.taskPlants.length;
    report.parse.lines += batch.stats.lines;
    report.parse.blank += batch.stats.blank;
    report.parse.parsed += batch.stats.parsed;
    report.parse.malformed += batch.stats.malformed;
    report.parse.truncatedTail += batch.stats.truncatedTail;
  };

  let sinceFlush = 0;
  for (const session of corpus.sessions) {
    if (overBudget()) {
      report.budget_exceeded = true;
      break;
    }

    const prints: FileFingerprint[] = [];
    for (const p of sessionFiles(session)) {
      const fp = fingerprint(p);
      if (fp !== null) prints.push(fp);
    }

    const unchanged =
      !full &&
      prints.length > 0 &&
      prints.every((f) => {
        const was = prior.get(f.path);
        return was !== undefined && was.inode === f.inode && was.bytes === f.bytes;
      });

    if (prints.length === 0) {
      report.sessions.empty += 1;
      continue;
    }
    if (unchanged) {
      report.sessions.skipped += 1;
      continue;
    }

    const ingested = await ingestSession(session, plan, now);
    mergeBatch(buffer, ingested);
    forkFiles.push(...ingested.files);
    // Two reasons a fingerprint must not become a watermark, and they are the same
    // reason: this session did not read those bytes. `incompleteFiles` is a read
    // that aborted; `skippedFiles` is a symlink-shared transcript another session
    // owns — and if THAT session is cut off by the budget, a watermark written here
    // would freeze the file out of every future incremental sweep.
    pendingFiles.push(
      ...watermarkable(prints, [...ingested.incompleteFiles, ...ingested.skippedFiles]),
    );
    report.files_incomplete += new Set(ingested.incompleteFiles).size;
    report.sessions.ingested += 1;
    sinceFlush += 1;
    if (sinceFlush >= chunkSessions) {
      flush();
      sinceFlush = 0;
    }
  }

  // §5.8 v9: D2 (src/census.ts) closes the gap D1 structurally cannot see — a
  // transcript deleted before it was EVER watermarked. Both write to
  // `corpus_loss` (durable, insert-once) inside one transaction, and the anomaly
  // raised depends on what is newly lost this sweep:
  //   `corpus_shrink`          — alerting; ANY new loss is younger than
  //                              `vanish_alarm_days`, or its age is unknown.
  //   `corpus_shrink_expected` — BENIGN (P2.10's delta-9 split, never landed
  //                              before v9); every new loss is at or past
  //                              `retention_days` — an expected reap, not damage.
  //   `census_collapse`        — the D2 sanity guard tripped (§5.8 risk #1): a
  //                              discovery outage must not be laundered into
  //                              hundreds of durable `corpus_loss` rows, so D2 is
  //                              skipped entirely and this fires instead.
  //
  // NOTE for whoever next touches `src/ingest.ts`'s `IngestAnomaly.kind` union:
  // "corpus_shrink_expected" and "census_collapse" belong in it alongside
  // "corpus_shrink" (this file owns adding sweep-level kinds there per its own
  // comment); they are cast here rather than added to that union because this
  // change does not touch src/ingest.ts.
  let lossProbe: CorpusLossProbeResult = {
    newLosses: [],
    insertedCount: 0,
    resolvedCount: 0,
    collapsed: false,
    collapseDetail: null,
  };
  db.transaction(() => {
    // `d1Losses` is empty when the guard tripped (see the D1 block above), so this
    // is unconditional in form and gated in fact — one verdict, both detectors.
    writeCorpusLoss(db, d1Losses);
    lossProbe = runCorpusLossProbe(db, corpus, sweptAt, now, {
      onDisk,
      guard: collapseGuard,
    });
  }).immediate();

  const newLosses: ClassifiedLoss[] = [...d1Losses, ...lossProbe.newLosses];
  const lt60dOf = (l: ClassifiedLoss): boolean => {
    const days = ageDaysFrom(l.mtime ?? l.lastSeenAt, now);
    return days === null || days < censusCfg.vanishAlarmDays;
  };
  // `total`/`lt_60d`/`paths` now cover D1 + D2 combined — the whole point of the
  // fix is that "vanished" stops meaning "vanished, but only the subset D1's
  // watermark diff could see". Every scenario the pre-fix JSON contract was
  // tested against had D2 finding nothing, so this is additive in practice.
  report.vanished.total = newLosses.length;
  report.vanished.lt_60d = newLosses.filter(lt60dOf).length;
  report.vanished.paths = newLosses.map((l) => l.path);
  report.vanished.sessions_lost = lossProbe.newLosses
    .map((l) => l.sessionId)
    .filter((s): s is string => s !== null);
  report.vanished.expected = newLosses.filter((l) => l.expected).length;

  if (lossProbe.collapsed) {
    pendingAnomalies.push({
      kind: "census_collapse",
      detail:
        lossProbe.collapseDetail ?? "discovery collapse guard tripped; D1 and D2 skipped this sweep",
    } as unknown as IngestAnomaly);
  }
  // A plain `if`, NOT an `else if`. Chained to the collapse branch, a sweep that
  // recorded real losses AND tripped the guard reported the collapse and stayed
  // silent about the losses it had nevertheless persisted. The guard now empties
  // both detectors, so the two branches are disjoint by construction — and saying so
  // with an unchained `if` means a future change to one cannot silence the other.
  if (newLosses.length > 0) {
    const alarming = newLosses.some((l) => !l.expected);
    const preview = newLosses.slice(0, 20).map((l) => l.path);
    const detail =
      `${newLosses.length} transcript(s)/session(s) newly recorded lost this sweep ` +
      `(D1 watermark diff: ${vanished.length}, ${vanishedLt60d} within ${censusCfg.vanishAlarmDays}d; ` +
      `D2 discovery probe: ${lossProbe.newLosses.length}; ${report.vanished.expected} at/beyond ` +
      `retention_days=${censusCfg.retentionDays}): ${preview.join(", ")}` +
      (newLosses.length > 20 ? ` … +${newLosses.length - 20} more` : "");
    pendingAnomalies.push({
      kind: alarming ? "corpus_shrink" : "corpus_shrink_expected",
      detail,
    } as unknown as IngestAnomaly);
  }
  if (report.budget_exceeded) {
    pendingAnomalies.push({
      kind: "sweep_budget_exceeded",
      detail: `sweep stopped after ${Date.now() - t0} ms (budget ${budgetMs} ms) with ${
        report.sessions.total -
        report.sessions.ingested -
        report.sessions.skipped -
        report.sessions.empty
      } session(s) unswept; partial commit is safe — the next sweep finishes the job`,
    });
  }

  flush();

  // §5.2 / G-FORK §7 rec 2 — the D3 fork detector. It runs over every transcript
  // THIS sweep read, so it belongs here rather than inside a session: the two
  // halves of a fork are by definition in different sessions, and on the real
  // corpus every single cross-file requestId crossed a session boundary. One hash
  // pass over uuids already gathered; no file is re-read.
  pendingAnomalies.push(...detectForkReplays(forkFiles));

  // §5.2 SECOND dedup pass — the ccusage message_id fallback. It runs HERE, after
  // every request row of this sweep is committed and before anything reads a sum,
  // because the two rows sharing a `message.id` routinely come from different
  // files and, on an incremental sweep, from different sweeps. Whole-table and
  // idempotent: the winner is recomputed from the same inputs every time.
  const replayGroups: ReplayGroup[] = [];
  db.transaction(() => {
    replayGroups.push(...markSidechainReplays(db));
  }).immediate();
  report.sidechain_replays = replayGroups.reduce((n, g) => n + g.n_losers, 0);
  pendingAnomalies.push(...replayAnomalies(replayGroups));

  // --- the Phase 1 tail of every sweep -------------------------------------
  // Three steps, in this order and nowhere else:
  //
  //  1. **Drain the hook spool** (P1.10, P1.11). The hooks cannot write to the
  //     database — a `BEGIN IMMEDIATE` on Craig's hot path queues behind exactly the
  //     sweeps a fan-out triggers — so they append a line and this is where those
  //     lines become rows. `cleanup()` runs AFTER the commit, so a crash mid-drain
  //     leaves the records on disk for the next sweep rather than losing them.
  //  2. **Attribute** (§5.4). Requests get their `tid` from EXPLICIT bindings, which
  //     is the corpus shape the live G-ATTR re-gate needs — attribution read off
  //     bindings rather than inferred from `TaskCreate`/`TaskUpdate` traces.
  //  3. **Refresh `burn_cache`** (P1.9). This is what buys `est burn --json` its
  //     sub-100 ms budget, and doing it here — including on the §6.3 micro-sweep — is
  //     what makes the statusline live rather than session-stale.
  let spool = emptyDrain();
  db.transaction(() => {
    spool = drainSpool(db, sweepSpoolDir);
  }).immediate();
  spool.cleanup();
  pendingAnomalies.push(...spool.anomalies);
  report.spool = {
    task_events_read: spool.task_events.read,
    task_events_inserted: spool.task_events.inserted,
    compliance_read: spool.compliance.read,
    compliance_unbound: spool.compliance.unbound,
    compliance_db_unavailable: spool.compliance.db_unavailable,
    malformed: spool.task_events.malformed + spool.compliance.malformed,
    markers_pruned: spool.markers_pruned,
  };

  // 1a2. **Link the lifecycle stream to its tasks.** Both `task_event` writers have
  //      now run (the batches above, and the spool drain), and the `session_task`
  //      aliases the plants minted are in place, so this is the first moment the join
  //      is complete. Corpus-wide and once per sweep rather than per batch: a plant
  //      seen in one chunk routinely links events written from another, and the
  //      statement only ever touches rows whose `tid` is still NULL.
  db.transaction(() => {
    report.rows.task_event_tids += backfillTaskEventTids(db);
  }).immediate();

  // 1b. **Drain the OTEL spool** (P2.3, P2.4), for the same reason and with the same
  //     crash-safety: the receiver is a long-lived unattended process that must never
  //     contend for the writer lock, so it appends lines and the sweeper — the single
  //     writer — turns them into rows. It runs BEFORE attribution because the auxiliary
  //     inserts it makes are `request` rows the attribution pass should see, and before
  //     `refreshBurnCache` because `compute_s` is computed from `request.duration_ms`,
  //     which is the one column this drain fills.
  let otel = emptyOtelIngest();
  // `otel_spool_retention_days` is read HERE, not in the drain: src/otel.ts is also the
  // receiver's decoder, and the receiver must never open the database (P1.10/P1.11).
  const otelRetentionDays = Number(
    getConfig(db, "otel_spool_retention_days") ?? DEFAULT_OTEL_SPOOL_RETENTION_DAYS,
  );
  db.transaction(() => {
    otel = drainOtel(db, sweepSpoolDir, { retentionDays: otelRetentionDays, now });
  }).immediate();
  otel.cleanup();
  pendingAnomalies.push(...otel.anomalies);
  report.otel = {
    logs_read: otel.logs_read,
    metrics_read: otel.metrics_read,
    requests_upserted: otel.otel_requests_upserted,
    metrics_inserted: otel.otel_metrics_inserted,
    durations_filled: otel.durations_filled,
    durations_refreshed: otel.durations_refreshed,
    auxiliary_inserted: otel.auxiliary_inserted,
    auxiliary_superseded: otel.auxiliary_superseded,
    auxiliary_collisions: otel.auxiliary_collisions,
    unjoined: otel.unjoined,
    counter_mismatches: otel.counter_mismatches,
    prompt_mismatches: otel.prompt_mismatches,
    malformed: otel.malformed,
    rejects_read: otel.rejects_read,
    traces_dropped: otel.traces_dropped,
    spool_pruned: otel.spool_pruned,
  };
  // The receiver cannot report its own death, and the sweeper is the component that
  // already owns loud failures. Silence is only a fault when telemetry is CONFIGURED:
  // with no `env` block the whole phase degrades to Phase 1 by design.
  const down = receiverDownAnomaly(
    db,
    telemetryConfigured(),
    Number(getConfig(db, "otel_stale_min") ?? 15),
    now,
  );
  if (down !== null) pendingAnomalies.push(down);

  const attribution = attributeTasks(db);
  report.attribution = {
    tasks: attribution.tasks,
    turns: attribution.turns_assigned,
    agents: attribution.agents_assigned,
    runs: attribution.runs_assigned,
    requests: attribution.requests_assigned,
    by_attr: attribution.by_attr,
  };

  // v10: give estimates whose EFFECTIVE estimator family is still the repairable
  // `'unknown'` sentinel a concrete one, by APPENDING to `estimate_identity_repair`.
  // Here rather than in a verb because the reason a row is 'unknown' is ingest lag —
  // `est open` runs before the sweep has seen the anchoring turn — so the moment the
  // repair becomes possible is precisely the moment ingest lands the turn, which is
  // now. Conservative by construction: it only ever touches the sentinel, refuses on
  // an ambiguous window, and writes nothing on a second run.
  //
  // Wrapped, for the reason `reconcileJobs` documents: `runSweep` is not itself inside
  // a transaction, so a bare call would autocommit once per repair row and once per
  // anomaly, and a crash between the two would leave a correction with no audit trail.
  let identityRepair: RepairReport = {
    candidates: 0,
    proposals: [],
    applied: 0,
    ambiguous: 0,
    pending: 0,
  };
  db.transaction(() => {
    identityRepair = repairEstimatorIdentity(db, { now, apply: true });
  }).immediate();
  report.identity_repair = {
    candidates: identityRepair.candidates,
    repaired: identityRepair.applied,
    ambiguous: identityRepair.ambiguous,
    pending: identityRepair.pending,
  };

  // P2.8: promote `estimating -> in_progress` on the task's FIRST attributed
  // request, and correct `started_at` monotone-earliest. Runs immediately after
  // attribution because it reads `request.tid`/`request.attr`, which that pass just
  // wrote — the sweeper's ONE other status edge, never `pending_verification`,
  // `completed`, `abandoned`, `deleted` or `reopened` (those are `est close`'s).
  const promotion = promoteStartedTasks(db);
  report.promotion = {
    promoted: promotion.promoted,
    started_at_set: promotion.started_at_set,
    started_at_backdated: promotion.started_at_backdated,
  };
  pendingAnomalies.push(...promotion.anomalies);

  // P2.9: reconcile `~/.claude/jobs` — RECONCILE-ONLY, never a source of truth for
  // a token, a status or a task (§7.1). Runs after attribution (so `task_alias` is
  // current) but has no ordering dependency on segments/burn_cache below; placed
  // here to keep every `request`/`task_alias`-reading pass adjacent.
  //
  // Wrapped the way every sibling pass is wrapped, and for the reason `reconcileJobs`
  // own doc comment states ("call INSIDE the sweep's transaction"): `runSweep` is not
  // itself inside one, so a bare call ran the whole loop in autocommit — one commit per
  // `task_alias` insert, per `job_run` upsert and per `job_item` upsert, and a crash
  // between the alias insert and the item loop left a tid bound to a half-written job.
  // The upserts are idempotent so the next sweep repaired it, but "repaired next time"
  // is not the atomicity the contract claims.
  let jobs = emptyJobsResult();
  db.transaction(() => {
    jobs = reconcileJobs(db, jobsRoot, sweptAt);
  }).immediate();
  report.jobs = {
    dirs_read: jobs.dirs_read,
    parsed: jobs.parsed,
    malformed: jobs.malformed,
    bound: jobs.bound,
    already_bound: jobs.already_bound,
    unjoined: jobs.unjoined,
    n_items: jobs.n_items,
    n_items_started: jobs.n_items_started,
  };
  pendingAnomalies.push(...jobs.anomalies);

  // 3a-bis. **Close the tasks that have gone quiet** (P1.7/§6.2, Craig 2026-07-30) —
  //     the working half of the gate's "leave it for the sweeper" refusal.
  //
  //     AFTER attribution and promotion, because the candidate filter reads
  //     `MAX(request.ts)` and the gate reads `task.status`, both of which those two
  //     passes have just written; BEFORE the heal below, so a task this pass closes is
  //     already a closed task when the heal asks whether any closed task's actual moved
  //     (it has not — the close was a moment ago); and before `refreshBurnCache` and the
  //     board, so the statusline and `board.html` publish the finalized state on the same
  //     sweep rather than one behind.
  //
  //     `attributed: true` is the whole reason this is affordable: without it every
  //     candidate re-runs the corpus-wide attribution pass that ran forty lines above.
  //     `force: full` runs the pass unthrottled on `est backfill` — a deliberate,
  //     human-initiated full rebuild should not be silenced by a marker a hook's
  //     micro-sweep stamped ninety seconds ago.
  //
  //     Not wrapped in a transaction here: `runClosePass` opens one PER CANDIDATE, so a
  //     task that fails the gate cannot roll back the closes that succeeded before it.
  //
  //     `markerPath` is the PER-DATABASE marker, in the per-database spool directory and
  //     named after `db.filename` (`closePassMarkerFile`). Neither half is optional: a
  //     throttle shared between two databases lets a sweep of a throwaway copy silence
  //     the live database's close pass for the whole window. `spoolDir` stays the HOOK
  //     spool, because that is where the overrun marker each closed task disarms lives.
  //
  //     `sweepIncomplete` SKIPS the pass outright when this sweep could not read its
  //     corpus — budget expiry or an aborted file read. The unread rows are exactly the
  //     ones that would have moved `MAX(request.ts)`, so a live task can look quiet and
  //     be closed on a partial corpus, and `healClosedOutcomes` cannot repair it later
  //     (it only re-checks spend POSTDATING `finalized_at`, and those rows predate it).
  const closePass = runClosePass(db, {
    now,
    markerPath: join(boardSpoolDir, closePassMarkerFile(db.filename)),
    spoolDir: sweepSpoolDir,
    attributed: true,
    sweepIncomplete: report.budget_exceeded || report.files_incomplete > 0,
    ...(full ? { force: true } : {}),
  });
  report.close_pass = {
    attempted: closePass.attempted,
    skipped: closePass.skipped,
    candidates: closePass.candidates,
    completed: closePass.completed,
    abandoned: closePass.abandoned,
    deleted: closePass.deleted,
    blocked: closePass.blocked,
    failed: closePass.failed,
    awaiting_abandon: closePass.awaiting_abandon,
  };

  // 3b. **Heal closed outcomes whose actual has since moved** (§6.2, Craig 2026-07-30).
  //     AFTER attribution, so the recomputed actual sees every request this sweep
  //     claimed, and before the cache/board so they publish the corrected number.
  //     It is the mechanism behind "a close is a revision, never an edit": the accepting
  //     turn's own spend lands after an `--accept` close by construction, and nothing
  //     used to append the correction. Appends nothing when nothing moved.
  db.transaction(() => {
    report.outcomes_healed = healClosedOutcomes(db, now, { spoolDir: sweepSpoolDir }).length;
  }).immediate();

  // 4. **Cut the run segments** (P2.1), and do it BEFORE `refreshBurnCache`: the
  //    check-back forecast the cache writes is issued against the OPEN segment this
  //    step produces, so the other order would always publish a forecast one sweep
  //    behind the activity it is about. `full` (backfill) rebuilds every session.
  db.transaction(() => {
    const cut = refreshSegments(db, { now, all: full });
    report.segments = { sessions: cut.sessions, segments: cut.segments, open: cut.open };
    // `segment_recut` findings, written INSIDE the same transaction that moved the rows
    // they are about. This call is not decoration and it was MISSING: `refreshSegments`
    // has always returned its findings and every earlier flush of `pendingAnomalies`
    // happens in the ingest loop far above, so the audit trail P2.1 promises — "the
    // corpus may not move SILENTLY" — was computed and then dropped on the floor. The
    // 2026-07-30 boundary rule made that visible by re-cutting the whole corpus at once,
    // which is exactly the event the ledger exists to record.
    writtenAnomalies.push(...insertAnomalies(db, cut.anomalies, sweptAt));
  }).immediate();

  db.transaction(() => {
    report.burn_cache_rows = refreshBurnCache(db, now);
  }).immediate();

  // §4.3 loud failure: a model family with no price row silently drops out of
  // v_priced (an INNER JOIN, deliberately) and would otherwise be invisible until
  // someone read a report and wondered why it was small. `sync()` only raises
  // unpriced_model for ids it could not RESOLVE, which misses the case where the
  // observed family and the priced family disagree on normalisation — so the
  // sweeper checks the actual join, which is the thing that matters.
  const unpricedFamilies = db
    .query<{ model_family: string; n: number }, []>(
      "SELECT model_family, COUNT(*) AS n FROM v_unpriced GROUP BY model_family ORDER BY n DESC",
    )
    .all();
  if (unpricedFamilies.length > 0) {
    pendingAnomalies.push(
      ...unpricedFamilies.map((f) => ({
        kind: "unpriced_model" as const,
        detail: `no model_price row for family "${f.model_family}" (${f.n} request(s) excluded from every sum); run \`est prices --sync\``,
      })),
    );
  }
  const preEpoch = db.query<{ n: number }, []>(PRE_EPOCH_SQL).get()?.n ?? 0;
  if (preEpoch > 0) {
    pendingAnomalies.push({
      kind: "unpriced_model",
      detail: `${preEpoch} request(s) predate the earliest effective_from of their own model family — dropped by v_priced's \`effective_from <= ts\` join and NOT counted by v_unpriced`,
    });
  }
  if (pendingAnomalies.length > 0) flush();

  db.transaction(() => {
    // Gated by the same verdict as everything else D1 does: `vanished` is empty when
    // the collapse guard tripped, so an outage cannot drop the watermarks — which are
    // precisely what lets the sweep AFTER the outage stay incremental instead of
    // re-reading the whole corpus.
    if (vanished.length > 0) {
      const del = db.prepare("DELETE FROM sweep_state WHERE path = ?");
      for (const p of vanished) del.run(p);
    }
    db.query(UPSERT_CENSUS_SQL).run({
      $swept_at: sweptAt,
      $n_files: corpus.census.files,
      $n_bytes: corpus.census.bytes,
      $n_sessions: corpus.census.sessions,
      // NOT NULL. An empty corpus has no oldest file; the sweep time is the
      // truthful degenerate answer ("nothing older than now") and keeps MIN()
      // over the census history meaningful.
      $oldest_mtime: corpus.census.oldestMtime ?? sweptAt,
      // Combined D1 + D2, per the same reasoning as `report.vanished` above.
      $vanished_total: report.vanished.total,
      $vanished_lt_60d: report.vanished.lt_60d,
    } as never);
  }).immediate();

  // P2.7: regenerate `board.html`/`board.md` at the end of a sweep "whose transaction
  // changed a `task`, `estimate`, `outcome` or `burn_cache` row", throttled by
  // `board_min_interval_s`.
  //
  // Those four tables have exactly two writers inside a sweep, and this reads both:
  // status promotion (P2.8) is the sweeper's ONLY `task` edge, and `refreshBurnCache`
  // (P1.9) reports the number of `burn_cache` rows it wrote. `estimate` and `outcome`
  // are append-only and belong to `est open` / `est close`, which no sweep runs — a
  // sweep cannot change them, so there is nothing here to read for them. When both
  // report zero, the board would render byte-for-byte what is already on disk, and the
  // render is skipped rather than paid for: `board()` is an unbounded read across half
  // the view stack plus two fsync'd writes, and an idle machine on a cron sweep would
  // otherwise pay it forever.
  //
  // Deliberately OUTSIDE `pendingAnomalies`/`writtenAnomalies`: a render failure
  // must never fail the sweep — not even under `--strict`, which promotes every
  // OTHER recorded anomaly — because the board is a convenience and the sweep is
  // the system. It is still written to the ledger directly, so it stays queryable.
  const boardDirty =
    promotion.promoted > 0 ||
    promotion.started_at_set > 0 ||
    promotion.started_at_backdated > 0 ||
    report.burn_cache_rows > 0;
  const boardResult = regenerateBoardIfDue(db, {
    boardDir,
    spoolDir: boardSpoolDir,
    now,
    dirty: boardDirty,
  });
  report.board = { attempted: boardResult.attempted, ok: boardResult.ok };
  if (boardResult.anomaly !== null) insertAnomalies(db, [boardResult.anomaly], sweptAt);

  for (const a of writtenAnomalies) {
    report.anomalies.by_kind[a.kind] = (report.anomalies.by_kind[a.kind] ?? 0) + 1;
  }
  report.anomalies.recorded = writtenAnomalies.length;
  report.anomalies.alerting = writtenAnomalies.filter((a) => !BENIGN_ANOMALY_KINDS.has(a.kind)).length;
  report.elapsed_ms = Date.now() - t0;
  return report;
}

// ---------------------------------------------------------------------------
// spend read models — `est backfill`'s summary tables
// ---------------------------------------------------------------------------

export interface SpendRow {
  key: string;
  n_req: number;
  in_tok: number;
  out_tok: number;
  cw_tok: number;
  cr_tok: number;
  /** Work-CET: price-weighted (output + cache_creation) / ref_model output price. */
  wcet: number;
  /** Spend-CET: all four counters, same normaliser. */
  scet: number;
  usd: number;
}

const SPEND_SELECT = `
SELECT %KEY% AS key,
  COUNT(*) AS n_req,
  COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(out_tok),0) AS out_tok,
  COALESCE(SUM(cw_tok),0) AS cw_tok, COALESCE(SUM(cr_tok),0) AS cr_tok,
  COALESCE(SUM(wcet),0) AS wcet, COALESCE(SUM(scet),0) AS scet,
  COALESCE(SUM((in_tok*usd_in + out_tok*usd_out + cw_cost + cr_tok*usd_cr) / 1000000.0),0) AS usd
FROM v_wcet GROUP BY %KEY% ORDER BY wcet DESC, n_req DESC
`;

function spendBy(db: Database, key: "model_family" | "origin"): SpendRow[] {
  return db.query<SpendRow, []>(SPEND_SELECT.replaceAll("%KEY%", key)).all();
}

/** Per-model Work-CET / Spend-CET / USD over every priced, non-replay request. */
export function spendByModel(db: Database): SpendRow[] {
  return spendBy(db, "model_family");
}

/** Per-origin (orchestrator / sub-agent / auxiliary) — the §4.6 split. */
export function spendByOrigin(db: Database): SpendRow[] {
  return spendBy(db, "origin");
}

export interface UnpricedSummary {
  n_req: number;
  families: string[];
  /**
   * Requests whose family IS priced but whose `ts` predates that family's earliest
   * `effective_from`. `v_priced` drops them (the join is `effective_from <= ts`)
   * and `v_unpriced` does not catch them (the family exists), so without this
   * count they would be invisible in both directions — the exact silent-zero the
   * design forbids (§2, §4.3).
   */
  n_pre_epoch: number;
  /** Priced rows whose Work-CET is NULL: the ref_model itself has no price row. */
  n_no_ref: number;
  ref_model: string | null;
}

const PRE_EPOCH_SQL = `
SELECT COUNT(*) AS n FROM v_request_live r
WHERE r.model_family IN (SELECT family FROM model_price)
  AND NOT EXISTS (SELECT 1 FROM model_price p
                  WHERE p.family = r.model_family AND p.effective_from <= r.ts)
`;

/** §4.3: unpriced rows degrade a ROW's usability, never the pipeline. Counted here. */
export function unpricedSummary(db: Database): UnpricedSummary {
  const n =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_unpriced").get()?.n ?? 0;
  const families = db
    .query<{ model_family: string }, []>(
      "SELECT DISTINCT model_family FROM v_unpriced ORDER BY model_family",
    )
    .all()
    .map((r) => r.model_family);
  const preEpoch = db.query<{ n: number }, []>(PRE_EPOCH_SQL).get()?.n ?? 0;
  const noRef =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM v_wcet WHERE wcet IS NULL").get()?.n ?? 0;
  return {
    n_req: n,
    families,
    n_pre_epoch: preEpoch,
    n_no_ref: noRef,
    ref_model: getConfig(db, "ref_model"),
  };
}

/**
 * The three tables `est backfill` prints after the sweep. Gathered inside the writer
 * lock (with the connection that ran the sweep) and rendered outside it, so no read
 * outlives the handle and no handle outlives the critical section.
 */
export interface SpendTables {
  models: SpendRow[];
  origins: SpendRow[];
  unpriced: UnpricedSummary;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const NUM = new Intl.NumberFormat("en-US");

function num(n: number): string {
  return NUM.format(Math.round(n));
}
function usd(n: number): string {
  return n >= 100 ? `$${NUM.format(Math.round(n))}` : `$${n.toFixed(2)}`;
}
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Fixed-width table. Column 0 left-aligned (labels), the rest right (numbers). */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length), 0),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function spendTable(title: string, rows: readonly SpendRow[]): string {
  if (rows.length === 0) return `${title}\n  (no priced requests — see the unpriced note below)`;
  const body = rows.map((r) => [
    r.key,
    num(r.n_req),
    num(r.wcet),
    num(r.scet),
    usd(r.usd),
    num(r.in_tok),
    num(r.out_tok),
    num(r.cw_tok),
    num(r.cr_tok),
  ]);
  const total = rows.reduce(
    (a, r) => ({
      n_req: a.n_req + r.n_req,
      wcet: a.wcet + r.wcet,
      scet: a.scet + r.scet,
      usd: a.usd + r.usd,
      in_tok: a.in_tok + r.in_tok,
      out_tok: a.out_tok + r.out_tok,
      cw_tok: a.cw_tok + r.cw_tok,
      cr_tok: a.cr_tok + r.cr_tok,
    }),
    { n_req: 0, wcet: 0, scet: 0, usd: 0, in_tok: 0, out_tok: 0, cw_tok: 0, cr_tok: 0 },
  );
  body.push([
    "TOTAL",
    num(total.n_req),
    num(total.wcet),
    num(total.scet),
    usd(total.usd),
    num(total.in_tok),
    num(total.out_tok),
    num(total.cw_tok),
    num(total.cr_tok),
  ]);
  const table = renderTable(
    ["", "requests", "Work-CET", "Spend-CET", "USD", "input", "output", "cache_w", "cache_r"],
    body,
  );
  return `${title}\n${table.replace(/^/gm, "  ")}`;
}

function sweepSummary(r: SweepReport): string {
  const lines = [
    `swept ${r.sessions.ingested}/${r.sessions.total} session(s) in ${r.elapsed_ms} ms` +
      (r.sessions.skipped > 0 ? ` (${r.sessions.skipped} unchanged)` : "") +
      (r.sessions.empty > 0 ? ` (${r.sessions.empty} with no readable artefact)` : "") +
      (r.full ? " [full re-read]" : ""),
    `corpus  ${num(r.corpus.files)} files, ${bytes(r.corpus.bytes)}, ${num(r.corpus.sessions)} sessions` +
      (r.corpus.oldest_mtime === null ? "" : `, oldest ${r.corpus.oldest_mtime.slice(0, 10)}`),
    `rows    ${num(r.rows.requests)} request, ${num(r.rows.turns)} turn, ${num(r.rows.agent_runs)} agent_run, ` +
      `${num(r.rows.workflow_runs)} workflow_run, ${num(r.rows.workflow_phases)} workflow_phase, ` +
      `${num(r.rows.task_events)} task_event (${num(r.rows.task_plants)} planted est_tid, ` +
      `${num(r.rows.task_event_tids)} linked)`,
    `parsed  ${num(r.parse.parsed)}/${num(r.parse.lines)} lines` +
      (r.parse.malformed > 0 ? `, ${r.parse.malformed} malformed` : "") +
      (r.parse.truncatedTail > 0 ? `, ${r.parse.truncatedTail} truncated tail(s)` : ""),
  ];
  if (r.sidechain_replays > 0) {
    lines.push(
      `replay  ${num(r.sidechain_replays)} request(s) demoted to attr='replay' (§5.2 message_id pass) — kept for audit, excluded from every sum`,
    );
  }
  if (r.spool.task_events_read > 0 || r.spool.compliance_read > 0 || r.spool.malformed > 0) {
    lines.push(
      `spool   ${num(r.spool.task_events_read)} hook task_event(s) read (${num(r.spool.task_events_inserted)} new), ` +
        `${num(r.spool.compliance_read)} compliance record(s) (${num(r.spool.compliance_unbound)} with no bound task)` +
        (r.spool.compliance_db_unavailable > 0
          ? `, ${num(r.spool.compliance_db_unavailable)} with no readable db`
          : "") +
        (r.spool.malformed > 0 ? `, ${r.spool.malformed} malformed` : ""),
    );
  }
  if (r.attribution.tasks > 0) {
    const split = Object.entries(r.attribution.by_attr)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${num(n)}`)
      .join(" ");
    lines.push(
      `attrib  ${num(r.attribution.tasks)} task(s): ${num(r.attribution.turns)} turn, ${num(r.attribution.agents)} agent, ` +
        `${num(r.attribution.runs)} run, ${num(r.attribution.requests)} request row(s) changed${split === "" ? "" : ` (${split})`}`,
    );
    lines.push(
      `burn    ${num(r.burn_cache_rows)} materialised burn_cache row(s) refreshed` +
        (r.outcomes_healed > 0
          ? `  ·  ${num(r.outcomes_healed)} closed outcome(s) corrected: spend landed after finalization, so a revision was appended`
          : ""),
    );
    lines.push(
      `segs    ${num(r.segments.segments)} run segment(s) over ${num(r.segments.sessions)} session(s), ` +
        `${num(r.segments.open)} still open — the check-back corpus (\`est segments\`)`,
    );
  }
  if (r.jobs.dirs_read > 0) {
    lines.push(
      `jobs    ${num(r.jobs.parsed)}/${num(r.jobs.dirs_read)} job dir(s) read: ${num(r.jobs.bound)} newly bound, ` +
        `${num(r.jobs.already_bound)} already bound, ${num(r.jobs.unjoined)} unjoined ` +
        `(${num(r.jobs.n_items_started)}/${num(r.jobs.n_items)} fan items started) — reconcile-only, never a source of truth`,
    );
  }
  // Printed when the pass CLOSED something, could not, or was skipped because the sweep
  // itself was incomplete. A due pass that found no candidates is the steady state and a
  // THROTTLED one did not even query; neither is news. A pass skipped for an incomplete
  // read IS news — it is the sweep declining to close on a corpus it could not finish.
  const cp = r.close_pass;
  if (cp.skipped === "incomplete_sweep") {
    lines.push(
      "close   SKIPPED — this sweep did not read its corpus completely, and a truncated read makes a live " +
        "task look quiet; no task is finalized on partial evidence. The next complete sweep runs it.",
    );
  } else if (cp.completed > 0 || cp.abandoned > 0 || cp.deleted > 0 || cp.failed > 0) {
    lines.push(
      `close   ${num(cp.completed)} completed, ${num(cp.deleted)} deleted, ${num(cp.abandoned)} abandoned ` +
        `of ${num(cp.candidates)} candidate(s) — the §6.2 gate was met in full for each` +
        (cp.blocked > 0 ? `; ${num(cp.blocked)} still live, retried next pass` : "") +
        (cp.awaiting_abandon > 0
          ? `; ${num(cp.awaiting_abandon)} silent but inside the abandon safety margin`
          : "") +
        (cp.failed > 0 ? `; ${num(cp.failed)} could not be finalized` : ""),
    );
  }
  if (r.promotion.promoted > 0 || r.promotion.started_at_set > 0 || r.promotion.started_at_backdated > 0) {
    lines.push(
      `promote ${num(r.promotion.promoted)} task(s) estimating->in_progress, ` +
        `${num(r.promotion.started_at_set)} started_at set, ${num(r.promotion.started_at_backdated)} backdated`,
    );
  }
  if (r.board.attempted) {
    lines.push(`board   ${r.board.ok ? "regenerated" : "render FAILED (see anomaly; previous file left intact)"}`);
  }
  if (r.files_incomplete > 0) {
    lines.push(
      `PARTIAL ${r.files_incomplete} file(s) could not be read to EOF; their watermarks were NOT advanced, so the next sweep re-reads them`,
    );
  }
  if (r.anomalies.recorded > 0) {
    const kinds = Object.entries(r.anomalies.by_kind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(" ");
    lines.push(`anomaly ${r.anomalies.recorded} new (${kinds})`);
  }
  if (r.vanished.total > 0) {
    lines.push(
      `SHRINK  ${r.vanished.total} transcript(s)/session(s) newly lost (D1+D2), ${r.vanished.lt_60d} in the alarming window, ${r.vanished.expected} at/beyond retention — §5.8 expects ZERO`,
    );
  }
  if (r.budget_exceeded) {
    lines.push(`BUDGET  exceeded ${r.budget_ms} ms; committed what was read — the next sweep finishes the job`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export interface Ctx {
  parsed: Parsed;
  dbPath: string;
  /** Writer lock. One per database — a second corpus needs a second lock. */
  lockPath: string;
  quiet: boolean;
  json: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
}

function lockNote(verb: string): string {
  return `est ${verb} (pid ${process.pid})`;
}

/**
 * Runtime scratch directories `est` writes into. Both live under {@link DATA_ROOT},
 * the sibling data tree, not under the public checkout (`ROOT`) — so a fresh clone
 * lacks them and they are created here. `gates/` is deliberately absent: it is
 * committed source under `ROOT`, and conjuring an empty one would paper over a
 * broken checkout instead of failing loudly (§2).
 */
function ensureDirs(): void {
  // `spool/` in particular is not optional: the PostToolUse and PreToolUse hooks
  // append to it on Craig's hot path and must never have to create it themselves
  // (P1.10's "missing spool directory -> print nothing, exit 0" fail-open would
  // silently discard every delete capture).
  ensureSpool();
  // Under DATA_ROOT, not ROOT: backups are runtime output (copies of estimator.db),
  // and the public checkout must never gain a path a careless `.gitignore` edit
  // could leave uncovered (§4, §10 Q11) — see the DATA_ROOT doc comment in db.ts.
  mkdirSync(join(DATA_ROOT, "backups"), { recursive: true });
}

async function cmdInit(ctx: Ctx): Promise<number> {
  ensureDirs();
  // openDb() applies schema.sql when the file is uninitialised — a write, so it
  // belongs under the writer lock like every other write path (§2), and the lock
  // has to be taken BEFORE the connection is opened for that to mean anything.
  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const version = getConfig(db, "schema_version");
        const counts = db
          .query<{ requests: number; anomalies: number }, []>(
            "SELECT (SELECT COUNT(*) FROM request) AS requests, (SELECT COUNT(*) FROM anomaly) AS anomalies",
          )
          .get()!;
        if (ctx.json) {
          ctx.out(JSON.stringify({ db: ctx.dbPath, schema_version: version, ...counts }, null, 2));
        } else if (!ctx.quiet) {
          ctx.out(`estimator ready: ${ctx.dbPath} (schema_version ${version}, ${num(counts.requests)} requests)`);
        }
        return 0;
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("init") },
  );
}

async function cmdSweep(ctx: Ctx, full: boolean): Promise<number> {
  const p = ctx.parsed;
  const budgetText = flagString(p, "budget");
  let budgetMs: number | null = null;
  if (budgetText !== null) {
    budgetMs = parseDuration(budgetText);
    if (budgetMs === null) {
      ctx.err(`est: --budget: cannot parse duration "${budgetText}" (try 20s, 500ms, 2m)`);
      return 1;
    }
  }
  const root = flagString(p, "root") ?? PROJECTS_ROOT;
  const strict = flagBool(p, "strict");
  const blocking = flagBool(p, "blocking");
  const chunk = flagInt(p, "chunk", 25);

  // --blocking waits for the lock instead of stepping aside — the SessionEnd
  // hook must not silently skip. Waiting is capped at HALF the budget so a
  // contended lock cannot eat the whole 20 s and leave nothing for the sweep;
  // whatever the wait costs is then subtracted from the sweep's own budget.
  const timeoutMs = blocking ? (budgetMs === null ? 30_000 : Math.min(budgetMs / 2, 10_000)) : 0;
  const tStart = Date.now();
  const top = flagInt(p, "top", 40);

  // The connection is opened INSIDE the lock (see `cmdOpen` for the whole reason):
  // `openDb()` migrates a stale `schema_version` on sight, so a handle opened here
  // would rewrite the schema even on the path that goes on to print "the lock is held
  // by another writer; skipping". `--backfill`'s spend tables are gathered inside the
  // critical section too — they read the rows this sweep just wrote, and the handle
  // must not outlive the lock — but they are pure reads on a database this process
  // already has open, so they cost the lock nothing the sweep did not already cost it.
  let result: { report: SweepReport; spend: SpendTables | null };
  try {
    result = await withLock(
      async (): Promise<{ report: SweepReport; spend: SpendTables | null }> => {
        const db = openDb({ path: ctx.dbPath });
        try {
          const report = await runSweep(db, {
            root,
            budgetMs: budgetMs === null ? null : Math.max(budgetMs - (Date.now() - tStart), 1),
            full,
            chunkSessions: chunk,
          });
          const spend: SpendTables | null = full
            ? {
                models: spendByModel(db).slice(0, top),
                origins: spendByOrigin(db),
                unpriced: unpricedSummary(db),
              }
            : null;
          return { report, spend };
        } finally {
          db.close();
        }
      },
      { path: ctx.lockPath, timeoutMs, note: lockNote(full ? "backfill" : "sweep") },
    );
  } catch (e) {
    if (e instanceof LockBusyError) {
      // Not an error for a detached micro-sweep: another writer is already
      // doing this work, and every write path is idempotent.
      if (!ctx.quiet) ctx.err(`est: ${e.message}; skipping (this sweep is a no-op)`);
      return 4;
    }
    throw e;
  }

  // Rendered outside the lock, from values already in memory: printing is not a write,
  // and holding the writer lock across it would block every other writer on a terminal.
  const { report, spend } = result;
  if (ctx.json) ctx.out(JSON.stringify(report, null, 2));
  else if (!ctx.quiet) ctx.out(sweepSummary(report));

  if (spend !== null) {
    const { models, origins, unpriced } = spend;
    if (ctx.json) {
      ctx.out(JSON.stringify({ by_model: models, by_origin: origins, unpriced }, null, 2));
    } else if (!ctx.quiet) {
      ctx.out("");
      ctx.out(spendTable(`Work-CET / Spend-CET by model (ref_model = ${unpriced.ref_model ?? "unset"})`, models));
      ctx.out("");
      ctx.out(spendTable("Work-CET / Spend-CET by origin (§4.6)", origins));
      ctx.out("");
      if (unpriced.n_req > 0) {
        ctx.out(
          `unpriced: ${num(unpriced.n_req)} request(s) across ${unpriced.families.length} family(ies) ` +
            `are excluded from the tables above — ${unpriced.families.join(", ")}\n` +
            `          run \`est prices --sync\` and re-run \`est backfill\` (no re-parse: the DB already has the rows)`,
        );
        // A bracketed family reaching this list means `--sync` has not run since
        // the row was ingested (or the base family itself is unpriced) — NOT the
        // old structural dead end, where ingest kept the suffix and the price
        // table dropped it so no sync could ever produce a joinable row.
        const bracketed = unpriced.families.filter((f) => /\[[^\]]*\]$/.test(f));
        if (bracketed.length > 0) {
          ctx.out(
            `          NOTE: ${bracketed.join(", ")} carr${bracketed.length === 1 ? "ies" : "y"} a "[...]" context suffix. ` +
              `\`est prices --sync\` resolves these against the base family's rate (its >200k tier when the ` +
              `suffix names a window past 200k), so a sync should clear them; if it does not, the BASE family ` +
              `has no price row either.`,
          );
        }
      } else {
        ctx.out("unpriced: 0 requests — every observed model family has a price row.");
      }
      if (unpriced.n_pre_epoch > 0) {
        ctx.out(
          `pre-epoch: ${num(unpriced.n_pre_epoch)} request(s) are older than the earliest price row for their ` +
            `own family, so they fall out of BOTH tables above and out of the unpriced count. ` +
            `Backdate a price row (\`est prices --set\`) if that spend needs to be included.`,
        );
      }
      if (unpriced.n_no_ref > 0) {
        ctx.out(
          `WARNING:  ${num(unpriced.n_no_ref)} priced request(s) yield a NULL Work-CET because ref_model ` +
            `"${unpriced.ref_model ?? "unset"}" has no model_price row. Fix with \`est prices --sync\` ` +
            `or point config.ref_model at a family that does.`,
        );
      }
    }
  }

  if (report.budget_exceeded) return 3;
  if (report.anomalies.alerting > 0) return 3;
  if (strict && report.anomalies.recorded > 0) return 3;
  return 0;
}

async function cmdPrices(ctx: Ctx): Promise<number> {
  const p = ctx.parsed;
  const wantSync = flagBool(p, "sync");
  const wantShow = flagBool(p, "show");
  const setModel = flagString(p, "set");
  // CACHE-TTL-PRICING.md D6: the one-shot historical fill.
  const wantFillCw1h = flagBool(p, "fill-cw-1h");

  if (!wantSync && !wantShow && setModel === null && !wantFillCw1h) {
    ctx.err(
      "est prices: nothing to do — pass --sync, --show, --fill-cw-1h or --set <model> --in .. --out .. --cw .. --cr ..",
    );
    return 1;
  }

  // `--at` names a VINTAGE, and both verbs that have one take it: --show reports
  // the rates in force then, --set makes a rate take effect then. It is parsed
  // ONCE, here, and rejected if unparseable, because every `effective_from <= ?`
  // in this codebase is a LEXICAL string comparison against an ISO instant —
  // a value SQLite cannot compare correctly is a wrong answer, not an error, and
  // silently reaching the wrong price row is the failure mode this whole file is
  // built to prevent. Normalised to the second, the format the DB is written in.
  const atRaw = flagString(p, "at");
  let at: Date | null = null;
  if (atRaw !== null && atRaw.trim() !== "") {
    const t = Date.parse(atRaw.trim());
    if (!Number.isFinite(t)) {
      ctx.err(
        `est prices --at: expected an ISO instant (2026-07-01 or 2026-07-01T12:00:00Z), got "${atRaw}"`,
      );
      return 1;
    }
    at = new Date(t);
  }

  // Writes take the lock, and the connection is opened INSIDE it (see `cmdOpen` for
  // the whole reason): `openDb()` migrates a stale `schema_version` on sight, so a
  // handle opened before the lock is itself a schema write outside the lock. ONE lock
  // spans the whole command rather than one per write — `--set --sync` in a single
  // invocation used to take it twice, and a nested `withLock` on the same path could
  // not be re-entered anyway.

  // `--source` is validated HERE, beside `--at`, and for one reason `--at` did not have:
  // `--set` and `--sync` can arrive in a SINGLE invocation, and this check used to sit
  // inside the `--sync` branch — after `setManualPrice` had already committed the
  // `--set` row. So `est prices --set <f> --in … --sync --source bogus` wrote a price
  // row and then exited 1: a usage refusal, which reads as "nothing happened, fix the
  // command line and retry", over a database that had already changed. Same shape as
  // the `--continue` bind in `cmdOpen`, and far less costly only because a price row is
  // keyed by (family, effective_from) and a retry overwrites it. Every rejection this
  // command can make is now made before it writes anything.
  const sourceFlag = flagString(p, "source");
  const source: "auto" | "live" | "fixture" =
    sourceFlag === "live" || sourceFlag === "fixture" || sourceFlag === "auto" ? sourceFlag : "auto";
  if (wantSync && sourceFlag !== null && source !== sourceFlag) {
    ctx.err(`est prices --source: expected auto|live|fixture, got "${sourceFlag}"`);
    return 1;
  }

  const writes = setModel !== null || wantSync || wantFillCw1h;
  const body = async (db: Database): Promise<number> => {
    let result: SyncResult | null = null;

    if (setModel !== null) {
      // Read through a null check, not `Number(flagString(...))`: Number(null)
      // is 0, so a missing --cr would silently become a free cache-read rate.
      const rate = (name: string): number | null => {
        const raw = flagString(p, name);
        if (raw === null || raw.trim() === "") return null;
        const v = Number(raw);
        return Number.isFinite(v) && v >= 0 ? v : null;
      };
      const usd_in = rate("in");
      const usd_out = rate("out");
      const usd_cw = rate("cw");
      const usd_cr = rate("cr");
      if (usd_in === null || usd_out === null || usd_cw === null || usd_cr === null) {
        ctx.err(
          "est prices --set: all four rates are required and must be non-negative numbers: --in --out --cw --cr (USD per Mtok)",
        );
        return 1;
      }
      // CACHE-TTL-PRICING.md D5: `--cw-1h` is REQUIRED when the family's most
      // recent existing vintage already carries a recorded (non-'unrecorded')
      // 1h rate — a bare `--set` that omitted it used to silently revert every
      // future 1h cache write on that family to the 5m fallback, with NO signal
      // anywhere (`cw_ttl_unrecorded` watches request-side capture,
      // `v_cw_ttl_exposure` watches request-side unknowns; neither watches
      // price-side coverage — that is what `v_cw_1h_price_gap` is for).
      // `--cw-1h-unrecorded` is the explicit escape hatch for "I really do mean
      // unknown". A family with no prior recorded rate stays optional.
      const cw1hFlag = rate("cw-1h");
      const cw1hUnrecorded = flagBool(p, "cw-1h-unrecorded");
      const priorFamily = priceFamily(setModel);
      const prior = currentPrice(db, priorFamily);
      const priorRecorded = prior !== null && prior.usd_cw1h !== null;
      if (priorRecorded && cw1hFlag === null && !cw1hUnrecorded) {
        ctx.err(
          `est prices --set ${setModel}: this family's most recent vintage carries a recorded ` +
            `1h cache-write rate (src=${prior!.usd_cw1h_src}, usd_cw1h=${prior!.usd_cw1h}) — ` +
            `pass --cw-1h <rate> to carry it forward, or --cw-1h-unrecorded to deliberately drop it`,
        );
        return 1;
      }
      const usd_cw1h = cw1hUnrecorded ? null : cw1hFlag;
      const rates = { usd_in, usd_out, usd_cw, usd_cr, usd_cw1h };
      const set = setManualPrice(db, setModel, rates, { at: at ?? undefined });
      if (ctx.json) {
        ctx.out(JSON.stringify(set, null, 2));
      } else if (!ctx.quiet) {
        // The vintage is printed, always. `--set` exists mostly to answer the
        // "pre-epoch" line `est backfill` prints, and the only thing that makes
        // it work is WHICH instant the row takes effect from — reporting just
        // the family left the user to guess whether the old spend got priced.
        ctx.out(
          `set manual price for family ${set.family}, effective ${set.effective_from}` +
            (set.backdated
              ? ` (backdated — it prices every request from that instant on; re-run \`est backfill\` to see them)`
              : ""),
        );
      }
    }

    if (wantSync) {
      result = await sync(db, { source });
      if (ctx.json) {
        ctx.out(JSON.stringify(result, null, 2));
      } else if (!ctx.quiet) {
        ctx.out(
          `price sync ${result.ok ? "ok" : "FAILED"}: epoch ${result.price_epoch}, source ${result.source}, ` +
            `${result.n_families} families (${result.n_provisional} provisional), ${result.n_rows_written} row(s) written`,
        );
        for (const a of result.attempts) {
          ctx.out(`  ${a.ok ? "ok  " : "fail"} ${a.leg} n=${a.n}${a.error === undefined ? "" : ` (${a.error})`}`);
        }
        if (result.unmatched.length > 0) {
          ctx.out(`  UNMATCHED (anomaly(unpriced_model) written): ${result.unmatched.join(", ")}`);
        }
      }
    }

    if (wantFillCw1h) {
      const fillResult: FillCw1hResult = await fillCw1h(db, { source });
      if (ctx.json) {
        ctx.out(JSON.stringify(fillResult, null, 2));
      } else if (!ctx.quiet) {
        ctx.out(
          `est prices --fill-cw-1h: epoch ${fillResult.price_epoch}, ` +
            `${fillResult.n_filled} vintage row(s) filled (${fillResult.n_implausible} implausible, ` +
            `fell back to derived_from_input)`,
        );
      }
    }

    if (wantShow) {
      // The same parsed instant --set uses, normalised to the second so it
      // compares against `effective_from` the way SQLite actually compares it.
      const rows = showPrices(db, at === null ? undefined : isoSeconds(at));
      if (ctx.json) {
        ctx.out(JSON.stringify(rows, null, 2));
      } else {
        ctx.out(
          renderTable(
            ["family", "from", "in", "out", "cache_w", "cw_1h", "cache_r", "src", "prov"],
            rows.map((r) => [
              r.family,
              r.effective_from.slice(0, 10),
              String(r.usd_in),
              String(r.usd_out),
              String(r.usd_cw),
              // CACHE-TTL-PRICING.md D5: 'unrecorded' is the honest label for a
              // vintage nobody has priced the 1h premium for yet.
              r.usd_cw1h === null ? "unrecorded" : String(r.usd_cw1h),
              String(r.usd_cr),
              r.source,
              r.provisional ? "yes" : "",
            ]),
          ),
        );
      }
    }

    if (result !== null && !result.ok) return 3;
    return 0;
  };

  if (!writes) {
    // `--show` on its own never writes, so it must never migrate either: a read-only
    // connection is incapable of both, and it stays callable beside a live sweep.
    const db = openDb({ path: ctx.dbPath, readonly: true });
    try {
      return await body(db);
    } finally {
      db.close();
    }
  }
  return await withLock(
    async (): Promise<number> => {
      const db = openDb({ path: ctx.dbPath });
      try {
        return await body(db);
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 30_000, note: lockNote("prices") },
  );
}

async function cmdCensus(ctx: Ctx): Promise<number> {
  const limit = flagInt(ctx.parsed, "limit", 10);
  const root = flagString(ctx.parsed, "root") ?? PROJECTS_ROOT;

  const db = openDb({ path: ctx.dbPath, readonly: true });
  try {
    const history = db
      .query<
        {
          swept_at: string;
          n_files: number;
          n_bytes: number;
          n_sessions: number;
          oldest_mtime: string;
          vanished_total: number;
          vanished_lt_60d: number;
        },
        [number]
      >("SELECT * FROM sweep_census ORDER BY swept_at DESC LIMIT ?")
      .all(limit);

    const counts = db
      .query<
        {
          request: number;
          turn: number;
          agent_run: number;
          workflow_run: number;
          workflow_phase: number;
          task_event: number;
          anomaly: number;
          model_price: number;
          sweep_state: number;
        },
        []
      >(
        `SELECT (SELECT COUNT(*) FROM request) AS request,
                (SELECT COUNT(*) FROM turn) AS turn,
                (SELECT COUNT(*) FROM agent_run) AS agent_run,
                (SELECT COUNT(*) FROM workflow_run) AS workflow_run,
                (SELECT COUNT(*) FROM workflow_phase) AS workflow_phase,
                (SELECT COUNT(*) FROM task_event) AS task_event,
                (SELECT COUNT(*) FROM anomaly) AS anomaly,
                (SELECT COUNT(*) FROM model_price) AS model_price,
                (SELECT COUNT(*) FROM sweep_state) AS sweep_state`,
      )
      .get()!;

    const live = discoverCorpus(root).census;
    const anomalies = db
      .query<{ kind: string; n: number }, []>(
        "SELECT kind, COUNT(*) AS n FROM anomaly GROUP BY kind ORDER BY n DESC",
      )
      .all();

    // The story-point panel (v15). The SEED lives in `config`, not in the append-only
    // spine, precisely because it is a convention rather than an observation — which
    // makes it invisible to every ledger query in this report. So it is surfaced here
    // explicitly, beside the corpus it is standing in for, with a live/stale verdict:
    // a seed whose anchor no longer matches the anchor in force is dead weight, and a
    // dead seed that still looks set is exactly how a stale rate gets trusted.
    const spEstimand = getConfig(db, "estimand") ?? "work_cet";
    const spAnchor = storyPointAnchor(db);
    const spSeedRaw = (getConfig(db, "sp_seed_wcet_per_point") ?? "").trim();
    const spSeedAnchor = getConfig(db, "sp_seed_anchor_id") ?? "";
    const spSeedNum = spSeedRaw === "" ? null : Number(spSeedRaw);
    const spRate = pointsToWcet(db, {
      bucket: "global",
      estimatorFamily: "*",
      refModel: getConfig(db, "ref_model") ?? "claude-sonnet-4-5",
      estimand: spEstimand,
    });
    const spEstimates =
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM estimate WHERE estimand = ?")
        .get(POINTS_ESTIMAND)?.n ?? 0;
    const storyPoints = {
      estimand_in_force: spEstimand,
      active: isPointsEstimand(spEstimand),
      anchor: spAnchor,
      estimate_rows: spEstimates,
      seed: {
        wcet_per_point: spSeedNum !== null && Number.isFinite(spSeedNum) && spSeedNum > 0 ? spSeedNum : null,
        anchor_id: spSeedAnchor === "" ? null : spSeedAnchor,
        // A seed is only usable against the anchor it was reasoned for.
        live: spSeedNum !== null && Number.isFinite(spSeedNum) && spSeedNum > 0 && spSeedAnchor === spAnchor.id,
        source: "config" as const,
      },
      rate: { rate: spRate.rate, source: spRate.source, n: spRate.n },
    };

    if (ctx.json) {
      ctx.out(
        JSON.stringify({ root, live, db: counts, anomalies, history, story_points: storyPoints }, null, 2),
      );
      return 0;
    }

    ctx.out(`corpus on disk (${root})`);
    ctx.out(
      `  ${num(live.files)} files, ${bytes(live.bytes)}, ${num(live.sessions)} sessions` +
        (live.oldestMtime === null ? "" : `, oldest ${live.oldestMtime.slice(0, 10)}`),
    );
    ctx.out("");
    ctx.out("database rows");
    ctx.out(
      renderTable(
        ["table", "rows"],
        Object.entries(counts).map(([k, v]) => [k, num(v)]),
      ).replace(/^/gm, "  "),
    );
    ctx.out("");
    if (anomalies.length > 0) {
      ctx.out("anomaly ledger");
      ctx.out(renderTable(["kind", "n"], anomalies.map((a) => [a.kind, num(a.n)])).replace(/^/gm, "  "));
      ctx.out("");
    }
    ctx.out(
      `story points (estimand in force: ${storyPoints.estimand_in_force}${storyPoints.active ? "" : " — points NOT active"})`,
    );
    ctx.out(`  anchor ${storyPoints.anchor.id}: "${storyPoints.anchor.text}" = 1 point`);
    ctx.out(`  ${num(storyPoints.estimate_rows)} estimate row(s) denominated in points`);
    ctx.out(
      storyPoints.seed.wcet_per_point === null
        ? "  seed rate: unset (config.sp_seed_wcet_per_point) — a bootstrap is a CONVENTION and lives in config, never in the append-only ledger"
        : `  seed rate: ${num(Math.round(storyPoints.seed.wcet_per_point))} Work-CET/point for anchor ${storyPoints.seed.anchor_id ?? "?"}` +
          ` — ${storyPoints.seed.live ? "LIVE" : `IGNORED (it was reasoned for anchor ${storyPoints.seed.anchor_id ?? "?"}, and ${storyPoints.anchor.id} is in force)`}` +
          `; stored in config, NOT as an estimate or an outcome — it was reasoned to, not predicted and not observed`,
    );
    ctx.out(
      storyPoints.rate.rate === null
        ? "  effective points→Work-CET rate: NONE — `est open` issues no Work-CET or Spend-CET forecast"
        : `  effective points→Work-CET rate: ${num(Math.round(storyPoints.rate.rate))} Work-CET/point (${storyPoints.rate.source}` +
          (storyPoints.rate.source === "fitted" ? `, n=${storyPoints.rate.n}` : "") +
          ")",
    );
    ctx.out("");
    ctx.out(`sweep_census (last ${history.length}; §5.8 expects vanished = 0 while both pruners are stood down)`);
    if (history.length === 0) {
      ctx.out("  (no sweeps recorded yet — run `est sweep`)");
    } else {
      ctx.out(
        renderTable(
          ["swept_at", "files", "bytes", "sessions", "oldest", "vanished", "<60d"],
          history.map((h) => [
            h.swept_at.replace("T", " ").slice(0, 19),
            num(h.n_files),
            bytes(h.n_bytes),
            num(h.n_sessions),
            h.oldest_mtime.slice(0, 10),
            num(h.vanished_total),
            num(h.vanished_lt_60d),
          ]),
        ).replace(/^/gm, "  "),
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `est config` — list / `get <k>` / `set <k> <v>` over the calibration constants.
 *
 * §1.1 puts EVERY tunable in the `config` table so none of them needs a code edit, and
 * schema.sql tells the reader to tune them with `est config set …` in four places. Until
 * this verb existed that instruction was false: `setConfig` had no caller outside the
 * migrations and the tests, so the only way to move `ref_model` or `attr_stale_turns` on
 * a live database was hand-written SQL — the one edit path with no lock, no validation
 * and no record of who wrote what.
 *
 * Two guards, both §2 loud failures rather than silent no-ops:
 *  - an unseeded key is rejected by name, because a typo'd key would otherwise upsert a
 *    row no reader ever looks at and read back as "set";
 *  - `schema_version` is refused outright — it is migration state, and hand-editing it
 *    either re-runs a migration over migrated data or skips one entirely.
 *
 * **The two exit codes are not interchangeable.** P2.0 fixes the surface as `0` · `1`
 * usage · `2` unknown or protected key · `4` lock busy, and the split is the whole point:
 * a script has to be able to tell a typo'd KEY (2 — the closed key set rejected it) from
 * a malformed COMMAND LINE (1 — missing key, missing value, unknown subcommand). Both
 * arriving as 1 makes the closed key set unobservable from outside.
 */
async function cmdConfig(ctx: Ctx): Promise<number> {
  const sub = positional(ctx, 0);
  if (sub !== null && sub !== "list" && sub !== "get" && sub !== "set") {
    throw new UsageError(
      `est config: unknown subcommand: ${sub} (expected \`list\`, \`get <key>\`, \`set <key> <value>\`, or no argument to list)`,
    );
  }

  // `list` and the bare form are the same command; P2.0 spells the surface with the
  // explicit verb and the bare form has shipped, so both stay.
  if (sub === null || sub === "list") {
    const db = openDb({ path: ctx.dbPath, readonly: true });
    try {
      const rows = db.query<{ k: string; v: string }, []>("SELECT k, v FROM config ORDER BY k").all();
      if (ctx.json) {
        ctx.out(JSON.stringify({ schema: 1, config: Object.fromEntries(rows.map((r) => [r.k, r.v])) }));
      } else if (!ctx.quiet) {
        ctx.out(renderTable(["key", "value"], rows.map((r) => [r.k, r.v])));
      }
      return 0;
    } finally {
      db.close();
    }
  }

  const key = positional(ctx, 1);
  if (key === null) throw new UsageError(`est config ${sub}: missing <key>`);

  if (sub === "get") {
    const db = openDb({ path: ctx.dbPath, readonly: true });
    try {
      const value = getConfig(db, key);
      if (value === null) {
        throw new InvariantError(
          `est config get: unknown key: ${key}`,
          "run `est config list` for the seeded key set; every key is seeded by schema.sql",
        );
      }
      // Bare value on stdout, so `$(est config get shrink_k)` is the number itself.
      if (ctx.json) ctx.out(JSON.stringify({ schema: 1, key, value }));
      else if (!ctx.quiet) ctx.out(value);
      return 0;
    } finally {
      db.close();
    }
  }

  const value = positional(ctx, 2);
  if (value === null) throw new UsageError(`est config set ${key}: missing <value>`);

  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        if (key === "schema_version") {
          throw new InvariantError(
            "config key `schema_version` is migration state, not a tunable",
            "let src/db.ts migrate the database — `est init` applies every pending step and writes the row itself",
          );
        }
        const old = getConfig(db, key);
        if (old === null) {
          throw new InvariantError(
            `est config set: unknown key: ${key}`,
            "every key is seeded by schema.sql — add it there (with a migration step) before tuning it; `est config list` shows the set",
          );
        }
        setConfig(db, key, value);
        if (ctx.json) ctx.out(JSON.stringify({ schema: 1, key, old, value }));
        else if (!ctx.quiet) ctx.out(`${key}: ${old} → ${value}`);
        // `estimator_model` is not a tunable, it is an ESCAPE HATCH, and it sits ABOVE
        // the per-session derivation in the resolution order (src/identity.ts). Pinning
        // it is machine-wide and permanent: every band from every session lands under
        // one family regardless of which model actually issued it, and nothing on
        // screen would ever say so. It is not refused — an operator may genuinely need
        // it — but it does not get to be quiet.
        if (key === "estimator_model" && !ctx.quiet) {
          ctx.err(
            "warning: config.estimator_model PINS the estimator identity for every session on this machine, " +
              "overriding the per-session derivation. Unset it (or use EST_ESTIMATOR_MODEL for one run) unless you " +
              "really do run exactly one model everywhere.",
          );
        }
        return 0;
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("config") },
  );
}

/**
 * `est anchor` — list / `define <id> <text>` over the story-point anchor registry (v19).
 *
 * `est config set sp_anchor_text` writes the definition of the anchor CURRENTLY IN FORCE
 * and there is no second form of it, so two states had no way out through the CLI at all:
 *
 *  - a legacy anchor id that appears only in `estimate.sp_anchor_id` — a band on disk
 *    naming a scale whose wording nobody recorded. The v18 migration deliberately
 *    declines to invent a definition for those, and `est config set` cannot reach one
 *    without first pointing `sp_anchor_id` AT it, which redenominates the live unit in
 *    order to annotate history. `est anchor define <that id> "…"` states it in place.
 *  - an `'unverified'` definition — the v18 migration's reading of the mutable
 *    `{sp_anchor_id, sp_anchor_text}` pair, which is exactly the artefact the registry
 *    exists because nobody can trust. `define` with the same text CONFIRMS it; with
 *    different text it CORRECTS it. Either way an `sp_anchor_repair` row records who
 *    said so and when, and `sp_anchor.text` keeps what was believed at the time.
 *
 * It cannot re-word a `'declared'` anchor, which is the one refusal `registerAnchor`
 * exists for: bands point at it, so its meaning does not move. Exit **2** for both
 * refusals — an invariant, not a mistyped command line.
 */
async function cmdAnchor(ctx: Ctx): Promise<number> {
  const sub = positional(ctx, 0);
  if (sub !== null && sub !== "list" && sub !== "define") {
    throw new UsageError(
      `est anchor: unknown subcommand: ${sub} (expected \`list\`, \`define <id> "<what one point is>"\`, or no argument to list)`,
    );
  }

  interface AnchorListRow {
    id: string;
    text: string;
    text_recorded: string;
    origin: string;
    verified: number;
    created_at: string;
    repaired_at: string | null;
  }

  if (sub === null || sub === "list") {
    const db = openDb({ path: ctx.dbPath, readonly: true });
    try {
      const inForce = getConfig(db, "sp_anchor_id");
      const rows = db
        .query<AnchorListRow, []>(
          "SELECT id, text, text_recorded, origin, verified, created_at, repaired_at FROM v_sp_anchor ORDER BY id",
        )
        .all();
      // Ids that BANDS name but the registry does not define. They are the population
      // `define` exists for, so listing without them would hide the reason it exists.
      const orphans = db
        .query<{ id: string; n: number }, []>(
          `SELECT sp_anchor_id AS id, COUNT(*) AS n FROM estimate
            WHERE sp_anchor_id IS NOT NULL
              AND sp_anchor_id NOT IN (SELECT id FROM sp_anchor)
            GROUP BY sp_anchor_id ORDER BY sp_anchor_id`,
        )
        .all();
      if (ctx.json) {
        ctx.out(
          JSON.stringify({
            schema: 1,
            in_force: inForce,
            anchors: rows.map((r) => ({
              id: r.id,
              text: r.text,
              text_recorded: r.text_recorded,
              origin: r.origin,
              verified: r.verified === 1,
              created_at: r.created_at,
              repaired_at: r.repaired_at,
            })),
            undefined_ids: orphans,
          }),
        );
      } else if (!ctx.quiet) {
        ctx.out(
          renderTable(
            ["id", "state", "1 point =", "since"],
            rows.map((r) => [
              r.id === inForce ? `${r.id} (in force)` : r.id,
              r.verified === 1 ? (r.repaired_at === null ? "declared" : "repaired") : "UNVERIFIED",
              r.text,
              r.repaired_at ?? r.created_at,
            ]),
          ),
        );
        for (const r of rows) {
          if (r.verified === 0) {
            ctx.out(
              `  ${r.id} is UNVERIFIED: this wording was read off the mutable config pair by the v18 ` +
                `migration, not stated by anyone. Confirm or correct it with ` +
                `\`est anchor define ${r.id} "<what one point is>"\`.`,
            );
          }
        }
        for (const o of orphans) {
          ctx.out(
            `  ${o.id} is named by ${o.n} band(s) and has NO recorded definition — ` +
              `\`est anchor define ${o.id} "<what one point is>"\` records it without moving the anchor in force.`,
          );
        }
      }
      return 0;
    } finally {
      db.close();
    }
  }

  const id = positional(ctx, 1);
  if (id === null || id.trim() === "") throw new UsageError("est anchor define: missing <id>");
  const text = positional(ctx, 2);
  if (text === null || text.trim() === "") {
    throw new UsageError(`est anchor define ${id}: missing "<what one point is>"`);
  }
  const note = flagString(ctx.parsed, "note");

  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const before = anchorDefinition(db, id);
        db.transaction(() => {
          if (before !== null && !before.verified) {
            // `registerAnchor` routes an unverified id here itself; calling `repairAnchor`
            // directly is what lets the CLI attach real evidence instead of the
            // "restated" placeholder the config path can supply.
            repairAnchor(db, id, text, {
              evidence: {
                method: "cli",
                previous: before.textRecorded,
                confirmed: before.text === text,
              },
              note,
            });
          } else {
            // Absent -> declared. Present and vouched for -> a no-op on an exact
            // restatement, and `registerAnchor`'s refusal on anything else.
            registerAnchor(db, id, text);
          }
          // The MIRROR follows the registry when the id repaired is the one in force,
          // for the reason `setConfig` maintains it at all: `est config list` and
          // `est config get sp_anchor_text` must not read back a definition the registry
          // has moved past.
          if (getConfig(db, ANCHOR_ID_KEY) === id) setConfig(db, ANCHOR_TEXT_KEY, text);
        })();
        const after = anchorDefinition(db, id)!;
        if (ctx.json) {
          ctx.out(
            JSON.stringify({
              schema: 1,
              id,
              text: after.text,
              verified: after.verified,
              action: before === null ? "declared" : before.text === text ? "confirmed" : "corrected",
            }),
          );
        } else if (!ctx.quiet) {
          ctx.out(
            before === null
              ? `anchor ${id} declared: "${after.text}" = 1 point`
              : before.text === text
                ? `anchor ${id} confirmed: "${after.text}" = 1 point (was unverified; the wording is unchanged)`
                : `anchor ${id} corrected: "${before.text}" → "${after.text}" = 1 point ` +
                  "(the recorded wording is kept; the correction is appended beside it)",
          );
        }
        return 0;
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("anchor") },
  );
}

// ---------------------------------------------------------------------------
// Phase 1 verbs (§Phase 1 interfaces)
// ---------------------------------------------------------------------------

function requireFlag(p: Parsed, name: string): string {
  const v = flagString(p, name);
  if (v === null || v.trim() === "") throw new UsageError(`--${name} is required`);
  return v;
}

function requireInt(p: Parsed, name: string): number {
  const raw = requireFlag(p, name);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number; got "${raw}"`);
  return Math.round(n);
}

function optInt(p: Parsed, name: string, dflt: number): number {
  const raw = flagString(p, name);
  if (raw === null) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : dflt;
}

function positional(ctx: Ctx, index: number): string | null {
  return ctx.parsed.positionals[index] ?? null;
}

/**
 * Translate the two typed failures into exit codes and prose. Exit 2 always prints
 * the remedy: "its message names the append path that IS allowed" (P1.0) is a
 * contract, not a nicety — a caller that cannot see the legal path will invent one.
 */
async function verb(ctx: Ctx, fn: () => Promise<number> | number): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InvariantError) {
      ctx.err(`est: REJECTED: ${e.message}`);
      ctx.err(`est: instead: ${e.remedy}`);
      return 2;
    }
    if (e instanceof UsageError) {
      ctx.err(`est: ${e.message}`);
      return 1;
    }
    if (e instanceof LockBusyError) {
      ctx.err(`est: ${e.message}`);
      return 4;
    }
    if (isConstraintError(e)) {
      // A constraint failure that reaches here is the SAME refusal an InvariantError
      // names — five tables carry `RAISE(ABORT,'append-only')` triggers and several
      // more carry UNIQUE keys — it just arrived from the driver instead of from our
      // own guard. Falling through to run()'s generic catch would print it as exit 1,
      // which reads as "transient, retry it": exactly the response P1.12 exists to
      // prevent. Exit 2 with the append path named, like every other rejection.
      ctx.err(`est: REJECTED: ${e instanceof Error ? e.message : String(e)}`);
      ctx.err(
        "est: instead: these tables are append-only or uniquely keyed — append a NEW row " +
          "(`est open` / `est scope` / `est retro --as-of <later>`) rather than rewriting one",
      );
      return 2;
    }
    throw e;
  }
}

/** A SQLite constraint refusal, however the driver chose to surface it. */
export function isConstraintError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = String((e as { code?: unknown }).code ?? "");
  return /^SQLITE_CONSTRAINT/.test(code) || /constraint failed|append-only/i.test(e.message);
}

const NUMERIC_OPEN_FLAGS = [
  "raw-p50",
  "raw-p90",
  "exp-agents",
  "exp-wf-phases",
  "exp-files-write",
  "exp-turns",
  "exp-requests",
] as const;

async function cmdOpen(ctx: Ctx): Promise<number> {
  const p = ctx.parsed;
  const cont = flagString(p, "continue");
  // The connection is opened INSIDE the lock, like `cmdInit`'s, and for the same
  // reason: `openDb()` applies pending migrations the moment it sees a stale
  // `schema_version`, and a migration is a write — it DROPs and rebuilds tables. A
  // handle opened before the lock therefore rewrites the schema while another process
  // holds the writer lock, which makes invariant 1 in this file's header ("every path
  // that writes takes the sweep lock") false rather than merely untidy. Every writing
  // verb below is built the same way.
  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const now = new Date();
        let result;
        if (cont !== null) {
          // `est open --continue <tid>` — sugar: bind this session to the task and
          // append a refinement re-issuing the previous band under the CURRENT
          // multipliers. It exists because a resumed session is the common case and
          // re-typing seven driver numbers to say "still working on this" is exactly
          // the friction that makes a ceremony get skipped.
          const prev = db
            .query<
              {
                raw_p50_wcet: number;
                raw_p90_wcet: number;
                exp_agents: number;
                exp_wf_phases: number;
                exp_files_write: number;
                exp_turns: number;
                exp_requests: number;
              },
              [string]
            >(
              "SELECT raw_p50_wcet, raw_p90_wcet, exp_agents, exp_wf_phases, exp_files_write, exp_turns, exp_requests FROM estimate WHERE tid = ? ORDER BY eid DESC LIMIT 1",
            )
            .get(cont);
          if (prev === null || prev === undefined) {
            throw new InvariantError(
              `unknown tid: ${cont}`,
              "run `est open` without --continue to mint a new task",
            );
          }
          const session = flagString(p, "session");
          // The bind is NOT issued here. It used to be — `bindTask` right on this line,
          // before `openTask` ran a single one of the checks that can reject a
          // continuation — and `bindTask` commits in its own `.immediate()`
          // transaction, so the refusal below could not take it back. A cutover
          // continuation therefore exited 2, wrote no estimate, and still left
          // `session -> tid` in `task_alias`; §5.4 reads that alias as the authority it
          // is and booked the session's NEXT request to the task the system had just
          // refused to associate it with, `exclusive`, with nothing downstream able to
          // tell that the association had been denied. A side effect that outlives the
          // validation which rejects it is worse than a wrong number: it is a wrong
          // number the ledger cannot distinguish from a real one.
          //
          // `openTask` already writes exactly this alias — same key, same
          // `source: 'est_bind'`, same `now` — inside the SAME `.immediate()`
          // transaction as the estimate row (its `existingTid !== null` arm), so the
          // estimate and the binding land together or neither does. The call here was
          // redundant as well as premature; deleting it is the whole fix.
          const kindRow = db
            .query<{ kind: string }, [string]>("SELECT kind FROM task WHERE tid = ?")
            .get(cont)!;
          const scope = db
            .query<{ subject: string }, [string]>("SELECT subject FROM v_scope_current WHERE tid = ?")
            .get(cont)!;
          result = openTask(db, {
            kind: kindRow.kind as TaskKind,
            subject: scope.subject,
            rawP50: Number(flagString(p, "raw-p50") ?? prev.raw_p50_wcet),
            rawP90: Number(flagString(p, "raw-p90") ?? prev.raw_p90_wcet),
            expAgents: optInt(p, "exp-agents", prev.exp_agents),
            expWfPhases: optInt(p, "exp-wf-phases", prev.exp_wf_phases),
            expFilesWrite: optInt(p, "exp-files-write", prev.exp_files_write),
            expTurns: optInt(p, "exp-turns", prev.exp_turns),
            expRequests: optInt(p, "exp-requests", prev.exp_requests),
            tid: cont,
            reason: (flagString(p, "reason") as EstimateReason | null) ?? "refinement",
            session,
            prompt: flagString(p, "prompt"),
            now,
          });
        } else {
          const tid = flagString(p, "tid");
          const kind = flagString(p, "kind");
          // `--from-blocks` IS the band, so the two quantile flags are not merely
          // optional — supplying them alongside it states a second, different number
          // for the same thing, and the whole point of the roll-up is that there is
          // only one. Refused rather than silently overridden.
          const fromBlocks = flagBool(p, "from-blocks");
          if (tid === null && (kind === null || !(TASK_KINDS as readonly string[]).includes(kind))) {
            throw new UsageError(`--kind is required and must be one of: ${TASK_KINDS.join(" | ")}`);
          }
          for (const f of NUMERIC_OPEN_FLAGS) {
            if (fromBlocks && (f === "raw-p50" || f === "raw-p90")) {
              if (flagString(p, f) !== null) {
                throw new UsageError(
                  `--from-blocks takes the band from the SUM of this task's block estimates, so --${f} must not also be given; ` +
                    "a roll-up and a parallel guess for the same task are two answers to one question",
                );
              }
              continue;
            }
            requireFlag(p, f);
          }
          result = openTask(db, {
            kind: (kind ?? "implement") as TaskKind,
            subject: tid === null ? requireFlag(p, "subject") : (flagString(p, "subject") ?? ""),
            description: flagString(p, "description"),
            dod: parseDod(flagString(p, "dod")),
            fromBlocks,
            rawP50: fromBlocks ? 0 : requireInt(p, "raw-p50"),
            rawP90: fromBlocks ? 0 : requireInt(p, "raw-p90"),
            expAgents: requireInt(p, "exp-agents"),
            expWfPhases: requireInt(p, "exp-wf-phases"),
            expFilesWrite: requireInt(p, "exp-files-write"),
            expTurns: requireInt(p, "exp-turns"),
            expRequests: requireInt(p, "exp-requests"),
            tid,
            reason: flagString(p, "reason") as EstimateReason | null,
            session: flagString(p, "session"),
            prompt: flagString(p, "prompt"),
            now,
          });
        }

        if (ctx.json) {
          ctx.out(
            JSON.stringify({
              schema: 1,
              tid: result.tid,
              eid: result.eid,
              version: result.version,
              reason: result.reason,
              band: {
                // NULL under `story_point` when there is no points -> Work-CET rate.
                // `p50_wcet: 8` for an 8-point band would be a token count derived from
                // nothing, and a consumer has no way to tell it from a real one — so
                // the field goes absent rather than wrong, and `points` below carries
                // the band the estimator actually issued.
                p50_wcet: result.band.wcetAvailable ? result.band.p50 : null,
                p90_wcet: result.band.wcetAvailable ? result.band.p90 : null,
                p50_points: result.points?.p50 ?? null,
                p90_points: result.points?.p90 ?? null,
                req_p50: result.band.reqP50,
                req_p90: result.band.reqP90,
                active_p50_s: result.band.activeP50S,
                active_p90_s: result.band.activeP90S,
                spend_usd_p50: result.band.spendUsdP50,
                spend_usd_p90: result.band.spendUsdP90,
              },
              // The bridge, stated rather than implied: `rate` null means no Work-CET
              // figure was issued at all, and `source` distinguishes a rate fitted from
              // n completed tasks from a bootstrapped convention.
              wcet_rate: {
                rate: result.wcetRate.rate,
                source: result.wcetRate.source,
                n: result.wcetRate.n,
              },
              sp_anchor:
                result.spAnchor === null
                  ? null
                  : { id: result.spAnchor.id, text: result.spAnchor.text },
              // Beside the anchor because it is the same kind of fact: `sp_anchor` says
              // what a point WAS when this band was issued, and `procedure_version` says
              // which instruction produced the quantiles. Both are pinned onto the row
              // at open time (v17) and both are how a later reader tells a band sized
              // under one regime from one sized under another. It was recorded and
              // returned but never emitted, so the only consumer that drives `est open`
              // — the estimating skill, via `--json` — could not see it.
              procedure_version: result.procedureVersion,
              rolled_up_from_blocks: result.rolledUpFromBlocks,
              // Beside the count it qualifies, and ALWAYS present (usually null) for the
              // same reason `near_duplicates` is always present: the estimating skill is
              // the one caller that drives `est open --json`, so an advisory that existed
              // only on the human render would be invisible to the only consumer able to
              // act on it. v18 turned this from a refusal into an observation — the
              // roll-up lands either way, and nothing here moves the exit code.
              rollup_notice: result.rollupNotice,
              raw: result.raw,
              uncalibrated: result.uncalibrated,
              plant: result.plant,
              bucket: result.bucket,
              bucket_n: result.bucketN,
              ref_model: result.refModel,
              estimand: result.estimand,
              price_epoch: result.priceEpoch,
              refclass_as_of: result.refclassAsOf,
              // WHO estimated, and which leg of the resolution order said so. Projected
              // because the calibration bucket this band joins is keyed on it, and
              // `'unknown'`/`pending` means the band is filed under a repairable
              // sentinel rather than under a model — a fact a consumer should be able
              // to see without querying the ledger.
              estimator_model: result.estimatorModel,
              estimator_method: result.estimatorMethod,
              anchor: { session: result.anchor.sessionId, prompt: result.anchor.promptId },
              // Advisory, always present (usually `[]`). The estimating skill drives
              // `est open --json`, so a warning that existed only on the human render
              // would be invisible to the one caller that can act on it.
              near_duplicates: result.nearDuplicates.map((d) => ({
                tid: d.tid,
                subject: d.subject,
                status: d.status,
                overlap: Number(d.overlap.toFixed(2)),
              })),
            }),
          );
        } else if (!ctx.quiet) {
          const usd = (v: number | null): string => (v === null ? "?" : `$${v.toFixed(2)}`);
          ctx.out(
            `${result.minted ? "opened" : `re-estimated (${result.reason}, v${result.version})`} ${result.tid}`,
          );
          const spendLine = `Spend-CET forecast ${usd(result.band.spendUsdP50)}–${usd(result.band.spendUsdP90)} (a LOWER bound: input and cache_read are excluded from Work-CET)`;
          if (result.points === null) {
            ctx.out(
              `band  ${num(result.band.p50)} / ${num(result.band.p90)} Work-CET` +
                `  ·  requests ${result.band.reqP50}–${result.band.reqP90}` +
                `  ·  active time: not predicted yet (§7.3 — the model has not beaten its baseline)` +
                `  ·  ${spendLine}`,
            );
          } else {
            // The POINTS band is the headline, because it is the thing that was
            // actually estimated. Work-CET and Spend-CET are derived, and they appear
            // only when something real derived them.
            ctx.out(
              `band  ${num(result.points.p50)} / ${num(result.points.p90)} points` +
                ` (anchor ${result.spAnchor?.id ?? "?"}: "${result.spAnchor?.text ?? ""}" = 1 point)` +
                `  ·  requests ${result.band.reqP50}–${result.band.reqP90}` +
                `  ·  active time: not predicted yet (§7.3 — the model has not beaten its baseline)`,
            );
            if (result.band.wcetAvailable && result.wcetRate.rate !== null) {
              ctx.out(
                `      Work-CET forecast ${num(result.band.p50)} / ${num(result.band.p90)}` +
                  ` at ${num(Math.round(result.wcetRate.rate))} Work-CET/point (${result.wcetRate.source}` +
                  (result.wcetRate.source === "fitted"
                    ? `, n=${result.wcetRate.n} completed story-point task(s)`
                    : ", a bootstrapped convention — NOT measured from completed work") +
                  `)  ·  ${spendLine}`,
              );
            } else {
              // THE THIRD surface that offers the seed, after `est burn`'s band note and
              // the retro's `unit_refusal`. It used to offer it in one trailing clause
              // with no bar attached — "or set the bootstrap with …" — which read as a
              // co-equal fix on the one surface a person meets while they are still
              // waiting for a number. Same shape as the siblings, deliberately: "do
              // nothing" first with its consequence, then the seed named as the
              // decided-against lever it is, with §13.1 and the bar travelling with it.
              ctx.out(
                `      no points→Work-CET rate: bucket "${result.bucket}" has ${result.bucketN} completed story-point task(s) (fitting starts at ${COLD_START_N})` +
                  ` and config.sp_seed_wcet_per_point is unset for anchor ${result.spAnchor?.id ?? "?"}.` +
                  ` NO Work-CET and NO Spend-CET forecast is issued — a token figure derived from nothing is worse than none.`,
              );
              ctx.out(
                `      do nothing: a FITTED rate appears on its own once the bucket has ${COLD_START_N} completed ` +
                  `story-point tasks, and the cold start ends with nobody deciding anything.`,
              );
              ctx.out(
                `      no seed is set DELIBERATELY (DECISIONS.md §13.1 — the implied rate is not stable, and a seed ` +
                  `lives in \`config\`, where it would be fitted against and never resurface as the assumption it is). ` +
                  `\`est config set sp_seed_wcet_per_point <n>\` + \`sp_seed_anchor_id ${result.spAnchor?.id ?? "v1"}\` ` +
                  `is Craig's own lever and clears the bar only on ρ(actual, rate) ≈ 0 and rate CV < 0.3 measured over ` +
                  `≥${COLD_START_N} REAL completed tasks — impatience is not that evidence.`,
              );
            }
          }
          if (result.rolledUpFromBlocks !== null) {
            ctx.out(
              `      band is the ROLL-UP of ${result.rolledUpFromBlocks} block estimate(s), not a separate guess (--from-blocks)`,
            );
          }
          ctx.out(
            result.uncalibrated
              ? `      UNCALIBRATED — bucket "${result.bucket}" has ${result.bucketN} comparable completed task(s); calibration starts at 10. This is your raw band, unchanged.`
              : `      calibrated from refclass ${result.refclassAsOf} (bucket ${result.bucket}, n=${result.bucketN}); raw was ${num(result.raw.p50)} / ${num(result.raw.p90)}`,
          );
          // Said out loud only when it is the sentinel. A band filed under 'unknown' is
          // in its own reference class of one until the next sweep ingests the anchoring
          // turn and `repairEstimatorIdentity` resolves it — which is a fact worth
          // seeing, and a silence worth not keeping.
          if (result.estimatorMethod === "pending") {
            ctx.out(
              "      estimator: unknown (this session's turn has not been swept yet) — the band is filed under the " +
                "repairable 'unknown' key; the next sweep resolves it, or `est repair-identity`",
            );
          }
          ctx.out(`${PLANT_MARKER} ${result.plant.call}`);
        }
        // Same contract as the near-duplicate warning below, and for the same reasons:
        // STDERR, on BOTH render paths, `!ctx.quiet`, and never touching the exit code.
        //
        // v18 replaced a refusal with this observation. `--from-blocks` requires `--tid`,
        // so a roll-up can only ever land as a REFINEMENT, and `est close` scores
        // `MIN(eid)` — the roll-up was therefore never the measured band and was never
        // meant to be, which is what made the old mechanical guard unnecessary. What is
        // still worth saying is that the blocks hang off the FIRST estimate, because that
        // shape means someone followed the open-coarse-then-decompose advice that has
        // since been withdrawn. `openTask` wrote the same text to
        // `anomaly(from_blocks_on_baseline)` inside the estimate's own transaction, so
        // this line is the interactive surface of a fact the ledger already carries —
        // not the only record of it, and not something a quiet run loses.
        if (result.rollupNotice !== null && !ctx.quiet) {
          ctx.err(`est open: NOTICE — ${result.rollupNotice}`);
        }
        // On STDERR, on BOTH render paths, and never affecting the exit code (P1.0
        // observe-first). Stderr because it is not part of the band contract — the
        // `--json` document on stdout must stay a single parseable object, and the
        // human render's `EST_PLANT:` line must stay the last thing printed.
        if (result.nearDuplicates.length > 0 && !ctx.quiet) {
          const d = result.nearDuplicates[0]!;
          ctx.err(
            `est open: WARNING — this session already has an OPEN task with an overlapping subject:\n` +
              `  ${d.tid} (${d.status}) "${d.subject}"` +
              (result.nearDuplicates.length > 1
                ? ` — and ${result.nearDuplicates.length - 1} more`
                : "") +
              `\n  Two tasks in one session split that session's spend between them (§5.4), so BOTH actuals\n` +
              `  come out wrong. If this is the SAME goal, the two legitimate paths are:\n` +
              `    est open --tid ${d.tid} --reason refinement …   (the estimate moved; append to it)\n` +
              `    est bind ${d.tid} [--session <sid>] [--task <n>] [--agent <id>]   (delegated work; attach its identity)\n` +
              `  ${result.tid} was minted anyway — this is a warning, never a refusal.`,
          );
        }
        return 0;
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("open") },
  );
}

async function cmdBlock(ctx: Ctx): Promise<number> {
  const tid = positional(ctx, 0);
  if (tid === null) throw new UsageError("est block: missing <tid>");
  const p = ctx.parsed;
  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const r = addBlock(db, {
          tid,
          phaseIdx: requireInt(p, "phase"),
          title: requireFlag(p, "title"),
          p50: requireInt(p, "p50"),
          p90: requireInt(p, "p90"),
          expAgents: optInt(p, "exp-agents", 1),
          model: flagString(p, "model"),
          now: new Date(),
        });
        if (ctx.json) ctx.out(JSON.stringify({ schema: 1, ...r }));
        else if (!ctx.quiet) {
          const unit = isPointsEstimand(r.estimand) ? "points" : "Work-CET";
          ctx.out(
            `block ${r.phaseIdx} "${r.title}" → ${num(r.p50)} / ${num(r.p90)} ${unit} (eid ${r.eid}, ${r.blocksSoFar}` +
              `${r.declaredPhases === null ? "" : `/${r.declaredPhases}`} block(s) recorded)`,
          );
          // The roll-up, after every block: for decomposed work the SUM is the estimate,
          // so it has to be visible while it is being built. `est retro` has always
          // scored the task band against this number. It does NOT advertise
          // `--from-blocks` here: that flag needs `--tid`, so it can only land as a
          // refinement, and `est close` scores MIN(eid) — pointing at it from inside the
          // blocking loop is what taught the coarse-open-then-roll-up order that leaves
          // the coarse guess as the scored baseline.
          ctx.out(
            `      roll-up so far  ${num(r.rollup.p50)} / ${num(r.rollup.p90)} ${unit} over ${r.rollup.blocks} block(s)` +
              ` — should converge on the band this task was opened with; if it has genuinely moved,` +
              ` re-estimate deliberately (\`est open --tid ${r.tid} --reason refinement\`)`,
          );
          if (r.declaredPhases !== null && r.blocksSoFar < r.declaredPhases) {
            ctx.out(
              `      ${r.declaredPhases - r.blocksSoFar} declared phase(s) still unblocked — a T1 estimate whose blocks do not cover every declared phase is reported as incomplete in the retro's data-quality panel`,
            );
          }
        }
        return 0;
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("block") },
  );
}

async function cmdBind(ctx: Ctx): Promise<number> {
  const tid = positional(ctx, 0);
  if (tid === null) throw new UsageError("est bind: missing <tid>");
  const p = ctx.parsed;
  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const r = bindTask(db, {
          tid,
          session: flagString(p, "session"),
          task: flagString(p, "task"),
          run: flagString(p, "run"),
          agent: flagString(p, "agent"),
          now: new Date(),
        });
        if (ctx.json) ctx.out(JSON.stringify({ schema: 1, ...r }));
        else if (!ctx.quiet) {
          for (const w of r.written) {
            ctx.out(`${w.existed ? "already bound" : "bound"} ${w.id_kind}=${w.local_id} → ${r.tid}`);
          }
        }
        return 0;
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("bind") },
  );
}

async function cmdScope(ctx: Ctx): Promise<number> {
  const tid = positional(ctx, 0);
  if (tid === null) throw new UsageError("est scope: missing <tid>");
  const p = ctx.parsed;
  // `flagStringOpt`, not `flagString`: a scope revision names the fields it CHANGES,
  // and an omitted flag must reach `appendScope` as `undefined` so the previous value
  // is carried forward. `null` there means "clear it" (see flagStringOpt's header).
  const dodRaw = flagStringOpt(p, "dod");
  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const r = appendScope(db, {
          tid,
          reason: requireFlag(p, "reason"),
          subject: flagStringOpt(p, "subject"),
          description: flagStringOpt(p, "description"),
          dod: dodRaw === undefined ? undefined : parseDod(dodRaw),
          now: new Date(),
        });
        if (ctx.json) ctx.out(JSON.stringify({ schema: 1, ...r }));
        else if (!ctx.quiet) {
          ctx.out(`scope seq ${r.seq} appended for ${r.tid} (${r.scopeHash.slice(0, 12)}…)`);
          ctx.out(r.diffSummary);
          ctx.out(
            "`est open --tid <tid> --reason scope_change …` is now permitted; it is the ONLY reason that removes a task from the velocity corpus.",
          );
        }
        return 0;
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("scope") },
  );
}

/**
 * `est burn` — read-only; **never sweeps, never writes, never takes the lock.**
 * Exit 0 always, including every empty case.
 */
function cmdBurn(ctx: Ctx): number {
  const p = ctx.parsed;
  const refresh = flagBool(p, "refresh");
  const opts = {
    tid: positional(ctx, 0),
    session: flagString(p, "session"),
    refresh,
    now: new Date(),
  };
  // `--refresh` is the live aggregation, and a live aggregation needs a normal
  // connection; the cached path uses the 50 ms read-only one that must fail fast
  // rather than queue behind a sweep.
  // Typed at the declaration rather than inferred: the annotation is what makes the
  // `catch` branch below a checked burn payload instead of a bag of fields that merely
  // resembles one, and it is why a stale `schema` there is now a compile error.
  let payload: BurnJson;
  if (refresh) {
    let db: ReturnType<typeof openDb> | null = null;
    try {
      db = openDb({ path: ctx.dbPath, readonly: true });
      payload = burnJson(db, opts);
    } catch (e) {
      // Same classifier the read path uses: a locked file is `db_busy`, and only a
      // genuinely absent or unreadable one is `db_missing`.
      // `BURN_SCHEMA`, never a literal: this is the ONE burn payload built outside
      // `src/burn.ts`, so a hardcoded version here would keep claiming the old shape
      // after the contract moved — and it is emitted exactly when the database is
      // locked, the path least likely to be exercised before a consumer hits it.
      payload = { schema: BURN_SCHEMA, active: false as const, as_of: isoNow(), reason: classifyOpenError(e) };
    } finally {
      db?.close();
    }
  } else {
    payload = burnRead(ctx.dbPath, opts);
  }
  if (ctx.json) ctx.out(JSON.stringify(payload));
  else if (!ctx.quiet) ctx.out(renderBurn(payload));
  return 0;
}

async function cmdClose(ctx: Ctx): Promise<number> {
  const tid = positional(ctx, 0);
  if (tid === null) throw new UsageError("est close: missing <tid>");
  const statusRaw = flagString(ctx.parsed, "status");
  const allowed = ["completed", "abandoned", "deleted", "reopened"];
  if (statusRaw !== null && !allowed.includes(statusRaw)) {
    throw new UsageError(`--status must be one of: ${allowed.join(" | ")}`);
  }
  // Rejected rather than treated as consent: `--accept` with nothing in it is a close
  // with no one behind it, which is what `--force` is for and is named as.
  const acceptRaw = flagString(ctx.parsed, "accept");
  const forceFlag = flagBool(ctx.parsed, "force");
  if (acceptRaw !== null && acceptRaw.trim() === "") {
    throw new UsageError(
      'est close --accept: quote the human\'s acceptance, e.g. --accept "I accept the task is done"',
    );
  }
  // The two bypasses make opposite claims about who decided, so passing both says
  // nothing. `closeTask` refuses the same combination — this layer exists for the
  // message, that one so no other caller can get past it.
  if (acceptRaw !== null && forceFlag) {
    throw new UsageError(
      "est close: pass --accept (the human decided, and the ledger records their words) or --force (nobody is named), never both",
    );
  }
  if (acceptRaw !== null && (statusRaw === "reopened" || statusRaw === "deleted")) {
    throw new UsageError(
      `est close --accept: an acceptance asserts the work is COMPLETE, so it cannot close as '${statusRaw}' — use --status completed or abandoned`,
    );
  }
  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const r = closeTask(db, {
          tid,
          status: (statusRaw as FinalStatus | null) ?? "completed",
          force: forceFlag,
          accept: acceptRaw,
          now: new Date(),
        });
        if (ctx.json) ctx.out(JSON.stringify({ schema: 1, ...r }));
        else if (!ctx.quiet) {
          ctx.out(
            `closed ${r.tid} as ${r.final_status} (revision ${r.revision}${r.censored ? ", CENSORED — the actual is a lower bound" : ""})`,
          );
          ctx.out(
            `actual  ${num(r.actual_wcet)} Work-CET (main ${num(r.wcet_main)} / sub ${num(r.wcet_sub)} / aux ${num(r.wcet_aux)}), ` +
              `${num(r.n_requests)} requests, ${num(r.n_agents)} agents, overhead ${num(r.overhead_wcet)}`,
          );
          ctx.out(
            `time    active ${Math.round(r.active_s / 60)}m (union), busy ${Math.round(r.busy_s / 60)}m, ` +
              `max concurrency ${r.max_concurrency}, parallelism ${r.parallelism_factor === null ? "n/a" : r.parallelism_factor.toFixed(2)}×`,
          );
          ctx.out(
            r.velocity_raw === null
              ? `velocity  not computable: actual_wcet_at_epoch is NULL (no price row at the estimate's vintage), so this task stays OUT of the velocity corpus rather than joining it under a vintage that never existed`
              : `velocity  raw ${r.velocity_raw.toFixed(2)}× · calibrated ${r.velocity_cal === null ? "n/a" : `${r.velocity_cal.toFixed(2)}×`} · ` +
                `${r.in_band === true ? "inside" : "OUTSIDE"} the p90 band (judged against eid ${r.eid_at_start}, the FIRST estimate — always)`,
          );
          if (r.forced) ctx.out(`FORCED  the quiescence gate was overridden: ${r.quiescence.failing.join("; ")}`);
          if (r.accepted) {
            ctx.out(
              `ACCEPTED  closed on the human's recorded acceptance` +
                (r.quiescence.ok ? "" : ` (gate bypassed: ${r.quiescence.failing.join("; ")})`) +
                ` — anomaly(accepted_close) carries the quote`,
            );
          }
          if (r.alerts.length > 0) ctx.out(`alerts  ${r.alerts.join(", ")}`);
        }
        return r.alerts.length > 0 ? 3 : 0;
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("close") },
  );
}

function cmdRefclass(ctx: Ctx): number {
  const p = ctx.parsed;
  const text = flagString(p, "text") ?? positional(ctx, 0);
  if (text === null) throw new UsageError("est refclass: --text \"<subject>\" is required");
  const fanoutRaw = flagString(p, "fanout");
  // Rejected rather than defaulted: --fanout narrows the class now, so a value the
  // parser could not read must not be silently dropped on the floor (which is what
  // the whole flag used to be).
  const fanout = fanoutRaw === null ? null : Number(fanoutRaw);
  if (fanout !== null && (!Number.isFinite(fanout) || fanout < 0)) {
    throw new UsageError(`est refclass: --fanout must be a non-negative number; got ${fanoutRaw}`);
  }
  const db = openDb({ path: ctx.dbPath, readonly: true });
  try {
    const r = refclass(db, {
      kind: flagString(p, "kind"),
      fanout,
      text,
      limit: optInt(p, "limit", 5),
      // Forwarded so step 1 and step 7 of the ceremony resolve the SAME estimator
      // identity. `est open --session X` beside a bare `est refclass` used to print one
      // family's calibration and stamp another's.
      session: flagString(p, "session"),
      prompt: flagString(p, "prompt"),
    });
    if (ctx.json) {
      ctx.out(JSON.stringify({ schema: 1, ...r }));
      return 0;
    }
    const lines: string[] = [];
    // Step 1 of the ceremony is the only place the estimator is told what "1" means, so
    // under story points the anchor leads. Every row and the distribution below are
    // already filtered to `r.estimand` (src/tasks.ts) — a Work-CET actual sitting next
    // to a points band would be two units in one table with nothing saying so.
    if (r.sp_anchor !== null) {
      lines.push(
        `anchor ${r.sp_anchor.id}: "${r.sp_anchor.text}" = 1 point. ` +
          `Size the work RELATIVE to that; decompose first, then sum — that is what took the ` +
          `cross-model spread from 61.9× to 1.96×.`,
      );
      if (!r.sp_anchor.verified) {
        // The definition is shown because it is the best reading available, and marked
        // because it is a reading: the v18 migration took it off two independently
        // mutable config keys, which is precisely the pair that could say `{v1, "<the v2
        // definition>"}`. Step 1 of the ceremony is where an estimator is told what "1"
        // means, so it is the one place that caveat cannot be left off.
        lines.push(
          `  ⚠ that wording is UNVERIFIED — migrated from config, not stated by anyone. ` +
            `Confirm or correct it with \`est anchor define ${r.sp_anchor.id} "<what one point is>"\`.`,
        );
      }
      lines.push(
        r.wcet_rate.rate === null
          ? `  points→Work-CET: NO RATE YET (no fitted rate, no seed). A points band will be issued with no Work-CET or Spend-CET forecast.`
          : `  points→Work-CET: ${num(Math.round(r.wcet_rate.rate))} Work-CET/point (${r.wcet_rate.source}` +
            (r.wcet_rate.source === "fitted" ? `, n=${r.wcet_rate.n}` : ", bootstrapped") +
            `)`,
      );
    }
    const rawUnit = r.sp_anchor === null ? "raw p50" : "raw p50 (pts)";
    if (r.matches.length === 0) {
      lines.push(`no completed task matches "${text}" — an empty reference class is a valid answer, not a failure`);
    } else {
      lines.push(
        renderTable(
          ["subject", "kind", "fanout", rawUnit, "actual", "velocity"],
          r.matches.map((m) => [
            m.subject.length > 48 ? `${m.subject.slice(0, 47)}…` : m.subject,
            m.kind,
            String(m.fanout),
            num(m.raw_p50),
            num(m.actual_wcet),
            m.velocity === null ? "n/a" : `${m.velocity.toFixed(2)}×`,
          ]),
        ),
      );
      for (const m of r.matches) {
        if (m.excerpt !== "") lines.push(`  · ${m.subject}: ${m.excerpt}`);
      }
      if (r.fanout_relaxed && r.fanout_band !== null) {
        // The flag must not manufacture an empty class, and it must not silently
        // widen one either — a match list that ignored --fanout has to say so.
        lines.push(
          `  note: no completed task ran at a comparable fan-out (${r.fanout_band.lo}–${r.fanout_band.hi} agents for --fanout ${r.fanout}); ` +
            "these matches are the UNFILTERED class",
        );
      } else if (r.fanout_band !== null) {
        lines.push(`  fan-out filter: ${r.fanout_band.lo}–${r.fanout_band.hi} agents (--fanout ${r.fanout})`);
      }
    }
    if (r.bucket.uncalibrated) {
      const d = r.cold_distribution;
      // Two reasons to withhold the multiplier, and they must not print the same
      // sentence. "Fewer than ten samples" is the cold start. "Ten samples of a DIFFERENT
      // anchor" is a unit mismatch, and saying "below 10 comparable completed tasks"
      // beside `n=10` would read as a bug in the counter rather than as the refusal it
      // is. This line is what a stale `×2000` used to occupy.
      lines.push(
        r.sp_anchor !== null && r.wcet_rate.source !== "fitted" && r.bucket.n >= 10
          ? `bucket ${r.bucket.bucket}: n=${r.bucket.n} at anchor ${r.sp_anchor.id} — NO MULTIPLIER SHOWN. ` +
              `The newest snapshot is not fitted from this anchor's samples alone (\`refclass\` is not keyed on the ` +
              `anchor), and a multiplier under \`story_point\` IS the Work-CET-per-point rate — so showing it here ` +
              `would put one anchor's number beside another anchor's name.`
          : `bucket ${r.bucket.bucket}: n=${r.bucket.n} — UNCALIBRATED. No velocity multiplier is shown, deliberately: ` +
              `below 10 comparable completed tasks a multiplier is a rumour, not a measurement.`,
      );
      if (d !== null && d.n > 0) {
        lines.push(
          `  raw actual-cost distribution over ${d.n} completed task(s): p10 ${num(d.p10 ?? 0)} · p50 ${num(d.p50 ?? 0)} · p90 ${num(d.p90 ?? 0)} Work-CET`,
        );
      }
    } else {
      const ci = (x: { lo: number; hi: number } | null): string =>
        x === null ? "" : ` [${x.lo.toFixed(2)}–${x.hi.toFixed(2)}]`;
      lines.push(
        `bucket ${r.bucket.bucket}: n=${r.bucket.n} (n_eff ${(r.bucket.n_eff ?? 0).toFixed(1)}), ` +
          `×${(r.bucket.mult_p50 ?? 1).toFixed(2)} p50${ci(r.bucket.boot_p50)} · ` +
          `×${(r.bucket.mult_p90 ?? 1).toFixed(2)} p90${ci(r.bucket.boot_p90)} · snapshot ${r.bucket.as_of}`,
      );
    }
    lines.push(
      r.sp_anchor === null
        ? `unit: ${r.estimand} normalised by ${r.ref_model} output tokens`
        : `unit: ${r.estimand} (band in points against anchor ${r.sp_anchor.id}; actuals in Work-CET normalised by ${r.ref_model} output tokens, so "velocity" above reads as Work-CET per point)`,
    );

    let text_ = lines.join("\n");
    if (flagBool(p, "full")) {
      ensureSpool();
      const path = join(SPOOL_DIR, `refclass-${isoNow().replace(/[:]/g, "")}.txt`);
      writeFileSync(path, `${text_}\n`, "utf8");
      ctx.out(`full reference class written to ${path}`);
      text_ = text_.slice(0, REFCLASS_BUDGET_CHARS);
    } else if (text_.length > REFCLASS_BUDGET_CHARS) {
      text_ = `${text_.slice(0, REFCLASS_BUDGET_CHARS - 40)}\n… [truncated to the 8,000-char budget; --full]`;
    }
    ctx.out(text_);
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Land one `anomaly(kind='board_render_failed')` for a MANUAL render failure, the same
 * row `regenerateBoardIfDue` produces on the sweep path.
 *
 * Best-effort by construction, like `touchBoardMarker`: the render is read-only, so this
 * needs its own writable handle, and the thing that just failed may well be the database
 * itself. A failure to record the failure must not turn a `0` into a crash — the operator
 * already has the message on stderr, and the next sweep re-renders. `insertAnomalies`
 * de-duplicates on `(kind, detail)`, so a render that fails on every invocation writes
 * one row rather than one per attempt.
 */
function recordBoardRenderFailure(ctx: Ctx, message: string, now: Date): void {
  try {
    const db = openDb({ path: ctx.dbPath });
    try {
      insertAnomalies(db, [{ kind: "board_render_failed", detail: `est board render failed: ${message}` }], isoNow(now));
    } finally {
      db.close();
    }
  } catch {
    // best-effort; see doc comment above
  }
}

/**
 * `est board` — P1.8's terminal/JSON read model, plus P2.7's file renderer.
 *
 * `--html`/`--md` switch to the FILE mode: `--out <dir>` names the destination
 * (default: the directory the database itself lives in — same rule `runSweep`
 * applies automatically, see `SweepOptions.boardDir`), and this call is UNTHROTTLED
 * — an explicit request bypasses the sweep's `board_min_interval_s` gate the same
 * way a manual `est sweep` is never throttled while the hook-spawned micro-sweep is
 * (P1.10's distinction, carried over here, §7.1/P2.7).
 *
 * **A render failure exits `0`, exactly as it does on the sweep path.** P2.7 fixes the
 * contract as "`0` always (a render failure is an anomaly, not a failed command) · `1`
 * usage", and the reason is the same in both directions: the board is a convenience and
 * the failure belongs in the ledger the alerting reads, not only on one operator's
 * terminal. Exiting `1` here made a manual render failure invisible to `anomaly`-based
 * alerting AND indistinguishable from a mistyped flag. The message still goes to stderr
 * — the person who just typed the command hears about it — and the previous good files
 * are left intact by `writeAtomic`'s rename discipline.
 */
function cmdBoard(ctx: Ctx): number {
  const p = ctx.parsed;
  const wantHtml = flagBool(p, "html");
  const wantMd = flagBool(p, "md");

  if (wantHtml || wantMd) {
    const dir = flagString(p, "out") ?? dirname(ctx.dbPath);
    const now = new Date();
    const written: { html?: string; md?: string } = {};
    let failure: string | null = null;
    // Read-only for the render itself: the happy path of a board render must not be
    // able to write to the database it is reading.
    const db = openDb({ path: ctx.dbPath, readonly: true });
    try {
      const r = renderBoardFiles(db, dir, {
        limit: optInt(p, "limit", DEFAULT_BOARD_LIMIT),
        now,
        html: wantHtml,
        md: wantMd,
      });
      if (r.html_path !== null) written.html = r.html_path;
      if (r.md_path !== null) written.md = r.md_path;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      db.close();
    }

    if (failure !== null) {
      recordBoardRenderFailure(ctx, failure, now);
      ctx.err(`est board: render/write failed: ${failure}`);
      return 0;
    }
    if (ctx.json) {
      ctx.out(JSON.stringify({ schema: 1, written }));
    } else if (!ctx.quiet) {
      for (const [kind, path] of Object.entries(written)) ctx.out(`wrote ${kind}: ${path}`);
    }
    return 0;
  }

  const db = openDb({ path: ctx.dbPath, readonly: true });
  try {
    const r = board(db, {
      column: flagString(ctx.parsed, "status"),
      limit: optInt(ctx.parsed, "limit", 20),
      now: new Date(),
    });
    // STILL 1, and the rule that decides it: **a payload's version moves when an
    // existing key is REMOVED or RETYPED, never when a key is added** — a decoder that
    // ignores what it does not recognise survives the second and cannot survive the
    // first. `BoardPhase` gained `blocks_in_points`, `block_points_p50` and
    // `block_points_p90`, which is purely additive; `block_p50`/`block_p90` were already
    // `number | null` before that change, so nothing a schema-1 consumer already decodes
    // has a new shape. (What DID change is which values land in `block_p50` — a points
    // block now leaves it null instead of parking a points figure in a Work-CET-named
    // field. That was the field violating its own declared type in spirit, not the type
    // changing, so it is a bug fix inside the contract rather than a new contract.)
    // Contrast `BURN_SCHEMA`, at 2 because four `number` fields widened to
    // `number | null`: a strict decoder had no way to absorb that, and no way to know.
    if (ctx.json) {
      ctx.out(JSON.stringify({ schema: 1, ...r }));
      return 0;
    }
    // The `consumed` column is Work-CET; the p50/p90 columns are Work-CET too, EXCEPT
    // where the band is in story points that nothing can convert. There they carry the
    // points band with a `pt` suffix, so a reader scanning the row cannot subtract one
    // from the other without seeing the unit change — and the legend below spells it
    // out whenever such a card is on screen. `cal_p50`/`cal_p90` are 0 in that state
    // (src/retro.ts), which is why the points band has to come off `c.points`.
    let sawPoints = false;
    let sawSeed = false;
    for (const col of r.columns) {
      ctx.out(`${col.column} (${col.cards.length})`);
      if (col.cards.length === 0) {
        ctx.out("  —");
        continue;
      }
      ctx.out(
        renderTable(
          ["subject", "kind", "consumed", "p50", "p90", "main/sub", "phase_conf"],
          col.cards.map((c) => {
            const p = c.points;
            const unconverted = p !== null && p.rate === null;
            if (unconverted) sawPoints = true;
            if (p !== null && p.rate_source === "seed") sawSeed = true;
            const mark = (c.uncalibrated ? "*" : "") + (p !== null && p.rate_source === "seed" ? "?" : "");
            return [
              c.subject.length > 44 ? `${c.subject.slice(0, 43)}…` : c.subject,
              c.kind,
              num(c.consumed_wcet),
              unconverted ? `${num(p.p50)} pt${mark}` : `${num(c.cal_p50)}${mark}`,
              unconverted ? `${num(p.p90)} pt` : num(c.cal_p90),
              `${num(c.wcet_main)}/${num(c.wcet_sub)}`,
              c.phase_conf ?? "—",
            ];
          }),
        ).replace(/^/gm, "  "),
      );
    }
    ctx.out("");
    ctx.out(
      "* = uncalibrated band (cold start). `est board --html [--md] [--out <dir>]` writes the fuller kanban view to disk (P2.7).",
    );
    if (sawPoints) {
      ctx.out(
        "pt = STORY POINTS, a size relative to the anchor — NOT Work-CET and NOT comparable with the consumed column. " +
          "No points→Work-CET rate exists for those bands yet, so no percentage or overrun is computed for them.",
      );
    }
    if (sawSeed) {
      ctx.out(
        "? = the band was converted through the SEED rate (`config.sp_seed_wcet_per_point`) — a convention reasoned to, " +
          "backed by no completed story-point task.",
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `est recon` — weekly reconciliation (P2.6, §7.5 widened).
 *
 * Writes one `recon` row (USD) and one `recon_metric` row per other axis, raises
 * `recon_mismatch` for any axis past `recon_alert_pct`, and — with `--certify` —
 * evaluates the criterion that retires the statusline's `[unvalidated]` marker.
 *
 * Exit `0` · `1` usage · `3` an axis breached the alert threshold (so a cron leg can
 * alert on it) · `4` lock busy. `--dry-run` never writes and never takes the lock,
 * which is what makes this safe to run against a copy during a review.
 */
/**
 * `est otel` — the operator's view of the OTLP receiver (P2.3).
 *
 * The ONE verb in this CLI that never opens the database, and that is the point rather
 * than an omission: the receiver's whole contract is that it does not contend for the
 * writer lock, so a diagnostic about it that took the lock would be reporting on a
 * property it had just broken. It speaks HTTP to `127.0.0.1:<port>/healthz` and prints
 * what it hears.
 *
 * Exit `0` when the receiver answered, `3` when it did not — the same code every other
 * verb uses for "ran fine; what it found is bad news" — so a cron leg can alert on a
 * dead receiver without parsing anything. `1` stays reserved for a mistyped command
 * line, because "you typed it wrong" and "the receiver is down" are different problems
 * and a script must be able to tell them apart.
 */
async function cmdOtel(ctx: Ctx): Promise<number> {
  const p = ctx.parsed;
  const dump = flagString(p, "dump");
  const status = flagBool(p, "status") || dump === null;
  if (dump !== null && flagBool(p, "status")) {
    throw new UsageError("est otel: --status and --dump are separate actions; run one at a time");
  }
  const portFlag = flagString(p, "port");
  if (portFlag !== null && !/^\d+$/.test(portFlag)) {
    throw new UsageError(`est otel: --port must be a number, got: ${portFlag}`);
  }
  const port = otelPort(process.env, portFlag === null ? null : Number(portFlag));

  if (!status) {
    const seconds = Number(dump);
    const r = await otelDump(port, seconds);
    if (ctx.json) ctx.out(JSON.stringify(r));
    else if (!ctx.quiet) ctx.out(renderOtelDump(r));
    return r.ok ? 0 : 3;
  }

  const s = await otelStatus(port);
  if (ctx.json) ctx.out(JSON.stringify(s));
  else if (!ctx.quiet) ctx.out(renderOtelStatus(s));
  return s.reachable ? 0 : 3;
}

async function cmdRecon(ctx: Ctx): Promise<number> {
  const p = ctx.parsed;
  const dryRun = flagBool(p, "dry-run");
  const certify = flagBool(p, "certify");
  if (dryRun && certify) {
    throw new UsageError(
      "est recon: --certify writes config.unvalidated_retired_at, so it cannot be combined with --dry-run; " +
        "run `est recon --dry-run` to see the axes, then `est recon --certify` to act on them",
    );
  }
  const axes = flagString(p, "source");
  const wanted =
    axes === null
      ? undefined
      : (axes
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a !== "") as ReconAxis[]);
  if (wanted !== undefined) {
    const legal: readonly string[] = ["usd", "tokens", "active_s", "requests"];
    for (const a of wanted) {
      if (!legal.includes(a)) {
        throw new UsageError(`est recon: unknown --source axis: ${a} (expected ${legal.join(" | ")})`);
      }
    }
  }
  const windowSpec = flagString(p, "window");

  const emit = (report: ReturnType<typeof computeRecon>): number => {
    const alerting = report.axes.some((a) => a.alert);
    if (ctx.json) ctx.out(JSON.stringify({ schema: 1, ...report }));
    else if (!ctx.quiet) ctx.out(renderRecon(report));
    // Exit 3 is "completed, but alerting anomalies were recorded" — the same code the
    // sweep uses, so one cron leg can treat both the same way.
    return alerting ? 3 : 0;
  };

  if (dryRun) {
    const db = openDb({ path: ctx.dbPath, readonly: true });
    try {
      const report = computeRecon(db, { window: windowSpec, axes: wanted });
      report.certification = evaluateCertification(db, { apply: false });
      return emit(report);
    } finally {
      db.close();
    }
  }

  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const report = computeRecon(db, { window: windowSpec, axes: wanted });
        const sweptAt = report.as_of;
        db.transaction(() => {
          writeRecon(db, report);
          insertAnomalies(db, report.anomalies, sweptAt);
          // Certification is evaluated on EVERY run, not only with --certify: writing
          // the key needs the flag, but CLEARING it does not. Retirement is rolling,
          // and a marker that could only ever be removed by the command that granted it
          // would be a validation that cannot expire.
          report.certification = evaluateCertification(db, { apply: true, now: new Date() });
          if (!certify && report.certification.granted) {
            // Without --certify this run must not GRANT retirement; undo the write and
            // report that the criterion is met and awaiting the explicit command.
            //
            // The guard is `granted` — the flag evaluateCertification sets ONLY in its
            // INSERT branch — and never `retired_at !== null`: the latter is also true
            // of a retirement an earlier `--certify` legitimately made, so keying off it
            // made the weekly cron's plain `est recon` revoke the marker it had just
            // certified, on a week where nothing breached.
            db.query("DELETE FROM config WHERE k = 'unvalidated_retired_at'").run();
            report.certification.retired_at = null;
            report.certification.granted = false;
            report.certification.reason += " — run `est recon --certify` to retire the marker";
          }
        }).immediate();
        report.wrote = true;
        return emit(report);
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("recon") },
  );
}

/**
 * `est segments` — the check-back tuning surface (P2.1).
 *
 * Read-only; never writes, never locks, exits `0` always, INCLUDING no segments. The
 * measured p50 moves ~10× across plausible `segment_gap_min` values, which is exactly
 * why `--gap` exists: it recomputes the whole partition at another threshold and
 * persists nothing, so the knob's effect is visible before anyone turns it.
 */
function cmdSegments(ctx: Ctx): number {
  const p = ctx.parsed;
  const gapRaw = flagString(p, "gap");
  let gap: number | null = null;
  if (gapRaw !== null) {
    const n = Number(gapRaw);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--gap: expected a positive number of minutes, got "${gapRaw}"`);
    gap = n;
  }
  const sinceRaw = flagString(p, "since");
  if (sinceRaw !== null && !Number.isFinite(Date.parse(sinceRaw))) {
    throw new UsageError(`--since: expected an ISO instant, got "${sinceRaw}"`);
  }
  const db = openDb({ path: ctx.dbPath, readonly: true });
  try {
    const report = segmentsReport(db, {
      session: flagString(p, "session"),
      gap,
      since: sinceRaw,
      limit: flagInt(p, "limit", 50),
      now: new Date(),
    });
    if (ctx.json) ctx.out(JSON.stringify(report));
    else if (!ctx.quiet) ctx.out(renderSegments(report));
    return 0;
  } finally {
    db.close();
  }
}

function renderSegments(r: SegmentsReport): string {
  const mins = (s: number | null): string => (s === null ? "—" : `${Math.round(s / 60)}m`);
  const lines = [
    `est segments  gap ${r.gap_min}m${r.recomputed ? "  [RECOMPUTED — nothing persisted]" : ""}  ·  ` +
      `${r.n} segment(s)${r.n > r.segments.length ? `, newest ${r.segments.length} shown` : ""}`,
  ];
  if (r.segments.length === 0) {
    lines.push(
      "  (none — a session with no turn_duration records and no OTEL durations contributes no intervals, which is the hole the receiver fills, not a bug here)",
    );
    return lines.join("\n");
  }
  lines.push(
    renderTable(
      ["started", "active", "busy", "maxc", "turns", "agents", "gap before", "gap after", "terminator", "src", "tid"],
      r.segments.map((s) => [
        s.started_at.replace("T", " ").slice(0, 16),
        mins(s.active_s),
        mins(s.busy_s),
        String(s.max_concurrency),
        String(s.n_turns),
        String(s.n_agents),
        mins(s.gap_before_s),
        mins(s.gap_after_s),
        s.terminator,
        s.interval_src_mix ?? "—",
        s.tid === null ? "—" : s.tid.slice(0, 8),
      ]),
    ).replace(/^/gm, "  "),
  );
  lines.push(
    "",
    "terminator: human_input = the boundary the check-back forecast aims at · compaction = /compact ended the session ·",
    "            session_end = nothing later and no live pid · open = still running (the only kind a forecast is issued against)",
    "gap after is RECORDED, never predicted: the human-availability model is descoped, not deferred (§7.3 clock 3).",
  );
  return lines.join("\n");
}

/**
 * `est audit` — P2.12's five checks over the ledger, made repeatable.
 *
 * Read-only by default and read-only in the overwhelming majority of runs: the report
 * is the product. `--fix` is bounded by the doctrine, not by judgement — it deletes
 * only from the five derived/ledger tables `src/audit.ts` names, records each removal
 * as `anomaly('audit_removed')` carrying the deleted row verbatim, and REFUSES the
 * append-only spine at exit `2` rather than silently doing less than it was asked.
 *
 * **Exit codes carry the whole result, because a cron leg reads them and not stdout:**
 * `0` clean · `1` usage · `2` `--fix` refused on the append-only spine · `3` findings
 * reported · `4` lock busy. `3` is the one that alerts; `0` means every row in the
 * database traces to the corpus.
 */
async function cmdAudit(ctx: Ctx): Promise<number> {
  const root = flagString(ctx.parsed, "root") ?? PROJECTS_ROOT;
  const fix = flagBool(ctx.parsed, "fix");
  const now = new Date();

  const emit = (report: AuditReport): number => {
    if (ctx.json) ctx.out(JSON.stringify({ schema: 1, ...report }));
    else if (!ctx.quiet) ctx.out(renderAudit(report));
    if (report.spine_refused) return 2;
    return report.findings.length > 0 ? 3 : 0;
  };

  if (!fix) {
    // No lock and no writable handle: an audit that could write is an audit that could
    // be the thing a later audit finds.
    const db = openDb({ path: ctx.dbPath, readonly: true });
    try {
      return emit(auditReport(db, { root, now }));
    } finally {
      db.close();
    }
  }

  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        const report = auditReport(db, { root, now });
        report.fixed = true;
        // The refusal is evaluated on the report, BEFORE anything is deleted, but it
        // does not cancel the bounded cleanup: the spine rows were never candidates,
        // and refusing to tidy the ledger because a spine row also needs attention
        // would leave both problems standing. The exit code still says `2`.
        report.spine_refused = report.findings.some((f) => f.spine);
        db.transaction(() => {
          report.removed = applyFix(db, report, isoNow(now));
        }).immediate();
        return emit(report);
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 10_000, note: lockNote("audit") },
  );
}

async function cmdRetro(ctx: Ctx): Promise<number> {
  const p = ctx.parsed;
  const dryRun = flagBool(p, "dry-run");
  const asOfRaw = flagString(p, "as-of");
  let asOf: Date | undefined;
  if (asOfRaw !== null) {
    const t = Date.parse(asOfRaw);
    if (!Number.isFinite(t)) throw new UsageError(`--as-of: expected an ISO instant, got "${asOfRaw}"`);
    asOf = new Date(t);
  }
  const emit = (r: RetroReport): number => {
    if (ctx.json) ctx.out(JSON.stringify({ schema: 1, ...r }));
    else if (!ctx.quiet) ctx.out(renderRetro(r));
    return r.alerts.length > 0 ? 3 : 0;
  };

  // `--dry-run` is read-only by contract, so it takes no lock — and therefore must not
  // open a connection that could migrate: `readonly: true` makes both true at once.
  if (dryRun) {
    const db = openDb({ path: ctx.dbPath, readonly: true });
    try {
      return emit(retro(db, { asOf, dryRun: true }));
    } finally {
      db.close();
    }
  }
  // The writing path opens INSIDE the lock (see `cmdOpen`): `openDb()` migrates a
  // stale `schema_version` on sight, and a migration is a write.
  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        return emit(retro(db, { asOf, dryRun: false }));
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 30_000, note: lockNote("retro") },
  );
}

/**
 * `est repair-identity` — give estimates whose EFFECTIVE estimator family is still the
 * repairable `'unknown'` sentinel a concrete one, WITHOUT touching a ledger row.
 *
 * **Dry run is the default.** `--apply` is required to write, because this verb writes
 * into the calibration key and the honest response to "did it propose the right thing?"
 * is to look first. It is also what the land step runs: dry run, eyeball the proposal
 * list, then apply.
 *
 * Nothing here can restate an estimate: the correction is one INSERT into
 * `estimate_identity_repair`, which carries the same `RAISE(ABORT,'append-only')` pair
 * every other evidence table carries. `SELECT estimator_model FROM estimate` is
 * unchanged afterwards, and that is the property to check.
 */
async function cmdRepairIdentity(ctx: Ctx): Promise<number> {
  const p = ctx.parsed;
  const apply = flagBool(p, "apply");
  if (apply && flagBool(p, "dry-run")) {
    throw new UsageError("est repair-identity: --apply and --dry-run are mutually exclusive");
  }

  const emit = (r: RepairReport): number => {
    if (ctx.json) {
      // `dry_run`, not `applied`: `RepairReport.applied` is the COUNT of rows written,
      // and two fields one letter apart meaning different things is how a consumer
      // reads "1" as "yes" forever.
      ctx.out(JSON.stringify({ schema: 1, dry_run: !apply, ...r }));
      return 0;
    }
    if (ctx.quiet) return 0;
    const lines: string[] = [
      `est repair-identity${apply ? "" : "  [DRY RUN — nothing written; --apply to write]"}`,
      `candidates: ${r.candidates} estimate(s) whose effective estimator family is 'unknown'`,
    ];
    for (const q of r.proposals) {
      lines.push(
        `  eid ${q.eid}  ${q.from} -> ${q.to}  method=${q.method}`,
        `    evidence: main_requests=${q.evidence.n_main} families=[${q.evidence.families.join(", ")}] n_families=${q.evidence.families.length}`,
      );
    }
    if (r.ambiguous > 0) {
      lines.push(
        `  ${r.ambiguous} refused as AMBIGUOUS (the window examined spans more than one main-chain family) — left 'unknown', which is the correct answer, not a failure`,
      );
    }
    if (r.pending > 0) {
      lines.push(
        `  ${r.pending} still PENDING (no origin='main' request ingested for that anchor yet) — retried on the next sweep`,
      );
    }
    if (r.proposals.length === 0 && r.ambiguous === 0 && r.pending === 0) {
      lines.push("  nothing to repair");
    }
    ctx.out(lines.join("\n"));
    return 0;
  };

  if (!apply) {
    const db = openDb({ path: ctx.dbPath, readonly: true });
    try {
      return emit(repairEstimatorIdentity(db, { apply: false }));
    } finally {
      db.close();
    }
  }
  return await withLock(
    (): number => {
      const db = openDb({ path: ctx.dbPath });
      try {
        let r: RepairReport = { candidates: 0, proposals: [], applied: 0, ambiguous: 0, pending: 0 };
        db.transaction(() => {
          r = repairEstimatorIdentity(db, { apply: true });
        }).immediate();
        return emit(r);
      } finally {
        db.close();
      }
    },
    { path: ctx.lockPath, timeoutMs: 30_000, note: lockNote("repair-identity") },
  );
}

function pct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

function renderRetro(r: RetroReport): string {
  const q = r.quality;
  const s = r.scoring;
  const lines: string[] = [
    `est retro ${r.as_of}${r.dry_run ? "  [DRY RUN — nothing written]" : ""}  ·  unit: ${r.estimand} / ${r.ref_model}`,
    "",
    // The headline, not a line in the panel: this is the number that licenses
    // calibration at all, until the live G-ATTR re-gate clears 70% (§7.4 R4 (i)).
    `ATTRIBUTION COVERAGE  ${pct(q.coverage_tracked)} over tracked sessions (${pct(q.coverage_all)} corpus-wide)  ·  gate 70%`,
    `  ambiguous ${pct(q.ambiguous_share)} · pre_task ${pct(q.pre_task_share)} · closed by staleness ${pct(q.stale_closed_share)}`,
    "",
    `calibration   n=${s.n_scored} scored outcome(s)`,
  ];
  if (s.n_scored === 0) {
    lines.push("  (nothing to calibrate yet — velocity needs completed, uncensored, fully-priced tasks)");
  } else {
    lines.push(
      `  pinball p50 ${s.pinball_p50?.toFixed(0) ?? "n/a"} · p90 ${s.pinball_p90?.toFixed(0) ?? "n/a"} · log-score ${s.log_score?.toFixed(2) ?? "n/a"}`,
      `  coverage p50 ${pct(s.coverage_p50)} (target 50%) · p90 ${pct(s.coverage_p90)} (target 90%), Jeffreys [${pct(s.cov_lo)}–${pct(s.cov_hi)}]`,
      `  refinements n=${s.refinement.n}, pinball ${s.refinement.pinball_p50?.toFixed(0) ?? "n/a"}, moved toward actual ${pct(s.refinement.moved_toward_actual_pct)} — scored BESIDE the baseline, never blended into it`,
      `  blocks vs task: ${s.blocks.verdict} (rollup ${s.blocks.rollup_pinball_p50?.toFixed(0) ?? "n/a"} vs task ${s.blocks.task_pinball_p50?.toFixed(0) ?? "n/a"} over ${s.blocks.n_tasks} task(s))`,
      `  origin: velocity main ${s.origin.velocity_main?.toFixed(2) ?? "n/a"}× · sub ${s.origin.velocity_sub?.toFixed(2) ?? "n/a"}× · ` +
        `exp_agents residual ${s.origin.exp_agents_residual?.toFixed(1) ?? "n/a"} · parallelism ${s.origin.parallelism_p50?.toFixed(2) ?? "n/a"}×`,
    );
  }
  // Said whichever branch ran, INCLUDING the n=0 one: "nothing to calibrate yet" and
  // "the comparison is undefined" are different sentences, and a points cold start
  // produces the second while looking exactly like the first.
  {
    const u = s.unscorable;
    if (u.baseline + u.refinement + u.block_tasks + u.blocks > 0) {
      lines.push(
        `  UNDEFINED, not missing: ${u.baseline} baseline · ${u.refinement} refinement · ${u.block_tasks} block-task · ` +
          `${u.blocks} per-block comparison(s) refused — band in story points, actual in Work-CET, no rate applied at open`,
      );
    }
  }
  lines.push("");
  if (r.buckets.length > 0) {
    lines.push("multipliers in force after this retro");
    lines.push(
      renderTable(
        ["bucket", "estimator", "n", "n_eff", "×p50", "×p90", "shrink_w", "method"],
        r.buckets.map((b) => [
          b.bucket,
          b.estimator_family,
          String(b.n),
          b.n_eff.toFixed(1),
          b.mult_p50.toFixed(2),
          b.mult_p90.toFixed(2),
          b.shrink_w.toFixed(2),
          b.method,
        ]),
      ).replace(/^/gm, "  "),
    );
    lines.push("");
  }
  lines.push(
    "data quality",
    `  compliance_t1t2 ${pct(q.compliance_t1t2)} (EXACT, and T1/T2 only — an upper bound on true compliance)`,
    `  t3_candidates ${q.t3_candidates} — an UPPER BOUND on T3 misses, never a gate input.  ${q.t4_note}`,
    `  scope declared ${pct(q.scope_declared_pct)} · identity planted ${pct(q.identity_planted_pct)} · overhead ${pct(q.overhead_share)}`,
    // The gate bypasses, reported every retro whether or not they fired. A lever that
    // decides what enters the calibration corpus has to be self-reporting: a climbing
    // share is evidence about the QUIESCENCE gate (it is finalizing less of the corpus
    // on its own), which is exactly the kind of drift nobody goes looking for.
    `  closes not made by a human at a quiet task: ${pct(q.bypass_share)} of closed tasks — ${q.accepted_closes} on recorded human consent (--accept), ${q.forced_closes} forced, ${q.swept_closes} swept on a completion signal, ${q.swept_abandons} swept as ABANDONED`,
    // The abandoned SHARE is DECISIONS §12's own re-open trigger, so it is printed as a
    // share rather than left to be divided by eye: past roughly half, the finding is
    // about the harness's terminal `task_event` not reaching the tasks it should, not
    // about any one close.
    `    of the swept ones, ${pct(q.swept_closes + q.swept_abandons > 0 ? q.swept_abandons / (q.swept_closes + q.swept_abandons) : null)} were abandoned (right-censored: a lower bound, never a measurement)`,
    `  unpriced ${pct(q.unpriced_share)} · provisional ${pct(q.provisional_share)} · cross-epoch tasks ${q.cross_epoch_tasks}`,
    `  fork replays ${q.fork_replays} · sidechain replays ${q.sidechain_replays} · compactions ${q.compactions} · spawn_depth>1 ${q.spawn_depth_gt1}`,
    `  dangling agents ${q.dangling_agents} · phase-unmapped ${q.phase_unmapped_agents} · unlabelled workflow agents ${q.unlabeled_wf_agents}`,
    `  workflowProgress completeness ${pct(q.wf_progress_completeness)} over COMPLETED runs (${q.wf_in_flight_agents} agent(s) in flight, counted separately)`,
    `  block-estimate completeness: ${q.block_complete_tasks} complete / ${q.block_incomplete_tasks} incomplete`,
    `  censored outcomes ${q.censored_outcomes} · corpus_shrink events ${q.corpus_shrink_events} (§5.8 expects ZERO)`,
  );
  if (q.recon.length === 0) {
    lines.push("  reconciliation: none — `est recon` is Phase 2 (§7.5), so every number above is OURS and unvalidated");
  } else {
    for (const rec of q.recon) lines.push(`  reconciliation ${rec.as_of} ${rec.source}: ${rec.delta_pct.toFixed(1)}%`);
  }
  if (r.splits.length > 0) {
    lines.push("", "candidate bucket splits (RECORDED, never auto-applied)");
    for (const sp of r.splits) {
      lines.push(`  ${sp.dimension}=${sp.level} n=${sp.n} pinball delta ${(sp.pinball_delta * 100).toFixed(1)}%`);
    }
  }
  if (r.jobs_reconcile.length === 0) {
    lines.push("", "jobs reconcile: no bound job — either none exist, or none are aliased to a tracked task yet");
  } else {
    lines.push("", "jobs reconcile (§P2.9 — reported, never corrected)");
    for (const j of r.jobs_reconcile) {
      const span = j.jobs_span_s === null ? "open" : `${j.jobs_span_s}s`;
      const ours = j.our_active_s === null ? "n/a" : `${j.our_active_s}s`;
      const delta = j.delta_span_s === null ? "" : ` · delta ${j.delta_span_s}s`;
      lines.push(`  ${j.job_id} -> ${j.tid}: jobs span ${span} vs our active ${ours}${delta}`);
    }
  }
  if (r.alerts.length > 0) lines.push("", `ALERTS: ${r.alerts.join(" · ")}`);
  if (!r.dry_run) {
    lines.push("", `written: ${r.written.refclass} refclass snapshot(s), ${r.written.calib_run} calib_run row`);
  }
  return lines.join("\n");
}

export const HELP = `est — token-based task estimation and tracking for Claude Code (Phase 0 + Phase 1)

usage: est <command> [flags]

commands:
  init                    create/verify ~/.claude/estimator and the database (idempotent)
  sweep                   incremental single-writer sweep of the transcript corpus
  backfill                full re-sweep over every surviving transcript, plus a spend report
  prices                  model price table: --sync, --show, --set
  census                  sweep_census history, corpus counts and the anomaly ledger
  config                  read/tune the calibration constants: list, get <k>, set <k> <v>
  refclass                the reference class — run this BEFORE stating any number
  open                    mint or re-estimate a task; prints the calibrated band
  block                   one estimate per declared workflow phase, before the launch
  bind                    attach a session / task number / run / agent to a tid
  scope                   append a scope revision (the scope_change precondition)
  burn                    consumption against the band (--json is the statusline contract)
  close                   finalize by arithmetic
  board                   terminal/JSON read model, or --html/--md to render board.html/board.md
  recon                   reconcile our numbers against Anthropic's, and certify [unvalidated]
  segments                run segments — the check-back corpus, and the gap knob that cuts it
  audit                   the five P2.12 checks over the ledger; --fix is bounded, never the spine
  retro                   weekly calibration + refclass write-back
  repair-identity         resolve estimates still filed under the 'unknown' estimator
  anchor                  the story-point anchor registry: list, or define <id> "<text>"
  help, version

global flags:
  --db <path>             database file (default: $EST_DB or <estimator-data>/estimator.db)
  --lock <path>           writer lock file (default: $EST_LOCK or <estimator-data>/sweep.lock).
                          One lock per database; a second corpus needs a second lock.
  -q, --quiet             suppress the human summary (hooks)
  --json                  machine-readable output
  -h, --help              this text

sweep / backfill:
  --blocking              wait for the sweep lock instead of stepping aside (SessionEnd hook)
  --budget <dur>          wall-clock budget, e.g. 20s. On expiry the sweep COMMITS what it has
                          and logs anomaly(sweep_budget_exceeded); the next sweep finishes.
  --root <path>           corpus root (default: $EST_PROJECTS or ~/.claude/projects)
  --chunk <n>             sessions per write transaction (default 25)
  --strict                exit non-zero for ANY new anomaly, not just alerting ones
  --top <n>               (backfill) rows per summary table

prices:
  --sync                  refresh from LiteLLM (primary) / models.dev (secondary) / snapshots
  --source auto|live|fixture
  --show [--at <iso>]     the rate in force per family, at that vintage (default: now)
  --set <model> --in <usd> --out <usd> --cw <usd> --cr <usd>   manual override, USD per Mtok
  --at <iso>              (with --set) the vintage the rate takes effect FROM — this is how
                          you answer backfill's "pre-epoch" line and price old requests.
                          Omitted: a family's first-ever rate covers all history, a later
                          one takes effect now.

census:
  --limit <n>             sweep_census rows to show (default 10)
  --root <path>

recon (P2.6 — our number vs an ANTHROPIC-computed one, on four independent axes):
  --window 7d | <iso>/<iso>   default: the last 7 days
  --source <axis>[,<axis>]    usd | tokens | active_s | requests (default: all four)
  --certify                   evaluate the retirement criterion and, if met, retire
                              [unvalidated]. Retirement is ROLLING: any later week that
                              breaches the delta OR the join floor clears it again.
  --dry-run                   compute and print; write nothing, take no lock

config (the calibration constants — §1.1 keeps every tunable in the DB, not in code):
  list, (no args)         list every key and value
  get <key>               the value alone on stdout, so it substitutes into a shell var
  set <key> <value>       tune a SEEDED key; an unknown key and schema_version are refused
                          The key set is CLOSED: an unknown or protected key exits 2, so a
                          typo'd key is distinguishable from a malformed command line (1).

refclass (read-only, takes no lock, ALWAYS exits 0 — an empty class is a valid answer):
  --text "<subject>"      what the work is about (FTS5 over completed tasks)
  --kind <k> --limit <n>
  --fanout <n>            comparable agent fan-out: a TOLERANCE band (half to double,
                          minimum ±2), not equality. If nothing in the corpus ran at a
                          comparable fan-out the unfiltered class is shown and says so.
  --session <sid> --prompt <pid>
                          the anchor. Pass the SAME pair you will pass to est open, so
                          the calibration shown here is the one the band is stamped with.
  --full                  write the unbudgeted form to spool/ and print its path

repair-identity (the append-only correction path for the estimator identity):
  (no flags)              DRY RUN — print what would be corrected, write nothing
  --apply                 append one estimate_identity_repair row per proposal. Never
                          touches the estimate row; only ever changes an EFFECTIVE 'unknown'.
                          The sweep runs this automatically; the verb is for the land
                          step and for looking before writing.

open:
  --kind <research|design|implement|refactor|debug|review|ops>
  --subject <t> [--description <t>] [--dod <json|@file>]
  --raw-p50 <n> --raw-p90 <n>        the band; your uncorrected guess, never pre-corrected.
                          UNIT = config.estimand. Under 'work_cet' (etc.) these are Work-CET
                          tokens. Under 'story_point' they are whole POINTS in
                          [1, config.sp_max_points], relative to config.sp_anchor_text —
                          a Work-CET-scale number typed under story points is REFUSED (exit 1),
                          because the estimate table is append-only and could never be corrected.
  --exp-agents <n> --exp-wf-phases <n> --exp-files-write <n> --exp-turns <n> --exp-requests <n>
  [--tid <tid> --reason refinement|scope_change|recalibration]   append a re-estimate
  [--from-blocks]         with --tid: take the band from SUM(this task's block estimates)
                          instead of --raw-p50/--raw-p90, which must then be omitted.
                          A REFINEMENT lever — it requires --tid, so it can only ever be
                          a re-estimate, and est close scores the FIRST estimate. Use it
                          when you re-sized the phases mid-task, not to open.
                          FOR DECOMPOSED WORK, OPEN WITH THE SUM: size each phase, add
                          them up, est open ONCE with that total, then est block per
                          phase. The decomposition IS the estimate, and it has to be the
                          FIRST one or the coarse guess stays the scored baseline (and
                          the sample velocity_raw is fitted from).
  [--session <sid>] [--prompt <promptId>]
  --continue <tid>        sugar: bind this session and append a refinement

block <tid>:
  --phase <i>             0-BASED — the phases[] index, NOT workflowProgress.phaseIndex
  --title <t> --p50 <n> --p90 <n> [--exp-agents <n>] [--model <m>]
                          Same unit and same bound as est open — blocks roll UP into the
                          task band, so they are denominated in whatever it is. Run AFTER
                          est open, with the SAME sizes you summed to produce its band:
                          this records the decomposition for per-phase attribution, it
                          does not replace the task band. Every block prints the roll-up
                          so far, which should converge on the band already issued.

bind <tid>:               [--session <sid>] [--task <n>] [--run <runId>] [--agent <agentId>]
scope <tid>:              --reason <text> [--subject <t>] [--description <t>] [--dod <json|@file>]
burn [<tid>]:             [--session <sid>] [--refresh]      read-only; never writes; always exits 0
close <tid>:              [--status completed|abandoned|deleted|reopened]
                          --accept "<the human's verbatim acceptance>"   closes on
                            recorded consent, bypassing the gate; the ONLY bypass
                            Claude may use, and only when the human has explicitly
                            said the work is done. Records anomaly(accepted_close).
                          [--force]   Craig's own override at a terminal, never
                            Claude's. Records anomaly(forced_close).
board:                    [--status <column>] [--limit <n>]
                          [--html] [--md] [--out <dir>]   P2.7 file renderer — writes
                          board.html/board.md (default dir: alongside the database),
                          untouched by the sweep's throttle since this is explicit
audit (P2.12 — every row in the ledger has to trace to the corpus):
  --root <path>           corpus root the "does this session exist" check reads
  --fix                   delete the untraceable rows from the FIVE derived/ledger
                          tables only (task_event, anomaly, burn_cache, sweep_state,
                          run_segment), recording each removal as
                          anomaly(audit_removed) with the deleted row as JSON.
                          The append-only spine is REPORTED, never fixed: --fix with a
                          spine finding still tidies the ledger and exits 2, because a
                          wrong estimate is corrected by APPENDING a better one.
  exits                   0 clean · 1 usage · 2 spine refused · 3 findings · 4 lock busy

segments:                 [--session <sid>] [--gap <min>] [--since <iso>] [--limit <n>]
                          Read-only, never writes, never locks. --gap RECOMPUTES at a
                          different threshold WITHOUT persisting: that is how
                          segment_gap_min gets fitted by evidence instead of by taste.
retro:                    [--as-of <iso>] [--dry-run]

otel:                     [--status] [--dump <seconds>] [--port <n>]
                          The OTLP receiver, over HTTP — the ONE verb that never opens
                          the database, because the receiver's contract is that it never
                          contends for the writer lock. --status reads /healthz (up?
                          which port? is the spool draining?); --dump arms raw-body
                          parking on the RUNNING receiver for <seconds> (0 turns it off,
                          3600 max) — those bodies contain PROMPT TEXT. Exit 3 when the
                          receiver does not answer, so a cron leg can alert on it.

exit codes: 0 ok (including a well-formed empty result) · 1 usage/fatal ·
            2 REJECTED BY AN INVARIANT (append-only; never retry, never work around) ·
            3 anomalies recorded or budget exceeded · 4 lock held
`;

export interface RunOptions {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/** The whole CLI, minus process exit — importable, so tests drive it directly. */
export async function run(argv: readonly string[], io: RunOptions = {}): Promise<number> {
  const out = io.out ?? ((s: string) => console.log(s));
  const err = io.err ?? ((s: string) => console.error(s));
  const parsed = parseArgs(argv);

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) err(`est: ${e}`);
    err("run `est help` for usage");
    return 1;
  }
  if (flagBool(parsed, "version") || parsed.command === "version") {
    out(`est 0.1.0 (estimator Phase 0 + Phase 1, schema ${SCHEMA_VERSION})`);
    return 0;
  }
  if (parsed.command === null || parsed.command === "help" || flagBool(parsed, "help")) {
    out(HELP);
    return parsed.command === null && !flagBool(parsed, "help") ? 1 : 0;
  }

  const ctx: Ctx = {
    parsed,
    dbPath: flagString(parsed, "db") ?? DB_PATH,
    lockPath: flagString(parsed, "lock") ?? LOCK_PATH,
    quiet: flagBool(parsed, "quiet"),
    json: flagBool(parsed, "json"),
    out,
    err,
  };

  try {
    switch (parsed.command) {
      case "init":
        return await cmdInit(ctx);
      case "sweep":
        return await cmdSweep(ctx, false);
      case "backfill":
        return await cmdSweep(ctx, true);
      case "prices":
        return await cmdPrices(ctx);
      case "census":
        return await cmdCensus(ctx);
      case "config":
        return await verb(ctx, () => cmdConfig(ctx));
      case "anchor":
        return await verb(ctx, () => cmdAnchor(ctx));
      case "refclass":
        return await verb(ctx, () => cmdRefclass(ctx));
      case "open":
        return await verb(ctx, () => cmdOpen(ctx));
      case "block":
        return await verb(ctx, () => cmdBlock(ctx));
      case "bind":
        return await verb(ctx, () => cmdBind(ctx));
      case "scope":
        return await verb(ctx, () => cmdScope(ctx));
      case "burn":
        return await verb(ctx, () => cmdBurn(ctx));
      case "close":
        return await verb(ctx, () => cmdClose(ctx));
      case "board":
        return await verb(ctx, () => cmdBoard(ctx));
      case "recon":
        return await verb(ctx, () => cmdRecon(ctx));
      case "segments":
        return await verb(ctx, () => cmdSegments(ctx));
      case "audit":
        return await verb(ctx, () => cmdAudit(ctx));
      case "otel":
        // NOT wrapped in `verb`: that helper is the database-opening path, and this is
        // the one verb that must never open the database (see `cmdOtel`).
        return await cmdOtel(ctx);
      case "retro":
        return await verb(ctx, () => cmdRetro(ctx));
      case "repair-identity":
        return await verb(ctx, () => cmdRepairIdentity(ctx));
      default:
        out(HELP);
        return 1;
    }
  } catch (e) {
    // §2 loud failures: never a stack trace swallowed into a zero exit.
    err(`est: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}

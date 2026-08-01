-- estimator schema — token-estimation-design-r3.md §4.2 (rev. R3, decisions applied).
-- This file is the ONLY source of DDL. src/db.ts applies it verbatim when
-- config.schema_version is absent; the leading connection PRAGMAs below are
-- applied by the opener OUTSIDE the DDL transaction (journal_mode cannot be
-- changed from inside a transaction) and are repeated here so a manual
--   sqlite3 estimator.db < schema.sql
-- produces an identical database.

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout  = 5000;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;
-- Writers: est CLI (tiny BEGIN IMMEDIATE txns) and the flock-guarded sweeper
-- (ONE transaction per sweep, not per file). Cron: wal_checkpoint(TRUNCATE) weekly.

CREATE TABLE config (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
-- seed: ref_model | estimand='work_cet' | quiesce_main_min='60' | shrink_k='10'
--       velocity_half_life_days='30' | split_min_pinball_gain='0.02'
--       boot_resamples='200' | coverage_prior='jeffreys' | schema_version
--       (the version literal lives in the seed block at the foot of this file and
--        in src/db.ts SCHEMA_VERSION; naming it twice more is how it goes stale)
-- EVERY calibration constant lives here, not in code: none is empirically backed
-- (§1.1), and the retro tunes them by cross-validation from n>=20.

CREATE TABLE model_price (          -- pricing is DATA; dated aliases collapse to family
  family TEXT NOT NULL,             -- model name with trailing -YYYYMMDD stripped at ingest
  effective_from TEXT NOT NULL,
  usd_in REAL NOT NULL, usd_out REAL NOT NULL,
  usd_cw REAL NOT NULL, usd_cr REAL NOT NULL,          -- per Mtok
  provisional INTEGER NOT NULL DEFAULT 0,   -- 1 = inferred from a tier peer, NOT authoritative
  source TEXT NOT NULL,             -- R3: 'litellm' (primary, ccusage's own upstream)
                                    -- | 'models_dev' (secondary) | 'otel' | 'manual'
                                    -- | 'claude-api-skill' | 'model-selection' (now occasional
                                    -- cross-checks only, §4.3)
  synced_epoch TEXT,                -- R3 -> price_sync(price_epoch): which sync wrote this row
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (family, effective_from)
) STRICT, WITHOUT ROWID;

CREATE TABLE price_sync (           -- R3: the DB IS the local price snapshot/cache (§4.3).
                                    -- ccusage keeps no on-disk cache to read [R3]; we keep ours.
  price_epoch TEXT PRIMARY KEY,     -- ISO ts of a successful sync; estimate.price_epoch names one
  synced_at TEXT NOT NULL,
  source TEXT NOT NULL,             -- 'litellm'|'models_dev'|'manual'|'otel'
  url TEXT, etag TEXT,
  n_families INTEGER NOT NULL,
  n_provisional INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1     -- 0 = fetch failed; the last good snapshot stays in force
) STRICT, WITHOUT ROWID;

CREATE TABLE task (
  tid TEXT PRIMARY KEY,             -- uuidv7 minted by `est open`
  kind TEXT NOT NULL CHECK (kind IN
    ('research','design','implement','refactor','debug','review','ops')),
  status TEXT NOT NULL CHECK (status IN
    ('estimating','in_progress','pending_verification','completed','abandoned','deleted')),
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
  anchor_session TEXT NOT NULL,
  anchor_prompt TEXT NOT NULL       -- turn where work began: planning spend is INSIDE the window
  -- NOTE (R2): subject/description/scope_hash MOVED to task_scope. A mutable scope column
  -- cannot answer "what was the scope when the baseline estimate was issued", which is the
  -- baseline all accuracy is judged against. Current scope = v_scope_current.
) STRICT;

CREATE TABLE task_scope (           -- APPEND-ONLY scope history (REQ-4 'otherwise modified')
  tid TEXT NOT NULL REFERENCES task(tid),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  subject TEXT NOT NULL, description TEXT,
  dod_json TEXT NOT NULL DEFAULT '[]',
  scope_hash TEXT NOT NULL,         -- sha256(subject||description||dod_json)
  source TEXT NOT NULL CHECK (source IN
    ('est_open','est_scope','sweeper_diff','transcript','classifier')),
  reason TEXT,                      -- free text from `est scope --reason`
  diff_summary TEXT,                -- unified-diff summary vs seq-1; NULL at seq=1
  PRIMARY KEY (tid, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER scope_ro_u BEFORE UPDATE ON task_scope BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER scope_ro_d BEFORE DELETE ON task_scope BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE task_alias (           -- many harness ids -> one logical task
  tid TEXT NOT NULL REFERENCES task(tid),
  id_kind TEXT NOT NULL CHECK (id_kind IN
    ('session_task','session','workflow_run','agent','job')),
  session_id TEXT NOT NULL, local_id TEXT NOT NULL, first_seen TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sweeper',   -- 'task_metadata'|'est_bind'|'sweeper'
  -- `tid` is IN the key (v6) because a SESSION HOSTS MANY TASKS. One `est open`
  -- per piece of work, sequentially or overlapping, is the ordinary case, and
  -- §5.4's staleness closure exists precisely to tell those tasks apart. Without
  -- `tid` here, ('session', S, S) was unique: the second `est open` in a session
  -- wrote NO alias at all (the mint path upserts DO NOTHING), so it was invisible
  -- to attribution and its spend booked to the FIRST task's actual.
  PRIMARY KEY (id_kind, session_id, local_id, tid)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_alias_tid ON task_alias(tid);
-- The PK starts with id_kind, so a lookup BY SESSION could not use it and scanned the
-- whole table — on the statusline's target-resolution path, at a >= 5 s cadence.
CREATE INDEX ix_alias_session ON task_alias(session_id);
-- Every OTHER identity is exclusive: one agent, one workflow run, one Task-tool
-- number is exactly one task's, and two tasks claiming it would split a single
-- stream of spend across two actuals with no way to tell which is right. Enforced
-- physically, so `est bind`'s guard (P1.3) is a better error message rather than
-- the only thing standing between the corpus and a re-pointed alias.
CREATE UNIQUE INDEX ux_alias_exclusive ON task_alias(id_kind, session_id, local_id)
  WHERE id_kind <> 'session';

CREATE TABLE bucket_def (           -- buckets are DEFINED, not free text (R2)
  bucket TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  dims_json TEXT NOT NULL,          -- {} for global; e.g. {"kind":"implement","fanout":"2-5"}
  parent_bucket TEXT REFERENCES bucket_def(bucket),   -- split lineage
  split_pinball_gain REAL,          -- CV loss reduction that justified the split; NULL for global
  active INTEGER NOT NULL DEFAULT 1
) STRICT;
-- seed: ('global', now, '{}', NULL, NULL, 1)

CREATE TABLE estimate (             -- APPEND-ONLY, physically enforced
  eid INTEGER PRIMARY KEY,
  tid TEXT NOT NULL REFERENCES task(tid),
  version INTEGER NOT NULL, created_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN
    ('initial','refinement','scope_change','recalibration')),
  scope_seq INTEGER NOT NULL,       -- WHICH scope this band was issued against (R2)
  -- CET quantiles are non-negative token quantities; see request's counter CHECKs.
  raw_p50_wcet INTEGER NOT NULL CHECK (raw_p50_wcet >= 0),       -- a feature, a floor
  raw_p90_wcet INTEGER NOT NULL CHECK (raw_p90_wcet >= 0),
  exp_agents INTEGER NOT NULL, exp_wf_phases INTEGER NOT NULL,
  exp_files_write INTEGER NOT NULL, exp_turns INTEGER NOT NULL,
  exp_requests INTEGER NOT NULL,
  bucket TEXT NOT NULL REFERENCES bucket_def(bucket),
  bucket_n INTEGER NOT NULL,
  refclass_as_of TEXT,              -- WHICH refclass snapshot issued the multipliers (R2);
                                    -- NULL only for uncalibrated cold-start bands
  shrink_w REAL NOT NULL,           -- n/(n+k) actually applied; 0 = uncalibrated cold start
  cal_p50_wcet INTEGER NOT NULL CHECK (cal_p50_wcet >= 0),       -- what Craig is shown
  cal_p90_wcet INTEGER NOT NULL CHECK (cal_p90_wcet >= 0),
  cal_req_p50 INTEGER CHECK (cal_req_p50 IS NULL OR cal_req_p50 >= 0),
  cal_req_p90 INTEGER CHECK (cal_req_p90 IS NULL OR cal_req_p90 >= 0),
  active_p50_s INTEGER, active_p90_s INTEGER,  -- driver-conditioned quantiles, NOT token-derived
  active_model TEXT,                -- 'baseline_req'|'fanout_cond' — which §7.3 model produced them
  price_epoch TEXT NOT NULL,        -- estimate and its actual computed under ONE price vintage;
                                    -- R3: names the price_sync snapshot in force at `est open`
  -- The UNIT this band is denominated in, snapshotted at `est open` alongside the
  -- vintage. price_epoch alone pins the RATES but not the DEFINITION of a CET:
  -- config.ref_model is the normaliser's family and config.estimand chooses which
  -- counters are summed ('out' | 'work_cet' | 'out_cw_in', §4.1) — or, since v15,
  -- names 'story_point', under which the BAND is relative (points against a fixed
  -- anchor) while the ACTUAL is still Work-CET (out+cw). Either can be
  -- changed with `est config set` at any time, and a band issued in
  -- sonnet-4-5-output-equivalents is simply not comparable to one issued in
  -- opus-5-output-equivalents. Without these two columns a config flip would mix
  -- currencies inside the SAME reference class, silently, forever.
  -- v_velocity therefore MUST compare like with like: group/filter on
  -- (ref_model, estimand) — a row with a different pair is a different unit, not
  -- an outlier, and blending them corrupts the multipliers rather than widening them.
  ref_model TEXT NOT NULL,          -- config.ref_model as of `est open`
  estimand TEXT NOT NULL,           -- config.estimand as of `est open`
  -- v15 `sp_anchor_id`: WHICH story-point anchor's scale this band is denominated in
  -- (config.sp_anchor_id / config.sp_anchor_text as of `est open`). A points value is
  -- meaningless without it — "8 points" says nothing unless you know what 1 point was
  -- defined to be — so it is pinned exactly like price_epoch / ref_model / estimand,
  -- and for the identical reason: re-wording the anchor redefines the unit, and an
  -- unpinned anchor would silently redenominate every historical band the moment
  -- Craig edited one sentence. NULL for every Work-CET band (no anchor is involved)
  -- and for every row issued before v15; a consumer that needs the anchor must treat
  -- NULL as "not a points band", never as "the current anchor".
  --
  -- LAYOUT NOTE: `sp_anchor_id` shares its line with `estimator_model` because that is
  -- byte-for-byte what `ALTER TABLE estimate ADD COLUMN sp_anchor_id TEXT` leaves in
  -- `sqlite_master` — SQLite splices the new column in after the LAST column
  -- definition and before its trailing comment. `estimate` cannot be rebuilt (four
  -- tables reference it and the append-only triggers guard every row), so the v14 ->
  -- v15 step is an ADD COLUMN, and `test/schema.test.ts` asserts a migrated file is
  -- byte-identical to a fresh one. Moving this to its own line breaks that test.
  estimator_model TEXT NOT NULL, sp_anchor_id TEXT,    -- velocity history is keyed by this (model churn decay)
  UNIQUE (tid, version),
  FOREIGN KEY (tid, scope_seq) REFERENCES task_scope(tid, seq)
) STRICT;
CREATE TRIGGER est_ro_u BEFORE UPDATE ON estimate BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER est_ro_d BEFORE DELETE ON estimate BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE estimate_block (       -- R3: per-block (per-phase) workflow estimates, APPEND-ONLY.
                                    -- One row per declared meta.phases entry, written at
                                    -- script-authoring time BEFORE the launch (§3.2).
                                    -- Rolls UP to the task band; never replaces it.
  eid INTEGER NOT NULL REFERENCES estimate(eid),
  phase_idx INTEGER NOT NULL,       -- the declared meta.phases index == workflowProgress.phaseIndex
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,              -- declared phase title; joins workflow_phase.title
  p50_wcet INTEGER NOT NULL CHECK (p50_wcet >= 0),
  p90_wcet INTEGER NOT NULL CHECK (p90_wcet >= 0),
  exp_agents INTEGER NOT NULL DEFAULT 1,
  model TEXT,                       -- the model the script assigns to this phase
  PRIMARY KEY (eid, phase_idx)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER estb_ro_u BEFORE UPDATE ON estimate_block BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER estb_ro_d BEFORE DELETE ON estimate_block BEGIN SELECT RAISE(ABORT,'append-only'); END;

-- v10: the live identity of an interactive session, as the statusline saw it.
--
-- The ONE mutable identity source, and deliberately so: every other leg of
-- `resolveEstimatorIdentity` (src/identity.ts) reads `request`, which is populated by
-- the SWEEP and therefore lags `est open` by design — the anchoring turn's own rows
-- are not on disk yet, and a brand-new session has none at all. This table is written
-- by the statusline shim, which receives the harness payload naming the model
-- answering THIS session, so it is fresh within one status-line render.
--
-- Mutable because it is not evidence: it is a cache of "who is at the keyboard now",
-- superseded on every render and never read for anything historical. The append-only
-- spine (§4.2) covers estimates, scopes, outcomes and repairs — not this.
--
-- NOTE (v10 gate): the harness statusline payload's `model.id` field is NOT a
-- documented contract, so `scripts/statusline-burn.ts` only writes here when
-- EST_SESSION_MODEL_CAPTURE=1. Absence degrades to the transcript legs; it never
-- degrades to a wrong answer.
CREATE TABLE session_model (
  session_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  model_family TEXT NOT NULL,
  seen_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- v10: the APPEND-ONLY correction ledger for `estimate.estimator_model`.
--
-- `estimate` is append-only and `outcome.eid_at_start` is MIN(eid) per task, so a
-- mis-derived estimator identity CANNOT be corrected by appending a better estimate:
-- every calibration consumer joins on the FIRST estimate, and a v2 row with the right
-- family would look like a fix while changing nothing downstream (v_velocity,
-- v_task_actual_epoch, retro's velocity join, close.ts's first-estimate-wins rule).
--
-- So the correction lives BESIDE the row instead of in it. The ledger row is never
-- touched; `v_estimate_identity` projects the effective value (MAX(seq) wins) and
-- `v_velocity` reads through it. `SELECT estimator_model FROM estimate` still returns
-- what was believed at the time, which is the whole point of the spine.
--
-- `evidence` is JSON and is mandatory: a correction with no stated basis is an
-- assertion, and this ledger is exactly where an assertion must not be able to hide.
CREATE TABLE estimate_identity_repair (
  eid INTEGER NOT NULL REFERENCES estimate(eid),
  seq INTEGER NOT NULL,
  repaired_at TEXT NOT NULL,
  estimator_model TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN
    ('anchor_prompt','at_created','statusline','manual')),
  evidence TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (eid, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER eir_ro_u BEFORE UPDATE ON estimate_identity_repair
  BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER eir_ro_d BEFORE DELETE ON estimate_identity_repair
  BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE request (              -- the atomic fact: one row per deduped API request
  request_id TEXT PRIMARY KEY,      -- GLOBAL key (fork replays collapse here).
                                    -- fallback: message.id, then uuid.
                                    -- GATE G-FORK RAN 2026-07-29 (gates/G-FORK.md): the global PK
                                    -- is CONFIRMED and must NOT be narrowed to
                                    -- (session_id, request_id). Overlap REPLICATES far beyond the
                                    -- single [J] pair: 5 independent file pairs, 643 duplicated
                                    -- requestIds, 100% of them crossing a session boundary, and
                                    -- 100% message.id agreement across all 643 — every duplicate
                                    -- is provably the same billed call written twice, so
                                    -- collapsing it is correct rather than lossy. Narrowing would
                                    -- double-count 2.4% of corpus Work-CET and 12-100% of the
                                    -- Work-CET of each affected session (one session is 100%
                                    -- phantom). Three mechanisms produce them: rewind fork,
                                    -- /compact continuation (tail replay), subagent symlink alias.
  message_id TEXT,                  -- INDEXED and USED: ccusage's replay fallback (§5.2)
  is_sidechain INTEGER NOT NULL DEFAULT 0,   -- ccusage collision tie-break input
  session_id TEXT NOT NULL,         -- FIRST-SEEN owner; fork replays never re-attribute
  prompt_id TEXT,                   -- turn key, propagated forward from user lines
  origin TEXT NOT NULL CHECK (origin IN ('main','subagent','auxiliary')),
                                    -- 'auxiliary' added in R2: OTEL's documented third
                                    -- query_source (title generation, quota checks, background
                                    -- cheap-model calls) — real money, previously would have
                                    -- violated the CHECK or been dropped on Phase 2 ingest.
  agent_id TEXT, run_id TEXT, wf_launch_id TEXT,   -- wf_launch_id discriminates relaunches
  model TEXT NOT NULL, model_family TEXT NOT NULL,
  attribution_agent TEXT, attribution_skill TEXT,  -- free per-request tags from transcript
  ts TEXT NOT NULL,
  -- Counters are non-negative BY CONSTRUCTION. The §5.2 dedup upsert is
  -- MAX(existing, incoming) per counter, so a single negative slipping in from a
  -- malformed usage block would be absorbed silently on the low side and then
  -- pinned there for every later sweep. A CHECK turns that into a loud failure at
  -- the row that caused it (§2) instead of an unexplained shortfall in Work-CET.
  in_tok INTEGER NOT NULL DEFAULT 0 CHECK (in_tok  >= 0),
  out_tok INTEGER NOT NULL DEFAULT 0 CHECK (out_tok >= 0),
  cw_tok INTEGER NOT NULL DEFAULT 0 CHECK (cw_tok  >= 0),
  cr_tok INTEGER NOT NULL DEFAULT 0 CHECK (cr_tok  >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
                                    -- OTEL only (Phase 2); transcripts lack it
  tid TEXT REFERENCES task(tid),    -- NULL = unattributed: a counted state, never an error
  attr TEXT NOT NULL DEFAULT 'none' CHECK (attr IN
    ('none','exclusive','sticky','ambiguous','overhead','pre_task','replay'))
                                    -- 'replay' added in R2: a sidechain re-emission of an
                                    -- already-counted message under a NEW request_id. Kept as
                                    -- a row for auditability; excluded from EVERY sum.
) STRICT;
CREATE INDEX ix_req_tid   ON request(tid);
CREATE INDEX ix_req_turn  ON request(session_id, prompt_id);
CREATE INDEX ix_req_agent ON request(agent_id);
CREATE INDEX ix_req_msg   ON request(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE turn (                 -- + the only harness-written wall clock (turn_duration)
  session_id TEXT NOT NULL, prompt_id TEXT NOT NULL,
  started_at TEXT NOT NULL, duration_ms INTEGER,
  pending_bg INTEGER, pending_wf INTEGER,   -- CONSUMED in R2: see §7.3 interval-union
  tid TEXT REFERENCES task(tid),
  PRIMARY KEY (session_id, prompt_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE workflow_run (         -- R2: workflow runs are first-class, from the STATIC plan
  run_id TEXT NOT NULL, wf_launch_id TEXT NOT NULL,  -- runId reused across relaunches
  session_id TEXT NOT NULL,
  workflow_name TEXT, transcript_dir TEXT, default_model TEXT,
  launch_prompt_id TEXT,
  n_phases_planned INTEGER,
  started_at TEXT, ended_at TEXT,   -- DERIVED from agent transcripts, never from wf_*.json
  tid TEXT REFERENCES task(tid),
  PRIMARY KEY (run_id, wf_launch_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE workflow_phase (       -- STATIC PLAN ONLY, read from wf_<runId>.json phases[]
  run_id TEXT NOT NULL, wf_launch_id TEXT NOT NULL,
  phase_idx INTEGER NOT NULL,
  title TEXT NOT NULL, detail TEXT, model TEXT,
  PRIMARY KEY (run_id, wf_launch_id, phase_idx),
  FOREIGN KEY (run_id, wf_launch_id) REFERENCES workflow_run(run_id, wf_launch_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE agent_run (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT, wf_launch_id TEXT,   -- runId = dir key only; launch id from toolUseResult.taskId
  agent_type TEXT, spawn_depth INTEGER NOT NULL DEFAULT 1,
  launch_prompt_id TEXT,            -- attribution inherits from the LAUNCHING turn
  transcript_path TEXT,             -- realpath-canonicalised
  status TEXT,
  label TEXT,                       -- R3: workflowProgress[].label (the agent() `label` opt).
                                    -- NULL on a workflow agent => the §3.2 authoring rule was
                                    -- violated; reported, not silently tolerated.
  started_at TEXT, ended_at TEXT,   -- R3 SOURCE ORDER (changed): for workflow agents, primary =
                                    -- workflowProgress[].startedAt (epoch ms) and startedAt +
                                    -- durationMs — exact scheduler intervals, stronger than
                                    -- transcript line timestamps. Fallback, and the rule for
                                    -- non-workflow agents: first/last line `timestamp` in
                                    -- agent-<id>.jsonl (journal.jsonl and meta.json carry none,
                                    -- verified [R2]). These two columns underpin EVERY time
                                    -- computation (§5.3, §7.3).
  interval_src TEXT CHECK (interval_src IN ('workflow_progress','transcript','none')),  -- R3
  queued_at TEXT,                   -- R3: workflowProgress[].queuedAt — queue latency is visible
  attempt INTEGER,                  -- R3: workflowProgress[].attempt — retries are visible
  reported_tokens INTEGER CHECK (reported_tokens IS NULL OR reported_tokens >= 0),
                                    -- R3: workflowProgress[].tokens, STORED FOR AUDIT ONLY and
                                    -- NEVER summed: measured at ~0.73x of true Work-CET for
                                    -- one verified agent — it appears to track cache_creation
                                    -- alone. Numbers always come from transcripts (§5.6).
  phase_idx INTEGER,                -- R3: EXACT, from workflowProgress[].phaseIndex (§5.6)
  phase_title TEXT,                 -- R3: workflowProgress[].phaseTitle, cross-checks phases[]
  phase_conf TEXT CHECK (phase_conf IN ('exact','inferred','unmapped')),
                                    -- R3 semantics: 'exact' = workflowProgress join;
                                    -- 'inferred' = interval-clustering fallback; 'unmapped' = neither
  tid TEXT REFERENCES task(tid)
) STRICT;
CREATE INDEX ix_agent_run ON agent_run(run_id, wf_launch_id);
-- Every per-task question about agents ("how many are bound", "which intervals does
-- this task own") filters on tid, and without this it was a SCAN of every agent run
-- ever recorded.
CREATE INDEX ix_agent_run_tid ON agent_run(tid);

CREATE TABLE task_event (           -- lifecycle from transcript toolUseResult (§6.1)
  ev INTEGER PRIMARY KEY,
  tid TEXT REFERENCES task(tid),
  session_id TEXT NOT NULL,
  -- WHICH tool wrote the event. TaskCreate carries `toolUseResult.task={id,subject}`
  -- and no statusChange; TaskUpdate carries `statusChange:{from,to}`. §5.4 defines a
  -- turn as "touching" a task if it did EITHER, so an ingest that only kept
  -- statusChange made every create invisible to attribution. Part of the dedup key:
  -- a create and a transition can land on the same (task, ts, to_status) and are
  -- still two different facts.
  kind TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'status'
       CHECK (kind IN ('create','status')),
  -- SENTINEL, NOT NULL. SQLite treats NULLs as DISTINCT inside a UNIQUE index, so
  -- with nullable task_num/to_status the dedup key below matched nothing and the
  -- ingest `ON CONFLICT ... DO NOTHING` silently inserted a fresh duplicate row on
  -- EVERY re-sweep of the same transcript — the one thing the sweeper is required
  -- to be idempotent about (§5.8). `ON CONFLICT REPLACE` on the NOT NULL is the
  -- coercion: SQLite substitutes the column DEFAULT when a NULL is bound, so the
  -- writer keeps binding `null` for "no task number / no target status" and the
  -- key still collapses. '' is unambiguous — a real taskId or status is non-empty.
  task_num TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  ts TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('transcript','cli','sweeper','pretooluse')),
                                    -- 'pretooluse' = the restored delete-capture hook (§6.1)
  UNIQUE (session_id, task_num, ts, to_status, kind)
) STRICT;
-- v13: the sweep's `session_task` backfill (src/ingest.ts BACKFILL_TASK_EVENT_TID_SQL)
-- selects on `tid IS NULL`, which no index could serve — so every sweep re-scanned every
-- lifecycle row this database has ever held, forever, to find the handful that just
-- became linkable. PARTIAL, so the index holds only the rows still awaiting a tid and
-- SHRINKS as they are linked: the steady state is an empty index and a scan of nothing.
-- The `task_num <> ''` half drops the sentinel rows (a `task_event` with no task number
-- can never match an alias), and the UPDATE repeats both predicates verbatim so the
-- planner can actually use this.
CREATE INDEX ix_task_event_unlinked ON task_event(session_id, task_num)
  WHERE tid IS NULL AND task_num <> '';
-- v14: the mirror image of the index above, for the SWEEPER CLOSE PASS (src/autoclose.ts).
-- Its candidate filter asks, once per open task, "is there a LINKED terminal signal for
-- this tid" -- and `tid` had no index at all, so the answer cost a scan of the whole
-- lifecycle table per open task, on the micro-sweep's path. PARTIAL over exactly the rows
-- that can ever answer yes: linked, and terminal. That is a handful of rows per finished
-- task rather than every transition ever recorded, and it GROWS only with terminations
-- (where ix_task_event_unlinked shrinks with them).
--
-- BOTH terminal statuses, not just 'completed'. §6.2's gate has always read
-- `to_status IN ('completed','deleted')` as its completion signal, and P1.11's
-- delete-capture hook exists precisely so a deletion is RECORDED rather than lost -- an
-- index that saw only completions would have made the close pass blind to every captured
-- deletion, so the pass would have reached those tasks only via the staleness arm and
-- filed them as `abandoned`, laundering the one signal that hook exists to preserve into
-- its opposite. `ts` is in the index because the candidate filter bounds every signal
-- below by the task's latest reopen; `to_status` because the filter carries the terminal
-- KIND through to the close status. CLOSE_PASS_CANDIDATE_SQL repeats the partial
-- predicate verbatim so the planner can use it; test/schema.test.ts asserts the plan
-- rather than the prose.
CREATE INDEX ix_task_event_completed ON task_event(tid, ts, to_status)
  WHERE tid IS NOT NULL AND to_status IN ('completed','deleted');

CREATE TABLE outcome (              -- APPEND-ONLY; current = MAX(revision). Reopen = new revision.
  tid TEXT NOT NULL REFERENCES task(tid),
  revision INTEGER NOT NULL,
  finalized_at TEXT NOT NULL,
  final_status TEXT NOT NULL CHECK (final_status IN
    ('completed','abandoned','deleted','reopened')),
  censored INTEGER NOT NULL DEFAULT 0,  -- abandoned => actual is a LOWER BOUND (right-censored)
  eid_at_start INTEGER NOT NULL REFERENCES estimate(eid),  -- accuracy judged vs THIS, always
  eid_final INTEGER NOT NULL REFERENCES estimate(eid),
  -- Every roll-up below is non-negative by construction, for the same reason the
  -- request counters are: a negative here is corrupt input, and a corrupt actual
  -- is a poisoned reference-class row that quietly drags the multipliers down.
  actual_wcet INTEGER NOT NULL CHECK (actual_wcet >= 0),
  actual_wcet_at_epoch INTEGER CHECK (actual_wcet_at_epoch IS NULL
                                      OR actual_wcet_at_epoch >= 0),
                                    -- R2: recomputed under estimate.price_epoch — the ONLY
                                    -- figure velocity may use (§4.4)
  actual_scet INTEGER NOT NULL CHECK (actual_scet >= 0),
  actual_in INTEGER NOT NULL CHECK (actual_in >= 0),
  actual_out INTEGER NOT NULL CHECK (actual_out >= 0),
  actual_cw INTEGER NOT NULL CHECK (actual_cw >= 0),
  actual_cr INTEGER NOT NULL CHECK (actual_cr >= 0),
  -- R2: the headline axis, finally split. exp_agents is committed at estimate time; without
  -- this you can record that an estimate was 3x low but not which half caused it.
  wcet_main INTEGER NOT NULL DEFAULT 0 CHECK (wcet_main >= 0),
  wcet_sub  INTEGER NOT NULL DEFAULT 0 CHECK (wcet_sub  >= 0),
  wcet_aux  INTEGER NOT NULL DEFAULT 0 CHECK (wcet_aux  >= 0),
  n_req_main INTEGER NOT NULL DEFAULT 0 CHECK (n_req_main >= 0),
  n_req_sub  INTEGER NOT NULL DEFAULT 0 CHECK (n_req_sub  >= 0),
  n_req_aux  INTEGER NOT NULL DEFAULT 0 CHECK (n_req_aux  >= 0),
  n_requests INTEGER NOT NULL CHECK (n_requests >= 0),
  n_agents INTEGER NOT NULL CHECK (n_agents >= 0),
  -- the three clocks, never blended (§7.3)
  active_s INTEGER,                 -- UNION of turn+agent intervals (not a sum) — R2
  busy_s INTEGER,                   -- SUM of those interval lengths
  max_concurrency INTEGER,          -- R2: realized, per task, from the sweep line
  parallelism_factor REAL,          -- R2: busy_s / active_s
  compute_s INTEGER, wall_s INTEGER,
  overhead_wcet INTEGER NOT NULL DEFAULT 0 CHECK (overhead_wcet >= 0),  -- ceremony's own cost
  unattrib_share REAL, ambiguous_share REAL,     -- honesty columns: counted, not hidden
  unpriced_share REAL NOT NULL DEFAULT 0,        -- R2: degrades the row, never blocks
  price_provisional INTEGER NOT NULL DEFAULT 0,
  dangling_agents INTEGER NOT NULL DEFAULT 0,
  compactions INTEGER NOT NULL DEFAULT 0,
  fork_replays INTEGER NOT NULL DEFAULT 0,
  sidechain_replays INTEGER NOT NULL DEFAULT 0,  -- R2: ccusage message_id fallback hits
  phase_unmapped_agents INTEGER NOT NULL DEFAULT 0,   -- R2: workflow-step coverage
  tid_planted INTEGER,                           -- R2: NULL = no Task-tool task existed
  scope_changed INTEGER NOT NULL DEFAULT 0,
  scope_changed_at TEXT,                         -- R2: when, not just whether
  scope_seq_at_start INTEGER,                    -- R2: reconstructable baseline
  scope_seq_final INTEGER,
  scope_declared INTEGER NOT NULL DEFAULT 0,     -- R2: 1 = Claude ran `est scope`;
                                                 -- 0 with a hash diff = undeclared drift
  velocity_raw REAL, velocity_cal REAL, in_band INTEGER,
  PRIMARY KEY (tid, revision)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER out_ro_u BEFORE UPDATE ON outcome BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER out_ro_d BEFORE DELETE ON outcome BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE refclass (      -- APPEND-ONLY snapshots: the reference-class table the retro
                             -- writes back into. [FS][INFERRED] required this; R1 had no table.
  as_of TEXT NOT NULL,       -- retro run timestamp; estimate.refclass_as_of points here
  bucket TEXT NOT NULL REFERENCES bucket_def(bucket),
  estimator_family TEXT NOT NULL,        -- '*' = pooled across model families
  n INTEGER NOT NULL, n_eff REAL NOT NULL,   -- n_eff after half-life decay weighting
  med_log_v REAL NOT NULL, iqr_log_v REAL NOT NULL,
  shrink_w REAL NOT NULL, shrink_k REAL NOT NULL, half_life_days REAL NOT NULL,
  mult_p50 REAL NOT NULL, mult_p90 REAL NOT NULL,
  boot_lo_p50 REAL, boot_hi_p50 REAL,    -- bootstrap CI: PARAMETER uncertainty, which dominates
  boot_lo_p90 REAL, boot_hi_p90 REAL,    -- at n~10 and which R1's plug-in argument discarded
  method TEXT NOT NULL CHECK (method IN ('plugin','bootstrap')),
  -- THE UNIT, and it is IN THE KEY (v6). A multiplier is a ratio of Work-CETs, so it
  -- only means anything against the (ref_model, estimand) pair it was fitted in
  -- (§4.1, §4.2 delta 3). `ref_model` used to live inside params_json, which no
  -- reader parses: `newestRefclass` matched on bucket and family alone, so after a
  -- one-line `est config set ref_model` the newest sonnet-denominated snapshot was
  -- handed straight to an opus-denominated band — calibrated-looking, zero
  -- comparable tasks, silently mis-denominated. Keying on the pair also lets two
  -- units coexist at one `as_of` instead of colliding on an append-only table.
  ref_model TEXT NOT NULL,
  estimand TEXT NOT NULL, params_json TEXT NOT NULL,
  PRIMARY KEY (as_of, bucket, estimator_family, ref_model, estimand)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER rc_ro_u BEFORE UPDATE ON refclass BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER rc_ro_d BEFORE DELETE ON refclass BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE calib_run (     -- retro provenance: what was tested, what won, what the floor was
  as_of TEXT PRIMARY KEY,
  n_outcomes INTEGER NOT NULL, estimand TEXT NOT NULL,
  pinball_p50 REAL, pinball_p90 REAL, log_score REAL,
  coverage_p50 REAL, coverage_p90 REAL, cov_lo REAL, cov_hi REAL,   -- Jeffreys interval
  baseline_pinball REAL,     -- the [FS]-constants baseline the time model must beat (§7.3)
  active_model_won TEXT,     -- 'baseline_req' | 'fanout_cond'
  splits_json TEXT NOT NULL, -- candidate bucket splits + their CV pinball deltas
  notes TEXT
) STRICT;

CREATE TABLE recon (         -- R2: our number vs an ANTHROPIC-computed number (§7.5)
  as_of TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('otel_cost','cli_json','usage_cmd','sdk_result')),
  window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  ours_usd REAL NOT NULL, theirs_usd REAL NOT NULL, delta_pct REAL NOT NULL,
  note TEXT,
  PRIMARY KEY (as_of, source)
) STRICT, WITHOUT ROWID;

CREATE TABLE sweep_census (  -- R2: dispositions "something prunes even faster" (§5.8)
  swept_at TEXT PRIMARY KEY,
  n_files INTEGER NOT NULL, n_bytes INTEGER NOT NULL, n_sessions INTEGER NOT NULL,
  oldest_mtime TEXT NOT NULL,
  vanished_total INTEGER NOT NULL DEFAULT 0,
  vanished_lt_60d INTEGER NOT NULL DEFAULT 0   -- >0 => an UNKNOWN pruner exists; anomaly + alert
) STRICT;

CREATE TABLE anomaly (              -- loud, queryable failure ledger
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL,
  kind TEXT NOT NULL,               -- Deliberately NOT a CHECK list: a new failure mode must be
                                    -- recordable the moment it is observed, never dropped because
                                    -- the DDL had not heard of it. The catalogue below is the
                                    -- documented vocabulary; keep it honest about who writes what.
                                    --
                                    -- WRITTEN TODAY by src/prices.ts:
                                    --   unpriced_model|provisional_price
                                    -- WRITTEN TODAY by src/discover.ts:
                                    --   dangling_symlink|spawn_depth_gt1|wf_record_mismatch
                                    --   |wf_state_unparseable|agent_meta_unparseable
                                    --   |orphan_agent_transcript
                                    --   |main_transcript_missing -- a session-id-shaped artefact
                                    --      dir (agents/workflows/states) exists with ZERO
                                    --      `<sid>.jsonl` anywhere in the corpus. Computed
                                    --      CORPUS-WIDE (a session's four possible munged project
                                    --      dirs are merged before this check), never per-dir — a
                                    --      per-dir test false-positives on a session whose main
                                    --      lives under a DIFFERENT project dir than this artefact
                                    --      set. Feeds `corpus_loss` (D2, src/census.ts).
                                    -- WRITTEN TODAY by src/ingest.ts:
                                    --   malformed_line|truncated_tail|unusable_usage_line
                                    --   |sidechain_replay|rid_collision|phase_unmapped
                                    --   |wf_record_mismatch
                                    --   |read_error  -- a read that ABORTED: the file's
                                    --      sweep_state watermark was deliberately withheld
                                    --   |orphan_turn_duration -- a turn_duration record that
                                    --      preceded every prompt in its file; the segmenter
                                    --      cannot attribute it, so it is COUNTED, not dropped
                                    --   |compaction_continuation -- /compact ends a session and
                                    --      replays its TAIL into the child's head (undocumented in
                                    --      R3; found by G-FORK §3.3). `compactionAnomalies`, off
                                    --      `ingestMainTranscript`; BENIGN in src/cli.ts, because a
                                    --      /compact boundary is a normal event Phase 1 needs fed.
                                    --   |agent_never_returned|wf_relaunch_orphan
                                    --   |wf_relaunch_detected -- §5.6 [R4] promotion condition (ii):
                                    --      the three CLASSIFIED reasons a workflow agent has no
                                    --      workflowProgress[] record, all BENIGN in src/cli.ts.
                                    --      never_returned = the run terminated and journal.jsonl has
                                    --      no `result` for it; relaunch_orphan = it started before
                                    --      the earliest recorded record, so it belongs to an earlier
                                    --      launch whose progress the harness overwrote when it
                                    --      rewrote wf_<runId>.json; relaunch_detected = that reuse
                                    --      itself. A fourth reason, `in_flight` (no state file yet),
                                    --      raises NOTHING — there is no state file until the run
                                    --      completes, so it is the normal case, not a failure. Only
                                    --      the residual keeps the ALERTING `phase_unmapped`. Every
                                    --      detail here is free of a count that moves between sweeps:
                                    --      the old `phase_unmapped` interpolated a wave count and so
                                    --      never deduped on (kind, detail).
                                    --      `agent_never_returned` is ALSO written by src/discover.ts
                                    --      for the population ingest cannot see — an agent the
                                    --      journal started that left no transcript at all.
                                    -- WRITTEN TODAY by src/cli.ts (sweep-level — these three need
                                    -- the WHOLE corpus in hand, so no per-file writer can raise them):
                                    --   corpus_shrink|sweep_budget_exceeded|unpriced_model
                                    --   |corpus_shrink_expected -- BENIGN (§5.8, P2.10 delta-9): a
                                    --      `corpus_loss` row whose age is >= config.retention_days.
                                    --      A daily cron sweep after the built-in `cleanupPeriodDays`
                                    --      first reaps must not exit 3 on expected retention; a loss
                                    --      inside `vanish_alarm_days` (or of unknown age) still raises
                                    --      the ALERTING `corpus_shrink`. See BENIGN_ANOMALY_KINDS.
                                    --   |census_collapse -- the D2/D3 sanity guard tripped: discovery
                                    --      found `census_collapse_pct`% fewer sessions than the
                                    --      previous `sweep_census` row (never on this database's
                                    --      first-ever sweep, or a corpus that has always been
                                    --      empty — there is nothing to have dropped FROM). A
                                    --      discovery outage (bad --root, unmounted volume, wrong
                                    --      EST_PROJECTS) must not be laundered into hundreds of
                                    --      durable `corpus_loss` rows — D2/D3 are SKIPPED and this
                                    --      fires instead. ALWAYS alerting.
                                    --   |fork_replay     -- cross-session uuid overlap between
                                    --      DISTINCT files; detail carries shape + shared count.
                                    --      `detectForkReplays` (D3: one corpus-wide uuid -> file[]
                                    --      pass, precision/recall 1.00). D1's leading-prefix test is
                                    --      dead (36% recall) and was never wired.
                                    --   |symlink_alias   -- one realpath claimed by two sessions;
                                    --      `planCorpus` picks the link TARGET and logs the loser.
                                    -- fork_replay and symlink_alias are BENIGN in src/cli.ts too:
                                    -- both are structural facts of a forked corpus (46 of them on
                                    -- the live tree), correctly handled by the global request PK.
                                    -- WRITTEN BY PHASE 1 (§Phase 1 interfaces):
                                    --   src/tasks.ts:  anchor_inferred -- `est open` resolved its
                                    --      session/prompt without an explicit flag; a wrong guess
                                    --      is visible rather than silent (P1.0)
                                    --   src/close.ts:  forced_close|scope_undeclared|tid_unplanted
                                    --      |accepted_close -- `est close --accept`: the human said
                                    --      the work was done and the agent relayed their words,
                                    --      which are stored VERBATIM in detail (the whole audit
                                    --      trail for a close no arithmetic authorised, verified
                                    --      against a bound session's transcript). BENIGN in
                                    --      src/cli.ts, unlike forced_close: forced_close alerts
                                    --      because nobody is named behind it, and this row exists
                                    --      to name someone. `est retro` reports both plus the
                                    --      share of closed tasks that came through either.
                                    --   src/autoclose.ts: swept_close -- the SWEEPER close pass
                                    --      (v14, Craig 2026-07-30) finalized a task nobody ran
                                    --      `est close` on, on the strength of a terminal
                                    --      task_event the §6.2 gate observed (`completed` or
                                    --      `deleted`; the gate's own kind is carried through to
                                    --      the close status). The full quiescence gate was met --
                                    --      this pass has no bypass -- so the row is PROVENANCE,
                                    --      not an override: `outcome` has no "who closed this"
                                    --      column, and this ledger is where
                                    --      `forced_close`/`accepted_close` already answer that
                                    --      question. BENIGN in src/cli.ts: the sweeper doing its
                                    --      documented job on every cron leg must not exit 3, or
                                    --      the watchdog learns to be ignored.
                                    --      |swept_abandon -- the same pass closing a task it has
                                    --      NO signal for, after `close_abandon_after_h` (168 h) of
                                    --      silence. ALERTING, unlike its sibling, and the split is
                                    --      the point: an abandon is right-censored, so it
                                    --      preserves NO measurement and permanently seals the
                                    --      task's attribution window. It is rare by construction
                                    --      (a week of silence), so it cannot cry wolf, and the
                                    --      thing a human most needs told is exactly this one --
                                    --      `est close <tid> --status reopened` is the way back.
                                    --      |close_failed -- `close_fail_alert_after` (3)
                                    --      consecutive close attempts on one tid threw for a
                                    --      reason that was NOT the gate. ALERTING: a task that
                                    --      cannot be finalized never enters the calibration
                                    --      corpus, and nothing else would ever say so.
                                    --      |close_attempt_failed -- one such attempt, BENIGN, and
                                    --      capped at `close_fail_alert_after` rows per tid so the
                                    --      breadcrumbs that COUNT toward the alert cannot
                                    --      themselves become the spam, and DELETED when that tid
                                    --      closes successfully so the count is consecutive.
                                    --      |close_blocked -- a candidate the gate has refused
                                    --      continuously for `close_blocked_after_h` (24 h); detail
                                    --      names the failing ARM, never a count, so the ledger's
                                    --      (kind, detail, tid) dedup holds it to one row per arm.
                                    --      BENIGN: the gate refusing is the gate working, and the
                                    --      row exists so a refusal that has stopped being
                                    --      temporary is visible rather than silent.
                                    --   src/ingest.ts: plant_unlinked -- a planted est_tid that
                                    --      could not become a session_task alias: either it named
                                    --      a tid with no task row, or its tool_result never
                                    --      arrived (the session died mid-call, so nothing says
                                    --      the harness accepted it). BENIGN: refusing the alias is
                                    --      correct in both cases -- a transcript is untrusted
                                    --      input and an alias is permanent -- but a silent drop is
                                    --      indistinguishable from the ingest never looking.
                                    --   src/spool.ts:  missed_estimate -- a drained PostToolUse
                                    --      compliance record with no bound task (P1.10)
                                    -- WRITTEN BY PHASE 2 (§Phase 2 interfaces):
                                    --   src/otel.ts:   otel_unjoined -- an OTEL request no
                                    --      transcript row matches; the join_pct complement
                                    --      |otel_counter_mismatch -- a counter that DIFFERS
                                    --      between OTEL and the transcript. NEVER merged: the
                                    --      transcript is the token source of truth (§2), and a
                                    --      second writer is how two sources disagree silently.
                                    --      This is the independent audit of the dedup chain.
                                    --      |otel_prompt_mismatch -- ours (propagated forward,
                                    --      §5.3) vs the harness's stamp; a non-trivial rate means
                                    --      turn segmentation is wrong somewhere
                                    --      |otel_reject -- the receiver parked a body it could
                                    --      not classify (it answers 200 so the exporter does not
                                    --      retry a poison payload forever)
                                    --   src/cli.ts:    otel_receiver_down -- telemetry configured
                                    --      and nothing spooled for otel_stale_min; the receiver
                                    --      cannot report its own death, so the sweeper does
                                    --   src/recon.ts:  recon_mismatch -- an axis breached
                                    --      recon_alert_pct (P2.6). No longer "still unwritten".
                                    --   src/eta.ts:    segment_recut -- a re-cut RESTATED or
                                    --      REMOVED a TERMINAL run_segment row. A closed segment
                                    --      is a corpus observation, and a late OTEL duration can
                                    --      still merge or move one, so the corpus is regenerable
                                    --      rather than frozen -- but it may not move SILENTLY,
                                    --      and this row is the audit trail. The detail carries
                                    --      the CLASS of the change, never the values: the ledger
                                    --      dedups on (kind, detail) and numbers in the key would
                                    --      write a row per sweep.
                                    --   src/identity.ts (v10):
                                    --      estimator_identity_repaired -- an estimate whose
                                    --      EFFECTIVE estimator family was 'unknown' now resolves
                                    --      to a concrete one; one `estimate_identity_repair` row
                                    --      was appended beside (never into) the ledger row. Exactly
                                    --      one per eid, ever: the row stops being a candidate.
                                    --      |estimator_identity_ambiguous -- the window examined
                                    --      held MORE THAN ONE main-chain family, so the pass
                                    --      REFUSED and left 'unknown' standing. Written at most
                                    --      once per eid (the writer checks first), because a
                                    --      per-sweep repeat would make the ledger less readable,
                                    --      not more. NOT an alert: 'unknown' is a legitimate
                                    --      terminal state for a ceremony whose turn is not
                                    --      recoverable from the corpus.
                                    -- STILL UNWRITTEN, reserved for the rest of Phase 2:
                                    --   segment_open_too_long|job_unjoined|promotion_backdated
                                    --   |board_render_failed|audit_removed|gate_override
  detail TEXT NOT NULL,
  tid TEXT REFERENCES task(tid)     -- nullable: many anomalies are corpus-wide
) STRICT;

CREATE TABLE sweep_state (          -- performance only; losing it costs seconds, not correctness
  path TEXT PRIMARY KEY, inode INTEGER NOT NULL, bytes_read INTEGER NOT NULL,
  last_swept TEXT NOT NULL,
  mtime TEXT                        -- v9: the file's own mtime at last read. NULL until
                                    -- `est backfill` rewrites it; D1's vanish-age split
                                    -- falls back to `last_swept` (a lower bound; §5.8) until then.
) STRICT;

CREATE TABLE corpus_loss (          -- v9: durable record of a transcript that stopped existing
                                    -- (§5.8 root cause: `sweep_state` alone cannot represent a
                                    -- loss that happened before a path was ever watermarked).
                                    -- Append-only in spirit: a false positive is retracted via
                                    -- `resolved_at`, never a DELETE — see src/census.ts.
                                    --
                                    -- ONE ROW PER PATH, DESCRIBING ITS CURRENT EPISODE. The PK is
                                    -- the path, so a path cannot hold two rows; what it CAN do is
                                    -- be lost, restored (`resolved_at` set) and lost again, and
                                    -- the writer's `ON CONFLICT(path) DO UPDATE ... resolved_at =
                                    -- NULL WHERE corpus_loss.resolved_at IS NOT NULL` re-opens
                                    -- the row with the new episode's evidence. `DO NOTHING` — the
                                    -- original clause — made that second loss UNREPRESENTABLE:
                                    -- the row went on reading "resolved" while the file was gone,
                                    -- and `est retro`'s `WHERE resolved_at IS NULL` count agreed
                                    -- with the ledger rather than with the disk. History of the
                                    -- superseded episode is deliberately not kept here: the
                                    -- `anomaly` ledger already carries one dated `corpus_shrink`
                                    -- row per episode, which is where "when did this happen" is
                                    -- meant to be read.
  path TEXT PRIMARY KEY,
  session_id TEXT,                 -- nullable: not every lost path resolves to one session
  kind TEXT NOT NULL CHECK (kind IN ('main','agent','state','unknown')),
  detected_by TEXT NOT NULL CHECK (detected_by IN
    ('watermark_diff','discovery_probe','ledger_probe')),
  first_missing_at TEXT NOT NULL,
  last_seen_at TEXT,
  mtime TEXT,
  age_source TEXT NOT NULL CHECK (age_source IN ('mtime','last_swept','ledger_ts','unknown')),
  expected INTEGER NOT NULL DEFAULT 0,  -- 1 => age >= config.retention_days at detection time
  resolved_at TEXT                 -- set when a LATER sweep finds the file back on disk
) STRICT;

-- Phase 1 (P1.9): the statusline's read path, and the ONLY reason `est burn --json`
-- can promise a sub-100 ms budget. Aggregating v_wcet over `request` at a >=5 s
-- refresh interval, forever, is not acceptable; one indexed row read is.
--
-- It is a CACHE, NOT A SOURCE. Every column is recomputed from `request` by
-- `refreshBurnCache` (src/burn.ts) at the end of each sweep, inside the sweep's
-- existing transaction, and `est burn --refresh` recomputes the same numbers live
-- without reading this table at all. Dropping it costs one sweep and nothing else,
-- which is why it carries no history and no append-only trigger — it is the one
-- table in this schema that is allowed to be overwritten in place.
--
-- The FK is deliberate even for a cache: a burn row for a tid that no longer exists
-- is not a stale number, it is a wrong one, and `est burn` would happily render it.
--
-- EVERY derived fact the P1.9 payload needs is a COLUMN here, including the counts
-- that look cheap (agents bound to the task, requests priced provisionally, requests
-- with no price). Each of those was a per-render query over `agent_run` or a priced
-- view — unbounded in corpus size, and measured at ~127 ms per render on a large task
-- while the row read itself was 0.01 ms. A statusline read must be bounded by the ROW,
-- not by the history behind it.
CREATE TABLE burn_cache (
  tid TEXT PRIMARY KEY REFERENCES task(tid),
  as_of TEXT NOT NULL,              -- when the sweep that wrote this row ran; `stale_s` derives
  consumed_wcet INTEGER,
  wcet_main INTEGER, wcet_sub INTEGER, wcet_aux INTEGER,
  usd REAL,                         -- overhead-EXCLUSIVE, like consumed_wcet: the two are divided
  n_req INTEGER,
  n_agents_live INTEGER,            -- bound agent_runs with no ended_at
  n_agents_total INTEGER,           -- bound agent_runs, live or finished
  n_provisional INTEGER,            -- requests priced from a provisional rate -> `provisional_price`
  n_unpriced INTEGER,               -- requests whose family has no price row  -> `unpriced`
  active_s INTEGER,                 -- §7.3 interval UNION, not a sum
  burn_wcet_per_min REAL,           -- over the current rolling window (config burn_window_min)
  proj_total_wcet INTEGER,          -- linear projection; CRUDE, and both output modes say so
  -- v8 (P2.2): the check-back forecast and the compute clock. Every one is a COLUMN
  -- for the P1.9 reason — a residual-life quantile computed per render is exactly the
  -- unbounded per-render work this table exists to abolish. NULL until the next sweep.
  seg_started_at TEXT,              -- the OPEN run_segment the forecast is issued against
  seg_elapsed_s INTEGER,
  check_back_p50_s INTEGER, check_back_p90_s INTEGER,
  eta_model TEXT,                   -- which of the three models issued the number on screen
  eta_probation INTEGER,            -- 1 => the statusline renders a trailing `?`
  eta_n_seg INTEGER,                -- closed segments the shipped model was fitted on. A COLUMN
                                    -- for the reason above and no other: reading it as
                                    -- `COUNT(*) FROM run_segment WHERE gap_min = ?` per render is
                                    -- a table scan (no index covers gap_min) inside the one path
                                    -- that promises to be bounded by the ROW.
  compute_s INTEGER,                -- SUM(request.duration_ms)/1000 over attributed requests
  compute_coverage_pct REAL,        -- share of those requests that actually carry one; a compute
                                    -- figure without its coverage is a moved denominator
  -- v11: idle suppression (P2.1/P2.2, Craig 2026-07-30). 1 => the resolved session has no
  -- live agent, no open workflow and a closed newest turn, so Claude is BLOCKED ON THE
  -- HUMAN and no forecast is issued: `check_back` becomes `{waiting_on_input: true}` and
  -- every column above is written NULL. A column rather than a render-time derivation for
  -- the same P1.9 reason as its neighbours — the predicate reads `agent_run`,
  -- `workflow_run` and `turn`, none of which the bounded read path may touch.
  eta_waiting_on_input INTEGER      -- NULL only on a row written before this column existed
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Phase 2 (P2.5) — the OTEL facts, the check-back corpus, the wider
-- reconciliation and the jobs reconcile.
-- ---------------------------------------------------------------------------

-- ---- P2.4: the OTEL facts, kept SEPARATE from `request` on purpose -------------
CREATE TABLE otel_request (         -- one row per api_request event; NOT a second `request`
  request_id TEXT PRIMARY KEY,      -- the join key to `request`; same global-PK doctrine (§5.2)
  session_id TEXT, prompt_id TEXT, message_uuid TEXT, client_request_id TEXT,
  model TEXT, query_source TEXT,    -- 'main' | 'subagent' | 'auxiliary' -> request.origin
  ts TEXT NOT NULL,                 -- event time, ISO, derived from timeUnixNano
  received_at TEXT NOT NULL,        -- when the receiver spooled it; drift between the two is
                                    -- export latency, and it is worth being able to see
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  cost_usd_micros INTEGER CHECK (cost_usd_micros IS NULL OR cost_usd_micros >= 0),
                                    -- INTEGER micros, not the float `cost_usd`: money summed
                                    -- across 10^5 rows should not accumulate float error
  in_tok  INTEGER CHECK (in_tok  IS NULL OR in_tok  >= 0),
  out_tok INTEGER CHECK (out_tok IS NULL OR out_tok >= 0),
  cw_tok  INTEGER CHECK (cw_tok  IS NULL OR cw_tok  >= 0),
  cr_tok  INTEGER CHECK (cr_tok  IS NULL OR cr_tok  >= 0),
  attempt INTEGER, speed TEXT, effort TEXT, status_code INTEGER,
  workflow_run_id TEXT, workflow_name TEXT,
  joined INTEGER NOT NULL DEFAULT 0 -- 1 once a matching `request` row was found; the complement
                                    -- is `otel_unjoined`, and it is the recon join_pct denominator
) STRICT;
CREATE INDEX ix_otel_req_turn ON otel_request(session_id, prompt_id);
CREATE INDEX ix_otel_req_ts   ON otel_request(ts);

CREATE TABLE otel_metric (          -- cost.usage | token.usage | active_time.total
  metric TEXT NOT NULL, ts TEXT NOT NULL,
                                    -- `ts` is ISO SECONDS, because every window predicate in
                                    -- this schema is a string compare on it. `ts_nanos` is the
                                    -- sub-second half of the point's identity, kept as the
                                    -- verbatim int64 STRING it arrived as (it exceeds 2^53).
                                    -- Nothing aggregates over it; it exists so two points of
                                    -- one series 250 ms apart cannot collapse into one row.
  ts_nanos     TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  -- NOT NULL SENTINELS, for the reason task_event documents: SQLite treats NULLs as
  -- DISTINCT inside a UNIQUE/PRIMARY key, so nullable dimensions make the dedup key
  -- match nothing and every re-drain inserts a duplicate.
  session_id   TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  model        TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  query_source TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  token_type   TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
                                    -- The four columns above are the ALLOWLISTED dimensions, and
                                    -- an OTLP point carries dimensions the allowlist drops
                                    -- (`tool`, `decision`, …). Two genuinely distinct series then
                                    -- share every stored dimension and the DO UPDATE overwrites
                                    -- one with the other -- silent ingest loss, not deduplication.
                                    -- `dim_digest` is a one-way 64-bit digest of the FULL decoded
                                    -- attribute set plus unit and stream start (src/otel.ts), so
                                    -- the stored identity is as wide as the wire identity without
                                    -- persisting a single unallowlisted VALUE.
  dim_digest   TEXT NOT NULL ON CONFLICT REPLACE DEFAULT '',
  value REAL NOT NULL, unit TEXT,
  temporality TEXT NOT NULL CHECK (temporality IN ('delta','cumulative','unspecified')),
                                    -- delta SUMs; cumulative must be DIFFERENCED per series.
                                    -- Mixing them in one window is the §5.2 dedup mistake again.
  received_at TEXT NOT NULL,
  PRIMARY KEY (metric, ts, ts_nanos, session_id, model, query_source, token_type, dim_digest)
) STRICT, WITHOUT ROWID;

-- ---- P2.1: the check-back corpus ----------------------------------------------
-- DERIVED but DURABLE, and the distinction from burn_cache is deliberate: a segment
-- outlives the transcript that produced it (P2.10 prunes at 365 days), so this table
-- is upserted per sweep and NEVER deleted. Mutable only while terminator='open';
-- frozen once terminal. No append-only trigger: it is regenerable for as long as its
-- inputs exist, and `est audit --fix` is allowed to clear it (P2.12).
CREATE TABLE run_segment (
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  active_s INTEGER NOT NULL CHECK (active_s >= 0),
  busy_s   INTEGER NOT NULL CHECK (busy_s   >= 0),
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency >= 0),
  n_turns  INTEGER NOT NULL DEFAULT 0,
  n_agents INTEGER NOT NULL DEFAULT 0,
  gap_before_s INTEGER, gap_after_s INTEGER,   -- RECORDED, never predicted (§7.3 clock 3)
  terminator TEXT NOT NULL CHECK (terminator IN
    ('human_input','compaction','session_end','open')),
  interval_src_mix TEXT,            -- e.g. 'turn+agent+otel'; a segment assembled from mixed
                                    -- sources is visible as such, like agent_run.interval_src
  gap_min REAL NOT NULL,            -- the segment_gap_min IN FORCE when this row was cut, so a
                                    -- retuned threshold cannot silently restate old segments
  tid TEXT REFERENCES task(tid),    -- the task owning the MAJORITY of active seconds; the
                                    -- forecast itself is session-scoped (P2.1)
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  -- `gap_min` IS PART OF THE IDENTITY, and that is the whole point of the column. A
  -- key of (session_id, started_at) alone made a retune of `segment_gap_min` a silent
  -- no-op: the re-partition at the new threshold usually reuses a `started_at` that is
  -- already present as a TERMINAL row, so the INSERT lost the PK conflict and the
  -- `terminator = 'open'` freeze guard refused the UPDATE — the table came back
  -- byte-identical while `refreshSegments` reported segments written. Downstream the
  -- corpus at the new threshold was EMPTY, `n_closed < eta_min_fit`, and `check_back`
  -- vanished from the statusline forever with no error anywhere.
  --
  -- With gap_min in the key a retune writes a fresh PARTITION alongside the old one.
  -- That is also the honest data model: rows cut at 2 minutes and rows cut at 30 are
  -- different observations of the same wall clock, never one corpus (the measured p50
  -- moves ~10× across plausible thresholds), which is exactly why every reader — the
  -- `v_eta_corpus` consumers, `v_segment_current` below, `forecastSession` — filters
  -- on the threshold IN FORCE rather than on the table.
  PRIMARY KEY (session_id, gap_min, started_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_run_segment_tid ON run_segment(tid);
CREATE INDEX ix_run_segment_end ON run_segment(ended_at);
-- Covers the corpus-size count and the per-partition open-row sweep; without it both
-- are full scans of a table that only ever grows.
CREATE INDEX ix_run_segment_gap ON run_segment(gap_min, terminator);

CREATE TABLE eta_run (              -- APPEND-ONLY: what the check-back model was fitted on, and
  as_of TEXT NOT NULL,              -- what it had to beat. calib_run's sibling (§4.5).
  eta_model TEXT NOT NULL CHECK (eta_model IN ('const_median','residual_life','fanout_cond')),
  n_seg INTEGER NOT NULL, n_censored INTEGER NOT NULL DEFAULT 0,
  gap_min REAL NOT NULL,
  pinball_p50 REAL, pinball_p90 REAL,
  baseline_pinball_p50 REAL NOT NULL,   -- const_median; the floor a model must clear
  coverage_p90 REAL, cov_lo REAL, cov_hi REAL,   -- Jeffreys, as §7.4
  won INTEGER NOT NULL DEFAULT 0,
  probation INTEGER NOT NULL DEFAULT 1,
  params_json TEXT NOT NULL,
  PRIMARY KEY (as_of, eta_model)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER eta_ro_u BEFORE UPDATE ON eta_run BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER eta_ro_d BEFORE DELETE ON eta_run BEGIN SELECT RAISE(ABORT,'append-only'); END;

-- ---- P2.6: non-USD reconciliation --------------------------------------------
-- `recon` (USD) is UNTOUCHED — widening its CHECK would mean rebuilding a WITHOUT
-- ROWID table for no gain. Tokens, active seconds and request counts are different
-- units and get their own table rather than being coerced into usd-named columns.
CREATE TABLE recon_metric (
  as_of TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('tokens','active_s','requests')),
  source TEXT NOT NULL CHECK (source IN ('otel_tokens','otel_active','otel_request')),
  window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  ours REAL NOT NULL, theirs REAL NOT NULL, delta_pct REAL NOT NULL,
  join_pct REAL,                    -- share of OUR requests in the window OTEL also saw; a small
                                    -- delta on a tiny join is agreement with nothing (P2.6)
  unit TEXT NOT NULL, note TEXT,
  PRIMARY KEY (as_of, metric, source)
) STRICT, WITHOUT ROWID;

-- ---- P2.9: jobs reconcile, RECONCILE-ONLY ------------------------------------
CREATE TABLE job_run (
  job_id TEXT PRIMARY KEY,          -- the ~/.claude/jobs/<id> directory name
  session_id TEXT, resume_session_id TEXT,
  name TEXT, state TEXT, backend TEXT, template TEXT,
  created_at TEXT, updated_at TEXT, first_terminal_at TEXT,
  reported_tokens INTEGER CHECK (reported_tokens IS NULL OR reported_tokens >= 0),
                                    -- state.json.tokens: a HARNESS AGGREGATE. Stored for audit,
                                    -- NEVER summed — same ban as wf_*.json totalTokens and
                                    -- workflowProgress[].tokens (§1, §5.6).
  n_items INTEGER NOT NULL DEFAULT 0,
  n_items_started INTEGER NOT NULL DEFAULT 0,   -- fan[] entries with startedAt > 0; the item-grain
                                                -- check stays dormant until this is populated
  tid TEXT REFERENCES task(tid)
) STRICT;

CREATE TABLE job_item (
  job_id TEXT NOT NULL REFERENCES job_run(job_id),
  item_id TEXT NOT NULL,            -- fan[].id, e.g. 'todo:3'
  kind TEXT, label TEXT,
  started_at TEXT, done_at TEXT,    -- NULL where the harness wrote 0; 0 is 'unset', not epoch
  PRIMARY KEY (job_id, item_id)
) STRICT, WITHOUT ROWID;

CREATE VIRTUAL TABLE task_fts USING fts5(tid UNINDEXED, subject, description);

-- ---------------------------------------------------------------------------
-- Views — the currency lives here so it can be redefined without migration.
-- ---------------------------------------------------------------------------

CREATE VIEW v_scope_current AS
SELECT s.* FROM task_scope s
WHERE s.seq = (SELECT MAX(seq) FROM task_scope WHERE tid = s.tid);

-- Replays are excluded at the base of the stack, so no downstream sum can forget.
CREATE VIEW v_request_live AS SELECT * FROM request WHERE attr <> 'replay';

-- Which model_price row prices THIS request. Anthropic's long-context premium is a
-- per-REQUEST property of the prompt size, not a property of the model id: a
-- transcript records `claude-sonnet-4-5` whether the call carried 30k or 400k of
-- context, and the `[1m]` suffix that `src/prices.ts` keys its bracketed families
-- on never appears in one. So pricing every request at the standard tier silently
-- undercharged every long-context call — the premium existed in the table (sync()
-- has always written the `@above_200k` companion rows) and was read by nothing.
--
-- The tier is chosen from the counters we actually have: in + cache_write +
-- cache_read is the prompt the API billed against (out_tok is the completion and
-- is not part of the context that triggers the tier). Above the threshold, the
-- companion family is used IF it exists at this request's vintage; otherwise the
-- base row stands, which is the honest fallback for a family upstream publishes
-- no >200k rate for.
--
-- A family that already carries a bracket suffix (`claude-sonnet-4-5[1m]`) MUST
-- resolve to itself: sync() bakes the long-context rate INTO that row, so
-- appending the companion would surcharge a rate that already carries the
-- premium. `NOT LIKE '%]'` is that guard, and it is load-bearing rather than
-- decorative — a bracketed family whose base was unpublished used to go down
-- sync()'s tier-peer fallback, which copied the PEER's `@above_200k` companion
-- under the bracketed name. History is append-only, so a later sync that
-- published the real rate could not supersede that companion, and the view
-- silently priced every >200k call at the stale guess (3x, and provisional=1,
-- which keeps the whole task out of v_velocity forever). Both sides are fixed:
-- sync() no longer writes a companion for a bracketed family, and the view no
-- longer looks for one.
--
-- THE LITERALS BELOW ARE A CONTRACT with src/prices.ts: 200000 is
-- LONG_CONTEXT_THRESHOLD and '@above_200k' is ABOVE_200K_SUFFIX, which is the
-- string sync() actually writes the companion family under; `'%]'` is the shape
-- `priceFamily()` gives a family with a context suffix. SQL cannot import them,
-- so test/schema.test.ts asserts the two sides still agree.
CREATE VIEW v_request_tiered AS
SELECT r.*,
  CASE WHEN (r.in_tok + r.cw_tok + r.cr_tok) > 200000
        AND r.model_family NOT LIKE '%]'
        AND EXISTS (SELECT 1 FROM model_price hi
                     WHERE hi.family = r.model_family || '@above_200k'
                       AND hi.effective_from <= r.ts)
       THEN r.model_family || '@above_200k'
       ELSE r.model_family END AS price_family
FROM v_request_live r;

-- INNER JOIN: an unpriced model can never silently zero a task (the LEFT-JOIN flaw is dead).
-- Unpriced requests fall out here and are COUNTED by v_unpriced; they no longer block anything.
CREATE VIEW v_priced AS
SELECT r.*, p.usd_in, p.usd_out, p.usd_cw, p.usd_cr, p.provisional
FROM v_request_tiered r
JOIN model_price p ON p.family = r.price_family
 AND p.effective_from = (SELECT MAX(effective_from) FROM model_price
                         WHERE family = r.price_family AND effective_from <= r.ts);

CREATE VIEW v_unpriced AS           -- sweep logs an anomaly and offers `est prices --sync`;
SELECT * FROM v_request_live        -- finalization PROCEEDS, recording outcome.unpriced_share.
WHERE model_family NOT IN (SELECT DISTINCT family FROM model_price);

-- Self-consistent vintage: each request priced at ITS OWN ts (and its OWN context
-- tier, via v_priced), ref-model normaliser at the SAME ts. The normaliser is
-- deliberately the ref model's STANDARD-tier output price: it defines the unit
-- (one ref-model output token), and a unit that moved with the prompt size of the
-- request being measured would not be a unit at all.
CREATE VIEW v_wcet AS
SELECT v.*,
  CAST((v.out_tok*v.usd_out + v.cw_tok*v.usd_cw) / v.ref_out AS INTEGER) AS wcet,
  CAST((v.in_tok*v.usd_in + v.out_tok*v.usd_out
        + v.cw_tok*v.usd_cw + v.cr_tok*v.usd_cr) / v.ref_out AS INTEGER) AS scet
FROM (SELECT p.*,
        (SELECT usd_out FROM model_price
          WHERE family = (SELECT v FROM config WHERE k='ref_model')
            AND effective_from <= p.ts
          ORDER BY effective_from DESC LIMIT 1) AS ref_out
      FROM v_priced p) v;

-- The Spend-CET-style total: 'auxiliary' IS included in `wcet`/`scet` here, because
-- this view answers "what did this task cost" and auxiliary calls are real money.
-- Calibration must NOT read `wcet`; it reads wcet_task_effort (main+sub, §4.6) or
-- v_task_actual_epoch, both of which exclude auxiliary by construction.
CREATE VIEW v_task_actual AS
SELECT tid,
  SUM(CASE WHEN attr <> 'overhead' THEN wcet ELSE 0 END) AS wcet,
  SUM(CASE WHEN attr <> 'overhead' AND origin IN ('main','subagent')
           THEN wcet ELSE 0 END) AS wcet_task_effort,
  SUM(CASE WHEN attr =  'overhead' THEN wcet ELSE 0 END) AS overhead_wcet,
  SUM(scet) AS scet,
  -- R2: the orchestrator/sub-agent/auxiliary split, exposed where it is actually readable
  SUM(CASE WHEN origin='main'      AND attr<>'overhead' THEN wcet ELSE 0 END) AS wcet_main,
  SUM(CASE WHEN origin='subagent'  AND attr<>'overhead' THEN wcet ELSE 0 END) AS wcet_sub,
  SUM(CASE WHEN origin='auxiliary' AND attr<>'overhead' THEN wcet ELSE 0 END) AS wcet_aux,
  SUM(CASE WHEN origin='main'      THEN 1 ELSE 0 END) AS n_req_main,
  SUM(CASE WHEN origin='subagent'  THEN 1 ELSE 0 END) AS n_req_sub,
  SUM(CASE WHEN origin='auxiliary' THEN 1 ELSE 0 END) AS n_req_aux,
  SUM(in_tok) in_tok, SUM(out_tok) out_tok, SUM(cw_tok) cw_tok, SUM(cr_tok) cr_tok,
  COUNT(*) n_req, COUNT(DISTINCT agent_id) n_agents,
  MIN(ts) first_ts, MAX(ts) last_ts
FROM v_wcet WHERE tid IS NOT NULL GROUP BY tid;

-- R2: per-workflow-STEP rollup (REQ-3). phase_conf travels with the number so a caller can
-- never mistake an inferred mapping for an exact one.
CREATE VIEW v_phase_actual AS
SELECT a.run_id, a.wf_launch_id, a.phase_idx, p.title, p.model AS planned_model,
       a.tid, COUNT(DISTINCT a.agent_id) AS n_agents,
       -- WORST-WINS. The three labels happen to sort 'exact' < 'inferred' < 'unmapped'
       -- lexically, so MAX() is the CONSERVATIVE aggregate and MIN() was the
       -- optimistic one: a phase whose agents were half exactly mapped and half
       -- interval-clustered reported 'exact' and a caller had no way to tell.
       -- A phase is only as trustworthy as its least-trustworthy agent.
       MAX(a.phase_conf) AS phase_conf,
       SUM(w.wcet) AS wcet, COUNT(w.request_id) AS n_req,
       MIN(a.started_at) AS phase_started_at, MAX(a.ended_at) AS phase_ended_at
FROM agent_run a
LEFT JOIN workflow_phase p
  ON p.run_id=a.run_id AND p.wf_launch_id=a.wf_launch_id AND p.phase_idx=a.phase_idx
LEFT JOIN v_wcet w ON w.agent_id = a.agent_id
WHERE a.run_id IS NOT NULL
GROUP BY a.run_id, a.wf_launch_id, a.phase_idx;

-- R3: block estimate vs block actual — the evidence for "smaller items estimate better" (§3.2, §7.4).
--
-- v16, UNIT ENFORCED on the block axis — the SQL half of the one refusal `bandUnscorable`
-- and `blocksInWcet` express in TypeScript (src/tasks.ts). `p50_wcet`/`p90_wcet` here are
-- whatever `config.estimand` was at `est block`, and NOTHING ever converts an
-- estimate_block row: the table has no cal_* pair, and estb_ro_u / estb_ro_d mean it could
-- never acquire one retroactively. `actual_wcet` on the other side is Work-CET off the logs
-- (v_phase_actual -> v_wcet), always, because there is no such thing as a log-derived story
-- point. So under 'story_point' the two columns are in DIFFERENT UNITS and any loss
-- computed across them is not a weak measurement, it is not a measurement.
--
-- Note this is STRICTLY BROADER than the task-band guard. A story-point band that had a
-- rate at `est open` has Work-CET cal_* and scores normally at task level — but that
-- conversion happened on `estimate`, not on the blocks hanging off it, so the block axis
-- stays refused for as long as the estimand is points.
--
-- The refusal is a NULL actual rather than a dropped row: the estimate side of the row is
-- still true and still wanted (the board reads title/p50/p90/exp_agents off this view), and
-- retro's per-block leg already filtered `actual_wcet IS NOT NULL`, so the existing consumer
-- refuses correctly without knowing why. `unit_mismatch` is what carries the why — 1 only
-- where an actual EXISTS and had to be withheld, so it counts refusals rather than the
-- unrun phases that are simply absent.
CREATE VIEW v_block_accuracy AS
SELECT b.eid, e.tid, b.phase_idx, b.title, b.p50_wcet, b.p90_wcet, b.exp_agents,
       CASE WHEN e.estimand = 'story_point' THEN NULL ELSE pa.wcet END AS actual_wcet,
       CASE WHEN e.estimand = 'story_point' AND pa.wcet IS NOT NULL THEN 1 ELSE 0 END AS unit_mismatch,
       pa.n_agents, pa.phase_conf
FROM estimate_block b
JOIN estimate e     ON e.eid = b.eid
JOIN workflow_run r ON r.tid = e.tid
LEFT JOIN v_phase_actual pa
       ON pa.run_id = r.run_id AND pa.wf_launch_id = r.wf_launch_id
      AND pa.phase_idx = b.phase_idx;

-- R2: price_epoch ENFORCED. Every counter repriced at the vintage the estimate was issued under,
-- normaliser included. This is the ONLY actual the velocity corpus is allowed to consume.
--
-- ORIGIN FILTER (§4.6). This view feeds CALIBRATION, and calibration measures TASK
-- EFFORT: what the orchestrator and its sub-agents spent doing the work Craig
-- asked for. 'auxiliary' is OTEL's third query_source — title generation, quota
-- checks, background cheap-model calls — real money, but money the harness spends
-- on its own behalf, uncorrelated with task size and unpredictable at `est open`.
-- Folding it in would inflate every actual by a per-session constant and teach the
-- multipliers a bias that no estimate could ever have anticipated. Auxiliary spend
-- is NOT hidden: v_task_actual keeps wcet_aux / n_req_aux and SUM(scet), which are
-- the Spend-CET totals reconciliation and cost reporting read.
--
-- UNIT ENFORCED, on BOTH axes, from e.ref_model / e.estimand — the unit snapshotted
-- at issue time (§4.1), never from `config`. price_epoch pins the RATES; these two
-- pin the DEFINITION of a CET: which family's output token is "one", and which
-- counters are summed. Reading either from config made a one-line `est config set`
-- restate every historical actual — a 5x swing for a sonnet->opus normaliser flip,
-- against a band issued in the old unit, on a measurement nothing else touched.
-- v_velocity projects e.ref_model / e.estimand as the row's LABEL, so a
-- config-denominated number here would not even be mislabelled loudly: it would
-- arrive inside the right reference class wearing the right name and quietly mix
-- currencies, which is precisely what the snapshot columns exist to prevent.
--
-- An `estimand` outside the values below yields NULL rather than a work_cet
-- number wearing an unknown label: NULL is what v_velocity's
-- `actual_wcet_at_epoch IS NOT NULL` filter already excludes, so a typo costs the
-- corpus rows instead of corrupting them.
--
-- v15, and the ONE place the story-point estimand is not simply another currency:
-- 'story_point' names the unit of the BAND, not of the ACTUAL. A point is a relative
-- size against config.sp_anchor_text; there is no such thing as a log-derived point,
-- so the actual for a points band is measured in Work-CET (out+cw) exactly as before.
-- That is what makes `outcome.velocity_raw = actual_wcet / raw_p50` come out as
-- Work-CET-PER-POINT the moment raw_p50 is in points, which is the entire learning
-- signal for the points -> Work-CET bridge. Without this branch the CASE would fall
-- through to NULL, `actual_wcet_at_epoch IS NOT NULL` would drop every completed
-- story-point task out of v_velocity, and the corpus would never learn a rate at all
-- — silently, since a missing row looks exactly like work nobody has finished yet.
CREATE VIEW v_task_actual_epoch AS
SELECT r.tid,
  SUM(CAST((CASE e.estimand
              WHEN 'out'         THEN r.out_tok*pe.usd_out
              WHEN 'work_cet'    THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw
              WHEN 'out_cw_in'   THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw + r.in_tok*pe.usd_in
              WHEN 'story_point' THEN r.out_tok*pe.usd_out + r.cw_tok*pe.usd_cw
            END) / rf.usd_out AS INTEGER)) AS wcet_at_epoch,
  e.price_epoch, e.eid AS eid_at_start
FROM v_request_live r
JOIN estimate e ON e.eid = (SELECT MIN(eid) FROM estimate WHERE tid = r.tid)
-- Same per-request context tier as v_priced, but resolved AT THE EPOCH rather than
-- at the request's own ts: reusing v_request_tiered here would pick a companion
-- family that may not exist at price_epoch, and this INNER JOIN would then drop the
-- request silently instead of pricing it. The `NOT LIKE '%]'` guard is the same
-- one v_request_tiered carries and for the same reason: a bracketed family's own
-- row already carries the long-context rate.
JOIN model_price pe
  ON pe.family = CASE WHEN (r.in_tok + r.cw_tok + r.cr_tok) > 200000
                       AND r.model_family NOT LIKE '%]'
                       AND EXISTS (SELECT 1 FROM model_price hi
                                    WHERE hi.family = r.model_family || '@above_200k'
                                      AND hi.effective_from <= e.price_epoch)
                      THEN r.model_family || '@above_200k'
                      ELSE r.model_family END
 AND pe.effective_from = (SELECT MAX(effective_from) FROM model_price
                          WHERE family = pe.family AND effective_from <= e.price_epoch)
-- The normaliser. `e.ref_model`, not config: the whole view is an INNER JOIN to
-- `estimate`, so the snapshot is always available and config could only ever be a
-- late substitute for it.
JOIN model_price rf ON rf.family = e.ref_model
 AND rf.effective_from = (SELECT MAX(effective_from) FROM model_price
                          WHERE family = rf.family AND effective_from <= e.price_epoch)
WHERE r.tid IS NOT NULL AND r.attr <> 'overhead'
  AND r.origin IN ('main','subagent')   -- task effort only; 'auxiliary' excluded (§4.6)
GROUP BY r.tid;

CREATE VIEW v_outcome_current AS
SELECT o.* FROM outcome o
WHERE o.revision = (SELECT MAX(revision) FROM outcome WHERE tid = o.tid);

CREATE VIEW v_missed_estimate AS    -- the T1/T2 backstop; T3/T4 are NOT representable here (§3.3)
SELECT t.session_id, t.prompt_id, t.started_at,
       SUM(CASE WHEN a.run_id IS NOT NULL THEN 1 ELSE 0 END) AS n_workflows,
       COUNT(DISTINCT a.agent_id) AS n_agents
FROM turn t JOIN agent_run a ON a.launch_prompt_id = t.prompt_id AND a.session_id = t.session_id
WHERE t.tid IS NULL
GROUP BY t.session_id, t.prompt_id
HAVING n_workflows >= 1 OR n_agents >= 2;

-- The calibration corpus. TWO comparability rules travel with every row, because
-- both were silently violable before:
--
--   1. LIKE UNITS. e.ref_model / e.estimand name the unit the band was issued in
--      (§4.1). `est config set ref_model` / `set estimand` are one-line changes
--      that redenominate everything issued afterwards, and a velocity ratio built
--      from two different denominations is a category error, not an outlier. Every
--      consumer MUST filter or GROUP BY (ref_model, estimand) — the columns are
--      projected here so there is no excuse for pooling across them.
--   2. TASK EFFORT ONLY. wcet_task_effort = main + sub. 'auxiliary' spend (title
--      generation, quota checks, background cheap-model calls) is harness
--      overhead: real money, no relationship to task size, unknowable at `est
--      open`. It stays visible as wcet_aux for Spend-CET reporting and is kept out
--      of the ratio the multipliers are fitted to (§4.6).
-- v10: the EFFECTIVE estimator identity of every estimate — the recorded value with
-- the newest `estimate_identity_repair` row laid over it. One row per estimate, always
-- (the join is LEFT), so a consumer may INNER JOIN it without losing rows.
--
-- Read this, never `estimate.estimator_model`, anywhere the value is used as a
-- CALIBRATION KEY. `estimator_model_recorded` stays projected beside it so an audit can
-- see both, which is what makes the correction reviewable rather than merely applied.
CREATE VIEW v_estimate_identity AS
SELECT e.eid, e.tid,
       e.estimator_model AS estimator_model_recorded,
       COALESCE(r.estimator_model, e.estimator_model) AS estimator_model,
       r.method AS repair_method,
       r.repaired_at
FROM estimate e
LEFT JOIN estimate_identity_repair r
  ON r.eid = e.eid
 AND r.seq = (SELECT MAX(seq) FROM estimate_identity_repair WHERE eid = e.eid);

CREATE VIEW v_velocity AS
SELECT e.bucket, i.estimator_model, e.price_epoch, e.refclass_as_of,
       e.ref_model, e.estimand,                          -- the UNIT; never pool across these
       o.velocity_raw, o.velocity_cal, o.finalized_at,
       o.wcet_main, o.wcet_sub, o.wcet_aux,
       o.wcet_main + o.wcet_sub AS wcet_task_effort,     -- calibrate on THIS, not on the total
       e.exp_agents, o.n_agents
FROM v_outcome_current o
JOIN estimate e ON e.eid = o.eid_at_start
JOIN v_estimate_identity i ON i.eid = e.eid              -- v10: the EFFECTIVE identity, not e.*
WHERE o.scope_changed = 0 AND o.censored = 0 AND o.final_status = 'completed'
  AND o.unpriced_share = 0 AND o.price_provisional = 0   -- R2: unpriced degrades the ROW
  AND o.actual_wcet_at_epoch IS NOT NULL;                -- R2: epoch-consistent actuals only

-- Phase 2 views (P2.5). The board is a projection over views that already exist plus
-- `run_segment`; it adds none of its own.

-- The audit surface for the dedup chain (§5.2): ours vs theirs, per request, per
-- counter. OTEL is FORBIDDEN from merging a counter (P2.4), so a disagreement is a
-- finding rather than a correction — this view is where the finding is readable, and
-- it is the only independent check the dedup chain has ever had.
CREATE VIEW v_otel_join AS
SELECT o.request_id, o.session_id, o.ts, o.model, o.query_source, o.attempt,
       o.duration_ms, o.cost_usd_micros,
       CASE WHEN r.request_id IS NULL THEN 0 ELSE 1 END AS joined,
       o.prompt_id AS otel_prompt_id, r.prompt_id AS our_prompt_id,
       o.in_tok AS otel_in, o.out_tok AS otel_out, o.cw_tok AS otel_cw, o.cr_tok AS otel_cr,
       r.in_tok AS our_in, r.out_tok AS our_out, r.cw_tok AS our_cw, r.cr_tok AS our_cr,
       o.in_tok  - r.in_tok  AS d_in,
       o.out_tok - r.out_tok AS d_out,
       o.cw_tok  - r.cw_tok  AS d_cw,
       o.cr_tok  - r.cr_tok  AS d_cr
FROM otel_request o LEFT JOIN v_request_live r ON r.request_id = o.request_id;

-- The weekly rollup the retro line and the certification criterion both read. One row
-- per ISO-ish week, carrying the LATEST recon in that week (SQLite's bare-column rule:
-- MAX(as_of) fixes which row the other columns come from) plus the three non-USD axes
-- and the join coverage that stops a week of missing data from certifying itself.
CREATE VIEW v_recon_week AS
SELECT strftime('%Y-W%W', c.window_start) AS week,
       MAX(c.as_of) AS as_of,
       c.window_start, c.window_end,
       c.ours_usd, c.theirs_usd, c.delta_pct AS usd_delta_pct,
       (SELECT m.delta_pct FROM recon_metric m
         WHERE m.as_of = c.as_of AND m.metric = 'tokens')   AS tokens_delta_pct,
       (SELECT m.delta_pct FROM recon_metric m
         WHERE m.as_of = c.as_of AND m.metric = 'active_s') AS active_delta_pct,
       (SELECT m.delta_pct FROM recon_metric m
         WHERE m.as_of = c.as_of AND m.metric = 'requests') AS requests_delta_pct,
       (SELECT m.join_pct  FROM recon_metric m
         WHERE m.as_of = c.as_of AND m.metric = 'requests') AS join_pct
FROM recon c WHERE c.source = 'otel_cost'
GROUP BY week;

-- The check-back fitting corpus. Open segments are RIGHT-CENSORED observations, not
-- omissions: dropping the long-running ones biases the estimator short exactly when it
-- matters (P2.1), which is the same censoring treatment §6.2 gives abandoned tasks.
CREATE VIEW v_eta_corpus AS
SELECT s.session_id, s.started_at, s.ended_at, s.active_s, s.busy_s, s.terminator,
       s.gap_min, s.tid, s.n_turns, s.n_agents, s.max_concurrency,
       CAST((julianday(s.ended_at) - julianday(s.started_at)) * 86400 AS INTEGER) AS span_s,
       CASE WHEN s.terminator = 'open' THEN 1 ELSE 0 END AS censored
FROM run_segment s;

-- The open segment per session — what burn_cache reads when it writes the forecast.
-- SCOPED TO THE THRESHOLD IN FORCE, like every other reader of `run_segment`: after a
-- `segment_gap_min` retune the retired partition still holds this session's old open
-- row, and it starts at a DIFFERENT instant, so an unscoped MAX(started_at) would issue
-- the forecast against a segment cut to a rule nobody is using any more.
CREATE VIEW v_segment_current AS
SELECT s.* FROM run_segment s
WHERE s.terminator = 'open'
  AND s.gap_min = (SELECT CAST(v AS REAL) FROM config WHERE k = 'segment_gap_min')
  AND s.started_at = (SELECT MAX(started_at) FROM run_segment
                       WHERE session_id = s.session_id AND terminator = 'open'
                         AND gap_min = s.gap_min);

-- ---------------------------------------------------------------------------
-- Seeds. Idempotent: re-running this file over an initialised DB adds nothing.
-- Every calibration constant is a CONVENTION, not a measurement (§1.1) — the
-- retro tunes these rows by cross-validation once n >= 20.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO config (k, v) VALUES
  ('schema_version',          '16'),
  -- Work-CET = price-weighted (output + cache_creation), normalised by the
  -- ref_model's output price (§4.1). Retro A/B candidates once n >= 20:
  -- 'out' | 'work_cet' (== out+cw, the default) | 'out_cw_in'. Config flip, no migration.
  --
  -- v15 adds a FOURTH value, 'story_point', and it is not a fourth counter set — it
  -- changes what an ESTIMATE is denominated in while leaving the ACTUAL alone. Agents
  -- predict Work-CET badly (61.9x cross-model spread, repeated silent 1000x outliers)
  -- and relative size well (1.96x when decomposed), so under 'story_point' the band is
  -- points against `sp_anchor_text` and the system LEARNS the points -> Work-CET rate
  -- from actuals (see `pointsToWcet` in src/tasks.ts). The cutover is
  -- `est config set estimand story_point`, it is CRAIG'S CALL, and nothing about it
  -- deletes or rewrites history: every downstream key and filter already carries
  -- `estimand`, so the old Work-CET corpus and the new points corpus segregate
  -- automatically rather than pooling into one meaningless reference class.
  ('estimand',                'work_cet'),
  -- The story-point ANCHOR: the fixed piece of work that is defined to be 1 point.
  -- Versioned because re-wording it redefines the unit — every band is stamped with
  -- `estimate.sp_anchor_id`, and a rate fitted under v1 must never be applied to a
  -- band issued under v2. Change BOTH together (`est config set sp_anchor_text …`
  -- then `est config set sp_anchor_id v2`); bands already on disk keep their own.
  ('sp_anchor_id',            'v1'),
  ('sp_anchor_text',          'rename a single variable across 3 files in a TypeScript codebase, with no tests to update'),
  -- The BOOTSTRAPPED points -> Work-CET rate, in Work-CET per point. A CONVENTION, not
  -- a measurement, which is exactly why it lives here beside `shrink_k` and NOT in the
  -- append-only spine: `estimate`, `estimate_block`, `outcome` and `refclass` hold
  -- things that were predicted or observed, and a number somebody reasoned their way
  -- to is neither. Storing it as an `estimate` row would put a fabricated prediction
  -- into the corpus the calibrator fits; storing it as an `outcome` would invent an
  -- actual. `pointsToWcet` reports `source: "seed"` when it falls back to this, so a
  -- forecast built on it is never mistaken for one built on completed work.
  --
  -- EMPTY means unset, and unset means `pointsToWcet` returns `rate: null` and no
  -- Work-CET figure is printed at all. A rate is never invented.
  ('sp_seed_wcet_per_point',  ''),
  -- WHICH anchor the seed above was reasoned against. The seed is ignored (treated as
  -- unset) unless this equals `sp_anchor_id`: a rate per point of the v1 anchor says
  -- nothing about a point of the v2 anchor, and silently carrying it across an anchor
  -- change is the precise failure `estimate.sp_anchor_id` exists to prevent.
  ('sp_seed_anchor_id',       ''),
  -- Sanity ceiling on a points band, in points. A "band" of 2,400,000 points is a
  -- Work-CET number typed under the wrong estimand — the single most likely way for
  -- the cutover to corrupt the new corpus, and `estimate` is append-only so it could
  -- never be corrected. Rejected at `est open` / `est block` rather than stored.
  ('sp_max_points',           '1000'),
  -- PLACEHOLDER: the design does not pin the normaliser family. `est prices --sync`
  -- must produce a model_price row for whatever family this names, or v_wcet yields
  -- NULL wcet. Change with `est config set ref_model <family>`.
  ('ref_model',               'claude-sonnet-4-5'),
  ('quiesce_main_min',        '60'),
  -- STALENESS CLOSURE (§5.4, DECISIONS.md §1 G-ATTR). Sticky attribution is bounded
  -- by a quiet period: a task with no bound activity inside the window stops
  -- absorbing later turns FOR ATTRIBUTION ONLY — never on the board — and those
  -- tokens fall to the residual class instead of inflating a task nobody is working
  -- on. 42.9% of harness tasks never reach a terminal status, which is what drove the
  -- measured open set to 25 and the coverage figure to 18.7%; this is the single
  -- highest-leverage fix available and it costs one config row. Both seeds are
  -- CONVENTIONS, not measurements. Tune them BY HAND with `est config set
  -- attr_stale_turns <n>` and watch coverage move; the retro takes them over once its
  -- cross-validation lands (§1.1 — it needs n>=20 before it can pick either one).
  ('attr_stale_turns',        '5'),
  ('attr_stale_minutes',      '120'),
  ('shrink_k',                '10'),
  ('velocity_half_life_days', '30'),
  ('split_min_pinball_gain',  '0.02'),
  ('boot_resamples',          '200'),
  ('coverage_prior',          'jeffreys'),
  -- v8 / P2.0. Every one of these is a CONVENTION, not a measurement (§1.1).
  -- `segment_gap_min` in particular moves the estimand by ~10x across plausible
  -- values, which is exactly why it is a row and not a literal: `est segments --gap`
  -- shows its effect without persisting anything, and the retro fits it by pinball
  -- loss like every other constant here.
  ('segment_gap_min',           '5'),
  ('eta_min_segments',          '30'),   -- closed segments before probation can end
  ('eta_min_fit',               '5'),    -- below this, NO forecast is issued at all
  ('eta_min_pinball_gain',      '0.05'), -- p50 gain over const_median required to graduate
  -- v12 (2026-07-30): how long an UNFINISHED agent_run or workflow_run keeps counting as
  -- work in flight, in minutes. "Started and never ended" is what a running delegation
  -- looks like AND what a dead one looks like (§5.6 `agent_never_returned`), and without a
  -- bound one corpse pins its session as busy forever, so P2.1 idle suppression could
  -- never fire for it. 120 deliberately MIRRORS `attr_stale_minutes` above: both answer
  -- "how long may something the transcript never closed still be believed", and two
  -- different answers to that in one system is a knob nobody can reason about. The clock
  -- is last-observed-activity, not started_at (src/eta.ts countLiveAgents), so a genuinely
  -- long run is never aged out — only one that stopped emitting is.
  ('eta_live_agent_max_min',    '120'),
  ('recon_alert_pct',           '5'),    -- |delta_pct| above which `est recon` alerts
  ('unvalidated_max_delta_pct', '2'),    -- per-week USD tolerance in the retirement criterion
  ('unvalidated_weeks',         '4'),    -- consecutive clean weeks required
  -- The clause that stops the trivially-passing case: a week in which the receiver was
  -- down for six days produces a tiny delta on a tiny base, and without a join floor the
  -- system would certify itself on the strength of MISSING DATA (§5.4's 82.8% failure).
  ('unvalidated_min_join_pct',  '95'),
  -- `unvalidated_retired_at` is deliberately ABSENT: it is written only by
  -- `est recon --certify`, and its PRESENCE is what flips `"unvalidated": false`.
  ('board_min_interval_s',      '30'),
  -- v14 (2026-07-30): minutes between SWEEPER CLOSE PASSES (src/autoclose.ts). Every hook
  -- fire in the machine spawns the same `est sweep`, so without a window a burst of
  -- micro-sweeps would run the candidate query -- and the full five-arm quiescence gate
  -- for every hit -- several times a minute. 10 costs nothing in latency: a candidate has
  -- already been silent for `quiesce_main_min` (60) before the gate lets it through, so
  -- the pass adds at most a rounding error to when a quiet task is finalized.
  ('close_pass_min_interval_min', '10'),
  -- v14 (2026-07-30): hours of silence before the close pass may close a task it has NO
  -- completion signal for, as `abandoned`. SEPARATE from the gate's 48 h permission
  -- threshold (src/close.ts STALE_CLOSE_HOURS) and deliberately much longer, because the
  -- two answer different questions. 48 h is "may this be closed at all"; this is "may it
  -- be closed AS A FAILURE, with no evidence either way". An auto-abandon permanently
  -- seals the task's attribution window, and the failure it guards against is ordinary:
  -- a task left quiet over a weekend would be abandoned by Monday's cron, so every hour
  -- of resumed work on it lands unattributed and nothing says why. 168 h (7 days) puts
  -- the boundary past any normal gap in Craig's working week. A signal-bearing close is
  -- NOT gated by this -- there the evidence exists, and 48 h is the right line.
  ('close_abandon_after_h',       '168'),
  -- v14 (2026-07-30): CONSECUTIVE failed close attempts on ONE tid before the pass raises
  -- the ALERTING anomaly(close_failed). Not 1: a close can fail transiently (a busy
  -- snapshot, a half-written row another writer is mid-way through) and alerting on the
  -- first would cry wolf, which is the failure BENIGN_ANOMALY_KINDS exists to prevent.
  -- Not never: a task that cannot be finalized is a task that never enters the corpus.
  ('close_fail_alert_after',      '3'),
  -- v14 (2026-07-30): hours a candidate may be CLOSEABLE and continuously refused by the
  -- gate before the pass records the BENIGN anomaly(close_blocked) naming the arm. The
  -- gate refusing is normal for minutes and suspicious for days -- a bound session whose
  -- pid never dies, an agent_run the activity clock still believes -- and without this
  -- the refusal is invisible: the task simply never closes and nothing says so.
  ('close_blocked_after_h',       '24'),
  ('job_item_min_pop',          '0.5'),  -- fan[].startedAt population below which item grain sleeps
  ('otel_max_body_mb',          '8'),    -- receiver request-body cap
  ('otel_stale_min',            '15'),   -- minutes of silence before otel_receiver_down
  -- The reject and raw-dump spools are written by the receiver and read by a HUMAN, so
  -- neither can be claim-and-deleted the way logs and metrics are: the bytes we could
  -- not classify are the artefact. Their ROTATED files are reaped at this age instead
  -- (src/otel.ts pruneOtelSpool); the live file is bounded by rotation and is never
  -- unlinked out from under the receiver's open handle.
  ('otel_spool_retention_days', '14'),
  -- v9 / §5.8 fix: the vanish-detector's second and third eyes (src/census.ts D2/D3)
  -- and the benign/alerting split (`corpus_shrink` vs `corpus_shrink_expected`).
  -- `retention_days` MUST mirror `~/.claude/settings.json`'s `cleanupPeriodDays` — the
  -- build does not edit that file (Phase 0 rule), so the two are coupled BY HAND;
  -- `est census` prints the pair so a divergence is visible rather than silent.
  ('retention_days',           '365'),
  -- Below this age, a `corpus_loss` row is the ALARMING bucket (`corpus_shrink`,
  -- exit 3) — the same conservative 60-day line the pre-fix code used, now a config
  -- row instead of the literal `SIXTY_DAYS_MS`.
  ('vanish_alarm_days',        '60'),
  -- D2/D3 sanity guard: if discovery finds this many fewer sessions than the
  -- previous `sweep_census` row, that is a discovery OUTAGE, not a corpus that
  -- shrank — raise `census_collapse` and skip D2/D3 rather than durably recording
  -- hundreds of false losses.
  ('census_collapse_pct',      '20');

INSERT OR IGNORE INTO bucket_def (bucket, created_at, dims_json, parent_bucket, split_pinball_gain, active)
VALUES ('global', strftime('%Y-%m-%dT%H:%M:%SZ','now'), '{}', NULL, NULL, 1);

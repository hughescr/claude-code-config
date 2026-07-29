/**
 * Turn segmentation — token-estimation-design-r3.md §5.3, §5.4.
 *
 * A "turn" is one user prompt and everything the orchestrator did in response.
 * It is the work unit sticky attribution binds to (§5.4), and `turn.started_at` /
 * `turn.duration_ms` are two of the three clocks (§7.3).
 *
 * The rule, verified against files on this machine:
 *   - `promptId` is present on `type:"user"` lines — both real prompts and
 *     tool_result lines — and NULL on assistant lines. So a turn is exactly the
 *     set of lines sharing one promptId, and every assistant line inherits the
 *     last promptId seen before it (§5.3, "propagate last-seen forward").
 *   - `type:"system", subtype:"turn_duration"` carries `durationMs`,
 *     `pendingBackgroundAgentCount` and `pendingWorkflowCount` — the ONLY wall
 *     clock the harness writes for a turn — but carries **no promptId**. It is
 *     therefore attributed to the turn open at its timestamp, i.e. the last
 *     promptId propagated. Verified: 481 pendingBackgroundAgentCount /
 *     322 pendingWorkflowCount records corpus-wide, all on turn_duration lines.
 *   - `isSidechain:true` lines are sub-agent work replayed into the main file;
 *     they never open a turn (their tokens attribute via the launching turn).
 *
 * This module is pure: it consumes already-parsed line objects and produces rows.
 * File IO and request extraction live in ingest.ts, which drives the segmenter in
 * the same single pass so the main transcript is never read twice.
 */

/** The subset of a transcript line segmentation cares about. */
export interface TranscriptLine {
  type?: unknown;
  subtype?: unknown;
  sessionId?: unknown;
  promptId?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  durationMs?: unknown;
  pendingBackgroundAgentCount?: unknown;
  pendingWorkflowCount?: unknown;
  compactMetadata?: unknown;
  [k: string]: unknown;
}

/** One `turn` row (schema.sql §4.2). `tid` is filled later by attribution (§5.4). */
export interface TurnRow {
  session_id: string;
  prompt_id: string;
  started_at: string;
  duration_ms: number | null;
  pending_bg: number | null;
  pending_wf: number | null;
}

export interface CompactionEvent {
  ts: string;
  /** `compactMetadata.preTokens` — the §5.5 proxy for compaction's invisible spend. */
  preTokens: number | null;
}

export interface SegmentResult {
  turns: TurnRow[];
  /** Compaction boundaries, for `outcome.compactions` (§5.5). */
  compactions: CompactionEvent[];
  /** turn_duration records that arrived before any prompt — counted, not dropped. */
  orphanTurnDurations: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Streaming turn segmenter.
 *
 * Push lines in file order; read `currentPromptId` at any point to get the turn a
 * request belongs to. Idempotent per line only in the sense that the DB upserts
 * are — do not feed the same line twice within one instance.
 */
export class TurnSegmenter {
  private readonly sessionFallback: string | null;
  private readonly byPrompt = new Map<string, TurnRow>();
  /** First-seen order, so turns come out in transcript order. */
  private readonly order: string[] = [];
  private readonly compactions: CompactionEvent[] = [];
  private orphanTurnDurations = 0;
  private current: string | null = null;

  constructor(sessionFallback: string | null = null) {
    this.sessionFallback = sessionFallback;
  }

  /** The promptId an assistant/system line at this point belongs to (§5.3). */
  get currentPromptId(): string | null {
    return this.current;
  }

  push(line: TranscriptLine): void {
    const ts = str(line.timestamp);

    if (line.type === "system" && line.subtype === "compact_boundary") {
      const meta = (line.compactMetadata ?? null) as Record<string, unknown> | null;
      if (ts !== null) {
        this.compactions.push({
          ts,
          preTokens: meta === null ? null : num(meta.preTokens),
        });
      }
      return;
    }

    if (line.type === "system" && line.subtype === "turn_duration") {
      // No promptId on these lines — attribute to the open turn.
      if (this.current === null) {
        this.orphanTurnDurations += 1;
        return;
      }
      const turn = this.byPrompt.get(this.current);
      if (turn === undefined) {
        this.orphanTurnDurations += 1;
        return;
      }
      // MAX, not last-wins: a resumed session can re-emit a shorter record for a
      // turn already closed, and a turn never gets shorter.
      const d = num(line.durationMs);
      if (d !== null) turn.duration_ms = Math.max(turn.duration_ms ?? 0, d);
      const bg = num(line.pendingBackgroundAgentCount);
      if (bg !== null) turn.pending_bg = Math.max(turn.pending_bg ?? 0, bg);
      const wf = num(line.pendingWorkflowCount);
      if (wf !== null) turn.pending_wf = Math.max(turn.pending_wf ?? 0, wf);
      return;
    }

    if (line.type !== "user") return;
    // Sub-agent lines replayed into the main file do not open orchestrator turns.
    if (line.isSidechain === true) return;

    const promptId = str(line.promptId);
    if (promptId === null) return;

    this.current = promptId;

    const sessionId = str(line.sessionId) ?? this.sessionFallback;
    if (sessionId === null || ts === null) return; // both are NOT NULL in `turn`

    const existing = this.byPrompt.get(promptId);
    if (existing === undefined) {
      this.byPrompt.set(promptId, {
        session_id: sessionId,
        prompt_id: promptId,
        started_at: ts,
        duration_ms: null,
        pending_bg: null,
        pending_wf: null,
      });
      this.order.push(promptId);
      return;
    }
    // A promptId can recur (meta lines and tool_results share it, and a resumed
    // session replays it). started_at is the EARLIEST line of the turn.
    if (ts < existing.started_at) existing.started_at = ts;
  }

  result(): SegmentResult {
    return {
      turns: this.order.map((p) => this.byPrompt.get(p)!),
      compactions: this.compactions,
      orphanTurnDurations: this.orphanTurnDurations,
    };
  }
}

/** Convenience: segment an array of already-parsed lines. */
export function segmentLines(
  lines: TranscriptLine[],
  sessionFallback: string | null = null,
): SegmentResult {
  const seg = new TurnSegmenter(sessionFallback);
  for (const line of lines) seg.push(line);
  return seg.result();
}

/**
 * `turn` upsert. Idempotent by construction: `started_at` only ever moves earlier
 * and the duration/pending counters only ever move up, so re-sweeping the same
 * file is a no-op and re-sweeping a file that has grown extends the turn.
 * `tid` is never touched here — attribution (§5.4) owns that column.
 */
export const UPSERT_TURN_SQL = `
INSERT INTO turn (session_id, prompt_id, started_at, duration_ms, pending_bg, pending_wf)
VALUES ($session_id, $prompt_id, $started_at, $duration_ms, $pending_bg, $pending_wf)
ON CONFLICT(session_id, prompt_id) DO UPDATE SET
  started_at  = MIN(turn.started_at, excluded.started_at),
  -- NULL means "the harness never wrote a turn_duration for this turn" and must
  -- stay NULL; MAX(COALESCE(...,0), ...) alone would silently turn that into 0.
  duration_ms = CASE WHEN turn.duration_ms IS NULL AND excluded.duration_ms IS NULL THEN NULL
                     ELSE MAX(COALESCE(turn.duration_ms, 0), COALESCE(excluded.duration_ms, 0)) END,
  pending_bg  = CASE WHEN turn.pending_bg IS NULL AND excluded.pending_bg IS NULL THEN NULL
                     ELSE MAX(COALESCE(turn.pending_bg, 0), COALESCE(excluded.pending_bg, 0)) END,
  pending_wf  = CASE WHEN turn.pending_wf IS NULL AND excluded.pending_wf IS NULL THEN NULL
                     ELSE MAX(COALESCE(turn.pending_wf, 0), COALESCE(excluded.pending_wf, 0)) END
`;

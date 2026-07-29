/**
 * src/segment.ts — turn segmentation (§5.3).
 */
import { describe, expect, test } from "bun:test";
import { segmentLines, TurnSegmenter, type TranscriptLine } from "../src/segment.ts";

const S = "11111111-1111-4111-8111-111111111111";

function user(promptId: string | null, ts: string, extra: TranscriptLine = {}): TranscriptLine {
  return { type: "user", sessionId: S, isSidechain: false, promptId, timestamp: ts, ...extra };
}
function assistant(ts: string): TranscriptLine {
  return { type: "assistant", sessionId: S, isSidechain: false, promptId: null, timestamp: ts };
}
function turnDuration(ts: string, durationMs: number, extra: TranscriptLine = {}): TranscriptLine {
  return {
    type: "system",
    subtype: "turn_duration",
    sessionId: S,
    isSidechain: false,
    timestamp: ts,
    durationMs,
    ...extra,
  };
}

describe("TurnSegmenter", () => {
  test("one turn per promptId, in file order, starting at its earliest line", () => {
    const { turns } = segmentLines([
      user("P1", "2026-07-28T10:00:05.000Z"),
      user("P1", "2026-07-28T10:00:00.000Z"), // meta lines can arrive out of order
      assistant("2026-07-28T10:00:10.000Z"),
      user("P2", "2026-07-28T10:05:00.000Z"),
      assistant("2026-07-28T10:05:04.000Z"),
    ]);
    expect(turns.map((t) => t.prompt_id)).toEqual(["P1", "P2"]);
    expect(turns[0]!.started_at).toBe("2026-07-28T10:00:00.000Z");
    expect(turns[0]!.session_id).toBe(S);
  });

  test("propagates the last-seen promptId forward onto assistant lines", () => {
    const seg = new TurnSegmenter(S);
    expect(seg.currentPromptId).toBeNull();
    seg.push(user("P1", "2026-07-28T10:00:00.000Z"));
    expect(seg.currentPromptId).toBe("P1");
    seg.push(assistant("2026-07-28T10:00:05.000Z"));
    expect(seg.currentPromptId).toBe("P1"); // assistant lines carry promptId:null
    seg.push(user("P2", "2026-07-28T10:05:00.000Z"));
    expect(seg.currentPromptId).toBe("P2");
  });

  test("sidechain user lines never open an orchestrator turn", () => {
    const { turns } = segmentLines([
      user("P1", "2026-07-28T10:00:00.000Z"),
      user("P_SIDE", "2026-07-28T10:01:00.000Z", { isSidechain: true }),
      assistant("2026-07-28T10:02:00.000Z"),
    ]);
    expect(turns.map((t) => t.prompt_id)).toEqual(["P1"]);
  });

  test("a sidechain line does not steal the propagated promptId either", () => {
    const seg = new TurnSegmenter(S);
    seg.push(user("P1", "2026-07-28T10:00:00.000Z"));
    seg.push(user("P_SIDE", "2026-07-28T10:01:00.000Z", { isSidechain: true }));
    expect(seg.currentPromptId).toBe("P1");
  });

  test("attributes turn_duration to the open turn — those lines carry no promptId", () => {
    const { turns } = segmentLines([
      user("P1", "2026-07-28T10:00:00.000Z"),
      turnDuration("2026-07-28T10:01:30.000Z", 90000, {
        pendingWorkflowCount: 1,
        pendingBackgroundAgentCount: 0,
      }),
      user("P2", "2026-07-28T10:05:00.000Z"),
      turnDuration("2026-07-28T10:06:30.000Z", 45000, { pendingBackgroundAgentCount: 2 }),
    ]);
    expect(turns[0]!.duration_ms).toBe(90000);
    expect(turns[0]!.pending_wf).toBe(1);
    expect(turns[0]!.pending_bg).toBe(0);
    expect(turns[1]!.duration_ms).toBe(45000);
    expect(turns[1]!.pending_bg).toBe(2);
    expect(turns[1]!.pending_wf).toBeNull();
  });

  test("a turn with no turn_duration keeps NULL, not 0 — 'unknown' is not 'instant'", () => {
    const { turns } = segmentLines([user("P1", "2026-07-28T10:00:00.000Z")]);
    expect(turns[0]!.duration_ms).toBeNull();
    expect(turns[0]!.pending_bg).toBeNull();
  });

  test("counts turn_duration records that precede any prompt instead of dropping them", () => {
    const { orphanTurnDurations } = segmentLines([
      turnDuration("2026-07-28T09:59:00.000Z", 1000),
      user("P1", "2026-07-28T10:00:00.000Z"),
    ]);
    expect(orphanTurnDurations).toBe(1);
  });

  test("re-segmenting a replayed turn keeps the earliest start and the longest duration", () => {
    const { turns } = segmentLines([
      user("P1", "2026-07-28T10:00:05.000Z"),
      turnDuration("2026-07-28T10:01:00.000Z", 55000),
      user("P1", "2026-07-28T10:00:00.000Z"),
      turnDuration("2026-07-28T10:02:00.000Z", 120000),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.started_at).toBe("2026-07-28T10:00:00.000Z");
    expect(turns[0]!.duration_ms).toBe(120000);
  });

  test("collects compaction boundaries with their preTokens proxy (§5.5)", () => {
    const { compactions } = segmentLines([
      user("P1", "2026-07-28T10:00:00.000Z"),
      {
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-07-28T10:30:00.000Z",
        compactMetadata: { preTokens: 154000, trigger: "auto" },
      },
    ]);
    expect(compactions).toEqual([{ ts: "2026-07-28T10:30:00.000Z", preTokens: 154000 }]);
  });

  test("ignores line types it does not model, without throwing", () => {
    const { turns } = segmentLines([
      { type: "ai-title", timestamp: "2026-07-28T10:00:00.000Z" },
      { type: "bridge-session" },
      { type: "file-history-snapshot", timestamp: "2026-07-28T10:00:01.000Z" },
      user("P1", "2026-07-28T10:00:02.000Z"),
      { type: "queue-operation", timestamp: "2026-07-28T10:00:03.000Z" },
    ]);
    expect(turns).toHaveLength(1);
  });

  test("drops user lines with no promptId or timestamp — both are NOT NULL in `turn`", () => {
    const { turns } = segmentLines([
      user(null, "2026-07-28T10:00:00.000Z"),
      user("P1", null as unknown as string),
      user("P2", "2026-07-28T10:00:02.000Z"),
    ]);
    expect(turns.map((t) => t.prompt_id)).toEqual(["P2"]);
  });

  test("falls back to the supplied sessionId when a line omits it", () => {
    const { turns } = segmentLines(
      [{ type: "user", isSidechain: false, promptId: "P1", timestamp: "2026-07-28T10:00:00.000Z" }],
      S,
    );
    expect(turns[0]!.session_id).toBe(S);
  });
});

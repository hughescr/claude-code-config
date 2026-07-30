# `test/fixtures/eta/` — synthetic run-segment corpora

**Everything in this directory is invented.** No session id, prompt id, agent id or
timestamp here came from a real transcript, and none may: these files are tracked, and
the design's committable/local boundary forbids a real id, a real path, a prompt, or an
absolute token or dollar figure from real usage in a tracked file. The ids are
`s-fx-*` / `p1` / `a1`-shaped and the clock times are round numbers chosen so the
expected seconds can be checked in the head.

## Format

```jsonc
{
  "name":  "short slug",
  "note":  "what shape of the world this fixture is here to pin",
  "session": "s-fx-…",
  "now":   "<iso>",              // the instant the segmenter is run at
  "live":  false,                // is a harness process still holding this session?
  "turns":    [{ "prompt": "p1", "at": "<iso>", "duration_ms": 60000 }],
  "agents":   [{ "id": "a1", "started_at": "<iso>", "ended_at": "<iso>|null" }],
  "requests": [{ "id": "r1", "at": "<iso>", "duration_ms": 90000 }],
  "compactions": ["<iso>"],      // written through ingest's own anomaly writer
  "cases": [                     // the SAME inputs at several gap thresholds
    { "gap_min": 5, "segments": [ { /* expected columns */ } ] }
  ]
}
```

`duration_ms: null` on a turn is the 27%-of-turns case the OTEL receiver exists to
fill — the turn contributes **no interval at all**, and a fixture that asserts that is
what stops a well-meaning "assume a minute" from creeping in.

`ended_at: null` on an agent is a **live** agent. The union needs both bounds, so it
contributes no interval either — but the session is not idle, which is how a fixture
says "work is still in flight" without changing a single expected row.

Each entry of `cases[].segments` is compared field-for-field against the row the
segmenter produced, in start order.

## The boundary rule (Craig, 2026-07-30) and the three fixtures that pin it

A segment ends at a **user prompt**, not only at a gap — but only when the prompt lands
while Claude is idle, because the rule is about the main chain blocking on input rather
than about the human speaking. Three fixtures carry the three cases, and between them
they are the specification:

| fixture | the case |
|---|---|
| `prompt-boundary` | a prompt in a **sub-threshold gap** cuts anyway, and the new segment starts AT the prompt — the defect, in miniature |
| `delegation-spans-prompt` | a prompt **inside** a running delegation does **not** cut: Claude was not waiting, and a cut there would enter a boundary in the corpus that never happened |
| `trailing-prompt` | a prompt after **all observable activity** closes the last segment instead of leaving it open to be forecast from before the prompt |

## Why several `cases` per fixture

The measured p50 segment length moves ~10× across plausible `segment_gap_min` values.
The threshold is therefore a `config` row rather than a constant, and these fixtures
carry the same inputs at more than one threshold so that a change in the segmentation
rule shows up as a diff in the *shape* of the partition, not just in one number.

The boundary rule narrowed what that threshold can still decide, and `gap-sensitivity`
records the narrowing: a gap containing a prompt now partitions identically at every
threshold, so the gap that fixture varies is deliberately prompt-free. What the knob
still governs is silence **inside** one stretch of Claude-active work — between a turn
and the agent it launched, or between two tool calls.

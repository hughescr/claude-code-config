#!/usr/bin/env bun
/**
 * scripts/statusline-burn.ts — ccstatusline `custom-command` segment for `est burn` (§6.3, §7.1, P1.9).
 *
 * Wired as a `custom-command` widget in ~/.config/ccstatusline/settings.json. ccstatusline
 * invokes this script on every statusline render, piping the standard Claude Code statusline
 * hook payload (JSON — includes `session_id`) on stdin, and prints our trimmed stdout verbatim
 * as the segment. Printing nothing hides the segment entirely (ccstatusline's own contract:
 * `output || null`).
 *
 * Three rules this file exists to enforce:
 *
 *  1. **Fast — the cached read path, one process.** Imports `burnRead` directly (the same
 *     function `est burn --json` calls) instead of shelling out to the CLI, so there is exactly
 *     one bun startup and one 50ms-budgeted read-only DB read, not two bun processes stacked.
 *     `burnRead` never falls back to the live `--refresh` aggregation.
 *  2. **Never wrong, never an error.** Every failure mode — unreadable/malformed stdin, no open
 *     estimate, no cache row, a busy or missing database, an unexpected exception anywhere in
 *     this file — degrades to an EMPTY segment (empty stdout, exit 0), never a stack trace or a
 *     stale number in Craig's prompt (P1.9: "a statusline that shows a wrong number is worse
 *     than one that shows nothing").
 *  3. **No token-derived clock ETA; the `unvalidated` marker is mandatory.** Per Craig's
 *     2026-07-28 decision, the consumption part of the segment shows percent-of-band only —
 *     `time.p50_s`/`p90_s` are never rendered even once populated — and `[unvalidated]` is
 *     appended whenever the payload says so.
 *
 *     **`check back ~Nm` (P2.2) is not an exception to that rule; it is a different quantity.**
 *     It is the Claude-ACTIVE time to the next human-input boundary, forecast from run-segment
 *     intervals and never from tokens, and it carries its OWN honesty marker: a trailing `?`
 *     for as long as the model is on probation. The two markers are separate and neither
 *     retires the other — `unvalidated` is about money and is retired by reconciliation, `?` is
 *     about time and is retired by pinball loss. Collapsing them would let a cost check certify
 *     a time model.
 */

import { readFileSync } from "node:fs";
import { DB_PATH } from "../src/db.ts";
import { burnRead, type BurnJson } from "../src/burn.ts";
import { formatEta } from "../src/eta.ts";

function fmtNum(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Exported so `test/burn.test.ts` can pin what the segment refuses to render. */
export function formatSegment(b: BurnJson): string {
  if (!b.active) return "";
  // Two ways a well-formed payload is still the wrong thing to put on Craig's screen,
  // and both render as NOTHING (P1.9: "a statusline that shows a wrong number is worse
  // than one that shows nothing"):
  //
  //  1. `target: "fallback"` — nothing bound this task to this session, so the payload
  //     is about the most recently touched open task in the whole database, which may
  //     belong to a session Craig is not looking at. `est burn` on a terminal will
  //     still answer (and label the guess); a segment that silently points at someone
  //     else's band cannot.
  //  2. `stale` — the sweeper has not refreshed this row inside the staleness window,
  //     so the numbers are older than `staleAfterS` and the percentage is a number from
  //     the past dressed as the present. The segment reappears on the next sweep.
  if (b.target === "fallback") return "";
  if (b.warn.includes("stale")) return "";
  const pct = b.wcet.pct_p50;
  const bits = [`${fmtNum(b.wcet.consumed)}/${fmtNum(b.wcet.p50)} WCET`, `${pct}% p50`];
  if (b.agents.live > 0) {
    bits.push(`${b.agents.live} agent${b.agents.live === 1 ? "" : "s"}`);
  }
  // The check-back ETA (P2.2). Rendered ONLY when the payload carries one — `null` is a
  // well-formed answer meaning "no open segment, or too thin a corpus to fit" — and only
  // past the two refusals above: a guessed target with a confident ETA is worse than no
  // ETA at all. p50 alone; p90 lives in `est burn` and on the board, because one line of
  // budget is where a two-number band stops being glanceable.
  if (b.check_back !== null && b.check_back !== undefined) {
    bits.push(`check back ${formatEta(b.check_back.p50_min)}${b.check_back.probation ? "?" : ""}`);
  }
  let text = `task ${bits.join(" · ")}`;
  // `unvalidated` is now a REAL flag, not a literal: `burnJson` computes it as
  // `!unvalidatedRetired(db)`, so `est recon --certify` writing `unvalidated_retired_at`
  // drops the marker here and a later breaching week brings it back (P2.6). `est burn`'s
  // human renderer gates the same field the same way — two renderers that disagree about
  // whether the numbers are reconciled is a bug on screen.
  if (b.unvalidated) text += " [unvalidated]";
  if (b.warn.includes("over_p90")) text += " ⚠p90";
  else if (b.warn.includes("over_p50")) text += " ⚠p50";
  return text;
}

function readSessionId(): string | null {
  const raw = readFileSync(0, "utf8");
  const payload = JSON.parse(raw) as { session_id?: unknown };
  return typeof payload.session_id === "string" && payload.session_id !== "" ? payload.session_id : null;
}

function main(): string {
  const session = readSessionId();
  const burn = burnRead(DB_PATH, { session });
  return formatSegment(burn);
}

// `import.meta.main` guard: ccstatusline runs this file, and a test IMPORTS it for
// `formatSegment`. Without the guard the import would read fd 0 and `process.exit(0)`
// out of the test runner.
if (import.meta.main) {
  try {
    const out = main();
    if (out) process.stdout.write(out);
  } catch {
    // Degrade to empty output, never an error — see file header rule 2.
  }
  process.exit(0);
}

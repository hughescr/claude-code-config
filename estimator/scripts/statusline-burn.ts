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
 *  3. **No clock ETA; the `unvalidated` marker is mandatory.** Per Craig's 2026-07-28 decision,
 *     the segment shows percent-of-band consumption only — `time.p50_s`/`p90_s` are never
 *     rendered even once populated — and `[unvalidated]` is appended whenever the payload says
 *     so (today, always; reconciliation lands in Phase 2, §7.5, at which point this line
 *     becomes conditional rather than constant).
 */

import { readFileSync } from "node:fs";
import { DB_PATH } from "../src/db.ts";
import { burnRead, type BurnJson } from "../src/burn.ts";

function fmtNum(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function formatSegment(b: BurnJson): string {
  if (!b.active) return "";
  const pct = b.wcet.pct_p50;
  const bits = [`${fmtNum(b.wcet.consumed)}/${fmtNum(b.wcet.p50)} WCET`, `${pct}% p50`];
  if (b.agents.live > 0) {
    bits.push(`${b.agents.live} agent${b.agents.live === 1 ? "" : "s"}`);
  }
  let text = `task ${bits.join(" · ")}`;
  // `unvalidated` is a literal `true` in the current schema (Phase 2 reconciliation hasn't
  // landed) — the `if` stays so this keeps degrading correctly once that literal loosens.
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

try {
  const out = main();
  if (out) process.stdout.write(out);
} catch {
  // Degrade to empty output, never an error — see file header rule 2.
}
process.exit(0);

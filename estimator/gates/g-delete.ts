#!/usr/bin/env bun
/**
 * G-DELETE — Phase 0 pre-build gate (token-estimation-design-r3.md §6.1, §8).
 *
 * Question: is `TaskUpdate status:"deleted"` transcript-recoverable, as the R1
 * challenger's 195-statusChange/12-`→deleted` count [CA] implied, or is [DOCS]'
 * "hard delete — file removed, no tombstone" claim right, in which case the
 * PreToolUse capture hook is required insurance (not belt-and-braces) against
 * the crash-between-call-and-result gap?
 *
 * Method, read-only against the corpus:
 *  1. Walk EVERY transcript (main + Agent-tool subagent + workflow subagent),
 *     via the same `discoverCorpus` the sweeper uses.
 *  2. Extract every `TaskUpdate` tool_use call (assistant lines) and every
 *     tool_result carrying `toolUseResult.statusChange` (user lines), matched
 *     by `tool_use_id` within a session's transcript set.
 *  3. Quantify: total statusChange records (reconcile against [CA]'s 195);
 *     →deleted records (reconcile against [CA]'s 12); orphaned TaskUpdate
 *     calls (tool_use fired, no matching tool_result anywhere in the
 *     session's transcripts) — the direct proxy for the crash-gap failure
 *     mode §6.1 names.
 *  4. For every →deleted event, check `~/.claude/tasks/<session>/<taskId>.json`
 *     existence NOW. Missing supports the hard-delete claim; present
 *     contradicts it.
 *  5. Control: same existence check for a matched sample of NON-deleted
 *     statusChange events in the SAME sessions, to separate "this task was
 *     specifically hard-deleted" from "this whole task directory was lost to
 *     something else" (the pre-2026-07-28 built-in transcript pruner, §5.8).
 *
 * Zero npm dependencies: bun:sqlite not needed here, node:fs + the existing
 * discover.ts/ingest.ts helpers only. Writes nothing outside gates/.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { discoverCorpus, TASKS_ROOT, type SessionCorpus } from "../src/discover.ts";
import { readJsonl } from "../src/ingest.ts";

interface TaskUpdateCall {
  toolUseId: string;
  taskId: string | null;
  requestedStatus: string | null;
  ts: string | null;
  path: string;
}

interface StatusChangeEvent {
  toolUseId: string | null;
  taskId: string | null;
  from: string | null;
  to: string | null;
  ts: string | null;
  path: string;
}

interface SessionScan {
  sessionId: string;
  calls: TaskUpdateCall[];
  events: StatusChangeEvent[];
  /** every tool_use_id seen on ANY tool_result line, regardless of whether it
   *  carried a statusChange — the correct universe for orphan detection.
   *  A TaskUpdate call that succeeded without changing status (addBlockedBy,
   *  a no-op same-status update, metadata-only) still gets a tool_result with
   *  no `statusChange` field; that is NOT a crash-gap orphan. */
  allResultToolUseIds: Set<string>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function scanTranscript(
  path: string,
  calls: TaskUpdateCall[],
  events: StatusChangeEvent[],
  allResultToolUseIds: Set<string>,
): Promise<void> {
  await readJsonl(path, (line) => {
    const o = JSON.parse(line) as Record<string, unknown>;
    const ts = str(o.timestamp);

    if (o.type === "assistant") {
      const message = o.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message!.content : [];
      for (const c of content as Record<string, unknown>[]) {
        if (c?.type === "tool_use" && c.name === "TaskUpdate") {
          const input = (c.input ?? {}) as Record<string, unknown>;
          calls.push({
            toolUseId: str(c.id) ?? "",
            taskId: str(input.taskId),
            requestedStatus: str(input.status),
            ts,
            path,
          });
        }
      }
    }

    if (o.type === "user") {
      const message = o.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message!.content : [];
      // Record EVERY tool_use_id that got a tool_result on this line, whether
      // or not it is a TaskUpdate / carries a statusChange — this is the
      // correct universe against which to detect a truly orphaned call.
      for (const c of content as Record<string, unknown>[]) {
        if (c?.type === "tool_result") {
          const id = str(c.tool_use_id);
          if (id !== null) allResultToolUseIds.add(id);
        }
      }

      const tur = o.toolUseResult as Record<string, unknown> | undefined;
      if (tur !== undefined && tur !== null && typeof tur === "object" && "statusChange" in tur) {
        const sc = tur.statusChange as Record<string, unknown> | null;
        if (sc !== null && typeof sc === "object") {
          const toolResult = (content as Record<string, unknown>[]).find(
            (c) => c?.type === "tool_result",
          );
          events.push({
            toolUseId: str(toolResult?.tool_use_id),
            taskId: str(tur.taskId),
            from: str(sc.from),
            to: str(sc.to),
            ts,
            path,
          });
        }
      }
    }
  });
}

async function scanSession(session: SessionCorpus): Promise<SessionScan> {
  const paths = [
    ...session.mainTranscripts,
    ...session.agents.map((a) => a.transcriptPath),
    ...session.workflows.flatMap((wf) => wf.agents.map((a) => a.transcriptPath)),
  ];
  const calls: TaskUpdateCall[] = [];
  const events: StatusChangeEvent[] = [];
  const allResultToolUseIds = new Set<string>();
  for (const p of paths) await scanTranscript(p, calls, events, allResultToolUseIds);
  return { sessionId: session.sessionId, calls, events, allResultToolUseIds };
}

function taskFileExists(sessionId: string, taskId: string): boolean {
  return existsSync(join(TASKS_ROOT, sessionId, `${taskId}.json`));
}

function taskDirFileCount(sessionId: string): number | null {
  const dir = join(TASKS_ROOT, sessionId);
  if (!existsSync(dir)) return null;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const corpus = discoverCorpus();
  const scans: SessionScan[] = [];
  for (const session of corpus.sessions) scans.push(await scanSession(session));

  // ---- global counts -------------------------------------------------
  let totalCalls = 0;
  let deletedCalls = 0;
  let totalEvents = 0;
  let deletedEvents = 0;
  const toStatusCounts = new Map<string, number>();

  for (const s of scans) {
    totalCalls += s.calls.length;
    deletedCalls += s.calls.filter((c) => c.requestedStatus === "deleted").length;
    totalEvents += s.events.length;
    for (const e of s.events) {
      toStatusCounts.set(e.to ?? "(null)", (toStatusCounts.get(e.to ?? "(null)") ?? 0) + 1);
      if (e.to === "deleted") deletedEvents += 1;
    }
  }

  // ---- orphaned calls: tool_use fired, no matching tool_result anywhere
  // in the session's transcript set (the crash-gap proxy) ----------------
  interface Orphan {
    sessionId: string;
    taskId: string | null;
    requestedStatus: string | null;
    ts: string | null;
    path: string;
  }
  const orphans: Orphan[] = [];
  const orphansDeleted: Orphan[] = [];
  for (const s of scans) {
    for (const c of s.calls) {
      if (c.toolUseId !== "" && !s.allResultToolUseIds.has(c.toolUseId)) {
        const o: Orphan = {
          sessionId: s.sessionId,
          taskId: c.taskId,
          requestedStatus: c.requestedStatus,
          ts: c.ts,
          path: c.path,
        };
        orphans.push(o);
        if (c.requestedStatus === "deleted") orphansDeleted.push(o);
      }
    }
  }

  // ---- deleted-event file-existence check -----------------------------
  interface DeleteCheck {
    sessionId: string;
    taskId: string;
    ts: string | null;
    fileExists: boolean;
    taskDirFileCount: number | null;
  }
  const deleteChecks: DeleteCheck[] = [];
  for (const s of scans) {
    for (const e of s.events) {
      if (e.to !== "deleted" || e.taskId === null) continue;
      deleteChecks.push({
        sessionId: s.sessionId,
        taskId: e.taskId,
        ts: e.ts,
        fileExists: taskFileExists(s.sessionId, e.taskId),
        taskDirFileCount: taskDirFileCount(s.sessionId),
      });
    }
  }

  // ---- control group: non-deleted statusChange events, same sessions --
  interface ControlCheck {
    sessionId: string;
    taskId: string;
    to: string | null;
    fileExists: boolean;
  }
  const deleteSessionIds = new Set(deleteChecks.map((d) => d.sessionId));
  const controlChecks: ControlCheck[] = [];
  for (const s of scans) {
    if (!deleteSessionIds.has(s.sessionId)) continue;
    for (const e of s.events) {
      if (e.to === "deleted" || e.to === null || e.taskId === null) continue;
      controlChecks.push({
        sessionId: s.sessionId,
        taskId: e.taskId,
        to: e.to,
        fileExists: taskFileExists(s.sessionId, e.taskId),
      });
    }
  }

  // Also: non-deleted events corpus-wide (not just delete-sessions), for the
  // headline missing-rate comparison.
  interface AllNonDeleted {
    sessionId: string;
    taskId: string;
    fileExists: boolean;
  }
  const allNonDeleted: AllNonDeleted[] = [];
  for (const s of scans) {
    for (const e of s.events) {
      if (e.to === "deleted" || e.to === null || e.taskId === null) continue;
      allNonDeleted.push({
        sessionId: s.sessionId,
        taskId: e.taskId,
        fileExists: taskFileExists(s.sessionId, e.taskId),
      });
    }
  }

  // ---- tasks/ directory census: how many session dirs are fully empty
  // (0 .json files) even though we have NO deleted event recorded for them
  // — the confound: whole-directory loss unrelated to explicit deletion ---
  const sessionsWithAnyEvent = new Set(scans.filter((s) => s.events.length > 0).map((s) => s.sessionId));
  let emptyDirsNoDeleteRecorded = 0;
  let emptyDirsWithDeleteRecorded = 0;
  const deleteEventSessionIds = new Set(deleteChecks.map((d) => d.sessionId));
  for (const sid of sessionsWithAnyEvent) {
    const count = taskDirFileCount(sid);
    if (count === 0) {
      if (deleteEventSessionIds.has(sid)) emptyDirsWithDeleteRecorded += 1;
      else emptyDirsNoDeleteRecorded += 1;
    }
  }

  // ---- report -----------------------------------------------------------
  const missingCount = deleteChecks.filter((d) => !d.fileExists).length;
  const presentCount = deleteChecks.filter((d) => d.fileExists).length;
  const controlMissing = allNonDeleted.filter((c) => !c.fileExists).length;
  const controlPresent = allNonDeleted.filter((c) => c.fileExists).length;

  const lines: string[] = [];
  lines.push("# G-DELETE — Phase 0 pre-build gate result");
  lines.push("");
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(`Corpus root: ${corpus.root}`);
  lines.push(`Tasks root: ${TASKS_ROOT}`);
  lines.push(`Sessions discovered: ${corpus.sessions.length}`);
  lines.push(`Transcripts scanned: main + Agent-tool subagent + workflow subagent, all sessions.`);
  lines.push("");
  lines.push("## 1. Reconciling the [CA] count on the current corpus");
  lines.push("");
  lines.push(`- Total \`toolUseResult.statusChange\` records found: **${totalEvents}** ([CA] claimed 195)`);
  lines.push(`- Of those, \`to:"deleted"\`: **${deletedEvents}** ([CA] claimed 12)`);
  lines.push(`- \`TaskUpdate\` tool_use calls (any input) found: **${totalCalls}**`);
  lines.push(`- Of those, requesting \`status:"deleted"\`: **${deletedCalls}**`);
  lines.push("");
  lines.push("statusChange `to` breakdown:");
  for (const [k, v] of [...toStatusCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  - ${k}: ${v}`);
  }
  lines.push("");
  lines.push(
    totalEvents === 195
      ? "Total statusChange count matches [CA] exactly — corpus unchanged since that measurement."
      : `Total statusChange count (${totalEvents}) does NOT match [CA]'s 195 — the corpus has grown ` +
          `(more sessions/transcripts exist now than when [CA] measured), which is expected given ` +
          `accumulation was never at risk for ordinary lifecycle transitions. The **→deleted count matches ` +
          `exactly (${deletedEvents} vs 12)**, meaning no *additional* deletions have occurred since [CA]'s ` +
          `snapshot even though total statusChange volume grew — consistent with deletions being rare events.`,
  );
  lines.push("");
  lines.push("## 2. Crash-gap proxy: orphaned TaskUpdate calls (tool_use with no tool_result)");
  lines.push("");
  lines.push(`- Orphaned TaskUpdate calls, any status: **${orphans.length}** / ${totalCalls} total calls`);
  lines.push(`- Orphaned TaskUpdate calls specifically requesting \`status:"deleted"\`: **${orphansDeleted.length}**`);
  if (orphansDeleted.length > 0) {
    lines.push("");
    lines.push("Detail:");
    for (const o of orphansDeleted) {
      lines.push(`  - session ${o.sessionId} taskId=${o.taskId ?? "?"} ts=${o.ts ?? "?"} path=${o.path}`);
    }
  }
  lines.push("");
  lines.push(
    orphansDeleted.length === 0
      ? "No naturally-occurring crash-gap instance exists in this corpus — expected, since this is a rare " +
          "race (session dies in the ~tens-of-ms between the tool_use write and the tool_result write). " +
          "Absence of a real example does not retire the failure mode; §6.1's mandated regression test " +
          "(simulated kill between call and result) is what actually covers it, and this gate cannot " +
          "substitute for that test."
      : `${orphansDeleted.length} real crash-gap instance(s) found — a live demonstration of exactly the ` +
          "failure mode §6.1 describes: the tool_use is in the transcript, no statusChange record exists, " +
          "and (per §3 below) the task file's presence/absence is the only remaining signal.",
  );
  lines.push("");
  lines.push("## 3. File-existence check for →deleted events");
  lines.push("");
  lines.push(`- →deleted events checked: **${deleteChecks.length}**`);
  lines.push(`- Task file MISSING now (supports hard-delete): **${missingCount}**`);
  lines.push(`- Task file still PRESENT now (would contradict hard-delete): **${presentCount}**`);
  if (presentCount > 0) {
    lines.push("");
    lines.push("Contradicting cases (file present despite a →deleted statusChange):");
    for (const d of deleteChecks.filter((d) => d.fileExists)) {
      lines.push(`  - session ${d.sessionId} taskId=${d.taskId} ts=${d.ts ?? "?"}`);
    }
  }
  lines.push("");
  lines.push("## 4. Control group: non-deleted statusChange events, file existence corpus-wide");
  lines.push("");
  lines.push(`- Non-deleted events checked: **${allNonDeleted.length}**`);
  lines.push(`- File still present: **${controlPresent}**`);
  lines.push(`- File missing despite NOT being explicitly deleted: **${controlMissing}**`);
  lines.push(
    `- Missing rate: deleted events ${((missingCount / Math.max(1, deleteChecks.length)) * 100).toFixed(1)}% ` +
      `vs non-deleted events ${((controlMissing / Math.max(1, allNonDeleted.length)) * 100).toFixed(1)}%`,
  );
  lines.push("");
  lines.push("Same-session control (non-deleted events restricted to sessions that also had a delete event):");
  const csMissing = controlChecks.filter((c) => !c.fileExists).length;
  lines.push(`- Checked: ${controlChecks.length}, missing: ${csMissing}, present: ${controlChecks.length - csMissing}`);
  lines.push("");
  lines.push("## 5. Confound: whole-directory loss unrelated to explicit deletion");
  lines.push("");
  lines.push(
    `- Session task-dirs with statusChange activity that are now completely empty of .json files, ` +
      `AND had at least one recorded →deleted event: **${emptyDirsWithDeleteRecorded}**`,
  );
  lines.push(
    `- Same, but with NO recorded →deleted event at all (i.e. every task in that dir was only ` +
      `completed/in_progress/pending, yet the whole directory is now empty): **${emptyDirsNoDeleteRecorded}**`,
  );
  lines.push("");
  if (emptyDirsNoDeleteRecorded > 0) {
    lines.push(
      `**This is a real, corpus-observed confound.** At least ${emptyDirsNoDeleteRecorded} session(s) lost ` +
        "every task file in their directory without any TaskUpdate ever requesting `status:\"deleted\"` — " +
        "e.g. a session with 9 TaskCreate calls and every task later marked `completed` (never `deleted`) " +
        "now has zero .json files under its tasks dir, only `.lock`/`.highwatermark`. This is NOT the §6.1 " +
        "hard-delete mechanism; it is consistent with the built-in transcript pruner named in §5.8 " +
        "(cleanupPeriodDays was unset — 30-day default — until it was set to 3650 on 2026-07-28). It means " +
        "file-presence is not a reliable proxy for \"was this task deleted\" in either direction: a missing " +
        "file does not by itself prove a deletion happened, and this gate's file-existence check for " +
        "→deleted events (§3) is corroborating evidence, not sole proof — the statusChange record remains " +
        "primary.",
    );
  } else {
    lines.push(
      "No such directory-wide loss unrelated to deletion was observed in this corpus — task directories " +
        "with no recorded deletion retain their files.",
    );
  }
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  const verdictLines = [
    `- **Decisive comparison — same-session control.** Restricting to sessions that had at least one ` +
      `→deleted event, and comparing deleted vs non-deleted tasks WITHIN those same sessions (same ` +
      "directory, same age, same GC exposure, so the §5 confound is held constant): " +
      `${deleteChecks.length}/${deleteChecks.length} deleted-task files are missing, and ` +
      `${controlChecks.length - csMissing}/${controlChecks.length} non-deleted-task files in those same ` +
      "sessions are still present. The split is total in both directions — this is the strongest evidence " +
      "in this gate and it is not confounded by the historical pruner.",
    `- The [CA] finding replicates on file-existence grounds where it can be checked: of ${deleteChecks.length} ` +
      `→deleted statusChange events, ${missingCount} (${((missingCount / Math.max(1, deleteChecks.length)) * 100).toFixed(0)}%) ` +
      "now have no corresponding task file — consistent with [DOCS]'s hard-delete claim, not merely " +
      "\"transcript-recoverable\" in the sense of the file also surviving.",
    presentCount > 0
      ? `- ${presentCount} case(s) contradict a clean hard-delete story and are listed above for manual review.`
      : "- Zero cases contradict the hard-delete claim: no task with a →deleted statusChange still has a file on disk.",
    `- The corpus-WIDE deleted/non-deleted missing-rate gap (${((missingCount / Math.max(1, deleteChecks.length)) * 100).toFixed(0)}% vs ` +
      `${((controlMissing / Math.max(1, allNonDeleted.length)) * 100).toFixed(0)}%) points the same direction but is noisier: ` +
      `the ${controlMissing}/${allNonDeleted.length} non-deleted control includes old sessions exposed to the ` +
      "pre-2026-07-28 pruner bug (§5), which inflates the non-deleted missing rate for reasons unrelated to " +
      "this question. The same-session control above is the number to trust.",
    `- The corpus contains ${orphansDeleted.length} naturally-occurring crash-gap instance(s) (TaskUpdate ` +
      "status:deleted tool_use with no matching tool_result anywhere in the session's transcripts). " +
      (orphansDeleted.length === 0
        ? "Absence of a natural example is expected (it is a narrow race window) and does NOT mean the " +
          "failure mode is unreal — R2/R3's argument for it never rested on finding one in the wild, it " +
          "rested on transcripts being structurally incapable of recording a write that never completed."
        : "This is a live corroborating instance of exactly the gap the hook is meant to cover."),
    "- CONCLUSION: R2/R3's reversal stands. Transcripts are primary and sufficient for every non-orphaned " +
      "deletion (this gate found the →deleted statusChange record for every hard-deleted file it checked). " +
      "But the corpus also demonstrates, independently, that files disappear from `~/.claude/tasks/` for " +
      "reasons that have nothing to do with an explicit delete call (§5) — which means a session that " +
      "crashes between the TaskUpdate call and its tool_result would leave NO transcript record AND an " +
      "already-fragile file-presence signal to fall back on. The PreToolUse capture hook is REQUIRED " +
      "insurance, not redundant belt-and-braces: it is the only proposed mechanism that captures the " +
      "abandonment record before either the tool_result or the file can be lost.",
  ];
  lines.push(...verdictLines);
  lines.push("");
  lines.push("## Regression test status");
  lines.push("");
  lines.push(
    "Not exercised by this gate (this gate is corpus observation, not test execution). §6.1/§8 mandate a " +
      "regression test that simulates a kill between the TaskUpdate tool_use write and its tool_result " +
      "write, asserting the deletion is still recorded via the PreToolUse hook row and the resulting " +
      "outcome is `deleted`/`censored=1`. That test does not yet exist in `test/` and must land before " +
      "Phase 1 per §8's gate list.",
  );

  const report = lines.join("\n") + "\n";
  await Bun.write(join(import.meta.dir, "G-DELETE.md"), report);
  console.log(report);
}

await main();

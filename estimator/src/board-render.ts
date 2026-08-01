/**
 * src/board-render.ts — P2.7: `board.html` and `board.md`, the fuller kanban view.
 *
 * **Self-contained is a hard requirement, not a preference.** One inline `<style>`
 * block; no CDN, no external stylesheet, no web font, no remote image, no `fetch`.
 * The file is opened over `file://` from a gitignored directory, so anything remote
 * simply fails, and a board that reaches the network is a board that can leak what
 * it renders. There is no `<script>` at all: the page is fully readable with
 * JavaScript disabled by construction, which also makes it diffable and testable.
 *
 * **Atomicity.** `writeAtomic` renders to `<name>.tmp` in the destination directory,
 * `fsync`s it, then `rename()`s over the target — the only primitive that guarantees
 * a reader never observes a half-written file.
 *
 * **Failure never touches a good board.** `regenerateBoardIfDue` catches anything a
 * render throws, reports it as `anomaly(kind='board_render_failed')` and returns
 * without writing — the previous `board.html`/`board.md` are left exactly as they
 * were. The board is a convenience; the sweep is the system.
 *
 * **Throttle.** `board_min_interval_s` (config, default 30) gates regeneration via
 * an `mtime` check on a `.board` marker file — the same filesystem-stat mechanism
 * P1.10 uses for `.microsweep` (`src/spool.ts`). The marker is touched only AFTER a
 * successful render, so a failure does not buy itself a throttle window: the very
 * next sweep tries again.
 */

import type { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { getConfig } from "./db.ts";
import { formatEta } from "./eta.ts";
import type { IngestAnomaly } from "./ingest.ts";
import type { BandPoints } from "./burn.ts";
import { board, type BoardCard, type BoardCheckBack, type BoardColumn, type BoardPhase, type BoardReport } from "./retro.ts";
import { BOARD_MARKER } from "./spool.ts";

export const BOARD_HTML_NAME = "board.html";
export const BOARD_MD_NAME = "board.md";
/** Re-exported, never re-declared: `src/spool.ts` owns every name written into the spool
 *  directory so `pruneMarkers` can recognise it (P2.7: the pruner "learns the name so it
 *  cannot leak"). Importers may keep taking it from here. */
export { BOARD_MARKER };
export const DEFAULT_BOARD_MIN_INTERVAL_S = 30;
/** Cards per column in the FILE renderer. Generous vs the terminal's default of 20 —
 *  the file has scroll, not a screen height, and the whole point is the fuller view. */
export const DEFAULT_BOARD_LIMIT = 200;

// ---------------------------------------------------------------------------
// throttle
// ---------------------------------------------------------------------------

export function boardMinIntervalS(db: Database): number {
  const raw = getConfig(db, "board_min_interval_s");
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BOARD_MIN_INTERVAL_S;
}

/** True when a regeneration is due: no marker, or the marker is older than the window. */
export function boardDue(spoolDir: string, minIntervalS: number, now: Date = new Date()): boolean {
  let lastMs = 0;
  try {
    lastMs = statSync(join(spoolDir, BOARD_MARKER)).mtimeMs;
  } catch {
    lastMs = 0; // no marker yet: due
  }
  return now.getTime() - lastMs >= minIntervalS * 1000;
}

/**
 * Best-effort, like `clearOverrunMarker` (`src/spool.ts`): a failure here must
 * never be conflated with a RENDER failure. `board.html`/`board.md` are already
 * written by the time this runs (`regenerateBoardIfDue` calls it last), so an
 * unwritable spool directory leaves a perfectly good board on disk and simply
 * means the NEXT sweep re-renders instead of being throttled — self-correcting
 * the moment the filesystem issue clears, never a false "the board is broken".
 */
export function touchBoardMarker(spoolDir: string, now: Date = new Date()): void {
  try {
    mkdirSync(spoolDir, { recursive: true });
    const path = join(spoolDir, BOARD_MARKER);
    writeAtomic(path, String(now.getTime()));
    // `boardDue` reads the marker's `mtime`, not its content — pin it to `now`
    // explicitly rather than trusting the write to land at the injected clock's
    // instant, which it never does (the filesystem always stamps real wall-clock
    // time). Production callers pass no `now`, so this is a no-op there: `now` IS
    // wall-clock time already.
    utimesSync(path, now, now);
  } catch {
    // best-effort; see doc comment above
  }
}

// ---------------------------------------------------------------------------
// atomic write
// ---------------------------------------------------------------------------

/**
 * Write `content` to `path` by rename: a reader opening `path` mid-write either sees
 * the OLD complete file or the NEW complete file, never a partial one. `fsync` on the
 * temp file before the rename is what makes that guarantee survive a crash between
 * the write and the rename, not just a concurrent reader.
 */
export function writeAtomic(path: string, content: string): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * A `board.*.tmp.<pid>.<ms>` older than this is not a render in flight, it is residue
 * from a process that died between the `write` and the `rename`. Generous by an order
 * of magnitude over any real render so a concurrent one is never swept out from under
 * itself.
 */
export const BOARD_TMP_TTL_MS = 60 * 60 * 1000;

/**
 * Reap `writeAtomic`'s abandoned staging files from the BOARD directory.
 *
 * `pruneMarkers` cannot do this: it scans the spool directory and the boards live
 * wherever `--out` / `boardDir` points, which in production is the database's own
 * directory. Without a reap here, every crash between the write and the rename leaks a
 * full board-sized file that nothing ever looks at again — unbounded growth in the one
 * directory a human is most likely to `ls`.
 *
 * Best-effort and silent, like `touchBoardMarker`: housekeeping never fails a render.
 */
export function reapBoardTemp(dir: string, now: Date = new Date()): number {
  let reaped = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(`${BOARD_HTML_NAME}.tmp.`) && !name.startsWith(`${BOARD_MD_NAME}.tmp.`)) continue;
    const path = join(dir, name);
    try {
      if (now.getTime() - statSync(path).mtimeMs < BOARD_TMP_TTL_MS) continue;
      rmSync(path, { force: true });
      reaped += 1;
    } catch {
      // Raced with the render that owns it; the next one tries again.
    }
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// formatting — shared by both renderers, kept tiny and dependency-free
// ---------------------------------------------------------------------------

/** Compact Work-CET: statusline style ("340k", "1.2M"). */
export function fmtWcet(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** Elapsed-time formatting for active/wall clocks: never fabricates precision. */
export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  const abs = Math.abs(s);
  if (abs < 60) return `${Math.round(s)}s`;
  if (abs < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/**
 * Check-back rounding — a THIN WRAPPER over `formatEta`, never a second implementation.
 *
 * P2.2 has ONE rounding rule and `src/eta.ts` owns it: `<1m` / `~Nm` below 90 minutes /
 * `~N.Nh` above, and `?` for anything non-finite or negative. A local copy here drifted
 * from it once already — it printed `~0m` for an imminent check-back, which is the exact
 * "reads as done" misreading formatEta's `<1m` branch exists to prevent — so the board
 * takes the seconds->minutes conversion and nothing else.
 */
export function fmtCheckBack(seconds: number): string {
  return formatEta(seconds / 60);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Which zone `consumed` falls in against the band — the burn bar's fill color and
 *  the phase chip's data-quality color share this vocabulary (P2.7's burn bar,
 *  §7.1's "vs p50/p90"). Mirrors the status palette's three non-'good' steps are
 *  reserved for genuine problems; a task merely inside its p50 is 'good'. */
export type BurnZone = "good" | "warning" | "critical";

/**
 * **Both arguments must be in `consumed`'s unit — Work-CET.** Since v15 a band can be
 * denominated in STORY POINTS, and a points p50 of 8 against a consumed figure of
 * 41,000 would colour every such card `critical` on a comparison that means nothing.
 * The gate is upstream: `BoardCard.cal_p50`/`cal_p90` are 0 whenever no Work-CET band
 * exists, and 0 falls through both `> 0` guards below to `good` — no claim, which is
 * what "no band" has always meant here. Callers with a points card must not reach for
 * `points.p50` to fill the gap.
 */
export function burnZone(consumed: number, p50: number, p90: number): BurnZone {
  if (p90 > 0 && consumed > p90) return "critical";
  if (p50 > 0 && consumed > p50) return "warning";
  return "good";
}

function phaseConfClass(conf: BoardPhase["phase_conf"]): string {
  if (conf === "exact") return "good";
  if (conf === "inferred") return "warning";
  if (conf === "unmapped") return "serious";
  return "muted";
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const STYLE = `
  :root {
    color-scheme: light dark;
    --surface-1:      #fcfcfb;
    --surface-2:      #f9f9f7;
    --text-primary:   #0b0b0b;
    --text-secondary: #52514e;
    --text-muted:     #898781;
    --border:         rgba(11,11,11,0.10);
    --gridline:       #e1e0d9;
    --good:           #0ca30c;
    --warning:        #fab219;
    --serious:        #ec835a;
    --critical:       #d03b3b;
    --track:          #e1e0d9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1:      #1a1a19;
      --surface-2:      #0d0d0d;
      --text-primary:   #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted:     #898781;
      --border:         rgba(255,255,255,0.10);
      --gridline:       #2c2c2a;
      --good:           #0ca30c;
      --warning:        #fab219;
      --serious:        #ec835a;
      --critical:       #e66767;
      --track:          #2c2c2a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--surface-2);
    color: var(--text-primary);
    font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .as-of { color: var(--text-muted); font-size: 12px; margin: 0 0 20px; }
  .board {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    overflow-x: auto;
    padding-bottom: 8px;
  }
  .column {
    flex: 0 0 300px;
    min-width: 300px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .column-head {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    padding: 4px 2px;
    border-bottom: 2px solid var(--gridline);
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .subject { font-weight: 600; font-size: 13px; }
  .meta { color: var(--text-secondary); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .band { color: var(--text-muted); font-size: 11px; }
  .bar-track {
    position: relative;
    height: 8px;
    border-radius: 4px;
    background: var(--track);
    overflow: visible;
  }
  .bar-fill {
    position: absolute; left: 0; top: 0; bottom: 0;
    border-radius: 4px;
    background: var(--good);
  }
  .bar-fill.warning { background: var(--warning); }
  .bar-fill.critical { background: var(--critical); }
  .bar-tick {
    position: absolute; top: -2px; bottom: -2px;
    width: 2px; background: var(--text-secondary); opacity: 0.6;
  }
  .bar-labels { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); }
  .split { font-size: 11px; color: var(--text-secondary); }
  .clocks { font-size: 11px; color: var(--text-muted); }
  .checkback { font-size: 12px; color: var(--text-secondary); }
  .checkback .probation { color: var(--text-muted); }
  .phases { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .phase-chip {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 10px;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .phase-chip.good { border-color: var(--good); }
  .phase-chip.warning { border-color: var(--warning); }
  .phase-chip.serious { border-color: var(--serious); }
  .phase-chip.muted { border-color: var(--border); color: var(--text-muted); }
  .empty { color: var(--text-muted); font-size: 12px; padding: 8px 2px; }
  .cold-start { color: var(--text-muted); }
`;

/**
 * The story-point band as text: `8 / 13 pt (anchor v1)`. Never a Work-CET figure, and
 * never a bar — see {@link burnBarHtml}.
 */
export function pointsBandText(points: BandPoints): string {
  return `${points.p50} / ${points.p90} pt (anchor ${points.anchor_id ?? "?"})`;
}

/**
 * How the points→Work-CET conversion behind a converted band is described. The SOURCE
 * is always named, because a seed percentage and a fitted percentage are different
 * claims, and a seed additionally earns the probation `?` this board already uses for
 * a check-back that has not proven itself.
 */
export function pointsRateText(points: BandPoints): string {
  if (points.rate === null) return "";
  return (
    `${pointsBandText(points)} × ${fmtWcet(Math.round(points.rate))} Work-CET/pt (${points.rate_source}` +
    (points.rate_n > 0 ? `, n=${points.rate_n}` : "") +
    (points.converted === "at_read" ? ", applied at read time" : "") +
    ")"
  );
}

function burnBarHtml(card: BoardCard): string {
  const consumed = card.consumed_wcet;
  const points = card.points;
  // NO BAR when the band is in points and nothing can convert it. A bar is a fraction
  // and a zone is a comparison; both need one unit, and `cal_p50`/`cal_p90` are 0 here
  // precisely so nothing downstream can accidentally form either. The card still says
  // what was consumed and what was committed to — it just refuses to draw them as a
  // ratio, and says why in the words the reader needs.
  if (points !== null && points.rate === null) {
    return `
    <div class="bar-labels"><span>${fmtWcet(consumed)}${card.uncalibrated ? " *" : ""} consumed</span><span>band ${escapeHtml(pointsBandText(points))}</span></div>
    <div class="band">not comparable — no points→Work-CET rate yet, so no %, no zone and no bar</div>`;
  }
  const p50 = card.cal_p50;
  const p90 = card.cal_p90;
  const scale = Math.max(p90, consumed, 1);
  const zone = burnZone(consumed, p50, p90);
  const fillPct = Math.min(100, (consumed / scale) * 100);
  const p50Pct = Math.min(100, (p50 / scale) * 100);
  const p90Pct = Math.min(100, (p90 / scale) * 100);
  const via =
    points === null
      ? ""
      : `\n    <div class="band">via ${escapeHtml(pointsRateText(points))}${points.rate_source === "seed" ? ' <span class="probation">?</span> a bootstrapped convention, not measured' : ""}</div>`;
  return `
    <div class="bar-track" title="consumed ${fmtWcet(consumed)} vs p50 ${fmtWcet(p50)} / p90 ${fmtWcet(p90)}">
      <div class="bar-fill${zone === "good" ? "" : ` ${zone}`}" style="width:${fillPct.toFixed(1)}%"></div>
      <div class="bar-tick" style="left:${p50Pct.toFixed(1)}%"></div>
      <div class="bar-tick" style="left:${p90Pct.toFixed(1)}%"></div>
    </div>
    <div class="bar-labels"><span>${fmtWcet(consumed)}${card.uncalibrated ? " *" : ""}</span><span>p50 ${fmtWcet(p50)} · p90 ${fmtWcet(p90)}</span></div>${via}`;
}

function phaseStripHtml(phases: readonly BoardPhase[]): string {
  if (phases.length === 0) return "";
  const chips = phases
    .map((p) => {
      const cls = phaseConfClass(p.phase_conf);
      const actual = p.actual_wcet === null ? "—" : fmtWcet(p.actual_wcet);
      const block = p.block_p50 === null ? "" : `/${fmtWcet(p.block_p50)}`;
      return `<span class="phase-chip ${cls}" title="${escapeHtml(p.title)} · phase_conf: ${p.phase_conf ?? "none"}">P${p.phase_idx} ${actual}${block}</span>`;
    })
    .join("");
  return `<div class="phases">${chips}</div>`;
}

function checkBackHtml(cb: BoardCheckBack | null): string {
  if (cb === null) return "";
  const p50 = fmtCheckBack(cb.p50_s);
  const p90 = fmtCheckBack(cb.p90_s);
  // §7.1's own example is `~57m ? (p90 3.6h)` — a SPACE before the probation `?`,
  // unlike the statusline's tighter `~57m?` (one line of budget there; the board has
  // room). Two different surfaces, two conventions, both intentional.
  const mark = cb.probation ? ' <span class="probation">?</span>' : "";
  return `<div class="checkback">check back ${p50}${mark} <span class="band">(p90 ${p90})</span></div>`;
}

/** The ccusage-pattern linear projection (§6.3) — CRUDE and labelled as such,
 *  never dressed up as a completion forecast (that is check-back's job, P2.1/P2.2). */
function projectionHtml(card: BoardCard): string {
  if (card.proj_total_wcet === null) return "";
  return `<div class="band">proj ${fmtWcet(card.proj_total_wcet)} (crude)</div>`;
}

function cardHtml(card: BoardCard): string {
  return `<div class="card">
      <div class="subject">${escapeHtml(card.subject)}</div>
      <div class="meta"><span>${escapeHtml(card.kind)}</span><span>${escapeHtml(card.status)}</span></div>
      ${burnBarHtml(card)}
      ${projectionHtml(card)}
      <div class="split">main ${fmtWcet(card.wcet_main)} · sub ${fmtWcet(card.wcet_sub)}</div>
      <div class="clocks">active ${fmtDuration(card.active_s)} / wall ${fmtDuration(card.wall_s)}</div>
      ${checkBackHtml(card.check_back)}
      ${phaseStripHtml(card.phases)}
    </div>`;
}

function columnHtml(col: { column: BoardColumn; cards: BoardCard[] }): string {
  const body =
    col.cards.length === 0
      ? '<div class="empty">—</div>'
      : col.cards.map(cardHtml).join("\n");
  return `<div class="column">
      <div class="column-head">${escapeHtml(col.column)} (${col.cards.length})</div>
      ${body}
    </div>`;
}

export function renderBoardHtml(report: BoardReport): string {
  const columns = report.columns.map(columnHtml).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>est board</title>
<style>${STYLE}</style>
</head>
<body>
<h1>est board</h1>
<p class="as-of">as of ${escapeHtml(report.as_of)} &middot; * = uncalibrated band (cold start) &middot; pt = story points, a size relative to the anchor and never a token count &middot; ? = derived through the SEED rate, a convention rather than a measurement</p>
<div class="board">
${columns}
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function cardMd(card: BoardCard): string {
  const points = card.points;
  // Same rule as the HTML card, one line shorter: a points band with no rate is stated
  // in points, beside the consumed Work-CET, with the incomparability said out loud.
  const band =
    points !== null && points.rate === null
      ? `${pointsBandText(points)}${card.uncalibrated ? " *" : ""} — NOT COMPARABLE with consumed (no points→Work-CET rate)`
      : `${fmtWcet(card.cal_p50)}/${fmtWcet(card.cal_p90)}${card.uncalibrated ? " *" : ""}` +
        (points === null
          ? ""
          : ` (via ${pointsRateText(points)}${points.rate_source === "seed" ? " ?" : ""})`);
  const proj = card.proj_total_wcet === null ? "" : ` · proj ${fmtWcet(card.proj_total_wcet)} (crude)`;
  const lines = [
    `- **${card.subject}** (${card.kind}, ${card.status})`,
    `  band ${band} · consumed ${fmtWcet(card.consumed_wcet)} · main/sub ${fmtWcet(card.wcet_main)}/${fmtWcet(card.wcet_sub)}${proj}`,
    `  active ${fmtDuration(card.active_s)} / wall ${fmtDuration(card.wall_s)}`,
  ];
  if (card.check_back !== null) {
    const p50 = fmtCheckBack(card.check_back.p50_s);
    const p90 = fmtCheckBack(card.check_back.p90_s);
    lines.push(`  check back ${p50}${card.check_back.probation ? " ?" : ""} (p90 ${p90})`);
  }
  if (card.phases.length > 0) {
    const phases = card.phases
      .map((p) => `P${p.phase_idx}:${p.actual_wcet === null ? "—" : fmtWcet(p.actual_wcet)}${p.block_p50 === null ? "" : `/${fmtWcet(p.block_p50)}`}(${p.phase_conf ?? "none"})`)
      .join(" ");
    lines.push(`  phases: ${phases}`);
  }
  return lines.join("\n");
}

export function renderBoardMd(report: BoardReport): string {
  const parts = [
    `# est board`,
    ``,
    `as of ${report.as_of} · \\* = uncalibrated band (cold start) · pt = story points, a size relative to the anchor and never a token count · ? = derived through the SEED rate, a convention rather than a measurement`,
    ``,
  ];
  for (const col of report.columns) {
    parts.push(`## ${col.column} (${col.cards.length})`, ``);
    if (col.cards.length === 0) {
      parts.push(`_none_`, ``);
      continue;
    }
    for (const c of col.cards) parts.push(cardMd(c), ``);
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

export interface BoardRegenResult {
  /** False when a gate skipped this call entirely — nothing was read or written. */
  attempted: boolean;
  ok: boolean;
  html_path: string | null;
  md_path: string | null;
  anomaly: IngestAnomaly | null;
}

/**
 * Render and atomically write `board.html`/`board.md` into `dir`, unconditionally —
 * this is what `est board --html` calls: an explicit request bypasses the sweep
 * throttle, the same way a manual `est sweep` is never throttled while the
 * hook-spawned micro-sweep is (P1.10's distinction, carried over here).
 *
 * `html` / `md` select which files to write and both default to true, because the
 * sweep always wants both. `est board --html` passes them through so the CLI does not
 * need a second copy of the render-and-write orchestration: one `board()` read model,
 * one `writeAtomic` per file, one place where the two renderers are named. The
 * returned path is `null` for a file this call was not asked to write.
 */
export function renderBoardFiles(
  db: Database,
  dir: string,
  opts: { limit?: number; now?: Date; html?: boolean; md?: boolean } = {},
): { html_path: string | null; md_path: string | null; report: BoardReport } {
  const report = board(db, { limit: opts.limit ?? DEFAULT_BOARD_LIMIT, now: opts.now });
  let htmlPath: string | null = null;
  let mdPath: string | null = null;
  if (opts.html ?? true) {
    htmlPath = join(dir, BOARD_HTML_NAME);
    writeAtomic(htmlPath, renderBoardHtml(report));
  }
  if (opts.md ?? true) {
    mdPath = join(dir, BOARD_MD_NAME);
    writeAtomic(mdPath, renderBoardMd(report));
  }
  // After the renames, so a temp file this call created is never a candidate.
  reapBoardTemp(dir, opts.now ?? new Date());
  return { html_path: htmlPath, md_path: mdPath, report };
}

/**
 * The sweep-triggered path (P2.7 "Regeneration"): rendered at the end of a sweep whose
 * transaction CHANGED a `task` / `estimate` / `outcome` / `burn_cache` row, throttled by
 * `board_min_interval_s` via an `mtime` check on `<spoolDir>/.board`, and never failing
 * the caller — a render failure is reported as `anomaly(kind='board_render_failed')` and
 * the previous files are left intact.
 *
 * **`dirty` is the FIRST gate and the mtime throttle is the second**, in that order,
 * because they answer different questions. The throttle bounds how OFTEN a changing
 * board is rewritten; `dirty` is what stops a board being rewritten at all when nothing
 * it displays has moved. Without it, every sweep more than `board_min_interval_s` after
 * the last one paid for a full `board()` — an unbounded read across `task`,
 * `v_scope_current`, `estimate`, `v_task_actual`, `v_outcome_current`, `burn_cache` and
 * the two phase-strip queries — plus two `fsync`+`rename` writes, to produce a
 * byte-identical file. On an idle machine with a cron sweep that is the whole cost of
 * the feature, spent on nothing.
 *
 * A caller that genuinely cannot tell passes `dirty: true`; the default is `true` so an
 * omission errs toward rendering rather than toward a silently stale board.
 */
export function regenerateBoardIfDue(
  db: Database,
  opts: { boardDir: string; spoolDir: string; now?: Date; limit?: number; dirty?: boolean },
): BoardRegenResult {
  const now = opts.now ?? new Date();
  // Cheapest gate first, and outside the try: reading a boolean the caller already
  // computed cannot fail, and skipping here must not look like a render that succeeded.
  if (opts.dirty === false) {
    return { attempted: false, ok: true, html_path: null, md_path: null, anomaly: null };
  }
  // The throttle check itself reads `config` off `db` (`boardMinIntervalS`), so it
  // belongs INSIDE the same try/catch as the render — a database that cannot answer
  // that read cannot render a board either, and the failure mode is identical
  // (report the anomaly, touch nothing, leave the previous good files alone).
  try {
    const minIntervalS = boardMinIntervalS(db);
    if (!boardDue(opts.spoolDir, minIntervalS, now)) {
      return { attempted: false, ok: true, html_path: null, md_path: null, anomaly: null };
    }
    const { html_path, md_path } = renderBoardFiles(db, opts.boardDir, { limit: opts.limit, now });
    touchBoardMarker(opts.spoolDir, now);
    return { attempted: true, ok: true, html_path, md_path, anomaly: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      attempted: true,
      ok: false,
      html_path: null,
      md_path: null,
      anomaly: { kind: "board_render_failed", detail: `est board render failed: ${message}` },
    };
  }
}

/** Ensures `dir` exists before the check-then-write above needs it. Exported for the
 *  small number of tests that write a `.board` marker directly rather than through
 *  {@link touchBoardMarker}. */
export function ensureDirExists(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

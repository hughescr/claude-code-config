/**
 * src/textdiff.ts — a minimal unified line diff, for `task_scope.diff_summary`.
 *
 * §6.4 requires a scope revision to be *diffable*: "a scope change is a fact in the
 * scope history, or it is not a scope change", and a hash that changed tells you
 * nothing about what moved. This produces the human-readable half of that record.
 *
 * Zero npm dependencies is a hard rule here (§Phase 1 interfaces), so this is a
 * small Hunt-Szymanski-style LCS over lines rather than a diff library. It is
 * deliberately unsophisticated: the input is a task subject, a description and a
 * DoD checklist, i.e. tens of lines, and the output is truncated to 2 KB anyway.
 */

/** Longest common subsequence of two line arrays, as index pairs. */
function lcs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // (n+1)*(m+1) table. Bounded by the truncation the caller applies before it gets
  // here; a scope record that reached megabytes would be a different problem.
  const dp: number[] = new Array<number>((n + 1) * (m + 1)).fill(0);
  const at = (i: number, j: number): number => dp[i * (m + 1) + j]!;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) i += 1;
    else j += 1;
  }
  return out;
}

export interface DiffOptions {
  /** Hard cap on the returned string. Default 2048 (§6.4's "truncated to 2 KB"). */
  maxBytes?: number;
  /** Label for the `---` header line. */
  fromLabel?: string;
  /** Label for the `+++` header line. */
  toLabel?: string;
}

/**
 * Unified-ish diff: header lines, then `-`/`+`/` ` prefixed lines with no hunk
 * headers (there is no file to apply this to — it is evidence, not a patch).
 *
 * Returns an empty string when the two texts are identical, which is what lets
 * `est scope` reject a no-op revision by content rather than by hash alone.
 */
export function unifiedDiff(from: string, to: string, opts: DiffOptions = {}): string {
  if (from === to) return "";
  const maxBytes = opts.maxBytes ?? 2048;
  const a = from.split("\n");
  const b = to.split("\n");
  const common = lcs(a, b);

  const lines: string[] = [`--- ${opts.fromLabel ?? "before"}`, `+++ ${opts.toLabel ?? "after"}`];
  let i = 0;
  let j = 0;
  const emitTo = (ai: number, bj: number): void => {
    while (i < ai) {
      lines.push(`-${a[i]!}`);
      i += 1;
    }
    while (j < bj) {
      lines.push(`+${b[j]!}`);
      j += 1;
    }
  };
  for (const [ai, bj] of common) {
    emitTo(ai, bj);
    lines.push(` ${a[ai]!}`);
    i = ai + 1;
    j = bj + 1;
  }
  emitTo(a.length, b.length);

  const text = lines.join("\n");
  if (text.length <= maxBytes) return text;
  // Truncation is announced. A silently-cut diff read months later would look like
  // the change was smaller than it was.
  const marker = "\n… [diff truncated]";
  return `${text.slice(0, Math.max(0, maxBytes - marker.length))}${marker}`;
}

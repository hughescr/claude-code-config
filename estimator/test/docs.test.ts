/**
 * README.md — the claims it makes about the CLI surface and about what is wired
 * into this machine.
 *
 * Documentation drift is not cosmetic here: README's operational-scripts table is
 * the surface a reader consults to answer "what is this doing to my machine right
 * now", and its verb table is what someone reads instead of running `est help`.
 * Both drifted in Phase 1 — `est nudge` / `est capture-delete` were documented as
 * verbs that were never registered, and `statusline-burn.ts` was live-wired with
 * no row at all — so these two invariants are pinned rather than re-checked by eye.
 *
 * Neither test reads the database, the corpus or any machine state; they are pure
 * string checks over two committed files.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, HELP } from "../src/cli.ts";

const ROOT = join(import.meta.dir, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

/**
 * Verbs README may name that `run()` does not dispatch. Every entry needs a
 * reason, and "the docs say so" is not one — a hook entry point that ships as a
 * shell wrapper belongs in the operational-scripts table, not here.
 */
const NOT_YET_VERBS = new Set([
  "recon", // Phase 2, and README says so in the same sentence.
  "delete", // named only to say it does not exist and never will.
]);

describe("README CLI surface", () => {
  test("every `est <verb>` README names is registered, or is an explained exception", () => {
    const named = new Set<string>();
    for (const m of README.matchAll(/`est ([a-z][a-z-]*)/g)) named.add(m[1]!);
    // Sanity: the regex is finding verbs at all, so a rewrite that breaks it fails loudly.
    expect(named.has("burn")).toBe(true);

    const registered = new Set<string>(COMMANDS);
    const unknown = [...named].filter((v) => !registered.has(v) && !NOT_YET_VERBS.has(v));
    expect(unknown).toEqual([]);
  });

  test("the hook entry points are documented as scripts, never as verbs", () => {
    // The exact drift that shipped: `est nudge` (PostToolUse) / `est capture-delete`
    // (PreToolUse). They run as wrappers and are deliberately not registered.
    expect(README).not.toContain("`est nudge`");
    expect(README).not.toContain("`est capture-delete`");
    expect(README).toContain("`scripts/nudge-hook.sh`");
    expect(README).toContain("`scripts/capture-delete-hook.sh`");
  });
});

describe("README operational coverage", () => {
  test("every file in scripts/ is accounted for by name", () => {
    const files = readdirSync(join(ROOT, "scripts")).filter((f) => !f.startsWith("."));
    // Sanity: the always-on entry points that the table exists to record.
    expect(files).toContain("statusline-burn.ts");
    const undocumented = files.filter((f) => !README.includes(f));
    expect(undocumented).toEqual([]);
  });

  test("wiring that lives outside this repo carries enough to reproduce it", () => {
    // statusline-burn.ts is invoked by ccstatusline, whose config is neither in
    // this repo nor in the DB-only weekly backup, so the path must be here.
    expect(README).toContain("~/.config/ccstatusline/settings.json");
    expect(README).toContain("scripts/statusline-burn.ts");
    // The launchd job is installed; the table must not claim otherwise.
    expect(README).not.toContain("**NOT INSTALLED**");
  });
});

describe("est help — focus TTL basis", () => {
  test("the focus entry describes the TTL on its implemented fixed-from-set basis", () => {
    const start = HELP.indexOf("focus <tid>:");
    const end = HELP.indexOf("scope <tid>:");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const entry = HELP.slice(start, end);
    expect(entry).toContain("hook_focus_ttl_min");
    // resolveLadder ages the marker from marker.ts alone (scripts/nudge.ts:363-388);
    // the behaviour is pinned by nudge.test.ts "a focus marker older than
    // hook_focus_ttl_min is ignored EVEN WHILE its task is still absorbing work".
    // This test pins the USER-FACING half, which rev-3 stated as its inverse.
    expect(entry.toLowerCase()).not.toContain("idle");
    expect(entry).toMatch(/when it was SET|time it was set/);
  });
});

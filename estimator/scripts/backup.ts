#!/usr/bin/env bun
/**
 * scripts/backup.ts — the weekly maintenance leg of `est-cron.sh` (§2, §8).
 *
 * Three things, in this order:
 *   1. `VACUUM INTO backups/estimator-<UTC date>.db` — a consistent single-file
 *      snapshot taken through sqlite itself, so it is safe against a live WAL and
 *      needs no external `sqlite3` binary (bun:sqlite only, zero npm deps).
 *   2. `PRAGMA wal_checkpoint(TRUNCATE)` — the weekly checkpoint §2 asks for; two
 *      concurrent live sessions were observed, so the WAL does grow.
 *   3. Prune old snapshots, keeping the newest `--keep` (default 8 ≈ two months).
 *
 * The sweep lock is deliberately NOT taken: VACUUM INTO is a reader, WAL allows
 * readers alongside the single writer, and blocking the sweeper behind a backup
 * would be a worse trade than a snapshot taken mid-sweep (every sweep is
 * idempotent, so a mid-sweep snapshot is a valid earlier state, never a torn one).
 *
 * usage: bun run scripts/backup.ts [--db <path>] [--dir <path>] [--keep <n>] [--quiet]
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DB_PATH, ROOT } from "../src/db.ts";

interface Opts {
  db: string;
  dir: string;
  keep: number;
  quiet: boolean;
}

function parse(argv: readonly string[]): Opts {
  const opts: Opts = { db: DB_PATH, dir: join(ROOT, "backups"), keep: 8, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const take = (): string => inline ?? argv[++i] ?? "";
    if (name === "--db") opts.db = take();
    else if (name === "--dir") opts.dir = take();
    else if (name === "--keep") opts.keep = Math.max(1, Number.parseInt(take(), 10) || 8);
    else if (name === "--quiet" || name === "-q") opts.quiet = true;
    else throw new Error(`backup: unknown argument ${a}`);
  }
  return opts;
}

export function backupName(now: Date = new Date()): string {
  return `estimator-${now.toISOString().slice(0, 10).replaceAll("-", "")}.db`;
}

export function pruneBackups(dir: string, keep: number): string[] {
  const snapshots = readdirSync(dir)
    .filter((n) => /^estimator-\d{8}\.db$/.test(n))
    .map((n) => ({ name: n, mtime: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const doomed = snapshots.slice(keep);
  for (const s of doomed) unlinkSync(join(dir, s.name));
  return doomed.map((s) => s.name);
}

function main(argv: readonly string[]): number {
  const opts = parse(argv);
  mkdirSync(opts.dir, { recursive: true });

  const target = join(opts.dir, backupName());
  // VACUUM INTO refuses to overwrite; a second run on the same UTC day should be
  // a no-op refresh, not a crash.
  try {
    unlinkSync(target);
  } catch {
    /* not there: normal */
  }

  // readwrite without `create`: a missing database is an error worth seeing, not
  // an empty file to back up. (bun:sqlite requires one of readonly/readwrite.)
  const db = new Database(opts.db, { readwrite: true });
  try {
    db.exec("PRAGMA busy_timeout = 30000;");
    db.query("VACUUM INTO ?").run(target);
    const wal = db
      .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
      .get();
    const pruned = pruneBackups(opts.dir, opts.keep);
    if (!opts.quiet) {
      const size = statSync(target).size;
      console.log(
        `backup ok: ${target} (${(size / 1024 / 1024).toFixed(1)} MiB), ` +
          `wal_checkpoint busy=${wal?.busy ?? "?"} log=${wal?.log ?? "?"}` +
          (pruned.length > 0 ? `, pruned ${pruned.join(", ")}` : ""),
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`backup: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

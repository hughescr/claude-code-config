#!/usr/bin/env bun
/**
 * SessionStart command hook: gives ~/.claude/mods-flag.log its "off" half.
 *
 * Claude Code mods load only while the server-side flag `tengu_plugin_hooks_modules` is ON for the process. The
 * mods-probe plugin appends an `on` line at its `session.start`, so silence is ambiguous. This hook runs in EVERY
 * process (settings hooks are not gated by the flag) and does two things:
 *
 *   1. appends `<ISO> session=<id> source=<src> pid=<claude pid> start` for this process;
 *   2. for each earlier `start` older than 2 minutes with no `on` for the same session within 5 minutes after it,
 *      appends `<ISO> session=<id> pid=<pid> for_start=<start ISO> inferred off`. That line is also the "already
 *      reconciled" marker, so a start is never inferred twice.
 *
 * Line grammar shared with mods-probe (one parser): `<ISO-8601 Z time> <key=value | word>... <state>`, where the
 * LAST token is the state: `start`, `on` or `off`. `session=` is required.
 *
 * `--report` prints on/off counts per day and the last transition, and writes nothing.
 *
 * Fail soft: no stdout, exit 0 on any error, hard wall-clock cap. It only ever APPENDS (O_APPEND), never rewrites,
 * except a rare size-triggered trim that swaps in a new file with an atomic rename (see trimIfLarge).
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

// ---- tunables -------------------------------------------------------------------------------------------------

/** A start younger than this is never inferred (the mod has had time to log). */
export const GRACE_MS = 2 * 60_000
/** An `on` for the same session this long after a start (or earlier, by LOOKBACK_MS) proves the start was on. */
export const ON_WINDOW_MS = 5 * 60_000
/** The hook and the mod race at launch; an `on` can carry a timestamp slightly BEFORE its start. */
export const LOOKBACK_MS = 30_000
/** Above this size the hook trims (the probe only trims when mods are on, and cannot read files over 4 MiB). */
export const TRIM_BYTES = 1024 * 1024
/** A trim keeps about this many of the newest bytes (whole lines). */
export const KEEP_BYTES = 512 * 1024
/** Never read more than this much of the log's tail. */
const READ_BYTES = 1024 * 1024
/** Wall-clock cap for the whole hook. */
const HARD_CAP_MS = 2000

export const DEFAULT_LOG = `${homedir()}/.claude/mods-flag.log`

// ---- line model -----------------------------------------------------------------------------------------------

export type State = 'start' | 'on' | 'off'

export type Entry = {
  readonly ms: number
  /** The line's own timestamp token, kept verbatim: it is the key a `for_start=` marker refers to. */
  readonly iso: string
  readonly session: string
  readonly state: State
  readonly kv: Readonly<Record<string, string>>
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u
const STATES: ReadonlySet<string> = new Set(['start', 'on', 'off'])

/** Strips whitespace and control characters so a value can never break the one-line, space-separated format. */
export const field = (value: string): string => value.replace(/[\s\u0000-\u001f\u007f]+/gu, '_')

/** Parses one log line; undefined for anything malformed (the caller skips it, the file keeps it). */
export const parseLine = (line: string): Entry | undefined => {
  const tokens = line.trim().split(/\s+/u)
  if (tokens.length < 3) return undefined
  const iso = tokens[0] as string
  const state = tokens[tokens.length - 1] as string
  if (!ISO_RE.test(iso) || !STATES.has(state)) return undefined
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return undefined
  const kv: Record<string, string> = {}
  for (const token of tokens.slice(1, -1)) {
    const eq = token.indexOf('=')
    if (eq > 0) kv[token.slice(0, eq)] = token.slice(eq + 1)
  }
  const session = kv['session']
  if (session === undefined || session === '') return undefined
  if (state === 'off' && (kv['for_start'] === undefined || !ISO_RE.test(kv['for_start']))) return undefined
  return { ms, iso, session, state: state as State, kv }
}

export const parseLog = (text: string): Entry[] => {
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    const entry = parseLine(line)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

export const formatStart = (nowMs: number, session: string, source: string, pid: string): string =>
  `${new Date(nowMs).toISOString()} session=${field(session)} source=${field(source)} pid=${pid} start`

export const formatOff = (nowMs: number, start: Entry): string =>
  `${new Date(nowMs).toISOString()} session=${field(start.session)} pid=${field(start.kv['pid'] ?? '?')} ` +
  `for_start=${start.iso} inferred off`

// ---- reconcile ------------------------------------------------------------------------------------------------

const reconciledKey = (session: string, startIso: string): string => `${session}|${startIso}`

/** The starts that are old enough, have no `on` near them and no `off` marker yet. Pure; the caller appends. */
export const inferOffs = (entries: readonly Entry[], nowMs: number): Entry[] => {
  const done = new Set<string>()
  const onBySession = new Map<string, number[]>()
  const wildcardOn: number[] = []
  for (const e of entries) {
    if (e.state === 'off') done.add(reconciledKey(e.session, e.kv['for_start'] as string))
    else if (e.state === 'on') {
      // An `on` whose session id the probe could not read (`?`) counts for any start it falls near.
      if (e.session === '?') wildcardOn.push(e.ms)
      else onBySession.set(e.session, [...(onBySession.get(e.session) ?? []), e.ms])
    }
  }
  const out: Entry[] = []
  for (const e of entries) {
    if (e.state !== 'start' || nowMs - e.ms <= GRACE_MS) continue
    const key = reconciledKey(e.session, e.iso)
    if (done.has(key)) continue
    const near = (t: number): boolean => t >= e.ms - LOOKBACK_MS && t <= e.ms + ON_WINDOW_MS
    if ((onBySession.get(e.session) ?? []).some(near) || wildcardOn.some(near)) continue
    done.add(key)
    out.push(e)
  }
  return out
}

// ---- process discovery ----------------------------------------------------------------------------------------

export type ProcRow = { readonly pid: string; readonly ppid: string; readonly etimeSec: number | undefined; readonly comm: string }
export type ProcInfo = { readonly pid: string; readonly startMs: number | undefined }

/** `etime` is `[[dd-]hh:]mm:ss`. */
export const parseEtime = (etime: string): number | undefined => {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(etime)
  if (m === null) return undefined
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

export const parsePs = (text: string): ProcRow[] => {
  const rows: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/u.exec(line)
    if (m !== null) rows.push({ pid: m[1] as string, ppid: m[2] as string, etimeSec: parseEtime(m[3] as string), comm: m[4] as string })
  }
  return rows
}

/** The claude binary: `.../claude`, or a versioned `.../claude/versions/<v>` (comm is the exec path on macOS). */
export const isClaudeBinary = (comm: string): boolean => /(?:^|\/)claude(?:\.exe)?$/u.test(comm) || /\/claude\/versions\/[^/]+$/u.test(comm)

/** Walks the parent chain from `fromPid` (at most 12 hops) to the first claude binary; undefined if none. */
export const findClaude = (rows: readonly ProcRow[], fromPid: string, nowMs: number): ProcInfo | undefined => {
  const byPid = new Map(rows.map(r => [r.pid, r]))
  let pid = fromPid
  for (let hop = 0; hop < 12; hop++) {
    const row = byPid.get(pid)
    if (row === undefined) return undefined
    if (isClaudeBinary(row.comm)) {
      return { pid: row.pid, startMs: row.etimeSec === undefined ? undefined : nowMs - row.etimeSec * 1000 }
    }
    if (row.ppid === pid || row.ppid === '0') return undefined
    pid = row.ppid
  }
  return undefined
}

const detectProc = (nowMs: number): ProcInfo => {
  try {
    const r = Bun.spawnSync(['/bin/ps', '-axo', 'pid=,ppid=,etime=,comm='], { stdout: 'pipe', stderr: 'ignore', timeout: 1000 })
    if (r.exitCode === 0) {
      return findClaude(parsePs(r.stdout.toString()), String(process.pid), nowMs) ?? { pid: '?', startMs: undefined }
    }
  } catch {
    // fall through: pid=? is a valid answer
  }
  return { pid: '?', startMs: undefined }
}

// ---- file access ----------------------------------------------------------------------------------------------

/** The last `maxBytes` of the file as whole lines ('' when missing). Never reads more than that. */
export const readTail = (path: string, maxBytes: number): string => {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY)
  } catch {
    return ''
  }
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, size - len + got)
      if (n === 0) break
      got += n
    }
    const text = buf.toString('utf8', 0, got)
    if (len === size) return text
    const nl = text.indexOf('\n')
    return nl < 0 ? '' : text.slice(nl + 1) // drop the partial first line
  } finally {
    closeSync(fd)
  }
}

/** One write(2) on an O_APPEND descriptor: the kernel positions each write at the current end atomically. */
export const appendLines = (path: string, lines: readonly string[]): void => {
  if (lines.length === 0) return
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o644)
  try {
    const buf = Buffer.from(lines.join('\n') + '\n', 'utf8')
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off)
  } finally {
    closeSync(fd)
  }
}

/**
 * Keeps the log bounded when mods are off for a long time (the probe trims only when it runs, and its 4 MiB read
 * limit would make it treat an oversized log as empty and overwrite it). Rare by design: it triggers above
 * TRIM_BYTES (about 9000 lines) and keeps the newest KEEP_BYTES of whole lines.
 *
 * Race with the probe and other hooks: the new file is built beside the log and swapped in with rename(2), so a
 * reader never sees a half-written file. A line appended between our read and the rename lands in the OLD inode
 * and is lost, and a probe that read before the rename can write its stale copy back over the trim. Both windows
 * are milliseconds wide, open only on this rare path, and lose at worst a few start lines, which never produces a
 * false "off" (a lost `on` can, but only the probe writes `on` and it rewrites the whole file anyway).
 */
export const trimIfLarge = (path: string): boolean => {
  try {
    if (statSync(path).size <= TRIM_BYTES) return false
    const tail = readTail(path, KEEP_BYTES)
    if (tail === '') return false
    const tmp = `${path}.trim-${process.pid}`
    try {
      writeFileSync(tmp, tail.endsWith('\n') ? tail : tail + '\n')
      renameSync(tmp, path)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // already gone
      }
      throw error
    }
    return true
  } catch {
    return false
  }
}

// ---- the hook -------------------------------------------------------------------------------------------------

export type HookInput = { readonly session_id?: unknown; readonly source?: unknown }

/** clear and compact keep the same process (and mods-probe's `session.start` does not fire for them). */
const SAME_PROCESS_SOURCES: ReadonlySet<string> = new Set(['clear', 'compact'])

export type RunOptions = { readonly logPath: string; readonly nowMs: number; readonly input: HookInput; readonly proc: ProcInfo }

/** Appends this process's start (once per process) plus any inferred offs. Returns the lines appended. */
export const run = ({ logPath, nowMs, input, proc }: RunOptions): string[] => {
  trimIfLarge(logPath)
  const entries = parseLog(readTail(logPath, READ_BYTES))
  const lines: string[] = []

  for (const start of inferOffs(entries, nowMs)) lines.push(formatOff(nowMs, start))

  const source = typeof input.source === 'string' && input.source !== '' ? input.source : 'startup'
  const session = typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : '?'
  if (!SAME_PROCESS_SOURCES.has(source) && !alreadyStarted(entries, proc)) {
    lines.push(formatStart(nowMs, session, source, proc.pid))
  }

  appendLines(logPath, lines)
  return lines
}

/** True when this claude process already has a start line (an in-process /resume or reload), so it gets one. */
const alreadyStarted = (entries: readonly Entry[], proc: ProcInfo): boolean => {
  if (proc.pid === '?') return false
  // pid reuse: only a start at or after this process's own launch counts.
  const since = proc.startMs === undefined ? Number.POSITIVE_INFINITY : proc.startMs - 5000
  return entries.some(e => e.state === 'start' && e.kv['pid'] === proc.pid && e.ms >= since)
}

// ---- report ---------------------------------------------------------------------------------------------------

type Event = { readonly ms: number; readonly state: 'on' | 'off' }

/** Counts per UTC day plus the last on/off transition. Includes starts that are due an `off` but not yet marked. */
export const report = (text: string, nowMs: number): string => {
  const entries = parseLog(text)
  const days = new Map<string, { starts: number; on: number; off: number }>()
  const bump = (ms: number, key: 'starts' | 'on' | 'off'): void => {
    const day = new Date(ms).toISOString().slice(0, 10)
    const row = days.get(day) ?? { starts: 0, on: 0, off: 0 }
    row[key]++
    days.set(day, row)
  }
  const events: Event[] = []
  const seenOff = new Set<string>()
  const addOff = (session: string, startIso: string): void => {
    const key = reconciledKey(session, startIso)
    if (seenOff.has(key)) return
    seenOff.add(key)
    const ms = Date.parse(startIso)
    bump(ms, 'off')
    events.push({ ms, state: 'off' })
  }
  for (const e of entries) {
    if (e.state === 'start') bump(e.ms, 'starts')
    else if (e.state === 'on') {
      bump(e.ms, 'on')
      events.push({ ms: e.ms, state: 'on' })
    } else addOff(e.session, e.kv['for_start'] as string)
  }
  for (const s of inferOffs(entries, nowMs)) addOff(s.session, s.iso)

  const out = ['day         starts    on   off']
  const total = { starts: 0, on: 0, off: 0 }
  for (const day of [...days.keys()].sort()) {
    const r = days.get(day) as { starts: number; on: number; off: number }
    total.starts += r.starts
    total.on += r.on
    total.off += r.off
    out.push(`${day}  ${String(r.starts).padStart(6)} ${String(r.on).padStart(5)} ${String(r.off).padStart(5)}`)
  }
  out.push(`total       ${String(total.starts).padStart(6)} ${String(total.on).padStart(5)} ${String(total.off).padStart(5)}`)

  events.sort((a, b) => a.ms - b.ms)
  let lastTransition: string | undefined
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1] as Event
    const cur = events[i] as Event
    if (cur.state !== prev.state) lastTransition = `${prev.state} -> ${cur.state} at ${new Date(cur.ms).toISOString()}`
  }
  const latest = events[events.length - 1]
  out.push(latest === undefined ? 'latest: no on/off events yet' : `latest: ${latest.state} at ${new Date(latest.ms).toISOString()}`)
  out.push(`last transition: ${lastTransition ?? 'none'}`)
  return out.join('\n') + '\n'
}

// ---- entry point ----------------------------------------------------------------------------------------------

const readStdin = async (): Promise<HookInput> => {
  const text = await Promise.race([Bun.stdin.text(), new Promise<string>(resolve => setTimeout(() => resolve(''), 1000))])
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookInput) : {}
  } catch {
    return {}
  }
}

const main = async (): Promise<void> => {
  const logPath = process.env['MODS_FLAG_LOG'] ?? DEFAULT_LOG
  if (process.argv.includes('--report')) {
    process.stdout.write(report(readTail(logPath, READ_BYTES), Date.now()))
    return
  }
  const input = await readStdin()
  const nowMs = Date.now()
  run({ logPath, nowMs, input, proc: detectProc(nowMs) })
}

if (import.meta.main) {
  // The wall-clock cap: a hook that hangs on stdin is cut off; synchronous steps have their own bounds.
  const cap = setTimeout(() => process.exit(0), HARD_CAP_MS)
  main().then(
    () => {
      clearTimeout(cap)
      process.exit(0)
    },
    () => process.exit(0),
  )
}

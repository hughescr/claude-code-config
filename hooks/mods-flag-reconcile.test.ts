import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ProcInfo,
  findClaude,
  parseEtime,
  parseLine,
  parsePs,
  report,
  run,
  trimIfLarge,
  TRIM_BYTES,
} from './mods-flag-reconcile'

const SCRIPT = join(import.meta.dir, 'mods-flag-reconcile.ts')
const T0 = Date.parse('2026-10-01T12:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const MIN = 60_000

let dir: string
let log: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mods-flag-'))
  log = join(dir, 'mods-flag.log')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const proc = (pid: string, startMs?: number): ProcInfo => ({ pid, startMs })
const startLine = (ms: number, session: string, pid = '100', source = 'startup'): string =>
  `${iso(ms)} session=${session} source=${source} pid=${pid} start`
const onLine = (ms: number, session: string): string =>
  `${iso(ms)} session=${session} surface=terminal interactive=true version=2.1.287 on`
const lines = (): string[] => readFileSync(log, 'utf8').split('\n').filter(l => l !== '')
const offLines = (): string[] => lines().filter(l => l.endsWith(' inferred off'))

describe('parseLine', () => {
  test('one parser reads probe, start and off lines', () => {
    expect(parseLine(onLine(T0, 'a'))?.state).toBe('on')
    expect(parseLine(startLine(T0, 'a'))?.kv['pid']).toBe('100')
    const off = parseLine(`${iso(T0 + 1)} session=a pid=100 for_start=${iso(T0)} inferred off`)
    expect(off?.state).toBe('off')
    expect(off?.kv['for_start']).toBe(iso(T0))
  })
})

describe('inference after 2 minutes', () => {
  test('a start older than 2 minutes with no on gets one off line', () => {
    writeFileSync(log, startLine(T0, 'sess-a') + '\n')
    const added = run({ logPath: log, nowMs: T0 + 3 * MIN, input: { session_id: 'sess-b', source: 'startup' }, proc: proc('200') })
    expect(added).toHaveLength(2)
    expect(offLines()).toEqual([`${iso(T0 + 3 * MIN)} session=sess-a pid=100 for_start=${iso(T0)} inferred off`])
    expect(lines().at(-1)).toBe(`${iso(T0 + 3 * MIN)} session=sess-b source=startup pid=200 start`)
  })

  test('a start with an on within 5 minutes is not inferred, one with a late on (over 5 min) is', () => {
    writeFileSync(log, [startLine(T0, 'ok'), onLine(T0 + 800, 'ok'), startLine(T0, 'late'), onLine(T0 + 6 * MIN, 'late')].join('\n') + '\n')
    run({ logPath: log, nowMs: T0 + 10 * MIN, input: { session_id: 'n', source: 'startup' }, proc: proc('200') })
    expect(offLines().map(l => l.split(' ')[1])).toEqual(['session=late'])
  })

  test('an on logged a few ms before its start still counts (the hook and the mod race)', () => {
    writeFileSync(log, [onLine(T0 - 20, 'r'), startLine(T0, 'r')].join('\n') + '\n')
    run({ logPath: log, nowMs: T0 + 10 * MIN, input: { session_id: 'n', source: 'startup' }, proc: proc('200') })
    expect(offLines()).toEqual([])
  })

  test('an on with an unreadable session id (?) near a start counts for it', () => {
    writeFileSync(log, [startLine(T0, 'x'), onLine(T0 + 500, '?')].join('\n') + '\n')
    run({ logPath: log, nowMs: T0 + 10 * MIN, input: { session_id: 'n', source: 'startup' }, proc: proc('200') })
    expect(offLines()).toEqual([])
  })
})

describe('no inference inside the window', () => {
  test('a start under 2 minutes old is left alone, then inferred once it ages out', () => {
    writeFileSync(log, startLine(T0, 'fresh') + '\n')
    run({ logPath: log, nowMs: T0 + 119_000, input: { session_id: 'n1', source: 'startup' }, proc: proc('201') })
    expect(offLines()).toEqual([])
    run({ logPath: log, nowMs: T0 + 121_000, input: { session_id: 'n2', source: 'startup' }, proc: proc('202') })
    expect(offLines()).toHaveLength(1)
  })
})

describe('idempotent re-runs', () => {
  test('running again never repeats an off, and never restarts the same process', () => {
    writeFileSync(log, startLine(T0, 'old') + '\n')
    const input = { session_id: 'now', source: 'startup' }
    run({ logPath: log, nowMs: T0 + 3 * MIN, input, proc: proc('200', T0 + 2 * MIN) })
    const first = lines()
    run({ logPath: log, nowMs: T0 + 3 * MIN + 1, input, proc: proc('200', T0 + 2 * MIN) })
    expect(lines()).toEqual(first)
    expect(offLines()).toHaveLength(1)
    // once this process's own start ages out it gets its one off; repeating that adds nothing
    run({ logPath: log, nowMs: T0 + 9 * MIN, input, proc: proc('200', T0 + 2 * MIN) })
    const second = lines()
    expect(offLines()).toHaveLength(2)
    run({ logPath: log, nowMs: T0 + 9 * MIN + 1, input, proc: proc('200', T0 + 2 * MIN) })
    run({ logPath: log, nowMs: T0 + 30 * MIN, input, proc: proc('200', T0 + 2 * MIN) })
    expect(lines().slice(0, second.length)).toEqual(second)
    expect(lines()).toHaveLength(second.length)
  })
})

describe('resume reusing a session id', () => {
  test('a new process resuming session S starts fresh; the earlier start for S keeps its on', () => {
    writeFileSync(log, [startLine(T0, 'S', '100'), onLine(T0 + 400, 'S')].join('\n') + '\n')
    // a new claude process (pid 300) resumes S ten minutes later, and mods are off in it
    run({ logPath: log, nowMs: T0 + 10 * MIN, input: { session_id: 'S', source: 'resume' }, proc: proc('300', T0 + 10 * MIN - 1000) })
    expect(lines().at(-1)).toBe(`${iso(T0 + 10 * MIN)} session=S source=resume pid=300 start`)
    expect(offLines()).toEqual([])
    run({ logPath: log, nowMs: T0 + 14 * MIN, input: { session_id: 'Z', source: 'startup' }, proc: proc('400') })
    // only the resume start is inferred off; the first start for S had its on
    expect(offLines()).toEqual([`${iso(T0 + 14 * MIN)} session=S pid=300 for_start=${iso(T0 + 10 * MIN)} inferred off`])
  })

  test('an in-process resume, /clear and compact write no start for a process that already has one', () => {
    const p = proc('300', T0 - MIN)
    run({ logPath: log, nowMs: T0, input: { session_id: 'S', source: 'startup' }, proc: p })
    run({ logPath: log, nowMs: T0 + MIN, input: { session_id: 'S2', source: 'resume' }, proc: p })
    run({ logPath: log, nowMs: T0 + 2 * MIN, input: { session_id: 'S3', source: 'clear' }, proc: p })
    run({ logPath: log, nowMs: T0 + 3 * MIN, input: { session_id: 'S3', source: 'compact' }, proc: p })
    expect(lines().filter(l => l.endsWith(' start'))).toHaveLength(1)
  })

  test('clear and compact never start a process, even one with no start yet', () => {
    run({ logPath: log, nowMs: T0, input: { session_id: 'S', source: 'clear' }, proc: proc('500', T0 - MIN) })
    run({ logPath: log, nowMs: T0, input: { session_id: 'S', source: 'compact' }, proc: proc('500', T0 - MIN) })
    expect(statSync(log, { throwIfNoEntry: false })).toBeUndefined()
  })

  test('a reused pid from before the process launched does not suppress the start', () => {
    writeFileSync(log, startLine(T0 - 5 * 24 * 60 * MIN, 'ancient', '300') + '\n')
    run({ logPath: log, nowMs: T0, input: { session_id: 'S', source: 'startup' }, proc: proc('300', T0 - 1000) })
    expect(lines().filter(l => l.endsWith(' start'))).toHaveLength(2)
  })
})

describe('malformed lines', () => {
  test('garbage is skipped, kept in the file, and does not stop reconciliation', () => {
    const junk = [
      'not a log line',
      '',
      `${iso(T0)} session=nostate source=startup pid=1`,
      `${iso(T0)} source=startup pid=1 start`,
      `2026-13-45T99:99:99Z session=bad start`,
      `${iso(T0)} session=a for_start=nope inferred off`,
      '\u0000\u0001 binary \u0002 start',
      startLine(T0, 'real'),
    ]
    writeFileSync(log, junk.join('\n') + '\n')
    const added = run({ logPath: log, nowMs: T0 + 5 * MIN, input: { session_id: 'n', source: 'startup' }, proc: proc('200') })
    expect(added).toHaveLength(2)
    expect(added.filter(l => l.endsWith(' inferred off'))).toEqual([`${iso(T0 + 5 * MIN)} session=real pid=100 for_start=${iso(T0)} inferred off`])
    expect(readFileSync(log, 'utf8').startsWith('not a log line\n')).toBe(true)
    expect(report(readFileSync(log, 'utf8'), T0 + 5 * MIN)).toContain('2026-10-01')
  })

  test('a missing log, an unwritable log path and a bad payload never throw out of the CLI', async () => {
    const bad = join(dir, 'file-not-dir')
    writeFileSync(bad, 'x')
    for (const [logPath, stdin] of [
      [join(bad, 'sub', 'mods-flag.log'), '{"session_id":"s","source":"startup"}'],
      [log, '{not json'],
      [log, ''],
    ] as const) {
      const p = Bun.spawn(['bun', SCRIPT], { env: { ...process.env, MODS_FLAG_LOG: logPath }, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
      expect(await p.exited).toBe(0)
      expect(await new Response(p.stdout).text()).toBe('')
    }
  })
})

describe('append and trim', () => {
  test('parallel hook processes all land their start line (O_APPEND)', async () => {
    const procs = Array.from({ length: 12 }, (_, i) =>
      Bun.spawn(['bun', SCRIPT], {
        env: { ...process.env, MODS_FLAG_LOG: log },
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: `par-${i}`, source: 'startup' })),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    for (const p of procs) expect(await p.exited).toBe(0)
    const sessions = lines().filter(l => l.endsWith(' start')).map(l => l.split(' ')[1])
    expect(new Set(sessions).size).toBe(12)
  })

  test('trim keeps newest whole lines and leaves a small log untouched', () => {
    writeFileSync(log, startLine(T0, 'small') + '\n')
    expect(trimIfLarge(log)).toBe(false)
    const row = startLine(T0, 'filler-' + 'x'.repeat(80)) + '\n'
    appendFileSync(log, row.repeat(Math.ceil(TRIM_BYTES / row.length) + 10))
    appendFileSync(log, startLine(T0 + 1, 'newest') + '\n')
    expect(trimIfLarge(log)).toBe(true)
    const kept = lines()
    expect(kept.at(-1)).toContain('session=newest')
    expect(kept.every(l => parseLine(l) !== undefined)).toBe(true)
    expect(statSync(log).size).toBeLessThan(TRIM_BYTES)
  })
})

describe('process discovery', () => {
  const ps = [
    '  900   1     05-02:03:04 /Applications/iTerm.app/Contents/MacOS/iTerm2',
    '  850   900      10:00:00 -zsh',
    '  800   850        01:30 /Users/craig/.local/bin/claude',
    '  790   800        00:01 /bin/sh',
    '  780   790        00:00 /opt/homebrew/bin/bun',
    '  700     1        00:10 /Users/craig/not claude/helper',
  ].join('\n')

  test('finds the claude binary up the chain and its start time, rejects a chain without one', () => {
    const rows = parsePs(ps)
    expect(rows).toHaveLength(6)
    expect(findClaude(rows, '780', T0)).toEqual({ pid: '800', startMs: T0 - 90_000 })
    expect(findClaude(rows, '700', T0)).toBeUndefined()
    expect(findClaude(rows, '999', T0)).toBeUndefined()
  })

  test('etime forms', () => {
    expect(parseEtime('00:05')).toBe(5)
    expect(parseEtime('01:30')).toBe(90)
    expect(parseEtime('10:00:00')).toBe(36000)
    expect(parseEtime('05-02:03:04')).toBe(5 * 86400 + 2 * 3600 + 3 * 60 + 4)
    expect(parseEtime('junk')).toBeUndefined()
  })
})

describe('--report', () => {
  test('counts per day, dedupes, includes due-but-unmarked offs, and names the last transition', () => {
    const day2 = T0 + 24 * 60 * MIN
    writeFileSync(
      log,
      [
        startLine(T0, 'a'),
        onLine(T0 + 500, 'a'),
        startLine(T0 + 10 * MIN, 'b'),
        `${iso(T0 + 20 * MIN)} session=b pid=100 for_start=${iso(T0 + 10 * MIN)} inferred off`,
        `${iso(T0 + 20 * MIN)} session=b pid=100 for_start=${iso(T0 + 10 * MIN)} inferred off`,
        startLine(day2, 'c'),
        onLine(day2 + 500, 'c'),
        startLine(day2 + 30 * MIN, 'd'),
      ].join('\n') + '\n',
    )
    const out = report(readFileSync(log, 'utf8'), day2 + 60 * MIN)
    expect(out).toContain('2026-10-01       2     1     1')
    expect(out).toContain('2026-10-02       2     1     1')
    expect(out).toContain(`latest: off at ${iso(day2 + 30 * MIN)}`)
    expect(out).toContain(`last transition: on -> off at ${iso(day2 + 30 * MIN)}`)
  })

  test('the CLI prints the report and writes nothing', async () => {
    writeFileSync(log, startLine(T0, 'a') + '\n' + onLine(T0 + 1, 'a') + '\n')
    const before = readFileSync(log, 'utf8')
    const p = Bun.spawn(['bun', SCRIPT, '--report'], { env: { ...process.env, MODS_FLAG_LOG: log }, stdout: 'pipe' })
    expect(await p.exited).toBe(0)
    expect(await new Response(p.stdout).text()).toContain('2026-10-01')
    expect(readFileSync(log, 'utf8')).toBe(before)
  })
})

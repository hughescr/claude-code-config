import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { MAX_LOG_LINES, NOTICE, appendLine, formatLine } from '../hooks/probe'

const NOW = Date.UTC(2026, 9, 1, 12, 34, 56, 789)

type Seen = { logs: string[]; writes: { path: string; text: string }[] }

/** Stands in for the engine beneath the plugin: records the transcript line and the file write. */
function world(on: On, opts: { existing?: string; home?: string; failVersion?: boolean } = {}): Seen {
  const seen: Seen = { logs: [], writes: [] }
  mock.clock(on, { now: NOW })
  mock.env(on, opts.home === undefined ? { HOME: '/home/craig' } : opts.home === '' ? {} : { HOME: opts.home })
  // Nothing sits beneath the plugin, so each hook below answers for the engine: `{ value }` or `{ deny }`.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-123' }))
  on('session.version', () =>
    opts.failVersion === true ? { deny: 'no version' } : { value: { version: '2.1.287', base: '2.1.287' } },
  )
  on('fs.read', () => (opts.existing === undefined ? { deny: 'ENOENT' } : { value: opts.existing }))
  on('fs.write', (_$, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  return seen
}

describe('formatLine', () => {
  test('is an ISO timestamp, the facts, and a trailing on', () => {
    expect(
      formatLine({ nowMs: NOW, sessionId: 'abc', surface: 'terminal', isInteractive: true, version: '2.1.287' }),
    ).toBe('2026-10-01T12:34:56.789Z session=abc surface=terminal interactive=true version=2.1.287 on')
  })

  test('unknown facts are spelled ? and none, never dropped', () => {
    expect(
      formatLine({ nowMs: NOW, sessionId: undefined, surface: null, isInteractive: false, version: undefined }),
    ).toBe('2026-10-01T12:34:56.789Z session=? surface=none interactive=false version=? on')
  })

  test('whitespace and control characters cannot break the one-line format', () => {
    const line = formatLine({
      nowMs: NOW,
      sessionId: 'a b\nc',
      surface: 'x\ty',
      isInteractive: true,
      version: '1.0 (dev)',
    })
    expect(line.includes('\n')).toBe(false)
    expect(line.split(' ').length).toBe(6)
  })
})

describe('appendLine', () => {
  test('adds one newline-terminated line to an empty or missing file', () => {
    expect(appendLine('', 'x')).toBe('x\n')
  })

  test('keeps earlier lines and puts the new one last', () => {
    expect(appendLine('a\nb\n', 'c')).toBe('a\nb\nc\n')
  })

  test('trims to the newest MAX_LOG_LINES lines', () => {
    const existing = Array.from({ length: MAX_LOG_LINES + 50 }, (_, i) => `l${i}`).join('\n') + '\n'
    const out = appendLine(existing, 'new').split('\n').filter(Boolean)
    expect(out.length).toBe(MAX_LOG_LINES)
    expect(out[out.length - 1]).toBe('new')
    expect(out[0]).toBe(`l${51}`)
  })
})

describe('session.start', () => {
  test('shows the notice and appends one line to ~/.claude/mods-flag.log', async ($, on) => {
    const seen = world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(seen.logs).toEqual([NOTICE])
    expect(seen.writes.length).toBe(1)
    expect(seen.writes[0]?.path).toBe('/home/craig/.claude/mods-flag.log')
    expect(seen.writes[0]?.text).toBe(
      '2026-10-01T12:34:56.789Z session=sess-123 surface=terminal interactive=true version=2.1.287 on\n',
    )
  })

  test('appends after existing lines rather than replacing them', async ($, on) => {
    const seen = world(on, { existing: 'older line\n' })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    const text = seen.writes[0]?.text ?? ''
    expect(text.startsWith('older line\n')).toBe(true)
    expect(text.endsWith(' on\n')).toBe(true)
    expect(text).toContain('surface=desktop')
  })

  test('a host that draws nowhere yet logs surface=none', async ($, on) => {
    const seen = world(on)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    expect(seen.writes[0]?.text).toContain('surface=none interactive=false')
  })

  test('an unreadable version still logs, as version=?', async ($, on) => {
    const seen = world(on, { failVersion: true })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(seen.writes[0]?.text).toContain('version=? on')
  })

  test('with no HOME the notice still shows and nothing is written', async ($, on) => {
    const seen = world(on, { home: '' })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(seen.logs).toEqual([NOTICE])
    expect(seen.writes.length).toBe(0)
  })
})

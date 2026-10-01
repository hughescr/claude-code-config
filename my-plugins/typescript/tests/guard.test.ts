import type { On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'
import {
  EXPAND_SCRIPT,
  hasGlob,
  shellNormalize,
  splitWords,
  tscArgs,
  tscDecide,
  tscGuard,
  TSC_REASON,
} from '../hooks/guard'

type Row = { command: string; expect: 'allow' | 'deny' }

// Golden corpus: decisions recorded from the original shell hook (parity-checked).
const CORPUS: Row[] = [
  { command: 'tsc', expect: 'allow' },
  { command: 'tsc --noEmit', expect: 'allow' },
  { command: 'tsc src/a.ts', expect: 'deny' },
  { command: 'npx tsc a.tsx', expect: 'deny' },
  { command: 'pnpm dlx tsc a.ts', expect: 'deny' },
  { command: 'pnpm dlx  tsc a.ts', expect: 'deny' },
  { command: 'yarn tsc a.ts', expect: 'deny' },
  { command: 'bunx tsc a.ts', expect: 'deny' },
  { command: 'tsc -p tsconfig.json', expect: 'allow' },
  { command: 'tsc -p a.ts', expect: 'allow' },
  { command: 'tsc --outFile out.ts --noEmit', expect: 'allow' },
  { command: 'tsc -b a.ts', expect: 'deny' },
  { command: 'tsc a.mts', expect: 'allow' },
  { command: 'tsc a.d.ts', expect: 'deny' },
  { command: 'tsc "a.ts"', expect: 'allow' },
  { command: 'tsc a.ts;', expect: 'allow' },
  { command: 'tsc --noEmit && git add foo.ts', expect: 'deny' },
  { command: 'tsc --noEmit | head -50', expect: 'allow' },
  { command: 'cp a.ts b.ts\ntsc --noEmit', expect: 'deny' },
  { command: 'foo;tsc a.ts', expect: 'deny' },
  { command: './node_modules/.bin/tsc a.ts', expect: 'allow' },
  { command: 'npxtsc a.ts', expect: 'deny' },
  { command: 'mytsc a.ts', expect: 'allow' },
  { command: 'tsc --noEmit a.ts', expect: 'deny' },
  { command: 'echo tsc a.ts', expect: 'deny' },
  { command: 'tsc src/*', expect: 'allow' },
  { command: 'tsc nomatch*.ts', expect: 'deny' },
  { command: 'tsc nomatch*', expect: 'allow' },
  { command: 'tsc "src/*"', expect: 'allow' },
  { command: `${' '.repeat(40)}echo ok\ntsc a.ts`, expect: 'deny' },
  { command: '', expect: 'allow' },
]

// Rows with a glob word: in a session the answer comes from bash's pathname
// expansion in the session cwd. The corpus was recorded where nothing matches,
// so the glob stays literal; the tool.call path below stubs bash that way.
const NEEDS_EXPANSION = new Set(['tsc src/*', 'tsc nomatch*', 'tsc nomatch*.ts', 'tsc "src/*"'])

describe('literal-words path (tscGuard)', () => {
  for (const row of CORPUS) {
    test(`${row.expect}: ${JSON.stringify(row.command.slice(0, 60))}`, () => {
      const got = tscGuard(row.command)
      expect(got === undefined ? 'allow' : 'deny').toBe(row.expect)
      if (row.expect === 'deny') expect(got).toBe(TSC_REASON)
    })
  }
})

describe('helpers', () => {
  test('shellNormalize strips trailing newlines and NULs only', () => {
    expect(shellNormalize('tsc a.ts\n\n')).toBe('tsc a.ts')
    expect(shellNormalize('ts\0c')).toBe('tsc')
    expect(shellNormalize('\n\n')).toBe('')
    expect(shellNormalize('  a\n b')).toBe('  a\n b')
  })
  test('splitWords uses space, tab and newline only', () => {
    expect(splitWords(' a\tb\nc  d ')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitWords('a b')).toEqual(['a b'])
  })
  test('hasGlob', () => {
    expect(hasGlob(['a.ts'])).toBe(false)
    expect(hasGlob(['a*'])).toBe(true)
    expect(hasGlob(['a?'])).toBe(true)
    expect(hasGlob(['[ab]'])).toBe(true)
  })
  test('tscDecide skip set', () => {
    expect(tscDecide(['--outDir', 'x.ts', 'y.js'])).toBeUndefined()
    expect(tscDecide(['--outDir', 'x.js', 'y.ts'])).toBe(TSC_REASON)
    expect(tscDecide(['-b', 'x.ts'])).toBe(TSC_REASON)
    expect(tscDecide(['a.mts', 'b.cts'])).toBeUndefined()
  })
  test('EXPAND_SCRIPT is an unquoted split+glob NUL emitter', () => {
    expect(EXPAND_SCRIPT).toBe(`for w in $1; do printf '%s\\0' "$w"; done`)
  })
  test('tscArgs strips through the last tsc per line', () => {
    expect(tscArgs('npx tsc a.ts')).toBe('a.ts')
    expect(tscArgs('pnpm dlx tsc a.ts')).toBe('a.ts')
    expect(tscArgs('cp a.ts b.ts\ntsc x')).toBe('cp a.ts b.ts\nx')
    expect(tscArgs('ls')).toBeUndefined()
    expect(tscArgs('')).toBeUndefined()
  })
})

describe('performance (adversarial 1 MB inputs stay linear)', () => {
  const MB = 1_000_000
  const inputs: Record<string, string> = {
    leadingSpaces: ' '.repeat(MB) + 'echo ok',
    spacesThenTsc: ' '.repeat(MB) + 'tsc a.mts',
    npxSpaces: 'npx' + ' '.repeat(MB),
    npxSpacesNoTsc: 'npx' + ' '.repeat(MB) + 'x',
    repeatedTsc: 'tsc '.repeat(MB / 4),
    repeatedNpx: 'npx '.repeat(MB / 4) + 'tsc',
    manyLines: 'tsc a\n'.repeat(MB / 6),
    dlxSpaces: 'pnpm dlx' + ' '.repeat(MB) + 'x',
  }
  for (const [name, input] of Object.entries(inputs)) {
    test(`${name} within budget`, () => {
      const t0 = Date.now()
      tscGuard(input)
      expect(Date.now() - t0 < 1500).toBe(true)
    })
  }
})

// Through the tool-call path: the plugin's hook over a stand-in engine. The
// stand-in counts how often a call reaches the engine, so an allow is proven by
// the call arriving and a deny by it not arriving.
const BASH_RESULT = { result: 'ok' } as const

function engineStub(on: On, state: { reached: number; runs: ProcessRunCall[] }, run?: (call: ProcessRunCall) => ProcessRunAnswer) {
  on('tool.call', { tool: 'Bash' }, () => {
    state.reached++
    return BASH_RESULT
  })
  on('session.cwd', () => ({ value: '/work/dir' }))
  on('process.run', (_$, e) => {
    const call = { argv: e.argv, init: e.init }
    state.runs.push(call)
    return run ? run(call) : { value: expansion('') }
  })
}

type ProcessRunCall = { argv: readonly string[]; init: unknown }
type ProcessRunAnswer = { value: ReturnType<typeof expansion> } | { deny: string }

// Stands in for bash expanding in a directory where no glob matches: every glob
// stays literal, so the output is the argument split on IFS.
function noMatchRun(call: ProcessRunCall): ProcessRunAnswer {
  const args = String(call.argv[4])
  return { value: expansion(args.split(/[ \t\n]+/).filter(Boolean).map(w => w + '\0').join('')) }
}

function expansion(stdout: string, over: { exitCode?: number; isStdoutTruncated?: boolean } = {}) {
  return {
    exitCode: over.exitCode ?? 0,
    stdout,
    stderr: '',
    isStdoutTruncated: over.isStdoutTruncated ?? false,
    isStderrTruncated: false,
  }
}

// In this engine build (2.1.287) a hook's `{ deny }` makes `$.tool.call` resolve to exactly `{ deny: reason }`.
const denyOf = (r: unknown): string | undefined => (r as { deny?: string }).deny

describe('tool.call path', () => {
  for (const row of CORPUS) {
    test(`${row.expect}: ${JSON.stringify(row.command.slice(0, 60))}`, async ($, on) => {
      const state = { reached: 0, runs: [] as ProcessRunCall[] }
      engineStub(on, state, noMatchRun)
      const r = await $.tool.call({ tool: 'Bash', command: row.command })
      expect(state.runs.length).toBe(NEEDS_EXPANSION.has(row.command) ? 1 : 0)
      if (row.expect === 'deny') {
        expect(state.reached).toBe(0)
        expect(denyOf(r)).toBe(TSC_REASON)
      } else {
        expect(state.reached).toBe(1)
        expect(denyOf(r)).toBeUndefined()
      }
    })
  }
})

describe('glob expansion fallback', () => {
  // The kit has no real process: $.process.run is stubbed and the test checks
  // what the plugin sends. Real expansion parity is checked by the bun harness
  // against the original shell hook.
  const expectDeny = async ($: Engine, state: { reached: number }, command: string) => {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(state.reached).toBe(0)
    expect(denyOf(r)).toBe(TSC_REASON)
  }
  const expectAllow = async ($: Engine, state: { reached: number }, command: string) => {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(state.reached).toBe(1)
    expect(denyOf(r)).toBeUndefined()
  }

  test('runs bash with the expansion script, args and session cwd', async ($, on) => {
    const state = { reached: 0, runs: [] as ProcessRunCall[] }
    engineStub(on, state, () => ({ value: expansion('src/a.ts\0') }))
    await expectDeny($, state, 'tsc src/*')
    expect(state.runs).toEqual([
      {
        argv: ['/bin/bash', '-c', EXPAND_SCRIPT, 'tsc-guard', 'src/*'],
        init: { cwd: '/work/dir', timeoutMs: 3000 },
      },
    ])
  })

  test('multi-line command passes the stripped args', async ($, on) => {
    const state = { reached: 0, runs: [] as ProcessRunCall[] }
    engineStub(on, state, () => ({ value: expansion('a.js\0') }))
    await expectAllow($, state, 'cp x y\ntsc src/*')
    expect(state.runs[0]?.argv[4]).toBe('cp x y\nsrc/*')
  })

  test('expansion result replaces the literal words', async ($, on) => {
    const state = { reached: 0, runs: [] as ProcessRunCall[] }
    engineStub(on, state, () => ({ value: expansion('js/x.js\0') }))
    await expectAllow($, state, 'tsc nomatch*.ts')
    expect(state.runs.length).toBe(1)
  })

  test('skip-next applies to the first expanded word', async ($, on) => {
    const state = { reached: 0, runs: [] as ProcessRunCall[] }
    engineStub(on, state, () => ({ value: expansion('-p\0a.ts\0b.js\0') }))
    await expectAllow($, state, 'tsc -p *')
  })

  test('empty expansion allows', async ($, on) => {
    const state = { reached: 0, runs: [] as ProcessRunCall[] }
    engineStub(on, state, () => ({ value: expansion('') }))
    await expectAllow($, state, 'tsc nomatch*.ts')
  })

  test('no spawn without a glob or without the tsc gate', async ($, on) => {
    const state = { reached: 0, runs: [] as ProcessRunCall[] }
    engineStub(on, state)
    await $.tool.call({ tool: 'Bash', command: 'tsc --noEmit' })
    await $.tool.call({ tool: 'Bash', command: 'ls src/*' })
    expect(state.runs.length).toBe(0)
  })

  test('spawn failure keeps the literal words', async ($, on) => {
    const state = { reached: 0, runs: [] as ProcessRunCall[] }
    engineStub(on, state, () => ({ deny: 'spawn failed' }))
    await expectDeny($, state, 'tsc nomatch*.ts')
  })

  test('non-zero exit keeps the literal words', async ($, on) => {
    const state = { reached: 0, runs: [] as ProcessRunCall[] }
    engineStub(on, state, () => ({ value: expansion('js/x.js\0', { exitCode: 1 }) }))
    await expectDeny($, state, 'tsc nomatch*.ts')
  })

  test('truncated output keeps the literal words', async ($, on) => {
    const state = { reached: 0, runs: [] as ProcessRunCall[] }
    engineStub(on, state, () => ({ value: expansion('js/x.js\0', { isStdoutTruncated: true }) }))
    await expectDeny($, state, 'tsc nomatch*.ts')
  })
})

import { test, expect, describe } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { CORPUS } from './corpus'
import {
  gitGuard,
  shellNormalize,
  SP_CODE_LIST,
  DENY_SUFFIX,
  REASON_CHECKOUT,
  REASON_RESTORE,
  REASON_RESET,
  REASON_CLEAN,
} from '../hooks/guard'

const EXEC_RESULT = { stdout: '', stderr: '', interrupted: false }

/**
 * Raises one Bash call through the whole chain (`$.tool.call`, beneath the plugin under test). The stub
 * registered via `on` stands for the engine: it counts how many calls reach it, so an allow is a call that
 * got through and a deny is one that never did.
 */
async function run($: Engine, on: On, command: string) {
  let reached = 0
  on('tool.call', { tool: 'Bash' }, () => {
    reached++
    return { result: EXEC_RESULT } as never
  })
  const out = await $.tool.call({ tool: 'Bash', command })
  const denied = reached === 0
  const text = typeof out.text === 'string' ? out.text : JSON.stringify(out)
  return { denied, text, out }
}

describe('golden corpus through $.tool.call', () => {
  for (const row of CORPUS) {
    test(`${row.expect}: ${JSON.stringify(row.command)}`, async ($, on) => {
      const { denied } = await run($, on, row.command)
      expect(denied).toBe(row.expect === 'deny')
    })
  }
})

describe('deny reasons', () => {
  const cases: readonly [string, string][] = [
    ['git checkout -- f', REASON_CHECKOUT],
    ['git restore f', REASON_RESTORE],
    ['git reset --hard', REASON_RESET],
    ['git clean -fd', REASON_CLEAN],
  ]
  for (const [command, reason] of cases) {
    test(`reason text for ${command}`, async ($, on) => {
      expect(gitGuard(command)).toBe(reason)
      const { denied, text } = await run($, on, command)
      expect(denied).toBe(true)
      expect(text).toContain(reason)
    })
  }

  test('reason strings are exactly the shell script messages plus the fixed suffix', () => {
    expect(DENY_SUFFIX).toBe(
      ' Undo your own edits by editing instead of discarding them; ask Craig for an exception if this destructive command is genuinely needed.',
    )
    expect(REASON_CHECKOUT).toBe(
      'git checkout -- discards working-tree changes. Undo your own edits by editing instead of discarding them; ask Craig for an exception if this destructive command is genuinely needed.',
    )
    expect(REASON_RESTORE).toBe(
      'git restore discards or overwrites working-tree content. Undo your own edits by editing instead of discarding them; ask Craig for an exception if this destructive command is genuinely needed.',
    )
    expect(REASON_RESET).toBe(
      'git reset --hard discards working-tree and index changes. Undo your own edits by editing instead of discarding them; ask Craig for an exception if this destructive command is genuinely needed.',
    )
    expect(REASON_CLEAN).toBe(
      'git clean with a force flag permanently deletes untracked files. Undo your own edits by editing instead of discarding them; ask Craig for an exception if this destructive command is genuinely needed.',
    )
  })
})

describe('pass-through and edge input', () => {
  test('an allowed command reaches the layer beneath exactly once', async ($, on) => {
    let reached = 0
    on('tool.call', { tool: 'Bash' }, () => {
      reached++
      return { result: EXEC_RESULT } as never
    })
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(reached).toBe(1)
  })

  test('a non-Bash tool is not inspected', async ($, on) => {
    let reached = 0
    on('tool.call', { tool: 'Read' }, () => {
      reached++
      return { result: EXEC_RESULT } as never
    })
    // The text of a Read's path is not a Bash command; it must pass through untouched.
    await $.tool.call({ tool: 'Read', file_path: '/tmp/git restore f' } as never)
    expect(reached).toBe(1)
  })

  test('empty, whitespace-only and newline-only commands have no opinion', () => {
    expect(gitGuard('')).toBeUndefined()
    expect(gitGuard('\n\n')).toBeUndefined()
    expect(gitGuard('   ')).toBeUndefined()
    expect(gitGuard('\0')).toBeUndefined()
  })

  test('shellNormalize drops NUL bytes and trailing newlines only', () => {
    expect(shellNormalize('a\0b\n\n')).toBe('ab')
    expect(shellNormalize('\n\na')).toBe('\n\na')
    expect(shellNormalize('a\nb')).toBe('a\nb')
  })

  test('the hard-coded SP table equals JS \\s minus U+FEFF', () => {
    const derived: number[] = []
    for (let c = 0; c < 0x10000; c++) if (/^[^\S﻿]$/u.test(String.fromCharCode(c))) derived.push(c)
    expect([...SP_CODE_LIST]).toEqual(derived)
    expect(SP_CODE_LIST.length).toBe(24)
  })

  // Oracle-backed (216 cases run through hooks/git-guard.sh, jq 1.8.2): jq rejects an escaped unpaired high
  // surrogate, so the shell hook gave no opinion; a lone low surrogate became U+FFFD (a word boundary).
  test('an unpaired high surrogate anywhere means no opinion (jq parse failure)', () => {
    for (const s of ['\ud800', '\udbff', '\ud800\ud800', '\udc00\ud800']) {
      for (const base of ['git restore a', 'git reset --hard', 'git clean -f', 'git checkout -- f']) {
        expect(gitGuard(base + s)).toBeUndefined()
        expect(gitGuard(s + base)).toBeUndefined()
        expect(gitGuard(base + ' ' + s + ' y')).toBeUndefined()
        expect(gitGuard('x' + s + '\n' + base)).toBeUndefined()
        expect(gitGuard(base + '\n' + s)).toBeUndefined()
      }
    }
  })

  test('a lone low surrogate or a valid pair is still inspected; the keyword boundary holds', () => {
    expect(gitGuard('git restore\udc00 f')).toBe(REASON_RESTORE)
    expect(gitGuard('git restore a\udc00')).toBe(REASON_RESTORE)
    expect(gitGuard('git restore a😀')).toBe(REASON_RESTORE)
    expect(gitGuard('git reset --hard 😀')).toBe(REASON_RESET)
    expect(gitGuard('git status \udc00 x')).toBeUndefined()
  })
})

describe('performance: 1 MB adversarial inputs finish in linear time', () => {
  const MB = 1_000_000
  const heavy: readonly [string, string, 'allow' | 'deny'][] = [
    ['checkout then 1M spaces then restore', 'git checkout ' + ' '.repeat(MB) + '; git restore f', 'deny'],
    ['git -C repeated 143k times', 'git -C '.repeat(143_000), 'allow'],
    ['git checkout repeated 77k times', 'git checkout '.repeat(77_000), 'allow'],
    ['clean with a 1M-letter flag token', 'git clean -' + 'n'.repeat(MB) + '1', 'allow'],
    ['clean with 333k -x tokens, no force', 'git clean ' + '-x '.repeat(333_000), 'allow'],
    ['clean with 333k -x tokens then -f', 'git clean ' + '-x '.repeat(333_000) + '-f', 'deny'],
  ]
  // Date.now() is the host's clock here; if a kit ever freezes it every delta reads 0 and the bound is
  // vacuous, in which case the scaling test below (which skips under 5 ms) is vacuous as well.
  for (const [name, command, expected] of heavy) {
    test(`${name}: ${expected}`, { timeoutMs: 30_000 }, async ($, on) => {
      const t0 = Date.now()
      const { denied } = await run($, on, command)
      const elapsed = Date.now() - t0
      expect(denied).toBe(expected === 'deny')
      expect(elapsed).toBeLessThan(1000)
    })
  }

  test('scaling: doubling the input does not quadruple the time', { timeoutMs: 30_000 }, () => {
    const timeIt = (command: string): number => {
      let best = Infinity
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now()
        gitGuard(command)
        best = Math.min(best, Date.now() - t0)
      }
      return best
    }
    for (const make of [
      (n: number) => 'git -C '.repeat(n),
      (n: number) => 'git checkout ' + ' '.repeat(n) + '; git restore f',
      (n: number) => 'git clean ' + '-x '.repeat(n),
    ]) {
      const t1 = timeIt(make(150_000))
      const t2 = timeIt(make(300_000))
      // Below 5 ms the clock's resolution dominates; the 1000 ms bound above still applies.
      if (t1 >= 5) expect(t2 / t1).toBeLessThan(3)
      expect(t2).toBeLessThan(1000)
    }
  })
})

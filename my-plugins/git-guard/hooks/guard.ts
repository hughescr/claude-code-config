// Pure decision logic for the git-guard mod. No 'claude-code' imports, so bun can import it for the
// oracle harness. Behavioural parity with the retired hooks/git-guard.sh (bash 3.2 + BSD grep 2.6.0,
// LANG=en_US.UTF-8) is the bar; see README.md for the quirks that are preserved on purpose.
//
// Character classes (each verified exhaustively over every Unicode code point against /usr/bin/grep and
// /bin/bash 3.2 =~):
//   SP   [[:space:]]  = JS \s minus U+FEFF (24 code points including \n, all in the BMP)
//   WORD grep's `\b` after a keyword ending in a word char = the generated WORD_CLASS table (NOT \p{L}\p{N};
//        grep disagrees with Unicode properties on 9,658 code points). No \p{} is used anywhere, so the
//        result does not depend on the engine's Unicode version.
//   [a-zA-Z] stays ASCII.
import { WORD_CLASS } from './wordchars'

const SP = '[^\\S\\uFEFF]'
const WORD_RE = new RegExp(`[${WORD_CLASS}]`, 'u')
const WB = `(?![${WORD_CLASS}])`

// JS \s minus U+FEFF, as char codes (hard-coded to keep module load cheap; the test suite checks this
// against the regex-derived set).
export const SP_CODE_LIST: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]
const SP_CODES: ReadonlySet<number> = new Set(SP_CODE_LIST)
const isSP = (s: string, i: number): boolean => SP_CODES.has(s.charCodeAt(i))
const SP_SPLIT = new RegExp(`${SP}+`, 'u')

export const DENY_SUFFIX =
  ' Undo your own edits by editing instead of discarding them; ask Craig for an exception if this destructive command is genuinely needed.'
export const REASON_CHECKOUT = 'git checkout -- discards working-tree changes.' + DENY_SUFFIX
export const REASON_RESTORE = 'git restore discards or overwrites working-tree content.' + DENY_SUFFIX
export const REASON_RESET = 'git reset --hard discards working-tree and index changes.' + DENY_SUFFIX
export const REASON_CLEAN = 'git clean with a force flag permanently deletes untracked files.' + DENY_SUFFIX

/** A high surrogate not immediately followed by a low surrogate (no 'u' flag: code units are the point). */
const UNPAIRED_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/

/** What `$(jq -r ...)` leaves in bash 3.2: NUL bytes dropped, trailing newlines stripped. */
export function shellNormalize(cmd: string): string {
  return cmd.replaceAll('\0', '').replace(/\n+$/, '')
}

/** True when index i is at the end of the string or holds a character grep does not treat as a word char. */
function boundaryAt(s: string, i: number): boolean {
  if (i >= s.length) return true
  // A lone low surrogate is a boundary (jq turns it into U+FFFD, which is not a word char). Unpaired high
  // surrogates never reach here: gitGuard returns early on them.
  return !WORD_RE.test(String.fromCodePoint(s.codePointAt(i)!))
}

// ------------------------------------------------------------------ git-prefix scanner
const HIT_CHECKOUT = 1
const HIT_RESTORE = 2
const HIT_RESET = 4
const HIT_CLEAN = 8

const ONE_TOKEN_OPTS: ReadonlySet<string> = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-optional-locks', '--no-replace-objects',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--bare',
  '--exec-path',
])
/** `--opt=v` (1 token, v non-empty) or `--opt v` (2 tokens). */
const VALUE_OPTS = ['--git-dir', '--work-tree', '--namespace'] as const
/** `--opt=v` only (1 token, v non-empty). */
const EQ_ONLY_OPTS = ['--super-prefix=', '--config-env=', '--exec-path='] as const

/**
 * How many tokens the git global option starting at this token consumes (0 = not a global option).
 * Mirrors GIT_GOPT. Exact because every option in the pattern is followed by SP+, so each token start
 * admits at most one option parse.
 */
function optTokens(tok: string): number {
  if (tok === '-C' || tok === '-c') return 2
  if (tok.length > 2 && (tok.startsWith('-C') || tok.startsWith('-c'))) return 1
  if (ONE_TOKEN_OPTS.has(tok)) return 1
  for (const o of VALUE_OPTS) {
    if (tok === o) return 2
    if (tok.length > o.length + 1 && tok.startsWith(o + '=')) return 1
  }
  for (const o of EQ_ONLY_OPTS) if (tok.length > o.length && tok.startsWith(o)) return 1
  return 0
}

/**
 * Bitmask of the subcommand patterns (`${GIT}checkout...--`, `${GIT}restore\b`, `${GIT}reset\b`,
 * `${GIT}clean\b`) that match somewhere in the line. O(line length): replaces the original regexes, which
 * backtrack quadratically.
 */
function gitHits(line: string): number {
  const n = line.length
  // Maximal non-SP runs.
  const ts: number[] = []
  const te: number[] = []
  for (let i = 0; i < n; ) {
    while (i < n && isSP(line, i)) i++
    if (i >= n) break
    const s = i
    while (i < n && !isSP(line, i)) i++
    ts.push(s)
    te.push(i)
  }
  const T = ts.length
  if (T < 2) return 0

  // nextSep[i]: first index >= i holding '|', '&' or ';' (or n).
  const nextSep = new Int32Array(n + 1)
  nextSep[n] = n
  for (let i = n - 1; i >= 0; i--) {
    const c = line.charCodeAt(i)
    nextSep[i] = c === 124 || c === 38 || c === 59 ? i : nextSep[i + 1]!
  }
  // nextDD[t]: smallest token index >= t whose text is exactly '--' (or T).
  const nextDD = new Int32Array(T + 1)
  nextDD[T] = T
  for (let t = T - 1; t >= 0; t--) {
    nextDD[t] = te[t]! - ts[t]! === 2 && line.startsWith('--', ts[t]!) ? t : nextDD[t + 1]!
  }

  // hit[t]: subcommands reachable when the subcommand sits at token t or after any chain of global options.
  const hit = new Uint8Array(T + 1)
  for (let t = T - 1; t >= 0; t--) {
    const s = ts[t]!
    const e = te[t]!
    let h = 0
    if (e - s === 8 && line.startsWith('checkout', s) && e < n) {
      const u = nextDD[t + 1]!
      if (u < T && nextSep[e]! >= ts[u]!) h |= HIT_CHECKOUT
    }
    if (line.startsWith('restore', s) && boundaryAt(line, s + 7)) h |= HIT_RESTORE
    if (line.startsWith('reset', s) && boundaryAt(line, s + 5)) h |= HIT_RESET
    if (line.startsWith('clean', s) && boundaryAt(line, s + 5)) h |= HIT_CLEAN
    const c = optTokens(line.slice(s, e))
    if (c > 0 && t + c < T) h |= hit[t + c]!
    hit[t] = h
  }

  // A token ENDING in 'git' (no left boundary: 'digit', '/usr/bin/git', 'a;git' all count) starts a chain.
  let out = 0
  for (let t = 0; t + 1 < T; t++) {
    if (te[t]! - ts[t]! >= 3 && line.startsWith('git', te[t]! - 3)) out |= hit[t + 1]!
  }
  return out
}

// ------------------------------------------------------------------ other patterns (linear)
const RE_STAGED = new RegExp(`--staged${WB}`, 'u')
const RE_WORKTREE = new RegExp(`(?:--worktree${WB}|-W${WB})`, 'u')
const RE_HARD = new RegExp(`--hard(?:$|${SP})`, 'u')
const ASCII_FLAG = /^-[a-zA-Z]*$/
const isDry = (tok: string): boolean => tok === '--dry-run' || (ASCII_FLAG.test(tok) && tok.includes('n'))
const isForce = (tok: string): boolean => tok === '--force' || (ASCII_FLAG.test(tok) && tok.includes('f'))

/**
 * The deny reason for a Bash command, or undefined when the guard has no objection. Never throws on a
 * string input. Every grep in the original script is independent and per line, ORed over lines.
 */
export function gitGuard(raw: string): string | undefined {
  // The shell hook fed JSON.stringify's output to jq, which rejects an escaped unpaired high surrogate
  // ("Invalid \uXXXX\uXXXX surrogate pair escape"); that parse failure meant "no opinion". Match it.
  // A lone low surrogate is accepted by jq (it becomes U+FFFD, a boundary, which the mod treats the same).
  if (UNPAIRED_HIGH_SURROGATE.test(raw)) return undefined
  const cmd = shellNormalize(raw)
  if (cmd === '') return undefined
  const lines = cmd.split('\n')

  let hits = 0
  for (const l of lines) hits |= gitHits(l)
  const anyLine = (re: RegExp): boolean => lines.some(l => re.test(l))

  if (hits & HIT_CHECKOUT) return REASON_CHECKOUT
  if (hits & HIT_RESTORE) {
    const pureStaged = anyLine(RE_STAGED) && !anyLine(RE_WORKTREE)
    if (!pureStaged) return REASON_RESTORE
  }
  if (hits & HIT_RESET && anyLine(RE_HARD)) return REASON_RESET
  if (hits & HIT_CLEAN) {
    const toks = lines.flatMap(l => l.split(SP_SPLIT))
    if (toks.some(isDry)) return undefined
    if (toks.some(isForce)) return REASON_CLEAN
  }
  return undefined
}

// Pure decision logic for the per-file compiler guard. No claude-code
// imports: the module is exercised by the plugin's tests.
//
// Mirrors the logic of the shell hook it replaced. Two compilers share one
// rule: tsc, and tsrs (the Rust port with tsc's CLI), which like tsc ignores
// the project's tsconfig.json when given file arguments.
//   1. gate: is tsc or tsrs invoked at all (bash [[ =~ ]] on the whole command)?
//   2. args: text after the last `tsc`/`tsrs` on each line (sed -E, per line)
//   3. words: unquoted word splitting (IFS = space, tab, newline), then
//      pathname expansion (done by bash in register.ts when a word has a glob)
//   4. decide: any non-flag word ending .ts/.tsx (outside skip-next flags) denies
//   5. name: the deny reason names the compiler last invoked in the command

export type Compiler = 'tsc' | 'tsrs'

export const reasonFor = (name: Compiler): string =>
  `BLOCKED: ${name} should not be run with individual file arguments. TypeScript needs to process the entire project for proper type-checking. Remove the file arguments and run '${name} --noEmit' instead.`

export const TSC_REASON = reasonFor('tsc')
export const TSRS_REASON = reasonFor('tsrs')

/** The same unquoted expansion (split plus glob) as the original `for word in $tsc_args`. */
export const EXPAND_SCRIPT = `for w in $1; do printf '%s\\0' "$w"; done`

// bash/sed [[:space:]] as macOS resolves it in a UTF-8 locale (the session's):
// ASCII space, \t \n \v \f \r, plus the Unicode spaces iswspace accepts
// (measured against the original hook: U+00A0, U+1680, U+2000-200A, U+2028,
// U+2029, U+202F, U+205F, U+3000; not U+0085 or U+200B). Word splitting (IFS)
// stays ASCII-only, see splitWords.
const SP = '[ \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'

// Linear rewrite of the original gate
//   (^|[[:space:]|;&])(npx|pnpm|yarn)?[[:space:]]*(dlx[[:space:]]+)?(tsc|tsrs)([[:space:]]|$)
// Whenever the optional SP* / dlx part is non-empty, the char before the compiler
// name is a space, which alone satisfies the first group. No `m` flag: ^ and $
// are string anchors. The name must be followed by whitespace or the end, so
// `tsrs-lint` (a different binary) does not match.
const RE_GATE = new RegExp(`(?:^|${SP}|[|;&])(?:npx|pnpm|yarn)?(?:tsc|tsrs)(?:${SP}|$)`, 'u')

// Anchored; removes through the LAST tsc/tsrs on a line (greedy), like sed's `^.*`.
const RE_STRIP = new RegExp(
  `^[^]*(?:^|${SP})(?:npx${SP}+|pnpm${SP}+(?:dlx${SP}+)?|yarn${SP}+)?(?:tsc|tsrs)(?:${SP}|$)`,
  'u',
)

// Every gate match, global, to find which compiler is named last. The trailing
// boundary is a lookahead so `tsc tsrs` still leaves the space for the second
// match to consume as its leading boundary. Linear: fixed-length alternations.
const RE_NAME = new RegExp(`(?:^|${SP}|[|;&])(?:npx|pnpm|yarn)?(tsc|tsrs)(?=${SP}|$)`, 'gu')

const SKIP_NEXT = new Set([
  '-p',
  '--project',
  '--outDir',
  '--outFile',
  '--rootDir',
  '--baseUrl',
  '--declarationDir',
  '--tsBuildInfoFile',
])

/**
 * What bash would hold after `command=$(... jq -r ...)`: NUL bytes cannot live
 * in a bash string, and command substitution strips trailing newlines.
 */
export function shellNormalize(raw: string): string {
  let s = raw.includes('\0') ? raw.replaceAll('\0', '') : raw
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 10) end--
  if (end !== s.length) s = s.slice(0, end)
  return s
}

/**
 * The compiler named last in the command, used only to word the deny reason.
 * Exact for a single-line command (the strip keeps only the text after the last
 * compiler on a line, so that compiler's arguments are the ones that deny); on a
 * multi-line command naming both, an earlier line can be the one that denied.
 * The shell hook applies the same rule with a greedy bash regex.
 */
export function compilerName(raw: string): Compiler {
  let name: Compiler = 'tsc'
  for (const m of shellNormalize(raw).matchAll(RE_NAME)) name = m[1] === 'tsrs' ? 'tsrs' : 'tsc'
  return name
}

/** Text after tsc/tsrs on each line (other lines verbatim), or undefined when neither is invoked. */
export function tscArgs(raw: string): string | undefined {
  const cmd = shellNormalize(raw)
  if (cmd === '') return undefined
  if (!RE_GATE.test(cmd)) return undefined
  return cmd
    .split('\n')
    .map(line => line.replace(RE_STRIP, ''))
    .join('\n')
}

/** Unquoted word splitting: IFS is space, tab and newline only. */
export function splitWords(args: string): string[] {
  return args.split(/[ \t\n]+/).filter(Boolean)
}

/** True when pathname expansion could change a word. */
export function hasGlob(words: readonly string[]): boolean {
  return words.some(w => /[*?[]/.test(w))
}

/** The deny reason (naming `name`) when a non-flag word is a .ts/.tsx file, else undefined. */
export function tscDecide(words: readonly string[], name: Compiler = 'tsc'): string | undefined {
  let skipNext = false
  for (const word of words) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (SKIP_NEXT.has(word)) {
      skipNext = true
      continue
    }
    if (word.startsWith('-')) continue
    if (word.endsWith('.ts') || word.endsWith('.tsx')) return reasonFor(name)
  }
  return undefined
}

/** Literal-words path (no pathname expansion); used by the parity harness. */
export function tscGuard(raw: string): string | undefined {
  const args = tscArgs(raw)
  if (args === undefined) return undefined
  return tscDecide(splitWords(args), compilerName(raw))
}

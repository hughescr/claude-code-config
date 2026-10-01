// Pure helpers for the mods-probe hooks module. No `claude-code` imports, so they are testable as plain functions.

/** Where the probe appends, relative to $HOME. */
export const LOG_RELATIVE_PATH = '.claude/mods-flag.log'

/** The log is trimmed to its newest this-many lines on every append, so it cannot grow without bound. */
export const MAX_LOG_LINES = 2000

/** The line shown in the transcript at session start. */
export const NOTICE = 'mods-probe: hooks modules are ON in this process (logged to ~/.claude/mods-flag.log)'

export type ProbeFacts = {
  /** Milliseconds since the epoch, from `$.clock.now()`. */
  readonly nowMs: number
  /** `$.session.id()`, or undefined when it could not be read. */
  readonly sessionId: string | undefined
  /** `session.start`'s `e.surface`; null for a `-p` or SDK/desktop-host run that draws nowhere yet. */
  readonly surface: string | null
  /** `session.start`'s `e.isInteractive`. */
  readonly isInteractive: boolean
  /** `$.session.version().version`, or undefined when it could not be read. */
  readonly version: string | undefined
}

/** Strips whitespace and control characters so one fact can never break the one-line, space-separated format. */
const field = (value: string): string => value.replace(/[\s\u0000-\u001f\u007f]+/gu, '_')

/**
 * One log line: `<ISO time> session=<id|?> surface=<terminal|desktop|...|none> interactive=<true|false>
 * version=<v|?> on`. The trailing `on` is the only state this probe can report: the module is never loaded while
 * the flag is off, so a line existing means "on".
 */
export const formatLine = (facts: ProbeFacts): string =>
  [
    new Date(facts.nowMs).toISOString(),
    `session=${facts.sessionId === undefined ? '?' : field(facts.sessionId)}`,
    `surface=${facts.surface === null ? 'none' : field(facts.surface)}`,
    `interactive=${facts.isInteractive}`,
    `version=${facts.version === undefined ? '?' : field(facts.version)}`,
    'on',
  ].join(' ')

/** Appends `line` to `existing` (the file's text, '' when missing) and keeps only the newest MAX_LOG_LINES lines. */
export const appendLine = (existing: string, line: string): string => {
  const lines = existing.split('\n').filter(l => l !== '')
  lines.push(line)
  return lines.slice(-MAX_LOG_LINES).join('\n') + '\n'
}

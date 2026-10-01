import type { Register } from 'claude-code'
import { EXPAND_SCRIPT, hasGlob, splitWords, tscArgs, tscDecide } from './guard'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd: unknown = e.command
    if (typeof cmd !== 'string') return next(e)

    const args = tscArgs(cmd)
    if (args === undefined) return next(e)

    let words = splitWords(args)

    if (hasGlob(words)) {
      // Same unquoted expansion (split + pathname) as the old shell hook, by the
      // same bash, in the session's cwd. Any failure keeps the literal words.
      try {
        const r = await $.process.run(['/bin/bash', '-c', EXPAND_SCRIPT, 'tsc-guard', args], {
          cwd: await $.session.cwd(),
          timeoutMs: 3000,
        })
        if (r.exitCode === 0 && !r.isStdoutTruncated) words = r.stdout.split('\0').slice(0, -1)
      } catch {
        // keep literal words
      }
    }

    const reason = tscDecide(words)
    return reason === undefined ? next(e) : { deny: reason }
  })
}

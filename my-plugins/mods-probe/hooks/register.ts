import type { Register } from 'claude-code'
import { LOG_RELATIVE_PATH, NOTICE, appendLine, formatLine } from './probe'

/**
 * Flag probe. This module only runs when the server-side `tengu_plugin_hooks_modules` flag is ON for the process
 * (or DISABLE_GROWTHBOOK=1 forces it), so reaching `session.start` IS the signal.
 *
 * Notice: `$.ui.log`, a transcript line. A toast was rejected: it lasts 4 s, floats over the transcript's corner
 * (one notification-bar line in scrollback mode) and can be missed or never drawn before the first frame at
 * launch, while a transcript line persists and a `-p` or SDK/desktop host receives it as `ui_log`.
 *
 * Every step is isolated: a failing id, version, read or write never stops the others, and never the session.
 */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      $.ui.log(NOTICE)
    } catch {
      // the log line below still records the fact
    }

    const sessionId = await $.session.id().catch(() => undefined)
    const version = await $.session
      .version()
      .then(v => v.version)
      .catch(() => undefined)
    const nowMs = await $.clock.now()
    const line = formatLine({
      nowMs,
      sessionId,
      surface: e.surface,
      isInteractive: e.isInteractive,
      version,
    })

    try {
      const home = await $.env.get('HOME')
      if (home !== undefined && home !== '') {
        const path = `${home}/${LOG_RELATIVE_PATH}`
        // $.fs has no append: read, add one line, write back. Two sessions starting in the same instant can lose
        // a line; for a flag tracker that is acceptable.
        const existing = await $.fs.read(path).then(
          text => (typeof text === 'string' ? text : ''),
          () => '',
        )
        await $.fs.write(path, appendLine(existing, line))
      }
    } catch {
      // never block the session over a log line
    }

    return next(e)
  })
}

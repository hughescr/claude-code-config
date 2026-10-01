import type { Register } from 'claude-code'
import { hugoGuard } from './guard'

export const register: Register = (on) => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const reason = hugoGuard(e.command)
    return reason === undefined ? next(e) : { deny: reason }
  })
}

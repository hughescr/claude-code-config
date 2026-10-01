import type { Register } from 'claude-code'
import { gitGuard } from './guard'

// No subagent filter: tool.call fires for subagents too, as the PreToolUse settings hook did.
export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const command: unknown = e.command
    if (typeof command !== 'string') return next(e)
    const reason = gitGuard(command)
    return reason === undefined ? next(e) : { deny: reason }
  })
}

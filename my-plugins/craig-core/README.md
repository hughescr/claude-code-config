# craig-core

Craig's core Claude setup, packaged so it reaches every surface that loads plugins: the Claude Code CLI and Desktop
Code tab, Cowork, cloud sessions, and (skills only) claude.ai chat.

| Part | Contents |
|---|---|
| `instructions/` | `COMMON-CLAUDE.md` (the global CLAUDE.md), `MAIN-CLAUDE.md` (main session), `SUBAGENT-CLAUDE.md` (sub-agents). The only copy of each. |
| `hooks/` | `inject-instructions.sh`, run by `hooks.json` at SessionStart and SubagentStart. |
| `agents/` | The Claude route agents and `craig-core:project-steward`. Plugin agents are namespaced: `subagent_type: "craig-core:sonnet-high"`. |
| `skills/` | `my-writing-style` (invoked as `craig-core:my-writing-style`). |
| `tests/` | `inject-instructions.test.sh`. |

The cross-family route agents (`gpt-*`, `deepseek-*`) are not here: they live in `~/.claude/agents/` on Craig's Mac,
because they only work through the local utraque proxy. CLAUDE.md's Route availability rule says when they may be
used; everywhere else the pairing table's Claude-only columns apply.

## How the instructions load

| Surface | CLAUDE.md (common) | MAIN / SUBAGENT |
|---|---|---|
| Craig's Mac (CLI, Desktop Code tab) | Natively: `~/.claude/CLAUDE.md` is a tracked symlink to `instructions/COMMON-CLAUDE.md`, which Claude Code loads for the session, sub-agents and Workflow agents. The hook sees this and skips it. | Hook |
| Cowork, cloud sessions | Hook | Hook |
| claude.ai chat | Not loaded (chat runs no hooks); only the skills arrive | Not loaded |

At each event the hook runs once per part (`common`, `role`, `project`), because Claude Code caps every
`additionalContext` string at 10,000 characters and replaces a longer one with a 2,000-character preview. Keep
`COMMON-CLAUDE.md` and `MAIN-CLAUDE.md` well under that: the tests fail when an injected part reaches the cap.

- `common` injects `COMMON-CLAUDE.md` unless `~/.claude/CLAUDE.md` resolves to a craig-core common file (this
  plugin's, a `*/craig-core/instructions/COMMON-CLAUDE.md` anywhere, or a byte-identical copy). The broad match matters
  locally: Claude Code runs the plugin from a cached copy under `~/.claude/plugins/cache/`, while the symlink points
  into `~/.claude/my-plugins/craig-core`.
- `role` injects `MAIN-CLAUDE.md` (SessionStart) or `SUBAGENT-CLAUDE.md` (SubagentStart), then one line saying whether
  the cross-family routes are usable in this session: `ANTHROPIC_BASE_URL` is `http://127.0.0.1:8317` and
  `~/.claude/agents/` holds `gpt-*` or `deepseek-*` agents.
- `project` injects the project's own `.claude/MAIN-CLAUDE.md` or `.claude/SUBAGENT-CLAUDE.md`, if it has one.

The script is POSIX `sh` with no `jq`, so it runs on macOS and the Linux cloud VMs.

## Editing

Edit the files in `instructions/`, never `~/.claude/CLAUDE.md` directly (it is the symlink). Locally, Claude Code
loads the installed copy of this plugin, so run `/reload-plugins` or restart after an edit; the native CLAUDE.md
picks up changes at the next session start.

When a route changes, update the agent file here (or in `~/.claude/agents/` for a cross-family route), both tables in
`COMMON-CLAUDE.md`, and the model-selection plugin (hughescr/model-selection).

## Tests

```bash
bash my-plugins/craig-core/tests/inject-instructions.test.sh   # hook, under sh, dash, ksh and bash
bash tests/hooks-test.sh                                       # repo-level PreToolUse hooks
```

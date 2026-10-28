# craig-core

Craig's core Claude setup, packaged so it reaches every surface that loads plugins: the Claude Code CLI and Desktop
Code tab, the Claude app (chat and Cowork), and cloud sessions.

| Part | Contents |
|---|---|
| `instructions/` | `COMMON-CLAUDE.md` (the global CLAUDE.md), `MAIN-CLAUDE.md` (main session), `SUBAGENT-CLAUDE.md` (sub-agents). The only copy of each. |
| `hooks/` | `inject-instructions.sh`, run by `hooks.json` at SessionStart and SubagentStart; `require-route-effort.sh`, run before every Agent call. |
| `agents/` | The Claude route agents (`opus`, `sonnet`, `haiku`, `fable`: one per model, pinning the model and no effort) and `craig-core:project-steward` (pins both). Plugin agents are namespaced: `subagent_type: "craig-core:sonnet", effort: "high"`. |
| `skills/` | `my-writing-style` (invoked as `craig-core:my-writing-style`) and `routing-refresh` (Craig runs `/routing-refresh`; its `EVIDENCE.md` holds the facts behind the routes). |
| `tests/` | `inject-instructions.test.sh`, `require-route-effort.test.sh`. |

The cross-family route agents (`gpt-*`, `deepseek-*`) are not here: they live in `~/.claude/agents/` on Craig's Mac,
because they only work through the local utraque proxy. CLAUDE.md's Route availability rule says when they may be
used; everywhere else the pairing table's Claude-only columns apply.

## How the instructions load

| Surface | CLAUDE.md (common) | MAIN / SUBAGENT |
|---|---|---|
| Craig's Mac (CLI, Desktop Code tab) | Natively: `~/.claude/CLAUDE.md` is a tracked symlink to `instructions/COMMON-CLAUDE.md`, which Claude Code loads for the session, sub-agents and Workflow agents. The hook sees this and skips it. | Hook |
| Claude app (chat and Cowork), cloud sessions | Hook | Hook |

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

## Route effort enforcement

Each route agent (`craig-core:opus|sonnet|haiku|fable` here; `gpt-sol`, `gpt-astra`, `gpt-luna`, `gpt-terra`, `deepseek-flash`,
`deepseek-v4-pro` in `~/.claude/agents/`) pins its model and no effort, so the caller picks the effort from the
CLAUDE.md routing table. An Agent call without `effort` would silently inherit the parent session's effort.
`hooks/require-route-effort.sh` (PreToolUse, matcher `Agent`) denies missing `effort` only when
`CLAUDE_CODE_ENTRYPOINT` is `cli` or `sdk-cli`, or unset/empty. Other entrypoints fail open. The Claude app
(`remote_cowork`, chat and Cowork) is verified: its Agent tool has no effort parameter, and the hook allows the call.
Desktop Code and other cloud surfaces are unverified. Without the parameter, route agents inherit the session effort;
the role injection explains that fallback on non-CLI entrypoints.
The hook denies passing `model` on every surface and allows every other Agent call. Add newly verified
entrypoints to its `EFFORT_ENTRYPOINTS` list. It is POSIX `sh` plus `jq`; without `jq` it reports the problem on
stderr and allows the call.

## Editing

Edit the files in `instructions/`, never `~/.claude/CLAUDE.md` directly (it is the symlink). Locally, Claude Code
loads the installed copy of this plugin, so run `/reload-plugins` or restart after an edit; the native CLAUDE.md
picks up changes at the next session start.

When a route changes, update the agent file here (or in `~/.claude/agents/` for a cross-family route), both tables in
`COMMON-CLAUDE.md`, the `ROUTES` list in `hooks/require-route-effort.sh` (and in its test), and
`skills/routing-refresh/EVIDENCE.md`, the facts behind the routes. `/routing-refresh` runs the update.

## Tests

```bash
bash my-plugins/craig-core/tests/inject-instructions.test.sh   # injector, under sh, dash, ksh and bash
bash my-plugins/craig-core/tests/require-route-effort.test.sh  # Agent effort hook, same shells
bash tests/hooks-test.sh                                       # repo-level PreToolUse hooks
```

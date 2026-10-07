# utraque launch settings

Claude Code reaches the `utraque` proxy (`127.0.0.1:8317`) only through environment
variables that `claude-smart.sh` (the `claude` alias) exports at launch, and only when
`GET /healthz` answers within 1 second. If the proxy is not answering, none are set and
Claude Code talks to `api.anthropic.com` directly. That holds only for a clean launch:
`claude-smart.sh` never unsets an inherited `ANTHROPIC_BASE_URL`. `settings.json` sets none of them, so
check the session's environment, not `settings.json`.

| Variable | Value | Effect |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8317` | The on/off switch. Claude requests pass through untouched; `gpt-*` and `deepseek-*` model names route to the Codex and DeepSeek legs. |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` | Queries the gateway's `/v1/models` for the `/model` picker. Only tried when an API key or auth token is present; agent frontmatter routes work without it. |
| `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` | `1` | Required; see below. |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `272000` | Context window for models whose name does not start with `claude-` (the Codex leg's real cap). Never affects Claude models. |

## Why `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` is required

Claude Code grants a model its native context window only when the base URL is
Anthropic's own host. With `ANTHROPIC_BASE_URL` pointing anywhere else, every Claude model
falls from its native 1M window to the 200,000-token default. A session whose live
context is already past that limit then loops: auto-compact must summarise a history
larger than the limit it compacts to, the request fails, the context never shrinks, and
compaction re-fires forever (observed on Opus).

The variable tells the client to treat the base URL as first-party, which restores
native window detection. That is accurate: utraque forwards the Anthropic leg to
`api.anthropic.com` with the client's own credential. It does not apply to Remote Control
sessions.

It does not defeat a second, server-side clamp that applies when 1M context needs credits
the plan does not cover; that clamp happens without the proxy too. Run `/context`: 1M
means the base-URL cause is handled; 200k means the server-side clamp. The only local
override (`DISABLE_COMPACT=1 CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 ~/.local/bin/claude`) sets that
window for every model, `gpt-*` included, and turns off auto-compact, so use it only to
diagnose. Call the binary, not the `claude` alias: `claude-smart.sh` overwrites
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` with 272000 when the proxy answers.

## Open actions

- **Proxy auth is off.** The proxy runs unauthenticated, so any local process can spend
  both subscriptions through `127.0.0.1:8317`. To turn it on, set `UTRAQUE_LOCAL_TOKEN` on
  the proxy (`deploy/install.sh --local-token-file`) and export
  `ANTHROPIC_CUSTOM_HEADERS="X-Utraque-Token: <token>"` from `claude-smart.sh`, reading the
  token from a file rather than committing it. `/healthz` is exempt from the token.
- **The health hook is not wired.** `hooks/utraque-health.sh` (proxy, Codex credential,
  catalog, and quota state at session start; fails soft) runs only once added to
  `hooks.SessionStart` in `settings.json` with `"timeout": 5`.

## Reverting

- One session: launch the native binary (`~/.local/bin/claude`) instead of the alias
  (killing the proxy is not enough while launchd holds its socket: the wrapper's
  health probe restarts it). Every `gpt-*` and `deepseek-*` route then fails to resolve; Claude
  routes are unaffected only in a clean launch. From a shell that already has
  `ANTHROPIC_BASE_URL` set, use `env -u ANTHROPIC_BASE_URL ~/.local/bin/claude`. If the proxy
  dies mid-session, every request in an already-proxied session fails, Claude routes included,
  while the proxy is down.
- Permanently: delete the utraque block from `claude-smart.sh`, remove the health-hook
  entry if it was wired, and uninstall the launchd agent with
  `deploy/uninstall.sh --unload` in the utraque repo.

# utraque settings delta

**This file is documentation, not an applied change.** Nothing in this branch turns
the proxy on. Apply the keys below to the **live** `/Users/craig/.claude/settings.json`
when you decide to go live. Until you do, every `gpt-*` agent route is inert: it will
fail to resolve its model, and all Claude routes behave exactly as they do today.

**Merge hazard, read first.** The live `settings.json` currently has an uncommitted
change (`"model": "fable"` removed, `"advisorModel": "opus"` added). The committed copy
on this branch still has the old content. Commit or stash the live change **before**
merging this branch, or the merge will conflict on `settings.json` or clobber it.

---

## 1. Required — add to the existing `env` object

None of these collide with the 11 OTEL keys already there.

```jsonc
"ANTHROPIC_BASE_URL": "http://127.0.0.1:8317"
```
Sends every request through utraque. Must match the proxy's `UTRAQUE_LISTEN`. This is
the single on/off switch for the whole integration — with it set, the Anthropic leg is
forwarded untouched and GPT model names route to the Codex leg.

---

## 2. Recommended — also in `env`

```jsonc
"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
```
Turns on `GET /v1/models` against the gateway, so the GPT models appear as rows in the
`/model` picker. Optional in the strict sense: GPT names already route when typed or set
in agent frontmatter, which is how the `gpt-*` routes work. Note that Claude Code only
attempts gateway discovery when an API key or auth token is present, so on a plain Max
subscription session the Claude half of the picker still comes from the client's
built-in list.

---

## 3. Think before adding — `CLAUDE_CODE_MAX_CONTEXT_TOKENS`

```jsonc
"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "272000"
```

**Recommendation: leave this out of `settings.json`.** Set it per-session in the shell
instead, when you are about to run a GPT-heavy session:

```sh
CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000 claude
```

Why the value would be 272000: it is the real cap the Codex catalog reports for every
live GPT route — `gpt-sol-*`, `gpt-terra-*`, `gpt-luna-*` all show a 272000-token window.
(OpenAI's own API docs quote a larger figure for some of these models, but the Codex
subscription caps them at 272000, and that is the number that governs here.)

Why it is risky as a global setting — this is one number applied to every model id,
recognised or not:

- **It overrides the models the client already knows.** Claude Code has correct built-in
  windows for Claude model ids. A global 272000 tells a 200k-window Claude session to
  keep going past its real limit, so compaction fires too late and the session fails with
  a context overflow instead of compacting. On a 1M-context Claude model it does the
  opposite: it throws away roughly three quarters of a window you are paying for.
- **It is wrong for one GPT route in the other direction.** `gpt-spark-high` has a
  **128000**-token window, not 272000. A global 272000 lets a spark session grow to more
  than twice its real limit before the client thinks about compacting; the request then
  fails upstream. Spark's role — fast, bounded edit-test-lint loops — keeps sessions
  short enough that this rarely bites, but the guard is your discipline, not the setting.
- **The conservative alternative is 128000**, which is safe for every model in play
  including spark and including 200k Claude models, at the cost of compacting GPT
  sessions less than halfway into a window they could have used.

There is no single correct global value, because the client applies one number to models
with three different real windows (128k, 272k, and Claude's 200k/1M). Omitting the key
leaves each model on the client's own default, which is the least-surprising behaviour;
add it per-session when a specific GPT run needs the full 272k.

---

## 4. Required — wire the health hook

Append a **third** entry to the existing matcher-less `hooks.SessionStart` group, after
`inject-main-context.sh`:

```jsonc
{ "type": "command",
  "command": "${HOME}/.claude/hooks/utraque-health.sh",
  "timeout": 5 }
```
Reports proxy state, Codex credential state, catalog state and quota burn-down at session
start. It fails soft by design: the request is capped at 2 seconds, and it prints nothing
at all when the proxy is unreachable and `ANTHROPIC_BASE_URL` is unset, so it can never
block or slow a session. When `ANTHROPIC_BASE_URL` **is** set and the proxy is down, it
prints how to start utraque and how to back the change out.

Under launchd this request is also what activates the daemon, since launchd holds the
listening socket — so the first session of the day warms the proxy for free.

---

## 5. Security — decide deliberately

The proxy currently runs **unauthenticated**. Any local process can reach
`127.0.0.1:8317` and spend both the Anthropic and the Codex subscription through it.
utraque's README recommends turning the loopback token on.

If you set `UTRAQUE_LOCAL_TOKEN` on the proxy, every request except `/healthz` must carry
it back, so add to `env`:

```jsonc
"ANTHROPIC_CUSTOM_HEADERS": "X-Utraque-Token: <the token>"
```
Two consequences worth weighing: `settings.json` takes a literal value, so the token sits
in plain text in a file you commit to git — keep it in the **local** settings file, not
this repo's tracked one. And the health hook needs no change either way, because
`/healthz` is exempt from the token.

---

## 6. Optional — `permissions.allow`

```jsonc
"Bash(curl -s http://127.0.0.1:8317/healthz*)"
```
Only if you want agents to check proxy health by hand. The SessionStart hook does not
need it — hooks bypass the permission system. Note the sandbox's `network.allowedHosts`
does not currently name loopback, so a sandboxed `Bash` curl may still be refused even
with this entry; the hook is the reliable path.

---

## 7. Reverting

**Remove `ANTHROPIC_BASE_URL`.** That is the whole rollback. Everything else is inert
without it:

- the `gpt-*` agent routes fail to resolve their models and are simply unusable;
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` has no gateway to query;
- the health hook goes silent, because it only warns when `ANTHROPIC_BASE_URL` is set;
- Claude routes are untouched throughout — they never stopped going to Anthropic
  directly, they were only being forwarded.

To back out further: remove the SessionStart hook entry, and remove
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` if you added it (that one does change Claude session
behaviour, so it is the only key worth removing promptly). Uninstall the launchd agent
with `deploy/uninstall.sh --unload` in the utraque repo.

---

## 8. Before trusting the routes — one thing to verify

The `gpt-*` agents pin `effort` in frontmatter (`effort: high` and so on). Confirm that
Claude Code actually forwards that effort to the gateway, rather than dropping it. It
matters because `sol` defaults to **low** effort at the proxy: if the frontmatter effort
does not reach utraque, `gpt-sol-high` silently becomes a low-effort run, which is
exactly the wrong failure mode for a consequential-review route.

Check the proxy's per-request log line, which carries `client_model`, `upstream_model`
and `effort`. If `effort` does not match the frontmatter, switch the `model:` field in
those agent files to the effort-suffixed form utraque also accepts — `sol-high`,
`sol-xhigh`, `terra-medium` — and keep the `effort:` key as harness bookkeeping.

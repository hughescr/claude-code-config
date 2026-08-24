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

One caveat on that recommended path: what Claude Code's default window is for a model id
it does not recognise is undocumented, and it is almost certainly above spark's real
128000. Omitting the key therefore does **not** make `gpt-spark-high` safe — it only
avoids breaking the Claude routes. For a spark-heavy session, set the key **down**:

```sh
CLAUDE_CODE_MAX_CONTEXT_TOKENS=128000 claude
```

---

## 4. Required — wire the health hook

**Merge this branch first.** `~/.claude` is this git repo, so `hooks/utraque-health.sh`
only exists at the path below once `utraque-integration` is merged into the live branch.
Adding this entry before the merge points `SessionStart` at a missing command on every
session start.

Then append a **third** entry to the existing matcher-less `hooks.SessionStart` group,
after `inject-main-context.sh`:

```jsonc
{ "type": "command",
  "command": "${HOME}/.claude/hooks/utraque-health.sh",
  "timeout": 5 }
```
Reports proxy state, Codex credential state, catalog state and quota burn-down at session
start. It fails soft by design: every path exits 0, the stdin drain is bounded by a
1-second read timeout, and the request is capped at 2 seconds against a 5-second hook
timeout, so it cannot block a session start. When `ANTHROPIC_BASE_URL` is unset it exits
immediately without even probing. When `ANTHROPIC_BASE_URL` **is** set and the proxy is
down, it prints how to start utraque and how to back the change out.

It also checks identity, not just reachability: it only reports "utraque is up" when the
response carries the three fields `/healthz` always has (`status`, `version`, `uptime_s`).
Anything else answering that port is reported as an unknown process, not as a healthy
proxy.

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
- the health hook goes silent, and does not even probe: with `ANTHROPIC_BASE_URL` unset it
  exits before the network call, so it neither nags nor re-activates a launchd-held daemon
  on every session start (set `UTRAQUE_HEALTH_URL` if you want to probe anyway);
- Claude routes are untouched throughout — they never stopped going to Anthropic
  directly, they were only being forwarded.

To back out further: remove the SessionStart hook entry, and remove
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` if you added it (that one does change Claude session
behaviour, so it is the only key worth removing promptly). Uninstall the launchd agent
with `deploy/uninstall.sh --unload` in the utraque repo.

---

## 8. Why the agent files name `sol-high` and not `sol`

**Do not "tidy" the `model:` values back to bare aliases.** Every `gpt-*` agent names an
effort-suffixed model (`model: sol-high`, `terra-medium`, `luna-low`, `spark-high`)
because the suffix is the **only** channel that carries effort to the proxy.

This was checked in utraque's source, not assumed. `chooseEffort`
(`internal/translate/request/request.go:504`) tries, in order: a model-name suffix, then
`Options.BetaEffort`, then `Options.ConfigEffort`, then the model's catalog default. The
two `Options` fields are declared but never assigned outside tests, and
`internal/router/resolve.go:104` says so outright ("Phase 3/4 adds EffortSourceBeta
precedence; it is unused today"). There is no request field an Anthropic-shaped client can
set. With a bare alias the catalog default wins, so `model: sol` would run at **low** —
`gpt-sol-medium`, `gpt-sol-high` and `gpt-sol-xhigh` would be three names for the same
cheapest-possible request, which is the exact wrong failure mode on a consequential-review
route.

The `effort:` key stays in the frontmatter as harness bookkeeping, because CLAUDE.md
requires every route to pin both `model` and `effort`. It is documentation; the suffix is
what acts.

Confirm once when you first go live, using the proxy's per-request log line, which carries
`client_model`, `upstream_model` and `effort`: a `gpt-sol-xhigh` spawn should log
`client_model=sol-xhigh` and `effort=xhigh`. If a future utraque release starts honouring
a request-level effort field, these files can go back to bare aliases; until then the
suffix is load-bearing.

Note also that `ultra` (sol and terra only) has no agent route, because CLAUDE.md's route
table does not define an `ultra` tier. Reach it, if ever, by naming `sol-ultra` directly.

---

## 9. Pre-merge requirement — publish the `model-selection` submodule commit

This branch bumps the `skills/model-selection` submodule pointer to `d5b1327`, the tip of
local branch `utraque-routing` (which also carries `0d2f986`, "Add GPT gateway routes and
cross-family verification pairings"). Together they hold the routing table and the
cross-family pairings the new `gpt-*` rows depend on.

**Those commits are not yet reachable from any remote.** They exist only in this worktree's
submodule clone. Merging this branch without publishing them first leaves the live checkout
unable to `git submodule update` — it fails with "did not contain d5b1327" and the skill
silently stays on `ae3de9f`, i.e. with none of the `gpt-*` routing content that CLAUDE.md
now advertises.

Push it before merging:

```sh
cd /Users/craig/.claude-worktrees/utraque-integration/skills/model-selection
git push git@github.com:hughescr/model-selection.git utraque-routing
```

Note the fork: the live submodule clone's `origin` is `hughescr/model-selection`, but
`.gitmodules` recorded the upstream `tkellogg/model-selection`, which will never hold
Craig's commits. This branch corrects `.gitmodules` to name the fork, so a fresh clone
initialises the submodule against a remote that can actually serve this pointer.

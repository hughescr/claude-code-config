# Routing evidence

The facts behind the routes and pairing tables in `COMMON-CLAUDE.md`. Read this only when routes are being changed; normal sessions do not load it. When a route, model, effort, or price changes, update this file together with both CLAUDE.md tables, the agent files, and the `ROUTES` list in `hooks/require-route-effort.sh`.

## Local gateway routes

The `gpt-*` routes reach OpenAI models over the `utraque` proxy on `127.0.0.1:8317`, billed to the Codex subscription. The `deepseek-*` routes reach DeepSeek's Anthropic-compatible endpoint over the same proxy and spend a prepaid DeepSeek API balance, so they are the only metered routes. There is one route agent per model, and every `Agent` call passes `effort` (written "`route` @ `effort`", e.g. `craig-core:opus` @ `high`). The Claude route agents (`craig-core:opus`, `craig-core:sonnet`, `craig-core:haiku`, `craig-core:fable`) ship in the `craig-core` plugin; the `gpt-*` and `deepseek-*` route agents live in `~/.claude/agents/` on Craig's Mac only. When these routes count as available, and the Claude-only fallback when they do not, is the Route availability rule in CLAUDE.md.

| Route | Model name sent | Peer Claude route | Allowed efforts |
|---|---|---|---|
| `gpt-astra` | `astra` (GPT-6 Astra) | `craig-core:opus` @ `high`, `craig-core:opus` @ `xhigh` | `medium`, `high`, `xhigh` |
| `gpt-sol` | `sol` (GPT-6.1 Sol) | `craig-core:sonnet` @ `high` | `medium`, `high`, `xhigh` |
| `gpt-luna` | `luna` (GPT-6 Luna) | `craig-core:haiku` @ `low` | `low`, `medium` |
| `gpt-terra` | `terra` (GPT-6.1 Terra) | `craig-core:haiku` @ `low`/`xhigh`/`max` (at `low`/`medium`/`high`), `craig-core:sonnet` @ `high` (at `xhigh`/`max`, the tier of `gpt-sol` @ `medium`) | `low`, `medium`, `high`, `xhigh`, `max` |
| `deepseek-flash` | `deepseek-flash` (V4.1 Flash 1017) | `craig-core:haiku` (at `low`), `craig-core:sonnet` @ `medium` (at `medium`), `craig-core:sonnet` @ `high` (at `high`) | `low`, `medium`, `high` |
| `deepseek-v4-pro` | `deepseek-v4-pro` (V4 Pro 0813); no image input | `craig-core:sonnet` @ `medium` (at `low`), `craig-core:opus` @ `medium` (at `medium`), `craig-core:opus` @ `high` (at `high`) | `low`, `medium`, `high` |

### Effort mechanics

Measured on Claude Code 2.1.306, 2026-10-21, except where dated otherwise.

- **The Agent tool's `effort` parameter** (`low|medium|high|xhigh|max`) reaches the API as `output_config.effort`. Precedence: Agent `effort` > agent frontmatter `effort` > parent session effort. A forgotten parameter silently inherits the parent's effort, which is why CLAUDE.md requires it; a `craig-core` PreToolUse hook enforces it.
- **The Agent `model` parameter accepts only `sonnet|opus|haiku|fable`.** Any other string, including a GPT alias or a full Claude model ID, fails with `InputValidationError`. A non-Claude model therefore needs an agent file whose frontmatter `model:` names it, which is why the `gpt-*` and `deepseek-*` routes are agent files.
- **`utraque` resolves effort as model-name suffix > body `output_config.effort` > default**, and logs `effort_source` (`suffix|body|default`) beside `effort_requested` and `effort_applied`. Use bare aliases (`sol`, `astra`, `luna`, `terra`) so the Agent parameter decides; a suffixed alias (`sol-high`) would override it.
- **The Codex leg clamps effort to the model's live catalog levels**, and sends it unclamped when the catalog is unavailable. `utraque` has no per-model effort override. Check `effort_applied` in the log line, not the request.
- **Terra's catalog lists `low` through `ultra`** (checked 2026-10-27), so `xhigh` and `max` pass the clamp. The proxy log of 2026-10-27 showed Terra running only at `medium` and `high`; `xhigh` and `max` are catalog-supported but not yet observed.
- **The DeepSeek leg maps** `low`→`low`, `medium`→`high`, `high`→`high`, `xhigh`→`high`, `max`→`max`, because DeepSeek accepts only `low`, `high`, and `max` ([thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)). So `medium` and `high` run identically there, and `xhigh` buys nothing. DeepSeek model names take no suffix.
- **`utraque` translates Claude Code's mid-conversation `tool_addition` and `tool_removal` blocks** for both the GPT and DeepSeek legs: it hoists added tools into the tools list and honors removals.

### Facts that constrain these routes

- **Context windows.** The live Codex catalog (`utraque` cache `~/Library/Caches/utraque/models_cache.json`, checked 2026-10-27) lists 500,000-token windows for GPT-6.1 Sol and GPT-6.1 Terra and 272,000 for GPT-6 Astra and GPT-6 Luna. AA lists 1M for Sol and Terra, but the subscription leg does not offer it. Never plan a task larger than a route's window onto it. DeepSeek windows are unverified.
- **Keep luna off long context.** Its long-context recall is poor, so it degrades quietly rather than failing.
- **Route agent files carry the bare model name and no `effort` key.** The Agent `effort` parameter is the only effort setting; confirm what a request ran with from the proxy's per-request log line (`client_model`, `upstream_model`, `effort_source`, `effort_requested`, `effort_applied`).
- **On the DeepSeek leg the model name must be exact** (`deepseek-flash`, `deepseek-v4-pro`; a suffix is rejected).
- **No `ultra` route.** The Agent `effort` enum stops at `max`. Reaching `ultra`, if ever, needs a dedicated agent file whose `model:` is the suffixed name `sol-ultra` (unverified for GPT-6.1 Sol).
- **Bare aliases float to the newest model with that codename**; pinned names (`sol-6`) keep older ones. The backend withholds new models from older Codex CLI clients, so check `/v1/models` before assuming which model a route runs.
- Do not route to `gpt-5.3-codex-spark` or `codex-auto-review`.

### Proxy availability

These routes work only when `ANTHROPIC_BASE_URL` is `http://127.0.0.1:8317`. The `claude` alias (`claude-smart.sh`) sets it at launch when the proxy answers healthy, so check the environment variable, not `settings.json`. Without it the model name reaches `api.anthropic.com` and is rejected. See `~/.claude/UTRAQUE-SETTINGS-DELTA.md`.

For availability prefer the proxy's own state: `GET /healthz` reports Codex auth, catalog state and model count, transport, and quota, and `GET /v1/models` lists what is routable now (DeepSeek rows only when a DeepSeek key is configured). When the proxy is down every `gpt-*` and `deepseek-*` route fails immediately; Claude routes are unaffected only in sessions launched without the proxy. In a session already routed through it, all requests fail while the proxy is down. The GPT leg uses the Codex subscription credential, so fix a stale one with `codex login`, not by rerouting. The DeepSeek leg answers `503` when no prepaid key is configured.

### Tool schemas

`utraque` sends `"strict": false` on every Responses function tool (since utraque 1.1.1+25507e7). Without it the API treats tools as strict and forces GPT models to fill every optional field, so GPT route agents passed `model` and `isolation` on Agent calls and the craig-core hook denied them. If GPT agents start passing optional Agent fields again, check this first.

## Intelligence-cost snapshot

Artificial Analysis Intelligence Index @ cost per index task, as of 2026-10-26. `~` marks a chart reading; `—` is unpublished. AA's effort names are its own settings. Cost is metered only on the DeepSeek leg; on the subscription legs read it as quota burn.

| Model | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| Claude Opus 5.5 | 42 @ $0.55 | 51 @ $1.34 | 54 @ $1.82 | 56 @ $3.46 | 58 @ $5.98 |
| Claude Sonnet 5.5 | 36 @ $0.35 | 41 @ $0.48 | 47 @ $0.88 | 52 @ $2.01 | 56 @ $5.46 |
| Claude Haiku 5.5 | 30 @ $0.025 | 35 @ $0.047 | 38 @ $0.079 | 41 @ $0.12 | 43 @ $0.21 |
| Claude Fable 5.1 | 47 @ $2.37 | 49 @ $2.98 | 51 @ $3.91 | 53 @ $5.98 | 53 @ $7.63 |
| GPT-6.1 Sol | 42 @ $0.13 | 48 @ $0.21 | 50 @ $0.32 | 51 @ $0.39 | 52 @ $0.72 |
| GPT-6 Astra | 46 @ $0.82 | 50 @ $1.54 | 51 @ $1.73 | 52 @ $2.31 | 53 @ $3.26 |
| GPT-6.1 Terra | 36 @ $0.055 | 41 @ $0.095 | 44 @ $0.13 | 45 @ $0.19 | 48 @ $0.40 |
| GPT-6 Luna | 22 @ $0.0045 | 30 @ $0.018 | 33 @ $0.029 | 35 @ $0.042 | 38 @ $0.068 |
| DeepSeek V4.1 Flash 1017 | — | — | — | — | 45 @ $0.26 |
| DeepSeek V4 Pro 0813 | — | — | — | — | ~36 @ ~$0.68 |

- **DeepSeek Flash is measured only at `max`,** which the route never runs (the DeepSeek leg sends `low` or `high`), so its capability at the route's efforts is unmeasured.
- **Haiku prices by per-request prompt length:** up to 100k tokens $0.10/$0.50 per 1M input/output; above 100k every category rises 5x. That drives the CLAUDE.md rule sending prompts expected to stay under 100k to `craig-core:haiku`.
- **Haiku's long-context recall is unmeasured**, so prompts above 100k stay on `craig-core:sonnet` @ `medium` until it is measured.
- **No `craig-core:sonnet` @ `xhigh` or @ `max`:** `craig-core:opus` @ `high` dominates Sonnet xhigh, and `craig-core:opus` @ `xhigh` ties Sonnet max at about 63% of the cost.
- **No `craig-core:opus` @ `max`:** Opus xhigh beats max on Terminal-Bench at about 1.7x lower cost.

### GPT-6.1 Terra

Sources: [AA Terra](https://artificialanalysis.ai/models/releases/gpt-6-1-terra), [AA Sol](https://artificialanalysis.ai/models/releases/gpt-6-1-sol), [OpenAI announcement](https://openai.com/index/introducing-gpt-6-1-terra/).

- **Index (AA Intelligence Index v4.3.2):** max 48, xhigh 45, high 44, medium 41, low 36, non-reasoning 33. Non-reasoning is not reachable through the Agent `effort` parameter.
- **Price:** $1 in / $5 out per 1M tokens against Sol's $2 / $10, with a 95% cache discount on both.
- **Token use:** about 2x Sol's output tokens on the index (130M vs 67M), so cost per index task at max is $0.40 against Sol's $0.72 at max. Speed is about 91 against about 77 output tokens per second.
- **Long context:** no published recall (AA-LCR per-model subscores are not shown), so prefer Sol or a Claude route for prompts well over 100k tokens.
- **OpenAI's claims:** "a fast, efficient model" at an API price 50% below Sol that completes tasks more than 3x faster than Sol and Astra. Strongest at visual reasoning, computer use, and technical drawings to 3D; close to Sol and Astra on MMMU-Pro and Agents' Last Exam (on par with Astra there at medium); Terminal-Bench 4.0 50.3% at max. "For the most complex coding tasks, GPT-6.1 Sol and GPT-6 Astra remain the better choice."
- **Craig's experience:** Sol and Terra are notably good at 3D conceptual and geometry work; Terra is very smart for its cost.

### Terra, Sol, or Astra

- **Terra @ `xhigh`** is the cheaper peer of Sol @ `medium`: 45 against 48 on the index at about 10% lower cost per task.
- **Terra @ `max`** ties Sol @ `medium` on the index (48) at about 1.9x the cost, so reserve it for visual, 3D, and geometry work.
- **Sol @ `medium`/`high`** for normal and multi-file work; Sol @ `high` is the routine challenger.
- **Astra** for the hardest, consequential, and security work.

## Cross-family verification

The pairing tables with their Claude-only columns, the tiebreak, and the security override live in CLAUDE.md. In addition, when cross-family routes are available:

- If `gpt-sol` @ `high` fails as the challenger for `craig-core:sonnet` @ `high` or `craig-core:opus` @ `medium`, use `gpt-astra` @ `medium`, escalating to `gpt-astra` @ `high`.
- `craig-core:sonnet` @ `high` is also an acceptable routine challenger for `gpt-sol` @ `medium`.
- `deepseek-flash` is a fit challenger when metered-cheap is the right price for a second opinion.

### Security routing

Why CLAUDE.md sends security work — doing it and reviewing it — to `gpt-astra` and, Claude-only, to `craig-core:opus` @ `high` or @ `xhigh` but never `craig-core:fable` or `craig-core:haiku`: Anthropic re-routes most cybersecurity tasks on Opus and Fable to an older Opus, and higher-risk ones on Sonnet visibly fall back to an older Sonnet, so no Claude route is full-strength for security and a Claude route reviewing GPT's security work may be running the older model. Routine bug finding and fixing in normal development is unaffected. Haiku has no fallback: a cyber-classifier decline returns `stop_reason: "refusal"` and stays declined, so `craig-core:haiku` never runs security work. A Claude-only security check is reported as same-family and as possibly run on an older Opus.

Anthropic's and OpenAI's classifiers also over-refuse defensive work on Craig's own systems: sysadmin tasks such as CA certificate repair, and network scans for insecure devices, have drawn refusals from both families. DeepSeek filters less, so CLAUDE.md falls back to `deepseek-flash` @ `high` when both refuse. Flash rather than `deepseek-v4-pro`, because Flash 1017 is the stronger DeepSeek model (AA index 45 vs 36 at `max`). The leg is a metered third-party API: send only what the task needs, never private keys or credentials.

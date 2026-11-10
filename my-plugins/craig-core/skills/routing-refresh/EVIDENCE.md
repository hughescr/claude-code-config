# Routing evidence

The facts behind the routes and pairing tables in `COMMON-CLAUDE.md`. Read this only when routes are being changed; normal sessions do not load it. When a route, model, effort, or price changes, update this file together with both CLAUDE.md tables, the agent files, and the `ROUTES` list in `hooks/require-route-effort.sh`.

## Local gateway routes

The `gpt-*` routes reach OpenAI models over the `utraque` proxy on `127.0.0.1:8317`, billed to the Codex subscription. The `deepseek-*` routes reach DeepSeek's Anthropic-compatible endpoint over the same proxy and spend a prepaid DeepSeek API balance, so they are the only metered routes. There is one route agent per model, and every `Agent` call passes `effort` (written "`route` @ `effort`", e.g. `craig-core:opus` @ `high`). The Claude route agents (`craig-core:opus`, `craig-core:sonnet`, `craig-core:haiku`, `craig-core:fable`) ship in the `craig-core` plugin; the `gpt-*` and `deepseek-*` route agents live in `~/.claude/agents/` on Craig's Mac only. When these routes count as available, and the Claude-only fallback when they do not, is the Route availability rule in CLAUDE.md.

| Route | Model name sent | Peer Claude route | Allowed efforts |
|---|---|---|---|
| `gpt-astra` | `astra` (GPT-6 Astra) | `craig-core:opus` @ `high`/`xhigh` | `medium`, `high`, `max` |
| `gpt-sol` | `sol` (GPT-6.1 Sol) | `craig-core:sonnet` @ `high` | `medium`, `high`, `xhigh` |
| `gpt-luna` | `luna` (GPT-6 Luna) | `craig-core:haiku` @ `low` | `low`, `medium` |
| `gpt-terra` | `terra` (GPT-6.1 Terra) | `craig-core:haiku` @ `low`/`xhigh`/`max` (at `low`/`medium`/`high`) | `low`, `medium`, `high`, `xhigh`, `max` |
| `deepseek-flash` | `deepseek-flash` (V4.1 Flash 1017) | `craig-core:haiku` (at `low`), `craig-core:sonnet` @ `medium` (at `medium`), `craig-core:sonnet` @ `high` (at `high`) | `low`, `medium`, `high` |
| `deepseek-v4-pro` | `deepseek-v4-pro` (V4 Pro 0813); no image input | `craig-core:sonnet` @ `medium` (at `low`), `craig-core:opus` @ `medium` (at `medium`), `craig-core:opus` @ `high` (at `high`) | `low`, `medium`, `high` |

### Effort mechanics

Measured on Claude Code 2.1.306, 2026-10-21, except where dated otherwise.

- **The Agent tool's `effort` parameter** (`low|medium|high|xhigh|max`) reaches the API as `output_config.effort`. Precedence: Agent `effort` > agent frontmatter `effort` > parent session effort. A forgotten parameter silently inherits the parent's effort, which is why CLAUDE.md requires it; a `craig-core` PreToolUse hook enforces it.
- **The Agent `model` parameter accepts only `sonnet|opus|haiku|fable`.** Any other string, including a GPT alias or a full Claude model ID, fails with `InputValidationError`. A non-Claude model therefore needs an agent file whose frontmatter `model:` names it, which is why the `gpt-*` and `deepseek-*` routes are agent files.
- **The Agent `model` alias `fable` resolves to `claude-fable-5-2`** (probe 2026-11-09).
- **`utraque` resolves effort as model-name suffix > body `output_config.effort` > default**, and logs `effort_source` (`suffix|body|default`) beside `effort_requested` and `effort_applied`. Use bare aliases (`sol`, `astra`, `luna`, `terra`) so the Agent parameter decides; a suffixed alias (`sol-high`) would override it.
- **The Codex leg clamps effort to the model's live catalog levels**, and sends it unclamped when the catalog is unavailable. `utraque` has no per-model effort override. Check `effort_applied` in the log line, not the request.
- **Terra's catalog lists `low` through `ultra`** (checked 2026-10-27), so `xhigh` and `max` pass the clamp. The proxy log of 2026-10-27 showed Terra running only at `medium` and `high`; `xhigh` and `max` are catalog-supported but not yet observed.
- **GPT-6 Astra `max` passes the clamp:** the proxy log of 2026-11-09 shows `effort_requested` max and `effort_applied` max.
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

Artificial Analysis Intelligence Index v5.0.1 @ cost per index task, as of 2026-11-09. `~` marks a chart reading; `—` is unpublished. AA's effort names are its own settings. Cost is metered only on the DeepSeek leg; on the subscription legs these are API-cost comparisons, and their equivalence to subscription quota is unverified.

| Model | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| Claude Fable 5.2 | 54 @ $3.10 | 56 @ $3.80 | 62 @ $9.08 | 62 @ $14.83 | 65 @ $26.54 |
| Claude Opus 5.5 | 35 @ $0.98 | 48 @ $2.45 | 52 @ $3.46 | 57 @ $6.05 | 59 @ $10.04 |
| Claude Sonnet 5.5 | 26 @ $0.51 | 31 @ $0.78 | 42 @ $1.64 | 50 @ $4.09 | 55 @ $10.02 |
| Claude Haiku 5.5 | 19 @ $0.04 | 25 @ $0.09 | 30 @ $0.16 | 35 @ $0.25 | 36 @ $0.41 |
| GPT-6.1 Sol | 35 @ $0.16 | 46 @ $0.36 | 50 @ $0.59 | 52 @ $0.76 | 55 @ $1.27 |
| GPT-6 Astra | 43 @ $1.42 | 52 @ $2.73 | 55 @ $3.24 | 55 @ $3.66 | 57 @ $6.24 |
| GPT-6.1 Terra | 29 @ $0.07 | 38 @ $0.17 | 42 @ $0.26 | 45 @ $0.40 | 51 @ $0.96 |
| GPT-6 Luna | 10 @ $0.01 | 18 @ $0.04 | 21 @ $0.07 | 23 @ $0.10 | 28 @ $0.15 |
| DeepSeek V4.1 Flash 1017 | — | — | — | — | 45 @ $0.26 |
| DeepSeek V4 Pro 0813 | — | — | — | — | ~36 @ ~$0.68 |

- **The DeepSeek rows are v4-era scores,** not rescored on v5.0.1 as of 2026-11-09, so they are not comparable with the rows above.
- **DeepSeek Flash is measured only at `max`,** which the route never runs (the DeepSeek leg sends `low` or `high`), so its capability at the route's efforts is unmeasured.
- **Haiku prices by per-request prompt length:** up to 100k tokens $0.10/$0.50 per 1M input/output; above 100k every category rises 5x. That drives the CLAUDE.md rule sending prompts expected to stay under 100k to `craig-core:haiku`.
- **Haiku's long-context recall is unmeasured**, so prompts above 100k stay on `craig-core:sonnet` @ `medium` until it is measured.
- **No `craig-core:sonnet` @ `xhigh` or @ `max`:** `craig-core:opus` @ `high` (52 @ $3.46) dominates Sonnet xhigh (50 @ $4.09); Sonnet max (55 @ $10.02) is dominated by `craig-core:opus` @ `xhigh` (57 @ $6.05).
- **No `craig-core:opus` @ `max`:** `craig-core:fable` @ `high` (62 @ $9.08) beats Opus max (59 @ $10.04) at lower cost.

### Claude Fable 5.2

Sources: [AA Fable 5.2](https://artificialanalysis.ai/models/releases/claude-fable-5-2), [Anthropic announcement](https://www.anthropic.com/claude-fable-and-mythos-5-2), checked 2026-11-09.

- **Price:** $8 in / $40 out per 1M tokens with a 98% cache discount (Opus 5.5: $4 / $20, 95%). Fast mode is $16 / $80 and up to 2.5x faster. 1M context; text and image in.
- **Output tokens on the index:** low 34.9M, medium 41M, high 85.3M, xhigh 144M, max 275M (Opus 5.5: medium 42.5M, high 56.1M, xhigh 101M, max 218M).
- **Time per index task:** low 6.5, medium 8.3, high 17.7, xhigh 26.3, max 44.1 minutes. Medium is the default effort in Claude apps and Claude Code.
- **Placement:** Fable @ `low` dominates Opus @ `high` (54 vs 52, $3.10 vs $3.46). Fable @ `medium` nearly ties Opus @ `xhigh` (56 vs 57) at about 63% of the cost. Fable @ `high` beats Opus @ `max` at lower cost. Fable @ `xhigh` is dominated by `high` (both 62, 1.6x the cost), so the route drops `xhigh`.
- **Anthropic's claims:** Fable @ `high` matches Opus 5.5's best FrontierCode score (45.3% vs 45.5%) "for roughly half the cost per task"; at `xhigh` it scores 49.1%, the highest of any released model they tested. Anthropic still recommends Opus 5.5 as the daily driver, with Fable for "the most ambitious, open-ended technical work".
- **Why Opus stays the heavy-work default:** Anthropic's recommendation, Fable's latency, and the subscription quota burn relative to Opus is unmeasured (all costs here are API prices).
- **Craig's experience:** Fable reasons more doggedly ("tenacity of thought"), a subjective judgment and the basis for the `low`/`medium` situational row.
- **Craig's experience:** Fable burns subscription quota fast, especially at `high` and above (it uses 85M–275M output tokens on the index at $40 per 1M output).

### GPT-6.1 Terra

Sources: [AA Terra](https://artificialanalysis.ai/models/releases/gpt-6-1-terra), [AA Sol](https://artificialanalysis.ai/models/releases/gpt-6-1-sol), [OpenAI announcement](https://openai.com/index/introducing-gpt-6-1-terra/).

- **Index (AA Intelligence Index v5.0.1):** max 51, xhigh 45, high 42, medium 38, low 29, non-reasoning 31. Non-reasoning is not reachable through the Agent `effort` parameter.
- **Price:** $1 in / $5 out per 1M tokens against Sol's $2 / $10, with a 95% cache discount on both.
- **Token use:** Terra max uses 99.4M output tokens on the index against Sol max's 63.7M; Terra xhigh uses 34.7M against Sol medium's 15.1M. Terra uses more tokens per task despite its faster token speed (about 91 against about 77 output tokens per second).
- **Long context:** no published recall (AA-LCR per-model subscores are not shown), so prefer Sol or a Claude route for prompts well over 100k tokens.
- **OpenAI's claims:** "a fast, efficient model" at an API price 50% below Sol that completes tasks more than 3x faster than Sol and Astra. Strongest at visual reasoning, computer use, and technical drawings to 3D; close to Sol and Astra on MMMU-Pro and Agents' Last Exam (on par with Astra there at medium); Terminal-Bench 4.0 50.3% at max. "For the most complex coding tasks, GPT-6.1 Sol and GPT-6 Astra remain the better choice."
- **Craig's experience:** Sol and Terra are notably good at 3D conceptual and geometry work; Terra is very smart for its cost.

### Terra, Sol, or Astra

- **Sol @ `medium` (46 @ $0.36) dominates Terra @ `xhigh` (45 @ $0.40),** and Sol @ `high` (50 @ $0.59) beats Terra @ `max` (51 @ $0.96) on cost per point, so Terra's `xhigh`/`max` are kept only for visual, 3D, and geometry work.
- **Astra @ `xhigh` (55 @ $3.66) adds nothing over Astra @ `high` (55 @ $3.24),** so the route uses `max` (57 @ $6.24, the top GPT score) for the hardest.
- **Sol @ `medium`/`high`** for normal and multi-file work; Sol @ `high` is the routine challenger.
- **Astra** for the hardest, consequential, and security work.
- **Observation, no rule change:** Sol @ `xhigh` (52 @ $0.76) ties Astra @ `medium` (52 @ $2.73) at about 28% of the cost; a candidate for the next refresh.

## Cross-family verification

The pairing tables with their Claude-only columns, the tiebreak, and the security override live in CLAUDE.md. In addition, when cross-family routes are available:

- If `gpt-sol` @ `high` fails as the challenger for `craig-core:sonnet` @ `high` or `craig-core:opus` @ `medium`, use `gpt-astra` @ `medium`, escalating to `gpt-astra` @ `high`.
- `craig-core:sonnet` @ `high` is also an acceptable routine challenger for `gpt-sol` @ `medium`.
- `deepseek-flash` is a fit challenger when metered-cheap is the right price for a second opinion.

### Security routing

Why CLAUDE.md sends security work — doing it and reviewing it — to `gpt-astra` and, Claude-only, to `craig-core:opus` @ `high` or @ `xhigh` but never `craig-core:fable` or `craig-core:haiku`: Anthropic re-routes most cybersecurity tasks on Opus and Fable to an older Opus, and higher-risk ones on Sonnet visibly fall back to an older Sonnet, so no Claude route is full-strength for security and a Claude route reviewing GPT's security work may be running the older model. Routine bug finding and fixing in normal development is unaffected. Fable 5.2 still blocks most cybersecurity tasks and answers them from Opus 4.8 (and biology from Opus 5), with about 55% fewer false-positive blocks than Fable 5.1, and it hands a small set of AI-R&D topics (such as kernel development on some nonstandard accelerators) to Opus 5 transparently. Haiku has no fallback: a cyber-classifier decline returns `stop_reason: "refusal"` and stays declined, so `craig-core:haiku` never runs security work. A Claude-only security check is reported as same-family and as possibly run on an older Opus.

Anthropic's and OpenAI's classifiers also over-refuse defensive work on Craig's own systems: sysadmin tasks such as CA certificate repair, and network scans for insecure devices, have drawn refusals from both families. DeepSeek filters less, so CLAUDE.md falls back to `deepseek-flash` @ `high` when both refuse. Flash rather than `deepseek-v4-pro`, because Flash 1017 is the stronger DeepSeek model (AA index 45 vs 36 at `max`). The leg is a metered third-party API: send only what the task needs, never private keys or credentials.

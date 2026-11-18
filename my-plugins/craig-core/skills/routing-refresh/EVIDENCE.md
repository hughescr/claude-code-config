# Routing evidence

The facts behind the routes and pairing tables in `COMMON-CLAUDE.md`. Read this only when routes are being changed; normal sessions do not load it. When a route, model, effort, or price changes, update this file together with both CLAUDE.md tables, the agent files, and the `ROUTES` list in `hooks/require-route-effort.sh`.

## Local gateway routes

The `gpt-*` routes reach OpenAI models over the `utraque` proxy on `127.0.0.1:8317`, billed to the Codex subscription. The `deepseek-*` routes reach DeepSeek's Anthropic-compatible endpoint over the same proxy and spend a prepaid DeepSeek API balance, so they are the only metered routes. There is one route agent per model, and every `Agent` call passes `effort` (written "`route` @ `effort`", e.g. `craig-core:opus` @ `high`). The Claude route agents (`craig-core:opus`, `craig-core:sonnet`, `craig-core:haiku`, `craig-core:fable`) ship in the `craig-core` plugin; the `gpt-*` and `deepseek-*` route agents live in `~/.claude/agents/` on Craig's Mac only. When these routes count as available, and the Claude-only fallback when they do not, is the Route availability rule in CLAUDE.md.

| Route | Model name sent | Peer Claude route | Allowed efforts |
|---|---|---|---|
| `gpt-astra` | `astra` (GPT-6.2 Astra) | `craig-core:opus` @ `xhigh` (at `medium`), `craig-core:fable` @ `high` (at `high`/`xhigh`) | `medium`, `high`, `xhigh` |
| `gpt-sol` | `sol` (GPT-6.2 Sol) | `craig-core:opus` @ `high` (at `medium`), `craig-core:opus` @ `xhigh` (at `high`/`xhigh`) by score; alternative to `craig-core:sonnet` @ `high` for leaf work | `medium`, `high`, `xhigh` |
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
- **GPT-6.2 Astra and Sol pass the `xhigh` clamp:** probes of 2026-11-17 show `effort_requested` xhigh and `effort_applied` xhigh on both, and the Codex catalog lists `low` through `ultra` for both.
- **The DeepSeek leg maps** `low`→`low`, `medium`→`high`, `high`→`high`, `xhigh`→`high`, `max`→`max`, because DeepSeek accepts only `low`, `high`, and `max` ([thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)). So `medium` and `high` run identically there, and `xhigh` buys nothing. DeepSeek model names take no suffix.
- **`utraque` translates Claude Code's mid-conversation `tool_addition` and `tool_removal` blocks** for both the GPT and DeepSeek legs: it hoists added tools into the tools list and honors removals.

### Facts that constrain these routes

- **Context windows.** The live Codex catalog (`codex debug models`, checked 2026-11-17) gives every listed GPT model a `max_context_window` of 872,000 tokens. Its `context_window` (500,000 for GPT-6.2 Sol, GPT-6.1 Sol, and GPT-6.1 Terra; 272,000 for GPT-6.2 Astra, GPT-6 Luna, and the rest) is only the Codex CLI's default compaction point, not a backend limit: on 2026-11-17 the subscription backend accepted 450k- and 800k-token prompts on `gpt-6-luna`. Sol and Astra above their defaults are untested. Claude Code compacts GPT routes at `CLAUDE_CODE_MAX_CONTEXT_TOKENS=828000` (872,000 less the 5% margin Codex keeps), set in `~/.claude/claude-smart.sh`. OpenAI's API pages list 1,050,000 for all of them. DeepSeek windows are unverified.
- **Long prompts cost more.** On the API, a request with more than 272K input tokens is priced at 2x input and cache rates and 1.5x output for the whole request (model pages for GPT-6.2 Astra, GPT-6 Astra, and GPT-6.1 Terra, 2026-11-17). OpenAI does not document how this maps to subscription allowance; assume it drains faster above 272k, and keep Astra prompts under that unless the task needs more.
- **Luna on long context.** GPT-6 Luna returned 8/8 exact lookups among 48 near-identical records at 100k, 250k, 450k, and 800k tokens (10 trials through `utraque`, 2026-11-17), matching GPT-6.2 Sol at 250k. The test was too easy to rank models, so reasoning across long inputs is unmeasured. The older poor-recall figure (41.3% on OpenAI's MRCR v2 at 512K–1M) was GPT-5.6 Luna.
- **Route agent files carry the bare model name and no `effort` key.** The Agent `effort` parameter is the only effort setting; confirm what a request ran with from the proxy's per-request log line (`client_model`, `upstream_model`, `effort_source`, `effort_requested`, `effort_applied`).
- **On the DeepSeek leg the model name must be exact** (`deepseek-flash`, `deepseek-v4-pro`; a suffix is rejected).
- **No `ultra` route.** The Agent `effort` enum stops at `max`. Reaching `ultra`, if ever, needs a dedicated agent file whose `model:` is the suffixed name `sol-ultra` (unverified for GPT-6.2 Sol).
- **Bare aliases float to the newest model with that codename:** `astra` → `gpt-6.2-astra` and `sol` → `gpt-6.2-sol` (proxy log 2026-11-17); pinned names such as `astra-6` and `sol-6.1` still route to the older models. The backend withholds new models from older Codex CLI clients, so check `/v1/models` before assuming which model a route runs.
- Do not route to `gpt-5.3-codex-spark` or `codex-auto-review`.

### Proxy availability

These routes work only when `ANTHROPIC_BASE_URL` is `http://127.0.0.1:8317`. The `claude` alias (`claude-smart.sh`) sets it at launch when the proxy answers healthy, so check the environment variable, not `settings.json`. Without it the model name reaches `api.anthropic.com` and is rejected. See `~/.claude/UTRAQUE-SETTINGS-DELTA.md`.

For availability prefer the proxy's own state: `GET /healthz` reports Codex auth, catalog state and model count, transport, and quota, and `GET /v1/models` lists what is routable now (DeepSeek rows only when a DeepSeek key is configured). When the proxy is down every `gpt-*` and `deepseek-*` route fails immediately; Claude routes are unaffected only in sessions launched without the proxy. In a session already routed through it, all requests fail while the proxy is down. The GPT leg uses the Codex subscription credential, so fix a stale one with `codex login`, not by rerouting. The DeepSeek leg answers `503` when no prepaid key is configured.

### Tool schemas

`utraque` sends `"strict": false` on every Responses function tool (since utraque 1.1.1+25507e7). Without it the API treats tools as strict and forces GPT models to fill every optional field, so GPT route agents passed `model` and `isolation` on Agent calls and the craig-core hook denied them. If GPT agents start passing optional Agent fields again, check this first. On 2026-11-17, forced tool calls with one required and two optional fields left the optional fields out in 3 of 3 runs on both GPT-6.2 Astra and GPT-6.2 Sol.

## Intelligence-cost snapshot

Artificial Analysis Intelligence Index v5.0.1 @ cost per index task, as of 2026-11-17 for the GPT-6.2 rows and 2026-11-09 for the rest (Claude rows and Terra `max` re-confirmed 2026-11-17). `~` marks a chart reading; `—` is unpublished. AA's effort names are its own settings. Cost is metered only on the DeepSeek leg; on the subscription legs these are API-cost comparisons, and their equivalence to subscription quota is unverified.

| Model | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| Claude Fable 5.2 | 54 @ $3.10 | 56 @ $3.80 | 62 @ $9.08 | 62 @ $14.83 | 65 @ $26.54 |
| Claude Opus 5.5 | 35 @ $0.98 | 48 @ $2.45 | 52 @ $3.46 | 57 @ $6.05 | 59 @ $10.04 |
| Claude Sonnet 5.5 | 26 @ $0.51 | 31 @ $0.78 | 42 @ $1.64 | 50 @ $4.09 | 55 @ $10.02 |
| Claude Haiku 5.5 | 19 @ $0.04 | 25 @ $0.09 | 30 @ $0.16 | 35 @ $0.25 | 36 @ $0.41 |
| GPT-6.2 Sol | 41 @ $0.18 | 53 @ $0.41 | 55 @ $0.56 | 56 @ $0.65 | 57 @ $1.01 |
| GPT-6.2 Astra | 46 @ $0.66 | 57 @ $1.62 | 60 @ $2.07 | 62 @ $2.52 | 62 @ $4.00 |
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

### GPT-6.2 Astra and Sol

Sources: [AA Astra](https://artificialanalysis.ai/models/gpt-6-2-astra), [AA Sol](https://artificialanalysis.ai/models/gpt-6-2-sol), checked 2026-11-17. The [OpenAI announcement](https://openai.com/index/introducing-gpt-6-2-astra-sol/) was read in a browser on 2026-11-17. Both released 2026-11-17.

- **Index (AA Intelligence Index v5.0.1):** Astra low 46, medium 57, high 60, xhigh 62 (61.6 unrounded), max 62 (62.1 unrounded). Sol low 41, medium 53, high 55, xhigh 56, max 57.
- **Price:** Astra $8 in / $40 out per 1M tokens; Sol $2 / $10; 95% cache discount on both. Text and image in; AA lists 1M context for both (the Codex catalog windows are under Facts that constrain these routes).
- **Output tokens on the index:** Astra low 6.31M, medium 12.4M, high 20M, xhigh 27.1M, max 65.8M; Sol low 7.21M, medium 14.6M, high 22.7M, xhigh 33.3M, max 60.9M.
- **Time per index task:** Astra 1.4 / 3.7 / 4.8 / 5.9 / 10.4 minutes at low / medium / high / xhigh / max; Sol 1.4 / 3.1 / 4.3 / 5.1 / 7.9.
- **Placement:** Astra @ `medium` ties Opus @ `xhigh` (57) at 27% of the API cost. Astra @ `high` (60) passes Opus @ `max` (59). Astra @ `xhigh` ties Fable @ `high` (62) at 28% of the API cost. Sol @ `medium` (53) edges Opus @ `high` (52) at 12% of the API cost. Sol @ `max` ties Opus @ `xhigh` (57).
- **Placement in the routes:** API cost does not predict subscription quota use, so these scores did not change Claude effort assignments; see Subscription quota for the resulting defaults.
- **Price:** cached input is $0.40 per 1M for Astra and $0.10 for Sol; Astra's token prices are 20% below GPT-6 Astra's; Sol keeps GPT-6.1 Sol's.
- **OpenAI's claims:** both models "deliver better results on demanding tasks with fewer output tokens"; FrontierCode 2.0: Sol "comes within 0.5 points of GPT‑6.2 Astra at about one-fifth the cost (both at max)"; Agents' Last Exam: Astra scores 5.2 points above GPT-6 Astra "at less than a third of the cost" and 5.5 points above Claude Fable 5.2 "at just 5% of the cost" (efforts not stated; the Fable result excludes nine tasks that used a fallback model); GDPval v2: Astra up 6.2 points on GPT-6 Astra with 22% fewer output tokens, Sol up 5.3 on GPT-6.1 Sol; AA-3D Elo: Astra 1,318, Claude Fable 5.2 1,271, Sol 1,259.
- **Availability:** Plus, Pro, Enterprise, and Edu plans in ChatGPT Work and Codex from 2026-11-17.
- **Blocker reporting:** OpenAI reports that in two tests both models "were more likely to omit mentioning obstacles that blocked their work, such as a missing file or unavailable search tool", and that it added Codex instructions that reduce this. Those instructions are not in our harness, so `SUBAGENT-CLAUDE.md` tells every sub-agent to state each blocker and what it left undone; its effect on GPT routes is unmeasured, so still check their reports for unstated blockers.

### GPT-6.1 Terra

Sources: [AA Terra](https://artificialanalysis.ai/models/releases/gpt-6-1-terra), [AA Sol](https://artificialanalysis.ai/models/gpt-6-2-sol), [OpenAI announcement](https://openai.com/index/introducing-gpt-6-1-terra/).

- **Index (AA Intelligence Index v5.0.1):** max 51, xhigh 45, high 42, medium 38, low 29, non-reasoning 31. Non-reasoning is not reachable through the Agent `effort` parameter.
- **Price:** $1 in / $5 out per 1M tokens against Sol's $2 / $10, with a 95% cache discount on both.
- **Token use:** Terra max uses 99.4M output tokens on the index against Sol max's 60.9M; Terra xhigh uses 34.7M against Sol medium's 14.6M. Terra uses more tokens per task despite its faster token speed (about 91 output tokens per second against GPT-6.2 Sol's 71 to 85 from low to max, Artificial Analysis 2026-11-17).
- **Long context:** no published MRCR score for GPT-6.1 Terra; OpenRouter lists AA-LCR 82.3% at high (third-party, 2026-11-17), and GPT-5.6 Terra scored 72.5% on MRCR v2 at 512K–1M against GPT-5.6 Sol's 73.8%. No length restriction on the route.
- **OpenAI's claims at Terra's launch, against GPT-6.1 Sol and GPT-6 Astra, the models then current:** "a fast, efficient model" at an API price 50% below Sol that completes tasks more than 3x faster than Sol and Astra. Strongest at visual reasoning, computer use, and technical drawings to 3D; close to Sol and Astra on MMMU-Pro and Agents' Last Exam (on par with Astra there at medium); Terminal-Bench 4.0 50.3% at max. "For the most complex coding tasks, GPT-6.1 Sol and GPT-6 Astra remain the better choice."
- **Craig's experience:** Sol and Terra are notably good at 3D conceptual and geometry work; Terra is very smart for its cost.

### Terra, Sol, or Astra

- **Sol @ `medium` (53 @ $0.41) outscores Terra @ `xhigh` (45 @ $0.40) at about the same cost and Terra @ `max` (51 @ $0.96) at under half the cost,** so Terra's `xhigh`/`max` are kept only for visual, 3D, and geometry work.
- **Astra @ `xhigh` and `max` have the same rounded score (62; 61.6 against 62.1 unrounded), and `xhigh` ($2.52) costs 63% of `max` ($4.00),** so the route tops out at `xhigh` and drops `max`.
- **Sol @ `medium`/`high`** is the alternative leaf route (normal and multi-file work); at `high` it challenges `craig-core:sonnet` @ `high` and `craig-core:opus` work (the CLAUDE.md pairing table is authoritative).
- **Astra** for Fable work, design calls, security design and review, escalation, and the hardest work.
- **Observation, no rule change:** Sol @ `max` (57 @ $1.01) ties Astra @ `medium` (57 @ $1.62) at 62% of the cost but takes 7.9 against 3.7 minutes per task.
- **Observation, no rule change:** Sol @ `low` (41 @ $0.18) trails Terra @ `high` (42 @ $0.26) and Sonnet @ `high` (42 @ $1.64) by one point at lower cost; a candidate `gpt-sol` @ `low` row for the next refresh.

### Subscription quota

Craig's observation (2026-11-17): the Codex subscription runs out much faster than the Claude one. API cost per task does not predict subscription quota use, and the conversion is unmeasured. The benchmarks did not change any Claude effort assignment; the quota observation changed the defaults: for execution the Claude route wins when both fit, `gpt-sol` is an alternative for leaf work, and `craig-core:opus` @ `high`/`xhigh` work is challenged by `gpt-sol` @ `high` (55 @ $0.56) with `gpt-astra` @ `high` (60 @ $2.07) as escalation; `gpt-astra` stays for Fable work, design calls, security design and review, and escalation.

## Cross-family verification

The pairing tables with their Claude-only columns, the tiebreak, and the security override live in CLAUDE.md. In addition, when cross-family routes are available:

- `craig-core:sonnet` @ `high` is also an acceptable routine challenger for `gpt-sol` @ `medium`.
- `deepseek-flash` is a fit challenger when metered-cheap is the right price for a second opinion.

### Security routing and refusals

Why CLAUDE.md routes security by refusal risk, not topic: security design and review go to the route least likely to refuse (Claude-only: `craig-core:opus` @ `high` or @ `xhigh`, never `craig-core:fable` or `craig-core:haiku`), and writing code with a security purpose is ordinary execution routed by the routing table. Anthropic re-routes most cybersecurity tasks on Opus and Fable to an older Opus, and higher-risk ones on Sonnet visibly fall back to an older Sonnet, so no Claude route is full-strength for security and a Claude route reviewing GPT's security work may be running the older model. Routine bug finding and fixing in normal development is unaffected, which is why code with a security purpose stays ordinary execution. Fable 5.2 still blocks most cybersecurity tasks and answers them from Opus 4.8 (and biology from Opus 5), with about 55% fewer false-positive blocks than Fable 5.1, and it hands a small set of AI-R&D topics (such as kernel development on some nonstandard accelerators) to Opus 5 transparently. Haiku has no fallback: a cyber-classifier decline returns `stop_reason: "refusal"` and stays declined, so `craig-core:haiku` never runs security design, review, or classifier-prone work, and a Haiku refusal on ordinary security-flavoured code moves that task to another route under the after-a-refusal rule. A Claude-only security check is reported as same-family and as possibly run on an older Opus. On 2026-11-18 an orchestrator read the security-routing line as covering every edit in a security task and sent about ten routine code-writing tasks to `gpt-astra` @ `high`, spending Codex quota on leaf work that was not refusal-prone.

Anthropic's and OpenAI's classifiers also over-refuse defensive work on Craig's own systems: sysadmin tasks such as CA certificate repair, and network scans for insecure devices, have drawn refusals from both families. GPT-6.2 Astra and Sol launched (2026-11-17) with tighter cybersecurity safeguards that OpenAI says "also restrict some legitimate vulnerability research and security testing workflows", plus increased restrictions on dual-use biological requests; OpenAI's reduced-refusal access (its Daybreak program) covers only GPT-6 Astra and is not part of the subscription. DeepSeek filters least; Craig expects it to refuse far less. Hence the CLAUDE.md rule: route by refusal risk, not topic; code with a security purpose follows the routing table; security design and security review go to `gpt-astra`; work that classifiers often block goes straight to `deepseek-flash` @ `high`; after a refusal, move that task to another family, DeepSeek last; the refusing family stays in use for other work. Flash rather than `deepseek-v4-pro`, because Flash 1017 is the stronger DeepSeek model (AA index 45 vs 36, both `max`-effort scores, which the route never runs). The leg is a metered third-party API: send only what the task needs, never private keys or credentials.

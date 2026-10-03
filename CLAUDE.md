## Quality & Risk

Before calling significant work done: tests pass, lint clean, docs updated, and the change weighed for security, performance, data integrity, and deployment/rollback risk.

---

## Language Choice

Python is a last resort, not the easy default — Craig has been bitten repeatedly by Python-shaped instincts (scalar loops, unbatched hot paths) leaking into every language. Design data flow batch-first — a per-item call in a hot path is a defect. Prefer ecosystems whose norms pull toward quality: Rust for performance-critical or parallel work; TypeScript on bun (Craig's usual) or Go for services and tooling. If Python is unavoidable, write it like a systems language and surface it as debt to retire.

---

## Installed CLI Tools (beyond defaults)

jq, httpie, gh, bat, diff-so-fancy, hyperfine, tree, watch, ag, parallel, awscli, csvkit (csvcut/csvjoin/csvstat), imagemagick, optipng, webp, ffmpeg

---

## Agent routing

Every `Agent` call must set `subagent_type` to a named custom agent whose frontmatter explicitly sets both `model` and `effort`; never omit either or inherit session defaults. Runtime `name` is only for addressability. Use one of these general routes, or a capability-specific personal agent that also pins both fields:

| Route | Use |
|---|---|
| `haiku-basic` | Summaries and basic mechanical work. Haiku 4.5 has no `effort` setting, so the route's `effort: low` pin satisfies the rule above but does not change behavior. Verify consequential output with a stronger route. |
| `sonnet-medium` | Bounded work with objective checks. |
| `sonnet-high` | Normal substantive execution; co-default leaf route with `gpt-sol-medium`/`gpt-sol-high`. Routine verifier for sol work. |
| `opus-medium` | Routine verification or challenge. |
| `opus-high` | Heavy work, consequential verification or challenge, and complex debugging. |
| `opus-xhigh` | Escalation above `opus-high`, and the hardest Claude-side work. |
| `fable-high`, `fable-xhigh` | A second Claude view on hard judgment calls. Not an escalation step: when `opus-high` stalls, use `opus-xhigh`. |
| `gpt-luna-low`, `gpt-luna-medium` | Cross-family cost-and-role peers of the Haiku and `sonnet-medium` rows; capability is below `sonnet-medium`. Short inputs only. |
| `gpt-sol-medium` | Normal substantive leaf work, co-default with `sonnet-high` (GPT-6.1 Sol, AA-measured: level with `sonnet-high`, ~3 below `opus-medium`). Also routine verification, and challenger for `sonnet-medium`. |
| `gpt-sol-high`, `gpt-sol-xhigh` | Multi-file leaf work, co-default with `sonnet-high`; the fallback when astra is unavailable. `sol-high` is the go-to routine cross-family challenger for `sonnet-high` and `opus-medium` (AA-measured: above `astra-medium` at about a fifth of the quota, ~1 below `opus-medium`). `sol-xhigh` is only +1 over `sol-high` for ~22% more cost, so prefer `sol-high`. ~4 below `opus-high` on the index. |
| `gpt-astra-medium`, `gpt-astra-high`, `gpt-astra-xhigh` | Consequential cross-family challenge (`opus-high` and above, design calls, security) and complex debugging; peers `opus-high` and `fable-*`. For routine checks sol is the go-to; pull in astra when a problem is among the hardest, needs tenacity, or sol stalled on it. |
| `deepseek-flash-low`, `deepseek-flash-medium`, `deepseek-flash-high` | The default DeepSeek route: third-family cost peers of the Haiku, `sonnet-medium`, and `sonnet-high` rows; capability is below `sonnet-medium`. |
| `deepseek-v4-pro-low`, `deepseek-v4-pro-medium`, `deepseek-v4-pro-high` | Third-family peers of `sonnet-medium`, `opus-medium`, and `opus-high`; only for a need the intelligence index does not measure. |

**The `gpt-*` and `deepseek-*` routes work only when `ANTHROPIC_BASE_URL` points at the local `utraque` proxy; check that environment variable, not `settings.json`.** When verification is warranted, use one independent verifier selected by the cross-family pairing table. Everything else about these routes — billing, effort mechanics, context limits, the cross-family pairing and escalation table, and the intelligence-cost evidence behind the peerings — lives in the `model-selection` skill, which is the single source of truth. Update it, not this table, when a model changes.

Fan out independent necessary work; do not duplicate work merely to create parallelism.

Verification is a second opinion, not a standing panel: most work needs none, complex work needs exactly one verifier, plus a second only when one agent cannot cover the change well (a change that is both a security change and a migration, say). Review does not recurse.

---

Destructive git commands are blocked by a PreToolUse hook: `git checkout -- <path>`, `git restore` (except the pure `--staged` unstage form), `git reset --hard`, and `git clean` with a force flag (dry runs allowed); undo your own edits by editing.

## Quality & Risk

Before calling significant work done: tests pass, lint clean, docs updated, and the change weighed for security, performance, data integrity, and deployment/rollback risk.

When you update docs, skills, or config, replace superseded facts, estimates, and passed dates instead of keeping them "as history" or adding "superseded by" notes — git already has the history.

---

## Language Choice

Python is a last resort, not the easy default, and its instincts (scalar loops, unbatched hot paths) must not leak into any language. Design data flow batch-first — a per-item call in a hot path is a defect. Prefer ecosystems whose norms pull toward quality: Rust for performance-critical or parallel work; TypeScript on bun (Craig's usual) or Go for services and tooling. If Python is unavoidable, write it like a systems language and surface it as debt to retire.

---

## Installed CLI Tools (beyond defaults)

jq, httpie, gh, bat, diff-so-fancy, hyperfine, tree, watch, ag, parallel, awscli, csvkit (csvcut/csvjoin/csvstat), imagemagick, optipng, webp, ffmpeg

---

## Agent routing

Every `Agent` call must set `subagent_type` to a named custom agent whose frontmatter explicitly sets both `model` and `effort`; never omit either or inherit session defaults. Runtime `name` is only for addressability. Use one of these general routes, or a capability-specific personal agent that also pins both fields:

| Route | Use |
|---|---|
| `haiku-xhigh` | Default for small tasks (prompts expected to stay under 100k tokens): bounded work with objective checks, extraction, classification, sub-agent leaf work. |
| `haiku-low` | Latency-sensitive mechanical work and summaries on small prompts. Verify consequential output with a stronger route. |
| `haiku-max` | A small task that needs a bit more than `haiku-xhigh`. |
| `sonnet-medium` | Bounded work with objective checks on prompts above 100k tokens. |
| `sonnet-high` | Normal substantive execution; co-default leaf route with `gpt-sol-medium`/`gpt-sol-high`. Routine verifier for sol work. |
| `opus-medium` | Routine verification or challenge. |
| `opus-high` | Heavy work, consequential verification or challenge, and complex debugging. |
| `opus-xhigh` | Escalation above `opus-high`, and the hardest Claude-side work. |
| `fable-high`, `fable-xhigh` | A second Claude view on hard judgment calls. Not an escalation step: when `opus-high` stalls, use `opus-xhigh`. |
| `gpt-luna-low`, `gpt-luna-medium` | Cross-family cost peers of the Haiku routes; capability is below `haiku-xhigh`. Short inputs only. |
| `gpt-sol-medium` | Normal substantive leaf work, co-default with `sonnet-high`. Also routine verification. |
| `gpt-sol-high`, `gpt-sol-xhigh` | Multi-file leaf work, co-default with `sonnet-high`; the fallback when astra is unavailable. `gpt-sol-high` is the routine cross-family challenger (pairing table below). Prefer `sol-high` over `sol-xhigh`. |
| `gpt-astra-medium`, `gpt-astra-high`, `gpt-astra-xhigh` | Consequential cross-family challenge (`opus-high` and above, design calls, security) and complex debugging; peers `opus-high` and `fable-*`. For routine checks sol is the go-to; pull in astra when a problem is among the hardest, needs tenacity, or sol stalled on it. |
| `deepseek-flash-low`, `deepseek-flash-medium`, `deepseek-flash-high` | The default DeepSeek route: third-family cost peers of the Haiku, `sonnet-medium`, and `sonnet-high` rows; capability is below `haiku-xhigh`. |
| `deepseek-v4-pro-low`, `deepseek-v4-pro-medium`, `deepseek-v4-pro-high` | Third-family peers of `sonnet-medium`, `opus-medium`, and `opus-high`; only for a need the intelligence index does not measure. |

The haiku/sonnet-medium split is by per-request prompt length: count the files the agent will read, not only the spawn prompt.

**The `gpt-*` and `deepseek-*` routes work only when `ANTHROPIC_BASE_URL` points at the local `utraque` proxy; check that environment variable, not `settings.json`.** The `model-selection` skill holds the facts behind these routes (billing, effort mechanics, context limits, benchmark evidence). When a route or model changes, update both tables here and the skill.

Fan out independent necessary work; do not duplicate work merely to create parallelism.

Verification is a second opinion, not a standing panel. Most work needs none. Add exactly one verifier for a consequential design decision, a change spanning several subsystems, or anything touching security, data integrity, concurrency, or a migration; add a second only when one agent cannot cover the change well (a change that is both a security change and a migration, say). A one-file fix, docs edit, test tweak, or mechanical rename does not qualify. Review does not recurse.

### Cross-family pairing

Claude work is challenged by a GPT route and GPT work by a Claude route; no model reviews its own output. Size the challenger to the cost of being wrong, not to the proposer's rank.

| Proposer | Challenger | Escalate to |
|---|---|---|
| `opus-high`, `opus-xhigh`, `fable-*` | `gpt-astra-high` | `gpt-astra-xhigh` |
| `opus-medium` | `gpt-sol-high` | `gpt-astra-medium` |
| `sonnet-high` | `gpt-sol-high` | `gpt-astra-high` |
| `sonnet-medium` | `gpt-sol-medium` | `gpt-sol-high` |
| `haiku-low` | `gpt-luna-medium` | `gpt-sol-medium` |
| `haiku-xhigh`, `haiku-max` | `gpt-sol-medium` | `gpt-sol-high` |
| `gpt-astra-*` | `opus-high` | `opus-xhigh` |
| `gpt-sol-high`, `gpt-sol-xhigh` | `opus-high` | `opus-xhigh` |
| `gpt-sol-medium` | `opus-medium` | `opus-high` |
| `gpt-luna-*` | `haiku-xhigh` | `sonnet-high` |
| `deepseek-v4-pro-high`, `deepseek-flash-high` | `opus-high` | `gpt-sol-high` |
| `deepseek-*-medium` | `sonnet-high` | `opus-medium` |
| `deepseek-*-low` | `haiku-xhigh` | `sonnet-high` |

Security work (doing it or reviewing it) overrides these pairings: use `gpt-astra-*`, and load the model-selection skill's Security routing section for the fallback.

A cross-family disagreement is a finding to resolve, not a tie to split: escalate one rung and report both positions. If that rung is the same family as the proposer or challenger, break the tie on the third family instead (`deepseek-flash-high` for Sonnet-tier work, `deepseek-v4-pro-high` for Opus-tier) and report all three positions.

With the proxy down or unconfigured there is no cross-family route: use `opus-medium` for routine checks and `opus-high` otherwise, escalate to `opus-xhigh` if `opus-high` stalls, and report the check as same-family.

---

Destructive git commands are blocked by a PreToolUse hook: `git checkout -- <path>`, `git restore` (except the pure `--staged` unstage form), `git reset --hard`, and `git clean` with a force flag (dry runs allowed); undo your own edits by editing.

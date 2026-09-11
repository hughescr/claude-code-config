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
| `haiku-summary`, `haiku-basic` | Summaries and basic mechanical work; `effort: low` is declarative metadata currently ignored by Haiku. Verify consequential output with a stronger route. |
| `sonnet-medium` | Bounded work with objective checks. |
| `sonnet-high` | Normal substantive execution; default leaf route. |
| `opus-medium` | Routine verification or challenge. |
| `opus-high` | Heavy work, consequential verification or challenge, and complex debugging. |
| `fable-high`, `fable-xhigh` | Only after Opus stalls, or for exceptional doggedness or judgment. |
| `gpt-luna-low`, `gpt-luna-medium` | Cross-family peers of the Haiku and `sonnet-medium` rows. Short inputs only. |
| `gpt-terra-medium`, `gpt-terra-high` | Cross-family peer of `sonnet-high`; the default GPT leaf route. |
| `gpt-sol-medium` | Cross-family peer of `opus-medium`: routine verification or challenge. |
| `gpt-sol-high`, `gpt-sol-xhigh` | Cross-family peer of `opus-high`; the fallback when astra is unavailable. |
| `gpt-astra-medium`, `gpt-astra-high`, `gpt-astra-xhigh` | First choice for consequential cross-family challenge and complex debugging; peers `opus-high` and `fable-*`. |
| `deepseek-flash-low`, `deepseek-flash-medium`, `deepseek-flash-high` | The default DeepSeek route: third-family peers of the Haiku, `sonnet-medium`, and `sonnet-high` rows. |
| `deepseek-v4-pro-low`, `deepseek-v4-pro-medium`, `deepseek-v4-pro-high` | Third-family peers of `sonnet-medium`, `opus-medium`, and `opus-high`; only for a need the intelligence index does not measure. |

**The `gpt-*` and `deepseek-*` routes work only when `ANTHROPIC_BASE_URL` points at the local `utraque` proxy; check that environment variable, not `settings.json`.** Never make one of them the only reviewer. Everything else about these routes — billing, effort mechanics, context limits, the cross-family pairing and escalation table, and the intelligence-cost evidence behind the peerings — lives in the `model-selection` skill, which is the single source of truth. Update it, not this table, when a model changes.

Fan out independent necessary work; do not duplicate work merely to create parallelism.

Verification is a second opinion, not a standing panel: most work needs none, complex work needs exactly one verifier. Review does not recurse.

---

Destructive git commands are blocked by a PreToolUse hook: `git checkout -- <path>`, `git restore` (except the pure `--staged` unstage form), `git reset --hard`, and `git clean` with a force flag (dry runs allowed); undo your own edits by editing.

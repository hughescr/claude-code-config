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
| `gpt-luna-low`, `gpt-luna-medium` | Cross-family peers of the Haiku and `sonnet-medium` rows. Short inputs only — long-context recall is weak. Against Haiku this is a cost peer, not a capability peer. |
| `gpt-terra-medium`, `gpt-terra-high` | Cross-family peer of `sonnet-high`; the default GPT leaf route. |
| `gpt-sol-medium` | Cross-family peer of `opus-medium`: routine verification or challenge. |
| `gpt-sol-high`, `gpt-sol-xhigh` | Cross-family peer of `opus-high`: consequential challenge and complex debugging. |
| `gpt-spark-high` | Fast, bounded edit-test-lint loops; 128k context; never planning or review. |

**The `gpt-*` routes are unavailable unless `ANTHROPIC_BASE_URL` points at the local `utraque` proxy on `127.0.0.1:8317`; that key is not set by default.** `claude-smart.sh` (the `claude` shell alias) sets it automatically at launch when the utraque proxy answers healthy on `127.0.0.1:8317` — so from inside a session, check the `ANTHROPIC_BASE_URL` environment variable itself, not `settings.json`. With it unset, a `gpt-*` spawn sends an unknown model name to `api.anthropic.com` and fails. See `UTRAQUE-SETTINGS-DELTA.md`, which documents the `settings.json` alternative.

When they are available, the `gpt-*` routes reach OpenAI models through that proxy and bill the Codex subscription; their context window is 272k tokens (128k for `gpt-spark-high`). Pair one with a Claude proposer for cross-family challenge; never make a `gpt-*` route the only reviewer. If the proxy is configured but not running they fail immediately, and the Claude routes are unaffected.

Fan out independent necessary work; do not duplicate work merely to create parallelism.

Verification is a second opinion, not a standing panel: most work needs none, complex work needs exactly one verifier. Review does not recurse.

---

Destructive git commands are blocked by a PreToolUse hook: `git checkout -- <path>`, `git restore` (except the pure `--staged` unstage form), `git reset --hard`, and `git clean` with a force flag (dry runs allowed); undo your own edits by editing.

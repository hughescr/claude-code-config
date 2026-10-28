## Quality & Risk

Before calling significant work done: tests pass, lint clean, docs updated, and the change weighed for security, performance, data integrity, and deployment/rollback risk.

When updating docs, skills, or config, replace superseded facts, estimates, and passed dates instead of keeping them "as history" or adding "superseded by" notes — git has the history.

## Language Choice

Python is a last resort, and its instincts (scalar loops, unbatched hot paths) must not leak into any language. Design data flow batch-first — a per-item call in a hot path is a defect. Prefer ecosystems whose norms pull toward quality: Rust for performance-critical or parallel work; TypeScript on bun (Craig's usual) or Go for services and tooling. If Python is unavoidable, write it like a systems language and surface it as debt to retire.

## Installed CLI Tools (beyond defaults)

jq, httpie, gh, bat, diff-so-fancy, hyperfine, tree, watch, ag, parallel, awscli, csvkit (csvcut/csvjoin/csvstat), imagemagick, optipng, webp, ffmpeg

## Agent routing

Every `Agent` call sets `subagent_type` to a named route agent and passes `effort` from the table below: `route` @ `effort` means `subagent_type: "route", effort: "effort"`. Never pass `model` to a route agent; its file pins the model and no effort. Omitting `effort` inherits the parent's, which is never acceptable; a craig-core PreToolUse hook denies both mistakes. Use only the efforts a route's rows list. A capability-specific agent (such as `craig-core:project-steward`) pins `model` and `effort` in its frontmatter; call it without `effort` unless you deliberately override it. Runtime `name` is only for addressability.

**Route availability.** Claude route `subagent_type`s always use the `craig-core:` prefix. The cross-family routes (`gpt-*`, `deepseek-*`) are local agents on Craig's Mac that reach their models through the `utraque` proxy. Use one only when its agent type is in this session's available agents and `ANTHROPIC_BASE_URL` is `http://127.0.0.1:8317` (check that environment variable, not `settings.json`). Otherwise (always in Cowork, cloud sessions, and claude.ai chat) use only `craig-core:*` routes and the Claude-only pairing columns, and report every check as same-family. The start hooks state which case applies.

| Route @ effort | Use |
|---|---|
| `craig-core:haiku` @ `xhigh` | Default for small tasks (prompts expected to stay under 100k tokens): bounded work with objective checks, extraction, classification, sub-agent leaf work. |
| `craig-core:haiku` @ `low` | Latency-sensitive mechanical work and summaries on small prompts. Verify consequential output with a stronger route. |
| `craig-core:haiku` @ `max` | A small task that needs a bit more than `xhigh`. |
| `craig-core:sonnet` @ `medium` | Bounded work with objective checks on prompts above 100k tokens. |
| `craig-core:sonnet` @ `high` | Normal substantive execution: the default leaf route, co-default with `gpt-sol` @ `medium`/`high` where available. Routine verifier for sol work. Never above `high`. |
| `craig-core:opus` @ `medium` | Routine verification or challenge. |
| `craig-core:opus` @ `high` | Heavy work, consequential verification or challenge, and complex debugging. |
| `craig-core:opus` @ `xhigh` | Escalation above `high`, and the hardest Claude-side work. Never `max`. |
| `craig-core:fable` @ `high`/`xhigh` | A second Claude view on hard judgment calls. Not an escalation step: if `craig-core:opus` @ `high` stalls, use `craig-core:opus` @ `xhigh`. |
| `gpt-luna` @ `low`/`medium` | Cross-family cost peers of the Haiku routes; capability is below `craig-core:haiku` @ `xhigh`. Short inputs only. Never above `medium`. |
| `gpt-terra` @ `low` | Cross-family peer of `craig-core:haiku` @ `low`; stronger, at about twice the cost. Verify consequential output with a stronger route. |
| `gpt-terra` @ `medium`/`high` | Cross-family peers of `craig-core:haiku` @ `xhigh` (at `medium`) and @ `max` (at `high`) for the same small bounded work. At `high`, also the cheap challenger for Haiku work. |
| `gpt-terra` @ `xhigh`/`max` | Cheaper, faster peer of `gpt-sol` @ `medium` for bounded and middle-weight coding, analysis, extraction, test and gate runs, and visual or 3D work. Prefer `xhigh`; use `max` only for visual, 3D, or geometry work that needs more. For complex multi-file coding and consequential challenges, use `gpt-sol` @ `high`/`xhigh` or `gpt-astra`. |
| `gpt-sol` @ `medium` | Normal substantive leaf work, co-default with `craig-core:sonnet` @ `high`. Also routine verification. |
| `gpt-sol` @ `high`/`xhigh` | Multi-file leaf work, co-default with `craig-core:sonnet` @ `high`; the fallback when astra is unavailable. At `high`, the routine cross-family challenger. Prefer `high` over `xhigh`. |
| `gpt-astra` @ `medium`/`high`/`xhigh` | Consequential cross-family challenge (`craig-core:opus` @ `high` and above, design calls, security) and complex debugging; peers `craig-core:opus` @ `high` and `craig-core:fable`. Use `gpt-sol` for routine checks; pull in astra for the hardest problems, those needing tenacity, or when sol stalled. |
| `deepseek-flash` @ `low`/`medium`/`high` | The default DeepSeek route: third-family cost peers of Haiku, `craig-core:sonnet` @ `medium`, and @ `high`, respectively; capability at these efforts is unmeasured. Never above `high`. |
| `deepseek-v4-pro` @ `low`/`medium`/`high` | Third-family peers of `craig-core:sonnet` @ `medium`, `craig-core:opus` @ `medium`, and `craig-core:opus` @ `high`; only for a need the intelligence index does not measure. Never above `high`. |

The `craig-core:haiku`/`craig-core:sonnet` @ `medium` split is by per-request prompt length: count the files the agent will read, not only the spawn prompt. For every `gpt-terra` row, prefer `gpt-sol` or a Claude route for prompts well over 100k tokens until Terra's long-context recall is measured.

`/routing-refresh` updates routes; its `EVIDENCE.md` holds their evidence. When a route or model changes, update both tables here, the agent files, craig-core's `require-route-effort.sh` route list, and `EVIDENCE.md`.

Fan out independent necessary work; do not duplicate work merely to create parallelism.

Verification is a second opinion, not a standing panel. Most work needs none. Add exactly one verifier for a consequential design decision, a change spanning several subsystems, or anything touching security, data integrity, concurrency, or a migration; add a second only when one agent cannot cover the change well. A one-file fix, docs edit, test tweak, or mechanical rename does not qualify. Review does not recurse.

### Cross-family pairing

Claude work is challenged by a GPT route and GPT work by a Claude route; no model reviews its own output. Size the challenger to the cost of being wrong, not to the proposer's rank. A proposer named without `@` means that route at any effort it allows.

| Proposer | Challenger | Escalate to | Claude-only challenger | Claude-only escalation |
|---|---|---|---|---|
| `craig-core:opus` @ `high`/`xhigh`, `craig-core:fable` | `gpt-astra` @ `high` | `gpt-astra` @ `xhigh` | `craig-core:opus` @ `high` | `craig-core:opus` @ `xhigh` |
| `craig-core:opus` @ `medium` | `gpt-sol` @ `high` | `gpt-astra` @ `medium` | `craig-core:opus` @ `high` | `craig-core:opus` @ `xhigh` |
| `craig-core:sonnet` @ `high` | `gpt-sol` @ `high` | `gpt-astra` @ `high` | `craig-core:opus` @ `medium` | `craig-core:opus` @ `high` |
| `craig-core:sonnet` @ `medium` | `gpt-sol` @ `medium` | `gpt-sol` @ `high` | `craig-core:opus` @ `medium` | `craig-core:opus` @ `high` |
| `craig-core:haiku` @ `low` | `gpt-luna` @ `medium` | `gpt-sol` @ `medium` | `craig-core:opus` @ `medium` | `craig-core:opus` @ `high` |
| `craig-core:haiku` @ `xhigh`/`max` | `gpt-terra` @ `high` | `gpt-sol` @ `medium` | `craig-core:opus` @ `medium` | `craig-core:opus` @ `high` |

Cross-family proposers exist only where those routes are available:

| Proposer | Challenger | Escalate to |
|---|---|---|
| `gpt-astra`, `gpt-sol` @ `high`/`xhigh` | `craig-core:opus` @ `high` | `craig-core:opus` @ `xhigh` |
| `gpt-sol` @ `medium`, `gpt-terra` @ `xhigh`/`max` | `craig-core:opus` @ `medium` | `craig-core:opus` @ `high` |
| `gpt-terra` @ `medium`/`high` | `craig-core:haiku` @ `max` | `craig-core:sonnet` @ `high` |
| `gpt-luna`, `gpt-terra` @ `low`, `deepseek-*` @ `low` | `craig-core:haiku` @ `xhigh` | `craig-core:sonnet` @ `high` |
| `deepseek-v4-pro` @ `high`, `deepseek-flash` @ `high` | `craig-core:opus` @ `high` | `gpt-sol` @ `high` |
| `deepseek-*` @ `medium` | `craig-core:sonnet` @ `high` | `craig-core:opus` @ `medium` |

Security work (doing it or reviewing it) overrides these pairings: use `gpt-astra` (any listed effort). Claude-only, use `craig-core:opus` @ `high` (`xhigh` for the hardest), never Fable or Haiku, and report the check as same-family and possibly run on an older Opus. When both families refuse authorized security or sysadmin work (CA certificates, scanning Craig's own network), fall back to `deepseek-flash` @ `high`, whose content filtering is less sensitive. Send it only what the task needs, never private keys or credentials, and report the work as unverified if every challenger also refuses.

A disagreement is a finding to resolve, not a tie to split: escalate one rung and report both positions. Claude-only, use the Claude-only columns. Otherwise, if that rung shares the proposer's or challenger's family, use the third family instead (`deepseek-flash` @ `high` for Sonnet-tier work, `deepseek-v4-pro` @ `high` for Opus-tier) and report all three positions.

---

Destructive git commands are blocked by a PreToolUse hook: `git checkout -- <path>`, `git restore` (except the pure `--staged` unstage form), `git reset --hard`, and `git clean` with a force flag (dry runs allowed); undo your own edits by editing.

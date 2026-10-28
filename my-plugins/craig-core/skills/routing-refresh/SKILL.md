---
name: routing-refresh
description: Update Craig's model-routing rules when Anthropic, OpenAI, or DeepSeek ship or reprice models. Gathers benchmark, price, and effort evidence, then proposes edits to the routing and pairing tables in COMMON-CLAUDE.md, the route agent files, the hook's route list, and EVIDENCE.md, and applies them after approval.
disable-model-invocation: true
argument-hint: "[model names and/or URLs describing them]"
---

# Routing refresh

Procedure for changing which models the routes use. The facts live in `EVIDENCE.md` beside this file, never here. Paths below are relative to `~/.claude/my-plugins/craig-core/` unless absolute.

Arguments: $ARGUMENTS

## 1. Scope

- **With arguments**, focus on the models they name and fetch every URL they give (vendor announcements, Artificial Analysis model pages, docs).
- **With none**, discover. On Craig's Mac, compare these against the models in `EVIDENCE.md` and report what is new, renamed, or gone:
  - `GET http://127.0.0.1:8317/v1/models` (Claude, GPT, and DeepSeek rows) and `GET /healthz`.
  - The utraque Codex catalog cache, `~/Library/Caches/utraque/models_cache.json` (`supported_reasoning_levels`, `context_window` per model).
- The proxy exists on Craig's Mac only when `ANTHROPIC_BASE_URL` is `http://127.0.0.1:8317`. Otherwise do the Claude-only parts and say the proxy checks were skipped.

## 2. Gather

- Fetch each given URL, plus the Artificial Analysis release page for every new model (per-effort Intelligence Index, cost per index task, prices, output tokens, speed, context window) and the vendor announcement.
- Fetch through web-fetch or sub-agents so page dumps stay out of the main context.
- If a page returns 403, say so and ask Craig to paste it or open it in a browser. Do not work around it.
- Record the source URL and check date for every figure. Never present a chart reading as exact; mark it "~".

## 3. Probe (Craig's Mac only)

Keep probes tiny; they spend subscription quota.

- **Each new GPT or DeepSeek route:**
  - (a) Which efforts the catalog lists, and whether utraque clamps them (`effort_applied` in `~/Library/Logs/utraque/utraque.log`).
  - (b) A tool-call probe through the proxy with one required and two optional fields, a forced `tool_choice`, and 3 runs, to confirm the optional fields are left out.
  - (c) Image input, if the route should take images.
- **Each new Claude model:** the Agent `model` enum and the effort levels it accepts.

## 4. Decide

- Place each model and effort by matching its AA score and cost per index task against existing rows. Compare at equal scores, not equal effort names.
- When a vendor's "Nx cheaper" or "Nx faster" claim compares mismatched efforts, say so.
- A route's allowed efforts are those with a distinct use. Drop an effort that duplicates another or is dominated.
- Pick challengers by the pairing rule in CLAUDE.md: cross-family, sized to the cost of being wrong.

## 5. Propose, then wait

Show Craig the planned diffs for:

- `instructions/COMMON-CLAUDE.md`: the routing table and both pairing tables.
- The route agent file(s): `~/.claude/agents/` for `gpt-*` and `deepseek-*`, `agents/` here for Claude routes. The description lists the allowed efforts.
- The `ROUTES` list in `hooks/require-route-effort.sh` and in `tests/require-route-effort.test.sh`, when a route is added or removed.
- `README.md`, if it lists routes.
- `skills/routing-refresh/EVIDENCE.md`.

Flag every point where the evidence contradicts Craig's request. Do not edit anything until he approves.

## 6. Apply

- Delegate the edits to sub-agents per the CLAUDE.md routing tables. Edit tracked files only with Edit or Write. Replace superseded facts; do not leave "previously" or "superseded" notes.
- Run both test scripts and report their results:
  - `bash "${CLAUDE_SKILL_DIR}/../../tests/require-route-effort.test.sh"`
  - `bash "${CLAUDE_SKILL_DIR}/../../tests/inject-instructions.test.sh"`
- Get one cross-family check of the table edits (the pairing table especially), using the CLAUDE.md pairing rule.
- Sweep for old-model pins: search the instruction files, agent files, skills, and docs for retired model names and IDs, and prefer floating aliases.
- Do not commit unless Craig asks.

## 7. Report

State what changed, what was verified, and what is unverified (for example efforts never observed in the proxy log, or missing long-context scores). For each unverified item, say whether it needs Craig's action.

---
name: review-changes
description: Use before committing a substantial change — several subsystems, a reshaped abstraction, or security, data integrity, concurrency, or a migration. Spawns ONE cross-family verifier to check the diff for bugs, wiring gaps, dead code, and alignment. Not for small or routine changes.
---

# Review Changes

One independent opinion on the uncommitted changes before they are committed.

> **Not a panel.** One verifier. Most changes need none. If you were yourself spawned to review, do not run this — review does not recurse.
>
> Distinct from `/code-review`, which is a diff-focused bug + cleanup pass with an ultra cloud mode.

## When to run it

Run it when the change is substantial in at least one way:

- spans several files or subsystems
- introduces or reshapes an abstraction
- touches security, data integrity, concurrency, or a migration
- would be costly to reverse

Otherwise skip it. A one-file fix, docs edit, test-only change, or mechanical rename does not earn a verifier. "No verifier needed — one-file fix" is a valid outcome of considering this skill.

## Which verifier

Prefer a **different model family**: it fails differently than this session does. Pair off the session's own model: `gpt-sol-high` for a `fable-*` or `opus-high` session, `gpt-terra-high` for `sonnet-high`. Load `model-selection` only if the session model is neither — its table covers the rest. When in doubt use `gpt-sol-high`; this runs on work already believed finished, so a missed defect costs more than the stronger reviewer.

No proxy (`ANTHROPIC_BASE_URL` not naming `utraque`, or it is down) means no cross-family route: use `opus-high` (or `fable-high`) and report that the check was same-family.

When alignment is the *only* material risk, use `project-steward` instead — it covers alignment and deliberately does not audit bugs, edge cases, or wiring. If the change carries correctness risk too, use a general verifier; the last checklist bullet already covers alignment.

Add a second verifier only when one agent cannot cover the change well — a diff that is both a security change and a migration, say. That is the exception.

## What it checks

Hand it this list in full — one agent covers all of it, not one agent per bullet:

- the changes against the plan from this conversation
- bugs and logic errors; unintended consequences elsewhere
- wiring: imports, exports, registrations, config, **and the call graph**. Trace the paths to confirm new code is actually invoked from its entry points — implementing a feature and never hooking it up is a common failure
- code made dead or redundant by the change
- alignment with the project's stated direction, conventions, and documented decisions

Do not pre-read the diff or gather context first; let the verifier investigate itself and keep orchestrator context free. Launch it with `run_in_background: true` and a distinct name.

## Output

- issues by severity (critical / major / minor)
- whether the changes match the plan
- dead code to prune
- alignment concerns
- overall: are we in good shape?
- which verifier ran, and whether the check was cross-family or same-family

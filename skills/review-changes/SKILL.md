---
name: review-changes
description: Multi-agent review of uncommitted changes against the plan. Delegates to multiple specialized agents (including Codex) to check for bugs, unintended consequences, dead code, and correct wiring. Use after implementation is complete and lint/tests pass.
disable-model-invocation: true
---

# Review Changes

Conduct a thorough multi-agent review of all uncommitted changes in the repository.

## What to Review

- Compare the uncommitted changes against the plan from this conversation
- Look for potential bugs or logic errors
- Identify places where these changes could have unintended consequences on other parts of the system
- Verify that everything is wired up correctly — imports, exports, registrations, config, AND the call graph. Trace the code paths to confirm new features are actually invoked from the appropriate entry points. (This is critical: a common failure mode is implementing a feature but never hooking it into the code that calls it.)
- Check whether these changes have made other portions of code redundant or dead, and flag anything that can be pruned

## How to Review

Delegate this review to **at least 3 different agents running in parallel**. Use different models and agent specializations for diverse perspectives. More agents are welcome if additional specialized agents are available — 3 is the minimum, not the target.

Each agent has full access to the codebase, git history, and all tools. Do NOT pre-read diffs or gather context before delegating — just invoke the agents with their instructions and let each one do its own investigation. This preserves orchestrator context.

1. **A Codex-based agent** (mandatory — use whatever codex/OpenAI agent is available). Have it review the uncommitted changes for architectural soundness, potential bugs, and unintended side-effects.

2. **A code reviewer agent** — focused on correctness, code quality, potential bugs, edge cases, and completeness vs. the plan.

3. **A code architect agent** — focused on structural integrity, wiring/call-graph verification, dead code detection, and whether the changes fit cleanly into the existing architecture.

4. **Additional agents** — if other specialized agents are available (e.g., security, performance, testing), include them too. The more perspectives, the better.

Using multiple agents with different underlying models provides broader coverage and catches issues that a single reviewer would miss.

## Output

Consolidate the findings from all agents into a clear summary:
- Issues found (by severity: critical, major, minor)
- Whether the changes match the plan
- Any dead code or redundancies to clean up
- Overall assessment: are we in good shape?

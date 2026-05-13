---
name: review-changes
description: Multi-agent review of uncommitted changes against the plan. Delegates to four mandatory perspectives (Codex, code reviewer, code architect, and project-steward) to check for bugs, unintended consequences, dead code, correct wiring, and long-term project/maintainability alignment. Use after implementation is complete and lint/tests pass.
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

Delegate this review to **at least 4 different agents running in parallel**. Use different models and agent specializations for diverse perspectives. More agents are welcome if additional specialized agents are available — 4 is the minimum, not the target.

Each agent has full access to the codebase, git history, and all tools. Do NOT pre-read diffs or gather context before delegating — just invoke the agents with their instructions and let each one do its own investigation. This preserves orchestrator context.

1. **A Codex-based agent** (mandatory — use whatever codex/OpenAI agent is available). Have it review the uncommitted changes for architectural soundness, potential bugs, and unintended side-effects.

2. **A code reviewer agent** — focused on correctness, code quality, potential bugs, edge cases, and completeness vs. the plan.

3. **A code architect agent** — focused on *in-codebase* structural integrity: wiring/call-graph verification, dead code detection, and whether new code integrates cleanly with existing modules and abstractions.

4. **A `project-steward` agent** (mandatory — definition at `~/.claude/agents/project-steward.md`) — focused on the forest, not the trees: long-term project alignment, documentation compliance, and maintainability. It reads the project's orientation docs (README, CLAUDE.md, ARCHITECTURE, ROADMAP, ADRs) before assessing the diff, and checks whether the changes are consistent with stated project direction, conventions, and documented decisions. Unlike the code architect, which evaluates internal code structure, project-steward assesses whether the diff honors the project's stated direction and documented decisions as captured in those orientation docs. This complements — does not replace — the code-level reviewers above.

5. **Additional agents** — if other specialized agents are available (e.g., security, performance, testing), include them too. The more perspectives, the better.

Using multiple agents with different underlying models provides broader coverage and catches issues that a single reviewer would miss.

## Output

Consolidate the findings from all agents into a clear summary:
- Issues found (by severity: critical, major, minor)
- Whether the changes match the plan
- Any dead code or redundancies to clean up
- Alignment with project goals / docs / long-term maintainability — `project-steward`'s alignment verdict and any documentation or maintainability concerns it raised
- Overall assessment: are we in good shape?

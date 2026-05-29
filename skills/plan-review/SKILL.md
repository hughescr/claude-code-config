---
name: plan-review
description: Use when explicitly asked to walk through a plan or list of issues one-by-one, with the user deciding each via AskUserQuestion. Triggers only on a request to review/triage a plan interactively — NOT on any casual mention of a feature, fix, or bug.
---

# Plan Review

Review and discuss issues that need fixing or implementing, one at a time.

## Process

1. **Identify issues to review from conversation context.** Look at the current conversation for a plan, a list of issues, or any prior discussion of features, fixes, or bugs. Work from whatever is already in context — do NOT scan the codebase independently for issues.

2. **For each issue, explain it clearly.** Describe the issue as though the user doesn't know much about the code or the problem. Cover:
   - What the issue is and where it lives in the codebase
   - Why it matters (impact, risk, or benefit of fixing it)
   - What the possible fix or implementation options are, with trade-offs

3. **Use AskUserQuestion for each issue.** Present the user with clear options for how to proceed — e.g., fix now, skip, defer, or take an alternative approach. Let the user drive the decision.

4. **Ask clarifying questions freely.** If anything is unclear at any point — about the codebase, the user's intent, or the best approach — use AskUserQuestion immediately rather than guessing.

5. **Proceed through all issues sequentially.** Don't rush or batch. One issue at a time, fully resolved before moving to the next.

6. **After all issues are decided, summarize, record, and delegate.** Recap the decisions made, then record the chosen actions into the task list with TaskCreate — capturing any sequential (`→`) or parallel (`||`) shape between them. Then DELEGATE the chosen fixes to sub-agents per the orchestrator rules in `~/.claude/CLAUDE.md`. This skill itself does NOT start writing code — it routes the decided work to sub-agents.

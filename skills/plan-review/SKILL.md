---
name: plan-review
description: Walk through each issue or planned change one-by-one, explaining each to the user and using AskUserQuestion to choose how to proceed. Use when reviewing plans, proposals, or discussing features/fixes/bugs.
disable-model-invocation: true
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

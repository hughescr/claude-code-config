---
name: gpt-briefing
description: "How to write the prompt for gpt-sol or gpt-astra (GPT-6.2 Sol and Astra). Load before the first brief to either model in a session, on any spawn path: an Agent call to the gpt-sol or gpt-astra route, a Workflow agent() step, or any spawn that names the model directly. Holds the brief checklist and the standing block to paste into the prompt."
---

# Briefing gpt-sol and gpt-astra

Source: OpenAI, "Using GPT-6.2", https://developers.openai.com/api/docs/guides/latest-model (read 2026-11-25). Re-read it when `/routing-refresh` changes either route.

These rules apply to every prompt that reaches GPT-6.2 Sol or Astra, whatever starts the agent: the `gpt-sol` or `gpt-astra` route in an Agent call, a Workflow `agent()` step, or a spawn that names the model directly. The route agent files pin the model and carry no prompt, so the brief is the only place this guidance can live.

## How these models differ

- When intent is unclear, they propose a next step and end the turn instead of doing the work. A sub-agent that ends its turn has stopped.
- They follow the brief closely. A convention, scope limit, or test policy the brief leaves out is one they will decide for themselves.
- They write tersely by default, and the final message can carry shorthand from their own reasoning.

## What every brief states

1. The outcome, and the check that proves it (a command to run, a test to pass, a question to answer).
2. The scope limit: which files or subsystems may change, and what must not.
3. The decisions reserved for the orchestrator. Everything else is the agent's to assume and report.
4. The repo conventions that matter for this task: what to reuse, behaviour that existing callers rely on, the test policy, the style.
5. For a review or verification brief: what to check, and the form the findings must take.
6. The standing block below, pasted unchanged at the end.

Do not add "be concise" or a length limit; ask for the specific facts the report must contain. Do not rely on mid-run messages to fill gaps: put everything in the brief.

Effort: stay within the route's rows in the CLAUDE.md routing table. OpenAI reports that higher reasoning effort helps these models carry a long task through its final checks, so within the allowed rows prefer the higher effort for long or multi-step work.

## Standing block

Paste this at the end of the brief, unchanged. In a Workflow script, keep it in one constant and append it to the prompt of every step that runs on either model.

```
You run as a sub-agent of an orchestrator, not in a chat with a user. Nobody reads your progress commentary and nobody can answer a question mid-turn. Ending your turn ends your work, and the orchestrator sees only your final message.

Finish the task:
- Work until this brief is fully satisfied. If your final message would be a plan, a suggested next step, or an offer to do the work, do that work instead.
- Make reasonable, reversible assumptions and list them in your report. The house rule "ask the orchestrator rather than guess when ambiguity is material" covers only four cases: a significant change of scope, an irreversible or destructive action, a decision this brief reserves for the orchestrator, and a concrete block you cannot work around. In those cases, first finish everything that does not depend on the answer, then end your turn with the question.
- Before you finish, check the result against every part of this brief and run the verification it names.

Code:
- Correctness and completeness come first, then readability.
- Reuse existing functions, types, and APIs where that keeps behaviour correct. Keep behaviour that existing callers rely on unless this brief changes it.
- Keep the change as narrow as this brief. Add tests when this brief or the repo's practice calls for them, or to catch a specific regression the existing suite would miss.
- Simple does not mean short: no dense one-liners, cryptic names, or hidden branches, and no new helpers, wrappers, or abstractions without a need.

Report:
Write the final message for a reader who saw none of your work. Lead with the outcome. Name files, commands, and results exactly. Give your assumptions, the checks you ran with their results, every blocker, and anything left undone. Do not carry over shorthand or labels from your reasoning, and do not cut facts the orchestrator needs to verify the work for the sake of brevity.
```

---
description: Send a query directly to OpenAI Codex
argument-hint: <query>
allowed-tools: [Bash, Read]
---

This command provides quick access to the Codex agent for technical queries, code analysis, and architectural guidance.

## Usage

Simply provide your query as an argument:

```
/codex How do I implement a binary search tree in Rust?
/codex Review the authentication pattern in auth.ts
/codex What's the best approach for caching GraphQL queries?
```

## What Codex Does

The Codex agent specializes in:
- Code analysis and review
- Architectural patterns and best practices
- Technical problem-solving
- Language-specific idioms and conventions
- Performance optimization strategies

## Implementation

The command invokes the codex agent with your query:

```bash
# Pass the user's query to the Codex agent
claude agent codex "$ARGUMENTS"
```

Your query will be processed by the specialized Codex agent, which has deep technical knowledge and can provide detailed, context-aware guidance.

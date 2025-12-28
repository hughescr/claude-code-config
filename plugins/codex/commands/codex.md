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

### Invoke Codex
Execute the Codex CLI with the query verbatim:

```bash
codex exec --full-auto --json -C /path/to/workspace "USER_QUERY_VERBATIM"
```

### Return Response
Output Codex's response exactly as received. No additions, no summary, no meta-commentary.

## CLI Reference

For detailed CLI invocation syntax, flags, options, and permission management, invoke the **codex-cli-reference** skill.

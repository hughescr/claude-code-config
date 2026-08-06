---
name: stryker-mutation-testing
description: This skill should be used when the user mentions "stryker", "mutation testing", "mutant", "mutation score", "survived mutant", "NoCoverage", "stryker disable", "mutation report", "equivalent mutant", "stryker incremental", "stryker cache", or any mutation testing of JavaScript/TypeScript code. Provides comprehensive Stryker mutation testing patterns, disable comment syntax, and strategies for handling survived mutants and NoCoverage results.
---

# Stryker Mutation Testing

## Disable Comment Syntax

### Single-Line Disable
`// Stryker disable next-line <MutatorName>` — disables specific mutator on next line.

**CRITICAL**: This comment must be placed at the STATEMENT level. It will FAIL silently if placed:
- Inside object literals (before a property)
- Before method chain continuations (`.then()`, `.map()`, etc.)
- The comment must be on the line BEFORE the full statement

### Block Disable/Restore
```javascript
// Stryker disable <MutatorName>
// ... code here is not mutated for that mutator ...
// Stryker restore <MutatorName>
```

**Nesting gotcha**: An inner `// Stryker restore <Type>` will re-enable mutations even within an outer `// Stryker disable all`. Be careful with scoping — avoid nesting disable/restore blocks.

### Disable All
`// Stryker disable all` — disables ALL mutators for subsequent lines. Use sparingly, primarily for untestable I/O methods (file system operations, network calls, process management).

### Common Mutator Names
ArithmeticOperator, ArrayDeclaration, ArrowFunction, BlockStatement, BooleanLiteral,
ConditionalExpression, EqualityOperator, LogicalOperator, MethodExpression,
ObjectLiteral, OptionalChaining, StringLiteral, UnaryOperator, UpdateOperator

## Incremental Cache

Stryker typically stores incremental results at `reports/stryker-incremental.json`.

**WARNING**: NEVER delete this file without first explaining to the user why and confirming with AskUserQuestion. On large projects, this file saves dozens of minutes by skipping unchanged mutants. Deleting it forces a full re-run of the entire mutation suite.

When to consider clearing (WITH user confirmation):
- Major refactors that change file structure
- Stryker version upgrades
- Suspicion of corrupted/stale cache causing false results

## NoCoverage Patterns

NoCoverage means no test exercises that code path. Common patterns that legitimately have NoCoverage:

- **Nullish coalescing defaults**: `value ?? false`, `value ?? []`, `value ?? ''` — the fallback branch only runs when upstream returns nullish, which is hard to trigger in unit tests
- **Conditional spreads**: `...(condition ? { key: value } : {})` — the falsy branch produces an empty object, functionally equivalent
- **I/O methods**: File-reading functions, network calls, process spawning — use `// Stryker disable all` for these
- **Error logging in catch blocks**: The specific log message is not behavior-relevant

## Survived Mutant Patterns

Survived means the mutant wasn't killed by any test. Common patterns:

### Separator strings in `.join()`
```javascript
items.join(', ')  // Mutant: items.join('') survives
```
**Fix**: Test with 2+ element arrays so the separator is visible in output. A single-element array never uses the separator.

### Optimization guards
```javascript
if (arr.length === 0) return [];  // Mutant: remove this line survives
```
If the remaining code handles empty arrays correctly (e.g., `.map()` on empty array returns `[]`), both paths are equivalent. This is a legitimate survivor — disable with:
```javascript
// Stryker disable next-line ConditionalExpression
if (arr.length === 0) return [];
```

### External API wrapping equivalences
When a function wraps an external API call and the mutation creates an equivalent call pattern, the mutant survives because both produce the same result. Disable with a comment explaining the equivalence.

## Workflow

1. Run all tests first — ensure they pass before mutation testing
2. If the project has a `mutate` script in package.json, run `bun run mutate`
3. Review the HTML report at `reports/mutation/html/index.html`
4. Address survived mutants:
   - Can you write a test that kills it? Write the test
   - Is it a legitimate equivalent mutant? Disable with comment explaining why
   - Is it NoCoverage? Determine if the code path is testable
5. Never chase 100% score at the expense of meaningful tests

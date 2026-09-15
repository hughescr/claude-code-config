---
name: typescript-quality
description: Use for TypeScript type-safety work - fixing type/tsc errors, adding types or TSDoc, enabling strict mode, or sourcing @types packages. Provides guidance on strict mode compliance, TSDoc documentation, and DefinitelyTyped packages.
---

# TypeScript Quality Standards

This skill covers TypeScript-specific quality requirements including strict mode compliance, type safety, and documentation standards.

## Type Checking

Run type checking through package.json scripts:
```bash
bun run typecheck     # Preferred - uses project tsconfig.json
bunx tsc --noEmit     # Only if no typecheck script exists
```

Run tsc against the full project, not individual files — TypeScript needs full project context for correct type-checking. A `block-tsc-with-files` hook blocks per-file invocations, so use `bun run typecheck` (preferred) or `bunx tsc --noEmit`.

## Strict Mode Compliance

All TypeScript projects use strict mode. Ensure:
- No implicit `any` types - all variables, parameters, and return types should have explicit types or be inferable
- Proper null safety - no unguarded access to potentially null/undefined values
- No `@ts-ignore` without exceptional justification and comment explaining why
- No non-null assertion (`!`) without safety checks or clear documentation

## TSDoc Documentation

Document public APIs with TSDoc format:
```typescript
/**
 * Brief description of function purpose
 *
 * @param input - Description of the input parameter
 * @param schema - Description of the schema parameter
 * @returns Description of return value
 * @throws {ErrorType} When this error is thrown
 * @example
 * ```typescript
 * const result = myFunction(input, schema);
 * ```
 */
export function myFunction<T>(input: unknown, schema: Schema<T>): T {
  // implementation
}
```

## Type Definitions

### Bundled Types (Preferred)
Package includes `types` field in package.json - no @types package needed.

### DefinitelyTyped (@types)
For packages without bundled types:
1. Search for an existing @types package first
2. Install as dev dependency:
```bash
bun add -d @types/package-name
```
Match the @types major version to the package major version (e.g., lodash@4.x uses @types/lodash@4.x).

### No Types Available
If a package has no types and no @types package exists:
1. Check if a newer version of the package has types
2. Search npm for alternative @types packages (sometimes named differently)
3. Create local `.d.ts` file with minimal declarations
4. As last resort, use `declare module 'package-name';`

## Quality Checklist

Before completing TypeScript work:
1. Zero TypeScript errors (check with `bun run typecheck` or watcher)
2. Zero TypeScript warnings
3. Proper type annotations on public APIs (no implicit any)
4. TSDoc comments on exported functions, classes, and types
5. Strict mode compliance (null safety, no @ts-ignore abuse)
6. @types packages added for dependencies without bundled types

## ESLint Auto-Fix

For formatting and stylistic issues, use auto-fix to save time:
```bash
bun lint --fix     # If project uses bun scripts
eslint --fix .     # Direct eslint command
```

Auto-fix handles: trailing commas, semicolons, quotes, spacing, import order, and many other formatting rules. Always review changes after running auto-fix.

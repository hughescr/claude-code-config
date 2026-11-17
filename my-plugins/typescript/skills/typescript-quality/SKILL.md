---
name: typescript-quality
description: Use for TypeScript type-safety work - fixing type errors from tsc or tsrs, adding types or TSDoc, enabling strict mode, sourcing @types packages, or Oxlint/ast-grep lint errors and disable directives. Provides guidance on strict mode compliance, TSDoc documentation, and DefinitelyTyped packages.
---

# TypeScript Quality Standards

This skill covers TypeScript-specific quality requirements including strict mode compliance, type safety, and documentation standards.

## Type Checking

Run type checking through package.json scripts:
```bash
bun run typecheck     # Preferred - uses project tsconfig.json
```

Fallback when no typecheck script exists: run the compiler the project declares in package.json. Use `bunx tsrs --noEmit` for a tsrs project and `bunx tsc --noEmit` otherwise. tsrs is a Rust port of the TypeScript compiler with tsc's CLI flags.

Run the compiler against the full project, not individual files, because it needs full project context for correct type-checking. This applies to tsrs as well as tsc. A plugin guard blocks per-file invocations of both `tsc` and `tsrs`.

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
7. Zero lint errors and warnings (`bun run lint`; see Linting below)

## Linting

Which linter runs is decided by the project's package.json scripts and config files (`oxlint.config.ts` vs `eslint.config.*`). Some projects still run ESLint.

- **Gate:** `bun run lint`. For auto-fix, run `bun run lint:fix` if the script exists, then review the diff.
- **Direct Oxlint runs** go under Node from the repo root, never through bun or bunx:
  ```bash
  node node_modules/oxlint/bin/oxlint --deny-warnings <paths>
  ```
  Bun truncates piped output at 64 KiB, and some rules resolve globs against the working directory. This is a deliberate exception to the bun-first rule.
- **Always pass `--deny-warnings`.** Warnings alone exit 0, and unused disable directives are reported as warnings.
- **Type-aware rules** run through tsrs, using each file's nearest `tsconfig.json`. Lint does not report compiler diagnostics, so the typecheck gate stays separate.
- **ast-grep** holds the syntax bans and lint-directive policy. Run it through the project's script (commonly `bun run check:ast-grep`, which runs `ast-grep scan`) where one exists.
- **Suppress an Oxlint rule** on the line above the code:
  ```ts
  // eslint-disable-next-line <rule-id> -- <specific reason>
  ```
  Oxlint honours ESLint directive syntax. The rule list and the reason are both required. Use the id Oxlint reports: ESLint-plugin rules loaded under an alias carry the alias prefix (`eslint-core/`, `unicorn-js/`, `import-x-js/`, `n-js/`, `jest-js/`).
- **Directive policy:** use only `disable-next-line` or `disable-line`, for local exceptions. Whole-file disables go in the file header before any code. Never use `eslint-enable` or `oxlint-enable`, or inline `eslint`, `global`, `globals`, `exported`, or `eslint-env` config comments. Delete a directive once it is no longer needed, since it fails the gate as unused.
- **Suppress an ast-grep rule** on the line above the code:
  ```ts
  // ast-grep-ignore: <rule-id> -- <reason>
  ```
  In `.js`/`.jsx` files the shared rule ids end in `-javascript`; in `.tsx` they end in `-tsx`.
- `package.json` is still linted by ESLint, since Oxlint does not lint JSON. The project's lint script already runs it.

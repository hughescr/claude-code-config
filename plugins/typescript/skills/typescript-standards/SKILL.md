---
name: typescript-standards
description: This skill should be used when working with TypeScript or JavaScript in any capacity - development, testing, debugging, documentation, or dependency management. Provides core runtime and tooling standards.
---

# TypeScript & JavaScript Standards

## Runtime & Tooling Requirements

### Bun Runtime (CRITICAL)

**ALWAYS use Bun instead of Node.js or npm for all TypeScript and JavaScript work.**

#### Package Management
```bash
# ✅ CORRECT - Use Bun
bun install
bun add <package>
bun remove <package>
bun update <package>

# ❌ INCORRECT - Do NOT use npm/yarn/pnpm
npm install
npm add <package>
yarn install
pnpm install
```

#### Script Execution
```bash
# ✅ CORRECT - Use Bun
bun run script-name
bun run dev
bun run build
bun run start

# ❌ INCORRECT - Do NOT use npm
npm run script-name
```

#### Prefer package.json Scripts (IMPORTANT)

**If a script exists in package.json, always use it instead of running the tool directly.**

```bash
# ✅ CORRECT - Use the project's configured scripts
bun run lint          # Instead of bunx eslint
bun run typecheck     # Instead of bunx tsc
bun run format        # Instead of bunx prettier
bun run test          # Instead of bunx jest

# ❌ INCORRECT - Running tools directly bypasses project configuration
bunx eslint src/
bunx tsc --noEmit
bunx prettier --write .
```

**Why this matters:**
- Scripts include project-specific flags and configuration
- Scripts may run multiple tools in sequence (e.g., lint + typecheck)
- Scripts ensure consistent behavior across team members
- Direct tool invocation may miss config files or use wrong options

**Bun "run" shorthand:** You can omit `run` when the script name doesn't conflict with a bun command:
```bash
bun lint              # ✅ Works - "lint" is not a bun command
bun typecheck         # ✅ Works - "typecheck" is not a bun command
bun format            # ✅ Works - "format" is not a bun command
bun test              # ⚠️  Runs bun's built-in test runner, NOT the "test" script
bun run test          # ✅ Use this to run the package.json "test" script
bun build             # ⚠️  Runs bun's bundler, NOT a "build" script
bun run build         # ✅ Use this to run the package.json "build" script
```

Common bun verbs to watch out for: `test`, `run`, `install`, `add`, `remove`, `update`, `init`, `create`, `build`

#### Executable Tools
```bash
# ✅ CORRECT - Use bunx
bunx <command>
bunx tsc
bunx eslint
bunx prettier

# ❌ INCORRECT - Do NOT use npx
npx <command>
```

#### Direct Execution
```bash
# ✅ CORRECT - Use bun
bun script.ts
bun index.js
bun --watch dev.ts

# ❌ INCORRECT - Do NOT use node
node script.js
ts-node script.ts
```

#### Testing
```bash
# ✅ CORRECT - Use bun test
bun test
bun test --watch
bun test --coverage

# ❌ INCORRECT - Do NOT use other test runners via npm
npm test
npm run jest
```

#### REPL & Debugging
```bash
# ✅ CORRECT - Use bun
bun repl
bun --inspect script.ts

# ❌ INCORRECT - Do NOT use node
node --inspect script.js
```

### Why Bun?

- **Performance**: 3-4x faster than Node.js for most operations
- **Built-in TypeScript**: Native TS support without transpilation
- **All-in-one**: Runtime, package manager, bundler, and test runner
- **npm Compatible**: Works with existing npm packages and package.json
- **Modern Defaults**: ESM, top-level await, JSX support out of the box

### Migration Notes

When working with existing projects:
- Bun respects `package.json` scripts and dependencies
- `bun install` reads `package-lock.json` and creates `bun.lock`
- All npm packages work with Bun (npm registry compatible)
- Replace `node` with `bun` in shebang lines: `#!/usr/bin/env bun`

### Exception Cases

The ONLY time to use Node.js/npm is when:
- Explicitly debugging Node.js-specific compatibility issues
- Working with tools that have hard Node.js version dependencies
- User explicitly requests npm/node for a specific reason

**In all other cases, default to Bun.**

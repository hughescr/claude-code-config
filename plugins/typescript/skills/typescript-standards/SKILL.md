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

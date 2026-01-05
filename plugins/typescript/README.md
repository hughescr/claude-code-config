# TypeScript Plugin

TypeScript-specific agent overrides with MCP tool integrations for Claude Code.

## Agents

| Agent | Model | Description |
|-------|-------|-------------|
| **debugger-optimizer** | sonnet | Problem solver for debugging and performance optimization |
| **dependency-platform** | sonnet | Package and dependency management specialist |
| **documentation-platform** | sonnet | Technical documentation specialist |
| **feature-developer** | opus | Full-stack feature implementation specialist |
| **quality-guardian** | opus | Testing and code review specialist |

## Skills

### typescript-standards

Core TypeScript/JavaScript runtime standards enforcing a **Bun-first approach**:

- Use `bun` instead of `node` for execution
- Use `bun install/add/remove` instead of `npm/yarn/pnpm`
- Use `bunx` instead of `npx`
- Prefer `package.json` scripts over direct tool invocation

## Integrations

### MCP Server

**DevTools** via `@hughescr/mcp-proxy-processor`

Provides symbol-based editing, TypeScript diagnostics, and code navigation tools to agents.

### LSP Server

**typescript-language-server** for TypeScript/JavaScript files.

Supported extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`

### Hooks

**PreToolUse: block-tsc-with-files**

Blocks `tsc` invocations with direct file arguments. TypeScript should process the entire project for proper type-checking. Use `tsc --noEmit` or `bun run typecheck` instead.

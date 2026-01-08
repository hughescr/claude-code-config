# JavaScript Plugin

JavaScript and Node.js development tools for Claude Code.

## Agents

| Agent | Model | Description |
|-------|-------|-------------|
| **dependency-platform** | sonnet | Package and dependency management specialist |

## Skills

- **bun-runtime**: Bun-first runtime standards for JavaScript projects

## MCP Tools (via nodejs-packages)

- `search-npm-packages` - Search the NPM registry
- `get-npm-package-details` - Get package information
- `list-npm-package-versions` - List available versions

## LSP

Provides TypeScript Language Server for JavaScript/TypeScript files:
- `.js`, `.jsx`, `.mjs`, `.cjs` - JavaScript
- `.ts`, `.tsx`, `.mts`, `.cts` - TypeScript

### Built-in LSP Tools

Claude Code provides built-in LSP tools for code navigation:
- `goToDefinition` - Jump to where a symbol is defined
- `findReferences` - Find all usages of a symbol
- `documentSymbol` - List all symbols in a file
- `workspaceSymbol` - Search symbols across the project
- `hover` - Get type info and documentation
- `goToImplementation` - Find interface implementations
- `prepareCallHierarchy` / `incomingCalls` / `outgoingCalls` - Analyze call relationships

These tools work automatically with the TypeScript Language Server configured by this plugin.

## Usage

This plugin is automatically loaded for projects with `package.json`. It builds on the generic-dev plugin which provides symbolic editing tools (for refactoring via AST-based edits) and documentation lookup.

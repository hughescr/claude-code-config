# TypeScript Plugin

TypeScript-specific development tools for Claude Code.

## Skills

- **typescript-quality**: TypeScript-specific quality standards (type checking, strict mode, TSDoc)

## Hooks

- **block-tsc-with-files**: Prevents running `tsc` with individual file arguments (TypeScript needs full project context)

## Usage

This plugin is automatically loaded for TypeScript projects (detected via `tsconfig.json` or typescript in package.json). It builds on:
- **generic-dev**: Symbol editing, documentation tools
- **javascript**: npm packages, Bun runtime

## Code Navigation (Built-in LSP)

Claude Code provides built-in LSP tools for TypeScript code navigation:
- **goToDefinition**: Jump to where a symbol is defined
- **findReferences**: Find all usages of a symbol
- **hover**: Get type information and documentation
- **documentSymbol**: List all symbols in a file
- **workspaceSymbol**: Search for symbols across the project
- **goToImplementation**: Find implementations of interfaces/abstract methods
- **prepareCallHierarchy / incomingCalls / outgoingCalls**: Analyze call relationships

The typescript-language-server handles TypeScript files automatically when LSP is configured.

## Plugin Stack

For TypeScript projects, plugins are loaded in order:
1. `generic-dev` - DevTools MCP (symbol editing, docs, security)
2. `javascript` - nodejs-packages MCP, Bun runtime skill
3. `typescript` - TypeScript quality skill, tsc hooks

Note: LSP code navigation is built into Claude Code and does not require plugin configuration.

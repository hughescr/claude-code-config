# TypeScript Plugin

TypeScript-specific development tools for Claude Code.

## Skills

- **typescript-quality**: TypeScript-specific quality standards (type checking, strict mode, TSDoc)

## Hooks

- **block-tsc-with-files**: Prevents running `tsc` with individual file arguments (TypeScript needs full project context)

## Usage

This plugin is automatically loaded for TypeScript projects (detected via `tsconfig.json` or typescript in package.json). It builds on:
- **generic-dev**: Symbol editing, documentation tools
- **javascript**: npm packages, Bun runtime, LSP

The typescript-language-server (provided by javascript plugin) handles TypeScript files.

## Plugin Stack

For TypeScript projects, plugins are loaded in order:
1. `generic-dev` - DevTools MCP (symbol editing, docs, security)
2. `javascript` - nodejs-packages MCP, LSP, Bun runtime skill
3. `typescript` - TypeScript quality skill, tsc hooks

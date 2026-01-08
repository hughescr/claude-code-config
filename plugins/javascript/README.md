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

## Usage

This plugin is automatically loaded for projects with `package.json`. It builds on the generic-dev plugin which provides symbol editing and documentation tools.

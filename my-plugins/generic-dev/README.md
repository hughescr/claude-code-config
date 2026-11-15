# Generic Development Plugin

Generic development tools for any coding project using Claude Code.

## Agents

| Agent | Model | Description |
|-------|-------|-------------|
| **feature-developer** | sonnet | Feature implementation with symbol-based editing |
| **debugger-optimizer** | sonnet | Debugging and performance optimization |
| **documentation-platform** | sonnet | Technical documentation creation |

## Skills

- **development-workflow**: Generic development patterns and symbol-based editing

## Injected Coding Instructions

`hooks/inject-coding.sh` injects `instructions/CODING.md` (code search guidance: `ast-grep` for code shape, LSP for definitions and references) into the main session at `SessionStart` and into every sub-agent at `SubagentStart`. Edit that file to change what coding sessions are told. Tests: `bash tests/inject-coding.test.sh`.

## Built-in LSP Tools

Code navigation is handled via Claude Code's built-in LSP integration:

- `goToDefinition` - Jump to where a symbol is defined
- `findReferences` - Find all references to a symbol
- `hover` - Get documentation and type info for a symbol
- `documentSymbol` - List all symbols in a document
- `workspaceSymbol` - Search for symbols across the workspace
- `goToImplementation` - Find implementations of interfaces/abstract methods
- `incomingCalls` - Find functions that call a given function
- `outgoingCalls` - Find functions called by a given function

## MCP Tools (via DevTools)

- Symbol editing: `insert_before_symbol`, `insert_after_symbol`, `replace_symbol_body`, `rename_symbol`
- Documentation: `resolve-library-id`, `query-docs`
- Security: `get-github-advisory`, `get-package-advisories`, `search-github-advisories`

## Usage

This plugin is automatically loaded for JavaScript and TypeScript projects. For other languages, add `generic-dev` to your `.claude-mixins` file or `CLAUDE_MIXINS` environment variable.

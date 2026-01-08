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

## MCP Tools (via DevTools)

- Symbol editing: `find_symbol`, `get_symbols_overview`, `insert_before_symbol`, `insert_after_symbol`, `replace_symbol_body`, `rename_symbol`, `find_referencing_symbols`
- Documentation: `resolve-library-id`, `query-docs`
- Security: `get-github-advisory`, `get-package-advisories`, `search-github-advisories`

## Usage

This plugin is automatically loaded for JavaScript and TypeScript projects. For other languages, add `generic-dev` to your `.claude-mixins` file or `CLAUDE_MIXINS` environment variable.

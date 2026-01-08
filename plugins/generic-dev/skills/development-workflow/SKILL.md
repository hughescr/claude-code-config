---
name: development-workflow
description: This skill should be used when the user asks about "development workflow", "quality workflow", "symbol-based editing", "find symbol", "replace symbol body", "rename across codebase", "LSP navigation", "get symbols overview", "before making changes", "after making changes", or needs language-agnostic code editing and quality patterns. Covers MCP symbol tools and generic development best practices.
---

# Development Workflow Standards

## Symbol-Based Editing

When working with LSP-supported languages (TypeScript, JavaScript, Python, Go, Rust, Java, C++, etc.), prefer symbol-based editing:

### Example Workflow (Conceptual)

When modifying a function in a file:
1. `get_symbols_overview` - See file structure
2. `find_symbol("calculateTotal")` - Get symbol location
3. `replace_symbol_body` - Update the function implementation

*Note: These represent MCP tool calls - invoke them through your MCP client.*

### Available MCP Tools

**Navigation:**
- `find_symbol` - Locate symbols by name pattern
- `get_symbols_overview` - Get high-level file structure
- `find_referencing_symbols` - Find all references to a symbol

**Modification:**
- `insert_before_symbol` - Insert code before a symbol definition
- `insert_after_symbol` - Insert code after a symbol definition
- `replace_symbol_body` - Replace entire symbol body
- `rename_symbol` - Rename symbol across codebase

**When to use symbol-based editing:**
- Adding new functions, classes, methods
- Modifying existing function bodies
- Want to preserve file organization

**When to use Edit tool instead:**
- Files without LSP support (JSON, markdown, config files)
- Complex multi-line string replacements
- Precise line-by-line edits needed

## Quality Workflow

### Before Making Changes
1. Read and understand existing code patterns
2. Use `get_symbols_overview` to understand file structure
3. Run the project's lint commands to verify current state
4. If the project requires compilation (Go, Rust, C++, Java, etc.), run the build command

### After Making Changes
1. Run appropriate linting tools for the language
2. Run the project's test suite
3. Verify no new errors introduced
4. Follow project's code style conventions

## Research Tools

Use documentation tools to understand libraries:
- `resolve-library-id` - Find library documentation IDs
- `query-docs` - Get documentation for a library

## Language-Specific Standards

This skill provides generic workflow patterns. For language-specific commands and conventions, load the appropriate language skill (e.g., bun-runtime for JavaScript/TypeScript).

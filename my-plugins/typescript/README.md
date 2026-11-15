# TypeScript Plugin

TypeScript-specific development tools for Claude Code.

## Skills

- **typescript-quality**: TypeScript-specific quality standards (type checking, strict mode, TSDoc)

## Hooks

- **block-tsc-with-files**: Prevents running `tsc` with individual file arguments (TypeScript needs full project context)
- **ts-lsp-check** (SessionStart): reports the language-server choice, only when it is not the project's own server (see below)

A staged in-process mod form of the tsc guard (`hooks/register.ts`, `hooks/guard.ts`) is not wired yet; activation steps: `my-plugins/MODS-ACTIVATION.md`.

## Language server that follows the project

The plugin declares one LSP server for `.ts .tsx .mts .cts .js .jsx .mjs .cjs` (`lspServers` in `.claude-plugin/plugin.json`). Its `command` is `${CLAUDE_PLUGIN_ROOT}/bin/ts-lsp`, a POSIX sh launcher that picks the server that matches the project's TypeScript and execs it over stdio. Claude Code expands `${CLAUDE_PLUGIN_ROOT}` in an LSP server's `command`, `args`, `env` and `workspaceFolder` (plugins manifest reference, "Environment variables"). The `command` may contain no spaces unless it starts with `/`, which the expanded value does.

This replaces the official `typescript-lsp` plugin, which hardcodes `typescript-language-server --stdio` and starts nothing when that binary is not installed.

### How the launcher chooses

The workspace is `$CLAUDE_PROJECT_DIR`, else the process cwd.

What the project **declares** decides; `node_modules` only supplies the binary for what is declared. The nearest ancestor `package.json` that declares a relevant dependency (`typescript`, an npm alias of `typescript`, `@typescript/native-preview` or `tsrs`, in `dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies`) decides, so a monorepo root that declares TypeScript decides for its sub-packages. The declared package is found the way Node finds it: the nearest `node_modules`, from that `package.json`'s directory upward, that has it, so a hoisted root install works. A binary in `node_modules` that no `package.json` declares (a stale `tsgo` dev build, say) is never used. The first rule that applies wins:

| # | Project declares | Server run | Kind |
|---|---|---|---|
| 1 | `tsrs` | `node_modules/.bin/tsrs --lsp --stdio` | `tsrs-project` |
| 2 | TypeScript 7+: `typescript` with a range whose major is >= 7 (dist-tags such as `latest` count as 7), or any dependency that is an npm alias of `typescript` 7+ (`"@typescript/native": "npm:typescript@7.0.2"`) | that package's own `bin/tsc --lsp --stdio` (`node_modules/NAME/bin/tsc`; plain `typescript` falls back to `.bin/tsc`); the installed `package.json` must report major >= 7 | `tsc7-project` |
| 3 | `@typescript/native-preview` | `node_modules/.bin/tsgo --lsp --stdio` | `tsgo-project` |
| 4 | only `typescript` < 7 (directly or via an alias) | `typescript-language-server --stdio`, from the project's `node_modules/.bin` if present, else from PATH (it finds the workspace's own `typescript`; without one it exits with "Could not find a valid TypeScript installation"). This helper need not be declared: it is tooling, not the compiler | `tsls-project`, `tsls-path` |

Rule 2 beats a co-declared `typescript` < 7: a project that keeps `"typescript": "^6.0.3"` for tools that import the JS API next to `"@typescript/native": "npm:typescript@7.0.2"` gets TypeScript 7's server, because that is what it type-checks with. A range with no readable major (`catalog:`, `workspace:*`) takes the major of the installed version.

If the declared choice is not installed (no `node_modules`, the binary is absent, or the installed version is not 7+), the result is `matched=no` with a hint to install the project's dependencies, and the fallback applies; the launcher does not drop to a lower rule. If no `package.json` up the tree declares anything relevant, `want=unknown` and the fallback applies. `--explain` says which `package.json` and which declaration decided, and mentions an undeclared `tsrs` or `tsgo` it ignored.

**Fallback** (the project lacks what its server needs): `tsrs` on PATH (kind `tsrs-path`), then `tsc` >= 7 on PATH (`tsc7-path`), then `tsgo` on PATH (`tsgo-path`). If none works, the launcher exits 3 with one stderr line and the kind is `none`.

TypeScript 7 (the Go-native compiler) ships its language server in `tsc` itself: `tsc --lsp --stdio`. `tsrs` (the experimental Rust port, npm `tsrs`) ships one too, with the same flags: `tsrs --lsp --stdio` (its own docs write `-stdio`; both spellings work).

`ts-lsp --explain` prints what the launcher would run, without exec:

```sh
sh ~/.claude/my-plugins/typescript/bin/ts-lsp --explain [--workspace DIR]
# kind=tsc7-path  matched=no  want=classic  workspace=...  command=...  reason=...  hint=...
```

`matched=yes` means the server the project's `package.json` declares; `want` is what the project declares (`tsrs`, `ts7`, `classic` or `unknown`); `hint` says what to install in the project to get the matched server.

jq is used to read `package.json` when present. Without it the launcher splits the file at commas and braces and reads every `"key": "string"` line with sed, which handles one-dependency-per-line and minified files, but sees an entry anywhere in the file (a `typescript` pin under `overrides` counts), misreads values containing a comma, brace or escaped quote, and does not notice an unparsable file.

### Startup notice

`hooks/ts-lsp-check.sh` runs the same resolution at `SessionStart` (about 55 ms). It prints nothing when the server the project declares was found. On a fallback, or when no server works, it prints a `systemMessage` (shown to you in the terminal) and the same text as `additionalContext` (so Claude can explain diagnostics that disagree with the project's TypeScript). It always exits 0.

### One server per extension

Claude Code gives each file extension one server: when two enabled plugins claim `.ts`, the first registered handles it and the other is not used (warning in the `/plugin` Errors tab). Disable the official plugin in `settings.json` so it cannot take over `.ts` files if `typescript-language-server` is ever installed globally:

```json
"enabledPlugins": { "typescript-lsp@claude-plugins-official": false }
```

### Tests

`sh tests/ts-lsp.test.sh` (or `bash`): temp workspaces with a `package.json` and fake `node_modules` with stub binaries, under a controlled PATH; covers every branch, aliases, undeclared binaries being ignored, declared-but-not-installed for each kind, the fallbacks, monorepo walk-up, broken or missing `package.json`, with and without jq, under each shell found (sh, dash, ksh, bash), and the hook and manifest wiring.

## Usage

This plugin is automatically loaded for TypeScript projects (detected via `tsconfig.json` or typescript in package.json). It builds on:
- **generic-dev**: Symbol editing, documentation tools
- **javascript**: npm packages, Bun runtime

## Code Navigation (LSP)

Claude Code's `LSP` tool talks to the server above:
- **goToDefinition**: Jump to where a symbol is defined
- **findReferences**: Find all usages of a symbol
- **hover**: Get type information and documentation
- **documentSymbol**: List all symbols in a file
- **workspaceSymbol**: Search for symbols across the project
- **goToImplementation**: Find implementations of interfaces/abstract methods
- **prepareCallHierarchy / incomingCalls / outgoingCalls**: Analyze call relationships

The server starts the first time Claude edits a matching file. Check `/plugin` (Errors tab) or `claude --debug` if it does not.

## Plugin Stack

For TypeScript projects, plugins are loaded in order:
1. `generic-dev` - DevTools MCP (symbol editing, docs, security)
2. `javascript` - nodejs-packages MCP, Bun runtime skill
3. `typescript` - TypeScript quality skill, tsc hooks, language-server launcher

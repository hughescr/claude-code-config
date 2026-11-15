## Code search

Text search (`grep`, the Grep tool) is right for names and strings. Use `ast-grep` (`ast-grep run -p '<pattern>' -l <lang> <path>`) when the question is about code shape: it matches syntax nodes, ignores comments and strings, and prints the whole matching node. Reach for it instead of:

- `grep -A`/`-B`, or `grep` then `sed -n` line ranges, to read a definition and its body (`fn $NAME($$$) { $$$ }`);
- a regex with escaped parentheses to find call sites or member accesses of one shape (`app.get($$$)`, `$OBJ[$KEY]`);
- `grep -v` chains that drop comments, tests, or declarations from the matches;
- hand edits across many call sites (`--rewrite`, then review the diff).

Where a language server is running, use the LSP tool for "where is this defined" and "what references this".

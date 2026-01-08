---
description: Start Hugo development server with optimal flags
allowed-tools: ["Bash", "Read", "Glob"]
---

# Hugo Development Server

Start the Hugo development server with optimal flags for local development and preview.

## Your Task

1. **Detect Hugo configuration location**

   First, check where the Hugo configuration file is located:

   ```bash
   # Check for config files in current directory
   ls hugo.toml config.toml 2>/dev/null

   # Check for config files in hugo/ subdirectory
   ls hugo/hugo.toml hugo/config.toml 2>/dev/null
   ```

   - If `hugo.toml` or `config.toml` exists in current directory: use root config (no -s flag needed)
   - If config exists in `hugo/` subdirectory: use nested config (add `-s hugo` flag)
   - If no config found: inform user that no Hugo configuration was detected

2. **Start the Hugo development server in background**

   Based on the config location, run the appropriate command:

   **For root config (config in current directory):**
   ```bash
   hugo --watch --renderToMemory --minify serve --disableFastRender -D
   ```

   **For nested config (config in hugo/ subdirectory):**
   ```bash
   hugo --watch --renderToMemory --minify serve --disableFastRender -s hugo -D
   ```

   Run this command in the background using `run_in_background: true` so the server continues running.

3. **Wait briefly and check server status**

   After starting, wait a moment and check if the process started successfully. The server typically outputs:
   ```
   Web Server is available at http://localhost:1313/
   ```

   The default URL is usually `http://localhost:1313` but may vary if that port is in use.

4. **Report to user**

   Provide the user with:
   - Confirmation that the Hugo server is running
   - The URL where the site is available (typically http://localhost:1313)
   - Explanation of key flags used:
     - `-D`: Draft posts are included (posts with `draft: true` in frontmatter)
     - `--watch`: Auto-rebuilds on file changes
     - `--renderToMemory`: Faster rebuilds (doesn't write to disk)
     - `--minify`: Minifies output for realistic preview
     - `--disableFastRender`: Full page rebuilds for accuracy
   - How to stop the server: Use Ctrl+C in the terminal, or use `/tasks` to manage background processes

5. **Optional: Open in browser**

   If the user wants to open the site in their browser, you can use Chrome MCP tools:
   - First load the navigate tool with MCPSearch
   - Then use `mcp__claude-in-chrome__navigate` to open the URL

## Notes

- The server runs in the foreground by default; use background mode to continue working
- If port 1313 is busy, Hugo will automatically try the next available port
- Live reload is enabled by default - the browser will refresh when content changes
- For production builds, use `hugo` without the `serve` command

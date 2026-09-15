---
name: hugo-fundamentals
description: Use for general Hugo static site generator questions about project structure, configuration locations and syntax, CLI commands, module mounts, environment-aware configuration, or deprecated configuration features such as .Site.Author and author data in site parameters.
---

# Hugo Fundamentals

## Hugo Project Structure

| Directory | Purpose | Processed? |
|-----------|---------|------------|
| content/ | Markdown content; `_index.md` = section/list page (has `.Pages`), files without underscore = single pages | Rendered |
| layouts/ | HTML templates | - |
| assets/ | SCSS, JS, images for Hugo Pipes | Hugo Pipes (explicit, via `resources.Get`) |
| static/ | Pre-optimized/legacy files | Copied as-is, no processing |
| data/ | Structured data, accessible as `.Site.Data` | - |
| archetypes/ | Content templates for `hugo new` | - |
| resources/ | Generated cache (resized images, compiled SCSS) | Generated |

- **Template precedence**: `layouts/` in the project root is searched before theme layouts of the same path — local always wins over the theme.
- **`assets/` vs `static/`**: files in `assets/` are NOT automatically published — they must be explicitly loaded via `resources.Get` and piped through Hugo Pipes. `static/` files are copied verbatim with no processing.
- **`_index.md` vs `index.md`**: `_index.md` (underscore) = branch bundle / section list page, has `.Pages`. `index.md` (no underscore) = leaf bundle, a single page bundled with its own resources.

## Configuration File Locations

Detection order when working with a project:
1. `hugo.toml` / `config.toml` / `hugo.yaml` / `hugo.json` in the project root (single-file, most common).
2. `hugo/hugo.toml` nested pattern — requires `-s hugo` (or `hugo serve -s hugo`) on every invocation. Check build scripts/CI config for the `-s` flag; a missing one silently builds from the wrong (or no) config.
3. `config/_default/` directory pattern — base config plus per-environment override directories (e.g. `config/production/`, `config/staging/`) merged on top of `_default`.

## Essential Hugo Commands

Flags worth calling out because they change build/serve *reliability*, not just convenience:
- `--disableFastRender`: forces a full rebuild on every change instead of Hugo's partial fast-render — use when fast-render is producing stale or incorrect dev output.
- `--renderToMemory`: serves from memory instead of disk during `hugo serve` — faster, and avoids stale files left on disk from a previous build.
- `--gc`: garbage-collects unused cache files after a production build — prevents `resources/` cache bloat over time.
- `--templateMetrics` (add `--templateMetricsHints`): reports per-template execution time, useful for finding what's actually slow rather than guessing.

## Key Configuration Sections

### Module Mounts (Importing npm Packages)

Mount pattern to bring npm packages into Hugo's asset pipeline:

```toml
[module]
  [[module.mounts]]
    source = "assets"
    target = "assets"

  [[module.mounts]]
    source = "node_modules/bootstrap/scss"
    target = "assets/scss/vendor/bootstrap"
```

Then in templates: `{{ resources.Get "scss/vendor/bootstrap/bootstrap.scss" }}` — the mounted path is addressable exactly as if it physically lived under `assets/`.

### Related Content

`[related]` indices have **tunable weights**, not fixed defaults — `[[related.indices]]` entries (e.g. `tags` weight 100, `categories` weight 50, `date` weight 10) control each index's relative influence on the relatedness score.

### .Site.Author Deprecation (Hugo v0.156.0+)

`.Site.Author` was removed in Hugo v0.156.0. Migrate author data to `[params.author]`:

```toml
# Old (removed)
[author]
  name = "Author Name"

# New — under [params]
[params.author]
  name = "Author Name"
```

- **Site-level**: `{{ .Site.Params.author.name }}` — from `hugo.toml` `[params.author]`
- **Page-level**: `{{ .Params.author }}` — from page frontmatter `author` field

## Environment Detection

- `hugo.IsServer`, `hugo.IsProduction`, and `hugo.Environment` are three **distinct** checks, not synonyms: `hugo.IsServer` is true only under `hugo serve`; `hugo.IsProduction` is true only when `--environment production` or `HUGO_ENVIRONMENT=production`; `hugo.Environment` is the raw environment name string (e.g. `"development"`, `"staging"`, `"production"`). A custom environment like `staging` is neither server nor production.
- Set the environment via `hugo --environment production`, `HUGO_ENVIRONMENT=production hugo`, or implicitly: `hugo serve` sets `development`, a plain `hugo` build sets `production`.

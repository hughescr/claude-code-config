---
name: hugo-templating
description: This skill should be used for Hugo templating concepts — Go template syntax, layouts and layout lookup, partials, shortcodes, and template debugging.
---

# Hugo Templating

## Layout Hierarchy and Lookup Order

Hugo uses a sophisticated lookup system to find the right template for each page.

### The baseof.html Template

The base template (`layouts/_default/baseof.html`) defines the overall HTML structure:

```go-html-template
<!DOCTYPE html>
<html lang="{{ .Site.Language.Lang }}">
<head>
  {{ block "head" . }}
    <meta charset="utf-8">
    <title>{{ .Title }} | {{ .Site.Title }}</title>
    {{ partial "head/meta.html" . }}
    {{ partial "head/css.html" . }}
  {{ end }}
</head>
<body>
  {{ partial "header.html" . }}

  <main>
    {{ block "main" . }}
      {{/* Default content - overridden by specific templates */}}
    {{ end }}
  </main>

  {{ partial "footer.html" . }}
  {{ block "scripts" . }}{{ end }}
</body>
</html>
```

### Layout Lookup Order

Hugo searches for templates in this order (first match wins):

**For a single page (e.g., content/blog/my-post.md):**
1. `layouts/blog/single.html`
2. `layouts/_default/single.html`
3. Theme equivalents

**For a list page (e.g., content/blog/_index.md):**
1. `layouts/blog/list.html`
2. `layouts/_default/list.html`
3. Theme equivalents

**For the home page:**
1. `layouts/index.html`
2. `layouts/home.html`
3. `layouts/_default/index.html`
4. `layouts/_default/home.html`

**With custom layout specified in front matter (`layout: custom`):**
1. `layouts/blog/custom.html`
2. `layouts/_default/custom.html`

### Directory Structure

```
layouts/
  _default/
    baseof.html      # Master template
    single.html      # Default single page
    list.html        # Default list page
    taxonomy.html    # Taxonomy list page (all tags, all categories)
    term.html        # Single term page (posts tagged "hugo")
    # legacy sites: terms.html (all terms) / taxonomy.html (one term); honoured under _default/ only, where the legacy taxonomy.html outranks term.html — modernise by moving both to layouts/ top level
  blog/
    single.html      # Blog post template
    list.html        # Blog listing template
  partials/
    header.html
    footer.html
    components/
      card.html
  shortcodes/
    youtube.html
    figure.html
```

## Block Definitions

- Blocks (`{{ block "name" . }}` in `baseof.html`, overridden via `{{ define "name" }}` in child templates) are how template inheritance works.
- Always pass context explicitly: `{{ block "main" . }}` (correct — passes current context) vs `{{ block "main" }}` (wrong — no context passed).
- Inside a block/define, `.` is whatever context was passed in; `$` always still refers to the original top-level context regardless of nesting — use `{{ $.Site.Title }}` to reach site data from inside a block that received a narrower context (e.g. a single page).

## Partials

- `partial` re-executes on every call; `partialCached` caches its output keyed by whatever extra arguments follow the context — `{{ partialCached "nav.html" . .Section }}` caches once per distinct `.Section` value, `{{ partialCached "global-nav.html" . "global" }}` (a constant key) caches exactly once, globally. Passing only `.` as the effective key defeats caching if the context differs per page.
- A partial can return a value with `{{ return $value }}` and be called as an expression: `{{ $time := partial "get-reading-time.html" . }}`.
- Partials never receive context implicitly — always pass it explicitly: `{{ partial "header.html" . }}`. Pass `.Params.author`, or a `dict`, to hand the partial a narrower or custom context instead of the whole page.

## Shortcodes

- `{{< shortcode >}}` — inner content is **not** processed as Markdown. `{{% shortcode %}}` — inner content **is** run through the Markdown renderer. Picking the wrong delimiter is a common source of literal `**bold**` markers or unrendered raw HTML showing up in output.
- Inside a shortcode template: `.Get "name"` (named param) / `.Get 0` (positional param), `.Inner` (raw inner content, only for paired shortcodes — `.Inner | markdownify` to render it as Markdown), `.Params` (all params as a map), `.Page` (the containing page).

### Shortcodes vs Partials

| Use Shortcodes When | Use Partials When |
|---------------------|-------------------|
| Adding to Markdown content | Building layout templates |
| Content authors need it | Developers use it |
| Per-content customization | Site-wide components |
| Dynamic content embeds | Header, footer, navigation |

## Template Debugging

- `{{ warnf "..." }}` prints a warning during build without stopping it. `{{ errorf "..." }}` prints and **stops the build** — use `errorf` for a required param you want to hard-fail on, `warnf` for anything non-fatal.
- `hugo --templateMetrics` (add `--templateMetricsHints` for suggestions) reports per-template execution time and call count — use it to find which template is actually slow instead of guessing.

---
name: hugo-content-structure
description: This skill should be used when the user mentions "content organization", "frontmatter", "taxonomy", "archetype", "page bundle", "leaf bundle", "branch bundle", "_index.md", "section pages", "draft content", "related content", "hugo new", "content types", "tags", "categories", or any Hugo content structure questions. Provides comprehensive guidance on organizing Hugo content, writing frontmatter, configuring taxonomies, and using archetypes.
---

# Hugo Content Structure

## Content Organization Patterns

### Directory-Based Sections

Hugo organizes content into sections based on directory structure under `content/`:

```
content/
├── _index.md           # Homepage content
├── blog/
│   ├── _index.md       # Blog section list page
│   ├── first-post.md   # Regular page
│   └── second-post/    # Page bundle
│       ├── index.md    # Page content
│       └── hero.jpg    # Page resource
├── docs/
│   ├── _index.md       # Docs section list page
│   ├── getting-started.md
│   └── api-reference/
│       └── _index.md   # Nested section
└── about.md            # Top-level page
```

**Key Principles:**
- Each top-level directory under `content/` creates a section
- URL structure mirrors directory structure: `content/blog/post.md` → `/blog/post/`
- Section names should be lowercase with hyphens

### Section List Pages (_index.md)

Every section needs an `_index.md` file for its list page:

```markdown
---
title: "Blog"
description: "Articles about web development and design"
---

Optional content that appears above the list of pages.
```

**Without `_index.md`:**
- Section list pages still render but have no custom title/description
- Cannot add content above the list
- Missing metadata for SEO

### Page Bundles

Page bundles group a page with its resources (images, files). Two types exist:

#### Leaf Bundles (Single Pages)
```
content/blog/my-post/
├── index.md          # Page content (note: index.md, not _index.md)
├── hero.jpg          # Page resource
├── diagram.png       # Page resource
└── data.json         # Page resource
```

Use leaf bundles when:
- Post has associated images
- Post needs downloadable files
- You want to keep assets with content

#### Branch Bundles (Section Pages)
```
content/docs/
├── _index.md         # Section list page (note: _index.md)
├── intro.md          # Child page
└── advanced/
    └── _index.md     # Nested section
```

**Critical Distinction:**
- `index.md` (no underscore) = Leaf bundle, single page with resources
- `_index.md` (with underscore) = Branch bundle, section list page

### Accessing Page Resources

In templates, access bundle resources:

```go-html-template
{{ $hero := .Resources.GetMatch "hero.*" }}
{{ if $hero }}
  <img src="{{ $hero.RelPermalink }}" alt="{{ .Title }}">
{{ end }}

{{/* All images */}}
{{ range .Resources.ByType "image" }}
  <img src="{{ .RelPermalink }}">
{{ end }}
```

## Frontmatter Fields and Schemas

### Required Fields

Every content file needs at minimum:

```yaml
---
title: "My Page Title"
date: 2026-01-07T10:00:00-08:00
---
```

**Date Format:** Always use RFC3339 with timezone. Hugo parses dates strictly.

### Common Fields

Required: `title`, `date` (RFC3339 with timezone — Hugo parses strictly). Everything else is optional.

- `draft: true` hides the page from `hugo` (production) builds; visible only with `hugo -D`/`--buildDrafts` or `hugo server -D`.
- A future `date` hides the page too, but by a **separate** mechanism from `draft` — needs `hugo -F`/`--buildFuture` to include, independent of the draft flag.
- `lastmod` is independent of `date`: it drives "last modified" in sitemap/RSS-style output only, and has no effect on build inclusion.
- Other optional fields (`description`, `summary`, `image`, `tags`/`categories`, `author`, `weight`, `slug`, `aliases`) carry no build-inclusion semantics — they're metadata or affect templates/URLs only.

### Custom Fields via Params

Add any custom fields; access them via `.Params`:

```yaml
---
title: "Product Review"
params:
  rating: 4.5
  price: 299
  featured: true
---
```

Access in templates:

```go-html-template
{{ with .Params.rating }}Rating: {{ . }}/5{{ end }}
```

### Type and Layout Fields

Control template selection:

```yaml
---
title: "About Us"
type: "info"      # Use layouts/info/ templates
layout: "about"   # Specifically use about.html template
---
```

Template lookup order with `type: "info"` and `layout: "about"`:
1. `layouts/info/about.html`
2. `layouts/info/single.html`
3. `layouts/_default/about.html`
4. `layouts/_default/single.html`

## Taxonomy Configuration and Usage

### Built-in Taxonomies

Hugo includes `tags` and `categories` by default. Use them in frontmatter:

```yaml
---
title: "Learning Go"
tags: ["golang", "programming", "backend"]
categories: ["tutorials"]
---
```

### Custom Taxonomies

Config shape in `hugo.toml` — `singular = "plural"`:

```toml
[taxonomies]
  tag = "tags"
  category = "categories"
  series = "series"
  author = "authors"
  show = "shows"
```

Use the **plural** key in frontmatter (e.g. `series: ["web-development-fundamentals"]`).

### Taxonomy Templates

- `taxonomy.html` = list of all terms for a taxonomy (e.g. all tags); `term.html` = pages carrying one specific term (e.g. posts tagged "hugo"). The names read backwards from what you'd guess, so it's easy to put logic in the wrong one.
- **Legacy naming**: in older Hugo versions these two were swapped — `terms.html` was the all-terms list (today's `taxonomy.html`), and `taxonomy.html` was the single-term page (today's `term.html`). If an older theme has either filename, verify which behavior it implements rather than trusting the name. The legacy swapped names are honoured only as `_default/` fallbacks. A per-taxonomy directory (e.g. `layouts/series/`) must use the canonical `taxonomy.html` (all terms) and `term.html` (one term) — a `layouts/series/taxonomy.html` intended as the term page is ignored for that kind and the page silently falls through to `_default/taxonomy.html` (observed on Hugo v0.166).
- `.GetTerms "tags"` on a page returns that page's terms for a taxonomy; `.Site.Taxonomies.tags` gives the site-wide taxonomy map, with `.Count` per term.

### Listing Taxonomy Terms in Templates

Display tags/categories on any page:

```go-html-template
{{/* On a single page */}}
{{ with .GetTerms "tags" }}
  <div class="tags">
    {{ range . }}
      <a href="{{ .RelPermalink }}">{{ .LinkTitle }}</a>
    {{ end }}
  </div>
{{ end }}

{{/* All site tags */}}
{{ range .Site.Taxonomies.tags }}
  <a href="{{ .Page.RelPermalink }}">{{ .Page.Title }} ({{ .Count }})</a>
{{ end }}
```

## Archetype Templates

- `archetypes/default.md` is the fallback; `archetypes/<type>.md` (e.g. `blog.md`) applies to `hugo new <type>/...`.
- A directory archetype (`archetypes/review/index.md`) is used for page-bundle creation: `hugo new review/product-name` creates a bundle, not a single file.
- `hugo new --kind blog posts/special-post.md` explicitly selects an archetype regardless of path, overriding path-based type inference.
- Archetype template vars: `{{ .Date }}`, `{{ .File.ContentBaseName }}`, `{{ .File.Dir }}`, `{{ .Site.Title }}`.

## Draft and Future Content

### Draft Content Workflow

Mark content as draft during development:

```yaml
---
title: "Work in Progress"
date: 2026-01-07T10:00:00-08:00
draft: true
---
```

**Build Behavior:**
- `hugo` - Excludes drafts (production)
- `hugo -D` or `hugo --buildDrafts` - Includes drafts
- `hugo server -D` - Local development with drafts

### Future-Dated Content

Content with dates in the future is hidden by default:

```yaml
---
title: "Scheduled Post"
date: 2026-02-01T09:00:00-08:00
---
```

**Build Behavior:**
- `hugo` - Excludes future content
- `hugo -F` or `hugo --buildFuture` - Includes future content
- Useful for scheduling posts

### Publishing Workflow

1. Create with draft: `hugo new blog/new-post.md` (draft: true from archetype)
2. Write and preview: `hugo server -D`
3. Publish: Remove `draft: true` or set `draft: false`
4. Build: `hugo`

## Related Content Configuration

- `[related]` indices (`[[related.indices]]`) have **tunable weights**, not fixed defaults — each index's `weight` controls its relative influence on the relatedness score; `threshold` (0-100, minimum score to count as related) and `includeNewer` (include pages newer than the current one) are likewise tunable.
- Use `.Site.RegularPages.Related .` in templates (typically piped through `first N`) to get related pages for the current page.
- Add a `keywords` frontmatter field for finer-grained matching beyond the built-in taxonomy indices.

## Content Best Practices

### Image Handling

**Always use shortcodes or partials for images:**

```markdown
{{</* figure src="hero.jpg" alt="Description" */>}}
```

**Never use raw markdown images:**
```markdown
![Description](hero.jpg)  <!-- Avoid: no processing, no responsive images -->
```

### Taxonomy Consistency

Before creating new tags:
1. Check existing tags: List at `/tags/`
2. Use consistent casing: `web-development` not `Web Development`
3. Prefer specific over generic: `hugo-templates` over `templates`
4. Check for similar tags to avoid duplicates

### Frontmatter Schema Consistency

Maintain consistent schemas per content type. Document in archetypes:

```yaml
# Blog posts always have:
title: ""
date:
description: ""
tags: []
image: ""

# Reviews always have:
title: ""
date:
rating:      # 1-5
pros: []
cons: []
verdict: ""
```

### Content Organization Tips

1. **Flat vs nested:** Prefer flat structure unless you have clear hierarchy
2. **Naming:** Use lowercase, hyphenated slugs: `my-great-post/`
3. **Dates in filenames:** Optional but helps sorting: `2026-01-07-post-title/`
4. **Index pages:** Always create `_index.md` for sections you want to customize
5. **Headless bundles:** Use `headless: true` for content used only as data

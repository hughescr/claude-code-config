# Hugo Plugin for Claude Code

A comprehensive plugin for Hugo static site development, providing specialized agents, skills, commands, and hooks for efficient Hugo project workflows.

## Purpose

This plugin provides Claude Code with deep knowledge of Hugo static site generator patterns, including:

- Go template syntax and layout hierarchy
- Content organization and frontmatter management
- Asset pipeline (SCSS, JavaScript, images via Hugo Pipes)
- AWS deployment via Serverless Framework (S3 + CloudFront)
- JavaScript testing with bun and happy-dom

## Auto-Loading

This plugin automatically loads via `claude-smart.sh` when a Hugo project is detected:

- `hugo.toml` in project root
- `hugo/hugo.toml` in subdirectory
- `config.toml` in project root
- `config/config.toml` in subdirectory

## Complements JavaScript Plugin

When both Hugo and JavaScript plugins load (common for Hugo projects with `package.json`), this plugin provides Hugo-specific corrections:

- **Asset Pipeline**: Hugo projects DO have a build step via Hugo Pipes, unlike pure client-side JS projects
- **Testing**: Hugo client-side JS requires DOM mocking with happy-dom since it interacts with the browser

---

## Components

### Agents (4)

| Agent | Model | Color | Purpose |
|-------|-------|-------|---------|
| `hugo-template-developer` | sonnet | green | Go templates, layouts, partials, shortcodes |
| `hugo-content-manager` | sonnet | cyan | Content creation, frontmatter, taxonomies, archetypes |
| `hugo-asset-specialist` | sonnet | yellow | SCSS, JavaScript, images, Hugo Pipes, fingerprinting |
| `hugo-deployment` | haiku | magenta | Local preview, builds, AWS deployment via CI |

### Skills (6)

| Skill | Triggers |
|-------|----------|
| `hugo-fundamentals` | hugo basics, hugo config, project structure, hugo commands |
| `hugo-templating` | go template, partial, shortcode, layout, template syntax |
| `hugo-content-structure` | content organization, frontmatter, taxonomy, archetype |
| `hugo-asset-pipeline` | scss, css, javascript, images, fingerprint, hugo pipes |
| `hugo-deployment-aws` | deploy, serverless, cloudfront, s3, github actions, ci/cd |
| `hugo-testing` | test javascript, bun test, unit test, happy-dom |

### Commands (2)

| Command | Description |
|---------|-------------|
| `/hugo-preview` | Start Hugo development server with optimal flags |
| `/hugo-build` | Build Hugo site for production with validation |

### Hooks (1)

| Hook | Event | Purpose |
|------|-------|---------|
| `block-serverless-deploy` | PreToolUse | Prevents manual `serverless deploy` - all deployments must go through GitHub CI |

---

## Agent Details

### hugo-template-developer

Handles all Go template syntax, layout hierarchy, and component development:

- Template syntax (`{{ }}`, `range`, `with`, `if`, `partial`)
- Layout hierarchy (`baseof.html`, `_default`, content-type layouts)
- Partial creation and organization
- Shortcode development
- Hugo functions and variables (`.Page`, `.Site`, `.Params`)

### hugo-content-manager

Manages content creation and organization:

- Content files (`index.md` for page bundles, `_index.md` for sections)
- Frontmatter schema adherence
- Taxonomy management (tags, categories, custom)
- Archetype templates
- Draft/future content handling

### hugo-asset-specialist

Handles all asset processing via Hugo Pipes:

- SCSS/CSS architecture
- JavaScript bundling
- Hugo module mounts for npm packages
- Image processing (resize, WebP, fingerprinting)
- Development vs production asset handling

### hugo-deployment

Manages local development and deployment workflows:

- Local server (`hugo serve` with appropriate flags)
- Build commands and validation
- AWS architecture (S3, CloudFront, Route53)
- GitHub Actions CI/CD pipeline

**Critical Rule**: Never runs `serverless deploy` manually - all deployments go through GitHub CI via push to develop branch.

---

## Directory Structure

```
~/.claude/plugins/hugo/
├── .claude-plugin/
│   └── plugin.json
├── README.md
├── agents/
│   ├── hugo-template-developer.md
│   ├── hugo-content-manager.md
│   ├── hugo-asset-specialist.md
│   └── hugo-deployment.md
├── commands/
│   ├── hugo-preview.md
│   └── hugo-build.md
├── hooks/
│   ├── hooks.json
│   └── block-serverless-deploy.sh
└── skills/
    ├── hugo-fundamentals/
    │   └── SKILL.md
    ├── hugo-templating/
    │   └── SKILL.md
    ├── hugo-content-structure/
    │   └── SKILL.md
    ├── hugo-asset-pipeline/
    │   └── SKILL.md
    ├── hugo-deployment-aws/
    │   └── SKILL.md
    └── hugo-testing/
        └── SKILL.md
```

---

## Usage Notes

- Project-specific details (custom shortcodes, frontmatter schemas) should remain in project `.claude/` folders
- This plugin provides generic Hugo patterns applicable to any Hugo project
- Both config locations (root and nested `hugo/`) are supported
- Chrome MCP tools are available for ad-hoc browser verification during development

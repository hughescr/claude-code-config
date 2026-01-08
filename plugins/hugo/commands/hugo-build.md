---
description: Build Hugo site for production with validation
allowed-tools: ["Bash", "Read", "Glob"]
---

# Hugo Production Build

Build the Hugo site for production with full validation and minification.

## Step 1: Detect Hugo Configuration Location

First, determine where the Hugo configuration is located.

Check for configuration files in this order:
1. Check if `hugo.toml` or `config.toml` exists in the current directory (root config)
2. Check if `hugo/hugo.toml` or `hugo/config.toml` exists (nested config)

```bash
# Check root config
ls hugo.toml config.toml 2>/dev/null

# Check nested config
ls hugo/hugo.toml hugo/config.toml 2>/dev/null
```

Based on findings:
- **Root config**: Hugo commands run without `-s` flag
- **Nested config**: Hugo commands need `-s hugo` flag

## Step 2: Run Content Validation

Validate all content before building. This catches issues like missing front matter, broken references, or draft content.

```bash
# For root config:
hugo list all

# For nested config:
hugo -s hugo list all
```

Review the output for:
- Warnings about missing fields
- Draft content that may need attention
- Future-dated posts
- Expired content

Report any warnings or errors to the user before proceeding.

## Step 3: Build Site with Minification

Run the production build with minification enabled for optimal output size.

```bash
# For root config:
hugo --minify

# For nested config:
hugo -s hugo --minify
```

## Step 4: Report Build Results

After the build completes, report:

1. **Pages generated**: Extract from Hugo output (e.g., "Built in 234 ms")
2. **Build time**: Total time to build
3. **Output directory**: Typically `public/` or `src/` depending on config
4. **File statistics**: Run a quick count

```bash
# For root config output (adjust path based on config):
find public -type f | wc -l
du -sh public

# For nested config:
find hugo/public -type f | wc -l
du -sh hugo/public
```

## Step 5: Deployment Reminder

After reporting results, always remind the user:

> **Note**: This is a local build for inspection purposes.
>
> To deploy:
> ```bash
> git add . && git commit -m "Build site" && git push origin develop
> ```
>
> CI/CD handles the actual deployment automatically. **Never run serverless deploy manually.**

## Error Handling

If the build fails:
1. Report the specific error message
2. Check for common issues:
   - Missing dependencies (`hugo mod get`)
   - Invalid front matter in content files
   - Broken shortcodes or partial references
   - Theme configuration issues
3. Suggest specific fixes based on the error type

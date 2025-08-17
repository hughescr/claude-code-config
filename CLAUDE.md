## CRITICAL: Agent Delegation Strategy

**ALWAYS delegate work to specialized agents via the Task tool instead of doing it yourself.**

This is MANDATORY for efficient operation:
- Each specialized agent gets fresh context window
- Prevents context exhaustion on complex tasks
- Enables the agent fleet to work longer and more thoroughly
- You should be orchestrating, not implementing

**Use Task tool with appropriate subagent_type for specialized agents.**

**When to delegate:** ANY task a specialized agent can handle

**Exception:** Only do direct work for simple, single-step tasks that take <30 seconds.

## Development Best Practices

- Always use `bunx` instead of `npx`; always use `bun` in general instead of `npm`.

## Available CLI Tools

### Core Development
- `jq` - JSON processing
- `httpie` - HTTP client (`http GET url`)
- `gh` - GitHub CLI
- `bat` - Syntax-highlighted file viewer
- `diff-so-fancy` - Better git diffs
- `hyperfine` - Benchmarking
- `tree` - Directory structure display
- `entr` - Run commands on file change
- `watch` - Execute commands periodically
- `ag` - The Silver Searcher (fast text search)

### AWS/Cloud
- `awscli` - AWS management
- `aws-ddbsh` - DynamoDB shell

### Data Processing
- `csvkit` - CSV tools (csvcut, csvjoin, csvstat)
- `parallel` - Parallel execution

### Media/Image
- `imagemagick` - Image manipulation
- `optipng`, `mozjpeg`, `webp` - Image optimization
- `svgo` - SVG optimization
- `ffmpeg` - Video/audio processing

### Recommended to Install
- `fd` - Fast file finder
- `fzf` - Fuzzy finder
- `miller` - Data processing
- `xsv` - Fast CSV toolkit
- `yq` - YAML processor
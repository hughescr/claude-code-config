## CRITICAL: ORCHESTRATOR-ONLY MODE

**You are STRICTLY an orchestrator. NEVER do implementation work yourself.**

### Core Mandate
- **NEVER** write code, edit files, or implement solutions directly
- **NEVER** make commits, run builds, or execute implementation commands
- **ALWAYS** delegate ALL work to specialized sub-agents via the Task tool
- Your ONLY job is to: understand requests, plan, delegate, validate, and report

### Why This Matters
- Preserves your context window for orchestration decisions
- Each sub-agent gets fresh context for thorough work
- Enables longer, more complex task completion
- Prevents context exhaustion on multi-step projects

### What You CAN Do Directly
- Read files to understand context (Read, Glob, Grep tools)
- Ask clarifying questions (AskUserQuestion)
- Plan and coordinate work
- Review sub-agent outputs
- Summarize results for the user

### What You MUST Delegate
- ALL code writing and editing
- ALL file creation and modification
- ALL testing and validation work
- ALL documentation updates
- ALL git operations (commits, branches, PRs)

**Use Task tool with appropriate subagent_type for ALL implementation work.**

---

## Task Planning Framework (OODA-Inspired)

When handling complex tasks, follow this structured approach:

### 1. OBSERVE
- Analyze existing codebase structure
- Review tests, documentation, and logs
- Identify affected components
- Check monitoring/metrics if available

### 2. ORIENT
- Map requirements to architecture layers
- Identify relevant patterns and conventions
- Assess technical constraints
- Consider security/performance implications

### 3. DECIDE
- Break down into atomic tasks
- Identify dependencies (parallel vs sequential)
- Assign to appropriate sub-agents
- Define acceptance criteria per task
- Set quality gates

### 4. ACT
- Delegate to specialized agents
- Monitor progress via tmux/outputs
- Validate against acceptance criteria
- Iterate based on feedback

## Task Dependency Management

For complex multi-step tasks, use lightweight DAG notation:
- `→` Sequential dependency
- `||` Parallel execution possible
- `[agent-name]` Task owner
- `✓` Acceptance criteria

Example:
```
1. [data-architect] Design schema →
2. [feature-developer] Implement API ||
3. [documentation-platform] Update docs →
4. [quality-guardian] Review & test
```

## Quality Gates (Pre-merge Checklist)

Before completing any significant change:
- ✓ Codex validation completed (architecture/approach)
- ✓ Tests passing (unit, integration, e2e)
- ✓ TypeScript/linting clean
- ✓ Security scan complete
- ✓ Documentation updated
- ✓ Performance validated
- ✓ Code reviewed

## Risk Assessment

For each significant change, consider:
- **Security**: Authentication, authorization, data exposure
- **Performance**: Query complexity, memory usage, API calls
- **Data**: Integrity, migrations, backwards compatibility
- **Operations**: Deployment risks, rollback plan

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
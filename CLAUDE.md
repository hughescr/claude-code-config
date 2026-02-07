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

## CRITICAL: SUB-AGENT FILE RESTRICTIONS

**This section applies to ALL sub-agents receiving delegated tasks.**

### FORBIDDEN: Temporary Planning Files

**NEVER use Bash to create planning, tracking, or organizational files.**

These patterns are STRICTLY PROHIBITED:
```bash
# ALL OF THESE ARE FORBIDDEN:
cat > /tmp/plan.md << EOF
cat > /tmp/claude/task-breakdown.md << 'EOF'
echo "## Plan" > /tmp/planning.md
cat << EOF > /tmp/approach.md
printf "..." > /tmp/notes.md
```

### Why This Rule Exists
- Temporary files waste context on file I/O instead of actual work
- Task management tools (TaskCreate/TaskList/TaskUpdate) provide structured, visible task tracking
- Planning files get lost and create clutter
- The orchestrator cannot see your temp files

### The ONLY Correct Approach
Use **Task Management Tools** for ALL task tracking and planning:
```
TaskCreate({
  subject: "Analyze existing code",
  description: "Review the codebase structure",
  activeForm: "Analyzing existing code"
})

TaskUpdate({
  taskId: "1",
  status: "in_progress"
})
```

### Enforcement
If you find yourself about to write `cat >` or any heredoc for a .md/.txt planning file, STOP. Use TaskCreate instead.

---

## CRITICAL: Sub-Agent Prompt Requirements

**Every Task tool invocation MUST include the critical restrictions preamble.**

### Standard Preamble (MANDATORY)
Include this at the start of every sub-agent prompt:

```
CRITICAL RESTRICTIONS:
- Use TaskCreate/TaskUpdate for task tracking, never temp files.
- For git commit, use dangerouslyDisableSandbox: true for GPG signing.

YOUR TASK:
[actual task details here]
```

### Why This Is Mandatory
- Sub-agents do NOT inherit CLAUDE.md instructions
- Sub-agents get only what you pass in the `prompt` parameter
- Without explicit instruction, sub-agents may violate critical rules
- This preamble enforces consistency

---

## Git Operations & Sandbox Mode

**`git commit` MUST run outside the sandbox for GPG signing to work.**

When executing git commits, always use `dangerouslyDisableSandbox: true`:

```bash
# This will FAIL in sandbox mode (GPG signing blocked):
git commit -m "message"

# Correct approach - disable sandbox for git commit:
Bash({ command: "git commit -m '...'", dangerouslyDisableSandbox: true })
```

Other git operations (status, diff, log, add) work fine in sandbox mode - only `commit` requires the override due to GPG access requirements.

---

## Git Submodule Management

**Some plugins in ~/.claude are managed as git submodules pointing to external repositories.**

### What This Means
- Submodules are external git repos embedded within this repo
- They track specific commits from upstream sources
- Updates must be pulled explicitly (they don't auto-update)
- More submodules may be added over time as the plugin ecosystem grows

### Maintenance Cadence
Claude should periodically check if submodules are out of date:
- **Weekly**: When starting a new session, consider checking for updates
- **On plugin work**: Always check before modifying or debugging plugin-related code
- **After major releases**: Upstream plugins may have important updates

### Commands

```bash
# Check for available updates (fetch without applying)
git -C ~/.claude submodule update --remote --dry-run

# Actually update all submodules to latest
git -C ~/.claude submodule update --remote

# Commit the submodule updates
git -C ~/.claude add -A
git -C ~/.claude commit -m "Update submodules to latest"
```

### Notes
- The `--dry-run` flag shows what would change without modifying anything
- After updating, review the changes before committing
- Submodule updates may introduce breaking changes - test after updating
- If a submodule update causes issues, you can revert with `git checkout -- <submodule-path>`

---

## Task Framework: Consensus-OODA (Grove-Inspired)

**Core Principle**: The orchestrator ratifies good decisions from paired sub-agents—never decides alone.

### Consensus Pattern

```
┌─────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR (Grove-style Executive)                       │
│  - Defines values/criteria for the phase                    │
│  - Delegates to agent pair                                  │
│  - Facilitates message-passing between agents               │
│  - Ratifies consensus (or sends back for more iteration)    │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────┐         ┌─────────────────────┐
│  AGENT A            │ ◄─────► │  AGENT B            │
│  (Primary focus)    │         │  (Complementary)    │
└─────────────────────┘         └─────────────────────┘
         │                                    │
         └────────── CONSENSUS ───────────────┘
                         │
                         ▼
              [Orchestrator Ratifies]
```

### Generic Orchestrator Script (All Phases)

1. **Delegate**: Launch 2 agents with complementary focus areas
2. **Facilitate**: Share A's output with B: "Do you agree? What would you add?"
3. **Iterate**: Share B's feedback with A: "Address this. Consensus reached?"
4. **Ratify**: When both explicitly agree, validate against project values
5. **Enforce**: If inadequate, send agents back to iterate

### OODA Phase Definitions

| Phase | Agent A Focus | Agent B Focus |
|-------|---------------|---------------|
| **OBSERVE** | Direct investigation (files, functions, flows) | Broad patterns (conventions, related systems) |
| **ORIENT** | Propose primary approach | Challenge, validate, propose alternatives |
| **DECIDE** | Task breakdown with acceptance criteria | Validate completeness, identify gaps |
| **ACT** | Implement the task | Review against criteria, suggest corrections |

### Consensus Signals
Agents state: "Consensus reached—I endorse this" or "Not yet—need resolution on [X]"

### Fast Path (Single-Agent)
Use single-agent for: trivial tasks, pure info gathering, user requests speed.
Use pairs for: design decisions, committed code, multi-file changes, security/performance.

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

## Task Tracking Guidelines

### For Orchestrators
- Use the **Plan agent** (`subagent_type: Plan`) for complex multi-step orchestration
- The Plan agent helps break down work and coordinate sub-agents
- Orchestrators delegate implementation; Plan agent helps structure that delegation

### For Sub-Agents

**⚠️ CRITICAL RULES - VIOLATIONS WILL CAUSE TASK FAILURE ⚠️**

When a sub-agent receives a delegated task:

**MANDATORY - Use Task Management Tools (TaskCreate/TaskList/TaskUpdate):**
- Create todos for each sub-task you identify
- Mark `in_progress` as you begin each task
- Mark `completed` when finished
- Update the todo list as your understanding evolves

**STRICTLY FORBIDDEN - Never Do These:**
- ❌ `cat > /tmp/anything.md << EOF` - NEVER
- ❌ `cat > /tmp/claude/plan.md << 'EOF'` - NEVER
- ❌ Any heredoc redirecting to a file for planning - NEVER
- ❌ `echo "..." > /tmp/notes.txt` - NEVER
- ❌ Creating ANY markdown/text files for task organization - NEVER

**Why This Matters:**
1. Temp files waste tokens on file I/O
2. The orchestrator cannot see your temp files
3. Task tools are visible and structured
4. Planning files create noise and get abandoned

**If you're tempted to write a planning file, use TaskCreate instead. No exceptions.**

## Quality Mindset

Before completing any significant change, ensure:
- ✓ Architecture/approach validated (use Codex skill from `plugins/codex` for complex decisions)
- ✓ Tests passing
- ✓ Linting clean
- ✓ Security considered
- ✓ Documentation updated
- ✓ Code reviewed

*Domain-specific quality gates (TypeScript strict mode, framework rules, etc.) are defined in specialized agents.*

## Risk Assessment

For each significant change, consider:
- **Security**: Authentication, authorization, data exposure
- **Performance**: Query complexity, memory usage, API calls
- **Data**: Integrity, migrations, backwards compatibility
- **Operations**: Deployment risks, rollback plan

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
# Claude Code Configuration

This repository contains my Claude Code configuration, including standard MCP servers I always use and settings.json which enables permissions for most of those tools by default.

## Features

- **MCP Servers**: Pre-configured MCP servers for enhanced Claude Code functionality
- **Specialized Agents**: Custom agents optimized for building full stack JavaScript applications using:
  - Bun runtime
  - Opinionated framework choices for modern web development
- **Default Permissions**: Pre-configured settings.json for streamlined tool access

## Specialized Agents

The following specialized agents are available for full stack JavaScript development:

### Development & Implementation
- [**API Documenter**](agents/api-documenter.md) - Creates OpenAPI 3.0 specs from TypeScript Lambda handlers with type-accurate schemas
- [**Backend Architect**](agents/backend-architect.md) - Designs serverless backend architectures, RESTful APIs, Lambda functions, and DynamoDB schemas
- [**UI/UX Designer**](agents/ui-ux-designer.md) - Expert UI/UX designer for interface design and user experience optimization
- [**UI Implementation Expert**](agents/ui-implementation-expert.md) - Implements UI components for Astro/Alpine.js applications using DaisyUI
- [**Data Structure Architect**](agents/data-structure-architect.md) - Designs optimal data structures and database schemas for complex systems
- [**Data Transformation Specialist**](agents/data-transformation-specialist.md) - Expert in ETL pipelines, data mapping, and format conversion

### Testing & Quality
- [**Test Automator**](agents/test-automater.md) - Creates comprehensive test suites (unit/integration/e2e) for TypeScript/Bun projects
- [**Code Reviewer**](agents/code-reviewer.md) - Performs automated quality checks and manual analysis with ESLint and TypeScript diagnostics
- [**Architect Reviewer**](agents/architect-reviewer.md) - Ensures SOLID principles, proper layering, and pattern consistency
- [**Security Specialist**](agents/security-specialist.md) - Defensive security expert for AWS/SST infrastructure and secure coding practices

### Infrastructure & Operations
- [**DevOps Troubleshooter**](agents/devops-troubleshooter.md) - Debug production incidents across AWS infrastructure and SST deployments
- [**Cloud Architect**](agents/cloud-architect.md) - AWS/Azure/GCP infrastructure architect specializing in Terraform IaC
- [**Integration Orchestrator**](agents/integration-orchestrator.md) - Orchestrates multi-system integrations using SST/AWS infrastructure

### Specialized Tools
- [**Browser Automation Specialist**](agents/browser-automation-specialist.md) - Expert in browser automation and web scraping using Playwright/Puppeteer
- [**Website Structure Analyzer**](agents/website-structure-analyzer.md) - Analyzes website architecture, data collection practices, and UI patterns
- [**Debugger**](agents/debugger.md) - Expert debugger for runtime errors, test failures, and build issues
- [**Context Manager**](agents/context-manager.md) - Context optimizer for multi-agent workflows

## Setup

To use these MCP servers by default, set up an alias in your shell configuration:

```bash
alias claude="claude --mcp-config ~/.claude/mcp.json"
```

This ensures that Claude Code will automatically load the MCP configuration whenever you run the `claude` command.

## Contents

- `mcp.json` - MCP server configuration
- `settings.json` - Default permissions and settings for Claude Code tools
- `CLAUDE.md` - Global instructions for all projects
- `agents/` - Specialized agent configurations for full stack JavaScript development
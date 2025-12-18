---
name: Documentation Templates
description: Comprehensive documentation templates, conventions, and style guidelines for creating high-quality technical documentation across all project layers
---

# Documentation Templates

A comprehensive collection of documentation templates, conventions, and best practices for creating professional, accessible, and maintainable technical documentation.

## Table of Contents

- [README Template](#readme-template)
- [TSDoc/JSDoc Conventions](#tsdocjsdoc-conventions)
- [Diátaxis Framework](#diátaxis-framework)
- [CHANGELOG Format](#changelog-format)
- [Architecture Decision Records (ADR)](#architecture-decision-records-adr)
- [Writing Style Guidelines](#writing-style-guidelines)

---

## README Template

Every project should have a comprehensive README.md file. Use this template as a starting point:

```markdown
# Project Name

Brief, compelling description of what this project does and why it exists (1-2 sentences).

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)]()
[![Version](https://img.shields.io/badge/version-1.0.0-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

## Description

A more detailed explanation of the project:
- What problem does it solve?
- What are its key features?
- Who is the target audience?

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Examples](#examples)
- [Contributing](#contributing)
- [Testing](#testing)
- [License](#license)
- [Support](#support)

## Installation

### Prerequisites

List required software, versions, and dependencies:
- Node.js >= 18.0.0
- Bun >= 1.0.0
- PostgreSQL >= 14.0

### Quick Start

```bash
# Clone the repository
git clone https://github.com/username/project-name.git

# Navigate to project directory
cd project-name

# Install dependencies
bun install

# Set up environment variables
cp .env.example .env

# Run database migrations
bun run migrate

# Start development server
bun run dev
```

### Alternative Installation Methods

#### Using npm
```bash
npm install project-name
```

#### Using Docker
```bash
docker pull username/project-name
docker run -p 3000:3000 username/project-name
```

## Usage

### Basic Example

```typescript
import { ProjectName } from 'project-name';

const instance = new ProjectName({
  apiKey: 'your-api-key',
  environment: 'production'
});

const result = await instance.doSomething();
console.log(result);
```

### Common Use Cases

#### Use Case 1: Authentication
```typescript
// Example code for authentication
```

#### Use Case 2: Data Processing
```typescript
// Example code for data processing
```

## API Reference

### Core Methods

#### `methodName(param1, param2)`

Description of what this method does.

**Parameters:**
- `param1` (string): Description of first parameter
- `param2` (number, optional): Description of second parameter. Default: `10`

**Returns:** `Promise<Result>` - Description of return value

**Example:**
```typescript
const result = await instance.methodName('value', 20);
```

**Throws:**
- `ValidationError` - When parameters are invalid
- `NetworkError` - When API request fails

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | - | Your API key (required) |
| `timeout` | number | 5000 | Request timeout in ms |
| `retries` | number | 3 | Number of retry attempts |

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# API Configuration
API_KEY=your_api_key_here
API_URL=https://api.example.com

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# Application
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug
```

### Configuration File

Alternatively, use a configuration file:

```typescript
// config.ts
export const config = {
  api: {
    key: process.env.API_KEY,
    baseUrl: 'https://api.example.com'
  },
  database: {
    url: process.env.DATABASE_URL,
    poolSize: 10
  }
};
```

## Examples

### Example 1: Complete Workflow

```typescript
// Detailed example showing a complete workflow
import { ProjectName } from 'project-name';

async function completeWorkflow() {
  const client = new ProjectName({
    apiKey: process.env.API_KEY
  });

  // Step 1: Initialize
  await client.initialize();

  // Step 2: Process data
  const data = await client.fetchData();

  // Step 3: Transform and save
  const transformed = client.transform(data);
  await client.save(transformed);

  console.log('Workflow completed successfully');
}
```

## Contributing

We welcome contributions! Please follow these guidelines:

### Development Setup

```bash
# Fork and clone the repository
git clone https://github.com/your-username/project-name.git

# Create a feature branch
git checkout -b feature/your-feature-name

# Install dependencies
bun install

# Run tests
bun test

# Run linter
bun run lint
```

### Contribution Guidelines

1. **Code Style**: Follow the existing code style and use ESLint/Prettier
2. **Tests**: Add tests for new features and ensure all tests pass
3. **Documentation**: Update documentation for API changes
4. **Commits**: Use conventional commit messages (see below)
5. **Pull Requests**: Provide clear description of changes

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Example:**
```
feat(auth): add OAuth2 authentication support

Implements OAuth2 flow for third-party authentication.
Adds support for Google and GitHub providers.

Closes #123
```

## Testing

### Running Tests

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run tests with coverage
bun test --coverage

# Run specific test file
bun test src/feature.test.ts
```

### Test Structure

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { FeatureName } from './feature';

describe('FeatureName', () => {
  let instance: FeatureName;

  beforeEach(() => {
    instance = new FeatureName();
  });

  it('should perform expected behavior', () => {
    const result = instance.method();
    expect(result).toBe(expectedValue);
  });
});
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

### Third-Party Licenses

This project uses the following open source packages:
- [Package 1](link) - MIT License
- [Package 2](link) - Apache 2.0 License

## Support

### Getting Help

- **Documentation**: [https://docs.example.com](https://docs.example.com)
- **Issues**: [GitHub Issues](https://github.com/username/project-name/issues)
- **Discussions**: [GitHub Discussions](https://github.com/username/project-name/discussions)
- **Email**: support@example.com

### Reporting Issues

When reporting issues, please include:
- Operating system and version
- Node.js/Bun version
- Project version
- Steps to reproduce
- Expected vs actual behavior
- Relevant code snippets or error messages

### FAQ

**Q: How do I handle authentication errors?**
A: Check that your API key is valid and properly configured...

**Q: Can I use this in production?**
A: Yes, the project is stable and production-ready...

## Acknowledgments

- Thanks to [contributor](link) for their valuable contributions
- Inspired by [project](link)
- Built with [technology](link)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a detailed history of changes.

## Roadmap

- [ ] Feature 1 - Q1 2025
- [ ] Feature 2 - Q2 2025
- [ ] Feature 3 - Q3 2025
```

---

## TSDoc/JSDoc Conventions

### Basic Documentation Structure

```typescript
/**
 * Brief one-line description of the function.
 *
 * More detailed description that explains what the function does,
 * why it exists, and any important implementation details.
 *
 * @param paramName - Description of the parameter
 * @param optionalParam - Description of optional parameter (optional)
 * @returns Description of the return value
 * @throws {ErrorType} Description of when this error is thrown
 * @example
 * ```typescript
 * const result = functionName('value', 42);
 * console.log(result);
 * ```
 *
 * @see {@link RelatedFunction} for related functionality
 * @since 1.2.0
 * @deprecated Use {@link NewFunction} instead
 */
export function functionName(
  paramName: string,
  optionalParam?: number
): ReturnType {
  // Implementation
}
```

### Class Documentation

```typescript
/**
 * Represents a user in the system.
 *
 * This class handles user authentication, authorization, and profile management.
 * It implements the Repository pattern for data persistence.
 *
 * @example
 * ```typescript
 * const user = new User({
 *   email: 'user@example.com',
 *   name: 'John Doe'
 * });
 * await user.save();
 * ```
 *
 * @public
 */
export class User {
  /**
   * The user's unique identifier.
   * @readonly
   */
  public readonly id: string;

  /**
   * The user's email address.
   * Must be unique across the system.
   */
  public email: string;

  /**
   * Creates a new User instance.
   *
   * @param data - The user data
   * @param data.email - User's email address
   * @param data.name - User's full name
   * @throws {ValidationError} If email format is invalid
   */
  constructor(data: UserData) {
    // Implementation
  }

  /**
   * Saves the user to the database.
   *
   * @returns Promise that resolves when save is complete
   * @throws {DatabaseError} If save operation fails
   * @internal
   */
  async save(): Promise<void> {
    // Implementation
  }
}
```

### Interface Documentation

```typescript
/**
 * Configuration options for the API client.
 *
 * @public
 */
export interface ApiConfig {
  /**
   * The API key for authentication.
   * @required
   */
  apiKey: string;

  /**
   * Base URL for API requests.
   * @default 'https://api.example.com'
   */
  baseUrl?: string;

  /**
   * Request timeout in milliseconds.
   * @default 5000
   */
  timeout?: number;

  /**
   * Number of retry attempts for failed requests.
   * @default 3
   * @minimum 0
   * @maximum 10
   */
  retries?: number;
}
```

### Type Documentation

```typescript
/**
 * Possible states for a task.
 *
 * @public
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Result of an asynchronous operation.
 *
 * @typeParam T - The type of the success value
 * @typeParam E - The type of the error value
 *
 * @public
 */
export type Result<T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };
```

### Common TSDoc Tags

| Tag | Purpose | Example |
|-----|---------|---------|
| `@param` | Document parameters | `@param userId - The user's ID` |
| `@returns` | Document return value | `@returns The user object` |
| `@throws` | Document exceptions | `@throws {NotFoundError} If user not found` |
| `@example` | Provide usage example | `@example const x = fn();` |
| `@see` | Reference related items | `@see {@link OtherFunction}` |
| `@since` | Version introduced | `@since 1.0.0` |
| `@deprecated` | Mark as deprecated | `@deprecated Use newFn instead` |
| `@public` | Public API | `@public` |
| `@internal` | Internal use only | `@internal` |
| `@beta` | Beta/experimental | `@beta` |
| `@readonly` | Read-only property | `@readonly` |
| `@default` | Default value | `@default 10` |
| `@typeParam` | Generic type parameter | `@typeParam T - The item type` |

---

## Diátaxis Framework

The Diátaxis framework organizes documentation into four distinct categories based on user needs:

### 1. Tutorials (Learning-Oriented)

**Purpose**: Take users through a learning experience to achieve a specific goal.

**Characteristics:**
- Learning by doing
- Hands-on, step-by-step guide
- Reproducible by any user
- Immediate sense of achievement

**Structure:**
```markdown
# Tutorial: Building Your First API Endpoint

In this tutorial, you'll learn how to create a REST API endpoint
that handles user authentication.

## What You'll Build

By the end of this tutorial, you'll have:
- A working login endpoint
- Password hashing implementation
- JWT token generation

## Prerequisites

- Basic TypeScript knowledge
- Node.js installed
- 30 minutes of time

## Step 1: Set Up the Project

First, create a new directory...

## Step 2: Install Dependencies

Run the following command...

## Step 3: Create the Endpoint

Add the following code...

## What You've Learned

In this tutorial, you:
- Created an authentication endpoint
- Implemented secure password handling
- Generated JWT tokens

## Next Steps

- Try adding password reset functionality
- Explore the [How-To Guide: Add OAuth](...)
```

### 2. How-To Guides (Problem-Oriented)

**Purpose**: Show how to solve a specific problem or accomplish a specific task.

**Characteristics:**
- Practical steps
- Focused on results
- Assumes some knowledge
- Solves a specific problem

**Structure:**
```markdown
# How to Deploy to Production

This guide shows you how to deploy your application to production.

## Prerequisites

- Application tested and ready
- Production environment configured
- Database migrations prepared

## Steps

### 1. Prepare the Build

```bash
bun run build
bun test
```

### 2. Run Database Migrations

```bash
bun run migrate:prod
```

### 3. Deploy the Application

```bash
bun run deploy
```

### 4. Verify Deployment

Check the following:
- [ ] Application is accessible
- [ ] Health check passes
- [ ] Logs show no errors

## Troubleshooting

**Problem**: Deployment fails with "Connection refused"
**Solution**: Check that the database connection string is correct...
```

### 3. Reference (Information-Oriented)

**Purpose**: Provide technical descriptions and specifications.

**Characteristics:**
- Dry and factual
- Complete and accurate
- Structure mirrors code structure
- No explanation of basic concepts

**Structure:**
```markdown
# API Reference

## UserService

### Methods

#### `createUser(data: UserData): Promise<User>`

Creates a new user in the system.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| data | UserData | Yes | User information |
| data.email | string | Yes | User's email |
| data.name | string | Yes | User's full name |
| data.role | Role | No | User role (default: 'user') |

**Returns:** `Promise<User>`

**Throws:**
- `ValidationError` - Invalid input data
- `DuplicateError` - Email already exists

**Example:**
```typescript
const user = await userService.createUser({
  email: 'user@example.com',
  name: 'John Doe'
});
```
```

### 4. Explanation (Understanding-Oriented)

**Purpose**: Provide context, background, and clarify topics.

**Characteristics:**
- Discusses alternatives and opinions
- Explains design decisions
- Provides background and context
- Deepens understanding

**Structure:**
```markdown
# Understanding Authentication Architecture

## Overview

Our authentication system uses JWT tokens with refresh token rotation.
This document explains why we chose this approach and how it works.

## Design Decisions

### Why JWT?

We chose JWT over session-based authentication for several reasons:

1. **Stateless**: No server-side session storage required
2. **Scalable**: Easy to scale horizontally
3. **Mobile-friendly**: Works well with mobile apps

However, JWTs also have drawbacks:
- Cannot be invalidated before expiration
- Larger than session IDs
- Require careful security handling

### Refresh Token Rotation

We implement refresh token rotation to mitigate token theft:

When a refresh token is used, we:
1. Issue a new access token
2. Issue a new refresh token
3. Invalidate the old refresh token

This means if a token is stolen and used, the legitimate user's
next request will fail, alerting them to the breach.

## How It Works

[Detailed technical explanation...]

## Trade-offs

[Discussion of trade-offs made...]

## Alternative Approaches

We considered but rejected:
1. Session-based auth - Not scalable for our needs
2. OAuth only - Too complex for our use case
```

### Choosing the Right Type

| User Need | Documentation Type | Example Question |
|-----------|-------------------|------------------|
| "I want to learn" | Tutorial | "How do I get started?" |
| "I want to accomplish a task" | How-To | "How do I deploy to AWS?" |
| "I need facts" | Reference | "What parameters does this take?" |
| "I want to understand" | Explanation | "Why does it work this way?" |

---

## CHANGELOG Format

Follow the [Keep a Changelog](https://keepachangelog.com/) standard:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- New feature that will be in next release

### Changed
- Changes to existing functionality

### Deprecated
- Features that will be removed in upcoming releases

### Removed
- Features that were removed

### Fixed
- Bug fixes

### Security
- Security-related changes

## [1.2.0] - 2025-01-15

### Added
- User authentication with OAuth2 support (#123)
- Rate limiting middleware for API endpoints (#145)
- Database connection pooling (#156)

### Changed
- Updated dependencies to latest versions (#134)
- Improved error messages for validation failures (#142)
- Refactored user service for better testability (#151)

### Deprecated
- `oldMethod()` function - use `newMethod()` instead (#148)

### Fixed
- Memory leak in WebSocket connections (#139)
- Race condition in parallel database writes (#147)
- Incorrect timezone handling in date parsing (#152)

### Security
- Fixed SQL injection vulnerability in search endpoint (CVE-2025-1234)
- Updated crypto library to patch security flaw (#158)

## [1.1.0] - 2024-12-01

### Added
- Real-time notifications via WebSockets (#101)
- Export data to CSV functionality (#108)

### Changed
- Migrated from Express to Fastify (#95)
- Updated Node.js requirement to >= 18.0.0 (#103)

### Fixed
- Pagination bug in user list endpoint (#99)
- Email validation rejecting valid addresses (#106)

## [1.0.0] - 2024-10-15

### Added
- Initial stable release
- User management (CRUD operations)
- RESTful API with full documentation
- PostgreSQL database integration
- JWT-based authentication
- Comprehensive test suite (95% coverage)
- Docker support

[Unreleased]: https://github.com/username/project/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/username/project/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/username/project/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/username/project/releases/tag/v1.0.0
```

### Change Categories

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security-related changes

### Best Practices

1. **Date Format**: Use ISO 8601 format (YYYY-MM-DD)
2. **Version Links**: Link version numbers to releases/tags
3. **Issue References**: Include issue/PR numbers in parentheses
4. **Grouping**: Group changes by category (Added, Changed, etc.)
5. **Audience**: Write for users, not developers (focus on impact, not implementation)
6. **Security**: Always highlight security fixes prominently

---

## Architecture Decision Records (ADR)

Use the [MADR format](https://adr.github.io/madr/) for recording architectural decisions:

```markdown
# ADR-001: Use PostgreSQL for Primary Database

## Status

Accepted

## Context

We need to choose a database system for storing application data.
The system must support:
- Complex queries with joins
- ACID transactions
- Horizontal scalability
- JSON document storage
- Full-text search capabilities

Our team has experience with both SQL and NoSQL databases.
We expect to handle 10,000+ concurrent users initially, growing to 100,000+.

## Decision Drivers

- **Performance**: Must handle high read/write loads
- **Data Integrity**: ACID compliance required for financial transactions
- **Developer Experience**: Team familiarity and ecosystem support
- **Scalability**: Must scale to millions of records
- **Cost**: Open-source preferred to minimize licensing costs
- **Flexibility**: Need both relational and document storage

## Considered Options

1. PostgreSQL
2. MongoDB
3. MySQL
4. Amazon DynamoDB

## Decision Outcome

Chosen option: **PostgreSQL**, because:

- Provides ACID guarantees required for financial data
- Supports both relational and JSON document storage (JSONB)
- Excellent full-text search capabilities with extensions
- Strong open-source community and ecosystem
- Team has extensive PostgreSQL experience
- Can scale vertically and horizontally (with partitioning/sharding)
- Superior query optimizer for complex queries

### Positive Consequences

- Single database handles both relational and document needs
- ACID compliance ensures data integrity
- Rich extension ecosystem (PostGIS, pg_trgm, etc.)
- Excellent tooling and monitoring solutions
- Strong TypeScript integration via libraries like Prisma

### Negative Consequences

- Vertical scaling has limits; horizontal scaling requires planning
- More complex operational requirements than managed NoSQL
- Requires careful index management for optimal performance
- Schema migrations require more planning than schemaless DBs

## Validation

We will validate this decision by:
- Running performance benchmarks with expected load (target: <100ms p95 latency)
- Implementing a prototype with realistic data models
- Conducting a 1-week trial with the development team
- Reviewing operational requirements with DevOps team

Success criteria:
- [ ] Meets performance requirements under load testing
- [ ] Team comfortable with development workflow
- [ ] Operational overhead acceptable to DevOps
- [ ] Total cost of ownership within budget

## Pros and Cons of the Options

### PostgreSQL

**Pros:**
- ACID compliance
- Rich feature set (JSON, full-text search, GIS)
- Excellent query optimizer
- Strong consistency guarantees
- Open source with commercial support available

**Cons:**
- Requires careful operational management
- Horizontal scaling more complex than some alternatives
- Higher resource requirements than simpler databases

### MongoDB

**Pros:**
- Flexible schema
- Horizontal scaling built-in
- Good developer experience
- Strong aggregation framework

**Cons:**
- No ACID transactions across documents (until v4.0)
- More complex consistency model
- Less mature ecosystem for complex queries
- Team has limited experience

### MySQL

**Pros:**
- Widely adopted and supported
- Good performance for simple queries
- Large ecosystem

**Cons:**
- Limited JSON support compared to PostgreSQL
- Less sophisticated query optimizer
- Weaker support for complex data types

### Amazon DynamoDB

**Pros:**
- Fully managed service
- Excellent horizontal scalability
- Pay-per-use pricing model

**Cons:**
- Vendor lock-in
- Limited query capabilities
- No ACID across items/tables
- Difficult data modeling for complex relationships

## Links

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Performance Benchmarks](link-to-internal-doc)
- [Related ADR: Caching Strategy](ADR-002.md)
- [Prisma ORM Documentation](https://www.prisma.io/docs)

## Metadata

- **Date**: 2025-01-15
- **Deciders**: @john-doe, @jane-smith, @bob-wilson
- **Informed**: Engineering Team, DevOps Team
- **Review Date**: 2025-07-15 (6 months)
```

### ADR Best Practices

1. **One Decision Per ADR**: Focus on a single architectural decision
2. **Context is Key**: Explain why the decision was necessary
3. **Document Alternatives**: Show what options were considered
4. **Be Specific**: Include concrete criteria and constraints
5. **Date Everything**: Record when the decision was made
6. **Review Regularly**: Set review dates for important decisions
7. **Use Status Tags**: Draft → Proposed → Accepted → Deprecated → Superseded
8. **Link Related ADRs**: Create a network of related decisions

### ADR Status Lifecycle

```
Draft → Proposed → Accepted → [Deprecated/Superseded]
                        ↓
                    Rejected
```

---

## Writing Style Guidelines

### Core Principles

#### 1. Use Active Voice

**Good:**
```
The function returns an error.
Click the Save button.
The system processes requests in parallel.
```

**Bad:**
```
An error is returned by the function.
The Save button should be clicked.
Requests are processed in parallel by the system.
```

#### 2. Use Present Tense

**Good:**
```
The application connects to the database.
When an error occurs, the system logs the details.
```

**Bad:**
```
The application will connect to the database.
When an error occurred, the system logged the details.
```

#### 3. Be Concise

**Good:**
```
Delete the file.
The API returns user data.
```

**Bad:**
```
Please proceed to delete the file.
The API will return the data related to the user.
```

#### 4. Use Direct Language

**Good:**
```
You must provide an API key.
Do not expose secrets in code.
```

**Bad:**
```
It is required that an API key be provided.
Secrets should not be exposed in code.
```

### Formatting Guidelines

#### Headers

```markdown
# H1: Document Title (only one per document)
## H2: Major Sections
### H3: Subsections
#### H4: Minor Subsections
```

#### Code Blocks

Always specify the language for syntax highlighting:

```typescript
// Good: Language specified
const user = await getUser(id);
```

#### Lists

Use bullet lists for unordered items:
```markdown
- First item
- Second item
- Third item
```

Use numbered lists for sequential steps:
```markdown
1. First step
2. Second step
3. Third step
```

#### Tables

Use tables for structured data:

```markdown
| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Data 1   | Data 2   | Data 3   |
```

### Accessibility in Documentation

1. **Use Descriptive Link Text**
   - Good: [View the API documentation](link)
   - Bad: [Click here](link) for API docs

2. **Provide Alt Text for Images**
   ```markdown
   ![Diagram showing the authentication flow with arrows connecting user, application, and auth server](auth-flow.png)
   ```

3. **Use Semantic HTML in Markdown**
   - Use proper heading hierarchy
   - Use `<kbd>` for keyboard shortcuts: <kbd>Ctrl</kbd> + <kbd>C</kbd>
   - Use `<code>` for inline code: `variable`

4. **Structure Content Logically**
   - Use clear heading hierarchy
   - Include table of contents for long documents
   - Break up long paragraphs
   - Use lists for multiple items

### Voice and Tone

- **Instructional**: Clear, direct, imperative
  - "Install the dependencies using `bun install`"

- **Reference**: Factual, precise, declarative
  - "The `timeout` parameter accepts values between 0 and 60000"

- **Explanatory**: Friendly, informative, conversational
  - "We chose PostgreSQL because it offers the best balance of performance and features for our needs"

### Common Pitfalls to Avoid

1. **Avoid Jargon Without Definition**
   - Bad: "Use the ORM to persist entities"
   - Good: "Use the ORM (Object-Relational Mapping tool) to save data to the database"

2. **Avoid Ambiguous Pronouns**
   - Bad: "When the service calls the API, it may fail"
   - Good: "When the service calls the API, the API may fail"

3. **Avoid Future Tense**
   - Bad: "The function will return a promise"
   - Good: "The function returns a promise"

4. **Avoid Unnecessary Words**
   - Bad: "In order to start the server, you need to run..."
   - Good: "To start the server, run..."

### Documentation Checklist

Before publishing documentation:

- [ ] All code examples are tested and working
- [ ] Links are valid and point to correct locations
- [ ] Spelling and grammar are correct
- [ ] Headings follow logical hierarchy
- [ ] Code blocks specify language for syntax highlighting
- [ ] Images have descriptive alt text
- [ ] Table of contents is up to date
- [ ] Version information is accurate
- [ ] No placeholder text (TODO, TBD, etc.)
- [ ] Follows project style guide
- [ ] Reviewed by at least one other person

---

## Quick Reference

### Documentation Type Selection

| Task | Template/Framework |
|------|-------------------|
| New project | README Template |
| Code comments | TSDoc/JSDoc Conventions |
| User documentation | Diátaxis Framework |
| Track changes | CHANGELOG Format |
| Design decision | Architecture Decision Record (ADR) |
| Writing style | Writing Style Guidelines |

### Essential Tools

- **Linters**: markdownlint, write-good
- **Generators**: TypeDoc, JSDoc, Docusaurus
- **Validators**: markdown-link-check, alex
- **Formatters**: Prettier

### Additional Resources

- [Documentation Guide for Technical Writers](https://developers.google.com/tech-writing)
- [Microsoft Writing Style Guide](https://learn.microsoft.com/en-us/style-guide/welcome/)
- [GitLab Documentation Guidelines](https://docs.gitlab.com/ee/development/documentation/styleguide/)

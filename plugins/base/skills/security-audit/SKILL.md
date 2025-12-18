---
name: Security Audit
description: Comprehensive security audit procedures including dependency scanning, vulnerability assessment, license compliance, and incident response planning
---

# Security Audit

A comprehensive guide to security auditing, vulnerability management, license compliance, and security best practices for modern software development.

## Table of Contents

- [Quick Audit Commands](#quick-audit-commands)
- [Security Tools](#security-tools)
- [Vulnerability Management](#vulnerability-management)
- [Incident Response](#incident-response)
- [License Compliance](#license-compliance)
- [Security Best Practices](#security-best-practices)
- [Pre-Deployment Checklist](#pre-deployment-checklist)
- [Emergency Response Plan](#emergency-response-plan)

---

## Quick Audit Commands

### Bun (Recommended)

```bash
# Audit dependencies for vulnerabilities
bun audit

# Show detailed vulnerability report
bun audit --json

# Update vulnerable packages
bun update

# Check for outdated packages
bun outdated
```

### npm

```bash
# Audit dependencies
npm audit

# Show detailed vulnerability report
npm audit --json

# Automatically fix vulnerabilities
npm audit fix

# Fix including breaking changes
npm audit fix --force

# Check for outdated packages
npm outdated
```

### Yarn

```bash
# Audit dependencies
yarn audit

# Show detailed vulnerability report
yarn audit --json

# Interactive upgrade tool
yarn upgrade-interactive

# Check for outdated packages
yarn outdated
```

### pnpm

```bash
# Audit dependencies
pnpm audit

# Fix vulnerabilities
pnpm audit --fix

# Check for outdated packages
pnpm outdated
```

---

## Security Tools

### Dependency Scanning Tools

#### 1. Socket Security

**Purpose**: Real-time dependency security and supply chain protection

```bash
# Install Socket CLI
npm install -g @socketsecurity/cli

# Scan package.json
socket scan

# Check specific package
socket info package-name

# GitHub integration
socket ci
```

**Features:**
- Supply chain attack detection
- Malware detection
- License compliance
- Dependency risk scoring
- GitHub PR integration

**Configuration (.socket.yml):**
```yaml
version: v1
issueRules:
  - type: error
    packages:
      - name: "*"
        minSeverity: high
  - type: warning
    packages:
      - name: "*"
        minSeverity: medium
```

#### 2. Snyk

**Purpose**: Find and fix vulnerabilities in dependencies

```bash
# Install Snyk CLI
npm install -g snyk

# Authenticate
snyk auth

# Test for vulnerabilities
snyk test

# Monitor project (send snapshot to Snyk)
snyk monitor

# Fix vulnerabilities
snyk fix

# Test Docker images
snyk container test image-name

# Test infrastructure as code
snyk iac test
```

**Features:**
- Vulnerability database
- Automated fixes
- Container scanning
- IaC scanning
- License compliance
- CI/CD integration

**Configuration (snyk.yml):**
```yaml
version: v1.22.0
language-settings:
  javascript:
    ignore-scripts: true
exclude:
  global:
    - "test/**"
    - "**/*.test.js"
```

#### 3. npm audit / Bun audit

**Purpose**: Built-in vulnerability scanning

```bash
# Generate detailed audit report
npm audit --json > audit-report.json

# Audit only production dependencies
npm audit --production

# Set audit level threshold
npm audit --audit-level=moderate
```

#### 4. Retire.js

**Purpose**: Detect use of vulnerable JavaScript libraries

```bash
# Install
npm install -g retire

# Scan current directory
retire

# Scan with path
retire --path /path/to/project

# Output as JSON
retire --outputformat json

# Include node modules
retire --node
```

#### 5. OWASP Dependency-Check

**Purpose**: Detect publicly disclosed vulnerabilities in dependencies

```bash
# Download and run
wget https://github.com/jeremylong/DependencyCheck/releases/download/v7.4.4/dependency-check-7.4.4-release.zip
unzip dependency-check-7.4.4-release.zip

# Run scan
./dependency-check/bin/dependency-check.sh \
  --project "My Project" \
  --scan ./package.json \
  --out ./reports
```

### Static Analysis Security Testing (SAST)

#### Semgrep

```bash
# Install
pip install semgrep

# Run security rules
semgrep --config=auto

# Run specific ruleset
semgrep --config "p/security-audit"

# CI mode (fail on findings)
semgrep --config auto --error

# Output as JSON
semgrep --config auto --json
```

#### ESLint Security Plugins

```bash
# Install security plugins
npm install --save-dev \
  eslint-plugin-security \
  eslint-plugin-no-unsanitized

# .eslintrc.js
module.exports = {
  plugins: ['security', 'no-unsanitized'],
  extends: ['plugin:security/recommended'],
  rules: {
    'security/detect-object-injection': 'error',
    'security/detect-non-literal-regexp': 'warn',
    'security/detect-unsafe-regex': 'error',
    'no-unsanitized/method': 'error',
    'no-unsanitized/property': 'error'
  }
};
```

### Secret Scanning

#### GitGuardian

```bash
# Install ggshield
pip install ggshield

# Scan current directory
ggshield secret scan path .

# Scan git history
ggshield secret scan repo .

# Pre-commit hook
ggshield install -m local
```

#### Gitleaks

```bash
# Install
brew install gitleaks

# Scan repository
gitleaks detect --source . --verbose

# Scan specific commit
gitleaks detect --log-opts="HEAD~1..HEAD"

# Pre-commit hook
gitleaks protect --staged
```

#### TruffleHog

```bash
# Install
pip install truffleHog

# Scan repository
truffleHog git https://github.com/user/repo.git

# Scan local repository
truffleHog filesystem /path/to/project
```

---

## Vulnerability Management

### Severity Levels

| Level | CVSS Score | Description | Response Time |
|-------|------------|-------------|---------------|
| **Critical** | 9.0-10.0 | Requires immediate attention | 24 hours |
| **High** | 7.0-8.9 | Requires urgent attention | 7 days |
| **Medium** | 4.0-6.9 | Should be addressed soon | 30 days |
| **Low** | 0.1-3.9 | Address when convenient | 90 days |
| **Informational** | N/A | No immediate action needed | Next release |

### CVSS Score Breakdown

**CVSS (Common Vulnerability Scoring System)** measures:
- **Attack Vector**: Network, Adjacent, Local, Physical
- **Attack Complexity**: Low, High
- **Privileges Required**: None, Low, High
- **User Interaction**: None, Required
- **Impact**: Confidentiality, Integrity, Availability

### Response Time Guidelines

#### Critical (24 hours)
- Remote code execution
- Authentication bypass
- SQL injection in production
- Data exposure affecting users
- Supply chain attacks

**Action:**
1. Assemble incident response team
2. Assess impact and exposure
3. Apply emergency patch or mitigation
4. Deploy to production
5. Notify affected users if required
6. Document incident

#### High (7 days)
- Privilege escalation
- XSS vulnerabilities
- Known exploits in dependencies
- Security misconfiguration

**Action:**
1. Review vulnerability details
2. Test patches in staging
3. Schedule deployment window
4. Apply fixes
5. Verify resolution
6. Update documentation

#### Medium (30 days)
- Information disclosure
- CSRF vulnerabilities
- Outdated dependencies (no known exploits)

**Action:**
1. Add to security backlog
2. Plan fix in next sprint
3. Test thoroughly
4. Deploy with regular release

#### Low (90 days)
- Minor configuration issues
- Deprecated functions
- Low-impact information leaks

**Action:**
1. Add to technical debt backlog
2. Address in maintenance window
3. Bundle with other updates

---

## Incident Response

### 1. Identify

**Initial Detection:**
```bash
# Check for suspicious activity in logs
grep -i "error\|warning\|fail" /var/log/application.log | tail -100

# Review recent security scan results
bun audit --json | jq '.vulnerabilities'

# Check for unauthorized changes
git log --all --oneline --since="1 day ago"

# Monitor running processes
ps aux | grep -i suspicious-process
```

**Indicators of Compromise:**
- Unexpected dependencies in package.json
- Unusual network activity
- Unauthorized code changes
- Failed authentication attempts
- Unexpected error rates
- Performance degradation

### 2. Assess Impact

**Questions to Answer:**
1. What systems are affected?
2. What data may be compromised?
3. How many users are impacted?
4. Is the vulnerability actively exploited?
5. What is the attack vector?
6. What is the blast radius?

**Impact Assessment Template:**
```markdown
# Security Incident Assessment

## Incident Details
- **Date/Time Detected**: 2025-01-15 14:30 UTC
- **Detected By**: Automated scan / User report / Monitoring
- **Severity**: Critical / High / Medium / Low

## Affected Systems
- [ ] Production environment
- [ ] Staging environment
- [ ] Development environment
- [ ] CI/CD pipeline
- [ ] Database
- [ ] API servers
- [ ] Frontend application

## Vulnerability Details
- **CVE ID**: CVE-2025-XXXXX
- **CVSS Score**: 9.2 (Critical)
- **Description**: [Brief description]
- **Affected Component**: package-name@version

## Impact Assessment
- **Users Affected**: X users / All users
- **Data Exposure**: Yes / No
- **Type of Data**: PII, credentials, financial, etc.
- **Active Exploitation**: Yes / No / Unknown

## Initial Response
- **Action Taken**: [Immediate mitigation steps]
- **Responsible Team**: Security / DevOps / Engineering
- **Status**: Investigating / Mitigating / Resolved
```

### 3. Contain

**Immediate Containment Steps:**

```bash
# 1. Isolate affected systems
# Disable affected endpoints in load balancer
# OR take down affected services

# 2. Revoke compromised credentials
# Rotate API keys
# Invalidate sessions
# Reset passwords

# 3. Block malicious activity
# Update firewall rules
# Rate limit suspicious IPs
# Enable WAF rules

# 4. Preserve evidence
# Capture logs
tar -czf logs-$(date +%Y%m%d-%H%M%S).tar.gz /var/log/

# Snapshot database state
pg_dump dbname > incident-backup-$(date +%Y%m%d-%H%M%S).sql

# Capture system state
ps aux > processes-$(date +%Y%m%d-%H%M%S).txt
netstat -tulpn > network-$(date +%Y%m%d-%H%M%S).txt
```

### 4. Remediate

**Step-by-Step Response Procedure:**

#### Step 1: Check for Patches

```bash
# Check if patch is available
npm view package-name versions --json | jq '.[-5:]'

# Check for security advisories
npm audit
bun audit

# Review GitHub security advisories
gh api /repos/owner/repo/security-advisories
```

#### Step 2: Test Patches

```bash
# Create test branch
git checkout -b security-patch-CVE-2025-XXXXX

# Update vulnerable package
bun update package-name

# Run full test suite
bun test

# Run security scan
bun audit

# Test in staging environment
bun run deploy:staging
```

#### Step 3: Apply Fix

```bash
# Update package
bun update package-name@latest

# Or update multiple packages
bun update

# Lock file update
bun install

# Verify fix
bun audit

# Commit changes
git add package.json bun.lockb
git commit -m "fix(security): patch CVE-2025-XXXXX in package-name

- Update package-name from X.X.X to Y.Y.Y
- Addresses critical vulnerability CVE-2025-XXXXX
- CVSS Score: 9.2
- Impact: Remote code execution

Refs: #123"
```

#### Step 4: Deploy

```bash
# Deploy to production
bun run deploy:production

# Verify deployment
curl -f https://api.example.com/health

# Monitor for issues
tail -f /var/log/application.log
```

#### Step 5: Verify

```bash
# Confirm vulnerability is resolved
bun audit

# Run security scan
snyk test

# Check application functionality
bun test:e2e

# Monitor error rates
# Check application metrics dashboard
```

### 5. Document

**Incident Report Template:**

```markdown
# Security Incident Report: CVE-2025-XXXXX

## Executive Summary
Brief overview of the incident, impact, and resolution.

## Timeline
- **2025-01-15 14:30 UTC**: Vulnerability detected
- **2025-01-15 14:45 UTC**: Severity assessed (Critical)
- **2025-01-15 15:00 UTC**: Incident response team assembled
- **2025-01-15 15:30 UTC**: Patch identified and tested
- **2025-01-15 16:00 UTC**: Fix deployed to production
- **2025-01-15 16:15 UTC**: Verification complete
- **2025-01-15 17:00 UTC**: Incident closed

## Vulnerability Details
- **CVE ID**: CVE-2025-XXXXX
- **CVSS Score**: 9.2 (Critical)
- **Affected Package**: package-name@1.2.3
- **Fixed Version**: package-name@1.2.4
- **Attack Vector**: Network
- **Impact**: Remote Code Execution

## Impact Assessment
- **Systems Affected**: Production API servers
- **Users Affected**: Potentially all users (not actively exploited)
- **Data Exposure**: None detected
- **Downtime**: 15 minutes during deployment

## Root Cause
The vulnerability was introduced when we updated to package-name@1.2.3
on 2025-01-10. The package contained a critical RCE vulnerability in
its request parsing logic.

## Resolution
- Updated package-name from 1.2.3 to 1.2.4
- Deployed patch to production
- Verified resolution with security scan
- No data exposure or active exploitation detected

## Lessons Learned
1. Need automated security scanning in CI/CD
2. Should monitor security advisories more proactively
3. Consider dependency update policy

## Action Items
- [ ] Implement automated security scanning in CI/CD pipeline
- [ ] Set up security advisory notifications
- [ ] Create dependency update policy
- [ ] Schedule security training for team
- [ ] Review and update incident response procedures

## References
- CVE Details: https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2025-XXXXX
- Security Advisory: https://github.com/package/advisories/GHSA-XXXX
- Internal Ticket: #123
```

---

## License Compliance

### Common Open Source Licenses

| License | Commercial Use | Modify | Distribute | Patent Grant | Disclose Source | Same License |
|---------|----------------|--------|------------|--------------|-----------------|--------------|
| **MIT** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Apache 2.0** | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **BSD 3-Clause** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **GPL-2.0** | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| **GPL-3.0** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **LGPL-2.1** | ✅ | ✅ | ✅ | ❌ | ✅ (if modified) | ✅ (if modified) |
| **LGPL-3.0** | ✅ | ✅ | ✅ | ✅ | ✅ (if modified) | ✅ (if modified) |
| **AGPL-3.0** | ✅ | ✅ | ✅ | ✅ | ✅ (network use) | ✅ |
| **MPL-2.0** | ✅ | ✅ | ✅ | ✅ | ✅ (modified files) | ✅ (modified files) |
| **ISC** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Unlicense** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

### License Categories

#### Permissive Licenses
**Safe for most commercial use**
- MIT
- Apache 2.0
- BSD (2-Clause, 3-Clause)
- ISC
- Unlicense

**Characteristics:**
- Minimal restrictions
- Can be used in proprietary software
- No copyleft requirements
- Attribution usually required

#### Copyleft Licenses
**Require source disclosure**

**Weak Copyleft:**
- LGPL-2.1
- LGPL-3.0
- MPL-2.0

**Strong Copyleft:**
- GPL-2.0
- GPL-3.0
- AGPL-3.0

**Characteristics:**
- Derivative works must use same license
- Source code must be disclosed
- AGPL requires disclosure even for network services

### License Scanning Tools

#### 1. license-checker

```bash
# Install
npm install -g license-checker

# Generate license report
license-checker --production --json > licenses.json

# Check for specific licenses
license-checker --production --onlyAllow 'MIT;Apache-2.0;BSD-3-Clause;ISC'

# Exclude licenses
license-checker --production --exclude 'GPL;AGPL'

# Generate summary
license-checker --production --summary
```

#### 2. licensee

```bash
# Install
gem install licensee

# Detect license
licensee detect /path/to/project

# Check specific file
licensee detect path/to/LICENSE
```

#### 3. FOSSA

```bash
# Install FOSSA CLI
curl -H 'Cache-Control: no-cache' \
  https://raw.githubusercontent.com/fossas/fossa-cli/master/install-latest.sh | bash

# Initialize project
fossa init

# Run license scan
fossa analyze

# Test for compliance
fossa test
```

#### 4. LicenseFinder

```bash
# Install
gem install license_finder

# Generate report
license_finder report

# Check for compliance
license_finder

# Approve licenses
license_finder permitted_licenses add MIT Apache-2.0

# Deny licenses
license_finder restricted_licenses add GPL-3.0
```

### License Compliance Checklist

#### Pre-Project

- [ ] Define acceptable licenses for project
- [ ] Document license policy
- [ ] Set up automated license scanning
- [ ] Train team on license compliance

#### During Development

- [ ] Scan licenses before adding dependencies
- [ ] Review licenses in code review
- [ ] Keep license inventory up to date
- [ ] Document exceptions and justifications

#### Pre-Release

- [ ] Generate complete license report
- [ ] Include NOTICE/ATTRIBUTION file
- [ ] Review copyleft obligations
- [ ] Verify license compatibility
- [ ] Document third-party licenses
- [ ] Update SBOM (Software Bill of Materials)

### License Compatibility

**Compatible with Proprietary Software:**
- MIT ✅
- Apache 2.0 ✅
- BSD ✅
- ISC ✅

**Requires Source Disclosure:**
- GPL ⚠️ (entire application)
- LGPL ⚠️ (library only)
- AGPL ⚠️ (including network use)
- MPL ⚠️ (modified files only)

**Compatibility Matrix:**

| Your License | Can Use |
|--------------|---------|
| Proprietary | MIT, Apache, BSD, ISC |
| MIT | MIT, Apache, BSD, ISC |
| Apache 2.0 | MIT, Apache, BSD, ISC |
| GPL-3.0 | MIT, Apache, BSD, ISC, GPL-3.0, LGPL, AGPL |
| AGPL-3.0 | MIT, Apache, BSD, ISC, GPL, LGPL, AGPL |

---

## Security Best Practices

### 1. Dependency Management

#### Keep Dependencies Updated

```bash
# Check for outdated packages
bun outdated

# Update all dependencies
bun update

# Update specific package
bun update package-name

# Update to latest major version
bun update package-name@latest
```

#### Use Lock Files

```bash
# Bun automatically creates bun.lockb
# Always commit lock files
git add bun.lockb package.json
git commit -m "chore: update dependencies"

# For npm/yarn
git add package-lock.json package.json
# or
git add yarn.lock package.json
```

#### Minimize Dependencies

```bash
# Analyze bundle size
npx bundle-wizard

# Find duplicate dependencies
npx depcheck

# Analyze dependency tree
bun pm ls

# Remove unused dependencies
bun remove unused-package
```

### 2. Automated Security Scanning

#### CI/CD Integration

**GitHub Actions Example:**

```yaml
# .github/workflows/security.yml
name: Security Audit

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
  schedule:
    # Run daily at 2 AM
    - cron: '0 2 * * *'

jobs:
  security:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run security audit
        run: bun audit

      - name: Run Snyk scan
        run: |
          npm install -g snyk
          snyk test --severity-threshold=high
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}

      - name: Scan for secrets
        run: |
          pip install gitleaks
          gitleaks detect --verbose

      - name: License compliance check
        run: |
          npm install -g license-checker
          license-checker --onlyAllow 'MIT;Apache-2.0;BSD-3-Clause;ISC'
```

### 3. Security Headers

**Express.js Example:**

```typescript
import helmet from 'helmet';
import express from 'express';

const app = express();

// Use Helmet for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true,
}));

// Additional security headers
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
```

### 4. Input Validation

**Zod Example:**

```typescript
import { z } from 'zod';

// Define schema
const userSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
  name: z.string().min(1).max(100),
  age: z.number().int().positive().max(120),
});

// Validate input
app.post('/api/users', async (req, res) => {
  try {
    const validatedData = userSchema.parse(req.body);
    // Process validated data
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ errors: error.errors });
    }
    throw error;
  }
});
```

**SQL Injection Prevention:**

```typescript
// BAD: String concatenation
const query = `SELECT * FROM users WHERE id = ${userId}`;

// GOOD: Parameterized query
const query = 'SELECT * FROM users WHERE id = $1';
const result = await db.query(query, [userId]);

// GOOD: ORM with parameterization
const user = await prisma.user.findUnique({
  where: { id: userId }
});
```

### 5. Secrets Management

#### Environment Variables

```bash
# .env (NEVER commit this file)
DATABASE_URL=postgresql://user:password@localhost:5432/db
API_KEY=sk_live_xxxxxxxxxxxxx
JWT_SECRET=xxxxxxxxxxxxx

# .env.example (commit this as template)
DATABASE_URL=postgresql://user:password@localhost:5432/dbname
API_KEY=your_api_key_here
JWT_SECRET=generate_random_secret
```

#### .gitignore

```gitignore
# Environment variables
.env
.env.local
.env.*.local

# Secrets
secrets/
*.key
*.pem
*.p12
credentials.json

# Sensitive configs
config/production.json
```

#### Secrets Detection

```bash
# Pre-commit hook to detect secrets
# .git/hooks/pre-commit
#!/bin/sh
gitleaks protect --staged --verbose
```

#### Secrets Management Tools

- **Development**: dotenv, envfile
- **Production**: AWS Secrets Manager, HashiCorp Vault, Azure Key Vault
- **CI/CD**: GitHub Secrets, GitLab CI Variables, CircleCI Contexts

### 6. Authentication & Authorization

#### Password Hashing

```typescript
import bcrypt from 'bcrypt';

// Hash password
const saltRounds = 12;
const hashedPassword = await bcrypt.hash(password, saltRounds);

// Verify password
const isValid = await bcrypt.compare(password, hashedPassword);
```

#### JWT Best Practices

```typescript
import jwt from 'jsonwebtoken';

// Generate token
const token = jwt.sign(
  { userId: user.id, role: user.role },
  process.env.JWT_SECRET!,
  {
    expiresIn: '15m',
    algorithm: 'HS256',
    issuer: 'your-app',
    audience: 'your-app-users'
  }
);

// Verify token
try {
  const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
    algorithms: ['HS256'],
    issuer: 'your-app',
    audience: 'your-app-users'
  });
} catch (error) {
  // Invalid token
}
```

---

## Pre-Deployment Security Checklist

### Code Security

- [ ] No hardcoded secrets or credentials
- [ ] All inputs validated and sanitized
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (output encoding)
- [ ] CSRF protection enabled
- [ ] Security headers configured
- [ ] Error messages don't leak sensitive info
- [ ] Logging excludes sensitive data

### Dependencies

- [ ] All dependencies up to date
- [ ] No known vulnerabilities (bun audit)
- [ ] License compliance verified
- [ ] Minimal dependency footprint
- [ ] Lock file committed and up to date
- [ ] Unused dependencies removed

### Authentication & Authorization

- [ ] Strong password requirements enforced
- [ ] Passwords properly hashed (bcrypt, argon2)
- [ ] Multi-factor authentication available
- [ ] Session management secure
- [ ] JWT tokens properly validated
- [ ] Authorization checks on all endpoints
- [ ] Role-based access control implemented

### Data Protection

- [ ] Encryption at rest configured
- [ ] Encryption in transit (TLS/HTTPS)
- [ ] PII properly protected
- [ ] Data retention policy implemented
- [ ] Backup and recovery tested
- [ ] Database access restricted

### Infrastructure

- [ ] Firewall rules configured
- [ ] Rate limiting enabled
- [ ] DDoS protection active
- [ ] Monitoring and alerting set up
- [ ] Logging configured
- [ ] Security groups/IAM properly configured
- [ ] Least privilege principle applied

### Compliance

- [ ] GDPR compliance (if applicable)
- [ ] CCPA compliance (if applicable)
- [ ] SOC 2 requirements met (if applicable)
- [ ] Privacy policy updated
- [ ] Terms of service updated
- [ ] Security incident response plan ready

### Testing

- [ ] Security scan completed (Snyk, etc.)
- [ ] Penetration testing done (if required)
- [ ] Vulnerability scan completed
- [ ] Secret scan completed (gitleaks)
- [ ] License scan completed
- [ ] Code review completed

---

## Emergency Response Plan

### Severity 1: Critical Security Incident

**Examples:**
- Active breach detected
- Data exposure confirmed
- Ransomware attack
- DDoS taking down services

**Immediate Actions (0-15 minutes):**

1. **Alert the team**
   ```bash
   # Send emergency notification
   # Use your incident management system (PagerDuty, etc.)
   ```

2. **Assess the situation**
   - What is compromised?
   - Is it still ongoing?
   - What is the scope?

3. **Contain the incident**
   ```bash
   # Isolate affected systems
   # Disable compromised accounts
   # Block malicious IPs
   # Enable WAF rules
   ```

**Next Steps (15-60 minutes):**

4. **Preserve evidence**
   ```bash
   # Capture logs
   tar -czf incident-logs-$(date +%Y%m%d-%H%M%S).tar.gz /var/log/

   # Database snapshot
   pg_dump dbname > incident-db-$(date +%Y%m%d-%H%M%S).sql

   # System state
   ps aux > processes-$(date +%Y%m%d-%H%M%S).txt
   netstat -tulpn > network-$(date +%Y%m%d-%H%M%S).txt
   ```

5. **Begin remediation**
   - Apply emergency patches
   - Rotate credentials
   - Update firewall rules

6. **Communicate**
   - Internal stakeholders
   - Affected users (if required)
   - Regulatory bodies (if required)

**Follow-up (1-24 hours):**

7. **Complete remediation**
8. **Verify resolution**
9. **Document incident**
10. **Conduct post-mortem**

### Contact Information Template

```markdown
# Emergency Contacts

## Internal Team
- **Security Lead**: name@company.com, +1-XXX-XXX-XXXX
- **DevOps Lead**: name@company.com, +1-XXX-XXX-XXXX
- **CTO**: name@company.com, +1-XXX-XXX-XXXX
- **Legal**: name@company.com, +1-XXX-XXX-XXXX

## External Contacts
- **Security Vendor**: vendor@security.com, +1-XXX-XXX-XXXX
- **Hosting Provider**: support@provider.com, +1-XXX-XXX-XXXX
- **Incident Response Firm**: contact@firm.com, +1-XXX-XXX-XXXX

## Escalation Path
1. Security Lead (< 15 min)
2. CTO (< 30 min)
3. CEO (< 1 hour)
4. External IR Firm (< 2 hours)

## Communication Channels
- Slack: #security-incidents
- Email: security@company.com
- Phone Bridge: +1-XXX-XXX-XXXX
```

### Incident Severity Matrix

| Severity | Impact | Examples | Response |
|----------|--------|----------|----------|
| **SEV-1** | Critical | Data breach, active attack, total outage | Immediate, all hands |
| **SEV-2** | High | Major vulnerability, partial outage | Urgent, within hours |
| **SEV-3** | Medium | Security misconfiguration, degraded service | Address within days |
| **SEV-4** | Low | Minor issue, no immediate impact | Address in next sprint |

---

## Resources

### Tools
- [Snyk](https://snyk.io/)
- [Socket Security](https://socket.dev/)
- [OWASP Dependency-Check](https://owasp.org/www-project-dependency-check/)
- [npm audit](https://docs.npmjs.com/cli/v9/commands/npm-audit)
- [GitGuardian](https://www.gitguardian.com/)
- [Semgrep](https://semgrep.dev/)

### Learning Resources
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)
- [CWE Top 25](https://cwe.mitre.org/top25/)
- [SANS Security Resources](https://www.sans.org/security-resources/)

### Standards & Compliance
- [PCI DSS](https://www.pcisecuritystandards.org/)
- [SOC 2](https://www.aicpa.org/soc)
- [GDPR](https://gdpr.eu/)
- [CCPA](https://oag.ca.gov/privacy/ccpa)

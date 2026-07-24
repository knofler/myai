---
name: analysis-dependency-audit
description: "Run npm audit, check for outdated packages, verify license compliance, and identify safe upgrade paths. Triggers: dependency audit, npm audit, outdated packages, license check, vulnerability scan, upgrade dependencies"
---

# Dependency Audit Playbook

## When to Use

- Before a release to ensure no known vulnerabilities ship
- Monthly dependency hygiene check
- When Dependabot or Snyk flags vulnerabilities
- Before adding a new dependency to assess the supply chain

## Prerequisites

- `package.json` and `package-lock.json` present
- Docker container running for npm commands
- Understanding of semver and breaking change risk

## Playbook

### 1. Run Security Audit

```bash
docker exec <container> npm audit
```

Capture the output and categorize findings:
- **Critical**: Remote code execution, auth bypass
- **High**: Data exposure, XSS, privilege escalation
- **Moderate**: Denial of service, information disclosure
- **Low**: Minor issues, theoretical attacks

### 2. Check for Outdated Packages

```bash
docker exec <container> npm outdated
```

For each outdated package, record:
- Current version
- Wanted version (within semver range)
- Latest version
- Package name and type (dependency vs devDependency)

### 3. Classify Upgrade Risk

For each outdated package, assess:
- **Patch** (x.x.PATCH): Safe, bug fixes only
- **Minor** (x.MINOR.0): Usually safe, new features, no breaking changes
- **Major** (MAJOR.0.0): Breaking changes likely, review changelog

### 4. Verify License Compliance

Check all dependency licenses against the project's allowed list:
- **Allowed**: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC
- **Review needed**: MPL-2.0, LGPL-3.0 (copyleft concerns)
- **Prohibited**: GPL-3.0, AGPL-3.0 (for commercial projects), UNLICENSED

Flag any package with a prohibited or unknown license.

### 5. Identify Upgrade Paths

For each vulnerability with a fix available:
1. Check if the fix is a patch/minor (safe to auto-upgrade)
2. Check if it requires a major version bump (manual review)
3. Check for transitive dependency issues (nested dep needs update)

```bash
docker exec <container> npm audit fix --dry-run
```

### 6. Check for Deprecated Packages

Identify packages marked as deprecated on npm. For each:
- Find the recommended replacement
- Assess migration effort
- Create a migration task if effort is significant

### 7. Produce Audit Report

| Package | Current | Latest | Severity | License | Action |
|---------|---------|--------|----------|---------|--------|

Summary metrics:
- Total dependencies (direct + transitive)
- Vulnerabilities by severity
- Outdated packages by risk level
- License violations

## Output

- Security audit results with severity classification
- Outdated package list with upgrade risk assessment
- License compliance report
- Recommended upgrade plan (safe auto-upgrades vs manual reviews)
- Deprecated package migration tasks

## Review Checklist

- [ ] `npm audit` run and all findings categorized
- [ ] Outdated packages identified with semver risk level
- [ ] License compliance verified for all dependencies
- [ ] Safe upgrades identified (patch/minor with no breaking changes)
- [ ] Major upgrades flagged for manual review
- [ ] Deprecated packages identified with replacement recommendations
- [ ] No critical or high vulnerabilities left unaddressed

---
name: github-codeowners
description: "Generate a CODEOWNERS file from git blame analysis. Map directories and file patterns to top contributors. Triggers: codeowners, code owners, ownership, who owns, file ownership"
---

# GitHub CODEOWNERS Playbook

## When to Use

- Repository lacks a CODEOWNERS file
- Ownership is unclear and PRs have no automatic reviewers
- Team has grown and ownership boundaries need formalizing
- Post-reorg when code ownership has shifted

## Prerequisites

- Git history available (at least 3 months recommended)
- Knowledge of current team members and their GitHub handles
- Repository write access to create `.github/CODEOWNERS`

## Playbook

### 1. Analyze Git Blame by Directory

For each top-level directory and key subdirectory, run:

```bash
git log --format='%aN' --since='6 months ago' -- <dir>/ | sort | uniq -c | sort -rn | head -5
```

Record the top 2-3 contributors per directory as ownership candidates.

### 2. Identify File-Pattern Owners

For specialized file types, check who modifies them most:
- `*.yml` / `*.yaml` — likely DevOps
- `*.test.*` / `*.spec.*` — likely QA
- `*.md` — likely Documentation
- `Dockerfile*` / `docker-compose*` — likely DevOps
- `package.json` / lock files — likely Tech Lead

### 3. Map Contributors to GitHub Handles

Cross-reference git author names with GitHub usernames. Build a mapping table:

| Git Author | GitHub Handle | Primary Ownership |
|-----------|---------------|-------------------|

### 4. Draft CODEOWNERS File

Create `.github/CODEOWNERS` with rules ordered from general to specific:

```
# Default owners
* @tech-lead

# Frontend
/src/app/         @frontend-dev
/src/components/  @frontend-dev @ui-dev

# API
/src/api/         @api-dev
/src/middleware/   @api-dev

# Infrastructure
/.github/         @devops
Dockerfile        @devops
docker-compose*   @devops
```

### 5. Validate Coverage

Verify every directory has at least one owner. Check for:
- Orphaned directories with no matching rule
- Overly broad patterns that assign wrong owners
- Missing team leads as fallback reviewers

### 6. Test the CODEOWNERS File

Push to a branch and open a test PR touching files in different directories. Verify GitHub auto-assigns the correct reviewers.

## Output

- `.github/CODEOWNERS` file
- Ownership analysis table (directory to contributor mapping)
- Coverage report showing any gaps

## Review Checklist

- [ ] Git blame analysis covers all major directories
- [ ] Contributors mapped to correct GitHub handles
- [ ] Rules ordered from general to specific (most specific last)
- [ ] Every key directory has an owner
- [ ] Fallback default owner specified
- [ ] CODEOWNERS file tested with a PR

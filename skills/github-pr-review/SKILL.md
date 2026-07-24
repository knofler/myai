---
name: github-pr-review
description: "Multi-perspective code review on a pull request. Run security, performance, and style checks in parallel. Consolidate into a single review with severity ratings. Triggers: review pr, pr review, review pull request, check pr, audit pr"
---

# GitHub PR Review Playbook

## When to Use
- A pull request needs code review before merging.
- User says "review pr", "check pr", or provides a PR number/URL.
- Part of the "ship it" workflow before merge approval.

## Prerequisites
- `gh` CLI installed and authenticated.
- PR number or URL provided, or inferred from current branch.
- Repository checked out locally with the PR branch available.

## Playbook

### 1. Fetch PR Details
- Run `gh pr view <number> --json title,body,files,additions,deletions,commits`.
- Run `gh pr diff <number>` to get the full diff.
- Note the PR author, base branch, and number of changed files.

### 2. Security Scan (Parallel Lane A)
- Check for hardcoded secrets, API keys, tokens, or passwords in the diff.
- Verify no `.env` files or credential files are included.
- Check input validation on any new API endpoints.
- Verify auth middleware on protected routes.
- Flag SQL/NoSQL injection vectors and XSS risks.

### 3. Performance Check (Parallel Lane B)
- Identify N+1 query patterns in database calls.
- Check for missing `async/await` or unhandled promises.
- Flag large synchronous operations that could block the event loop.
- Review any new dependencies for bundle size impact.
- Check for missing pagination on list endpoints.

### 4. Style and Standards Check (Parallel Lane C)
- Read `documentation/AI_RULES.md` for project conventions.
- Verify TypeScript strict mode compliance.
- Check naming conventions (files, variables, components).
- Verify error handling patterns match project standards.
- Confirm test files exist for new functionality.

### 5. Consolidate Findings
- Merge results from all three parallel scans.
- Assign severity to each finding: Critical, Warning, Nit.
- Group findings by file for readability.
- Determine overall verdict: Approve, Approve with Nits, Request Changes.

### 6. Post Review
- Run `gh pr review <number> --body "<review>" --approve` or `--request-changes`.
- Format review as markdown with severity badges.
- Include a summary table of all findings at the top.

### 7. Log and Report
- Log the review outcome in `logs/claude_log.md`.
- Report verdict and finding count to the user.

## Output
- GitHub PR review posted with structured findings.
- Each finding has: file, line, severity, description, suggestion.
- Summary verdict with rationale.

## Review Checklist
- [ ] All changed files examined in the diff.
- [ ] Security scan completed — no secrets or injection risks.
- [ ] Performance scan completed — no N+1 or blocking operations.
- [ ] Style scan completed — conventions followed.
- [ ] Findings consolidated with correct severity ratings.
- [ ] Review posted to GitHub via gh CLI.

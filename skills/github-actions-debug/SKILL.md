---
name: github-actions-debug
description: "Debug failing GitHub Actions CI workflows. Read workflow YAML, fetch failed run logs via gh CLI, identify root cause, suggest fix. Triggers: debug ci, fix workflow, ci failing, actions debug"
---

# GitHub Actions Debug Playbook

## When to Use

- A GitHub Actions workflow run has failed
- CI is red and the cause is not immediately obvious
- A newly added or modified workflow is not behaving as expected
- Tests pass locally but fail in CI

## Prerequisites

- `gh` CLI installed and authenticated
- Access to the repository on GitHub
- Workflow YAML files in `.github/workflows/`

## Playbook

### 1. Identify the Failed Run

```bash
gh run list --status failure --limit 5
gh run view <run-id>
```

Note the workflow name, trigger event, branch, and commit SHA.

### 2. Fetch and Read Logs

```bash
gh run view <run-id> --log-failed
```

Extract the exact error message, failed step name, and exit code. Look for patterns: dependency install failures, test assertion errors, timeout, permission denied, missing secrets.

### 3. Read the Workflow YAML

Open `.github/workflows/<workflow>.yml`. Trace the failed job and step. Check:
- Runner OS and version
- Node/Python/Docker version mismatches
- Environment variables and secrets references
- Conditional expressions (`if:` clauses)
- Caching configuration (actions/cache key mismatches)

### 4. Compare Local vs CI Environment

- Check `package-lock.json` or lock file consistency
- Verify env vars available in CI but not hardcoded
- Check for OS-specific path issues (Linux CI vs macOS local)
- Confirm Docker images are accessible from CI runner

### 5. Identify Root Cause

Categorize the failure:
- **Dependency**: lock file drift, registry timeout, private package auth
- **Test**: flaky test, timing issue, missing test fixture
- **Config**: wrong secret name, expired token, missing env var
- **Infrastructure**: runner disk full, timeout, rate limit

### 6. Apply Fix

Implement the fix in the workflow YAML or source code. Push to the branch and monitor the re-run:

```bash
gh run watch
```

### 7. Document the Fix

Add a comment to the PR or commit message explaining what failed and why.

## Output

- Root cause summary (one paragraph)
- Fixed workflow YAML or source code
- Verified passing CI run

## Review Checklist

- [ ] Failed run logs retrieved and analyzed
- [ ] Workflow YAML reviewed for the failed step
- [ ] Root cause identified and categorized
- [ ] Fix applied and pushed
- [ ] CI re-run passes
- [ ] Fix documented in commit message or PR comment

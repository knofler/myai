---
name: tech-debt-flag
description: "Identify and document technical debt. Scan for TODOs, workarounds, deprecated deps, missing tests, and hardcoded values. Produce a prioritized debt backlog. Triggers: tech debt, technical debt, code smell, refactor needed, cleanup needed"
---

# Tech Debt Flag Playbook

## 1. Define Scan Scope

- Read `state/STATE.md` for current project boundaries.
- Determine scope: full codebase, specific service, or recent changes.

## 2. Scan for Debt Indicators

- **TODOs/FIXMEs/HACKs**: Grep for `TODO`, `FIXME`, `HACK`, `WORKAROUND`.
- **Deprecated Dependencies**: Check `package.json` / `requirements.txt` for deprecated or outdated packages.
- **Missing Tests**: Identify source files with no corresponding test file.
- **Hardcoded Values**: Search for hardcoded URLs, secrets, magic numbers.
- **Dead Code**: Look for unused exports, unreachable branches.
- **Copy-Paste Duplication**: Identify repeated code blocks across files.

## 3. Categorize by Severity

| Severity | Definition | Example |
|----------|-----------|---------|
| Critical | Blocks production or causes data loss | Hardcoded secrets, no error handling on payments |
| High | Causes bugs or significant maintenance burden | Missing tests for core logic, deprecated auth lib |
| Medium | Slows development or degrades DX | Poor naming, missing docs, no linting |
| Low | Cosmetic or minor inefficiency | TODO comments, minor duplication |

## 4. Estimate Remediation Effort

- Tag each item: **S** (< 1 hr), **M** (1-4 hrs), **L** (4-16 hrs), **XL** (> 16 hrs).
- Note dependencies (e.g., "must upgrade X before fixing Y").

## 5. Create Prioritized Backlog

- Output as a markdown table sorted by severity then effort.
- Include: file path, line number, category, severity, effort, description.

## 6. Update State

- Add debt summary to `state/STATE.md` under a Tech Debt section.
- Log the scan in `logs/claude_log.md`.

## 7. Review Checklist

- [ ] All indicator types scanned.
- [ ] Each item has severity and effort estimate.
- [ ] Critical items flagged for immediate action.
- [ ] Backlog saved and state/STATE.md updated.

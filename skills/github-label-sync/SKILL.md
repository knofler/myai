---
name: github-label-sync
description: "Define a standard label set, compare across repos, create missing labels, and update colors for consistency. Triggers: label sync, sync labels, standardize labels, label management, github labels"
---

# GitHub Label Sync Playbook

## When to Use

- Setting up a new repository and need standard labels
- Labels are inconsistent across managed repositories
- Adding new label categories (e.g., priority, agent, component)
- Post-reorg when label taxonomy needs updating

## Prerequisites

- `gh` CLI installed and authenticated
- Write access to target repositories
- `config/managed_repos.txt` for multi-repo sync

## Playbook

### 1. Define Standard Label Set

Establish the canonical label taxonomy:

| Category | Labels | Color |
|----------|--------|-------|
| Type | `bug`, `feature`, `chore`, `docs` | Red, Green, Yellow, Blue |
| Priority | `P0-critical`, `P1-high`, `P2-medium`, `P3-low` | #B60205, #D93F0B, #FBCA04, #0E8A16 |
| Status | `triage`, `in-progress`, `blocked`, `review` | #D4C5F9, #1D76DB, #E11D48, #BFD4F2 |
| Agent | `frontend`, `api`, `database`, `devops`, `security` | Per-agent color |
| Size | `size/S`, `size/M`, `size/L`, `size/XL` | Gradient grey |

### 2. Fetch Current Labels per Repo

```bash
gh label list --repo <owner>/<repo> --json name,color,description
```

Store results for comparison against the standard set.

### 3. Compare and Identify Gaps

For each repository, produce a diff:
- **Missing**: labels in standard set but not in repo
- **Extra**: labels in repo but not in standard set (keep, do not delete)
- **Mismatched**: same name but different color or description

### 4. Create Missing Labels

```bash
gh label create "<name>" --color "<hex>" --description "<desc>" --repo <owner>/<repo>
```

Process all missing labels. Skip any that already exist.

### 5. Update Mismatched Labels

```bash
gh label edit "<name>" --color "<hex>" --description "<desc>" --repo <owner>/<repo>
```

Only update color and description; never rename without confirmation.

### 6. Generate Sync Report

Output a markdown table per repo showing actions taken:

| Repo | Created | Updated | Already Correct | Extra (kept) |
|------|---------|---------|-----------------|--------------|

## Output

- Standard label definition file (JSON or YAML)
- Per-repo sync report
- Summary of total labels created/updated across all repos

## Review Checklist

- [ ] Standard label set defined and documented
- [ ] All managed repos audited for current labels
- [ ] Missing labels created with correct colors
- [ ] Mismatched colors/descriptions updated
- [ ] Extra repo-specific labels preserved (not deleted)
- [ ] Sync report generated for all repos

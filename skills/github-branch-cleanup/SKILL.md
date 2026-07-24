---
name: github-branch-cleanup
description: "Clean up stale branches merged to main or inactive for more than 30 days. List candidates, confirm with user, delete safely. Triggers: clean branches, prune branches, stale branches, branch cleanup"
---

# GitHub Branch Cleanup Playbook

## When to Use

- Repository has accumulated many stale or merged branches
- Post-release housekeeping
- Before a major milestone to reduce clutter
- Remote branch list is unwieldy

## Prerequisites

- `gh` CLI installed and authenticated
- Push/delete permissions on the repository
- Protected branches configured (main, test will be skipped)

## Playbook

### 1. List All Remote Branches

```bash
git fetch --prune
git branch -r --merged main | grep -v 'main\|test\|HEAD'
```

Collect branch name, last commit date, and author for each candidate.

### 2. Identify Merged Branches

Flag every branch fully merged into `main`. These are safe to delete — all commits are already in the mainline.

### 3. Identify Inactive Branches

For unmerged branches, check last commit date:

```bash
git log -1 --format="%ci %an" origin/<branch>
```

Flag branches with no commits in the last 30 days as stale. Note: these may contain unmerged work.

### 4. Generate Candidate List

Present a markdown table to the user:

| Branch | Status | Last Commit | Author | Safe to Delete |
|--------|--------|-------------|--------|----------------|

Separate merged (safe) from stale-unmerged (needs confirmation).

### 5. Confirm with User

Never delete without explicit confirmation. For stale-unmerged branches, warn that unmerged commits exist and suggest creating a backup tag if needed.

### 6. Delete Confirmed Branches

```bash
git push origin --delete <branch-name>
```

Process deletions in batches. Report each deletion result.

### 7. Clean Local References

```bash
git remote prune origin
git branch -d <local-branch>
```

Remove local tracking branches that no longer exist on remote.

## Output

- Table of all branches reviewed with status
- List of deleted branches
- List of preserved branches with reason
- Count summary: deleted / preserved / skipped

## Review Checklist

- [ ] Protected branches (main, test) excluded from deletion
- [ ] Merged branches identified correctly
- [ ] Stale threshold applied (30 days default)
- [ ] User confirmed deletions before execution
- [ ] Unmerged branches flagged with warning
- [ ] Local references pruned after remote deletion

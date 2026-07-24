---
name: github-pr-create
description: "Create a pull request with auto-generated description from git history. Summarize changes, categorize type, generate Summary and Test Plan sections. Triggers: create pr, open pr, new pull request, pr create, submit pr"
---

# GitHub PR Create Playbook

## When to Use
- A feature branch is ready for review and needs a pull request.
- User says "create pr", "open pr", or "ship it" (ship it delegates here).
- Branch has commits not yet in the base branch.

## Prerequisites
- `gh` CLI installed and authenticated.
- Current branch is not `main` — PRs go from feature/test branch into `main`.
- All changes committed (no uncommitted work).

## Playbook

### 1. Identify Branch and Base
- Run `git branch --show-current` to get the source branch.
- Default base is `main` unless user specifies otherwise.
- Verify remote tracking: `git rev-parse --abbrev-ref @{upstream}`.
- If no upstream, push with `git push -u origin <branch>`.

### 2. Gather Commit History
- Run `git log main..<branch> --oneline --no-merges` to list all new commits.
- Run `git diff main...<branch> --stat` to get changed file summary.
- Count files changed, insertions, deletions.

### 3. Categorize Change Type
- Scan commit prefixes for conventional commit types.
- `feat:` → Feature, `fix:` → Bug Fix, `refactor:` → Refactoring.
- `docs:` → Documentation, `test:` → Testing, `chore:` → Maintenance.
- If mixed, use the dominant type. If no convention, infer from diff content.

### 4. Generate PR Title
- Keep under 70 characters.
- Format: `<type>: <concise description>` (e.g., `feat: add user profile page`).
- Derive from commit messages or branch name if commits lack clarity.

### 5. Generate PR Body
- Structure with two sections:
  - **Summary**: 2-5 bullet points describing what changed and why.
  - **Test Plan**: Checklist of manual or automated verification steps.
- Include file change stats at the bottom.
- Add `Generated with Claude Code` footer.

### 6. Create the PR
- Run `gh pr create --title "<title>" --body "<body>" --base main`.
- Capture the returned PR URL.
- If draft requested, add `--draft` flag.

### 7. Post-Creation
- Report the PR URL to the user.
- Log the PR creation in `logs/claude_log.md` with timestamp.
- Update `state/STATE.md` if relevant to current milestone.

## Output
- Pull request created on GitHub with structured description.
- PR URL returned to user.
- Log entry in `logs/claude_log.md`.

## Review Checklist
- [ ] Branch pushed to remote with upstream tracking.
- [ ] PR title is concise and under 70 characters.
- [ ] Summary section accurately describes all changes.
- [ ] Test plan section has actionable verification steps.
- [ ] Correct base branch specified.
- [ ] PR URL confirmed accessible.

# Skill: Git Conflict Resolve

> **Agent:** Tech Lead / DevOps Specialist
> **Trigger keywords:** `conflict`, `merge conflict`, `pre-commit failed`
> **Output:** Resolved files, documented resolution

---

## Purpose

Detect and resolve git conflicts, pre-commit hook failures, and commit message
formatting issues. Proposes resolutions with rationale and documents the outcome
for team reference.

---

## Steps

### 1. Identify Conflict Type
- Run `git status` to detect the current state
- Classify the issue:
  - **Merge conflict:** `UU` (both modified) markers in `git status`
  - **Pre-commit hook failure:** exit code from last commit attempt
  - **Commit message format:** conventional commits validation failure
  - **Rebase conflict:** mid-rebase state detected

### 2. Merge Conflict Resolution
- For each conflicted file:
  - Read the file to find `<<<<<<<`, `=======`, `>>>>>>>` markers
  - Identify "ours" (current branch) and "theirs" (incoming branch) changes
  - Analyse both sides: are they editing the same logic or adjacent lines?
  - **Resolution strategy:**
    - Same logic, different approach -> pick the more complete/correct version
    - Adjacent lines, no semantic conflict -> combine both changes
    - Structural conflict (imports, exports) -> merge both, deduplicate
  - Apply the resolution, remove all conflict markers
  - Run linter/formatter on resolved files
- Stage resolved files with `git add`

### 3. Pre-Commit Hook Failure
- Read the hook output to identify the failing check:
  - **Lint errors:** run the linter, fix reported issues, re-stage
  - **Type errors:** run `npx tsc --noEmit` in Docker, fix type issues
  - **Test failures:** run tests in Docker, fix or flag failing tests
  - **Format errors:** run formatter (Prettier/ESLint --fix), re-stage
- After fixing, create a NEW commit (never amend the previous commit)

### 4. Commit Message Format
- Check against conventional commits format: `type(scope): description`
- Valid types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `test`, `ci`
- If message is malformed:
  - Parse intent from the original message
  - Suggest a corrected message
  - Apply correction and retry commit

### 5. Rebase Conflict
- Detect mid-rebase state from `.git/rebase-merge/` or `.git/rebase-apply/`
- For each conflicted step:
  - Resolve using same strategy as merge conflicts (Step 2)
  - Run `git rebase --continue` after resolution
- If rebase is too complex, suggest `git rebase --abort` and alternative strategy

### 6. Document Resolution
- Log the conflict and resolution to `logs/claude_log.md`:
  - Files affected, conflict type, resolution strategy chosen
  - Any manual review needed (flag for tech lead)
- If resolution involved non-trivial logic choices, add a code comment explaining why

---

## Abort Conditions
- If conflict involves files outside the project scope -> WARN, do not auto-resolve
- If both sides of a conflict contain significant new logic -> present both options
  to the user instead of auto-resolving
- Never force-push or use destructive git operations without explicit user approval

## Post-Completion
- Verify resolved state: `git status` shows no conflicts
- Run linter and tests to confirm resolution is valid
- Update `state/STATE.md` if conflict blocked a deployment
- Log action to `logs/claude_log.md`

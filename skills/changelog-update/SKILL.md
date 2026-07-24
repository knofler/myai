---
name: changelog-update
description: "Update CHANGELOG.md following Keep a Changelog format and semver. Triggers: changelog, release notes, what changed, version notes"
---

# Skill: Update CHANGELOG.md

Maintain a CHANGELOG.md that follows the Keep a Changelog specification and semver.

## Playbook

### 1. Read Recent Git History

- Run `git log --oneline` from the last tag or last changelog entry.
- If no tags exist, read all commits since project init.
- Collect commit messages, authors, and dates.

### 2. Categorize Changes

Sort each change into exactly one Keep a Changelog category:

- **Added** — new features or capabilities.
- **Changed** — modifications to existing functionality.
- **Deprecated** — features marked for future removal.
- **Removed** — features that were deleted.
- **Fixed** — bug fixes.
- **Security** — vulnerability patches or security improvements.

Omit categories that have no entries for this release.

### 3. Determine Version Number

- If the user specifies a version, use it.
- Otherwise, infer from the change categories:
  - Breaking changes or Removed -> major bump.
  - Added or Changed -> minor bump.
  - Fixed or Security only -> patch bump.
- Read current version from `package.json`, `pyproject.toml`, or last changelog header.

### 4. Read or Create CHANGELOG.md

- If CHANGELOG.md exists, read its current contents.
- If it does not exist, create it with the Keep a Changelog header:
  ```
  # Changelog
  All notable changes to this project will be documented in this file.
  The format is based on [Keep a Changelog](https://keepachangelog.com/).
  ```

### 5. Write the New Version Entry

- Insert the new version block below the header and above previous entries.
- Format:
  ```
  ## [X.Y.Z] - YYYY-MM-DD

  ### Added
  - Description of addition.

  ### Fixed
  - Description of fix.
  ```

### 6. Save and Verify

- Write CHANGELOG.md to project root.
- Verify the file parses as valid markdown.
- Log action to `logs/claude_log.md`.
- Update `state/STATE.md` with the new version number.

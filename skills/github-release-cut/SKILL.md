---
name: github-release-cut
description: "Cut a release with auto-generated changelog from conventional commits. Determine semver bump, generate release notes, create GitHub release, and tag the commit. Triggers: cut release, new release, release, tag release, ship release"
---

# GitHub Release Cut Playbook

## When to Use
- A set of changes on main is ready to be released.
- User says "cut release", "new release", or "tag release".
- After a successful merge of a significant feature or fix batch.

## Prerequisites
- `gh` CLI installed and authenticated.
- On the `main` branch with all changes merged.
- Commits follow conventional commit format (feat:, fix:, etc.).

## Playbook

### 1. Determine Current Version
- Check for existing tags: `git tag --list 'v*' --sort=-version:refname | head -1`.
- If no tags exist, start at `v0.1.0`.
- Parse the latest tag into major, minor, patch components.

### 2. Analyze Commits Since Last Release
- Run `git log <last-tag>..HEAD --oneline --no-merges`.
- Categorize each commit by conventional commit prefix.
- Count: features (feat:), fixes (fix:), breaking changes (BREAKING CHANGE or !).

### 3. Determine Version Bump
- **Major** bump: Any commit contains `BREAKING CHANGE` in body or `!` after type.
- **Minor** bump: At least one `feat:` commit and no breaking changes.
- **Patch** bump: Only `fix:`, `docs:`, `chore:`, `refactor:`, `test:` commits.
- Calculate the new version string (e.g., `v1.2.0` → `v1.3.0`).

### 4. Generate Changelog
- Group commits into sections:
  - **Breaking Changes** (if any) — listed first with migration notes.
  - **Features** — all `feat:` commits.
  - **Bug Fixes** — all `fix:` commits.
  - **Other** — docs, chore, refactor, test commits.
- Format each entry as: `- <commit message> (<short-sha>)`.
- Include contributor list from `git shortlog -sn <last-tag>..HEAD`.

### 5. Create Git Tag
- Run `git tag -a <new-version> -m "Release <new-version>"`.
- Push the tag: `git push origin <new-version>`.

### 6. Create GitHub Release
- Run `gh release create <new-version> --title "<new-version>" --notes "<changelog>"`.
- If pre-release, add `--prerelease` flag.
- Attach any build artifacts if applicable.

### 7. Post-Release
- Update `state/STATE.md` with the new version and release date.
- Log the release in `logs/claude_log.md` with version and commit count.
- Notify the user with the release URL and changelog summary.

## Output
- Git tag created and pushed.
- GitHub release published with structured changelog.
- State files updated with new version.

## Review Checklist
- [ ] Version bump follows semver rules correctly.
- [ ] All commits since last tag are included in changelog.
- [ ] Breaking changes are highlighted prominently.
- [ ] Git tag matches the GitHub release version.
- [ ] Release notes are readable and well-organized.
- [ ] State files updated with release information.

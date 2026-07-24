---
name: content-changelog-gen
description: "Auto-generate changelog from git commits. Parse conventional commits, group by type, link PRs. Triggers: generate changelog, auto changelog, changelog from commits, release notes generate, commit history"
---
# Changelog Generation Playbook

## When to Use
- Preparing a new release and need release notes
- Generating a changelog for a time period or tag range
- Setting up automated changelog generation in CI
- Catching up on missed changelog entries

## Prerequisites
- Git repository with commit history
- Conventional commit format used (feat:, fix:, chore:, docs:, etc.)
- Previous version tag or date range to generate from
- CHANGELOG.md exists or will be created

## Playbook

### 1. Determine Scope
- Identify the range: last tag to HEAD, or between two tags
- Run `git log --oneline <from>..<to>` to preview commits
- Confirm the version number for this release (semver)
- Check for breaking changes that require a major bump

### 2. Parse Conventional Commits
- Extract commit type prefix: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`
- Extract scope if present: `feat(auth):` -> scope is `auth`
- Extract description (the text after the colon)
- Identify breaking changes: `BREAKING CHANGE:` in body or `!` after type
- Extract PR numbers from commit messages or merge commits

### 3. Group by Category
- **Added** (`feat`): New features and capabilities
- **Fixed** (`fix`): Bug fixes
- **Changed** (`refactor`, `perf`): Code changes that are not new features or fixes
- **Documentation** (`docs`): Documentation updates
- **Security** (`security`): Security-related changes
- **Deprecated**: Features marked for removal
- **Removed**: Features that were removed
- **Breaking Changes**: Changes that break backward compatibility

### 4. Format as Keep a Changelog
- Use Keep a Changelog format (https://keepachangelog.com)
- Header: `## [version] - YYYY-MM-DD`
- Group entries under category headers (### Added, ### Fixed, etc.)
- Each entry: `- Description of change ([#PR](link)) by @author`
- Link PR numbers to GitHub PR URLs
- Link version header to diff comparison URL

### 5. Determine Version Bump
- Breaking changes -> major version bump
- New features -> minor version bump
- Bug fixes only -> patch version bump
- Apply semver rules strictly

### 6. Update CHANGELOG.md
- Insert new version section at the top (below header)
- Keep `## [Unreleased]` section at the very top
- Update comparison links at the bottom of the file
- Preserve all previous entries unchanged

### 7. Verify and Commit
- Review generated entries for accuracy and clarity
- Ensure no duplicate entries
- Check that all significant changes are represented
- Commit changelog update with version tag

## Output
- Updated CHANGELOG.md with new version section
- Version bump recommendation (major/minor/patch)
- List of commits included in this release

## Review Checklist
- [ ] All commits in range are accounted for
- [ ] Entries are grouped by correct category
- [ ] PR links resolve to correct pull requests
- [ ] Version number follows semver based on change types
- [ ] Breaking changes are prominently noted
- [ ] Keep a Changelog format followed correctly
- [ ] Previous entries are preserved unchanged

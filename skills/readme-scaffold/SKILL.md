---
name: readme-scaffold
description: "Scaffold a comprehensive README.md for a project. Triggers: README, project readme, scaffold readme, documentation setup"
---

# Skill: Scaffold README.md

Generate a complete, production-quality README.md for the current project.

## Playbook

### 1. Gather Project Context

- Read `package.json`, `pyproject.toml`, or equivalent for project name, version, and description.
- Read `state/STATE.md` and `documentation/AI_RULES.md` for tech stack and project conventions.
- Scan `src/` or project root to identify major modules and entry points.

### 2. Write Project Header

- Add project title as H1.
- Add one-line description paragraph.
- Add tech stack badges (framework, language, CI status, license).

### 3. Write Prerequisites Section

- List required runtime versions (Node.js, Python, etc.).
- List required global tools (npm, pnpm, Docker, etc.).
- Note any external service dependencies (databases, APIs).

### 4. Write Installation Steps

- Clone command.
- Dependency install command.
- Any post-install setup scripts.

### 5. Write Environment Setup

- Copy `.env.example` to `.env` instruction.
- Document each required environment variable with description and example value.
- Note which variables are optional vs required.

### 6. Write Usage Examples

- Dev server start command.
- Build command.
- Common CLI commands or scripts.

### 7. Write API Reference Link

- If API docs exist in `docs/` or `documentation/`, link to them.
- Otherwise note "See API documentation (coming soon)".

### 8. Write Contributing Guidelines

- Branch naming convention.
- Commit message format.
- PR process summary.
- Link to full CONTRIBUTING.md if it exists.

### 9. Write License Section

- Read LICENSE file and reference it.
- If no LICENSE file exists, note "License: TBD".

### 10. Save and Verify

- Write README.md to project root.
- Verify all sections render correctly in markdown.
- Log action to `logs/claude_log.md`.

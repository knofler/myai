---
name: standards-enforcement
description: "Enforce coding standards across the codebase. Scan for violations of documentation/AI_RULES.md, linting config, TypeScript strictness, naming patterns, and import conventions. Triggers: standards, coding standards, enforce standards, lint, code quality, conventions"
---

# Standards Enforcement Playbook

## 1. Load Standards

- Read `documentation/AI_RULES.md` for project-specific mandates.
- Check for existing lint config (`.eslintrc`, `biome.json`, `.prettierrc`).
- Check `tsconfig.json` for TypeScript compiler options.

## 2. Verify Linting Setup

- Confirm a linter is configured and has a run script in `package.json`.
- Verify Prettier or equivalent formatter is configured.
- Check that lint-staged and pre-commit hooks exist (husky, lefthook).

## 3. Check TypeScript Strictness

- Verify `strict: true` in `tsconfig.json`.
- Check for `any` usage -- flag excessive `any` types.
- Verify `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`.

## 4. Check Naming Conventions

- Files: kebab-case for utilities, PascalCase for components.
- Variables/functions: camelCase.
- Constants: UPPER_SNAKE_CASE.
- Types/interfaces: PascalCase with descriptive names.

## 5. Check Import Conventions

- Verify import order: external libs, internal modules, relative imports.
- Check for circular imports.
- Verify path aliases are used consistently (e.g., `@/` prefix).

## 6. Check File Organization

- Verify folder structure matches project conventions.
- Check that test files are co-located or in a parallel `__tests__` directory.
- Verify no business logic in route/page files (separation of concerns).

## 7. Output Violations Report

- List each violation: file, line, rule, description, fix suggestion.
- Group by severity: **Error** (must fix), **Warning** (should fix), **Info** (consider).
- Provide a summary count at the top.

## 8. Update State

- Update `state/STATE.md` with standards compliance status.
- Log the enforcement run in `logs/claude_log.md`.

## 9. Review Checklist

- [ ] documentation/AI_RULES.md loaded and applied.
- [ ] Lint config exists and is runnable.
- [ ] TypeScript strict mode verified.
- [ ] Naming conventions checked.
- [ ] Import conventions checked.

---
name: analysis-dead-code
description: "Find unused exports, functions, variables, and components. Trace all imports to build a dependency graph and produce a safe removal list with impact assessment. Triggers: dead code, unused code, unused exports, unreachable code, tree shake"
---

# Dead Code Analysis Playbook

## When to Use

- Codebase has grown and unused code is suspected
- Before a major release to reduce bundle size
- After removing a feature to clean up residual code
- As part of a tech debt reduction initiative

## Prerequisites

- Source code accessible (TypeScript/JavaScript project)
- Understanding of entry points (pages, API routes, scripts)
- TypeScript compiler available for type-checking after removal

## Playbook

### 1. Identify All Entry Points

Map every file that serves as an entry point and cannot be "imported":
- Next.js pages (`src/app/**/page.tsx`, `src/pages/**`)
- API routes (`src/app/api/**`, `src/pages/api/**`)
- Scripts (`scripts/`, `package.json` scripts)
- Config files (`next.config.js`, `tailwind.config.ts`)
- Test files (`**/*.test.*`, `**/*.spec.*`)

### 2. Build the Import Graph

Starting from entry points, trace every import statement recursively. Build a directed graph of file dependencies. Record which exports from each file are actually consumed.

### 3. Find Unused Exports

For each file, compare its exported symbols against the import graph:
- **Unused named exports**: exported but never imported anywhere
- **Unused default exports**: file is imported but default export unused
- **Entirely unused files**: no file imports this module at all

### 4. Find Unused Internal Code

Within each file, identify:
- **Unused functions**: defined but never called within the file or exported
- **Unused variables/constants**: declared but never referenced
- **Unused type definitions**: types/interfaces never used
- **Unreachable code**: code after return/throw statements

### 5. Assess Removal Impact

For each dead code candidate, evaluate:
- **Safe to remove**: no references anywhere, not dynamically imported
- **Possibly dynamic**: could be referenced via `require()`, string interpolation, or reflection
- **Side effects**: module-level side effects that run on import (be cautious)

Categorize as: `safe`, `review-needed`, or `keep` (has side effects).

### 6. Produce Removal List

Generate a prioritized list:

| File | Symbol | Type | Lines | Status | Impact |
|------|--------|------|-------|--------|--------|
| src/utils/old.ts | formatDate | function | 15-30 | safe | none |
| src/components/Legacy.tsx | (entire file) | component | 1-85 | safe | -2.1KB |

### 7. Verify Removal Safety

After removing dead code, run:
- TypeScript compiler (`npx tsc --noEmit`) to catch broken references
- Test suite to verify no runtime dependencies
- Build to confirm bundle compiles

## Output

- Dead code inventory with file, symbol, type, and line numbers
- Removal list categorized by safety level
- Estimated bundle size savings
- Verification results after removal

## Review Checklist

- [ ] All entry points identified correctly
- [ ] Import graph traced completely (including dynamic imports)
- [ ] Unused exports flagged with correct status
- [ ] Side-effect modules handled carefully (not auto-removed)
- [ ] TypeScript compilation passes after proposed removals
- [ ] Test suite passes after proposed removals

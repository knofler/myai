---
name: dev-scaffold-component
description: "Scaffold a React component with TypeScript, Tailwind, Storybook story, and unit test. Triggers: 'scaffold component', 'new component', 'create component', 'generate component', 'component template'."
---

# Component Scaffold Playbook

## When to Use
- Building a new reusable UI component
- Adding a feature-specific component that needs tests and documentation
- Establishing component patterns for the team to follow

## Prerequisites
- React + TypeScript project with Tailwind CSS configured
- Component name and location decided (e.g., `components/ui/` vs `components/features/`)
- Storybook configured in the project (optional but recommended)
- Testing framework set up (Jest or Vitest with Testing Library)

## Playbook

### 1. Determine Naming and Location
- Use PascalCase for component name (e.g., `DataTable`, `UserAvatar`)
- Create component directory: `components/{category}/{ComponentName}/`
- Standard files: `index.ts`, `{ComponentName}.tsx`, `{ComponentName}.test.tsx`, `{ComponentName}.stories.tsx`
- Check project conventions — some prefer flat files, others prefer directories

### 2. Create Component File
- `{ComponentName}.tsx` with:
  - TypeScript interface for props (exported as `{ComponentName}Props`)
  - Functional component with `forwardRef` if it wraps a native element
  - Tailwind classes using `cn()` utility for conditional styling
  - Default export of the component
  - JSDoc comment describing the component purpose and usage example

### 3. Create Barrel Export
- `index.ts` that re-exports the component and its props type:
  ```
  export { default as ComponentName } from './ComponentName'
  export type { ComponentNameProps } from './ComponentName'
  ```
- Update parent `index.ts` if one exists (e.g., `components/ui/index.ts`)

### 4. Create Unit Test
- `{ComponentName}.test.tsx` with:
  - Render test: component mounts without errors
  - Props test: key props produce expected output
  - Interaction test: click/input handlers fire correctly
  - Accessibility test: no a11y violations (using jest-axe if available)
  - Edge case: empty/null props, long strings, missing optional props

### 5. Create Storybook Story
- `{ComponentName}.stories.tsx` with:
  - Default story showing standard usage
  - Variant stories for each visual state (sizes, colors, disabled)
  - Interactive story with args/controls for prop exploration
  - Story for edge cases (empty state, loading, error)
  - Use CSF3 format with `meta` default export

### 6. Verify Integration
- Run TypeScript check to confirm no type errors
- Run tests to confirm all pass
- Build Storybook to confirm stories render (if Storybook is set up)
- Verify Tailwind classes are being purged correctly

## Output
- `{ComponentName}.tsx` — the component implementation
- `{ComponentName}.test.tsx` — unit tests with full coverage
- `{ComponentName}.stories.tsx` — Storybook stories for all variants
- `index.ts` — barrel export
- Updated parent index if applicable

## Review Checklist
- [ ] Props interface is exported and well-documented
- [ ] Component uses Tailwind with `cn()` for conditional classes
- [ ] Tests cover render, props, interaction, and accessibility
- [ ] Storybook stories show all meaningful variants
- [ ] Barrel export and parent index updated
- [ ] No TypeScript errors, all tests pass

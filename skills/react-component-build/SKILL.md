---
name: react-component-build
description: "Build a reusable React component with TypeScript and Tailwind CSS. Triggers: component, React component, build component, new component, UI component"
---

# Skill: Build a React Component

Create a well-structured, typed, and styled React component.

## Playbook

### 1. Define Component Scope

- Confirm the component name and purpose.
- Determine where it fits: `src/components/ui/`, `src/components/layout/`, or a feature directory.
- Check for existing similar components to avoid duplication.

### 2. Define Props Interface

- Create a TypeScript interface named `{ComponentName}Props`.
- Include all required and optional props with JSDoc comments.
- Extend native HTML element props where appropriate using `ComponentPropsWithoutRef`.
- Example:
  ```typescript
  interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
    /** Visual style variant */
    variant?: 'primary' | 'secondary' | 'ghost';
    /** Show loading spinner */
    isLoading?: boolean;
  }
  ```

### 3. Implement the Component

- Use function declaration with explicit return type.
- Destructure props with sensible defaults.
- Apply Tailwind CSS classes for styling.
- Use `cn()` or `clsx()` for conditional class merging if available.
- Handle all states: default, hover, focus, disabled, loading, error.
- Add `'use client'` directive only if the component uses hooks or browser APIs.

### 4. Add Accessibility

- Use semantic HTML elements (`button`, `nav`, `article`, not generic `div`).
- Add ARIA attributes where needed (`aria-label`, `role`, etc.).
- Ensure keyboard navigation works (focus management, tab order).
- Meet WCAG 2.1 AA contrast requirements.

### 5. Export the Component

- Use named export (not default) for consistency.
- Add to barrel export file (`index.ts`) in the component directory.
- If no barrel file exists, create one.

### 6. Write Basic Test

- Create `{ComponentName}.test.tsx` alongside the component.
- Test: renders without crashing, displays expected content, handles click/interaction.
- Use React Testing Library patterns.

### 7. Verify

- Confirm component renders in isolation.
- Check TypeScript compiles without errors.
- Log action to `logs/claude_log.md`.

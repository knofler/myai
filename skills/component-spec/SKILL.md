---
name: component-spec
description: "Write UI component specifications. Define props, variants, states, responsive behavior, accessibility requirements, and keyboard interactions. Triggers: component spec, UI spec, component design, component definition, widget spec"
---

# Component Spec Playbook

## 1. Define Component Purpose

- State what the component does in one sentence.
- Identify where it appears in the UI (pages, layouts, other components).
- Note if it replaces or extends an existing component.

## 2. Define Props and Variants

- List all props with name, type, default, and description.
- Define visual variants (e.g., `variant: 'primary' | 'secondary' | 'ghost'`).
- Define size variants (e.g., `size: 'sm' | 'md' | 'lg'`).
- Use TypeScript interface format:

```typescript
interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}
```

## 3. Define States

- **Default**: Normal resting state.
- **Hover**: Visual change on mouse hover.
- **Focus**: Visible focus ring for keyboard navigation.
- **Active/Pressed**: Visual feedback on click/tap.
- **Disabled**: Greyed out, non-interactive.
- **Loading**: Spinner or skeleton, non-interactive.
- **Error**: Red border or icon for validation failure.

## 4. Create Visual Mockup

- Provide an ASCII layout or detailed text description.
- Show each variant and state.
- Include spacing and alignment notes.

## 5. Define Responsive Behavior

- How the component adapts at each breakpoint (sm, md, lg, xl).
- Note any props that change per breakpoint.
- Specify if the component is hidden at certain breakpoints.

## 6. Specify Accessibility

- Required ARIA role and attributes.
- Label strategy (visible label, `aria-label`, or `aria-labelledby`).
- Color contrast compliance (4.5:1 for text, 3:1 for large text).

## 7. List Keyboard Interactions

- Tab: Focus order.
- Enter/Space: Activation.
- Escape: Dismiss (for overlays).
- Arrow keys: Navigation (for lists, tabs, menus).

## 8. Output

- Save the spec to `AI/design/`.
- Log the session in `logs/claude_log.md`.

## 9. Review Checklist

- [ ] All props documented with types and defaults.
- [ ] All states defined.
- [ ] Responsive behavior specified.
- [ ] Accessibility requirements listed.
- [ ] Keyboard interactions documented.

---
name: design-system-setup
description: "Set up a design system with Tailwind CSS, React, and Next.js. Define tokens, create base components, and document usage patterns. Triggers: design system, component library, UI kit, design tokens, style guide"
---

# Design System Setup Playbook

## 1. Audit Existing Setup

- Check for existing `tailwind.config.js` or `tailwind.config.ts`.
- Review current component directory structure.
- Read `documentation/AI_RULES.md` for any UI/styling mandates.

## 2. Define Color Palette

- Define semantic colors in Tailwind config: `primary`, `secondary`, `accent`, `neutral`.
- Include state colors: `success`, `warning`, `error`, `info`.
- Provide light/dark variants (50-950 scale or explicit light/dark tokens).
- Ensure all color pairs meet WCAG 2.1 AA contrast (4.5:1 for text).

## 3. Define Typography Scale

- Set font families: sans, serif, mono.
- Define size scale: `xs`, `sm`, `base`, `lg`, `xl`, `2xl`, `3xl`, `4xl`.
- Set line heights and letter spacing for each size.
- Define heading styles (h1-h6) with consistent rhythm.

## 4. Define Spacing and Sizing

- Use Tailwind's default 4px grid or customize.
- Define consistent border-radius tokens: `sm`, `md`, `lg`, `full`.
- Define shadow tokens: `sm`, `md`, `lg`, `xl`.

## 5. Create Base Components

Build reusable React components with Tailwind:

- **Button**: Variants (primary, secondary, ghost, danger), sizes (sm, md, lg), loading state.
- **Input**: Text, email, password, with label, error message, disabled state.
- **Card**: Header, body, footer sections, with optional border/shadow.
- **Modal**: Overlay, content, close button, focus trap, ESC to close.

## 6. Document Usage Patterns

- Create a usage guide with code examples for each component.
- Document prop types and default values.
- If Storybook is available, create stories for each component and variant.

## 7. Save and Update

- Save design system docs to `AI/design/`.
- Update `state/STATE.md` with design system status.
- Log the session in `logs/claude_log.md`.

## 8. Review Checklist

- [ ] Color palette meets contrast requirements.
- [ ] Typography scale is consistent.
- [ ] Base components are accessible (keyboard, ARIA).
- [ ] All components have TypeScript props interface.
- [ ] Usage documentation written.

---
name: tailwind-config-extend
description: "Extend Tailwind CSS configuration. Add custom colors, fonts, spacing, breakpoints, and plugins. Update PostCSS config if needed. Triggers: Tailwind config, extend Tailwind, custom Tailwind, Tailwind theme, Tailwind plugin"
---

# Tailwind Config Extension Playbook

## 1. Identify Customization Needs

- Clarify what needs to be added or changed (colors, fonts, spacing, etc.).
- Read existing `tailwind.config.js` or `tailwind.config.ts`.
- Check `documentation/AI_RULES.md` for any styling mandates.

## 2. Update Tailwind Config

- Open `tailwind.config.js` (or `.ts`).
- Use `theme.extend` to add without overriding defaults:

```js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: { 50: '#f0f9ff', 500: '#3b82f6', 900: '#1e3a5f' },
      },
      fontFamily: {
        display: ['Inter', 'sans-serif'],
      },
    },
  },
};
```

## 3. Add Custom Colors

- Define semantic color scales (primary, secondary, accent).
- Include full shade ranges (50, 100, 200, ..., 900, 950).
- Ensure contrast ratios meet WCAG 2.1 AA (4.5:1 for text).

## 4. Add Custom Fonts

- Add font family to `fontFamily` in config.
- Import font files or Google Fonts in layout/global CSS.
- Define fallback stack (e.g., `['Inter', 'system-ui', 'sans-serif']`).

## 5. Add Custom Spacing/Breakpoints

- Extend spacing for non-standard values: `'18': '4.5rem'`.
- Add custom breakpoints if design requires them:
  ```js
  screens: { 'xs': '475px', '3xl': '1920px' }
  ```

## 6. Configure Plugins

- Add official plugins as needed:
  - `@tailwindcss/forms` for form styling.
  - `@tailwindcss/typography` for prose content.
  - `@tailwindcss/container-queries` for container queries.
- Install via npm and add to `plugins` array in config.

## 7. Update PostCSS Config (if needed)

- Verify `postcss.config.js` includes `tailwindcss` and `autoprefixer`.
- Add any required PostCSS plugins (e.g., `postcss-import`).

## 8. Verify Changes

- Run the dev server and inspect rendered output.
- Check that new utility classes generate correctly.
- Verify no existing styles are broken by the changes.
- Test responsive behavior at all breakpoints.

## 9. Update State

- Update `state/STATE.md` with Tailwind config changes.
- Log the session in `logs/claude_log.md`.

## 10. Review Checklist

- [ ] Used `theme.extend` (not `theme` override) to preserve defaults.
- [ ] Custom colors meet contrast requirements.
- [ ] Fonts load correctly with fallbacks.
- [ ] Plugins installed and configured.
- [ ] PostCSS config verified.
- [ ] Changes render correctly in browser.

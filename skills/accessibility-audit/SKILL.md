---
name: accessibility-audit
description: "Perform accessibility audit against WCAG 2.1 AA. Check semantic HTML, ARIA, color contrast, keyboard navigation, focus management, and screen reader compatibility. Triggers: accessibility, a11y, WCAG, screen reader, keyboard navigation, accessible"
---

# Accessibility Audit Playbook

## 1. Define Audit Scope

- Identify pages or components to audit.
- Read `documentation/AI_RULES.md` for any accessibility mandates.
- Target standard: **WCAG 2.1 Level AA**.

## 2. Check Semantic HTML

- Verify correct heading hierarchy (h1 -> h2 -> h3, no skipped levels).
- Confirm use of semantic elements: `<nav>`, `<main>`, `<article>`, `<section>`, `<aside>`.
- Check that `<button>` is used for actions, `<a>` for navigation.
- Verify lists use `<ul>`/`<ol>`/`<li>`, not divs.
- Confirm forms use `<label>` elements linked to inputs.

## 3. Verify ARIA Labels and Roles

- Check that interactive elements have accessible names.
- Verify custom widgets have appropriate ARIA roles.
- Confirm `aria-live` regions for dynamic content updates.
- Check that `aria-hidden` is not hiding visible interactive content.

## 4. Check Color Contrast

- **Normal text**: Minimum 4.5:1 contrast ratio.
- **Large text** (18px+ or 14px+ bold): Minimum 3:1 ratio.
- **UI components and icons**: Minimum 3:1 ratio.
- Verify information is not conveyed by color alone.

## 5. Verify Keyboard Navigation

- Tab through the entire page; confirm logical focus order.
- Verify all interactive elements are reachable via keyboard.
- Check that focus is never trapped (except intentional modals).
- Confirm visible focus indicators on all focusable elements.

## 6. Check Focus Management

- After modal open: focus moves to modal.
- After modal close: focus returns to trigger element.
- After route change: focus moves to main content or page title.
- Skip-to-content link present and functional.

## 7. Verify Screen Reader Compatibility

- Check that images have meaningful `alt` text (or `alt=""` for decorative).
- Verify form error messages are announced.
- Confirm that status updates use `aria-live` or role="status".
- Check that tables have proper `<th>` and scope attributes.

## 8. Test with axe-core

- If axe-core is available, run it against each page.
- Document each finding with severity and WCAG criterion.
- If axe-core is not installed, recommend adding it.

## 9. Output Audit Report

- List each issue: element, WCAG criterion, severity, description, fix.
- Summary: total issues by severity (critical, serious, moderate, minor).
- Save report to `AI/design/`.
- Update `state/STATE.md` with accessibility status.
- Log the audit in `logs/claude_log.md`.

## 10. Review Checklist

- [ ] Semantic HTML verified.
- [ ] ARIA usage correct and complete.
- [ ] Color contrast meets AA thresholds.
- [ ] Full keyboard navigation works.
- [ ] Focus management correct for modals and route changes.
- [ ] Screen reader compatibility verified.

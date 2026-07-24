---
name: nextjs-page-create
description: "Create a Next.js App Router page with loading and error boundaries. Triggers: page, route, Next.js page, new page, app router page"
---

# Skill: Create a Next.js Page / Route

Scaffold a complete Next.js App Router page with metadata, loading state, and error boundary.

## Playbook

### 1. Determine Route Path

- Confirm the desired URL path (e.g., `/dashboard/settings`).
- Map to file system: `src/app/dashboard/settings/`.
- Check for route conflicts with existing pages.

### 2. Choose Component Type

- **Server Component** (default): data fetching, no interactivity.
- **Client Component**: user interactions, hooks, browser APIs.
- If both are needed, create a server component page that imports client sub-components.

### 3. Create page.tsx

- Create the directory structure under `src/app/`.
- Add `page.tsx` with:
  - Metadata export (`export const metadata` or `generateMetadata`).
  - TypeScript props interface for any route params.
  - Main component with semantic HTML and Tailwind CSS classes.
  - Data fetching if server component (async component or fetch calls).

### 4. Create loading.tsx

- Add `loading.tsx` in the same directory.
- Implement a skeleton/spinner UI using Tailwind.
- Match the layout structure of the page for smooth transitions.

### 5. Create error.tsx

- Add `error.tsx` in the same directory.
- Mark as `'use client'` (required by Next.js).
- Accept `error` and `reset` props.
- Display a user-friendly error message with a retry button.

### 6. Add Layout (If Needed)

- If this route needs a unique layout, create `layout.tsx`.
- Wrap children with shared UI (sidebar, header, etc.).
- Reuse existing layout components from `src/components/`.

### 7. Add to Navigation

- Find the navigation component (header, sidebar, or nav bar).
- Add a link to the new route using `next/link`.
- Set active state styling if the nav supports it.

### 8. Verify

- Confirm the page renders without errors.
- Check metadata appears correctly.
- Log action to `logs/claude_log.md`.

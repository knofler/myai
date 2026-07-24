# Design System: Tailwind CSS + shadcn/ui

> **Standard for all repos.** Every Next.js project in this framework uses Tailwind CSS (v4 preferred) + shadcn/ui for UI components. This document is the authoritative reference — AI agents, scaffold commands, and code reviews enforce it.

---

## 1. Why This Standard

| Problem | Solution |
|---------|----------|
| Every project invents its own CSS naming conventions | Tailwind's utility classes are the naming convention |
| No shared component library across repos | shadcn/ui provides copy-paste components owned by each repo |
| Inconsistent spacing, colors, typography | Tailwind config enforces a design token scale |
| Accessibility is bolted on after the fact | shadcn/ui components ship with ARIA, keyboard nav, focus management |
| Dead CSS accumulates over time | Tailwind purges unused classes at build time (~10-30KB production CSS) |
| Dark mode is an afterthought | Tailwind `dark:` prefix makes dark mode a first-class concern |

---

## 2. Architecture Overview

```
src/
  app/
    globals.css              <-- @import "tailwindcss" + @theme design tokens
    layout.tsx               <-- Root layout, font loading
  components/
    ui/                      <-- shadcn components (owned source code, NOT node_modules)
      button.tsx
      card.tsx
      dialog.tsx
      ...
    Header.tsx               <-- Project-specific components (use shadcn + Tailwind)
    EventCard.tsx
  lib/
    utils.ts                 <-- cn() helper for class merging
postcss.config.mjs           <-- PostCSS with @tailwindcss/postcss
components.json              <-- shadcn config (style, paths, aliases)
```

### What Does NOT Exist

```
tailwind.config.ts           <-- Not needed in v4 (CSS-first config via @theme)
src/styles/*.module.css      <-- No CSS modules
*.styled.ts                  <-- No styled-components / emotion
```

---

## 3. Core Dependencies

```json
{
  "dependencies": {
    "tailwind-merge": "^2.0.0",
    "clsx": "^2.0.0",
    "class-variance-authority": "^0.7.0"
  },
  "devDependencies": {
    "tailwindcss": "^4.0.0",
    "@tailwindcss/postcss": "^4.0.0",
    "postcss": "^8.5.0"
  }
}
```

**Tailwind v4** (released Jan 2025) uses CSS-first configuration — no `tailwind.config.ts` file. Config lives in `globals.css` via `@theme`. If a project needs v3 compatibility, see Section 8.

**shadcn/ui** is NOT a dependency. It's a CLI that copies component source code into your project:

```bash
# Inside Docker container only
docker compose exec app npx shadcn@latest init
docker compose exec app npx shadcn@latest add button dialog card
```

---

## 4. Design Tokens

All colors, fonts, spacing, and sizing are defined as design tokens in `globals.css`. Never hardcode values in components.

### Token Categories

| Category | Token Pattern | Example Class |
|----------|--------------|---------------|
| Brand colors | `--color-brand-*` | `bg-brand-accent`, `text-brand-muted` |
| Font families | `--font-*` | `font-primary`, `font-mono` |
| Spacing | `--spacing-*` | Custom via `@theme` |
| Sizing | `--width-*` | `max-w-content` |

### Default Token Set

Every project starts with these tokens (override values per repo):

```css
@theme {
  /* Brand Colors */
  --color-brand-primary: #000000;
  --color-brand-secondary: #1a1a1a;
  --color-brand-accent: #3b82f6;
  --color-brand-accent-hover: #2563eb;
  --color-brand-muted: #6b7280;
  --color-brand-error: #ef4444;
  --color-brand-success: #22c55e;
  --color-brand-warning: #f59e0b;

  /* Typography */
  --font-primary: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  /* Layout */
  --spacing-header: 64px;
  --width-content-max: 1280px;
}
```

### Customizing Per Project

Override tokens in `globals.css` — the whole app updates:

```css
@theme {
  --color-brand-accent: #00B14C;          /* Powerhouse green */
  --font-primary: 'Powerhouse Filar', -apple-system, sans-serif;
  --width-content-max: 1440px;
}
```

---

## 5. Rules (Enforced by AI Agents)

These rules are mandatory. AI agents (Claude, Gemini, Copilot) enforce them during code generation and code review.

### Styling

1. **Utility-first.** Use Tailwind classes directly in JSX. Do NOT create CSS files for component styling.
2. **No inline styles.** Never use `style={{ }}` props. Use Tailwind classes instead. Only exception: truly dynamic values (e.g., `style={{ width: \`${percent}%\` }}`).
3. **Design tokens only.** All colors, fonts, and spacing come from the `@theme` block. Never hardcode hex values — use `bg-brand-accent`, not `bg-[#00B14C]`.
4. **cn() for conditional classes.** Use the `cn()` utility from `@/lib/utils` for conditional class merging. Never do string concatenation.
5. **No @apply in components.** Avoid `@apply` in CSS files — it defeats utility-first. Only use `@apply` in `@layer base` for global defaults (body font, link underlines).

### Components

6. **shadcn before custom.** Before building a component from scratch, check if shadcn has one: `docker compose exec app npx shadcn@latest add [component]`. Modify the shadcn component rather than building a parallel one.
7. **Component location.** shadcn components: `src/components/ui/`. Project components: `src/components/`. Never mix them.
8. **Compose, don't wrap.** Build project components by composing shadcn primitives, not by wrapping them in unnecessary abstraction layers.

### Responsive & Accessibility

9. **Mobile-first.** Mobile layout is the default. Use `md:` and `lg:` prefixes for larger screens.
10. **Dark mode.** Use `dark:` prefix for dark mode variants. Define dark tokens in the CSS config.
11. **Accessibility built-in.** shadcn components include ARIA attributes, keyboard navigation, and focus management. Do not remove or override these.

### Docker

12. **No host npm.** All Tailwind/shadcn commands run inside Docker: `docker compose exec app npx shadcn@latest add button`.

---

## 6. Setup Steps (New Project)

### Step 1: Install Dependencies

```bash
docker compose exec app npm install -D tailwindcss @tailwindcss/postcss postcss
docker compose exec app npm install tailwind-merge clsx class-variance-authority
```

### Step 2: Create `postcss.config.mjs`

```js
/** @type {import('postcss').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
export default config;
```

### Step 3: Create `globals.css`

```css
@import "tailwindcss";

/* -- Design Tokens (override per project) -- */
@theme {
  --color-brand-primary: #000000;
  --color-brand-secondary: #1a1a1a;
  --color-brand-accent: #3b82f6;
  --color-brand-accent-hover: #2563eb;
  --color-brand-muted: #6b7280;
  --color-brand-error: #ef4444;
  --color-brand-success: #22c55e;
  --color-brand-warning: #f59e0b;

  --font-primary: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  --spacing-header: 64px;
  --width-content-max: 1280px;
}

/* -- Base layer -- */
@layer base {
  body {
    @apply font-primary text-brand-primary antialiased;
  }
}
```

### Step 4: Init shadcn/ui

```bash
docker compose exec app npx shadcn@latest init
```

Recommended answers:

| Question | Answer |
|----------|--------|
| Style | New York |
| Base color | Neutral |
| CSS variables | Yes |
| Components path | `src/components/ui` |
| Utils path | `src/lib/utils` |

### Step 5: Install Base Components

```bash
docker compose exec app npx shadcn@latest add \
  button card dialog dropdown-menu input label \
  select separator sheet skeleton tabs toast
```

These cover 80% of UI needs. Add more as needed.

### Step 6: Verify

```bash
docker compose exec app npm run build
```

---

## 7. Component Patterns

### Using shadcn Components

```tsx
import { Button } from "@/components/ui/button";

export function BookingCTA() {
  return (
    <Button variant="default" size="lg" className="bg-brand-accent hover:bg-brand-accent-hover">
      Book Tickets
    </Button>
  );
}
```

### Building Project Components on shadcn Primitives

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface EventCardProps {
  title: string;
  image: string;
  price: number;
}

export function EventCard({ title, image, price }: EventCardProps) {
  return (
    <Card className="overflow-hidden">
      <img src={image} alt={title} className="w-full h-48 object-cover" />
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex justify-between items-center">
        <span className="text-brand-muted">${price}</span>
        <Button size="sm">Book Now</Button>
      </CardContent>
    </Card>
  );
}
```

### The cn() Utility

```ts
// src/lib/utils.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Usage:
```tsx
cn("p-4 bg-black", isActive && "bg-brand-accent", className)
```

### Component Variants with CVA

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
  {
    variants: {
      variant: {
        default: "bg-brand-accent text-white",
        secondary: "bg-brand-secondary text-white",
        destructive: "bg-brand-error text-white",
        outline: "border border-brand-muted text-brand-primary",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
```

---

## 8. Tailwind v3 Fallback

Some projects or dependencies may require Tailwind v3. In that case, use file-based config:

### `tailwind.config.ts`

```ts
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          primary: 'var(--color-brand-primary)',
          accent: 'var(--color-brand-accent)',
          'accent-hover': 'var(--color-brand-accent-hover)',
          muted: 'var(--color-brand-muted)',
          error: 'var(--color-brand-error)',
          success: 'var(--color-brand-success)',
          warning: 'var(--color-brand-warning)',
        },
      },
      fontFamily: {
        primary: ['var(--font-primary)'],
        mono: ['var(--font-mono)'],
      },
      maxWidth: {
        content: 'var(--width-content-max)',
      },
    },
  },
  plugins: [],
};

export default config;
```

### `globals.css` (v3)

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --color-brand-primary: #000000;
  --color-brand-accent: #3b82f6;
  /* ... all tokens ... */
}

.dark {
  --color-brand-primary: #ffffff;
  --color-brand-accent: #60a5fa;
  /* ... dark overrides ... */
}
```

---

## 9. Migration Strategy (Existing Projects)

```
Is the project actively being developed?
  |-- No  --> Leave as-is
  +-- Yes --> Is there significant custom CSS (>500 lines)?
        |-- No  --> Full migrate (add Tailwind, convert all)
        +-- Yes --> Coexist (add Tailwind alongside, convert page-by-page)
```

### Coexistence Mode

Tailwind runs alongside existing CSS. New components use Tailwind; old components keep their CSS. Convert incrementally.

```css
@import "tailwindcss";

/* Existing CSS below -- untouched until converted */
.existing-header { ... }
.existing-card { ... }
```

---

## 10. Docker Integration

### All commands inside Docker

```bash
docker compose exec app npx shadcn@latest add button     # Install component
docker compose exec app npm install -D @tailwindcss/typography  # Add plugin
docker compose exec app npm run build                     # Verify build
```

### Dev Mode (Hot Reload)

```yaml
# docker-compose.override.yml (git-ignored)
services:
  app:
    command: npm run dev
    volumes:
      - .:/app
      - /app/node_modules
```

### Dockerfile

Tailwind processes CSS at build time. The existing `RUN npm run build` step handles this — no Dockerfile changes needed.

---

## 11. Quick Reference

```
+-------------------------------------------------------+
|  TAILWIND + SHADCN CHEAT SHEET                        |
+-------------------------------------------------------+
|                                                       |
|  Install component:                                   |
|    docker compose exec app npx shadcn@latest add btn  |
|                                                       |
|  Merge classes:                                       |
|    cn("p-4 bg-black", isActive && "bg-brand-accent")  |
|                                                       |
|  Responsive:                                          |
|    "text-sm md:text-base lg:text-xl"                  |
|                                                       |
|  Dark mode:                                           |
|    "bg-white dark:bg-black"                           |
|                                                       |
|  Hover/focus:                                         |
|    "bg-black hover:bg-gray-800 focus:ring-2"          |
|                                                       |
|  Brand colors:                                        |
|    "bg-brand-accent text-brand-muted"                 |
|                                                       |
|  Spacing (1 unit = 4px):                              |
|    p-1 (4px) p-2 (8px) p-4 (16px) p-8 (32px)        |
|                                                       |
|  Layout:                                              |
|    "flex items-center justify-between gap-4"          |
|    "grid grid-cols-1 md:grid-cols-3 gap-6"            |
|                                                       |
+-------------------------------------------------------+
```

---

## 12. Scaffold Command Integration

| Command | What It Does |
|---------|-------------|
| `scaffold page [name]` | Creates page with Tailwind classes, imports from `@/components/ui` |
| `scaffold component [name]` | Creates component using `cn()`, Tailwind classes, TypeScript props |
| `scaffold docker` | Includes Tailwind devDependencies in package.json, `postcss.config.mjs` |
| `scaffold api` | API routes don't use Tailwind (backend) — no change |

---

## 13. File Checklist (New Project)

After setup, these files must exist:

- [ ] `postcss.config.mjs` — PostCSS with `@tailwindcss/postcss`
- [ ] `src/app/globals.css` — `@import "tailwindcss"` + `@theme` tokens
- [ ] `src/components/ui/` — shadcn components (added on demand)
- [ ] `src/lib/utils.ts` — `cn()` helper
- [ ] `components.json` — shadcn config (style, paths, aliases)

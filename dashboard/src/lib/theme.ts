// Theme system — pure logic (no DOM). Kept side-effect free so it runs under
// the repo's node-environment vitest config; the React glue that talks to
// `window`/`localStorage`/`document` lives in `theme-context.tsx`.
//
// Three-way preference (`system` | `light` | `dark`) resolves to the two
// actually-rendered themes (`light` | `dark`). Persisted per operator via
// `writeStoredTheme`, scoped by the active tenant id when one is known so
// switching tenants in the same browser doesn't clobber another operator's
// choice.

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_PREFIX = 'myai.theme.v1';

export function themeStorageKey(scope?: string | null): string {
  return `${STORAGE_PREFIX}.${scope || 'default'}`;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readStoredTheme(
  storage: Pick<Storage, 'getItem'>,
  scope?: string | null,
): ThemePreference {
  try {
    const raw = storage.getItem(themeStorageKey(scope));
    return isThemePreference(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function writeStoredTheme(
  storage: Pick<Storage, 'setItem'>,
  theme: ThemePreference,
  scope?: string | null,
): void {
  try {
    storage.setItem(themeStorageKey(scope), theme);
  } catch {
    /* storage unavailable (private mode) — in-memory state still works */
  }
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

// Manual-toggle cycle: system -> light -> dark -> system.
export function nextThemePreference(current: ThemePreference): ThemePreference {
  if (current === 'system') return 'light';
  if (current === 'light') return 'dark';
  return 'system';
}

// ── WCAG contrast checking ─────────────────────────────────────────────
// Used by theme.test.ts to enforce AA on the palette below, and reusable by
// any future accessibility audit — not just a one-off check.

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export type Rgb = readonly [number, number, number];

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** PWA/browser-chrome colour (`<meta name="theme-color">`, app/layout.tsx).
 *  Lives here so no .tsx carries a raw hex — design-tokens.test.ts forbids
 *  hex literals outside this file. Darker than --brand-orange on purpose:
 *  it tints the OS status bar, not a surface. */
export const BRAND_THEME_COLOR = '#cc4426';

export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3.0;

// Semantic tokens mirrored in globals.css (`--bg-page`, `--bg-surface`, ...).
// Dark values are the ones this dashboard already ships (zinc-950 body /
// zinc-900 surfaces / zinc-100 + zinc-400 text) — kept byte-identical so
// existing dark mode never shifts. Light values are new.
export const THEME_PALETTE: Record<ResolvedTheme, { bgPage: Rgb; bgSurface: Rgb; textPrimary: Rgb; textSecondary: Rgb }> = {
  dark: {
    bgPage: [9, 9, 11], // zinc-950
    bgSurface: [24, 24, 27], // zinc-900
    textPrimary: [244, 244, 245], // zinc-100
    textSecondary: [161, 161, 170], // zinc-400
  },
  light: {
    bgPage: [248, 250, 252], // slate-50
    bgSurface: [255, 255, 255], // white
    textPrimary: [15, 23, 42], // slate-900
    textSecondary: [71, 85, 105], // slate-600
  },
};

// ── Light-mode status-text overrides ───────────────────────────────────
// Page content uses Tailwind's bright/mid status shades (red-400, amber-300,
// emerald-400, ...) — legible on the dark zinc surfaces this dashboard
// shipped with, but well under WCAG AA once the surface flips light (e.g.
// red-400 on white ≈ 2.8:1). Source of truth for the `:root.light` override
// rules in app/globals.css — keep both in sync. theme.test.ts asserts every
// entry here clears AA against both light backgrounds; globals.css is
// re-derived by hand from this table (no build-time codegen), so update the
// CSS block whenever this map changes.
export const LIGHT_STATUS_TEXT_OVERRIDES: Record<string, Rgb> = {
  'text-amber-200': [180, 83, 9], // amber-700
  'text-amber-300': [180, 83, 9],
  'text-amber-400': [180, 83, 9],
  'text-amber-500': [180, 83, 9],
  'text-blue-300': [37, 99, 235], // blue-600
  'text-blue-400': [37, 99, 235],
  'text-cyan-400': [14, 116, 144], // cyan-700
  'text-emerald-200': [4, 120, 87], // emerald-700
  'text-emerald-300': [4, 120, 87],
  'text-emerald-400': [4, 120, 87],
  'text-emerald-500': [4, 120, 87],
  'text-gray-300': [75, 85, 99], // gray-600
  'text-green-400': [21, 128, 61], // green-700
  'text-indigo-300': [79, 70, 229], // indigo-600
  'text-indigo-400': [79, 70, 229],
  'text-lime-400': [77, 124, 15], // lime-700
  'text-neutral-100': [82, 82, 82], // neutral-600
  'text-neutral-300': [82, 82, 82],
  'text-neutral-400': [82, 82, 82],
  'text-orange-400': [194, 65, 12], // orange-700
  'text-pink-400': [190, 24, 93], // pink-700
  'text-purple-200': [147, 51, 234], // purple-600
  'text-purple-300': [147, 51, 234],
  'text-purple-400': [147, 51, 234],
  'text-red-300': [220, 38, 38], // red-600
  'text-red-400': [220, 38, 38],
  'text-rose-200': [190, 18, 60], // rose-700
  'text-rose-300': [190, 18, 60],
  'text-rose-400': [190, 18, 60],
  'text-sky-300': [3, 105, 161], // sky-700
  'text-teal-50': [15, 118, 110], // teal-700
  'text-teal-100': [15, 118, 110],
  'text-teal-200': [15, 118, 110],
  'text-teal-300': [15, 118, 110],
  'text-teal-400': [15, 118, 110],
  'text-violet-400': [124, 58, 237], // violet-600
  'text-yellow-400': [161, 98, 7], // yellow-700
  'text-yellow-500': [161, 98, 7],
};

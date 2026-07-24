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

// i18n scaffold — pure logic (no DOM, no `next/headers`). Kept side-effect
// free so it runs under the dashboard's node-environment vitest, and so it's
// importable from both Server Components (i18n/request.ts) and Client
// Components (locale-switcher.tsx) — same split as lib/theme.ts /
// lib/tenant-cookie.ts.
//
// Adding a market is a catalogue drop-in, not a refactor: add the locale to
// SUPPORTED_LOCALES + LOCALE_LABELS below and drop a `src/messages/<locale>.json`
// file with the same keys as `en.json`. Everything else (provider, switcher,
// cookie persistence) already handles N locales.

export const SUPPORTED_LOCALES = ['en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Display name shown in the locale switcher, per locale. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
};

/** Cookie the locale switcher writes to; read server-side in i18n/request.ts. */
export const LOCALE_COOKIE = 'myai_locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: string | undefined | null): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** 1-year, path=/, Lax — readable by the server on the next request. */
export function buildLocaleCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

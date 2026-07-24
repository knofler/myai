'use client';

// Locale switcher — one <select> of SUPPORTED_LOCALES (i18n/config.ts).
// Writes the choice to the myai_locale cookie and refreshes the server tree
// so i18n/request.ts re-resolves messages for the new locale on next render
// (same cookie -> router.refresh() pattern as tenant-cookie-sync.tsx). Only
// English ships today — this is the drop-in point for future markets.

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { SUPPORTED_LOCALES, LOCALE_LABELS, buildLocaleCookie, isLocale } from '@/i18n/config';

export function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations('locale');

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    if (!isLocale(next) || next === locale) return;
    document.cookie = buildLocaleCookie(next);
    router.refresh();
  }

  return (
    <label className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer">
      <span aria-hidden="true" className="text-sm leading-none">🌐</span>
      <span className="sr-only">{t('label')}</span>
      <select
        value={locale}
        onChange={handleChange}
        aria-label={t('ariaLabel')}
        className="bg-transparent flex-1 outline-none cursor-pointer text-[var(--text-secondary)]"
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l} className="text-black">
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

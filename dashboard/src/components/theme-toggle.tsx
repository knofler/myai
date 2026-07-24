'use client';

// Manual theme toggle — one button cycles system -> light -> dark -> system.
// Shows the mode that will apply NEXT is a common pattern but is confusing;
// instead this shows the CURRENT resolved appearance plus the preference, so
// the operator always knows what they're looking at and what "system" means
// right now.

import { useTranslations } from 'next-intl';
import { useThemePreference } from '@/lib/theme-context';

const ICON: Record<string, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};

export function ThemeToggle() {
  const { preference, resolved, cycle } = useThemePreference();
  const t = useTranslations('theme');
  const label = t(preference);

  return (
    <button
      type="button"
      onClick={cycle}
      className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
      aria-label={t('ariaLabel', { label, resolved })}
      title={t('title', { label, resolved })}
    >
      <span aria-hidden="true" className="text-sm leading-none">{ICON[preference]}</span>
      <span>{label}</span>
      <span className="ml-auto text-[10px] text-[var(--text-muted)] font-mono">{resolved}</span>
    </button>
  );
}

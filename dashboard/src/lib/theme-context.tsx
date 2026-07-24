'use client';

// Theme provider — wires the pure logic in `theme.ts` to the DOM: reads the
// OS `prefers-color-scheme`, listens for it changing mid-session, persists
// the operator's manual choice (scoped per tenant so two operators sharing a
// browser don't clobber each other), and toggles the `.light` class that
// `globals.css` keys off. The blocking inline script in `layout.tsx` applies
// the class before first paint; this provider takes over after hydration.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTenant } from '@/lib/tenant-context';
import {
  nextThemePreference,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@/lib/theme';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (theme: ThemePreference) => void;
  cycle: () => void;
}

const ThemeCtx = createContext<ThemeContextValue | null>(null);

export function useThemePreference(): ThemeContextValue {
  const v = useContext(ThemeCtx);
  if (!v) throw new Error('useThemePreference must be used within <ThemeProvider>');
  return v;
}

function applyResolvedTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle('light', resolved === 'light');
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // TenantProvider wraps this component in layout.tsx, so `current` is safe
  // to read here even before a tenant session exists (null tenant = 'default' scope).
  const { current } = useTenant();
  const scope = current?.tenantId ?? null;

  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [systemPrefersDark, setSystemPrefersDark] = useState(true);

  // Read the stored preference (scoped by tenant) once mounted.
  useEffect(() => {
    setPreferenceState(readStoredTheme(window.localStorage, scope));
  }, [scope]);

  // Track the live OS preference so `system` stays reactive without a reload.
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemPrefersDark(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const resolved = useMemo(() => resolveTheme(preference, systemPrefersDark), [preference, systemPrefersDark]);

  useEffect(() => {
    applyResolvedTheme(resolved);
  }, [resolved]);

  const setPreference = useCallback(
    (theme: ThemePreference) => {
      setPreferenceState(theme);
      writeStoredTheme(window.localStorage, theme, scope);
    },
    [scope],
  );

  const cycle = useCallback(() => {
    setPreference(nextThemePreference(preference));
  }, [preference, setPreference]);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, cycle }),
    [preference, resolved, setPreference, cycle],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

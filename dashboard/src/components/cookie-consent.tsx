'use client';

// Cookie-consent banner (GDPR/ePrivacy groundwork for the public site).
// Rendered once in the root layout (like DemoBanner) so every surface —
// /welcome, the trust pack, the dashboard — shows it until a choice is
// recorded in the `myai_consent` cookie (lib/consent.ts is the model).
//
// Compliance posture, matched to what the code actually does:
//  • only functional cookies exist today (auth session, tenant, locale) —
//    strictly-necessary ones load regardless (they're consent-exempt);
//  • "Necessary only" is a first-class button, equal in weight to "Accept
//    all" (no dark pattern), plus a granular customise panel;
//  • consent can be revisited any time: LegalShell's footer renders
//    <CookieSettingsButton/>, which re-opens this banner via a custom event —
//    withdrawing is as easy as giving (GDPR art. 7(3)).
import { useCallback, useEffect, useState } from 'react';
import {
  type ConsentState,
  acceptAll,
  necessaryOnly,
  CONSENT_VERSION,
  buildConsentCookie,
  consentFromCookieHeader,
} from '@/lib/consent';

/** Custom event that re-opens the banner (fired by CookieSettingsButton). */
const OPEN_EVENT = 'myai:cookie-settings';

export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      className={className ?? 'hover:text-[rgb(var(--text-secondary))]'}
    >
      Cookie settings
    </button>
  );
}

export function CookieConsent() {
  const [open, setOpen] = useState(false);
  const [customise, setCustomise] = useState(false);
  const [preferences, setPreferences] = useState(true);
  const [analytics, setAnalytics] = useState(false);

  // Read the cookie only after mount (document isn't available in SSR); no
  // valid recorded choice → show the banner.
  useEffect(() => {
    const existing = consentFromCookieHeader(document.cookie);
    if (!existing) setOpen(true);
    const reopen = () => {
      const cur = consentFromCookieHeader(document.cookie);
      if (cur) {
        setPreferences(cur.preferences);
        setAnalytics(cur.analytics);
        setCustomise(true);
      }
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, reopen);
    return () => window.removeEventListener(OPEN_EVENT, reopen);
  }, []);

  const save = useCallback((state: ConsentState) => {
    document.cookie = buildConsentCookie(state);
    setOpen(false);
    setCustomise(false);
  }, []);

  if (!open) return null;

  const now = () => new Date().toISOString();

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Cookie consent"
      className="fixed bottom-0 inset-x-0 z-[60] border-t border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]/95 backdrop-blur px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto max-w-4xl text-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[rgb(var(--text-secondary))]">
            <span className="font-semibold text-[rgb(var(--text-primary))]">Cookies:</span> myAI sets only functional
            cookies (sign-in session, workspace, language) — no advertising trackers, and no analytics load without your
            opt-in. Details in the{' '}
            <a href="/privacy#cookies" className="text-teal-300 hover:underline">
              privacy policy
            </a>
            .
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setCustomise((v) => !v)}
              className="rounded-md border border-[rgb(var(--border-subtle))] px-3 py-1.5 text-[rgb(var(--text-secondary))] transition-colors hover:text-[rgb(var(--text-primary))]"
            >
              Customise
            </button>
            <button
              type="button"
              onClick={() => save(necessaryOnly(now()))}
              className="rounded-md border border-[rgb(var(--border-subtle))] px-3 py-1.5 font-medium text-[rgb(var(--text-primary))] transition-colors hover:border-[rgb(var(--text-muted))]"
            >
              Necessary only
            </button>
            <button
              type="button"
              onClick={() => save(acceptAll(now()))}
              className="rounded-md bg-teal-500 px-3 py-1.5 font-medium text-zinc-950 transition-colors hover:bg-teal-400"
            >
              Accept all
            </button>
          </div>
        </div>

        {customise && (
          <div className="mt-3 border-t border-[rgb(var(--border-subtle))] pt-3 space-y-2">
            <label className="flex items-start gap-2 text-[rgb(var(--text-secondary))]">
              <input type="checkbox" checked disabled className="mt-0.5" />
              <span>
                <span className="font-medium text-[rgb(var(--text-primary))]">Strictly necessary</span> — sign-in
                session, security and workspace scoping. Always on; the site cannot work without them.
              </span>
            </label>
            <label className="flex items-start gap-2 text-[rgb(var(--text-secondary))]">
              <input
                type="checkbox"
                checked={preferences}
                onChange={(e) => setPreferences(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-[rgb(var(--text-primary))]">Preferences</span> — remembers your
                language choice (<code className="text-teal-300">myai_locale</code>).
              </span>
            </label>
            <label className="flex items-start gap-2 text-[rgb(var(--text-secondary))]">
              <input
                type="checkbox"
                checked={analytics}
                onChange={(e) => setAnalytics(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-[rgb(var(--text-primary))]">Analytics</span> — none are in use today;
                this records your choice so any future measurement tool only ever loads with your opt-in.
              </span>
            </label>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() =>
                  save({
                    version: CONSENT_VERSION,
                    necessary: true,
                    preferences,
                    analytics,
                    decidedAt: now(),
                  })
                }
                className="rounded-md bg-teal-500 px-3 py-1.5 font-medium text-zinc-950 transition-colors hover:bg-teal-400"
              >
                Save choices
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

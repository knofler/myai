'use client';

// First-visit onboarding card for web push, shown at the top of /notifications.
//
// Explains what web push buys you (delivery when no tab is open) and enrols this
// device with one click via the shipped VAPID flow (enablePush → PushManager
// subscribe → gateway register). It is deliberately non-nagging:
//   • only ever shown when push is supported AND this device isn't enrolled yet
//   • dismissed permanently (localStorage) once you enable or say "Not now"
//   • quiet-hours aware — surfaces your configured do-not-disturb window (or a
//     reassurance that quiet hours are honoured) so enabling push never means
//     being woken at 3am. The gateway enforces the mute; this just tells you.
//
// The full per-channel controls still live in <NotificationPreferences> below;
// this card is the gentle on-ramp to them.

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { enablePush, getPushSubscription, pushSupport } from '@/lib/push-client';

const DISMISS_KEY = 'myai:notifications:push-onboard-dismissed';

interface QuietPrefs {
  pushConfigured?: boolean;
  quietStart?: string;
  quietEnd?: string;
}

export function PushOnboardCard() {
  // Start hidden; a mount effect decides whether to reveal it so we never flash
  // the card during SSR/hydration or for enrolled/dismissed devices.
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quiet, setQuiet] = useState<QuietPrefs | null>(null);

  useEffect(() => {
    if (pushSupport() !== 'ok') return;
    if (window.localStorage.getItem(DISMISS_KEY)) return;
    let cancelled = false;
    getPushSubscription()
      .then((sub) => {
        if (cancelled || sub) return; // already enrolled → nothing to onboard
        setShow(true);
        // Best-effort: learn the quiet-hours window so the copy is accurate.
        fetch('/api/notifications/preferences')
          .then((r) => (r.ok ? r.json() : null))
          .then((p: QuietPrefs | null) => !cancelled && p && setQuiet(p))
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    window.localStorage.setItem(DISMISS_KEY, '1');
    setShow(false);
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await enablePush();
      window.localStorage.setItem(DISMISS_KEY, '1');
      setShow(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push setup failed.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!show) return null;

  const pushUnconfigured = quiet?.pushConfigured === false;
  const window_ = quiet?.quietStart && quiet?.quietEnd ? `${quiet.quietStart}–${quiet.quietEnd}` : null;

  return (
    <div className="mb-5">
      <Card title="Get notified when the app is closed" accent="emerald">
        <div className="p-4 space-y-3">
          <p className="text-sm text-zinc-300 leading-snug">
            Turn on web push and this device gets stage events, deploys, and alerts even when no dashboard tab is
            open — the same live feed you see here, delivered to your OS.
          </p>
          <p className="text-xs text-zinc-500 leading-snug">
            {window_
              ? `Your quiet hours (${window_}) are respected — nothing is pushed during that window.`
              : 'Quiet hours are respected — set a do-not-disturb window below and push stays silent inside it.'}
          </p>
          {pushUnconfigured && (
            <p className="text-[11px] text-yellow-500/80">
              Push isn’t configured on the gateway yet (set VAPID keys in AI/.env) — you can still enable it once it is.
            </p>
          )}
          {error && <p className="text-[11px] text-red-400/80">{error}</p>}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              disabled={busy || pushUnconfigured}
              onClick={enable}
              className="px-3 py-1.5 rounded-lg gel-brand text-xs font-semibold text-teal-100 hover:brightness-110 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Enabling…' : 'Enable web push'}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 transition-colors"
            >
              Not now
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

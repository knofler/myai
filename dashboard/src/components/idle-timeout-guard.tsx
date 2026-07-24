'use client';

// Idle-session auto-logout (SECURITY, shared-machine risk on Team/Pro tiers —
// see src/lib/idle-timeout.ts for the pure state machine this drives). Tracks
// user activity anywhere in the window; once the active tenant has been idle
// long enough it shows a warning modal with a live countdown, then signs out
// automatically if no activity/response arrives before it reaches zero.
//
// "Sign out" here means the real thing, not just clearing local state: it
// revokes the session server-side (POST /api/auth/sessions/revoke-all with
// includeCurrent, the same route the manual "Revoke" button on /sessions
// uses) so the httpOnly JWT cookie is actually invalidated, then clears the
// tenant from local storage and redirects to /login.
//
// Configurable per-tenant timeout lives in localStorage (idle-timeout.ts);
// the settings control on /sessions (idle-timeout-settings.tsx) writes it and
// dispatches IDLE_TIMEOUT_CHANGED_EVENT so this guard picks up a change
// without a reload.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '@/lib/tenant-context';
import {
  computeIdleState,
  IDLE_TIMEOUT_CHANGED_EVENT,
  readStoredIdleTimeoutMinutes,
  secondsUntilExpiry,
  type IdleTimeoutMinutes,
} from '@/lib/idle-timeout';

// Passive, low-noise signals that the operator is actually at the keyboard.
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;
const CHECK_INTERVAL_MS = 1000;

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function IdleTimeoutGuard() {
  const { current, logout } = useTenant();
  const tenantId = current?.tenantId ?? null;

  const [minutes, setMinutes] = useState<IdleTimeoutMinutes>(30);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const lastActivityRef = useRef(Date.now());

  // Load (and re-load on external change) the tenant-scoped preference.
  useEffect(() => {
    const read = () => setMinutes(readStoredIdleTimeoutMinutes(window.localStorage, tenantId));
    read();
    window.addEventListener(IDLE_TIMEOUT_CHANGED_EVENT, read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener(IDLE_TIMEOUT_CHANGED_EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, [tenantId]);

  const bump = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  // Real sign-out: revoke the session server-side first (best-effort — an
  // already-expired/absent cookie is fine, we still finish the local logout
  // and redirect), then clear the tenant and leave the page.
  const doLogout = useCallback(async () => {
    setSigningOut(true);
    try {
      await fetch('/api/auth/sessions/revoke-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeCurrent: true }),
      });
    } catch {
      /* best effort — proceed to local logout + redirect regardless */
    }
    logout(tenantId ?? undefined);
    window.location.href = '/login?reason=idle';
  }, [logout, tenantId]);

  // No tenant signed in, or the operator disabled the feature (0 = never) →
  // nothing to track, no listeners, no modal.
  const enabled = Boolean(tenantId) && minutes !== 0;

  useEffect(() => {
    if (!enabled) return;
    bump();
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    return () => ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, bump));
  }, [enabled, bump]);

  useEffect(() => {
    if (!enabled) {
      setSecondsLeft(null);
      return;
    }
    const id = setInterval(() => {
      const now = Date.now();
      const state = computeIdleState(now, lastActivityRef.current, minutes);
      if (state === 'expired') {
        setSecondsLeft(null);
        void doLogout();
        return;
      }
      setSecondsLeft(state === 'warning' ? secondsUntilExpiry(now, lastActivityRef.current, minutes) : null);
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, minutes, doLogout]);

  if (secondsLeft === null) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-timeout-title"
      aria-describedby="idle-timeout-desc"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
    >
      <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-xl">
        <h2 id="idle-timeout-title" className="text-sm font-semibold text-zinc-100">
          Still there?
        </h2>
        <p id="idle-timeout-desc" className="mt-2 text-sm text-zinc-400">
          You&apos;ve been inactive for a while. For security, you&apos;ll be signed out automatically in{' '}
          <span className="font-mono text-zinc-200">{formatCountdown(secondsLeft)}</span>.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void doLogout()}
            disabled={signingOut}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
          >
            Sign out now
          </button>
          <button
            type="button"
            onClick={bump}
            disabled={signingOut}
            autoFocus
            className="rounded bg-teal-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-600 disabled:opacity-50"
          >
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}

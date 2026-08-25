'use client';

// ImpersonationBanner — always-visible warning while an operator
// support-impersonation session is active (gateway support-login-as-tenant).
// Keys off the `impersonation` field the gateway's /api/auth/me returns for
// tokens minted by core/impersonation.ts; renders nothing for normal sessions
// (one cheap /me fetch on mount, no polling). Fixed to the TOP edge (the demo
// banner owns the bottom) with a rose accent — a support session must never be
// mistakable for a normal one. Counts down to the token's auto-expiry and
// offers "End session" (POST /api/auth/impersonation/end → audit-stamped
// revoke + cookie clear).

import { useCallback, useEffect, useState } from 'react';

interface ImpersonationState {
  readOnly: boolean;
  expiresAt: string;
  reason?: string;
  email: string;
  tenantName?: string;
  tenantId: string;
}

function remainingLabel(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function ImpersonationBanner() {
  const [state, setState] = useState<ImpersonationState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        if (!res.ok) return;
        const me = await res.json();
        if (!cancelled && me?.impersonation) {
          setState({
            readOnly: !!me.impersonation.readOnly,
            expiresAt: String(me.impersonation.expiresAt),
            reason: me.impersonation.reason,
            email: String(me.email ?? ''),
            tenantName: me.tenantName,
            tenantId: String(me.tenantId ?? ''),
          });
        }
      } catch {
        // gateway unreachable — no session to banner
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!state) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);

  const endSession = useCallback(async () => {
    setEnding(true);
    try {
      await fetch('/api/auth/impersonation/end', { method: 'POST' });
    } finally {
      // Cookie is cleared server-side either way once revoked/expired — land
      // the operator back on a fresh load, not a half-dead session.
      window.location.href = '/';
    }
  }, []);

  if (!state) return null;

  const expired = new Date(state.expiresAt).getTime() <= now;

  return (
    <div
      role="alert"
      className="fixed top-0 inset-x-0 z-50 border-b border-rose-500/40 bg-[rgb(var(--bg-surface))]/95 backdrop-blur px-4 py-2"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm">
        <span className="text-rose-400" aria-hidden>●</span>
        <p className="text-[rgb(var(--text-primary))]">
          <span className="font-semibold text-rose-400">Support session</span>
          {' — impersonating '}
          <span className="font-medium">{state.email}</span>
          {state.tenantName ? ` (${state.tenantName})` : ` (${state.tenantId})`}
          {state.readOnly ? (
            <span className="ml-2 rounded bg-rose-500/15 px-1.5 py-0.5 text-xs font-medium text-rose-300">read-only</span>
          ) : (
            <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-300">write-elevated</span>
          )}
        </p>
        <span className="text-[rgb(var(--text-secondary))]">
          {expired ? 'expired — session ended' : `expires in ${remainingLabel(state.expiresAt, now)}`}
        </span>
        <button
          type="button"
          onClick={endSession}
          disabled={ending}
          className="shrink-0 rounded-md bg-rose-500 px-3 py-1 font-medium text-zinc-950 transition-colors hover:bg-rose-400 disabled:opacity-60"
        >
          {ending ? 'Ending…' : 'End session'}
        </button>
      </div>
    </div>
  );
}

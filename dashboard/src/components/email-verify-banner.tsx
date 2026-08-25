'use client';

// EmailVerifyBanner — persistent in-dashboard nudge for an unverified signup
// address (M2). Reads /api/auth/me; renders nothing when signed out, still
// loading, or already verified. "Resend" hits /api/auth/email/resend
// (JWT-authenticated — always resends to the caller's OWN address, no email
// input needed). Soft enforcement only: verification never gates login or
// any dashboard route, so this is the entire UI surface for it.

import { useEffect, useState } from 'react';

interface MeResponse {
  email?: string;
  emailVerified?: boolean;
}

export function EmailVerifyBanner() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [resendState, setResendState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled) setMe(j as MeResponse | null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!me || me.emailVerified !== false) return null;

  async function onResend() {
    setResendState('busy');
    try {
      const res = await fetch('/api/auth/email/resend', { method: 'POST' });
      setResendState(res.ok ? 'sent' : 'error');
    } catch {
      setResendState('error');
    }
  }

  return (
    <div className="mb-5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-200">Verify your email address</p>
        <p className="text-xs text-amber-300/70 mt-0.5">
          {resendState === 'sent'
            ? `We sent a new verification link to ${me.email ?? 'your email'} — check your inbox.`
            : `Confirm ${me.email ?? 'your email'} to secure your account. Check your inbox for the link from signup.`}
        </p>
      </div>
      <button
        type="button"
        onClick={onResend}
        disabled={resendState === 'busy' || resendState === 'sent'}
        className="shrink-0 px-3 py-1.5 rounded-md bg-amber-500/20 border border-amber-500/40 text-xs font-medium text-amber-200 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {resendState === 'busy' ? 'Sending…' : resendState === 'sent' ? 'Sent' : resendState === 'error' ? 'Try again' : 'Resend email'}
      </button>
    </div>
  );
}

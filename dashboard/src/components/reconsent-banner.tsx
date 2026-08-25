'use client';

// ReconsentBanner — re-consent prompt for the click-wrap legal pack
// (core/legal.ts). Shown on the dashboard home when the gateway reports
// `reconsentNeeded: true`: either a legal-document version bumped since this
// tenant last accepted, or LEGAL_CONSENT_REQUIRED=1 and no acceptance is on
// record. "Accept" records a fresh consent (version + timestamp) via
// POST /api/legal/consent. Non-blocking by design — same dismissable-banner
// posture as EmailVerifyBanner, never a login gate.
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ConsentStatus {
  reconsentNeeded: boolean;
  accepted: Record<string, string> | null;
}

export function ReconsentBanner() {
  const [status, setStatus] = useState<ConsentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/legal/consent', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json) setStatus(json as ConsentStatus);
      })
      .catch(() => {
        /* gateway unreachable — banner simply doesn't render */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (done || !status?.reconsentNeeded) return null;

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/legal/consent', { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || 'failed to record acceptance');
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to record acceptance');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 px-4 py-3 rounded-xl bg-amber-950/40 border border-amber-700/40 flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-[240px] text-sm text-amber-200">
        {status.accepted ? (
          <>
            Our{' '}
            <Link href="/terms" target="_blank" className="underline hover:text-amber-100">
              Terms of Service
            </Link>
            ,{' '}
            <Link href="/privacy" target="_blank" className="underline hover:text-amber-100">
              Privacy Policy
            </Link>{' '}
            or{' '}
            <Link href="/acceptable-use" target="_blank" className="underline hover:text-amber-100">
              Acceptable Use Policy
            </Link>{' '}
            changed since you last accepted them. Please review and accept the updated versions.
          </>
        ) : (
          <>
            Please review and accept our{' '}
            <Link href="/terms" target="_blank" className="underline hover:text-amber-100">
              Terms of Service
            </Link>
            ,{' '}
            <Link href="/privacy" target="_blank" className="underline hover:text-amber-100">
              Privacy Policy
            </Link>{' '}
            and{' '}
            <Link href="/acceptable-use" target="_blank" className="underline hover:text-amber-100">
              Acceptable Use Policy
            </Link>{' '}
            to continue using the service.
          </>
        )}
        {error && <span className="block mt-1 text-xs text-rose-300">{error}</span>}
      </div>
      <button
        onClick={accept}
        disabled={busy}
        className="px-3 py-1.5 rounded-lg bg-amber-600/80 hover:bg-amber-600 text-sm font-medium text-amber-50 disabled:opacity-50 transition"
      >
        {busy ? 'Recording…' : 'I accept'}
      </button>
    </div>
  );
}

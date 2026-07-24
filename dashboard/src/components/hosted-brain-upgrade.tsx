'use client';

// Hosted-brain soft-limit upgrade CTA (ADR-017) — the button rendered under the
// quota bar when a tenant is approaching / over their hosted-brain storage cap.
// Starts a Stripe Checkout for the NEXT tier up (same flow as BillingBanner,
// which gates autonomous work): POST /api/billing/checkout { plan } with the
// active tenant's own key, then redirect to the hosted checkout URL.
//
// Renders nothing when signed out / on the single-operator default tenant (no
// tenant key) — those tenants are never billed, so there is nothing to upgrade.

import { useCallback, useState } from 'react';
import { useTenant } from '@/lib/tenant-context';
import type { TenantPlan } from '@/lib/billing';
import { planLabel } from '@/lib/hosted-brain';

export function HostedBrainUpgrade({ nextPlan, over }: { nextPlan: TenantPlan; over: boolean }) {
  const { current, authHeaders } = useTenant();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upgrade = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ plan: nextPlan }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 503) {
        setError('Billing is not configured on this deployment yet.');
        return;
      }
      if (!res.ok || !json?.url) {
        setError(json?.error || 'Could not start checkout.');
        return;
      }
      window.location.href = json.url as string;
    } catch {
      setError('Could not reach billing. Try again.');
    } finally {
      setBusy(false);
    }
  }, [authHeaders, nextPlan]);

  // Nothing to upgrade for the local/default tenant (never billed).
  if (!current) return null;

  const cls = over
    ? 'bg-rose-400 text-zinc-950 hover:bg-rose-300'
    : 'bg-amber-400 text-zinc-950 hover:bg-amber-300';

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <button
        type="button"
        onClick={upgrade}
        disabled={busy}
        className={`shrink-0 px-3.5 py-1.5 rounded-md text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${cls}`}
      >
        {busy ? 'Starting…' : `Upgrade to ${planLabel(nextPlan)}`}
      </button>
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  );
}

'use client';

// BillingBanner (MVP M5 / §7.2 Day 7) — the Solo-tier subscription gate.
// Reads the active tenant's entitlement from /api/billing/status (auth'd with
// the tenant's own key) and, when the tenant is NOT entitled, shows an upgrade
// prompt that starts Stripe Checkout. Renders nothing when:
//   • signed out / single-operator default tenant (no key) — never gated, or
//   • the tenant is already entitled (active Solo subscription).
// Self-contained: no server props, reflects the current client tenant exactly.

import { useCallback, useEffect, useState } from 'react';
import { useTenant } from '@/lib/tenant-context';

interface DiscountSummary {
  couponId?: string;
  name?: string;
  percentOff?: number;
  amountOff?: number;
}

interface BillingStatus {
  plan: string;
  subscriptionStatus: string;
  entitled: boolean;
  reason: string | null;
  stripeConfigured: boolean;
  hasPortal?: boolean;
  billingInterval?: 'month' | 'year';
  discount?: DiscountSummary | null;
  annualPlans?: string[];
  dunning?: {
    inDunning: boolean;
    failureCount: number;
    maxAttempts: number;
    lastFailedAt: string | null;
  };
}

/** Human label for an applied discount, or null when there is none. */
function discountLabel(d: DiscountSummary | null | undefined): string | null {
  if (!d) return null;
  if (typeof d.percentOff === 'number') return `${d.percentOff}% off`;
  if (typeof d.amountOff === 'number') return `${(d.amountOff / 100).toFixed(2)} off`;
  return d.name || d.couponId || 'discount applied';
}

export function BillingBanner() {
  const { current, authHeaders } = useTenant();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Chosen cadence for the upsell checkout (annual only offered when configured).
  const [interval, setInterval] = useState<'month' | 'year'>('month');

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    setError(null);
    if (!current) return;
    fetch('/api/billing/status', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled) setStatus(j as BillingStatus | null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [current, authHeaders]);

  // Start checkout (new subscription) OR open the billing portal (fix a card on
  // a past_due subscription). The past_due path already has a Stripe customer,
  // so we route it through the portal where the customer can update payment.
  const startFlow = useCallback(
    async (endpoint: '/api/billing/checkout' | '/api/billing/portal') => {
      setBusy(true);
      setError(null);
      try {
        // Only checkout takes an interval; the portal ignores the body.
        const payload = endpoint === '/api/billing/checkout' ? JSON.stringify({ interval }) : '{}';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: payload,
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 503) {
          setError('Billing is not configured on this deployment yet.');
          return;
        }
        if (!res.ok || !json?.url) {
          setError(json?.error || 'Could not open billing.');
          return;
        }
        window.location.href = json.url as string;
      } catch {
        setError('Could not reach billing. Try again.');
      } finally {
        setBusy(false);
      }
    },
    [authHeaders, interval],
  );

  // Nothing to show: signed out or still loading.
  if (!current || !status) return null;

  // Entitled → reflect the active plan, cadence and any discount (billing page).
  if (status.entitled) {
    const disc = discountLabel(status.discount);
    const cadence = status.billingInterval === 'year' ? 'billed annually' : 'billed monthly';
    return (
      <div className="mb-5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-emerald-200 capitalize">{status.plan} plan</span>
        <span className="text-xs text-emerald-300/70">· {cadence}</span>
        {disc && (
          <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-200">
            {disc}
          </span>
        )}
      </div>
    );
  }

  // Payment-recovery variant: the tenant HAS a subscription but the latest
  // payment failed. Route them to the billing portal to update their card
  // rather than to a fresh checkout.
  if (status.dunning?.inDunning) {
    const { failureCount, maxAttempts } = status.dunning;
    return (
      <div className="mb-5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-rose-200">
            Payment failed — update your card to keep your subscription
          </p>
          <p className="text-xs text-rose-300/70 mt-0.5">
            {`We couldn't charge your payment method (attempt ${Math.min(
              failureCount || 1,
              maxAttempts,
            )} of ${maxAttempts}). Paid features are paused until payment succeeds; after the final attempt your workspace is downgraded to Free.`}
          </p>
          {error && <p className="text-xs text-rose-400 mt-1">{error}</p>}
        </div>
        <button
          type="button"
          onClick={() => startFlow(status.hasPortal ? '/api/billing/portal' : '/api/billing/checkout')}
          disabled={busy}
          className="shrink-0 px-4 py-2 rounded-md bg-rose-400 text-zinc-950 text-sm font-semibold hover:bg-rose-300 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Opening…' : 'Update payment method'}
        </button>
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-200">
          Solo subscription required to queue autonomous work
        </p>
        <p className="text-xs text-amber-300/70 mt-0.5">
          {status.reason ?? 'Subscribe to unlock the off-hours runner, scheduling and the work queue.'}
        </p>
        {error && <p className="text-xs text-rose-400 mt-1">{error}</p>}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {status.annualPlans && status.annualPlans.length > 0 && (
          <div className="inline-flex rounded-md border border-amber-500/40 overflow-hidden text-xs">
            {(['month', 'year'] as const).map((iv) => (
              <button
                key={iv}
                type="button"
                onClick={() => setInterval(iv)}
                className={`px-2 py-1 font-medium transition-colors ${
                  interval === iv ? 'bg-amber-400 text-zinc-950' : 'text-amber-200 hover:bg-amber-500/10'
                }`}
              >
                {iv === 'year' ? 'Annual' : 'Monthly'}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => startFlow('/api/billing/checkout')}
          disabled={busy}
          className="px-4 py-2 rounded-md bg-amber-400 text-zinc-950 text-sm font-semibold hover:bg-amber-300 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Starting…' : 'Subscribe to Solo'}
        </button>
      </div>
    </div>
  );
}

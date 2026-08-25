'use client';

// BillingManager — the account-settings self-serve billing surface
// (BILLING-PORTAL). The heavy lifting already exists server-side (lib/billing.ts,
// api/billing/portal, api/billing/invoices) from the M5 checkout work and the
// standalone /pricing page; what was missing was a place inside the signed-in
// dashboard where a tenant can launch the Stripe-hosted billing portal (update
// card, change plan, cancel) and see their invoice history, without emailing
// support. Inert until STRIPE_* is set — every action surfaces that as a plain
// message rather than a broken redirect (same discipline as /pricing).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTenant } from '@/lib/tenant-context';
import { ResidencyBadge } from '@/components/residency-badge';
import {
  discountLabel,
  subscriptionStatusLabel,
  subscriptionStatusClasses,
  billingIntervalLabel,
  type DiscountSummary,
} from '@/lib/billing-status-format';

interface BillingStatus {
  plan: string;
  /** ADR-024 data residency — tenant's pinned region ('us'|'eu'|'au'). */
  region?: string;
  subscriptionStatus: string;
  entitled: boolean;
  reason: string | null;
  stripeConfigured: boolean;
  hasPortal?: boolean;
  billingInterval?: 'month' | 'year';
  discount?: DiscountSummary | null;
  dunning?: {
    inDunning: boolean;
    failureCount: number;
    maxAttempts: number;
    lastFailedAt: string | null;
  };
}

interface InvoiceRow {
  id: string;
  number: string;
  status: string;
  date: string;
  total: string;
  amountDue: string;
  currency: string;
  hostedUrl: string | null;
  pdfPath: string;
}

export default function BillingManager() {
  const { current, authHeaders } = useTenant();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [portalBusy, setPortalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [statusRes, invoicesRes] = await Promise.all([
        fetch('/api/billing/status', { headers: authHeaders(), cache: 'no-store' }),
        fetch('/api/billing/invoices', { headers: authHeaders(), cache: 'no-store' }),
      ]);
      if (statusRes.ok) {
        setStatus((await statusRes.json()) as BillingStatus);
      } else {
        setError('Could not load billing status.');
      }
      if (invoicesRes.ok) {
        const json = await invoicesRes.json();
        setInvoices(Array.isArray(json.invoices) ? json.invoices : []);
      }
      // A 503 on invoices just means billing isn't configured — status already
      // carries stripeConfigured, so no separate error for that case.
    } catch {
      setError('Could not reach billing. Try again.');
    } finally {
      setLoading(false);
    }
  }, [current, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const openPortal = useCallback(async () => {
    setPortalBusy(true);
    setError(null);
    setNotConfigured(false);
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      if (res.status === 503) {
        setNotConfigured(true);
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setError(json?.error || 'No subscription yet — start checkout first.');
        return;
      }
      if (!res.ok || !json?.url) {
        setError(json?.error || 'Could not open the billing portal.');
        return;
      }
      window.location.href = json.url as string;
    } catch {
      setError('Could not reach billing. Try again.');
    } finally {
      setPortalBusy(false);
    }
  }, [authHeaders]);

  if (!current) {
    return (
      <div className="rounded-lg border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-page))]/50 px-4 py-3 text-sm text-[rgb(var(--text-secondary))]">
        Sign in to manage billing.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-page))]/50 px-4 py-3 text-sm text-[rgb(var(--text-secondary))]">
        Loading…
      </div>
    );
  }

  if (status && !status.stripeConfigured) {
    return (
      <div className="rounded-lg border border-amber-800/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
        Billing isn&apos;t configured on this deployment yet — set the <code className="font-mono">STRIPE_*</code>{' '}
        env vars to enable self-serve billing.
      </div>
    );
  }

  const disc = discountLabel(status?.discount);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
      )}
      {notConfigured && (
        <div className="rounded-lg border border-amber-800/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
          Billing isn&apos;t configured on this deployment yet — set the <code className="font-mono">STRIPE_*</code>{' '}
          env vars to enable the billing portal.
        </div>
      )}

      {/* Current plan summary */}
      <div className="rounded-lg border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-page))]/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-[rgb(var(--text-primary))] capitalize">
              {status?.plan ?? 'free'} plan
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs ${subscriptionStatusClasses(status?.subscriptionStatus)}`}>
                {subscriptionStatusLabel(status?.subscriptionStatus)}
              </span>
              {status && <ResidencyBadge region={status.region} />}
              {status?.subscriptionStatus && status.subscriptionStatus !== 'none' && (
                <span className="text-xs text-[rgb(var(--text-muted))]">
                  {billingIntervalLabel(status.billingInterval)}
                </span>
              )}
              {disc && (
                <span className="rounded bg-emerald-400/20 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                  {disc}
                </span>
              )}
            </div>
            {status?.dunning?.inDunning && (
              <p className="mt-2 text-xs text-rose-300/80">
                We couldn&apos;t charge your payment method (attempt{' '}
                {Math.min(status.dunning.failureCount || 1, status.dunning.maxAttempts)} of{' '}
                {status.dunning.maxAttempts}). Update your card below to keep your subscription.
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status?.hasPortal ? (
              <button
                type="button"
                onClick={() => void openPortal()}
                disabled={portalBusy}
                className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
              >
                {portalBusy ? 'Opening…' : 'Manage billing'}
              </button>
            ) : (
              <Link
                href="/pricing"
                className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-[rgb(var(--text-primary))] hover:border-teal-700 hover:text-teal-300"
              >
                View plans
              </Link>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-[rgb(var(--text-muted))]">
          {status?.hasPortal
            ? 'Update your payment method, change plans, download invoices, or cancel — all in the Stripe-hosted billing portal.'
            : 'No Stripe customer on file yet — subscribe from the pricing page to unlock self-serve billing management.'}
        </p>
      </div>

      {/* Invoice history */}
      <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-subtle))]">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="whitespace-nowrap border-b border-[rgb(var(--border-subtle))] px-3 py-2 text-left font-medium text-[rgb(var(--text-primary))]">
                Invoice
              </th>
              <th className="whitespace-nowrap border-b border-[rgb(var(--border-subtle))] px-3 py-2 text-left font-medium text-[rgb(var(--text-primary))]">
                Date
              </th>
              <th className="whitespace-nowrap border-b border-[rgb(var(--border-subtle))] px-3 py-2 text-left font-medium text-[rgb(var(--text-primary))]">
                Status
              </th>
              <th className="whitespace-nowrap border-b border-[rgb(var(--border-subtle))] px-3 py-2 text-left font-medium text-[rgb(var(--text-primary))]">
                Total
              </th>
              <th className="whitespace-nowrap border-b border-[rgb(var(--border-subtle))] px-3 py-2 text-left font-medium text-[rgb(var(--text-primary))]">
                Download
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 ? (
              <tr>
                <td colSpan={5} className="border-b border-[rgb(var(--border-subtle))] px-3 py-2 text-[rgb(var(--text-secondary))]">
                  No invoices yet.
                </td>
              </tr>
            ) : (
              invoices.map((inv) => (
                <tr key={inv.id}>
                  <td className="border-b border-[rgb(var(--border-subtle))] px-3 py-2 align-top text-[rgb(var(--text-primary))]">
                    {inv.number}
                  </td>
                  <td className="border-b border-[rgb(var(--border-subtle))] px-3 py-2 align-top text-[rgb(var(--text-secondary))]">
                    {inv.date}
                  </td>
                  <td className="border-b border-[rgb(var(--border-subtle))] px-3 py-2 align-top text-[rgb(var(--text-secondary))] capitalize">
                    {inv.status}
                  </td>
                  <td className="border-b border-[rgb(var(--border-subtle))] px-3 py-2 align-top text-[rgb(var(--text-secondary))]">
                    {inv.total} {inv.currency}
                  </td>
                  <td className="border-b border-[rgb(var(--border-subtle))] px-3 py-2 align-top">
                    <a
                      href={inv.pdfPath}
                      target="_blank"
                      rel="noreferrer"
                      className="text-teal-400 hover:underline"
                    >
                      PDF
                    </a>
                    {inv.hostedUrl && (
                      <>
                        {' · '}
                        <a href={inv.hostedUrl} target="_blank" rel="noreferrer" className="text-teal-400 hover:underline">
                          Stripe
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

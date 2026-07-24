'use client';

// SpendAlertBanner (FINOPS tenant-facing spend alert) — persistent in-dashboard
// heads-up when the tenant's billing-period LLM spend crosses 80%/100% of
// their plan's included allowance. Sits alongside BillingBanner (subscription
// gate) but reads a different signal: /api/billing/spend-status (dollar spend
// vs. plan allowance), not entitlement. Renders nothing when signed out, still
// loading, unlimited plan, or under 80%.

import { useEffect, useState } from 'react';
import { useTenant } from '@/lib/tenant-context';

interface SpendAlertStatus {
  plan: string;
  includedUsd: number;
  spentUsd: number;
  pct: number | null;
  alertLevel: 80 | 100 | null;
  unlimited: boolean;
}

export function SpendAlertBanner() {
  const { current, authHeaders } = useTenant();
  const [status, setStatus] = useState<SpendAlertStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    if (!current) return;
    fetch('/api/billing/spend-status', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled) setStatus(j as SpendAlertStatus | null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [current, authHeaders]);

  if (!current || !status || status.unlimited || !status.alertLevel) return null;

  const atCap = status.alertLevel >= 100;
  const tone = atCap
    ? { border: 'border-rose-500/40', bg: 'bg-rose-500/10', text: 'text-rose-200', sub: 'text-rose-300/70' }
    : { border: 'border-amber-500/40', bg: 'bg-amber-500/10', text: 'text-amber-200', sub: 'text-amber-300/70' };

  return (
    <div className={`mb-5 rounded-lg border ${tone.border} ${tone.bg} px-4 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3`}>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${tone.text}`}>
          {atCap
            ? `You've used 100% of your included ${status.plan} plan spend`
            : `You've used ${status.alertLevel}% of your included ${status.plan} plan spend`}
        </p>
        <p className={`text-xs ${tone.sub} mt-0.5`}>
          {`$${status.spentUsd.toFixed(2)} of $${status.includedUsd.toFixed(2)} included LLM spend used this billing period.`}
          {atCap ? ' Further usage may incur overage charges.' : ' You are approaching your plan allowance.'}
        </p>
      </div>
    </div>
  );
}

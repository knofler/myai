// /system → Feature Flags tab (admin-only) — platform feature-flag service
// (core/feature-flags.ts): global on/off/killed state, percentage rollout,
// per-tenant force-on/off overrides, and the kill-switch. Mirrors the
// gift-codes tab's admin-proxy pattern: reads/writes go through
// /api/flags(/[key]), which proxy to the gateway's admin-gated REST routes —
// this view never touches Mongo directly, since a flag is platform-wide
// state with no single tenant in scope.

import FeatureFlagsPanel from '@/components/feature-flags-panel';

export const dynamic = 'force-dynamic';

export default function FeatureFlagsView() {
  return (
    <div className="max-w-5xl">
      <p className="mb-5 text-sm text-[rgb(var(--text-muted))]">
        Ship risky features dark, roll them out by percentage or per tenant, and pull the kill-switch when one
        misbehaves (killed = off for everyone, overrides included). Operator-only — requires{' '}
        <code className="bg-[rgb(var(--bg-hover))] px-1 rounded">ADMIN_API_TOKEN</code> configured on both the
        dashboard and the gateway. Apps read their evaluated map from{' '}
        <code className="bg-[rgb(var(--bg-hover))] px-1 rounded">GET /api/flags/eval</code> (or the SDK&apos;s
        FeatureFlagsReader).
      </p>
      <FeatureFlagsPanel />
    </div>
  );
}

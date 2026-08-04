// /system → Gift Codes tab (admin-only) — mint/list/revoke platform-wide
// gift/redeemable subscription codes (core/gift-codes.ts, 38087be shipped the
// REST layer with no client able to drive it). Mirrors the mcp-tools tab's
// admin-proxy pattern: reads/writes go through /api/gift-codes(/revoke),
// which proxy to the gateway's admin-gated REST routes — this view never
// touches Mongo directly, since a gift code is a platform-wide grant with no
// redeeming tenant in scope (unlike the tenant-scoped /system tabs).

import GiftCodesPanel from '@/components/gift-codes-panel';

export const dynamic = 'force-dynamic';

export default function GiftCodesView() {
  return (
    <div className="max-w-4xl">
      <p className="mb-5 text-sm text-zinc-500">
        Mint promo/redeemable subscription codes, review active/redeemed/revoked codes, and revoke a code.
        Operator-only — requires <code className="bg-zinc-800 px-1 rounded">ADMIN_API_TOKEN</code> configured
        on both the dashboard and the gateway.
      </p>
      <GiftCodesPanel />
    </div>
  );
}

// /referrals — GROWTH self-serve referral program. Any tenant member can view
// their tenant's tracked invite link + stats (read-only, no capability gate —
// mirrors /api/auth/me). Shares the credit-grant rail with gift codes
// (core/gift-codes.ts) and the shipped viral share/proof-card surface.
import { PageHeader } from '@/components/page-header';
import ReferralPanel from './referral-panel';

export const dynamic = 'force-dynamic';

export default function ReferralsPage() {
  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="Referrals"
        subtitle="Share your tracked invite link. When someone signs up through it, you both get credits."
      />
      <div className="mt-6">
        <ReferralPanel />
      </div>
    </div>
  );
}

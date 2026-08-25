// /billing — self-serve Stripe billing portal launcher in account settings
// (BILLING-PORTAL). Complements the base /pricing checkout: once a tenant has
// subscribed, this is where they come back to update their card, change plan,
// cancel, or pull an invoice, all via the Stripe-hosted portal + the branded
// invoice list, without opening a support ticket.
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import BillingManager from './billing-manager';

export const dynamic = 'force-dynamic';

export default function BillingPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="Billing"
        subtitle="Manage your subscription — update your payment method, change plans, cancel, or download an invoice. Handled by Stripe's hosted billing portal."
      >
        <Link
          href="/pricing"
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-[rgb(var(--text-secondary))] hover:bg-[rgb(var(--bg-hover))] hover:text-[rgb(var(--text-primary))]"
        >
          View plans ↗
        </Link>
      </PageHeader>
      <div className="mt-6">
        <BillingManager />
      </div>
    </div>
  );
}

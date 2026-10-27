// /billing — self-serve Stripe billing portal launcher in account settings
// (BILLING-PORTAL). Complements the base /pricing checkout: once a tenant has
// subscribed, this is where they come back to update their card, change plan,
// cancel, or pull an invoice, all via the Stripe-hosted portal + the branded
// invoice list, without opening a support ticket.
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import BillingManager from './billing-manager';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1). Plan, spend and invoices are
 *  loaded by the client manager, so this shell quotes no figures. */
function billingSummary(): string {
  return 'Everything about your subscription lives here. Update the card you pay with, move up or down a plan, cancel, or pull an invoice, all through the Stripe portal.';
}

export default function BillingPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        icon="billing"
        title="Billing"
        summary={billingSummary()}
        subtitle="Stripe hosted billing portal · invoices included."
      >
        <Link
          href="/pricing"
          className="rounded-lg border border-[rgb(var(--border-subtle))] px-3 py-1.5 text-meta text-[rgb(var(--text-secondary))] hover:bg-[rgb(var(--bg-hover))] hover:text-[rgb(var(--text-primary))]"
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

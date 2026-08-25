// Pure display-formatting helpers for the /billing account-settings page —
// kept side-effect-free (no fetch, no DOM) so they're unit-testable the same
// way invoice-pdf.ts and nav-groups.ts split their pure logic out from the
// React shell that calls them.

export interface DiscountSummary {
  couponId?: string;
  name?: string;
  percentOff?: number;
  amountOff?: number;
}

/** Human label for an applied discount, or null when there is none. Mirrors
 *  billing-banner.tsx's inline version — kept here so the account page and
 *  the upsell banner render the same wording without importing a client
 *  component into a page that also needs it. */
export function discountLabel(d: DiscountSummary | null | undefined): string | null {
  if (!d) return null;
  if (typeof d.percentOff === 'number') return `${d.percentOff}% off`;
  if (typeof d.amountOff === 'number') return `$${(d.amountOff / 100).toFixed(2)} off`;
  return d.name || d.couponId || 'discount applied';
}

/** Friendly label for a Stripe subscription status, for a tenant reading
 *  their own account settings rather than debugging a webhook payload. */
export function subscriptionStatusLabel(status: string | undefined | null): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'trialing':
      return 'Trial';
    case 'past_due':
      return 'Payment failed — action needed';
    case 'canceled':
      return 'Canceled';
    case 'incomplete':
      return 'Incomplete';
    case 'none':
    case undefined:
    case null:
      return 'No active subscription';
    default:
      return status;
  }
}

/** Tailwind color classes for the status pill, keyed off the same states. */
export function subscriptionStatusClasses(status: string | undefined | null): string {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'text-emerald-400 bg-emerald-950/40';
    case 'past_due':
      return 'text-rose-400 bg-rose-950/40';
    case 'canceled':
      return 'text-zinc-400 bg-zinc-900';
    default:
      return 'text-amber-400 bg-amber-950/40';
  }
}

export function billingIntervalLabel(interval: 'month' | 'year' | undefined): string {
  return interval === 'year' ? 'Billed annually' : 'Billed monthly';
}

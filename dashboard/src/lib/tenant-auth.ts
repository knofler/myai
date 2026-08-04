// Server-only: validate a per-tenant API key and return the tenant row.
// Shared by the billing routes (checkout/status) — same logic the login route
// uses (indexed prefix lookup → constant-time hash compare → active check), but
// it returns the full billing-relevant fields the gate needs.
//
// NEVER import from a Client Component (pulls in node:crypto + Mongo).
import { connectDB, Tenant } from '@/lib/db';
import { sha256Hex, timingSafeEqualHex, KEY_PREFIX_LEN, KEY_RE } from '@/lib/tenant-keys';
import type { TenantPlan, SubscriptionStatus, BillingInterval, DiscountSummary } from '@/lib/billing';

export interface AuthedTenant {
  tenantId: string;
  name: string;
  plan: TenantPlan;
  status: string;
  ownerEmail?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: SubscriptionStatus;
  // Active billing cadence + applied discount (reflected on the billing page).
  billingInterval?: BillingInterval;
  discount?: DiscountSummary | null;
  // Dunning / failed-payment recovery signals (read by the billing status route).
  paymentFailureCount?: number;
  lastPaymentFailedAt?: Date;
  // Free-form per-tenant contract terms (e.g. `slaTargetPct` — negotiated SLA
  // target for Scale/Enterprise) read by the SLA-credit route.
  metadata?: Record<string, unknown>;
  // ADR-019 follow-up #4 — this tenant's Stripe Connect creator payout account
  // (present only once onboarding has started; distinct from stripeCustomerId).
  stripeConnectAccountId?: string;
  stripeConnectStatus?: 'not_connected' | 'onboarding' | 'restricted' | 'enabled' | 'disconnected';
}

export type AuthResult =
  | { ok: true; tenant: AuthedTenant }
  | { ok: false; status: number; error: string };

interface TenantRow extends AuthedTenant {
  apiKeyHash: string;
}

/** Validate a raw API key. Returns the tenant on success, or a typed failure
 *  (400 bad format, 401 unknown/bad key, 403 non-active). Never reveals which. */
export async function authenticateTenant(apiKey: string): Promise<AuthResult> {
  const key = (apiKey || '').trim();
  if (!KEY_RE.test(key)) return { ok: false, status: 400, error: 'invalid key format' };

  await connectDB();
  const prefix = key.slice(0, KEY_PREFIX_LEN);
  const tenant = await Tenant.findOne({ apiKeyPrefix: prefix })
    .select('+apiKeyHash')
    .lean<TenantRow | null>()
    .exec();

  if (!tenant) return { ok: false, status: 401, error: 'unauthorized' };
  if (tenant.status !== 'active') return { ok: false, status: 403, error: 'tenant not active' };
  if (!timingSafeEqualHex(sha256Hex(key), tenant.apiKeyHash)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  const { apiKeyHash: _h, ...rest } = tenant;
  return { ok: true, tenant: rest };
}

/** Extract the raw key from an Authorization: Bearer / x-api-key header. */
export function keyFromRequest(req: Request): string {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return bearer || req.headers.get('x-api-key')?.trim() || '';
}

// Usage-based overage invoicing (Team tier) — the ADR-014 "add-on billing"
// follow-up that CONSUMES the S2 product meter. ADR-014 shipped the meter
// (`UsageEvent`: off-hours minutes + task executions) and deferred invoicing;
// this is that deferred piece: at a Stripe billing period boundary, read the
// meter, subtract each tier's included allowance, and report the OVERAGE to
// Stripe as metered-billing usage so Stripe raises the overage invoice line.
//
// Two billable dimensions (the units the pricing page sells beyond the flat
// subscription): off-hours runner minutes and premium-model task executions.
//
// SDK-free, mirroring dashboard/src/lib/billing.ts: we POST to Stripe's REST
// Meter Events API directly (form-encoded) so no new npm dependency is needed.
//
// ENV-GATED end-to-end — nothing here touches Stripe unless explicitly enabled:
//   STRIPE_OVERAGE_ENABLED         "1"/"true"/"yes"/"on" — master switch (default OFF)
//   STRIPE_METER_OFFHOURS_MINUTES  Stripe Billing Meter event_name for minutes
//   STRIPE_METER_PREMIUM_TASKS     Stripe Billing Meter event_name for premium tasks
//   STRIPE_TEAM_OFFHOURS_INCLUDED  included off-hours minutes / period (default 20000)
//   STRIPE_TEAM_PREMIUM_INCLUDED   included premium tasks / period   (default 500)
// `isOverageConfigured()` is false when the switch is off or no meter is set,
// and every entry point returns a `reason` rather than throwing.

import { stripeForm, type TenantPlan } from './billing';
import { Tenant, UsageEvent } from './db';

const STRIPE_API = 'https://api.stripe.com/v1';

// ── Env (read at call time so tests can toggle process.env) ────
function truthy(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v || '').toLowerCase());
}
function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface OverageEnv {
  enabled: boolean;
  offhoursMeter: string;
  premiumMeter: string;
  teamOffhoursIncluded: number;
  teamPremiumIncluded: number;
}

export function overageEnv(): OverageEnv {
  return {
    enabled: truthy(process.env.STRIPE_OVERAGE_ENABLED),
    offhoursMeter: process.env.STRIPE_METER_OFFHOURS_MINUTES || '',
    premiumMeter: process.env.STRIPE_METER_PREMIUM_TASKS || '',
    teamOffhoursIncluded: numEnv('STRIPE_TEAM_OFFHOURS_INCLUDED', 20_000),
    teamPremiumIncluded: numEnv('STRIPE_TEAM_PREMIUM_INCLUDED', 500),
  };
}

/** Master switch: is usage-based overage billing turned on AND a secret key
 *  present AND at least one meter configured? Off → nothing is ever reported. */
export function isOverageConfigured(): boolean {
  const env = overageEnv();
  const hasKey = Boolean(process.env.STRIPE_SECRET_KEY);
  return hasKey && env.enabled && Boolean(env.offhoursMeter || env.premiumMeter);
}

// ── Allowances & eligibility ──────────────────────────────────
// Included units per plan (a limit of -1 means "unlimited" → never any overage).
// Solo/free carry nominal advisory allowances (ADR-014 §4); only the tiers in
// OVERAGE_PLANS are actually invoiced for overage in this iteration.
export interface OverageAllowance {
  offhoursMinutes: number;
  premiumTasks: number;
}

/** Only these tiers get usage-based overage invoicing. Scale is unlimited
 *  (no overage); Solo/free are flat-rate for now → not metered here. */
export const OVERAGE_PLANS: readonly TenantPlan[] = ['team'];

export function isOverageBilled(plan: TenantPlan): boolean {
  return OVERAGE_PLANS.includes(plan);
}

export function overageAllowances(): Readonly<Record<TenantPlan, OverageAllowance>> {
  const env = overageEnv();
  return {
    free: { offhoursMinutes: 0, premiumTasks: 0 },
    solo: { offhoursMinutes: 6_000, premiumTasks: 100 },
    team: { offhoursMinutes: env.teamOffhoursIncluded, premiumTasks: env.teamPremiumIncluded },
    scale: { offhoursMinutes: -1, premiumTasks: -1 },
  } as const;
}

// ── Usage → overage (pure) ────────────────────────────────────
export type OverageDimension = 'offhours.minutes' | 'premium.tasks';

/** The billable totals for a tenant over a billing period, read from the meter. */
export interface UsageTotals {
  offhoursMinutes: number;
  premiumTasks: number;
}

export interface OverageLineItem {
  dimension: OverageDimension;
  meter: string; // Stripe meter event_name this line reports to
  used: number;
  included: number;
  overage: number; // billable units (always > 0 for an emitted line)
}

/** Overage past an allowance: 0 when unlimited (-1) or under the allowance. */
export function overageFor(used: number, included: number): number {
  if (included < 0) return 0; // unlimited
  return Math.max(0, used - included);
}

/**
 * Compute the billable overage line items for a tenant. PURE — no I/O. Returns
 * a line ONLY when: the plan is overage-billed, the dimension's meter is
 * configured, and there is positive overage. Non-billed plans → [].
 */
export function computeOverage(plan: TenantPlan, totals: UsageTotals): OverageLineItem[] {
  if (!isOverageBilled(plan)) return [];
  const env = overageEnv();
  const allowance = overageAllowances()[plan];
  const lines: OverageLineItem[] = [];

  const offhoursOverage = overageFor(totals.offhoursMinutes, allowance.offhoursMinutes);
  if (env.offhoursMeter && offhoursOverage > 0) {
    lines.push({
      dimension: 'offhours.minutes',
      meter: env.offhoursMeter,
      used: totals.offhoursMinutes,
      included: allowance.offhoursMinutes,
      overage: offhoursOverage,
    });
  }

  const premiumOverage = overageFor(totals.premiumTasks, allowance.premiumTasks);
  if (env.premiumMeter && premiumOverage > 0) {
    lines.push({
      dimension: 'premium.tasks',
      meter: env.premiumMeter,
      used: totals.premiumTasks,
      included: allowance.premiumTasks,
      overage: premiumOverage,
    });
  }

  return lines;
}

// ── Stripe Meter Events API (SDK-free) ────────────────────────
export interface MeterEventResult {
  identifier?: string;
  event_name?: string;
}

/** POST one usage measurement to Stripe's Meter Events API. `identifier` makes
 *  the report idempotent (Stripe dedupes by identifier), so a re-run of the
 *  period-end job never double-bills. Throws on a non-2xx Stripe response. */
export async function reportMeterEvent(opts: {
  eventName: string;
  customerId: string;
  value: number;
  identifier?: string;
  timestamp?: number; // unix seconds
}): Promise<MeterEventResult> {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const body: Record<string, unknown> = {
    event_name: opts.eventName,
    identifier: opts.identifier,
    timestamp: opts.timestamp,
    payload: {
      stripe_customer_id: opts.customerId,
      value: String(Math.max(0, Math.round(opts.value))),
    },
  };
  const res = await fetch(`${STRIPE_API}/billing/meter_events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: stripeForm(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message || `stripe ${res.status}`;
    throw new Error(msg);
  }
  return json as MeterEventResult;
}

// ── Meter read (period-bounded, tenant-scoped) ────────────────
/**
 * Read the billable totals for a tenant over a half-open [from, to) window from
 * the product meter (ADR-014 export contract: "units per type for tenant T in
 * Stripe billing period [start, end)"). Off-hours minutes sum `quantity`;
 * premium tasks count `task.executed` events flagged `metadata.premium: true`
 * (forward-compatible — reads 0 until the emission point stamps that flag, so
 * no tenant is ever over-billed before premium flagging lands).
 */
export async function getOverageUsage(
  tenantId: string,
  opts: { from: Date; to?: Date },
): Promise<UsageTotals> {
  const occurredAt: { $gte: Date; $lt?: Date } = { $gte: opts.from };
  if (opts.to) occurredAt.$lt = opts.to;
  const base = { tenantId, occurredAt }; // tenant-scoped $match

  const [offRows, premRows] = await Promise.all([
    UsageEvent.aggregate([
      { $match: { ...base, type: 'offhours.minutes' } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]),
    UsageEvent.aggregate([
      { $match: { ...base, type: 'task.executed', 'metadata.premium': true } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]),
  ]);

  return {
    offhoursMinutes: (offRows as Array<{ total?: number }>)[0]?.total ?? 0,
    premiumTasks: (premRows as Array<{ total?: number }>)[0]?.total ?? 0,
  };
}

// ── Orchestrator ──────────────────────────────────────────────
export type OverageSkipReason = 'disabled' | 'not-billed-plan' | 'no-customer' | 'no-overage';

export interface OverageReportedItem extends OverageLineItem {
  identifier: string;
  ok: boolean;
  error?: string;
}

export interface OverageResult {
  reported: boolean; // true if at least one meter event was accepted by Stripe
  reason?: OverageSkipReason | 'partial';
  periodKey: string; // the period this run bills (YYYY-MM-DD of periodEnd)
  items: OverageReportedItem[];
}

/**
 * Invoice a tenant's overage for a billing period. Gated at every step:
 * env-off → `disabled`; non-Team plan → `not-billed-plan`; no Stripe customer →
 * `no-customer`; nothing over allowance → `no-overage`. Otherwise reports one
 * idempotent meter event per overage dimension and returns a per-line result.
 * A single failed line does not abort the others (partial success is reported).
 */
export async function invoiceTenantOverage(opts: {
  plan: TenantPlan;
  stripeCustomerId?: string;
  totals: UsageTotals;
  periodEnd: Date;
}): Promise<OverageResult> {
  const periodKey = opts.periodEnd.toISOString().slice(0, 10);
  const base: OverageResult = { reported: false, periodKey, items: [] };

  if (!isOverageConfigured()) return { ...base, reason: 'disabled' };
  if (!isOverageBilled(opts.plan)) return { ...base, reason: 'not-billed-plan' };
  if (!opts.stripeCustomerId) return { ...base, reason: 'no-customer' };

  const lines = computeOverage(opts.plan, opts.totals);
  if (lines.length === 0) return { ...base, reason: 'no-overage' };

  const timestamp = Math.floor(opts.periodEnd.getTime() / 1000);
  const items: OverageReportedItem[] = [];
  for (const line of lines) {
    const identifier = `overage-${opts.stripeCustomerId}-${line.dimension}-${periodKey}`;
    try {
      await reportMeterEvent({
        eventName: line.meter,
        customerId: opts.stripeCustomerId,
        value: line.overage,
        identifier,
        timestamp,
      });
      items.push({ ...line, identifier, ok: true });
    } catch (err) {
      items.push({ ...line, identifier, ok: false, error: (err as Error).message });
    }
  }

  const okCount = items.filter((i) => i.ok).length;
  return {
    reported: okCount > 0,
    reason: okCount === items.length ? undefined : 'partial',
    periodKey,
    items,
  };
}

// ── Fleet sweep (period-boundary job) ─────────────────────────
// The automation that turns the per-tenant push into a REAL billing pipeline:
// at a period boundary (operator/cron — same invocation posture as
// scheduler/quota-reset-sweep.ts and the SLA-credit job), walk every
// overage-billed tenant with a Stripe customer and report the just-ended
// period's overage. Per-tenant isolation: one tenant's failure never aborts
// the rest. Idempotent end-to-end — re-running the sweep re-sends the same
// meter-event identifiers, which Stripe dedupes.

/** The tenant fields the sweep needs. Injectable so the orchestration is
 *  unit-testable without Mongo (same discipline as invoiceTenantOverage). */
export interface SweepTenant {
  tenantId: string;
  plan: TenantPlan;
  stripeCustomerId?: string;
}

export interface OverageSweepTenantResult extends OverageResult {
  tenantId: string;
  usage?: UsageTotals;
  error?: string; // meter read threw — nothing was reported for this tenant
}

export interface OverageSweepResult {
  period: { from: string; to: string };
  scanned: number;   // overage-billed tenants with a Stripe customer examined
  reported: number;  // tenants with >= 1 accepted meter event
  skipped: number;   // no-overage / no-customer skips
  failed: number;    // meter read threw, or every line was rejected by Stripe
  tenants: OverageSweepTenantResult[];
}

/** All overage-billed tenants that can actually be invoiced (Stripe customer
 *  attached). Plans outside OVERAGE_PLANS are excluded at the query. */
async function listOverageTenants(): Promise<SweepTenant[]> {
  const rows = await Tenant.find(
    { plan: { $in: OVERAGE_PLANS as TenantPlan[] }, stripeCustomerId: { $exists: true, $nin: [null, ''] } },
    { tenantId: 1, plan: 1, stripeCustomerId: 1 },
  ).lean();
  return rows as unknown as SweepTenant[];
}

/**
 * Report overage for EVERY billable tenant over one billing period. Deps are
 * injectable for tests; production callers pass only the period. Assumes the
 * caller has already checked `isOverageConfigured()` (the route 503s first) —
 * when it isn't, every tenant just resolves `reason: 'disabled'` harmlessly.
 */
export async function runOverageSweep(opts: {
  periodStart: Date;
  periodEnd: Date;
  tenants?: SweepTenant[];
  readUsage?: (tenantId: string, window: { from: Date; to?: Date }) => Promise<UsageTotals>;
}): Promise<OverageSweepResult> {
  const readUsage = opts.readUsage ?? getOverageUsage;
  const tenants = opts.tenants ?? (await listOverageTenants());

  const results: OverageSweepTenantResult[] = [];
  for (const tenant of tenants) {
    try {
      const usage = await readUsage(tenant.tenantId, { from: opts.periodStart, to: opts.periodEnd });
      const result = await invoiceTenantOverage({
        plan: tenant.plan,
        stripeCustomerId: tenant.stripeCustomerId,
        totals: usage,
        periodEnd: opts.periodEnd,
      });
      results.push({ tenantId: tenant.tenantId, usage, ...result });
    } catch (err) {
      // Meter read failed — record and continue with the next tenant.
      results.push({
        tenantId: tenant.tenantId,
        reported: false,
        periodKey: opts.periodEnd.toISOString().slice(0, 10),
        items: [],
        error: (err as Error).message,
      });
    }
  }

  return {
    period: { from: opts.periodStart.toISOString(), to: opts.periodEnd.toISOString() },
    scanned: tenants.length,
    reported: results.filter((r) => r.reported).length,
    skipped: results.filter((r) => !r.reported && !r.error && r.reason !== 'partial').length,
    failed: results.filter((r) => !!r.error || (!r.reported && r.reason === 'partial')).length,
    tenants: results,
  };
}

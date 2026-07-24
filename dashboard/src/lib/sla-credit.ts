// SLA uptime service-credit automation — a proactive, enterprise-contract
// obligation distinct from dunning (payment recovery) and overage
// (usage-based invoicing): when a tenant's MEASURED monthly uptime breaches
// its SLA target, automatically issue a Stripe account CREDIT per the credit
// schedule and notify the tenant. This module only ever credits a tenant, it
// never charges one.
//
// Signal: the committed incident log (state/incidents.json, read via
// dashboard/src/lib/incidents.ts) is the durable source of downtime for a
// calendar month. Per documentation/OBSERVABILITY.md §3, the in-process
// uptime ring buffer (runtime/src/monitoring/uptime.ts) resets on restart and
// is explicitly NOT the source for contractual SLA numbers — the incident log
// is. Only `major`/`critical` incidents count against uptime; `minor` doesn't.
//
// SLA target is a per-tenant CONTRACT term — Scale/Enterprise pricing is
// custom per-tenant (plan/GRAND_PRODUCT_ROADMAP.md), so the target can be
// negotiated. It's stored in `tenant.metadata.slaTargetPct`, defaulting to
// `defaultSlaTargetPct()` for the `scale` plan. Lower tiers carry no
// contractual SLA and are never eligible for a credit.
//
// SDK-free (mirrors billing.ts / overage.ts / dunning.ts): the credit is
// issued via Stripe's Customer Balance Transactions API (a negative amount
// applies as a credit toward the customer's next invoice). Balance
// transactions have no Stripe-side dedup key (unlike meter events), so
// idempotency is done by listing the customer's recent balance transactions
// and skipping if one already carries this period's tag.
//
// ENV-GATED end-to-end — nothing here touches Stripe unless explicitly enabled:
//   STRIPE_SLA_CREDIT_ENABLED       "1"/"true"/"yes"/"on" — master switch (default OFF)
//   STRIPE_SLA_DEFAULT_TARGET_PCT   default contractual target, e.g. "99.9" (default 99.9)

import { stripeForm, type TenantPlan } from './billing';
import { readIncidents, type Incident } from './incidents';

const STRIPE_API = 'https://api.stripe.com/v1';

// ── Env (read at call time so tests can toggle process.env) ────
function truthy(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v || '').toLowerCase());
}
function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

/** Master switch: is SLA-credit automation turned on AND a Stripe secret key
 *  present? Off → `runSlaCreditForTenant` always returns `disabled`. */
export function isSlaCreditConfigured(): boolean {
  return truthy(process.env.STRIPE_SLA_CREDIT_ENABLED) && Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Default contractual SLA target (%) when a tenant has no negotiated override. */
export function defaultSlaTargetPct(): number {
  return numEnv('STRIPE_SLA_DEFAULT_TARGET_PCT', 99.9);
}

// ── Eligibility ──────────────────────────────────────────────────
/** Only these tiers carry a contractual SLA (Scale/Enterprise — custom contracts). */
export const SLA_PLANS: readonly TenantPlan[] = ['scale'];

export function hasSlaContract(plan: TenantPlan): boolean {
  return SLA_PLANS.includes(plan);
}

/** Resolve a tenant's effective SLA target: a per-tenant contract override
 *  (`tenant.metadata.slaTargetPct`) or the plan default. Non-SLA plans → null
 *  (never eligible, regardless of any stray metadata). */
export function slaTargetForTenant(
  plan: TenantPlan,
  metadata?: Record<string, unknown> | null,
): number | null {
  if (!hasSlaContract(plan)) return null;
  const override = metadata?.slaTargetPct;
  if (typeof override === 'number' && override > 0 && override <= 100) return override;
  return defaultSlaTargetPct();
}

// ── Uptime from the incident log (pure) ─────────────────────────
/** Incident impacts that count against uptime. `minor` does not. */
export const DOWNTIME_IMPACTS: ReadonlySet<string> = new Set(['major', 'critical']);

/** Minutes of `incident` that overlap `[periodStart, periodEnd)`. 0 when the
 *  impact doesn't count against uptime or there's no overlap. An unresolved
 *  incident is treated as still down through `periodEnd`. */
export function downtimeMinutesForIncident(
  incident: Pick<Incident, 'impact' | 'startedAt' | 'resolvedAt'>,
  periodStart: Date,
  periodEnd: Date,
): number {
  if (!DOWNTIME_IMPACTS.has(incident.impact)) return 0;
  const start = new Date(incident.startedAt).getTime();
  const end = incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : periodEnd.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const overlapStart = Math.max(start, periodStart.getTime());
  const overlapEnd = Math.min(end, periodEnd.getTime());
  return overlapEnd > overlapStart ? (overlapEnd - overlapStart) / 60_000 : 0;
}

export interface MonthlyUptime {
  periodStart: string;
  periodEnd: string;
  periodMinutes: number;
  downtimeMinutes: number;
  uptimePct: number; // 0–100
}

/** Compute uptime% for `[periodStart, periodEnd)` from a list of incidents.
 *  PURE — takes the already-read incident list so callers can inject fixtures. */
export function computeMonthlyUptime(
  incidents: readonly Pick<Incident, 'impact' | 'startedAt' | 'resolvedAt'>[],
  periodStart: Date,
  periodEnd: Date,
): MonthlyUptime {
  const periodMinutes = Math.max(0, (periodEnd.getTime() - periodStart.getTime()) / 60_000);
  const downtimeMinutes = incidents.reduce(
    (sum, i) => sum + downtimeMinutesForIncident(i, periodStart, periodEnd),
    0,
  );
  const clampedDowntime = Math.min(downtimeMinutes, periodMinutes);
  const uptimePct = periodMinutes > 0 ? ((periodMinutes - clampedDowntime) / periodMinutes) * 100 : 100;
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    periodMinutes,
    downtimeMinutes: clampedDowntime,
    uptimePct,
  };
}

/** `[start, end)` of the calendar month PRECEDING `now` (UTC) — the default
 *  billing period a run at month-boundary reports on. */
export function previousCalendarMonthUTC(now: Date): { start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  return { start, end };
}

// ── Credit schedule (pure) ───────────────────────────────────────
// Shortfall = target − actual (percentage points). Tiered like typical cloud
// SLA credit schedules, expressed relative to the tenant's OWN contractual
// target so the same schedule works across different negotiated targets.
export interface SlaCreditTier {
  maxShortfallPct: number; // exclusive upper bound; Infinity for the last tier
  creditPct: number; // % of the monthly subscription fee credited
}

export const SLA_CREDIT_SCHEDULE: readonly SlaCreditTier[] = [
  { maxShortfallPct: 1.0, creditPct: 10 },
  { maxShortfallPct: 5.0, creditPct: 25 },
  { maxShortfallPct: Infinity, creditPct: 50 },
];

/** The credit % of the monthly fee owed for a shortfall (target − actual, in
 *  percentage points). 0 or negative shortfall (met/beat the target) → 0. */
export function creditPctForShortfall(shortfallPct: number): number {
  if (shortfallPct <= 0) return 0;
  for (const tier of SLA_CREDIT_SCHEDULE) {
    if (shortfallPct <= tier.maxShortfallPct) return tier.creditPct;
  }
  return SLA_CREDIT_SCHEDULE[SLA_CREDIT_SCHEDULE.length - 1].creditPct;
}

export interface SlaBreachDecision {
  breached: boolean;
  targetPct: number;
  actualPct: number;
  shortfallPct: number;
  creditPct: number;
}

/** The full pure decision: did this tenant breach its SLA, and what credit
 *  tier applies? PURE — no I/O, no Stripe. */
export function decideSlaBreach(actualPct: number, targetPct: number): SlaBreachDecision {
  const shortfallPct = Math.max(0, targetPct - actualPct);
  const creditPct = creditPctForShortfall(shortfallPct);
  return { breached: creditPct > 0, targetPct, actualPct, shortfallPct, creditPct };
}

/** Credit amount in cents for a monthly fee + credit percentage. Rounded to
 *  the nearest cent; never negative. */
export function creditCentsFor(monthlyFeeCents: number, creditPct: number): number {
  return Math.max(0, Math.round((monthlyFeeCents * creditPct) / 100));
}

// ── Stripe REST helpers (SDK-free, mirrors overage.ts) ──────────
async function stripeGet<T>(path: string): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const res = await fetch(`${STRIPE_API}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message || `stripe ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

interface StripePrice {
  unit_amount?: number;
  currency?: string;
  recurring?: { interval?: string };
}

export interface MonthlyFee {
  cents: number;
  currency: string; // ISO 4217, lower-case (Stripe's convention), e.g. 'aud'
}

/** The recurring monthly fee (cents + currency) for a Stripe price id,
 *  normalizing an annual price to its monthly equivalent. The currency is
 *  threaded through so the issued credit is posted in the subscription's
 *  actual currency, never a hard-coded default. */
export async function monthlyFeeCentsForPrice(priceId: string): Promise<MonthlyFee> {
  const price = await stripeGet<StripePrice>(`/prices/${priceId}`);
  const amount = Number(price.unit_amount) || 0;
  const cents = price.recurring?.interval === 'year' ? Math.round(amount / 12) : amount;
  return { cents, currency: (price.currency || 'usd').toLowerCase() };
}

/** The description tag stamped on the issued balance transaction, used to
 *  detect a prior issuance for the same tenant + period on re-run. */
export function slaCreditTag(periodKey: string): string {
  return `sla-credit-${periodKey}`;
}

interface StripeBalanceTransactionList {
  data?: Array<{ description?: string }>;
}

/** Has an SLA credit already been issued to this customer for this period?
 *  Balance transactions have no dedup identifier (unlike meter events), so we
 *  list the customer's recent transactions and check for the period's tag.
 *  Bounded to the most recent 100 — sufficient for a monthly cadence job. */
export async function hasExistingSlaCredit(customerId: string, periodKey: string): Promise<boolean> {
  const tag = slaCreditTag(periodKey);
  const list = await stripeGet<StripeBalanceTransactionList>(
    `/customers/${customerId}/balance_transactions?limit=100`,
  );
  return (list.data ?? []).some((row) => (row.description ?? '').includes(tag));
}

export interface StripeBalanceTransaction {
  id: string;
  amount: number;
  currency: string;
}

/** Issue a Stripe account credit (a negative balance transaction, applied to
 *  the customer's next invoice). `amountCents` is given positive; negated here. */
export async function issueStripeCredit(opts: {
  customerId: string;
  amountCents: number;
  currency?: string;
  description: string;
}): Promise<StripeBalanceTransaction> {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const body = stripeForm({
    amount: -Math.abs(Math.round(opts.amountCents)),
    currency: opts.currency || 'usd',
    description: opts.description,
  });
  const res = await fetch(`${STRIPE_API}/customers/${opts.customerId}/balance_transactions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message || `stripe ${res.status}`;
    throw new Error(msg);
  }
  return json as StripeBalanceTransaction;
}

// ── Notify (pluggable mailer, console fallback — mirrors dunning.ts) ──
export interface SlaCreditEmail {
  to: string;
  subject: string;
  text: string;
}

export function renderSlaCreditEmail(
  decision: SlaBreachDecision,
  opts: { ownerEmail: string; tenantName?: string; periodKey: string; creditCents: number; currency?: string },
): SlaCreditEmail | null {
  if (!opts.ownerEmail || !decision.breached || opts.creditCents <= 0) return null;
  const who = opts.tenantName ? `${opts.tenantName} team` : 'there';
  const amount = (opts.creditCents / 100).toFixed(2);
  const currency = (opts.currency || 'usd').toUpperCase();
  const text = [
    `Hi ${who},`,
    '',
    `Our platform's measured uptime for ${opts.periodKey} was ${decision.actualPct.toFixed(3)}%,`,
    `below your ${decision.targetPct.toFixed(2)}% SLA target.`,
    '',
    `Per your service agreement, we've issued a ${decision.creditPct}% service credit`,
    `(${currency} ${amount}) to your account — it will apply automatically to your next invoice.`,
    '',
    "We're sorry for the disruption and are working to prevent a repeat.",
    '',
    '— The myAI team',
  ].join('\n');
  return { to: opts.ownerEmail, subject: `Service credit issued — ${opts.periodKey} SLA`, text };
}

export type SlaCreditMailer = (email: SlaCreditEmail) => Promise<void>;
let mailer: SlaCreditMailer | null = null;

/** Override the SLA-credit mail sender (tests, real transports). null → console. */
export function setSlaCreditMailer(fn: SlaCreditMailer | null): void {
  mailer = fn;
}

/** Send an SLA-credit email via the active transport (console fallback). Never throws. */
export async function sendSlaCreditEmail(email: SlaCreditEmail): Promise<boolean> {
  try {
    if (mailer) {
      await mailer(email);
    } else {
      console.log(
        `[sla-credit] MAIL to=${email.to} subject="${email.subject}"\n${email.text}\n` +
          '(console transport — inject setSlaCreditMailer() to send real email)',
      );
    }
    return true;
  } catch (err) {
    console.error('[sla-credit] email send failed:', (err as Error).message);
    return false;
  }
}

// ── Orchestrator ──────────────────────────────────────────────
export type SlaCreditSkipReason =
  | 'disabled'
  | 'no-sla-contract'
  | 'no-breach'
  | 'no-customer'
  | 'no-price'
  | 'already-issued';

export interface SlaCreditResult {
  issued: boolean;
  reason?: SlaCreditSkipReason;
  periodKey: string; // YYYY-MM
  uptime: MonthlyUptime;
  decision?: SlaBreachDecision;
  creditCents?: number;
  balanceTransactionId?: string;
  emailSent?: boolean;
}

/**
 * Full pipeline for one tenant + period: compute uptime from the incident log
 * → decide breach/credit → (if breached, not already issued, and a price is
 * known) issue the Stripe credit and notify the tenant. Every gate returns a
 * typed `reason`; nothing throws for an expected skip — only Stripe call
 * failures propagate.
 */
export async function runSlaCreditForTenant(opts: {
  plan: TenantPlan;
  stripeCustomerId?: string;
  priceId?: string;
  ownerEmail?: string;
  tenantName?: string;
  metadata?: Record<string, unknown> | null;
  periodStart: Date;
  periodEnd: Date;
}): Promise<SlaCreditResult> {
  const periodKey = opts.periodStart.toISOString().slice(0, 7); // YYYY-MM
  const log = await readIncidents();
  const uptime = computeMonthlyUptime(log.incidents, opts.periodStart, opts.periodEnd);
  const base: SlaCreditResult = { issued: false, periodKey, uptime };

  if (!isSlaCreditConfigured()) return { ...base, reason: 'disabled' };

  const targetPct = slaTargetForTenant(opts.plan, opts.metadata);
  if (targetPct === null) return { ...base, reason: 'no-sla-contract' };

  const decision = decideSlaBreach(uptime.uptimePct, targetPct);
  if (!decision.breached) return { ...base, decision, reason: 'no-breach' };

  if (!opts.stripeCustomerId) return { ...base, decision, reason: 'no-customer' };
  if (!opts.priceId) return { ...base, decision, reason: 'no-price' };

  if (await hasExistingSlaCredit(opts.stripeCustomerId, periodKey)) {
    return { ...base, decision, reason: 'already-issued' };
  }

  const { cents: monthlyFeeCents, currency } = await monthlyFeeCentsForPrice(opts.priceId);
  const creditCents = creditCentsFor(monthlyFeeCents, decision.creditPct);
  if (creditCents <= 0) return { ...base, decision, creditCents, reason: 'no-price' };

  const tx = await issueStripeCredit({
    customerId: opts.stripeCustomerId,
    amountCents: creditCents,
    currency,
    description: `${slaCreditTag(periodKey)} — ${decision.creditPct}% credit for ${uptime.uptimePct.toFixed(3)}% uptime (target ${targetPct}%)`,
  });

  const email = renderSlaCreditEmail(decision, {
    ownerEmail: opts.ownerEmail || '',
    tenantName: opts.tenantName,
    periodKey,
    creditCents,
    currency,
  });
  const emailSent = email ? await sendSlaCreditEmail(email) : false;

  return {
    ...base,
    decision,
    issued: true,
    creditCents,
    balanceTransactionId: tx.id,
    emailSent,
  };
}

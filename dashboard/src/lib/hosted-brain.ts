// Hosted-brain quota surface (ADR-017) — the dashboard's read-only view of the
// managed, tenant-scoped brain remote the gateway provisions per tenant. Mirrors
// the gateway `brain_host_status` tool output (runtime/src/core/hosted-brain.ts →
// hostedBrainInfo): whether provisioned, the display remote URL (no credential),
// plan, timestamps, encryption-at-rest posture, and quota (used vs plan cap).
//
// This module owns the PURE quota math + soft-limit prompt logic (tested), plus
// the one gateway fetch. The plan byte caps mirror hosted-brain.ts HOSTED_QUOTA_BYTES
// — kept in lock-step the same way billing.ts mirrors the gateway's billing.ts.

import { callGateway } from './gateway';
import { hasHostedBrain } from './billing';
import type { TenantPlan } from './billing';

/** Public hosted-brain status (no secret material) — mirrors HostedBrainInfo. */
export interface HostedBrainInfo {
  provisioned: boolean;
  tenantId: string;
  plan?: TenantPlan;
  remoteUrl?: string;
  createdAt?: string;
  rotatedAt?: string;
  dataEncrypted?: boolean;
  usedBytes?: number;
  /** -1 = unlimited. */
  limitBytes?: number;
  withinQuota?: boolean;
}

/** This tenant's hosted-brain status from the gateway (null if unreachable). */
export function fetchHostedBrainInfo(): Promise<HostedBrainInfo | null> {
  return callGateway<HostedBrainInfo>('brain_host_status');
}

// ── per-plan hosted-repo byte caps (mirror of hosted-brain.ts HOSTED_QUOTA_BYTES) ──
const MB = 1024 * 1024;
export const PLAN_CAP_BYTES: Readonly<Record<TenantPlan, number>> = {
  free: 0, // not entitled
  solo: 100 * MB,
  team: 1024 * MB,
  scale: -1, // unlimited
} as const;

// ── soft-limit thresholds (percent of cap that triggers the upgrade prompt) ──
export const QUOTA_WARN_PCT = 75;
export const QUOTA_CRITICAL_PCT = 90;

/** Upgrade ladder, cheapest → richest. `nextPlan` walks one rung up it. */
const PLAN_ORDER: readonly TenantPlan[] = ['free', 'solo', 'team', 'scale'] as const;

/** The next tier up from `plan`, or null when already at the top (scale). */
export function nextPlan(plan: TenantPlan | undefined): TenantPlan | null {
  if (!plan) return null;
  const i = PLAN_ORDER.indexOf(plan);
  if (i < 0 || i >= PLAN_ORDER.length - 1) return null;
  return PLAN_ORDER[i + 1];
}

/** Human label for a plan tier. */
export function planLabel(plan: TenantPlan | undefined): string {
  switch (plan) {
    case 'free': return 'Free';
    case 'solo': return 'Solo';
    case 'team': return 'Team';
    case 'scale': return 'Scale';
    default: return 'your plan';
  }
}

/** Byte cap as a display string; unlimited caps render as "Unlimited". */
export function capLabel(plan: TenantPlan | undefined): string {
  if (!plan) return '—';
  const cap = PLAN_CAP_BYTES[plan];
  return cap < 0 ? 'Unlimited' : formatBytes(cap);
}

/** Human-readable byte size (1024-based). `—` for missing/invalid input. */
export function formatBytes(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), units.length - 1);
  const val = n / k ** i;
  const rounded = i === 0 ? Math.round(val) : Number(val.toFixed(val >= 100 ? 0 : 1));
  return `${rounded} ${units[i]}`;
}

export type QuotaLevel = 'ok' | 'warn' | 'critical' | 'over' | 'unlimited';

export interface QuotaUsage {
  unlimited: boolean;
  usedBytes: number;
  /** -1 = unlimited. */
  limitBytes: number;
  /** 0–100, clamped; 0 for an unlimited plan. */
  percent: number;
  level: QuotaLevel;
  /** True when the soft-limit prompt should surface (warn+ AND a higher tier exists). */
  approaching: boolean;
}

/**
 * Compute the quota bar + soft-limit state from a hosted-brain status.
 * Pure — no fetch, no clock — so the UI and the tests agree exactly.
 *
 * `over` is driven by the SERVER's `withinQuota` verdict when present (the
 * server is the source of truth for whether new pushes are being rejected),
 * falling back to a used>limit comparison. `approaching` gates the upgrade CTA:
 * only shown at warn+ and only when there is a richer tier to sell.
 */
export function quotaUsage(
  info: Pick<HostedBrainInfo, 'usedBytes' | 'limitBytes' | 'withinQuota' | 'plan'>,
): QuotaUsage {
  const usedBytes = Math.max(0, info.usedBytes ?? 0);
  const limitBytes = info.limitBytes ?? 0;
  const unlimited = limitBytes < 0;

  if (unlimited) {
    return { unlimited: true, usedBytes, limitBytes, percent: 0, level: 'unlimited', approaching: false };
  }

  const percent = limitBytes > 0 ? Math.min(100, Math.round((usedBytes / limitBytes) * 100)) : 0;
  const over = info.withinQuota === false || (limitBytes > 0 && usedBytes > limitBytes);

  let level: QuotaLevel;
  if (over) level = 'over';
  else if (percent >= QUOTA_CRITICAL_PCT) level = 'critical';
  else if (percent >= QUOTA_WARN_PCT) level = 'warn';
  else level = 'ok';

  const approaching = nextPlan(info.plan) != null && (level === 'warn' || level === 'critical' || level === 'over');
  return { unlimited, usedBytes, limitBytes, percent, level, approaching };
}

// ── Provisioning (ADR-023 Slice P1a) — the "connect another machine" action
// the quota bar never had. Calls the existing brain_host_provision /
// brain_host_rotate MCP tools (ADR-017) via /api/brain/host/{provision,rotate}
// (dashboard-only work; no new gateway surface). ──

/** One-time provisioning/rotation result — remote URL + credential, shown
 *  once and never persisted. Mirrors hosted-brain.ts's `ProvisionResult`. */
export interface HostedBrainProvisionResult {
  remoteUrl: string;
  /** Plaintext access token — returned ONCE, never persisted. */
  token: string;
  created: boolean;
}

/**
 * The one-time reveal-banner copy for a provision/rotate result — pure so the
 * UI and its test agree exactly on wording. `created` distinguishes minting a
 * brand-new remote from adopting an existing one / rotating its token.
 */
export function provisionRevealNote(result: Pick<HostedBrainProvisionResult, 'created'>): string {
  return result.created
    ? 'Hosted brain provisioned — shown once, copy now.'
    : 'New access token minted — shown once, copy now.';
}

/**
 * Provisioning-card CTA label. Reads as "connect another machine" once a
 * remote already exists (provisioning is idempotent — it adopts the same
 * repo and mints a fresh token) rather than "start over".
 */
export function provisionCtaLabel(provisioned: boolean): string {
  return provisioned ? 'Connect another machine' : 'Provision hosted brain';
}

export interface UpgradeCta {
  headline: string;
  body: string;
  nextPlan: TenantPlan;
}

/**
 * The soft-limit upgrade prompt for a given usage + current plan, or null when
 * none should show (unlimited plan, not approaching the cap, or already top-tier).
 */
export function upgradeCta(usage: QuotaUsage, plan: TenantPlan | undefined): UpgradeCta | null {
  const np = nextPlan(plan);
  if (!np || usage.unlimited || !usage.approaching) return null;

  const target = PLAN_CAP_BYTES[np] < 0 ? 'unlimited storage' : `a ${capLabel(np)} cap`;
  const headline = usage.level === 'over'
    ? 'Hosted brain over quota — new syncs are being rejected'
    : `Hosted brain ${usage.percent}% full`;
  const body = usage.level === 'over'
    ? `You've hit your ${planLabel(plan)} storage limit. Upgrade to ${planLabel(np)} for ${target} to resume cross-device sync.`
    : `You're approaching your ${planLabel(plan)} storage limit. Upgrade to ${planLabel(np)} for ${target}.`;
  return { headline, body, nextPlan: np };
}

// ── Onboarding upsell moment (ADR-023 Slice P2) ─────────────────────────────
//
// The highest-intent moment to offer cross-machine sync is when an account
// that's clearly already invested in myAI (it has real brain activity) shows
// up without the hosted-brain entitlement — the "this looks like a second
// machine for an existing account" signal the ADR calls for. There's no
// per-device signal yet, so `hasBrainActivity` (does this tenant's own brain
// already have sessions/namespaces?) is the proxy: it distinguishes a
// returning, engaged account from a brand-new empty one, so the nudge doesn't
// fire on the very first run before there's anything to sync.

export interface SyncUpsellInput {
  /** The tenant's current plan — absent is treated as not entitled. */
  plan?: TenantPlan;
  /** Whether this tenant's own (self-hosted) brain already has real activity. */
  hasBrainActivity: boolean;
}

/**
 * Whether the "connect your other machine" upsell should render. Gated on the
 * tenant lacking the hosted-brain entitlement (an already-entitled tenant who
 * simply hasn't provisioned yet gets the plain provisioning card, not an
 * upgrade nudge) AND already showing real brain activity.
 */
export function shouldShowSyncUpsell(input: SyncUpsellInput): boolean {
  if (!input.plan) return false;
  return !hasHostedBrain(input.plan) && input.hasBrainActivity;
}

export interface SyncUpsellCopy {
  headline: string;
  body: string;
}

/** The upsell copy (ADR-023 Slice P2) — framed as the natural next step for an
 *  account that's clearly already using myAI on at least one machine. */
export function syncUpsellCopy(): SyncUpsellCopy {
  return {
    headline: 'Working from another machine too?',
    body: 'Cross-device brain sync (managed remote) keeps every machine’s context in lockstep — no more copying state files by hand.',
  };
}

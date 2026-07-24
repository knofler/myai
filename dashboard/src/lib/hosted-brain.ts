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

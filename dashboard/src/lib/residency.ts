// Data-residency display helpers (ADR-024 Phase 2 — residency badge).
// The gateway is the enforcement layer (runtime/src/core/region-guard.ts);
// the dashboard only *surfaces* the tenant's pinned region so a
// sovereignty-sensitive buyer can see where their data lives. Pure module —
// safe to import from Client Components (no node:crypto, no Mongo).

/** Mirror of the gateway's TenantRegion (runtime/src/shared/db.ts). 'us' is
 *  the implicit region of every pre-ADR-024 tenant and MUST stay the default. */
export type TenantRegion = 'us' | 'eu' | 'au';

export const TENANT_REGIONS: readonly TenantRegion[] = ['us', 'eu', 'au'] as const;

const LABELS: Record<TenantRegion, string> = {
  us: 'US',
  eu: 'EU',
  au: 'AU',
};

const NAMES: Record<TenantRegion, string> = {
  us: 'United States',
  eu: 'European Union',
  au: 'Australia',
};

/** Narrow an untrusted value (API payload, stale mirror row) to a TenantRegion.
 *  Unknown/absent → 'us', matching the gateway's schema default so a
 *  pre-migration tenant row never renders a broken badge. */
export function asTenantRegion(value: unknown): TenantRegion {
  return typeof value === 'string' && (TENANT_REGIONS as readonly string[]).includes(value)
    ? (value as TenantRegion)
    : 'us';
}

/** Short badge text, e.g. 'EU'. */
export function regionLabel(region: TenantRegion): string {
  return LABELS[region];
}

/** Full region name for tooltips/aria, e.g. 'European Union'. */
export function regionName(region: TenantRegion): string {
  return NAMES[region];
}

/** One-line explanation shown on hover — states the guarantee honestly:
 *  the region tag is what the gateway's region-guard enforces against. */
export function residencyTitle(region: TenantRegion): string {
  return `Data residency: ${NAMES[region]} — this tenant's records and off-hours runner work are pinned to the '${region}' region and enforced at the gateway (ADR-024).`;
}

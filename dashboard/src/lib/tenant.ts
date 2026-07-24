// Active-tenant context for the dashboard (ADR-010 M2 / §7.2 Day 4).
//
// The dashboard's `/schedule` `/plan` `/directory` views read tenant-owned data
// directly from Mongo (read-only mirrors in `db.ts`). This module derives the
// *active tenant* for the current request and produces the Mongo filter every
// scoped query must apply.
//
// CONTEXT SOURCE — the tenant is read from the `myai_tenant` cookie, which the
// M2 signup/login + tenant-switcher flow sets after authentication. When no
// cookie is present we fall back to DEFAULT_TENANT_ID.
//
// ⚠ STANDING REQUIREMENT (do NOT regress): the dashboard must NEVER force a
// login for LOCAL / loopback access. On any machine, hitting the dashboard on
// localhost must render immediately as the default tenant with no /login
// redirect — login is OPT-IN (for multi-tenant / hosted use), never a gate on
// the local operator. That is why this fallback is permanent, not transitional,
// and why there is deliberately no auth-gating middleware. The gateway mirrors
// this: it trusts loopback callers without a key (runtime/src/core/auth.ts
// `resolveNoKey` → isLoopback). If hosted enforcement ever needs a login wall,
// it MUST exempt loopback so this requirement still holds.
//
// NOTE: the tenant is NEVER trusted as a data-shaping argument server-side at
// the gateway (that resolves tenant from the per-tenant API key — see
// runtime/src/core/auth.ts). Here it only selects which slice of the *local*
// read-only mirror to render; the gateway remains the source of truth for any
// write path.

import { cookies } from 'next/headers';
import { DEMO_MODE } from './demo';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from './tenant-cookie';

// Re-export so existing server-side importers can keep using `@/lib/tenant`.
export { DEFAULT_TENANT_ID, TENANT_COOKIE };

/**
 * Resolve the active tenant for the current request from the `myai_tenant`
 * cookie, falling back to the default tenant when absent (single-operator /
 * pre-login). Never throws — a cookie-read failure degrades to the default.
 */
export async function getActiveTenant(): Promise<string> {
  // Read-only demo (src/lib/demo.ts): the tenant is pinned — the demo
  // database only holds seeded demo data, and the cookie must not let a
  // visitor point the UI at any other slice.
  if (DEMO_MODE) return DEFAULT_TENANT_ID;
  try {
    const store = await cookies();
    const value = store.get(TENANT_COOKIE)?.value?.trim();
    return value || DEFAULT_TENANT_ID;
  } catch {
    return DEFAULT_TENANT_ID;
  }
}

/**
 * Build the Mongo filter that scopes a query to `tenantId`.
 *
 * - **Default tenant** → a backward-compatible catch-all that also matches rows
 *   written before the ADR-010 backfill (no `tenantId`, or `null`). This keeps
 *   the existing single-operator dashboard fully populated whether or not the
 *   tenant backfill has run on this database.
 * - **Any other (real) tenant** → a strict `{ tenantId }` match, so one tenant
 *   never sees another's rows.
 *
 * Spread into a query alongside other conditions, e.g.
 *   `Schedule.find({ ...tenantFilter(t), enabled: true })`.
 */
export function tenantFilter(tenantId: string): Record<string, unknown> {
  if (tenantId === DEFAULT_TENANT_ID) {
    return { $or: [{ tenantId: DEFAULT_TENANT_ID }, { tenantId: { $exists: false } }, { tenantId: null }] };
  }
  return { tenantId };
}

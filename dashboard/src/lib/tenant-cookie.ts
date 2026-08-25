// Client-safe tenant constants (no `next/headers`) — importable from both
// Server Components (lib/tenant.ts) and Client Components (tenant-cookie-sync.tsx).
// Kept separate so the client bundle never pulls in `next/headers`.

/** Mirrors runtime/src/shared/db.ts DEFAULT_TENANT_ID — read from the same env var. */
export const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'default';

/** Cookie the M2 login/tenant-switcher mirrors the active tenant id into. */
export const TENANT_COOKIE = 'myai_tenant';

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
 * Lives HERE rather than in `tenant.ts` because it is pure — no `next/headers`,
 * no request context. `tenant.ts` is server-only, and pulling it into a client
 * bundle for this one helper broke the production build: the client component
 * `budget-suggestions-panel.tsx` imports pure helpers from `budget-suggestions.ts`,
 * which imported `tenantFilter` from `tenant.ts`, which imports `next/headers`.
 * `tenant.ts` re-exports this so existing server-side importers are unaffected.
 */
export function tenantFilter(tenantId: string): Record<string, unknown> {
  if (tenantId === DEFAULT_TENANT_ID) {
    return { $or: [{ tenantId: DEFAULT_TENANT_ID }, { tenantId: { $exists: false } }, { tenantId: null }] };
  }
  return { tenantId };
}

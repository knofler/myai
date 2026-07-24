// Client-safe tenant constants (no `next/headers`) — importable from both
// Server Components (lib/tenant.ts) and Client Components (tenant-cookie-sync.tsx).
// Kept separate so the client bundle never pulls in `next/headers`.

/** Mirrors runtime/src/shared/db.ts DEFAULT_TENANT_ID — read from the same env var. */
export const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'default';

/** Cookie the M2 login/tenant-switcher mirrors the active tenant id into. */
export const TENANT_COOKIE = 'myai_tenant';

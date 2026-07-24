'use client';

// Bridges Day-3's client-side tenant context (localStorage, see lib/tenant-context.tsx)
// to the server (ADR-010 M2 / §7.2 Day 4). The active tenant lives only in
// localStorage + React state, but the `/schedule` `/plan` `/directory` views are
// server components that scope their Mongo reads via the `myai_tenant` cookie
// (lib/tenant.ts `getActiveTenant`). This mirrors the active tenantId into that
// cookie whenever it changes, then refreshes the server tree so the scoped views
// re-render for the newly-selected tenant.
//
// The cookie carries ONLY the tenant slug (an identifier), never the API key —
// it selects which slice of the local read-only mirror to render. The gateway
// still authenticates writes with the per-tenant Bearer key under TENANT_ENFORCE.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTenant } from '@/lib/tenant-context';
import { TENANT_COOKIE } from '@/lib/tenant-cookie';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function writeCookie(tenantId: string | null) {
  if (typeof document === 'undefined') return;
  if (tenantId) {
    // 30-day, path=/, Lax — readable by the server on the next request.
    document.cookie = `${TENANT_COOKIE}=${encodeURIComponent(tenantId)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
  } else {
    document.cookie = `${TENANT_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  }
}

export function TenantCookieSync() {
  const { current, loading } = useTenant();
  const router = useRouter();

  const activeId = current?.tenantId ?? null;

  useEffect(() => {
    // Wait until the context has hydrated from localStorage before touching the
    // cookie — otherwise the first paint (current=null) would clobber a valid cookie.
    if (loading) return;
    // The cookie is what the server rendered against. If it already matches the
    // active tenant, the server view is correct — do nothing. Otherwise rewrite
    // it and refresh so the scoped server components re-render for this tenant.
    if (readCookie(TENANT_COOKIE) === activeId) return;
    writeCookie(activeId);
    router.refresh();
  }, [activeId, loading, router]);

  return null;
}

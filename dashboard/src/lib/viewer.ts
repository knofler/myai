// Active viewer (tenant + user) for per-user dashboard state (task-e8aaf32e).
//
// Same trust model as lib/tenant.ts getActiveTenant — the ONLY thing that may
// turn a credential into an identity is the gateway's /api/auth/me verifier;
// the dashboard never decodes the JWT itself, and no client-writable cookie is
// ever honoured as authorization (GHSA-ffgf-pmmg-cjj5).
//
// Fallback: an unauthenticated local single-operator install still gets
// working per-user persistence — it acts as the fixed LOCAL_OPERATOR_USER_ID
// under DEFAULT_TENANT_ID, mirroring how getActiveTenant falls back rather
// than erroring. Never throws.

import { cookies } from 'next/headers';
import { DEMO_MODE } from './demo';
import { GATEWAY_HTTP_URL } from './gateway';
import { SESSION_COOKIE_NAME } from './session-cookie';
import { DEFAULT_TENANT_ID } from './tenant-cookie';

/** The pseudo-user a session with no login acts as (local-first install). */
export const LOCAL_OPERATOR_USER_ID = 'local-operator';

export interface ActiveViewer {
  tenantId: string;
  userId: string;
}

const FALLBACK: ActiveViewer = { tenantId: DEFAULT_TENANT_ID, userId: LOCAL_OPERATOR_USER_ID };

async function viewerFromSession(jwt: string): Promise<ActiveViewer | null> {
  try {
    const res = await fetch(`${GATEWAY_HTTP_URL}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const me = (await res.json().catch(() => null)) as { userId?: unknown; tenantId?: unknown } | null;
    const userId = typeof me?.userId === 'string' ? me.userId.trim() : '';
    const tenantId = typeof me?.tenantId === 'string' ? me.tenantId.trim() : '';
    return userId && tenantId ? { userId, tenantId } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the acting {tenantId, userId} for the current request.
 *
 *   • No session                        → default tenant, local-operator user.
 *   • Valid session                     → the identity the GATEWAY says the JWT
 *                                         belongs to.
 *   • Unverifiable (gateway down / bad JWT)
 *                                       → fallback (fail closed to least privilege).
 */
export async function getActiveViewer(): Promise<ActiveViewer> {
  if (DEMO_MODE) return FALLBACK;
  try {
    const store = await cookies();
    const jwt = store.get(SESSION_COOKIE_NAME)?.value?.trim();
    if (!jwt) return FALLBACK;
    return (await viewerFromSession(jwt)) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}

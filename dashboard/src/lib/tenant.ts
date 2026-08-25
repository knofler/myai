// Active-tenant context for the dashboard (ADR-010 M2 / §7.2 Day 4).
//
// The dashboard's `/schedule` `/plan` `/directory` views read tenant-owned data
// directly from Mongo (read-only mirrors in `db.ts`). This module derives the
// *active tenant* for the current request and produces the Mongo filter every
// scoped query must apply.
//
// CONTEXT SOURCE — the tenant is derived from the httpOnly `myai_token` session
// JWT, verified by the gateway. The `myai_tenant` cookie the tenant-switcher
// sets is a UI preference only and is never trusted as authorization (it is
// client-writable — see GHSA-ffgf-pmmg-cjj5 and getActiveTenant below). With no
// session we fall back to DEFAULT_TENANT_ID.
//
// ⚠ SUPERSEDED (2026-08-11) — this file used to carry a standing requirement that
// local/loopback access must NEVER require a login, and that there was therefore
// "deliberately no auth-gating middleware". Both halves are now false, by explicit
// operator decision, and keeping the note would be the same species of stale
// invariant that let GHSA-ffgf-pmmg-cjj5 ship:
//   • There IS an auth gate — the single-operator middleware (lib/operator-auth.ts).
//   • It has NO loopback exemption, because the old one keyed off the `Host`
//     header, which is attacker-controlled; inside Docker every request arrives
//     via the bridge, so `Host: localhost` bypassed it from anywhere on the network.
// The local operator now logs in like everyone else, with a credential that lives
// only in a gitignored `.env`. What survives is the *fallback below*: with no
// session, the acting tenant is DEFAULT_TENANT_ID rather than an error.
//
// NOTE: the gateway never trusts a caller-supplied tenant — it resolves tenant
// from the per-tenant API key (runtime/src/core/auth.ts).
//
// ⚠ This module is NOT read-only, and the comment that used to claim so was
// wrong. Several dashboard routes write to Mongo directly, scoped by whatever
// this function returns — `api/projects` (Task.insertMany, and the runner
// EXECUTES queue tasks as code), `api/connectors`, `api/budget-caps`,
// `api/routing-policy`, `api/apps/new`, `api/onboarding/launch`. That mistaken
// "read-only mirror" assumption is what allowed a client-writable cookie to
// become an unauthenticated cross-tenant write primitive (GHSA-ffgf-pmmg-cjj5).
// Treat every value returned here as a security decision, not a view preference.

import { cookies } from 'next/headers';
import { DEMO_MODE } from './demo';
import { GATEWAY_HTTP_URL } from './gateway';
import { SESSION_COOKIE_NAME } from './session-cookie';
import { DEFAULT_TENANT_ID, TENANT_COOKIE, tenantFilter } from './tenant-cookie';

// Re-export so existing server-side importers can keep using `@/lib/tenant`.
// `tenantFilter` is pure and now lives in the client-safe module — see the note
// there; importing it from here would drag `next/headers` into a client bundle.
export { DEFAULT_TENANT_ID, TENANT_COOKIE, tenantFilter };

/**
 * Resolve the session's tenant by asking the gateway to verify the httpOnly
 * `myai_token` JWT (the same verifier `/api/auth/me` proxies to). Returns null
 * when there is no session, the JWT is invalid, or the gateway is unreachable.
 *
 * The gateway is the ONLY thing that may turn a credential into a tenant id —
 * the dashboard never decodes the JWT itself.
 */
async function tenantFromSession(jwt: string): Promise<string | null> {
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
    const me = (await res.json().catch(() => null)) as { tenantId?: unknown; tenant?: unknown } | null;
    const id = typeof me?.tenantId === 'string' ? me.tenantId : typeof me?.tenant === 'string' ? me.tenant : '';
    return id.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the active tenant for the current request.
 *
 * ⚠ SECURITY (GHSA-ffgf-pmmg-cjj5, 2026-08-10): the `myai_tenant` cookie is
 * written by client-side JavaScript — it is NOT httpOnly and NOT signed, so any
 * caller can set it to any value. It used to be returned verbatim here, which
 * made it an unauthenticated cross-tenant selector on every route that calls
 * this function, including routes that write directly to Mongo (`/api/projects`
 * fan-out creates queue tasks, and the autonomous runner executes queue tasks as
 * code). It is therefore now treated as a **UI preference only, never as
 * authorization**:
 *
 *   • No session         → DEFAULT_TENANT_ID. The cookie is ignored entirely.
 *   • Valid session      → the tenant the GATEWAY says the JWT belongs to. The
 *                          cookie is honoured only when it already agrees, so
 *                          the tenant switcher keeps working for a session that
 *                          genuinely is that tenant, and is inert otherwise.
 *   • Session unverifiable (gateway down / bad JWT)
 *                        → DEFAULT_TENANT_ID (fail closed to least privilege).
 *
 * The standing local-first requirement is untouched: a local operator with no
 * login still renders immediately as the default tenant, with no /login redirect.
 * What changed is only that an unauthenticated caller can no longer *choose*
 * which tenant they act as. Never throws.
 */
export async function getActiveTenant(): Promise<string> {
  // Read-only demo (src/lib/demo.ts): the tenant is pinned — the demo
  // database only holds seeded demo data, and the cookie must not let a
  // visitor point the UI at any other slice.
  if (DEMO_MODE) return DEFAULT_TENANT_ID;
  try {
    const store = await cookies();
    const jwt = store.get(SESSION_COOKIE_NAME)?.value?.trim();
    // Unauthenticated (single-operator local install): default tenant only.
    if (!jwt) return DEFAULT_TENANT_ID;

    const sessionTenant = await tenantFromSession(jwt);
    if (!sessionTenant) return DEFAULT_TENANT_ID;

    // The switcher's cookie is allowed to select a tenant only when the verified
    // session already IS that tenant; otherwise the session wins.
    const requested = store.get(TENANT_COOKIE)?.value?.trim();
    return requested && requested === sessionTenant ? requested : sessionTenant;
  } catch {
    return DEFAULT_TENANT_ID;
  }
}


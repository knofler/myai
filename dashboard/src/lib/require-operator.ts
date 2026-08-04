// Operator-only gate for dashboard routes that read/mutate cross-tenant
// platform state locally, with no gateway leg to delegate the check to (the
// marketplace review queue — ADR-019 §"New capabilities": "marketplace.review
// (platform-side reviewer — approve/reject/yank; not a tenant role, a
// platform operation)"). Every other operator-only dashboard route
// (gift-codes, tenants/mcp-tools, budgets, usage) is a pure proxy: the
// dashboard route attaches `x-admin-token: ADMIN_API_TOKEN` on its way OUT to
// the gateway, and the gateway's own `requireAdmin` (runtime/src/core/
// server.ts) verifies it there. The review queue has no such second hop — it
// mutates dashboard/src/lib/marketplace-store.ts's in-process store directly
// — so the SAME env var/header pair is checked HERE, on the incoming
// request, instead.
import { NextResponse } from 'next/server';

/** True iff `ADMIN_API_TOKEN` is configured and `req` carries a matching
 *  `x-admin-token` header. */
export function isOperatorRequest(req: Request): boolean {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) return false;
  return req.headers.get('x-admin-token') === expected;
}

/**
 * Route guard for operator-only handlers. Returns a response to send
 * immediately when the caller isn't authorized, or `null` when the request
 * may proceed.
 *
 * - 503 `ADMIN_DISABLED` when `ADMIN_API_TOKEN` isn't configured on this
 *   deployment — same posture as the gift-codes/mcp-tools proxies (the
 *   feature is off by default; a tenant-facing deployment never sets this).
 * - 403 `FORBIDDEN` when it IS configured but the caller's token is
 *   missing/wrong — an authenticated-but-wrong-role denial, matching the
 *   403 `assertCapability`/`requireRole` use in runtime/src/core/rbac.ts for
 *   a role-capability failure (as opposed to the plain 401 `requireAdmin`
 *   uses for a bare missing-credential case — this caller may well be a
 *   perfectly valid logged-in tenant user, just not an operator).
 */
export function requireOperator(req: Request): NextResponse | null {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'admin_disabled', code: 'ADMIN_DISABLED' }, { status: 503 });
  }
  if (req.headers.get('x-admin-token') !== expected) {
    return NextResponse.json({ error: 'operator role required', code: 'FORBIDDEN' }, { status: 403 });
  }
  return null;
}

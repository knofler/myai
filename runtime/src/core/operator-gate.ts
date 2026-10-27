// Operator-plane gates (v1 gate G5, H-2/H-3/L-1).
//
// Some REST routes act on the operator's own installation (the global hook
// registry, the operator's repo list, indexing the operator's repos) rather
// than a tenant's data. A tenant API key must never reach them: only local
// trust (the operator's own tools: loopback or GATEWAY_LOCAL_TOKEN) or the
// admin token. Inbound webhooks follow the same rule when no signing secret is
// configured: an unsigned delivery is accepted only from local trust.
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Constant-time comparison against ADMIN_API_TOKEN; false when it is unset. */
export function adminTokenMatches(provided: string | undefined, expected = process.env.ADMIN_API_TOKEN): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Local trust or a valid x-admin-token; everyone else gets 403. */
export function requireLocalOrAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.tenant?.local || adminTokenMatches(req.header('x-admin-token'))) {
    next();
    return;
  }
  res.status(403).json({ error: 'operator access required', code: 'FORBIDDEN' });
}

/** An unsigned webhook delivery (no secret configured) is accepted only from local trust. */
export function unsignedWebhookAllowed(req: Request): boolean {
  return Boolean(req.tenant?.local);
}

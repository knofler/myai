// v1 gate G5 (H-1): a local install never takes self-serve signups. A LAN or
// container peer could otherwise create its own tenant and reach every
// tenant-scoped tool. The local compose files set SIGNUP_ENABLED=false;
// hosted deployments leave it unset (on). Mounted ahead of the rate limiter, so
// a refused signup costs no rate-limit budget and no database round trip.
import type { NextFunction, Request, Response } from 'express';
import { isSignupEnabled } from '../shared/config.js';

export function requireSignupEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!isSignupEnabled()) {
    res.status(403).json({ error: 'Signup is disabled on this gateway' });
    return;
  }
  next();
}

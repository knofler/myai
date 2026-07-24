/**
 * Per-tenant API-key authentication (ADR-010 §3).
 *
 * One resolver, three transports. `resolveTenant` (REST/MCP) and
 * `authenticateWs` (WS) derive a {@link ToolContext} from:
 *   (a) a valid per-tenant key  → that tenant;
 *   (b) loopback OR GATEWAY_LOCAL_TOKEN (no key) → the default tenant (local);
 *   (c) otherwise → 401 when `tenancy.enforce`, else the default tenant (MVP
 *       single-operator backwards-compat).
 *
 * SECURITY NOTES
 * - Loopback is decided from the RAW socket address (`req.socket.remoteAddress`),
 *   NEVER `req.ip`: with TRUST_PROXY on, `req.ip` honours X-Forwarded-For and is
 *   spoofable (`X-Forwarded-For: 127.0.0.1`). Do not "simplify" this.
 * - Key compare is constant-time (`timingSafeEqual`), with a dummy compare on
 *   tenant-not-found to flatten timing.
 * - Hash is SHA-256: keys carry full CSPRNG entropy so bcrypt's slowness would
 *   tax every request (runner/dashboard/Telegram hammer this path) to defend a
 *   threat that doesn't exist. bcrypt stays correct for human passwords (M2).
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import { TenantModel, type ITenant } from '../shared/db.js';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { type ToolContext, AuthError } from './tenant-context.js';
import { resolveScopedTenantByKey } from './tenant-api-keys.js';

const log = createChildLogger({ module: 'auth' });

// Augment Express Request with the resolved tenant context.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: ToolContext;
    }
  }
}

/**
 * Lookup-prefix length: `myai_` (5) + `live_`|`test_` (5) + 8 secret chars = 18.
 * 8 base62 secret chars (~62^8 ≈ 2.2e14) make the indexed prefix effectively
 * unique; the env segment is fixed-width so the slice length is env-independent.
 */
export const KEY_PREFIX_LEN = 18;

const KEY_RE = /^myai_(live|test)_[0-9A-Za-z]{20,}$/;

// Stable dummy hash for constant-time compare on tenant-not-found.
const DUMMY_HASH = crypto.createHash('sha256').update('myai_dummy_timing_safety_value').digest('hex');

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  let ba: Buffer;
  let bb: Buffer;
  try {
    ba = Buffer.from(a, 'hex');
    bb = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** IPv6-mapped IPv4 (`::ffff:127.0.0.1`) and bare IPv4/IPv6 loopback. */
function isLoopback(addr?: string | null): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || a === '127.0.0.1' || a.startsWith('127.');
}

function extractBearerOrApiKey(authHeader?: string, xApiKey?: string): string | undefined {
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const v = authHeader.slice(7).trim();
    if (v) return v;
  }
  if (xApiKey && xApiKey.trim()) return xApiKey.trim();
  return undefined;
}

/**
 * Resolve a tenant from a raw API key. Returns its context, or throws AuthError
 * (401 unknown/bad key, 403 suspended/deleted). Indexed lookup by prefix, then
 * constant-time hash compare.
 */
export async function resolveTenantByKey(rawKey: string): Promise<ToolContext> {
  const candidateHash = sha256Hex(rawKey);
  const prefix = rawKey.slice(0, KEY_PREFIX_LEN);
  // The prefix may match either the CURRENT bootstrap key or a key that was
  // rotated out and is still inside its grace window (tenant-keys.ts rotate).
  const tenant = await TenantModel.findOne({
    $or: [{ apiKeyPrefix: prefix }, { apiKeyPrefixPrevious: prefix }],
  })
    .select('+apiKeyHash +apiKeyHashPrevious')
    .lean<ITenant>()
    .exec();

  if (!tenant) {
    // Not a tenant-doc (bootstrap) key — try the scoped-key collection
    // (named/rotatable per-tenant keys, ADR-010 §3.6). It resolves the tenant
    // context (with scopes) or throws for a known-but-invalid scoped key.
    const scoped = await resolveScopedTenantByKey(rawKey, candidateHash, timingSafeEqualHex);
    if (scoped) return scoped;
    // Flatten timing: always run a compare even when the prefix is unknown.
    timingSafeEqualHex(candidateHash, DUMMY_HASH);
    throw new AuthError('unauthorized');
  }
  if (tenant.status !== 'active') {
    throw new AuthError('tenant not active', 403, 'FORBIDDEN');
  }
  if (tenant.apiKeyPrefixPrevious === prefix) {
    // Matched via the PREVIOUS prefix — only valid inside the rotation grace
    // window (rotateApiKey in tenant-keys.ts sets apiKeyPreviousExpiresAt).
    const graceOk =
      !!tenant.apiKeyPreviousExpiresAt && new Date(tenant.apiKeyPreviousExpiresAt).getTime() > Date.now();
    if (!graceOk || !tenant.apiKeyHashPrevious || !timingSafeEqualHex(candidateHash, tenant.apiKeyHashPrevious)) {
      throw new AuthError('unauthorized');
    }
  } else if (!timingSafeEqualHex(candidateHash, tenant.apiKeyHash)) {
    throw new AuthError('unauthorized');
  }
  return { tenantId: tenant.tenantId, plan: tenant.plan, region: tenant.region };
}

/**
 * The shared no-key branch for REST/MCP/WS: loopback or a matching
 * GATEWAY_LOCAL_TOKEN grants the default tenant (local); otherwise 401 when
 * enforcing, else the default tenant (backwards-compat under enforce=false).
 */
/** Tenancy config with a safe fallback (partial mocks / pre-init may omit it). */
function tenancyConfig(): {
  defaultTenantId: string;
  enforce: boolean;
  localToken?: string;
  previousLocalToken?: string;
  previousLocalTokenExpiresAt?: number;
} {
  return getConfig().tenancy ?? { defaultTenantId: 'default', enforce: false, localToken: undefined };
}

/**
 * Dual-valid grace window (`myai rotate-keys local`): the CURRENT token always
 * works; the PREVIOUS token (set by a rotation) keeps working until its
 * `previousLocalTokenExpiresAt` cutoff passes — so rotating the token never
 * 401s a caller that hasn't picked up the new value yet.
 */
export function resolveNoKey(socketAddr: string | undefined, localTokenHeader: string | undefined): ToolContext {
  const tenancy = tenancyConfig();
  const localTokenOk =
    !!tenancy.localToken && !!localTokenHeader && timingSafeEqualStr(localTokenHeader, tenancy.localToken);
  const graceTokenOk =
    !!tenancy.previousLocalToken &&
    !!tenancy.previousLocalTokenExpiresAt &&
    tenancy.previousLocalTokenExpiresAt > Date.now() &&
    !!localTokenHeader &&
    timingSafeEqualStr(localTokenHeader, tenancy.previousLocalToken);

  if (isLoopback(socketAddr) || localTokenOk || graceTokenOk) {
    return { tenantId: tenancy.defaultTenantId, plan: 'scale', local: true };
  }
  if (tenancy.enforce) {
    throw new AuthError('unauthorized');
  }
  return { tenantId: tenancy.defaultTenantId, plan: 'scale', local: false };
}

/** Resolve the tenant context for an HTTP (REST or MCP) request. */
export async function resolveTenant(req: Request): Promise<ToolContext> {
  const rawKey = extractBearerOrApiKey(req.header('authorization'), req.header('x-api-key'));
  if (rawKey) {
    // A present key must be valid regardless of enforce — never silently
    // downgrade a failed auth attempt to the default tenant.
    return resolveTenantByKey(rawKey);
  }
  // `req.socket.remoteAddress` is the RAW peer address (NOT req.ip — see header).
  return resolveNoKey(req.socket?.remoteAddress, req.header('x-gateway-local-token'));
}

interface AuthOptions {
  /** Exact request paths that bypass auth (e.g. /health, /api/openapi.json). */
  exemptPaths?: Set<string>;
  /** When true, GET requests bypass auth (used for the read-only MCP discovery GET). */
  exemptGet?: boolean;
}

// /api/auth/* are public (or self-authenticating via the JWT cookie): signup/login
// mint the session, logout clears it, and /me verifies the JWT itself. None use the
// per-tenant API key the REST middleware resolves, so they bypass it.
const REST_EXEMPT = new Set([
  '/health', '/health/deep', '/status', '/api/status/uptime', '/api/openapi.json', '/api/docs',
  '/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/auth/me',
  // Team-tier invites + members: JWT-cookie authenticated inside the handlers
  // (owner/admin role-gated), or public-by-token (lookup) — none use the
  // per-tenant API key this middleware resolves.
  '/api/auth/invites', '/api/auth/invites/revoke', '/api/auth/invites/lookup',
  '/api/auth/members', '/api/auth/members/role',
  // Audit trail + permission matrix (ADR-013 §5, RBAC v2): JWT-cookie
  // authenticated inside the handlers, members-capability gated.
  '/api/auth/audit', '/api/auth/audit/export', '/api/auth/permissions',
  // Scoped per-tenant API-key management (ADR-010 §3.6): JWT-cookie
  // authenticated + owner/admin gated inside the handlers, so they bypass the
  // per-tenant API-key middleware (an owner shouldn't need a key to mint keys).
  '/api/auth/api-keys', '/api/auth/api-keys/rotate', '/api/auth/api-keys/revoke',
  // SOC2 governance (ADR-013 §5): quarterly access review + evidence-export
  // report. Same JWT-cookie, members-capability gate inside the handlers.
  '/api/auth/access-review', '/api/auth/evidence',
  // Password reset: public by design (rate-limited; forgot never confirms an
  // account exists, reset/lookup are self-authenticating via the token).
  '/api/auth/password/forgot', '/api/auth/password/reset', '/api/auth/password/lookup',
  // Enterprise SSO (Phase 3): the IdP round-trip is the authentication — no
  // per-tenant API key. Metadata is a public gate check; the callbacks verify
  // the IdP token/assertion inside the handler and are env-gated per tenant.
  '/api/auth/sso/metadata', '/api/auth/sso/oidc/callback', '/api/auth/sso/saml/callback',
]);

/**
 * Express middleware factory. Resolves `req.tenant`, or rejects with the
 * AuthError's status/code. Mounts after body-parse + rate-limit, before routes.
 */
export function authenticate(opts: AuthOptions = {}) {
  const exemptPaths = opts.exemptPaths ?? REST_EXEMPT;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (exemptPaths.has(req.path) || (opts.exemptGet && req.method === 'GET')) {
      next();
      return;
    }
    try {
      req.tenant = await resolveTenant(req);
      next();
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('unauthorized');
      log.warn(
        { ip: req.socket?.remoteAddress, path: req.path, code: e.code },
        'auth rejected',
      );
      // Flat body — never echo the offending key.
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  };
}

/**
 * Resolve the tenant context for a WebSocket upgrade. Key via
 * `Sec-WebSocket-Protocol: myai-key.<key>` or `?api_key=<key>`; otherwise the
 * shared no-key branch. Throws AuthError when enforcing and unresolved.
 */
export async function authenticateWs(req: IncomingMessage): Promise<ToolContext> {
  let rawKey: string | undefined;

  const proto = req.headers['sec-websocket-protocol'];
  const protoStr = Array.isArray(proto) ? proto.join(',') : proto;
  if (protoStr) {
    for (const part of protoStr.split(',').map((p) => p.trim())) {
      if (part.startsWith('myai-key.')) {
        rawKey = part.slice('myai-key.'.length);
        break;
      }
    }
  }
  if (!rawKey && req.url) {
    const qpKey = new URL(req.url, 'http://localhost').searchParams.get('api_key');
    if (qpKey) rawKey = qpKey;
  }

  if (rawKey) {
    return resolveTenantByKey(rawKey);
  }
  const localTokenHeader = req.headers['x-gateway-local-token'];
  return resolveNoKey(
    req.socket?.remoteAddress,
    Array.isArray(localTokenHeader) ? localTokenHeader[0] : localTokenHeader,
  );
}

/** Build a ToolContext from a resolved request (or fall back to the default tenant). */
export function ctxFromReq(req: Request): ToolContext {
  if (req.tenant) return req.tenant;
  return { tenantId: tenancyConfig().defaultTenantId, plan: 'scale', local: true };
}

/** Validate that a string matches the myai key format (used by tests/tools). */
export function isApiKeyFormat(s: string): boolean {
  return KEY_RE.test(s);
}

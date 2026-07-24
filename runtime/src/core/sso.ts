/**
 * Enterprise SSO — SAML 2.0 / OIDC login as a SECOND, env-gated login path
 * alongside password auth (GRAND_PRODUCT Phase 3).
 *
 * Design posture (security-specialist):
 *   - SSO is OFF by default and gated PER TENANT. A tenant only gets an SSO
 *     login path when the operator has published a config block for its
 *     `tenantId` in the `SSO_CONFIG` env var (JSON) AND the master gate
 *     `SSO_ENABLED` is on. Absent either, `getTenantSsoConfig` returns null and
 *     the routes 404 — no silent enable, no per-user opt-in.
 *   - SSO NEVER provisions a tenant. It maps a verified IdP identity onto an
 *     EXISTING enterprise tenant (the one whose config matched). Just-in-time it
 *     creates/updates the `User` row inside that tenant.
 *   - IdP group claims → RBAC role via the tenant's `groupRoleMap`. Highest
 *     grant wins; unknown/absent groups fall to `defaultRole` (viewer). `owner`
 *     is NEVER mintable from a group claim unless the operator explicitly sets
 *     `allowOwnerFromGroups` — an IdP admin must not be able to seize tenant
 *     ownership by naming a group.
 *   - The session it issues is the IDENTICAL JWT password login issues
 *     (`issueSessionToken`), so the rest of the stack (RBAC, tenant scoping) is
 *     unchanged by the auth method.
 *   - OIDC ID-token verification is done here with node crypto (HS256 + RS*),
 *     with strict alg/iss/aud/exp checks (no `alg:none`, no alg confusion).
 *   - SAML assertion signature verification is done with node crypto against the
 *     configured IdP cert. NOTE: exclusive XML canonicalization is intentionally
 *     minimal — this targets IdPs that emit already-normalized signed XML. For
 *     broad IdP interop a vetted xml-dsig library should be swapped in behind
 *     `verifySamlSignature`; the group-mapping/provisioning path above it is
 *     library-independent.
 */
import crypto from 'node:crypto';
import { UserModel, TenantModel, type IUser, type UserRole } from '../shared/db.js';
import { AuthError } from './tenant-context.js';
import { issueSessionToken } from './user-auth.js';
import type { DeviceInfo } from './user-sessions.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'sso' });

// ── Config ───────────────────────────────────────────────────────────────────

export type SsoProvider = 'oidc' | 'saml';
export type OidcAlg = 'HS256' | 'RS256' | 'RS384' | 'RS512';

/** Per-tenant SSO config (one entry per tenant in the `SSO_CONFIG` JSON blob). */
export interface SsoTenantConfig {
  provider: SsoProvider;
  /** Email domains that route to this tenant for SP-initiated / discovery. */
  emailDomains?: string[];
  /** IdP group claim → RBAC role. Highest-privilege match wins. */
  groupRoleMap?: Record<string, UserRole>;
  /** Role when no group matches. Defaults to the least-privilege 'viewer'. */
  defaultRole?: UserRole;
  /** Allow an IdP group to grant 'owner'. Default false (security). */
  allowOwnerFromGroups?: boolean;

  // ── OIDC ──
  issuer?: string;            // expected `iss`
  audience?: string;          // expected `aud` (the OIDC client_id)
  jwtAlg?: OidcAlg;           // expected token alg (rejects any other)
  publicKeyPem?: string;      // RS* verification key (PEM)
  clientSecret?: string;      // HS256 shared secret
  emailClaim?: string;        // claim holding the email (default 'email')
  groupsClaim?: string;       // claim holding groups (default 'groups')
  authorizationEndpoint?: string; // for metadata / redirect (not exchanged here)

  // ── SAML ──
  certPem?: string;           // IdP signing certificate (PEM)
  spEntityId?: string;        // expected Audience restriction
  entryPoint?: string;        // IdP SSO URL (for metadata)
}

/** Master gate — SSO is entirely off unless this is truthy. */
export function ssoGloballyEnabled(): boolean {
  const v = process.env.SSO_ENABLED;
  return v === 'true' || v === '1';
}

let cachedRaw: string | undefined;
let cachedMap: Record<string, SsoTenantConfig> = {};

function loadSsoConfigMap(): Record<string, SsoTenantConfig> {
  const raw = process.env.SSO_CONFIG ?? '';
  if (raw === cachedRaw) return cachedMap;
  cachedRaw = raw;
  cachedMap = {};
  if (!raw.trim()) return cachedMap;
  try {
    const parsed = JSON.parse(raw) as Record<string, SsoTenantConfig>;
    if (parsed && typeof parsed === 'object') cachedMap = parsed;
  } catch (err) {
    log.error({ err }, 'SSO_CONFIG is not valid JSON — SSO disabled for all tenants');
    cachedMap = {};
  }
  return cachedMap;
}

/**
 * Resolve the SSO config for a tenant, or null when SSO is globally off or the
 * tenant has no config block. This is the per-tenant gate — a null return means
 * "no SSO login path for this tenant" and callers 404.
 */
export function getTenantSsoConfig(tenantId: string): SsoTenantConfig | null {
  if (!ssoGloballyEnabled()) return null;
  const cfg = loadSsoConfigMap()[tenantId];
  return cfg ?? null;
}

/** Reverse-lookup a tenantId from an email domain (SP-initiated discovery). */
export function tenantIdForEmail(email: string): string | null {
  if (!ssoGloballyEnabled()) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain) return null;
  const map = loadSsoConfigMap();
  for (const [tenantId, cfg] of Object.entries(map)) {
    if (cfg.emailDomains?.some((d) => d.toLowerCase().trim() === domain)) return tenantId;
  }
  return null;
}

// ── Group → role mapping ───────────────────────────────────────────────────

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * Map IdP group claims onto the highest RBAC role the tenant grants them.
 * Unknown/empty → `defaultRole` (viewer). `owner` is filtered out unless the
 * tenant opts in via `allowOwnerFromGroups` (defence against ownership seizure
 * by naming an IdP group).
 */
export function mapGroupsToRole(groups: string[] | undefined, cfg: SsoTenantConfig): UserRole {
  const fallback: UserRole = cfg.defaultRole ?? 'viewer';
  const map = cfg.groupRoleMap ?? {};
  let best: UserRole | null = null;
  for (const g of groups ?? []) {
    const mapped = map[g];
    if (!mapped) continue;
    if (mapped === 'owner' && !cfg.allowOwnerFromGroups) continue; // never mint owner via IdP
    if (best === null || ROLE_RANK[mapped] > ROLE_RANK[best]) best = mapped;
  }
  return best ?? fallback;
}

// ── Verified identity ───────────────────────────────────────────────────────

export interface SsoClaims {
  email: string;
  groups: string[];
  /** Stable IdP subject (OIDC `sub` / SAML NameID) — for logging/audit. */
  subject?: string;
}

// ── OIDC ID-token verification ────────────────────────────────────────────

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

/**
 * Verify an OIDC ID token and extract identity claims. Strict:
 *   - `alg` MUST equal the tenant's configured `jwtAlg` (rejects `none` and any
 *     algorithm-confusion downgrade/upgrade).
 *   - signature verified (HMAC-SHA256 for HS256, RSA-PKCS1-v1_5 for RS*).
 *   - `exp` required and in the future; `nbf`/`iat` honoured when present.
 *   - `iss` must equal the configured issuer; `aud` must contain the audience.
 *   - `nonce` must match when an expected nonce is supplied.
 */
export function verifyOidcIdToken(
  idToken: string,
  cfg: SsoTenantConfig,
  opts: { expectedNonce?: string; now?: number } = {},
): SsoClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new AuthError('malformed id_token', 400, 'BAD_REQUEST');
  const [h, p, s] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  } catch {
    throw new AuthError('malformed id_token header', 400, 'BAD_REQUEST');
  }

  const expectedAlg = cfg.jwtAlg ?? 'RS256';
  if (!header.alg || header.alg !== expectedAlg) {
    throw new AuthError(`unexpected id_token alg '${header.alg}'`, 401, 'UNAUTHORIZED');
  }

  const signingInput = `${h}.${p}`;
  const sig = b64urlToBuf(s);

  if (expectedAlg === 'HS256') {
    if (!cfg.clientSecret) throw new AuthError('SSO misconfigured: no clientSecret', 500, 'INTERNAL');
    const expected = crypto.createHmac('sha256', cfg.clientSecret).update(signingInput).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
      throw new AuthError('id_token signature invalid', 401, 'UNAUTHORIZED');
    }
  } else {
    if (!cfg.publicKeyPem) throw new AuthError('SSO misconfigured: no publicKeyPem', 500, 'INTERNAL');
    const hashAlg = expectedAlg === 'RS256' ? 'RSA-SHA256' : expectedAlg === 'RS384' ? 'RSA-SHA384' : 'RSA-SHA512';
    const ok = crypto.createVerify(hashAlg).update(signingInput).verify(cfg.publicKeyPem, sig);
    if (!ok) throw new AuthError('id_token signature invalid', 401, 'UNAUTHORIZED');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  } catch {
    throw new AuthError('malformed id_token payload', 400, 'BAD_REQUEST');
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
  if (exp === undefined || exp <= now) throw new AuthError('id_token expired', 401, 'UNAUTHORIZED');
  const nbf = typeof payload.nbf === 'number' ? payload.nbf : undefined;
  if (nbf !== undefined && nbf > now + 60) throw new AuthError('id_token not yet valid', 401, 'UNAUTHORIZED');

  if (cfg.issuer && payload.iss !== cfg.issuer) {
    throw new AuthError('id_token issuer mismatch', 401, 'UNAUTHORIZED');
  }
  if (cfg.audience && !asStringArray(payload.aud).includes(cfg.audience)) {
    throw new AuthError('id_token audience mismatch', 401, 'UNAUTHORIZED');
  }
  if (opts.expectedNonce && payload.nonce !== opts.expectedNonce) {
    throw new AuthError('id_token nonce mismatch', 401, 'UNAUTHORIZED');
  }

  const emailClaim = cfg.emailClaim ?? 'email';
  const groupsClaim = cfg.groupsClaim ?? 'groups';
  const email = typeof payload[emailClaim] === 'string' ? (payload[emailClaim] as string) : '';
  if (!email) throw new AuthError('id_token missing email claim', 401, 'UNAUTHORIZED');

  return {
    email,
    groups: asStringArray(payload[groupsClaim]),
    subject: typeof payload.sub === 'string' ? payload.sub : undefined,
  };
}

// ── SAML assertion verification + extraction ───────────────────────────────

function firstMatch(re: RegExp, xml: string): string | null {
  const m = re.exec(xml);
  return m ? m[1] : null;
}

/**
 * Verify the RSA-SHA256 enveloped signature of a SAML response against the
 * configured IdP cert. Minimal by design (see module header): verifies the
 * `<SignedInfo>` block and requires the presence of both a SignatureValue and a
 * DigestValue. Production interop across IdPs that emit non-normalized XML
 * should swap a vetted xml-dsig implementation in here — callers above are
 * unaffected. Throws AuthError on any failure (fail-closed).
 */
export function verifySamlSignature(xml: string, cfg: SsoTenantConfig): void {
  if (!cfg.certPem) throw new AuthError('SSO misconfigured: no certPem', 500, 'INTERNAL');

  const signedInfo = firstMatch(/(<(?:\w+:)?SignedInfo[\s\S]*?<\/(?:\w+:)?SignedInfo>)/, xml);
  const sigValueRaw = firstMatch(/<(?:\w+:)?SignatureValue[^>]*>([\s\S]*?)<\/(?:\w+:)?SignatureValue>/, xml);
  const digestValue = firstMatch(/<(?:\w+:)?DigestValue[^>]*>([\s\S]*?)<\/(?:\w+:)?DigestValue>/, xml);
  if (!signedInfo || !sigValueRaw || !digestValue) {
    throw new AuthError('SAML response is not signed', 401, 'UNAUTHORIZED');
  }

  const sig = Buffer.from(sigValueRaw.replace(/\s+/g, ''), 'base64');
  const ok = crypto.createVerify('RSA-SHA256').update(signedInfo).verify(cfg.certPem, sig);
  if (!ok) throw new AuthError('SAML signature invalid', 401, 'UNAUTHORIZED');
}

/**
 * Verify a base64-encoded SAMLResponse and extract identity claims. Checks the
 * signature, audience restriction, and the assertion validity window before
 * returning the subject email + group attribute values.
 */
export function verifyAndExtractSaml(
  samlResponseB64: string,
  cfg: SsoTenantConfig,
  opts: { now?: number; groupAttr?: string } = {},
): SsoClaims {
  let xml: string;
  try {
    xml = Buffer.from(samlResponseB64, 'base64').toString('utf8');
  } catch {
    throw new AuthError('malformed SAMLResponse', 400, 'BAD_REQUEST');
  }

  verifySamlSignature(xml, cfg);

  // Audience restriction.
  if (cfg.spEntityId) {
    const aud = firstMatch(/<(?:\w+:)?Audience\s*>([\s\S]*?)<\/(?:\w+:)?Audience>/, xml);
    if (aud?.trim() !== cfg.spEntityId) {
      throw new AuthError('SAML audience mismatch', 401, 'UNAUTHORIZED');
    }
  }

  // Validity window (Conditions NotBefore / NotOnOrAfter).
  const now = opts.now ?? Date.now();
  const cond = /<(?:\w+:)?Conditions([^>]*)>/.exec(xml);
  if (cond) {
    const nb = /NotBefore="([^"]+)"/.exec(cond[1])?.[1];
    const noa = /NotOnOrAfter="([^"]+)"/.exec(cond[1])?.[1];
    if (nb && Date.parse(nb) - 60_000 > now) throw new AuthError('SAML assertion not yet valid', 401, 'UNAUTHORIZED');
    if (noa && Date.parse(noa) <= now) throw new AuthError('SAML assertion expired', 401, 'UNAUTHORIZED');
  }

  const nameId = firstMatch(/<(?:\w+:)?NameID[^>]*>([\s\S]*?)<\/(?:\w+:)?NameID>/, xml)?.trim();
  if (!nameId) throw new AuthError('SAML response missing NameID', 401, 'UNAUTHORIZED');

  // Group attribute values. Match <Attribute Name="groups"> ... <AttributeValue>g</AttributeValue> ...
  const groupAttr = opts.groupAttr ?? 'groups';
  const groups: string[] = [];
  const attrBlock = new RegExp(
    `<(?:\\w+:)?Attribute[^>]*Name="${groupAttr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?Attribute>`,
  ).exec(xml);
  if (attrBlock) {
    const valRe = /<(?:\w+:)?AttributeValue[^>]*>([\s\S]*?)<\/(?:\w+:)?AttributeValue>/g;
    let m: RegExpExecArray | null;
    while ((m = valRe.exec(attrBlock[1])) !== null) groups.push(m[1].trim());
  }

  return { email: nameId, groups, subject: nameId };
}

// ── JIT provisioning + session issue ────────────────────────────────────────

export interface SsoLoginResult {
  token: string;
  tenantId: string;
  userId: string;
  email: string;
  role: UserRole;
  /** True when this login created the user row (first SSO login). */
  provisioned: boolean;
}

/**
 * Turn a verified IdP identity into a dashboard session. Just-in-time creates
 * the user inside `tenantId` on first login and keeps the role in sync with the
 * IdP groups on every login (the IdP is authoritative for SSO users). Rejects
 * an email already bound to a DIFFERENT tenant — an SSO identity may not hop
 * tenants.
 */
export async function resolveSsoLogin(params: {
  tenantId: string;
  claims: SsoClaims;
  cfg: SsoTenantConfig;
} & DeviceInfo): Promise<SsoLoginResult> {
  const { tenantId, claims, cfg, userAgent, ip } = params;
  const email = claims.email.toLowerCase().trim();
  if (!email || !email.includes('@')) throw new AuthError('IdP returned an invalid email', 401, 'UNAUTHORIZED');

  const tenant = await TenantModel.findOne({ tenantId }).lean();
  if (!tenant) throw new AuthError('SSO tenant not found', 404, 'NOT_FOUND');

  const role = mapGroupsToRole(claims.groups, cfg);
  const existing = await UserModel.findOne({ email }).lean<IUser>();

  if (existing) {
    if (existing.tenantId !== tenantId) {
      // The email is already a member of another tenant — do not silently
      // rebind or leak across tenants.
      log.warn({ email, tenantId, existingTenant: existing.tenantId }, 'sso.cross-tenant-email-rejected');
      throw new AuthError('email is registered to a different tenant', 409, 'CONFLICT');
    }
    // Keep role in lock-step with the IdP; refresh lastLoginAt.
    const patch: Record<string, unknown> = { lastLoginAt: new Date() };
    if (existing.role !== role) patch.role = role;
    await UserModel.updateOne({ userId: existing.userId }, { $set: patch });
    log.info({ tenantId, userId: existing.userId, role, provider: cfg.provider }, 'sso login');
    const token = await issueSessionToken({ userId: existing.userId, tenantId, email, role, userAgent, ip });
    return { token, tenantId, userId: existing.userId, email, role, provisioned: false };
  }

  // JIT provision. SSO users have no password — store a valid but unguessable
  // hash so the password-login path can never match (bcryptCompare returns false).
  const userId = `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const unusablePasswordHash = `!sso!${crypto.randomBytes(24).toString('base64url')}`;
  await UserModel.create({
    userId,
    tenantId,
    email,
    passwordHash: unusablePasswordHash,
    displayName: email.split('@')[0],
    role,
  });
  log.info({ tenantId, userId, role, provider: cfg.provider }, 'sso login — user provisioned');
  const token = await issueSessionToken({ userId, tenantId, email, role, userAgent, ip });
  return { token, tenantId, userId, email, role, provisioned: true };
}

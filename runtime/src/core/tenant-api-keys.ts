/**
 * Scoped, rotatable per-tenant API keys (ADR-010 §3.6).
 *
 * The tenant doc's single `apiKeyHash` (tenant-keys.ts) is the bootstrap
 * credential; this module owns the NAMED, SCOPED keys an owner/admin mints from
 * the dashboard. It delivers what MVP M1 deferred:
 *   - create   — a named, scoped key; raw shown ONCE (never persisted/logged).
 *   - list     — non-secret views (prefix + last-used + status), never the hash.
 *   - rotate   — mint a replacement inheriting name+scopes; the OLD key stays
 *                valid for a grace window (default 60 min) so callers swap with
 *                ZERO downtime, then auth rejects it once `expiresAt` passes.
 *   - revoke   — instant kill (status='revoked'); no grace.
 *   - resolve  — the auth hot-path lookup (prefix → constant-time hash compare),
 *                honoring grace expiry + tenant status, stamping last-used.
 *
 * Same secret posture as auth.ts: 256-bit CSPRNG key, only its sha256 stored,
 * constant-time compare, never log a full key. Every lifecycle action is
 * appended to the privileged-action audit trail (ADR-013 §5).
 */
import crypto from 'node:crypto';
import { TenantApiKeyModel, TenantModel, type ITenantApiKey, type ITenant } from '../shared/db.js';
import { AuthError, type ToolContext, type CtxRole } from './tenant-context.js';
import { sha256Hex, KEY_PREFIX_LEN } from './auth.js';
import { generateApiKey } from './tenant-keys.js';
import { recordAuditEvent } from './audit-log.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'tenant-api-keys' });

/**
 * The scope vocabulary a key may be granted. `*` is full access; the granular
 * verbs mirror the gateway's tool families. Enforcement of individual scopes on
 * each tool call is a follow-up; today the set is validated at mint time and
 * threaded onto the request context so callers/enforcement can read it.
 */
export const API_KEY_SCOPES = [
  '*',
  'brain:read', 'brain:write',
  'tasks:read', 'tasks:write',
  'memory:read', 'memory:write',
  'chat',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const VALID_SCOPES: ReadonlySet<string> = new Set(API_KEY_SCOPES);

/** Default rotation grace window — the old key keeps working this long. */
const DEFAULT_GRACE_MINUTES = Number(process.env.APIKEY_ROTATION_GRACE_MINUTES) || 60;
const MAX_GRACE_MINUTES = 7 * 24 * 60; // 7 days — a generous but bounded ceiling

/** Per-tenant cap on live (non-revoked) keys — abuse/runaway guard. */
const MAX_ACTIVE_KEYS = Number(process.env.APIKEY_MAX_ACTIVE) || 25;

/** Non-secret projection of a key — the ONLY shape returned to the dashboard. */
export interface ApiKeyView {
  keyId: string;
  name: string;
  scopes: string[];
  prefix: string;            // non-secret lookup prefix (e.g. "myai_live_8Kf2…")
  env: 'live' | 'test';
  status: ITenantApiKey['status'];
  lastUsedAt?: string;
  expiresAt?: string;        // set only on a rotated-out key inside its grace
  createdAt?: string;
  createdBy?: string;
  rotatedFromKeyId?: string;
}

function toView(k: ITenantApiKey): ApiKeyView {
  return {
    keyId: k.keyId,
    name: k.name,
    scopes: k.scopes,
    prefix: k.apiKeyPrefix,
    env: k.env,
    status: k.status,
    lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : undefined,
    expiresAt: k.expiresAt ? new Date(k.expiresAt).toISOString() : undefined,
    createdAt: k.createdAt ? new Date(k.createdAt).toISOString() : undefined,
    createdBy: k.createdBy,
    rotatedFromKeyId: k.rotatedFromKeyId,
  };
}

function mintKeyId(): string {
  return `key_${crypto.randomBytes(9).toString('hex')}`;
}

/** Validate + normalize requested scopes. Empty/absent → full access (`['*']`). */
function normalizeScopes(scopes?: unknown): string[] {
  if (scopes == null) return ['*'];
  if (!Array.isArray(scopes)) throw new AuthError('scopes must be an array', 400, 'BAD_REQUEST');
  const cleaned = [...new Set(scopes.map((s) => String(s).trim()).filter(Boolean))];
  if (cleaned.length === 0) return ['*'];
  for (const s of cleaned) {
    if (!VALID_SCOPES.has(s)) {
      throw new AuthError(`unknown scope: ${s}`, 400, 'BAD_REQUEST');
    }
  }
  // `*` subsumes everything — collapse to just `['*']`.
  return cleaned.includes('*') ? ['*'] : cleaned;
}

/** Who performed a lifecycle action — threaded through for the audit trail. */
export interface ApiKeyActor {
  userId?: string;
  role?: CtxRole;
}

export interface CreateApiKeyInput {
  tenantId: string;
  name: string;
  scopes?: string[];
  env?: 'live' | 'test';
  actor?: ApiKeyActor;
}

export interface CreateApiKeyResult {
  key: ApiKeyView;
  /** Show-once raw key — this response is the ONLY place it ever appears. */
  rawKey: string;
}

/**
 * Mint a new scoped key for a tenant. Retries on the rare prefix collision.
 * The raw key is returned exactly once and never persisted.
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  const name = input.name?.trim();
  if (!name) throw new AuthError('name is required', 400, 'BAD_REQUEST');
  if (name.length > 80) throw new AuthError('name too long (max 80)', 400, 'BAD_REQUEST');
  const scopes = normalizeScopes(input.scopes);
  const env = input.env === 'test' ? 'test' : 'live';

  const activeCount = await TenantApiKeyModel.countDocuments({ tenantId: input.tenantId, status: 'active' });
  if (activeCount >= MAX_ACTIVE_KEYS) {
    throw new AuthError(`active key limit reached (${MAX_ACTIVE_KEYS}) — revoke one first`, 409, 'CONFLICT');
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const gen = generateApiKey(env);
    const keyId = mintKeyId();
    try {
      const doc = await TenantApiKeyModel.create({
        keyId,
        tenantId: input.tenantId,
        name,
        scopes,
        apiKeyHash: gen.hash,
        apiKeyPrefix: gen.prefix,
        env,
        status: 'active',
        createdBy: input.actor?.userId,
      });
      log.info({ tenantId: input.tenantId, keyId, scopes, prefix: gen.prefix }, 'api key created');
      recordAuditEvent({
        tenantId: input.tenantId,
        actor: { userId: input.actor?.userId, role: input.actor?.role ?? 'admin', via: 'jwt' },
        action: 'apikey.create',
        target: keyId,
        detail: { name, scopes, env },
      });
      return { key: toView(doc as ITenantApiKey), rawKey: gen.raw };
    } catch (err) {
      // Regenerate only on a prefix/keyId uniqueness collision.
      if (isDuplicateKeyError(err) && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error('failed to mint api key after retries');
}

function isDuplicateKeyError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;
}

/** List a tenant's keys (newest first), non-secret views only. */
export async function listApiKeys(tenantId: string): Promise<ApiKeyView[]> {
  const keys = await TenantApiKeyModel.find({ tenantId })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean<ITenantApiKey[]>();
  return keys.map(toView);
}

export interface RotateApiKeyInput {
  tenantId: string;
  keyId: string;
  /** Grace window the OLD key stays valid; 0 = immediate cutover. */
  graceMinutes?: number;
  actor?: ApiKeyActor;
}

/**
 * Rotate a key with a grace overlap: mint a replacement that inherits the old
 * key's name + scopes, then mark the old key with an `expiresAt` so it keeps
 * authenticating for `graceMinutes` before auth rejects it. Zero downtime — the
 * caller swaps in the new key any time inside the window. Revoked/expired keys
 * cannot be rotated (mint a fresh one instead).
 */
export async function rotateApiKey(input: RotateApiKeyInput): Promise<CreateApiKeyResult> {
  const old = await TenantApiKeyModel.findOne({ tenantId: input.tenantId, keyId: input.keyId });
  if (!old) throw new AuthError('api key not found', 404, 'NOT_FOUND');
  if (old.status !== 'active') throw new AuthError('cannot rotate a revoked key', 409, 'CONFLICT');

  const graceMin = Math.min(
    Math.max(input.graceMinutes ?? DEFAULT_GRACE_MINUTES, 0),
    MAX_GRACE_MINUTES,
  );

  for (let attempt = 0; attempt < 5; attempt++) {
    const gen = generateApiKey(old.env);
    const newKeyId = mintKeyId();
    try {
      const created = await TenantApiKeyModel.create({
        keyId: newKeyId,
        tenantId: input.tenantId,
        name: old.name,
        scopes: old.scopes,
        apiKeyHash: gen.hash,
        apiKeyPrefix: gen.prefix,
        env: old.env,
        status: 'active',
        createdBy: input.actor?.userId,
        rotatedFromKeyId: old.keyId,
      });
      // Retire the old key: keep it 'active' but set the grace cutoff (auth
      // rejects once past). graceMin=0 → expires now (immediate cutover).
      old.expiresAt = new Date(Date.now() + graceMin * 60_000);
      old.rotatedToKeyId = newKeyId;
      await old.save();

      log.info(
        { tenantId: input.tenantId, oldKeyId: old.keyId, newKeyId, graceMin },
        'api key rotated',
      );
      recordAuditEvent({
        tenantId: input.tenantId,
        actor: { userId: input.actor?.userId, role: input.actor?.role ?? 'admin', via: 'jwt' },
        action: 'apikey.rotate',
        target: old.keyId,
        detail: { newKeyId, graceMinutes: graceMin },
      });
      return { key: toView(created as ITenantApiKey), rawKey: gen.raw };
    } catch (err) {
      if (isDuplicateKeyError(err) && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error('failed to rotate api key after retries');
}

export interface RevokeApiKeyInput {
  tenantId: string;
  keyId: string;
  actor?: ApiKeyActor;
}

/** Instantly revoke a key (no grace). Idempotent-ish: revoking twice is a no-op. */
export async function revokeApiKey(input: RevokeApiKeyInput): Promise<ApiKeyView> {
  const key = await TenantApiKeyModel.findOne({ tenantId: input.tenantId, keyId: input.keyId });
  if (!key) throw new AuthError('api key not found', 404, 'NOT_FOUND');
  if (key.status !== 'revoked') {
    key.status = 'revoked';
    key.expiresAt = new Date();
    await key.save();
    log.info({ tenantId: input.tenantId, keyId: input.keyId }, 'api key revoked');
    recordAuditEvent({
      tenantId: input.tenantId,
      actor: { userId: input.actor?.userId, role: input.actor?.role ?? 'admin', via: 'jwt' },
      action: 'apikey.revoke',
      target: input.keyId,
      detail: { name: key.name },
    });
  }
  return toView(key as ITenantApiKey);
}

/**
 * Auth hot-path resolution of a scoped key. Returns the tenant context (with
 * scopes), or null when this key is NOT a scoped key (so the caller can fall
 * through to the legacy tenant-doc path). Throws AuthError for a scoped key that
 * exists but is revoked/expired/hash-mismatched or whose tenant is inactive.
 *
 * Defensive against a partial db mock (unit tests that stub only TenantModel):
 * if the model isn't wired, treat it as "no scoped key" and return null.
 */
export async function resolveScopedTenantByKey(
  rawKey: string,
  candidateHash: string,
  timingSafeEqualHex: (a: string, b: string) => boolean,
): Promise<ToolContext | null> {
  if (!TenantApiKeyModel || typeof TenantApiKeyModel.findOne !== 'function') return null;
  const prefix = rawKey.slice(0, KEY_PREFIX_LEN);
  const rec = await TenantApiKeyModel.findOne({ apiKeyPrefix: prefix })
    .select('+apiKeyHash')
    .lean<ITenantApiKey>()
    .exec();
  if (!rec) return null;

  if (rec.status !== 'active') throw new AuthError('unauthorized');
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() <= Date.now()) {
    // Rotation grace elapsed (or a 0-grace immediate cutover) — treat as an
    // unknown key. `<=` makes graceMinutes=0 (expiresAt == mint instant) reject
    // deterministically rather than depending on sub-millisecond timing.
    throw new AuthError('unauthorized');
  }
  if (!timingSafeEqualHex(candidateHash, rec.apiKeyHash)) throw new AuthError('unauthorized');

  // The owning tenant must itself be active — suspending a tenant instantly
  // kills all its scoped keys.
  const tenant = await TenantModel.findOne({ tenantId: rec.tenantId }).lean<ITenant>().exec();
  if (!tenant || tenant.status !== 'active') {
    throw new AuthError('tenant not active', 403, 'FORBIDDEN');
  }

  // Best-effort last-used stamp — never block auth on this write.
  void TenantApiKeyModel.updateOne({ keyId: rec.keyId }, { $set: { lastUsedAt: new Date() } })
    .exec?.()
    ?.catch?.(() => {});

  return {
    tenantId: rec.tenantId,
    plan: tenant.plan,
    region: tenant.region,
    isolationTier: tenant.isolationTier,
    scopes: rec.scopes,
    keyId: rec.keyId,
    mcpToolAllowlist: tenant.mcpToolAllowlist,
    mcpToolDenylist: tenant.mcpToolDenylist,
  };
}

export { sha256Hex };

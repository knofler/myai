/**
 * hosted-brain.ts — Managed brain remote: the SERVER side of the brain's
 * `origin` (ADR-017). The gateway provisions and serves one bare git repo per
 * tenant so users who won't self-host git get turnkey cross-device continuity.
 *
 * The brain client is unchanged: a hosted remote is just another `origin` URL
 * fed to the existing push-on-merge / pull-on-boot auto-sync (brain.ts). This
 * module owns provisioning, token auth, and quota — NOT the git-over-HTTP
 * transport route (a later slice calls verifyHostedToken/checkHostedQuota).
 *
 * Self-host stays the DEFAULT (data-locality — the brain is the user's repo in
 * every tier). The hosted remote is an opt-in Pro/Team upsell, gated by
 * billing.hasHostedBrain(plan). The local single-operator tenant is never
 * hosted.
 *
 * Layout (mirrors brainEnvFor's per-tenant isolation, ADR-010):
 *   <myai home>/hosted-brains/<tenantId>.git   bare repo (the remote)
 *   <myai home>/hosted-brains/<tenantId>.json  provisioning metadata
 *
 * Encryption at rest (ADR-017 §5): git objects live on an encrypted volume;
 * the access token is NEVER persisted in plaintext (SHA-256 hash only), and the
 * encryption posture is asserted via HOSTED_BRAIN_DATA_ENCRYPTED and surfaced
 * in hostedBrainInfo so ops can verify it fleet-wide.
 *
 * Dependency-free (node builtins only), env-injectable for hermetic tests —
 * same discipline as brain.ts.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { hasHostedBrain } from './billing.js';
import { myaiHome, slugify } from './brain.js';
import { SYSTEM_CONTEXT } from './tenant-context.js';
import type { TenantPlan } from '../shared/db.js';

/** Thrown when provisioning is refused (not entitled) or a tenant is invalid. */
export class HostedBrainError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 402, code = 'HOSTED_BRAIN_UNAVAILABLE') {
    super(message);
    this.name = 'HostedBrainError';
    this.status = status;
    this.code = code;
  }
}

/** On-disk provisioning record. The plaintext token is NEVER stored here. */
export interface HostedBrainMeta {
  tenantId: string;
  plan: TenantPlan;
  /** SHA-256 hex of the access token — the only form persisted. */
  tokenHash: string;
  createdAt: string;
  rotatedAt: string;
  /** Whether the data volume is asserted encrypted (HOSTED_BRAIN_DATA_ENCRYPTED). */
  dataEncrypted: boolean;
}

/** Public status (no secret material). */
export interface HostedBrainInfo {
  provisioned: boolean;
  tenantId: string;
  plan?: TenantPlan;
  remoteUrl?: string;
  createdAt?: string;
  rotatedAt?: string;
  dataEncrypted?: boolean;
  usedBytes?: number;
  limitBytes?: number;
  withinQuota?: boolean;
}

export interface ProvisionResult {
  remoteUrl: string;
  /** Plaintext access token — returned ONCE, never persisted. */
  token: string;
  created: boolean;
}

export interface QuotaResult {
  withinQuota: boolean;
  usedBytes: number;
  /** -1 = unlimited. */
  limitBytes: number;
  plan: TenantPlan;
}

// ── per-plan hosted-repo byte caps (mirrors billing brainMaxAtoms tiering) ────
const MB = 1024 * 1024;
const HOSTED_QUOTA_BYTES: Readonly<Record<TenantPlan, number>> = {
  free: 0, // not entitled
  solo: 100 * MB,
  team: 1024 * MB,
  scale: -1, // unlimited
} as const;

/** The hosted-repo byte cap for a plan (-1 = unlimited). */
export function hostedQuota(plan: TenantPlan): number {
  return HOSTED_QUOTA_BYTES[plan] ?? HOSTED_QUOTA_BYTES.free;
}

// ── location resolution (tenant-scoped by construction) ───────────────────────

/**
 * Root directory holding every tenant's `<tenantId>.git` bare repo +
 * `<tenantId>.json` metadata. Exported for the git-over-HTTP transport route
 * (hosted-brain-transport.ts), which needs it as `GIT_PROJECT_ROOT` for the
 * `git http-backend` CGI process — the one other place allowed to know this
 * layout, per the tenant-scoping discipline in this module's header.
 */
export function hostedRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(myaiHome(env), 'hosted-brains');
}

/**
 * Sanitise a tenant id to a safe single path segment; throws on anything
 * unsafe. Exported so the transport route validates/derives the on-disk
 * `<tenantId>.git` segment the exact same way provisioning did — never its
 * own copy of the slugify + local-tenant-refusal rule.
 */
export function safeTenant(tenantId: string): string {
  const t = slugify(tenantId);
  if (!t) throw new HostedBrainError(`invalid tenantId '${tenantId}'`, 400, 'BAD_TENANT');
  if (tenantId === SYSTEM_CONTEXT.tenantId) {
    throw new HostedBrainError('the local operator tenant is self-hosted — not hostable', 400, 'LOCAL_TENANT');
  }
  return t;
}

function repoDir(tenantId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(hostedRoot(env), `${safeTenant(tenantId)}.git`);
}

function metaPath(tenantId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(hostedRoot(env), `${safeTenant(tenantId)}.json`);
}

function dataEncrypted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HOSTED_BRAIN_DATA_ENCRYPTED === '1' || env.HOSTED_BRAIN_DATA_ENCRYPTED === 'true';
}

/** Base gateway URL clients push/fetch through (no trailing slash). */
function gatewayBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.HOSTED_BRAIN_BASE_URL || 'https://api.myai.dev').replace(/\/+$/, '');
}

/**
 * The git remote URL a tenant sets as `origin`. Token embedded git-Basic-auth
 * style so the existing plain `git push/fetch` authenticate with no client
 * change. Omit `token` for the display form (no secret).
 */
export function hostedRemoteUrl(tenantId: string, token?: string, env: NodeJS.ProcessEnv = process.env): string {
  const t = safeTenant(tenantId);
  const base = gatewayBase(env).replace(/^https?:\/\//, '');
  const scheme = gatewayBase(env).startsWith('http://') ? 'http' : 'https';
  const cred = token ? `x-access-token:${token}@` : '';
  return `${scheme}://${cred}${base}/brain/${t}.git`;
}

// ── git plumbing (local, non-network) ─────────────────────────────────────────

function git(dir: string, ...args: string[]): void {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`hosted-brain: git unavailable: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`hosted-brain: git ${args[0]} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
}

function readMeta(tenantId: string, env: NodeJS.ProcessEnv = process.env): HostedBrainMeta | null {
  const p = metaPath(tenantId, env);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as HostedBrainMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: HostedBrainMeta, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(hostedRoot(env), { recursive: true });
  // 0600 — the meta holds the token hash; keep it owner-only.
  writeFileSync(metaPath(meta.tenantId, env), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── provisioning ──────────────────────────────────────────────────────────────

/**
 * Provision (or adopt) the tenant's hosted brain remote. Gated on
 * hasHostedBrain(plan) — free tier is refused. Idempotent: an existing bare
 * repo is adopted, but a token is (re)minted every call (the plaintext is only
 * available at provision time — use rotateHostedToken to reissue explicitly if
 * you must keep the old repo but need a fresh token surfaced).
 *
 * Returns the remote URL + the plaintext token ONCE (never persisted).
 */
export function provisionHostedBrain(
  tenantId: string,
  plan: TenantPlan,
  env: NodeJS.ProcessEnv = process.env,
): ProvisionResult {
  const t = safeTenant(tenantId);
  if (!hasHostedBrain(plan)) {
    throw new HostedBrainError(
      `plan '${plan}' has no hosted brain — upgrade to Solo to enable cross-device continuity`,
    );
  }
  mkdirSync(hostedRoot(env), { recursive: true });
  const dir = repoDir(tenantId, env);
  const created = !existsSync(dir);
  if (created) {
    mkdirSync(dir, { recursive: true });
    // Bare repo, default branch main — it only ever receives pushes / serves fetches.
    if (spawnSync('git', ['init', '--bare', '-b', 'main', dir]).status !== 0) {
      git(dir, 'init', '--bare');
      git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    }
  }
  const { token, hash } = mintToken();
  const now = new Date().toISOString();
  const existing = readMeta(tenantId, env);
  writeMeta(
    {
      tenantId: t,
      plan,
      tokenHash: hash,
      createdAt: existing?.createdAt ?? now,
      rotatedAt: now,
      dataEncrypted: dataEncrypted(env),
    },
    env,
  );
  return { remoteUrl: hostedRemoteUrl(tenantId, token, env), token, created };
}

/**
 * Mint a fresh token (invalidating the old one) — leak response / reissue.
 *
 * Re-checks hasHostedBrain(plan) against the CALLER'S CURRENT plan (not the
 * plan stored at provision time): a tenant that downgraded to free after
 * provisioning must not be able to keep minting fresh access tokens for a
 * hosted brain they're no longer paying for. Existing data/repo is untouched
 * either way (lapse never destroys data — mirrors provisionHostedBrain).
 */
export function rotateHostedToken(
  tenantId: string,
  plan: TenantPlan,
  env: NodeJS.ProcessEnv = process.env,
): ProvisionResult {
  const meta = readMeta(tenantId, env);
  if (!meta) throw new HostedBrainError(`no hosted brain for tenant '${tenantId}'`, 404, 'NOT_PROVISIONED');
  if (!hasHostedBrain(plan)) {
    throw new HostedBrainError(
      `plan '${plan}' has no hosted brain — upgrade to Solo to enable cross-device continuity`,
    );
  }
  const { token, hash } = mintToken();
  writeMeta({ ...meta, plan, tokenHash: hash, rotatedAt: new Date().toISOString() }, env);
  return { remoteUrl: hostedRemoteUrl(tenantId, token, env), token, created: false };
}

/** Remove the hosted repo and its metadata (does not touch the tenant's own brain). */
export function deprovisionHostedBrain(tenantId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = repoDir(tenantId, env);
  const meta = metaPath(tenantId, env);
  const had = existsSync(dir) || existsSync(meta);
  rmSync(dir, { recursive: true, force: true });
  rmSync(meta, { force: true });
  return had;
}

// ── auth ────────────────────────────────────────────────────────────────────

/**
 * Verify a tenant's access token against the stored hash. Timing-safe.
 * Fail-closed: unknown tenant / missing metadata / mismatch → false. This is
 * what the (later) git-over-HTTP transport route calls per request.
 */
export function verifyHostedToken(
  tenantId: string,
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!token) return false;
  let meta: HostedBrainMeta | null;
  try {
    meta = readMeta(tenantId, env);
  } catch {
    return false;
  }
  if (!meta?.tokenHash) return false;
  const got = Buffer.from(sha256(token), 'hex');
  const want = Buffer.from(meta.tokenHash, 'hex');
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

// ── quota ─────────────────────────────────────────────────────────────────────

/** Recursive on-disk byte size of a directory (git objects + refs + packs). */
function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirBytes(p);
    } else if (entry.isFile()) {
      try {
        total += statSync(p).size;
      } catch {
        /* raced deletion — ignore */
      }
    }
  }
  return total;
}

/**
 * Is the tenant's hosted repo within its plan quota? The transport pre-receive
 * path calls this BEFORE accepting a push, so the client can't bypass it.
 */
export function checkHostedQuota(
  tenantId: string,
  plan: TenantPlan,
  env: NodeJS.ProcessEnv = process.env,
): QuotaResult {
  const limitBytes = hostedQuota(plan);
  const usedBytes = dirBytes(repoDir(tenantId, env));
  const withinQuota = limitBytes < 0 || usedBytes <= limitBytes;
  return { withinQuota, usedBytes, limitBytes, plan };
}

// ── status ────────────────────────────────────────────────────────────────────

/** Public provisioning status for a tenant (no secret material). */
export function hostedBrainInfo(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): HostedBrainInfo {
  const meta = readMeta(tenantId, env);
  if (!meta || !existsSync(repoDir(tenantId, env))) {
    return { provisioned: false, tenantId: safeTenant(tenantId) };
  }
  const quota = checkHostedQuota(tenantId, meta.plan, env);
  return {
    provisioned: true,
    tenantId: meta.tenantId,
    plan: meta.plan,
    remoteUrl: hostedRemoteUrl(tenantId, undefined, env),
    createdAt: meta.createdAt,
    rotatedAt: meta.rotatedAt,
    dataEncrypted: meta.dataEncrypted,
    usedBytes: quota.usedBytes,
    limitBytes: quota.limitBytes,
    withinQuota: quota.withinQuota,
  };
}

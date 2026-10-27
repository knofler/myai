/**
 * Where a non-operator tenant may register a repo — v1 gate G5 (NF-1).
 *
 * The host runner works a tenant's task in the checkout its roster names, so a
 * tenant that could register `/repos/<operator-repo>` (or `…/AI/.`) would get
 * its prompt run inside the operator's code. A tenant's repos must live under
 * its own root: `${MYAI_TENANT_REPO_ROOT:-/repos/tenants}/<tenantId>/<name>`,
 * named after the last path segment. Card-only placeholders
 * (`/repocard/<name>`) are not checkouts and stay allowed. The runner repeats
 * the check on the host side with realpath.
 */
import { posix } from 'node:path';
import { realpathSync } from 'node:fs';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function tenantRepoRoot(tenantId: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.MYAI_TENANT_REPO_ROOT || '/repos/tenants').replace(/\/+$/, '');
  return `${base}/${tenantId}`;
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Throws when `rawPath` is not a valid repo location for a non-operator tenant. */
export function assertTenantRepoPath(tenantId: string, name: string, rawPath: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!SAFE_SEGMENT.test(tenantId) || tenantId === '.' || tenantId === '..') {
    throw new Error('tenant id is not usable as a repo directory');
  }
  if (!SAFE_SEGMENT.test(name) || name === '.' || name === '..') {
    throw new Error('repo name must be a plain directory name (letters, digits, . _ -), not "." or ".."');
  }
  if (rawPath === `/repocard/${name}`) return;
  if (!rawPath.startsWith('/')) throw new Error('repo path must be absolute');
  if (rawPath.split('/').some((seg) => seg === '.' || seg === '..')) {
    throw new Error('repo path must not contain "." or ".." segments');
  }
  const norm = posix.normalize(rawPath).replace(/\/+$/, '');
  const root = tenantRepoRoot(tenantId, env);
  if (!norm.startsWith(`${root}/`) || norm.slice(root.length + 1).includes('/')) {
    throw new Error(`repo path must be ${root}/<name>`);
  }
  if (posix.basename(norm) !== name) throw new Error('repo name must match the last path segment');
  // Where the path exists on this side, follow symlinks: it must stay inside the root.
  const realRoot = realOrNull(root);
  const real = realOrNull(norm);
  if (real && (!realRoot || !real.startsWith(`${realRoot}/`))) {
    throw new Error('repo path resolves outside the tenant repo root');
  }
}

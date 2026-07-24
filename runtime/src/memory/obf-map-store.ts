/**
 * B-9 follow-up — client-only local store for the obfuscation reverse map.
 *
 * `obfuscate.ts` pseudonymises identifiers before a descriptor is embedded and
 * upserted to a REMOTE index (Atlas). The reverse `{token: original}` map is
 * what makes that reversible — so it must never travel with the row it
 * belongs to (that would ship the real identifiers right back to the same
 * remote index B-9 exists to keep them out of). This module keeps the map on
 * the LOCAL disk only, under the same `~/.myai` root the brain store and
 * hosted-brain metadata already use (see `myaiHome()` in `core/brain.ts`), so
 * a remote/Atlas operator reading the corpus never sees it.
 *
 * Keyed by a hash of (tenantId, repo, source, contentHash) rather than the raw
 * values — collision-free, fixed-length, and immune to path traversal from
 * any of those inputs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { myaiHome } from '../core/brain.js';

function obfMapDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(myaiHome(env), 'brain', 'obf-map');
}

/** Deterministic, collision-free, path-safe key for one stored row's reverse map. */
export function obfMapKey(tenantId: string, repo: string, source: string, contentHash: string): string {
  return createHash('sha256').update(`${tenantId}\0${repo}\0${source}\0${contentHash}`).digest('hex');
}

function obfMapPath(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(obfMapDir(env), `${key}.json`);
}

/** Persist a row's reverse map locally. No-op for an empty map (nothing to reverse). */
export function saveObfMap(key: string, map: Record<string, string>, env: NodeJS.ProcessEnv = process.env): void {
  if (Object.keys(map).length === 0) return;
  const dir = obfMapDir(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // 0o600 — the map contains the real paths/repo names/handles/emails it hides remotely.
  writeFileSync(obfMapPath(key, env), JSON.stringify(map), { mode: 0o600 });
}

/** Load a row's reverse map, or undefined if none was stored (or this machine never wrote it). */
export function loadObfMap(key: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const p = obfMapPath(key, env);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

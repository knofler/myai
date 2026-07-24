import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { addHook } from '../hooks/registry.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'agent-workspace' });

/**
 * Per-session workspace directories (MYAI_GATEWAY Phase 6).
 *
 * Each gateway session that needs scratch space gets an isolated directory
 * under the workspace root. Directories are removed when the session closes
 * (via the `session:end` hook registered by `registerWorkspaceCleanupHook`)
 * or explicitly through `cleanupWorkspace`.
 *
 * Root resolution: `MYAI_WORKSPACE_ROOT` env var, else `<os tmpdir>/myai-workspaces`.
 */
export function workspaceRoot(): string {
  return process.env.MYAI_WORKSPACE_ROOT || join(tmpdir(), 'myai-workspaces');
}

/**
 * Session IDs are UUIDs, but the workspace path is filesystem-facing so we
 * defensively strip anything that could traverse out of the root.
 */
function safeSegment(sessionId: string): string {
  const seg = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!seg) throw new Error(`Invalid session id for workspace: "${sessionId}"`);
  return seg;
}

export function getWorkspacePath(sessionId: string): string {
  return join(workspaceRoot(), safeSegment(sessionId));
}

/** Create (idempotently) and return the workspace directory for a session. */
export function ensureWorkspace(sessionId: string): string {
  const dir = getWorkspacePath(sessionId);
  mkdirSync(dir, { recursive: true });
  log.debug({ sessionId, dir }, 'Workspace ensured');
  return dir;
}

export function workspaceExists(sessionId: string): boolean {
  return existsSync(getWorkspacePath(sessionId));
}

/**
 * Remove a session's workspace directory. Containment-checked: refuses to
 * delete anything that does not resolve under the workspace root.
 * Returns true when a directory was actually removed.
 */
export function cleanupWorkspace(sessionId: string): boolean {
  const root = resolve(workspaceRoot());
  const dir = resolve(getWorkspacePath(sessionId));
  if (!dir.startsWith(root + '/') && dir !== root) {
    log.warn({ sessionId, dir, root }, 'Workspace cleanup refused — path escapes root');
    return false;
  }
  if (dir === root) return false; // never delete the root itself
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  log.info({ sessionId, dir }, 'Workspace removed');
  return true;
}

/** Remove every workspace under the root (gateway shutdown / maintenance). */
export function cleanupAllWorkspaces(): number {
  const root = workspaceRoot();
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root)) {
    rmSync(join(root, entry), { recursive: true, force: true });
    removed++;
  }
  if (removed > 0) log.info({ root, removed }, 'All workspaces removed');
  return removed;
}

/**
 * Register the built-in `session:end` hook that removes the closing session's
 * workspace. Called once at gateway bootstrap.
 */
export function registerWorkspaceCleanupHook(): void {
  addHook(
    'agent-workspace-cleanup',
    ['session:end'],
    async (ctx) => {
      if (!ctx.sessionId) return;
      try {
        cleanupWorkspace(ctx.sessionId);
      } catch (err) {
        // Cleanup must never fail a session close.
        log.warn({ err, sessionId: ctx.sessionId }, 'Workspace cleanup failed');
      }
    },
    { source: 'builtin' },
  );
}

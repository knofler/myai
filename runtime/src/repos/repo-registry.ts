import { readFileSync, existsSync, statSync, readdirSync, appendFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { countTasks } from '../tasks/task-store.js';
import { listRepos, upsertRepo } from './repo-store.js';

const log = createChildLogger({ module: 'repo-registry' });

export interface RepoInfo {
  name: string;
  path: string;
  exists: boolean;
  isGitRepo: boolean;
  hasAiFolder: boolean;
  hasStateFile: boolean;
  hasHandoffFile: boolean;
}

export interface RepoStatus extends RepoInfo {
  branch?: string;
  uncommittedFiles: number;
  lastHandoffAt?: Date;
  lastStateAt?: Date;
  ahead?: number;
  behind?: number;
  error?: string;
}

export interface RepoPriorityEntry {
  repo: string;
  score: number;
  reasons: string[];
  openTasks: number;
  staleDays: number;
}

export interface ScanResult {
  name: string;
  path: string;
  stack: string[];
  hasAiFolder: boolean;
  hasStateFile: boolean;
}

// Tilde-rooted prefix used by managed_repos.txt entries.
// When REPOS_BASE is set (e.g. inside the gateway container with a
// `<your-code-root>:/repos:ro` mount), entries matching this
// prefix are rewritten to `${REPOS_BASE}/<rest>` so the registry resolves
// against the bind mount instead of the container's HOME.
const MANAGED_REPOS_TILDE_PREFIX = process.env.MANAGED_REPOS_PREFIX || '~/code/';

function resolveManagedRepoPath(raw: string): string {
  const reposBase = process.env.REPOS_BASE;
  if (reposBase && raw.startsWith(MANAGED_REPOS_TILDE_PREFIX)) {
    return resolve(reposBase, raw.slice(MANAGED_REPOS_TILDE_PREFIX.length));
  }
  const home = process.env.HOME || '/root';
  return raw.replace(/^~\//, `${home}/`);
}

/** Parse managed_repos.txt into absolute paths + names. */
export function listRepoPaths(): RepoInfo[] {
  const config = getConfig();
  const reposFile = resolve(config.aiRoot, 'config', 'managed_repos.txt');
  if (!existsSync(reposFile)) {
    log.warn({ reposFile }, 'managed_repos.txt missing');
    return [];
  }

  const lines = readFileSync(reposFile, 'utf-8')
    .split('\n')
    .map(l => l.split('#')[0].trim())
    .filter(Boolean);

  return lines.map(raw => repoInfoFromPath(resolveManagedRepoPath(raw)));
}

/** Build a RepoInfo (filesystem-derived flags) from an absolute checkout path. */
function repoInfoFromPath(path: string): RepoInfo {
  const name = basename(path);
  const exists = existsSync(path);
  const isGitRepo = exists && existsSync(resolve(path, '.git'));
  const aiFolder = resolve(path, 'AI');
  const hasAiFolder = exists && existsSync(aiFolder);
  const hasStateFile = hasAiFolder && existsSync(resolve(aiFolder, 'state', 'STATE.md'));
  const hasHandoffFile = hasAiFolder && existsSync(resolve(aiFolder, 'state', 'AI_AGENT_HANDOFF.md'));
  return { name, path, exists, isGitRepo, hasAiFolder, hasStateFile, hasHandoffFile };
}

/**
 * ADR-021 Phase 1 — the unified roster: the `managed_repos.txt` seed UNIONed
 * with the tenant's DB `repos` roster (by name; DB path wins for a name in both).
 * Backward-compatible: an empty/unavailable DB roster yields exactly the txt
 * result, so nothing disappears during the migration. This is the resolver
 * `repos_list`/`fleet_overview` migrate onto (closing step of Phase 1).
 */
export async function listReposUnified(tenantId: string): Promise<RepoInfo[]> {
  const seed = listRepoPaths();
  const byName = new Map<string, RepoInfo>(seed.map(r => [r.name, r]));
  try {
    const dbRepos = await listRepos(tenantId);
    for (const r of dbRepos) byName.set(r.name, repoInfoFromPath(r.path));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'DB roster unavailable — falling back to managed_repos.txt seed only');
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * ADR-021 — idempotent seed: INSERT managed_repos.txt entries into the tenant's
 * DB roster if absent. Insert-only (never overwrites a self-registered / manually
 * edited row), so it is safe to run on every gateway boot. Card-only repos (a
 * RepoCard with no local checkout path) are left to Phase-2 self-registration
 * (`myai init` supplies the path). Astrovia is already absent from the txt seed.
 */
export async function seedReposFromManagedFile(tenantId: string): Promise<{ seeded: number; existing: number }> {
  const seed = listRepoPaths();
  if (seed.length === 0) return { seeded: 0, existing: 0 };
  let existing: Set<string>;
  try {
    existing = new Set((await listRepos(tenantId, { enabledOnly: false })).map(r => r.name));
  } catch {
    return { seeded: 0, existing: 0 }; // DB unavailable — skip silently, the txt seed still serves via listReposUnified
  }
  let seeded = 0;
  for (const r of seed) {
    if (existing.has(r.name)) continue;
    try {
      await upsertRepo(tenantId, {
        name: r.name,
        path: r.path,
        source: 'seed',
        stack: r.isGitRepo ? detectStack(r.path) : [],
      });
      seeded++;
    } catch (err) {
      log.warn({ err: (err as Error).message, repo: r.name }, 'repo seed upsert failed');
    }
  }
  if (seeded > 0) log.info({ seeded, tenantId }, 'seeded repos roster from managed_repos.txt');
  return { seeded, existing: existing.size };
}

export function getRepoStatus(repoName: string): RepoStatus {
  const all = listRepoPaths();
  const repo = all.find(r => r.name === repoName || r.path === repoName || r.path.endsWith(`/${repoName}`));
  if (!repo) {
    return {
      name: repoName, path: '', exists: false, isGitRepo: false,
      hasAiFolder: false, hasStateFile: false, hasHandoffFile: false,
      uncommittedFiles: 0, error: `Repo not found: ${repoName}`,
    };
  }

  const status: RepoStatus = { ...repo, uncommittedFiles: 0 };

  if (repo.isGitRepo) {
    try {
      status.branch = execSync('git branch --show-current', { cwd: repo.path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* noop */ }
    try {
      const porcelain = execSync('git status --porcelain', { cwd: repo.path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      status.uncommittedFiles = porcelain.split('\n').filter(Boolean).length;
    } catch { /* noop */ }
    try {
      // Only compute ahead/behind for safe branch names — git refs allow many chars but
      // we interpolate into a shell command, so restrict to a conservative allowlist.
      if (status.branch && /^[A-Za-z0-9._/-]+$/.test(status.branch)) {
        try {
          const ahead = execSync(`git rev-list --count origin/${status.branch}..HEAD`, { cwd: repo.path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          status.ahead = Number(ahead) || 0;
        } catch { status.ahead = 0; }
        try {
          const behind = execSync(`git rev-list --count HEAD..origin/${status.branch}`, { cwd: repo.path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          status.behind = Number(behind) || 0;
        } catch { status.behind = 0; }
      }
    } catch { /* noop */ }
  }

  if (repo.hasStateFile) {
    try { status.lastStateAt = statSync(resolve(repo.path, 'AI', 'state', 'STATE.md')).mtime; } catch { /* noop */ }
  }
  if (repo.hasHandoffFile) {
    try { status.lastHandoffAt = statSync(resolve(repo.path, 'AI', 'state', 'AI_AGENT_HANDOFF.md')).mtime; } catch { /* noop */ }
  }

  return status;
}

export async function prioritizeRepos(tenantId: string): Promise<RepoPriorityEntry[]> {
  const repos = await listReposUnified(tenantId);
  const now = Date.now();
  const results: RepoPriorityEntry[] = [];

  for (const repo of repos) {
    if (!repo.exists) continue;

    const reasons: string[] = [];
    let score = 0;

    let openTasks = 0;
    try {
      const counts = await countTasks(tenantId, { repo: repo.name });
      openTasks = counts.pending + counts.working + counts.review;
      if (counts.pending > 0) { score += counts.pending * 10; reasons.push(`${counts.pending} pending task(s)`); }
      if (counts.review > 0) { score += counts.review * 5; reasons.push(`${counts.review} in review`); }
      if (counts.blocked > 0) { score += counts.blocked * 3; reasons.push(`${counts.blocked} blocked`); }
    } catch {
      // Task DB may be empty — ignore
    }

    let staleDays = 0;
    if (repo.hasHandoffFile) {
      try {
        const mtime = statSync(resolve(repo.path, 'AI', 'state', 'AI_AGENT_HANDOFF.md')).mtime;
        staleDays = Math.floor((now - mtime.getTime()) / 86400000);
        if (staleDays > 7) { score += Math.min(staleDays, 30); reasons.push(`handoff ${staleDays}d stale`); }
      } catch { /* noop */ }
    } else if (repo.hasAiFolder) {
      score += 20; reasons.push('no handoff file');
    }

    if (!repo.hasAiFolder) { score += 5; reasons.push('no AI framework'); }

    if (score > 0) results.push({ repo: repo.name, score, reasons, openTasks, staleDays });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Directory scanning ─────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

/** Detect tech stack for a git repo by checking for common indicator files. */
function detectStack(repoPath: string): string[] {
  const stack: string[] = [];

  // Next.js — next.config.* files
  try {
    const entries = readdirSync(repoPath);
    if (entries.some(e => e.startsWith('next.config'))) stack.push('Next.js');
  } catch { /* noop */ }

  // Express — check package.json dependencies
  const pkgPath = resolve(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['express']) stack.push('Express');
    } catch { /* noop */ }
  }

  // Docker
  if (existsSync(resolve(repoPath, 'docker-compose.yml')) || existsSync(resolve(repoPath, 'docker-compose.yaml')) || existsSync(resolve(repoPath, 'Dockerfile'))) {
    stack.push('Docker');
  }

  // MongoDB — check docker-compose or package.json for mongo references
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['mongodb'] || allDeps['mongoose'] || allDeps['mongosh']) stack.push('MongoDB');
    } catch { /* noop */ }
  }

  // TypeScript
  if (existsSync(resolve(repoPath, 'tsconfig.json'))) {
    stack.push('TypeScript');
  }

  // Python
  if (existsSync(resolve(repoPath, 'requirements.txt')) || existsSync(resolve(repoPath, 'setup.py')) || existsSync(resolve(repoPath, 'pyproject.toml'))) {
    stack.push('Python');
  }

  return stack;
}

/** Walk a directory tree up to `maxDepth` and discover git repos. */
function walkForGitRepos(dirPath: string, currentDepth: number, maxDepth: number, results: ScanResult[]): void {
  if (currentDepth > maxDepth) return;

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return; // unreadable directory
  }

  // If this directory has .git, it's a repo — record it and don't recurse deeper into it
  if (entries.includes('.git')) {
    const aiFolder = resolve(dirPath, 'AI');
    results.push({
      name: basename(dirPath),
      path: dirPath,
      stack: detectStack(dirPath),
      hasAiFolder: existsSync(aiFolder),
      hasStateFile: existsSync(resolve(aiFolder, 'state', 'STATE.md')),
    });
    return;
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const childPath = resolve(dirPath, entry);
    try {
      if (statSync(childPath).isDirectory()) {
        walkForGitRepos(childPath, currentDepth + 1, maxDepth, results);
      }
    } catch { /* noop — stat failure, permission denied, etc. */ }
  }
}

/**
 * Scan a directory to discover git repositories and their tech stacks.
 * Optionally register discovered repos — ADR-021 Phase 2: self-registration
 * writes each discovered repo into the caller's tenant `repos` DB roster
 * (source: 'scan'); the managed_repos.txt append is kept alongside it for the
 * ~30 shell consumers not yet migrated off the txt (Phase 3).
 */
export async function scanDirectory(args: { path: string; maxDepth?: number; register?: boolean; tenantId?: string }): Promise<{
  scannedPath: string;
  maxDepth: number;
  found: number;
  registered: number;
  repos: ScanResult[];
}> {
  const scanPath = resolve(args.path);
  const maxDepth = args.maxDepth ?? 4;
  const shouldRegister = args.register ?? false;

  if (!existsSync(scanPath)) {
    throw new Error(`Path does not exist: ${scanPath}`);
  }
  if (!statSync(scanPath).isDirectory()) {
    throw new Error(`Not a directory: ${scanPath}`);
  }

  const repos: ScanResult[] = [];
  walkForGitRepos(scanPath, 0, maxDepth, repos);
  repos.sort((a, b) => a.name.localeCompare(b.name));

  let registered = 0;
  if (shouldRegister && repos.length > 0) {
    const config = getConfig();
    const reposFile = resolve(config.aiRoot, 'config', 'managed_repos.txt');
    const existing = existsSync(reposFile)
      ? new Set(
          readFileSync(reposFile, 'utf-8')
            .split('\n')
            .map(l => l.split('#')[0].trim())
            .filter(Boolean)
            .map(raw => resolveManagedRepoPath(raw)),
        )
      : new Set<string>();

    const newPaths = repos.filter(r => !existing.has(r.path)).map(r => r.path);
    if (newPaths.length > 0) {
      const appendBlock = '\n# Auto-discovered by repos_scan on ' + new Date().toISOString().slice(0, 10) + '\n' + newPaths.join('\n') + '\n';
      appendFileSync(reposFile, appendBlock, 'utf-8');
      registered = newPaths.length;
      log.info({ count: registered, reposFile }, 'Registered new repos via repos_scan');
    }

    if (args.tenantId) {
      for (const r of repos) {
        try {
          await upsertRepo(args.tenantId, { name: r.name, path: r.path, stack: r.stack, source: 'scan', lastSeenAt: new Date() });
        } catch (err) {
          log.warn({ err: (err as Error).message, repo: r.name }, 'repos_scan DB upsert failed');
        }
      }
    }
  }

  return { scannedPath: scanPath, maxDepth, found: repos.length, registered, repos };
}

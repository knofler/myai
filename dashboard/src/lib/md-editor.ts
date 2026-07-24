// File read/write/git-commit helpers backing the in-UI agent/skill source
// editor (MYAI_DASHBOARD.md §3.2). Kept independent of the Mongo mirror
// (lib/db.ts) so the fs/git orchestration is testable against a plain tmpdir
// + git repo — no mongodb-memory-server needed. API routes glue this to the
// Agent/Skill models.
//
// AI_ROOT containment mirrors lib/docs.ts's safeRead guard: `filePath` values
// come from the Mongo mirror (itself populated by the gateway's file-system
// loader), but we re-validate here in case a doc was hand-edited or a future
// caller passes an unchecked path.
import { promises as fs } from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFile = promisify(execFileCb);

export const AI_ROOT = process.env.AI_ROOT ?? '/app/AI';

/** Resolve `p` only if it stays inside `root`; null if it would escape. */
export function containRoot(p: string, root: string = AI_ROOT): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(p);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
}

export async function readFileAt(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

export function contentHashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export interface CommitResult {
  committed: boolean;
  commitSha?: string;
  gitError?: string;
}

/**
 * Write `content` to `filePath` and commit it with git, scoped to `repoRoot`.
 * The write is always attempted first; the commit is best-effort — a repo
 * mounted read-only or missing `.git` still lets the on-disk edit land (and
 * the caller's Mongo mirror update proceeds), it just comes back
 * `committed: false` with `gitError` set instead of throwing.
 */
export async function writeFileAndCommit(
  filePath: string,
  content: string,
  commitMessage: string,
  repoRoot: string = AI_ROOT,
): Promise<CommitResult> {
  await fs.writeFile(filePath, content, 'utf-8');

  const relPath = path.relative(repoRoot, filePath);
  try {
    await execFile('git', ['add', '--', relPath], { cwd: repoRoot });
    await execFile('git', ['commit', '-m', commitMessage, '--', relPath], { cwd: repoRoot });
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    return { committed: true, commitSha: stdout.trim() };
  } catch (err) {
    return { committed: false, gitError: err instanceof Error ? err.message : String(err) };
  }
}

export interface ParsedDoc {
  data: Record<string, string>;
  body: string;
}

/** Minimal frontmatter parser — mirrors the fallback path in runtime/src/agents/loader.ts. */
export function parseFrontmatter(raw: string): ParsedDoc {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: raw.trim() };
  const data: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) data[m[1]] = m[2].trim();
  }
  return { data, body: raw.slice(match[0].length).trim() };
}

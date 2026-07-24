// Filesystem readers for the docs hub + showcase pages.
//
// The dashboard container mounts the master repo read-only at AI_ROOT
// (/app/AI) and all sibling repos read-only at /repos (see docker-compose.yml,
// mirroring the gateway's mounts). These helpers read markdown from those
// roots with strict path containment — only files *inside* a known root and
// only the markdown filenames we expose are ever read.

import { promises as fs } from 'fs';
import path from 'path';

export const AI_ROOT = process.env.AI_ROOT ?? '/app/AI';

/** Safely read a UTF-8 file, returning null on any error (missing, perms, etc.). */
async function safeRead(absPath: string, root: string): Promise<string | null> {
  const resolved = path.resolve(absPath);
  // Containment guard — never escape the intended root.
  if (!resolved.startsWith(path.resolve(root))) return null;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 2_000_000) return null; // 2 MB ceiling
    return await fs.readFile(resolved, 'utf-8');
  } catch {
    return null;
  }
}

/** Read the master SHOWCASE.md. */
export function readShowcase(): Promise<string | null> {
  return safeRead(path.join(AI_ROOT, 'SHOWCASE.md'), AI_ROOT);
}

/** Read the master README.md. */
export function readMasterReadme(): Promise<string | null> {
  return safeRead(path.join(AI_ROOT, 'README.md'), AI_ROOT);
}

export interface FrameworkDoc {
  slug: string;
  title: string;
  file: string;
}

/** Curated set of framework docs surfaced in the docs hub. */
export const FRAMEWORK_DOCS: FrameworkDoc[] = [
  { slug: 'ai-rules', title: 'AI Rules', file: 'documentation/AI_RULES.md' },
  { slug: 'routing', title: 'Multi-Agent Routing', file: 'documentation/MULTI_AGENT_ROUTING.md' },
  { slug: 'keywords', title: 'Keywords Reference', file: 'documentation/KEYWORDS_REFERENCE.md' },
  { slug: 'powerhouse-keywords', title: 'Powerhouse Keywords', file: 'documentation/POWERHOUSE_KEYWORDS.md' },
  { slug: 'design-system', title: 'Design System', file: 'documentation/DESIGN_SYSTEM.md' },
  { slug: 'swarm', title: 'Swarm Coordination', file: 'documentation/SWARM_COORDINATION.md' },
  { slug: 'multi-machine', title: 'Multi-Machine Workflow', file: 'documentation/MULTI_MACHINE_WORKFLOW.md' },
];

/** Read a curated framework doc by slug. */
export async function readFrameworkDoc(slug: string): Promise<{ doc: FrameworkDoc; content: string | null } | null> {
  const doc = FRAMEWORK_DOCS.find((d) => d.slug === slug);
  if (!doc) return null;
  const content = await safeRead(path.join(AI_ROOT, doc.file), AI_ROOT);
  return { doc, content };
}

/**
 * Read a managed repo's documentation. `repoPath` comes from the gateway's
 * repos_list (already a /repos/... absolute path). Tries README.md, then a
 * couple of common fallbacks. Returns the rendered file name too.
 */
export async function readRepoReadme(repoPath: string): Promise<{ file: string; content: string } | null> {
  const REPOS_ROOT = '/repos';
  const resolved = path.resolve(repoPath);
  if (!resolved.startsWith(REPOS_ROOT)) return null;
  const candidates = ['README.md', 'readme.md', 'Readme.md', 'AI/state/STATE.md'];
  for (const c of candidates) {
    const content = await safeRead(path.join(resolved, c), REPOS_ROOT);
    if (content) return { file: c, content };
  }
  return null;
}

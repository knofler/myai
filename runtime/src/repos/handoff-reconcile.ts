import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBrainRepo, resolveBrainDir, slugify } from '../core/brain.js';
import { readHandoff, type HandoffView, type ReadHandoffResult } from './handoff-store.js';

/**
 * One "latest handoff" for a repo across BOTH continuity stores (v1 G2 B2).
 *
 * The gateway keeps handoffs in Mongo; the brain keeps atoms in git. Without
 * Docker there is no Mongo, and the local stdio MCP server
 * (scripts/lib/mcp_local_stdio.mjs) reads the brain only. For the two never to
 * disagree, both compute the same thing:
 *
 *   brain side  = the newest HEADLINE atom of the namespace — a `handoff` atom
 *                 or a hand-written `session` atom (never `session-auto`), the
 *                 handoff first within the same second. Same candidates as the
 *                 distiller's headlineAtom (distill.ts), read off the working
 *                 tree so a write is visible before the next brain_merge.
 *   gateway     = the NEWER of (Mongo latest, brain side). Timestamps compare
 *                 at the brain's one-second UTC resolution and a tie goes to
 *                 the brain: it is git-backed and portable.
 *   local       = the brain side (there is no Mongo to compare with).
 *
 * Every gateway handoff_write also commits a `handoff` atom, and brain_merge's
 * Mongo mirror only ever copies a brain atom, so anything Mongo holds that is
 * newer than the brain side is content the brain already has. KEEP IN SYNC
 * with `brainHeadline` in scripts/lib/mcp_local_stdio.mjs.
 */

/** How many newest session atoms to look through for a hand-written one. */
const SESSION_SCAN = 200;

export interface BrainHeadline {
  /** Repo-relative path in the brain store. */
  path: string;
  /** The filename's UTC stamp, YYYYMMDDTHHMMSSZ. */
  ts: string;
  kind: 'handoff' | 'session';
  body: string;
}

function stripFrontmatter(raw: string): { kind?: string; body: string } {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n\n?/);
  if (!fm) return { body: raw.trim() };
  const kind = fm[1].match(/^kind: (.+)$/m)?.[1].trim();
  return { kind, body: raw.slice(fm[0].length).trim() };
}

function newestFirst(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{8}T\d{6}Z-.*\.md$/.test(f)).sort().reverse();
}

/** The brain side of the rule above, or undefined (no brain / no namespace / no atoms). */
export function brainHeadline(repo: string, env: NodeJS.ProcessEnv = process.env): BrainHeadline | undefined {
  const dir = resolveBrainDir(env);
  const ns = slugify(repo);
  if (!ns || !isBrainRepo(dir)) return undefined;
  const pick = (sub: 'handoffs' | 'sessions', kind: 'handoff' | 'session', limit: number): BrainHeadline | undefined => {
    for (const f of newestFirst(join(dir, 'repos', ns, sub)).slice(0, limit)) {
      let raw: string;
      try { raw = readFileSync(join(dir, 'repos', ns, sub, f), 'utf8'); } catch { continue; }
      const atom = stripFrontmatter(raw);
      if (atom.kind && atom.kind !== kind) continue; // session-auto lives in sessions/ too
      if (!atom.body) continue;
      return { path: `repos/${ns}/${sub}/${f}`, ts: f.slice(0, 16), kind, body: atom.body };
    }
    return undefined;
  };
  const h = pick('handoffs', 'handoff', 1);
  const s = pick('sessions', 'session', SESSION_SCAN);
  if (!h) return s;
  if (!s) return h;
  return s.ts > h.ts ? s : h;
}

/**
 * Atom filenames resolve to the second, so two handoffs in the same second
 * would order by their hashes. A handoff writer calls this first: when the
 * newest handoff atom already carries the current second, wait (≤ ~1 s) for
 * the next one, so the new atom is always the newest file.
 */
export function waitForFreshSecond(repo: string, env: NodeJS.ProcessEnv = process.env): void {
  const ns = slugify(repo);
  if (!ns) return;
  const newest = newestFirst(join(resolveBrainDir(env), 'repos', ns, 'handoffs'))[0]?.slice(0, 16);
  if (!newest) return;
  const tick = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2000;
  while (toStamp(new Date()) <= newest && Date.now() < deadline) Atomics.wait(tick, 0, 0, 50);
}

/** A Date at the brain's resolution: YYYYMMDDTHHMMSSZ. */
export function toStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function stampToDate(ts: string): Date {
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : new Date(0);
}

/** A brain headline in the handoff store's shape, so callers need not care where it came from. */
export function headlineView(repo: string, h: BrainHeadline): HandoffView {
  const at = stampToDate(h.ts);
  const firstLine = h.body.split('\n').find((l) => l.trim()) ?? '';
  return {
    id: `brain:${h.path}`,
    repo,
    content: h.body,
    summary: firstLine.replace(/\s+/g, ' ').trim().slice(0, 240),
    author: 'brain',
    status: 'active',
    metadata: { source: 'brain', atom: h.path, atomKind: h.kind },
    createdAt: at,
    updatedAt: at,
  };
}

/** Newer of the two; equal (to the second) → the brain. */
export function newerHandoff(mongo: HandoffView | null, brain: BrainHeadline | undefined, repo: string): HandoffView | null {
  if (!brain) return mongo;
  if (!mongo) return headlineView(repo, brain);
  return brain.ts >= toStamp(new Date(mongo.createdAt)) ? headlineView(repo, brain) : mongo;
}

/**
 * readHandoff with the brain reconciled in: `latest` is the newer of the Mongo
 * entry and the brain headline. History stays the Mongo trail (the brain's own
 * history is `brain_log`). Works with no DB at all (latest = the brain side).
 */
export async function readHandoffReconciled(
  tenantId: string,
  repo: string,
  opts: { historyLimit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadHandoffResult> {
  const stored = await (opts.historyLimit ? readHandoff(tenantId, repo, opts) : readHandoff(tenantId, repo));
  let brain: BrainHeadline | undefined;
  try { brain = brainHeadline(repo, env); } catch { brain = undefined; }
  return { ...stored, latest: newerHandoff(stored.latest, brain, repo) };
}

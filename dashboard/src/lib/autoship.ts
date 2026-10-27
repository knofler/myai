// Reader for the auto-ship kill switch + last ship-step verdict (task-79a07a7c).
//
// Two filesystem artifacts under AI_ROOT, same containment/size-guard pattern
// as lib/runner-health.ts and lib/docs.ts:
//   1. config/autoship.off — the operator kill switch (scripts/runner_ship_step.sh
//      exits immediately while this committed marker exists). "Since when" is
//      best-effort: the file's own text carries the directive date
//      ("operator directive YYYY-MM-DD"), which survives a fresh git checkout
//      resetting mtime — fall back to mtime only when that text is missing.
//   2. state/ship-step.json — the last decision runner_ship_step.sh made,
//      written by that script itself (previously stdout-only, task-79a07a7c).

import { promises as fs } from 'fs';
import path from 'path';
import { AI_ROOT } from './docs';

export interface AutoshipKillSwitch {
  active: boolean;
  /** ISO timestamp the marker took effect, or null if inactive/unknown. */
  since: string | null;
}

export interface AutoshipVerdict {
  result: string;
  detail: string | null;
  at: string | null;
  repo: string | null;
  taskId: string | null;
  prNumber: number | null;
  drift: number | null;
  reviewCount: number | null;
}

export interface AutoshipStatus {
  killSwitch: AutoshipKillSwitch;
  lastVerdict: AutoshipVerdict | null;
}

const DIRECTIVE_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

async function readKillSwitch(): Promise<AutoshipKillSwitch> {
  const resolved = path.resolve(path.join(AI_ROOT, 'config', 'autoship.off'));
  if (!resolved.startsWith(path.resolve(AI_ROOT))) return { active: false, since: null }; // containment guard
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return { active: false, since: null };
    let since: string | null = null;
    try {
      const raw = await fs.readFile(resolved, 'utf-8');
      const match = raw.match(DIRECTIVE_DATE_RE);
      if (match) {
        const parsed = new Date(`${match[1]}T00:00:00.000Z`);
        if (!Number.isNaN(parsed.getTime())) since = parsed.toISOString();
      }
    } catch {
      // fall through to mtime below
    }
    if (!since) since = stat.mtime.toISOString();
    return { active: true, since };
  } catch {
    return { active: false, since: null };
  }
}

async function readLastVerdict(): Promise<AutoshipVerdict | null> {
  const resolved = path.resolve(path.join(AI_ROOT, 'state', 'ship-step.json'));
  if (!resolved.startsWith(path.resolve(AI_ROOT))) return null; // containment guard
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 200_000) return null;
    const raw = await fs.readFile(resolved, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.result !== 'string') return null;
    return {
      result: parsed.result,
      detail: typeof parsed.detail === 'string' ? parsed.detail : null,
      at: typeof parsed.at === 'string' ? parsed.at : null,
      repo: typeof parsed.repo === 'string' ? parsed.repo : null,
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
      prNumber: typeof parsed.prNumber === 'number' ? parsed.prNumber : null,
      drift: typeof parsed.drift === 'number' ? parsed.drift : null,
      reviewCount: typeof parsed.reviewCount === 'number' ? parsed.reviewCount : null,
    };
  } catch {
    return null;
  }
}

export async function getAutoshipStatus(): Promise<AutoshipStatus> {
  const [killSwitch, lastVerdict] = await Promise.all([readKillSwitch(), readLastVerdict()]);
  return { killSwitch, lastVerdict };
}

// Reader for the two repo-list policy files that shape the autonomous
// scheduler queue (see documentation/AI_RULES.md §7 + CLAUDE.md "Scheduling"):
//   config/schedule_priority.txt — core-product repos kept at full priority;
//     every other repo's pending tasks get capped at P3.
//   config/schedule_ignore.txt   — consent-gated repos the runner skips
//     entirely on its autonomous (fleet) picks.
// Same read-only AI_ROOT mount + containment guard as lib/docs.ts.

import { promises as fs } from 'fs';
import path from 'path';
import { AI_ROOT } from './docs';

async function readRepoList(file: string): Promise<string[]> {
  const resolved = path.resolve(path.join(AI_ROOT, 'config', file));
  if (!resolved.startsWith(path.resolve(AI_ROOT))) return []; // containment guard
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 200_000) return [];
    const raw = await fs.readFile(resolved, 'utf-8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

export interface SchedulePolicy {
  /** Core-product repos — keep assigned priority; every other repo is capped at P3. */
  priorityRepos: string[];
  /** Consent-gated repos — no autonomous scheduling without explicit user consent. */
  ignoreRepos: string[];
}

export async function readSchedulePolicy(): Promise<SchedulePolicy> {
  const [priorityRepos, ignoreRepos] = await Promise.all([
    readRepoList('schedule_priority.txt'),
    readRepoList('schedule_ignore.txt'),
  ]);
  return { priorityRepos, ignoreRepos };
}

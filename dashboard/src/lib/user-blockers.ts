// Reader for config/user_blockers.md — the one canonical fleet-wide tracker
// for user-owed credentials/decisions (see scripts/user_blockers.sh + the
// file's own header for the full contract). Repos reference this file from
// their session-close instead of re-listing the same blockers in handoff
// prose every session; the /work "Blockers" tab renders it read-only here.
// Same read-only AI_ROOT mount + containment guard as lib/docs.ts.

import { promises as fs } from 'fs';
import path from 'path';
import { AI_ROOT } from './docs';

const START_MARK = '<!-- USER_BLOCKERS_TABLE_START -->';
const END_MARK = '<!-- USER_BLOCKERS_TABLE_END -->';

export interface UserBlocker {
  id: string;
  repo: string;
  blocker: string;
  requested: string;
  status: 'open' | 'resolved' | string;
  notes: string;
}

function parseRow(line: string): UserBlocker | null {
  if (!line.trim().startsWith('|')) return null;
  // Strip leading/trailing pipe, split the rest, trim each cell.
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
  if (cells.length < 6) return null;
  const [id, repo, blocker, requested, status, notes] = cells;
  if (!/^\d+$/.test(id)) return null; // skip header/separator rows
  return { id, repo, blocker, requested, status: status as UserBlocker['status'], notes: notes ?? '' };
}

/** Parse the markdown table between the START/END markers into rows. */
export function parseUserBlockers(raw: string): UserBlocker[] {
  const startIdx = raw.indexOf(START_MARK);
  const endIdx = raw.indexOf(END_MARK);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return [];
  const body = raw.slice(startIdx + START_MARK.length, endIdx);
  const rows: UserBlocker[] = [];
  for (const line of body.split('\n')) {
    const row = parseRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** Read + parse config/user_blockers.md. Degrades to [] on any read failure. */
export async function readUserBlockers(): Promise<UserBlocker[]> {
  const resolved = path.resolve(path.join(AI_ROOT, 'config', 'user_blockers.md'));
  if (!resolved.startsWith(path.resolve(AI_ROOT))) return []; // containment guard
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 500_000) return [];
    const raw = await fs.readFile(resolved, 'utf-8');
    return parseUserBlockers(raw);
  } catch {
    return [];
  }
}

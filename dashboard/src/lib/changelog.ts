// Reader + parser for CHANGELOG.md (Keep a Changelog format) — backs the
// in-app "what's new" widget, which surfaces the release feed to drive
// re-engagement. Same read-only AI_ROOT mount + containment guard as
// lib/docs.ts / lib/user-blockers.ts.

import { promises as fs } from 'fs';
import path from 'path';
import { AI_ROOT } from './docs';

/** One `### Added` / `### Fixed` / … subsection within a release. */
export interface ChangelogSection {
  heading: string;
  items: string[];
}

/** One `## [version] — date` release entry. */
export interface ChangelogRelease {
  version: string;
  date?: string;
  sections: ChangelogSection[];
}

const RELEASE_HEADING = /^##\s*\[([^\]]+)\]\s*(?:[—-]\s*(.+))?$/;
const SECTION_HEADING = /^###\s+(.+)$/;
const LIST_ITEM = /^[-*]\s+(.+)$/;

/**
 * Parse Keep a Changelog markdown into structured releases, newest first
 * (the file's own order). Skips `[Unreleased]` (nothing shipped yet — the
 * widget is "what's new", not "what's in progress") and any release with no
 * bullet items (an empty placeholder heading).
 */
export function parseChangelog(raw: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  let currentSection: ChangelogSection | null = null;

  for (const line of raw.split('\n')) {
    const releaseMatch = line.match(RELEASE_HEADING);
    if (releaseMatch) {
      current = { version: releaseMatch[1].trim(), date: releaseMatch[2]?.trim(), sections: [] };
      currentSection = null;
      if (current.version.toLowerCase() !== 'unreleased') releases.push(current);
      else current = null; // drop the reference so its sections are ignored below
      continue;
    }
    if (!current) continue;

    const sectionMatch = line.match(SECTION_HEADING);
    if (sectionMatch) {
      currentSection = { heading: sectionMatch[1].trim(), items: [] };
      current.sections.push(currentSection);
      continue;
    }

    const itemMatch = line.match(LIST_ITEM);
    if (itemMatch && currentSection) {
      currentSection.items.push(itemMatch[1].trim());
    }
  }

  return releases.filter((r) => r.sections.some((s) => s.items.length > 0));
}

/** Read + parse the master CHANGELOG.md. Degrades to [] on any read failure. */
export async function readChangelog(): Promise<ChangelogRelease[]> {
  const resolved = path.resolve(path.join(AI_ROOT, 'CHANGELOG.md'));
  if (!resolved.startsWith(path.resolve(AI_ROOT))) return []; // containment guard
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 2_000_000) return [];
    const raw = await fs.readFile(resolved, 'utf-8');
    return parseChangelog(raw);
  } catch {
    return [];
  }
}

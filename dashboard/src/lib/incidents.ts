// Reader for the public incident log shown on the /status page.
//
// Incidents are recorded in state/incidents.json in the master repo, mounted
// read-only into the dashboard container at AI_ROOT (same pattern as
// lib/runner-health.ts and lib/docs.ts). Keeping the log in a committed file
// means the incident history is versioned, survives restarts, and needs no
// extra datastore. Operators append entries during/after an incident.

import { promises as fs } from 'fs';
import path from 'path';
import { AI_ROOT } from './docs';

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';

export interface IncidentUpdate {
  at: string; // ISO timestamp
  status: IncidentStatus;
  message: string;
}

export interface Incident {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  startedAt: string; // ISO
  resolvedAt: string | null;
  components: string[]; // e.g. ["gateway", "mongo"]
  updates: IncidentUpdate[];
}

export interface IncidentLog {
  generatedAt: string;
  available: boolean;
  incidents: Incident[];
}

const VALID_STATUS: ReadonlySet<string> = new Set([
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);

/**
 * Read state/incidents.json from AI_ROOT. Returns an empty (but `available`)
 * log when the file is absent — "no incidents" is a valid, healthy state and
 * should render as such rather than as an error.
 */
export async function readIncidents(): Promise<IncidentLog> {
  const resolved = path.resolve(path.join(AI_ROOT, 'state', 'incidents.json'));
  // Containment guard — never read outside AI_ROOT even if AI_ROOT is odd.
  if (!resolved.startsWith(path.resolve(AI_ROOT))) {
    return { generatedAt: new Date().toISOString(), available: false, incidents: [] };
  }
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 1_000_000) {
      return { generatedAt: new Date().toISOString(), available: true, incidents: [] };
    }
    const raw = await fs.readFile(resolved, 'utf-8');
    const parsed = JSON.parse(raw) as { incidents?: unknown };
    const incidents = Array.isArray(parsed.incidents)
      ? (parsed.incidents as Incident[]).filter(isValidIncident)
      : [];
    // Most recent first.
    incidents.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return { generatedAt: new Date().toISOString(), available: true, incidents };
  } catch {
    // Missing file → healthy "no incidents". Malformed JSON also degrades to
    // empty rather than throwing the whole status page.
    return { generatedAt: new Date().toISOString(), available: true, incidents: [] };
  }
}

function isValidIncident(x: unknown): x is Incident {
  if (!x || typeof x !== 'object') return false;
  const i = x as Record<string, unknown>;
  return (
    typeof i.id === 'string' &&
    typeof i.title === 'string' &&
    typeof i.status === 'string' &&
    VALID_STATUS.has(i.status) &&
    typeof i.startedAt === 'string'
  );
}

/** True when there is at least one unresolved incident. */
export function hasActiveIncident(log: IncidentLog): boolean {
  return log.incidents.some((i) => i.status !== 'resolved');
}

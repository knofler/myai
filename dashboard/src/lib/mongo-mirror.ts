// Reader for the Atlas→local mongo mirror coverage artifact.
//
// Atlas is the SOURCE OF TRUTH; the local myai-mongo is a WARM READ REPLICA
// (documentation/MONGO_MIRROR.md). scripts/mongo_mirror.sh records each run's
// freshness + per-collection count delta (source vs replica) to
// ~/.myai/mongo-mirror-counts.json on the host, and
// scripts/mongo_mirror_status_snapshot.sh folds it into
// state/mongo-mirror-status.json inside the repo. The dashboard container mounts
// the repo read-only at AI_ROOT, so we read the artifact straight off the
// filesystem — the same host→repo bridge pattern as lib/runner-health.ts. The
// $MYAI_HOME artifacts live outside the mount, so this JSON is the only bridge.

import { promises as fs } from 'fs';
import path from 'path';
import { AI_ROOT } from './docs';

export interface MirrorPerCollection {
  name: string;
  atlas: number;
  local: number;
  delta: number;
}

export interface MirrorCoverage {
  capturedAt: number;
  mirroredCollections: number;
  totalCollections: number;
  deniedCollections: string[];
  localDataSizeBytes: number;
  ramWarnBytes: number;
  /** true when the replica's on-disk dataSize nears the 512m RAM slice. */
  ramFlag: boolean;
  perCollection: MirrorPerCollection[];
}

export interface MirrorLastRun {
  epoch: number;
  rc: number;
  direction: string;
  db: string;
}

export interface MongoMirrorStatus {
  generatedAt: string;
  installed: boolean;
  intervalSec: number | null;
  last: MirrorLastRun | null;
  coverage: MirrorCoverage | null;
}

const STATUS_FILE = 'mongo-mirror-status.json';

/**
 * Read + minimally validate state/mongo-mirror-status.json from AI_ROOT.
 * Returns null when the producer hasn't run yet or the artifact is
 * missing/malformed/oversized — the replica row then renders "no data" rather
 * than crashing the page.
 */
export async function readMongoMirrorStatus(): Promise<MongoMirrorStatus | null> {
  const stateDir = path.resolve(path.join(AI_ROOT, 'state'));
  if (!stateDir.startsWith(path.resolve(AI_ROOT))) return null; // containment guard
  const file = path.resolve(path.join(stateDir, STATUS_FILE));
  if (!file.startsWith(stateDir)) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2_000_000) return null;
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as Partial<MongoMirrorStatus>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.generatedAt !== 'string') return null;
    return {
      generatedAt: parsed.generatedAt,
      installed: Boolean(parsed.installed),
      intervalSec: typeof parsed.intervalSec === 'number' ? parsed.intervalSec : null,
      last: parsed.last ?? null,
      coverage: parsed.coverage ?? null,
    };
  } catch {
    return null;
  }
}

export interface ReplicaSummary {
  /** "local replica: 70/73 collections, last sync 4m ago" */
  label: string;
  mirrored: number;
  total: number;
  /** "4m ago" | "2h ago" | "never" */
  lastSync: string;
  /** last recorded run succeeded (rc === 0). */
  healthy: boolean;
  /** replica on-disk size nears the 512m RAM slice. */
  ramFlag: boolean;
}

function agoLabel(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Compose the one-line replica status for the System → Runner Health page:
 *   "local replica: N/73 collections, last sync Xm ago"
 * Pure (inject `now` for deterministic tests). Returns null when no coverage has
 * been recorded yet.
 */
export function formatReplicaSummary(
  status: MongoMirrorStatus | null,
  now: number = Date.now(),
): ReplicaSummary | null {
  if (!status || !status.coverage) return null;
  const cov = status.coverage;
  const mirrored = Number(cov.mirroredCollections) || 0;
  const total = Number(cov.totalCollections) || 0;
  const succeeded = Boolean(
    status.last && status.last.rc === 0 && Number.isFinite(status.last.epoch),
  );
  const lastSync = succeeded ? agoLabel(now - status.last!.epoch * 1000) : 'never';
  return {
    label: `local replica: ${mirrored}/${total} collections, last sync ${lastSync}`,
    mirrored,
    total,
    lastSync,
    healthy: succeeded,
    ramFlag: Boolean(cov.ramFlag),
  };
}

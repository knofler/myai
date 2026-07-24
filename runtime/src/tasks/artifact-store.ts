import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ArtifactModel, isConnected } from '../shared/db.js';
import type { ArtifactKind, IArtifact } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOne, tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'artifact-store' });

// Raw content past this size is truncated (keeps a single artifact document
// well under MongoDB's 16MB doc cap and the dashboard's download response small).
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024; // 2MB
// Content at or above this size is gzip+base64-encoded before storage; smaller
// payloads are kept as plain utf8 so tiny artifacts stay human-readable in Mongo.
const GZIP_THRESHOLD_BYTES = 4 * 1024;

export interface SaveArtifactInput {
  taskId: string;
  repo: string;
  kind: ArtifactKind;
  filename: string;
  contentType?: string;
  content: string;
}

export interface ArtifactView {
  artifactId: string;
  taskId: string;
  repo: string;
  kind: ArtifactKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
  truncated: boolean;
  createdAt: Date;
}

export interface ArtifactContent extends ArtifactView {
  buffer: Buffer;
}

function toView(doc: IArtifact): ArtifactView {
  return {
    artifactId: doc.artifactId,
    taskId: doc.taskId,
    repo: doc.repo,
    kind: doc.kind,
    filename: doc.filename,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    truncated: doc.truncated,
    createdAt: doc.createdAt,
  };
}

function requireDb(): void {
  if (!isConnected() || !ArtifactModel) {
    throw new Error('MongoDB not connected — artifact store unavailable');
  }
}

/**
 * Object storage abstraction for per-task artifacts (diff / build output / test
 * report). Backed by MongoDB today — the same shared store every runner machine
 * already writes the task queue to (ADR-011), so a download link works no matter
 * which Mac produced the artifact. Swappable for a real object store (S3-
 * compatible) later behind this same save/list/read contract.
 */
export async function saveArtifact(tenantId: string, input: SaveArtifactInput): Promise<ArtifactView> {
  requireDb();
  const raw = Buffer.from(input.content, 'utf8');
  const truncated = raw.length > MAX_ARTIFACT_BYTES;
  const bounded = truncated ? raw.subarray(0, MAX_ARTIFACT_BYTES) : raw;

  let encoding: 'utf8' | 'gzip+base64' = 'utf8';
  let stored: string;
  if (bounded.length >= GZIP_THRESHOLD_BYTES) {
    encoding = 'gzip+base64';
    stored = gzipSync(bounded).toString('base64');
  } else {
    stored = bounded.toString('utf8');
  }

  const doc = await ArtifactModel.create({
    ...tenantScope(tenantId),
    artifactId: `artifact-${randomUUID()}`,
    taskId: input.taskId,
    repo: input.repo,
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType ?? 'text/plain',
    sizeBytes: bounded.length,
    encoding,
    content: stored,
    truncated,
  });
  log.info({ artifactId: doc.artifactId, taskId: doc.taskId, kind: doc.kind, sizeBytes: doc.sizeBytes, truncated }, 'Artifact saved');
  return toView(doc);
}

export async function listArtifacts(tenantId: string, taskId: string): Promise<ArtifactView[]> {
  requireDb();
  const docs = await scopedFind(ArtifactModel, tenantId, { taskId }).sort({ createdAt: 1 }).exec();
  return docs.map(toView);
}

export async function readArtifact(tenantId: string, artifactId: string): Promise<ArtifactContent | null> {
  requireDb();
  const doc = await scopedFindOne(ArtifactModel, tenantId, { artifactId }).exec();
  if (!doc) return null;
  const buffer = doc.encoding === 'gzip+base64'
    ? gunzipSync(Buffer.from(doc.content, 'base64'))
    : Buffer.from(doc.content, 'utf8');
  return { ...toView(doc), buffer };
}

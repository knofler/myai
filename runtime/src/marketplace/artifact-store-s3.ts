/**
 * ADR-029 §1/§2 — S3-compatible object-store backend for the `ArtifactStore`
 * put/get-by-key interface (`artifact-store.ts`), for hosted (non-self-hosted)
 * tenants. This is implementation checklist item #1's other half — the local
 * filesystem backend (`artifact-store.ts`) stays the self-hosted default;
 * this backend is opt-in via `MARKETPLACE_ARTIFACT_BACKEND=s3`
 * (`resolveArtifactStore()` in `artifact-store.ts`).
 *
 * Talks the plain S3 REST API directly (SigV4-signed `fetch` calls) instead
 * of pulling in a vendor SDK — §7 explicitly defers the vendor choice
 * (AWS S3 vs Cloudflare R2 vs MinIO), and the plain-REST approach works
 * unmodified against any of them (all speak the same signed-REST dialect)
 * without adding a dependency or coupling this backend to one vendor's SDK.
 *
 * Bucket layout matches the local backend key-for-key (ADR-029 §2): callers
 * pass the same `<stage>/sha256/<hh>/<manifestHash>` key produced by
 * `artifactKey()`; `keyPrefix` (below) just lets one bucket be shared with
 * other object families without a collision, it never changes the shape a
 * caller sees.
 *
 * The CDN fronting `published/` (ADR-029 §1/§2) is a separate, later
 * concern — a public read path in front of this bucket, set up by whoever
 * wires `artifactUri` at the `staging → published` promotion (ADR-029 §3
 * step 3, still an open follow-up). This backend only implements the
 * authenticated bucket-level put/get/delete/list primitives every consumer
 * (review pipeline, promotion, the TTL sweep) needs directly against the
 * bucket, same as the local backend does directly against the filesystem.
 */
import { createHash, createHmac } from 'node:crypto';
import type { ArtifactStage, ArtifactStore, ArtifactStoreEntry } from './artifact-store.js';

export interface S3ArtifactStoreConfig {
  bucket: string;
  region: string;
  /** e.g. `https://s3.us-east-1.amazonaws.com`, or a full R2/MinIO/Spaces endpoint. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** MinIO and most self-hosted S3-compatible servers require path-style; AWS and R2 support both. Default true — the broadly-compatible choice. */
  forcePathStyle: boolean;
  /** Optional prefix within the bucket (e.g. `'marketplace-artifacts/'`) so one bucket can host more than this store. Default `''`. */
  keyPrefix: string;
}

/**
 * Reads `MARKETPLACE_S3_*` env vars into a config, throwing with an
 * actionable message if a required one is missing — fails fast at backend
 * construction rather than on the first request.
 */
export function readS3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3ArtifactStoreConfig {
  const bucket = env.MARKETPLACE_S3_BUCKET;
  const accessKeyId = env.MARKETPLACE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.MARKETPLACE_S3_SECRET_ACCESS_KEY;
  const missing = [
    !bucket && 'MARKETPLACE_S3_BUCKET',
    !accessKeyId && 'MARKETPLACE_S3_ACCESS_KEY_ID',
    !secretAccessKey && 'MARKETPLACE_S3_SECRET_ACCESS_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`MARKETPLACE_ARTIFACT_BACKEND=s3 requires ${missing.join(', ')} to be set`);
  }
  const region = env.MARKETPLACE_S3_REGION || 'us-east-1';
  const endpoint = (env.MARKETPLACE_S3_ENDPOINT || `https://s3.${region}.amazonaws.com`).replace(/\/+$/, '');
  return {
    bucket: bucket!,
    region,
    endpoint,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    sessionToken: env.MARKETPLACE_S3_SESSION_TOKEN || undefined,
    forcePathStyle: env.MARKETPLACE_S3_FORCE_PATH_STYLE !== 'false',
    keyPrefix: env.MARKETPLACE_S3_KEY_PREFIX || '',
  };
}

const EMPTY_PAYLOAD_HASH = createHash('sha256').update('').digest('hex');

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** AWS's URI-encoding rules for a canonical request component (SigV4 spec: RFC 3986 unreserved chars untouched, everything else percent-encoded, uppercase hex). `encodeSlash=false` restores literal `/` for a path (each segment already individually safe). */
function awsUriEncode(input: string, encodeSlash: boolean): string {
  let out = encodeURIComponent(input).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (!encodeSlash) out = out.replace(/%2F/g, '/');
  return out;
}

function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Builds a SigV4-signed S3 REST request (AWS Signature Version 4, "Authorization
 * header" variant — the standard scheme every S3-compatible provider implements
 * identically). See AWS docs "Authenticating Requests (AWS Signature Version 4)".
 */
function buildSignedRequest(
  config: S3ArtifactStoreConfig,
  method: string,
  objectKey: string | null,
  query: Record<string, string>,
  payload: Buffer,
): SignedRequest {
  const { amzDate, dateStamp } = amzTimestamps(new Date());
  const payloadHash = payload.length === 0 ? EMPTY_PAYLOAD_HASH : sha256Hex(payload);

  const endpointUrl = new URL(config.endpoint);
  const useVirtualHost = !config.forcePathStyle;
  const host = useVirtualHost ? `${config.bucket}.${endpointUrl.host}` : endpointUrl.host;

  const encodedKey = objectKey ? objectKey.split('/').map((seg) => awsUriEncode(seg, true)).join('/') : '';
  const canonicalUri = useVirtualHost ? `/${encodedKey}` : `/${awsUriEncode(config.bucket, true)}/${encodedKey}`;

  const sortedQueryKeys = Object.keys(query).sort();
  const canonicalQueryString = sortedQueryKeys
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(query[k], true)}`)
    .join('&');

  const headersToSign: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (config.sessionToken) headersToSign['x-amz-security-token'] = config.sessionToken;

  const signedHeaderNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headersToSign[h].trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${endpointUrl.protocol}//${host}${canonicalUri}${canonicalQueryString ? `?${canonicalQueryString}` : ''}`;

  return {
    url,
    headers: {
      ...headersToSign,
      Authorization: authorization,
    },
  };
}

/** Minimal extraction over S3's `ListObjectsV2` XML response — no XML dependency needed for this one fixed, well-documented shape. */
function parseListObjectsV2(xml: string): { keys: { key: string; size: number; lastModified: string }[]; isTruncated: boolean; nextContinuationToken: string | null } {
  const keys: { key: string; size: number; lastModified: string }[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = contentsRe.exec(xml)) !== null) {
    const block = m[1];
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? '';
    const size = Number(/<Size>([\s\S]*?)<\/Size>/.exec(block)?.[1] ?? '0');
    const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? '';
    keys.push({ key: decodeXmlEntities(key), size, lastModified });
  }
  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextContinuationToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null;
  return { keys, isTruncated, nextContinuationToken };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * S3-compatible backend for hosted tenants (ADR-029 §1). Bucket-keyed by
 * `manifestHash` via the same `artifactKey()` scheme the local backend uses
 * — one key shape, two backends, per ADR-029's own named Risk of the two
 * implementations drifting.
 */
export class S3ArtifactStore implements ArtifactStore {
  constructor(private readonly config: S3ArtifactStoreConfig) {}

  private objectKeyFor(key: string): string {
    return `${this.config.keyPrefix}${key}`;
  }

  private async request(method: string, objectKey: string | null, query: Record<string, string>, body: Buffer): Promise<Response> {
    const { url, headers } = buildSignedRequest(this.config, method, objectKey, query, body);
    return fetch(url, { method, headers, body: body.length > 0 ? body : undefined });
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const res = await this.request('PUT', this.objectKeyFor(key), {}, bytes);
    if (!res.ok) {
      throw new Error(`S3 put failed for key "${key}": ${res.status} ${res.statusText} ${await safeBody(res)}`);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.request('GET', this.objectKeyFor(key), {}, Buffer.alloc(0));
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 get failed for key "${key}": ${res.status} ${res.statusText} ${await safeBody(res)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async size(key: string): Promise<number | null> {
    const res = await this.request('HEAD', this.objectKeyFor(key), {}, Buffer.alloc(0));
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 head failed for key "${key}": ${res.status} ${res.statusText}`);
    }
    const len = res.headers.get('content-length');
    return len ? Number(len) : 0;
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', this.objectKeyFor(key), {}, Buffer.alloc(0));
    // S3 DeleteObject is idempotent — 204 whether or not the key existed.
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 delete failed for key "${key}": ${res.status} ${res.statusText} ${await safeBody(res)}`);
    }
  }

  async listStage(stage: ArtifactStage): Promise<ArtifactStoreEntry[]> {
    const prefix = this.objectKeyFor(`${stage}/sha256/`);
    const entries: ArtifactStoreEntry[] = [];
    let continuationToken: string | null = null;

    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (continuationToken) query['continuation-token'] = continuationToken;

      const res: Response = await this.request('GET', null, query, Buffer.alloc(0));
      if (!res.ok) {
        throw new Error(`S3 list failed for stage "${stage}": ${res.status} ${res.statusText} ${await safeBody(res)}`);
      }
      const xml = await res.text();
      const parsed = parseListObjectsV2(xml);
      for (const item of parsed.keys) {
        if (!item.key.startsWith(this.config.keyPrefix)) continue;
        const key = item.key.slice(this.config.keyPrefix.length);
        entries.push({ key, sizeBytes: item.size, mtimeMs: Date.parse(item.lastModified) || 0 });
      }
      continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : null;
    } while (continuationToken);

    return entries;
  }
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

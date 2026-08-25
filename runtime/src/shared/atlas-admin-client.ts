/**
 * atlas-admin-client — ADR-032 §1.2 Atlas Admin API v2 wrapper.
 *
 * Digest-auth (RFC 7616) over `https://cloud.mongodb.com/api/atlas/v2`. Org-
 * level service-account credentials (`ATLAS_PUBLIC_KEY` / `ATLAS_PRIVATE_KEY`,
 * scoped to `ATLAS_ORG_ID`) are gateway operator secrets — read from env
 * only, never accepted as a caller-supplied parameter, never logged (same
 * posture as every other secret in `.env`; credential provisioning/rotation
 * itself is an operational prerequisite this ADR assumes, per its own "Out
 * of scope" note).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ §1.5 CRITICAL                                                             │
 * │                                                                           │
 * │   `createScopedDatabaseUser` MUST request a role scoped to exactly one    │
 * │   `databaseName` (`readWrite` on the target `dbName` only) — never a      │
 * │   cluster-wide role (`readWriteAnyDatabase`, `atlasAdmin`, etc). Getting  │
 * │   this wrong doesn't degrade ADR-030's physical-isolation guarantee, it   │
 * │   eliminates it: a leaked credential for one tenant would be able to      │
 * │   query every other tenant's database on the same cluster. See           │
 * │   runtime/tests/unit/atlas-database-user-scope.test.ts (the ADR's own     │
 * │   pre-registered acceptance check).                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import crypto from 'node:crypto';
import { createChildLogger } from './logger.js';
import { withRetry } from './retry.js';

const log = createChildLogger({ module: 'atlas-admin-client' });

const ATLAS_API_BASE = process.env.ATLAS_API_BASE_URL ?? 'https://cloud.mongodb.com/api/atlas/v2';
const API_VERSION_ACCEPT = 'application/vnd.atlas.2023-11-15+json';

export class AtlasAdminApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'AtlasAdminApiError';
    this.status = status;
    this.body = body;
  }
}

// ── Digest auth (RFC 7616) ──────────────────────────────────────────────
// Atlas Admin API v2 authenticates with HTTP Digest against the org service
// account's public/private key pair. Node's fetch has no built-in digest
// support, so this hand-rolls the standard two-request handshake: an
// unauthenticated request draws a 401 + WWW-Authenticate challenge, then one
// retry carries the computed Authorization: Digest header.

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

function parseDigestChallenge(header: string): DigestChallenge {
  const attrs: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    attrs[m[1]] = m[2] ?? m[3];
  }
  if (!attrs.realm || !attrs.nonce) {
    throw new Error('atlas-admin-client: malformed WWW-Authenticate digest challenge');
  }
  return { realm: attrs.realm, nonce: attrs.nonce, qop: attrs.qop, opaque: attrs.opaque, algorithm: attrs.algorithm };
}

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}

function buildDigestHeader(opts: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: DigestChallenge;
}): string {
  const { username, password, method, uri, challenge } = opts;
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = challenge.qop?.split(',')[0]?.trim();
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  return `Digest ${parts.join(', ')}`;
}

function credentials(): { publicKey: string; privateKey: string } {
  const publicKey = process.env.ATLAS_PUBLIC_KEY;
  const privateKey = process.env.ATLAS_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    throw new Error('atlas-admin-client: ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY not configured');
  }
  return { publicKey, privateKey };
}

/** Injectable for tests — defaults to the global `fetch` (Node >=20). */
export type FetchLike = typeof fetch;
let fetchImpl: FetchLike = fetch;
export function __setFetchForTests(impl: FetchLike | null): void {
  fetchImpl = impl ?? fetch;
}

async function handleResponse(res: Response, method: string, path: string): Promise<unknown> {
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    log.warn({ method, path, status: res.status, body: json }, 'Atlas Admin API request failed');
    throw new AtlasAdminApiError(`Atlas Admin API ${method} ${path} failed: ${res.status}`, res.status, json);
  }
  return json;
}

async function digestRequestOnce(method: string, path: string, body?: unknown): Promise<unknown> {
  const { publicKey, privateKey } = credentials();
  const url = `${ATLAS_API_BASE}${path}`;
  const parsedUrl = new URL(url);
  const uriPath = parsedUrl.pathname + parsedUrl.search;
  const headers: Record<string, string> = { Accept: API_VERSION_ACCEPT };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const requestBody = body !== undefined ? JSON.stringify(body) : undefined;

  // First (unauthenticated) request — expected to draw the 401 challenge.
  const first = await fetchImpl(url, { method, headers, body: requestBody });
  if (first.status !== 401) {
    return handleResponse(first, method, path);
  }
  const challengeHeader = first.headers.get('www-authenticate');
  if (!challengeHeader) {
    throw new AtlasAdminApiError('atlas-admin-client: 401 with no WWW-Authenticate challenge', 401, undefined);
  }
  const challenge = parseDigestChallenge(challengeHeader);
  const authHeader = buildDigestHeader({ username: publicKey, password: privateKey, method, uri: uriPath, challenge });
  const second = await fetchImpl(url, {
    method,
    headers: { ...headers, Authorization: authHeader },
    body: requestBody,
  });
  return handleResponse(second, method, path);
}

/** Retries transport-level failures and 5xx; never retries a 4xx (those are
 *  request-shape errors a retry can't fix — the caller's idempotency handling,
 *  e.g. §1.4 step 3's "409 -> proceed to polling", decides what to do with them). */
async function digestRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  return withRetry(() => digestRequestOnce(method, path, body), {
    maxAttempts: 3,
    retryOn: (err) => !(err instanceof AtlasAdminApiError) || err.status >= 500,
  });
}

// ── §1.2 wrapper functions ──────────────────────────────────────────────

function generatePassword(): string {
  // Atlas's password policy wants length + mixed character classes; a
  // base64url encoding of random bytes satisfies that with overwhelming
  // probability. Never logged — returned to the caller only.
  return crypto.randomBytes(24).toString('base64url');
}

/** role: readWrite on `dbName` ONLY — see §1.5. Never widen this. */
export async function createScopedDatabaseUser(opts: {
  projectId: string;
  dbName: string;
  username: string;
}): Promise<{ username: string; password: string }> {
  const password = generatePassword();
  await digestRequest('POST', `/groups/${opts.projectId}/databaseUsers`, {
    databaseName: 'admin',
    username: opts.username,
    password,
    roles: [{ roleName: 'readWrite', databaseName: opts.dbName }],
  });
  log.info(
    { projectId: opts.projectId, dbName: opts.dbName, username: opts.username },
    'Atlas scoped database user created (readWrite on dbName only)',
  );
  return { username: opts.username, password };
}

/** Fire-and-forget — Atlas builds the cluster asynchronously regardless of
 *  whether the caller is watching (ADR-032 §1.2). */
export async function createCluster(opts: {
  projectId: string;
  clusterName: string;
  region: string;
  tier: string;
}): Promise<{ clusterName: string }> {
  try {
    await digestRequest('POST', `/groups/${opts.projectId}/clusters`, {
      name: opts.clusterName,
      clusterType: 'REPLICASET',
      replicationSpecs: [
        {
          regionConfigs: [
            {
              regionName: opts.region,
              electableSpecs: { instanceSize: opts.tier, nodeCount: 3 },
              priority: 7,
            },
          ],
        },
      ],
    });
  } catch (err) {
    // §1.4 step 3 idempotency: an already-exists cluster name is a
    // no-op-or-error the worker treats as "proceed to polling", not a hard
    // failure — ADR-032's own instruction.
    if (err instanceof AtlasAdminApiError && err.status === 409) {
      log.info(
        { projectId: opts.projectId, clusterName: opts.clusterName },
        'Atlas cluster already exists — proceeding to polling (idempotent create)',
      );
    } else {
      throw err;
    }
  }
  return { clusterName: opts.clusterName };
}

export async function getClusterState(
  projectId: string,
  clusterName: string,
): Promise<{ stateName: 'CREATING' | 'IDLE' | 'UPDATING' | 'DELETING' | 'FAILED'; connectionString?: string }> {
  const json = (await digestRequest('GET', `/groups/${projectId}/clusters/${clusterName}`)) as {
    stateName: string;
    connectionStrings?: { standardSrv?: string; standard?: string };
  };
  return {
    stateName: json.stateName as 'CREATING' | 'IDLE' | 'UPDATING' | 'DELETING' | 'FAILED',
    connectionString: json.connectionStrings?.standardSrv ?? json.connectionStrings?.standard,
  };
}

export async function deleteCluster(projectId: string, clusterName: string): Promise<void> {
  try {
    await digestRequest('DELETE', `/groups/${projectId}/clusters/${clusterName}`);
  } catch (err) {
    if (err instanceof AtlasAdminApiError && err.status === 404) return; // already gone — idempotent teardown
    throw err;
  }
}

export async function deleteDatabaseUser(projectId: string, username: string): Promise<void> {
  try {
    await digestRequest('DELETE', `/groups/${projectId}/databaseUsers/admin/${username}`);
  } catch (err) {
    if (err instanceof AtlasAdminApiError && err.status === 404) return; // already gone — idempotent teardown
    throw err;
  }
}

// ── Cluster health monitoring (Atlas resilience task) ───────────────────
// Read-only wrappers backing monitoring/atlas-cluster-health-alerter.ts.
// The operator key these authenticate with only needs Project Read Only
// (never a write-capable role) — nothing below issues a mutating request.

/** `paused` is only present on the cluster description resource, not
 *  `getClusterState()`'s shape above — a separate, narrower read. */
export async function getClusterPausedState(projectId: string, clusterName: string): Promise<boolean> {
  const json = (await digestRequest('GET', `/groups/${projectId}/clusters/${clusterName}`)) as {
    paused?: boolean;
  };
  return json.paused === true;
}

export interface AtlasProcess {
  id: string;
  hostname: string;
  port: number;
  typeName?: string;
}

/** Every mongod/mongos process Atlas monitors for this project — the
 *  `processId` (`<hostname>:<port>`) each measurement is scoped to. */
export async function listProcesses(projectId: string): Promise<AtlasProcess[]> {
  const json = (await digestRequest('GET', `/groups/${projectId}/processes`)) as {
    results?: Array<{ id: string; hostname: string; port: number; typeName?: string }>;
  };
  return json.results ?? [];
}

export interface AtlasMeasurement {
  name: string;
  units: string;
  dataPoints: Array<{ timestamp: string; value: number | null }>;
}

/** Raw measurement series for one process (CONNECTIONS, DISK_PARTITION_UTILIZATION,
 *  OPLOG_SLAVE_LAG_MASTER_TIME, etc — Atlas Admin API v2 measurement names). */
export async function getProcessMeasurements(
  projectId: string,
  processId: string,
  measurementNames: string[],
  opts: { granularity?: string; period?: string } = {},
): Promise<AtlasMeasurement[]> {
  const granularity = opts.granularity ?? 'PT1M';
  const period = opts.period ?? 'PT10M';
  const query = measurementNames.map(m => `m=${encodeURIComponent(m)}`).join('&');
  const json = (await digestRequest(
    'GET',
    `/groups/${projectId}/processes/${processId}/measurements?granularity=${granularity}&period=${period}&${query}`,
  )) as { measurements?: AtlasMeasurement[] };
  return json.measurements ?? [];
}

/** Latest non-null data point in a measurement series, or null if the whole
 *  window came back empty (a brand-new process, or a measurement Atlas
 *  doesn't emit for this cluster tier — M0 disk/replication metrics are
 *  more limited than dedicated tiers). */
export function latestMeasurementValue(m: AtlasMeasurement | undefined): number | null {
  if (!m) return null;
  for (let i = m.dataPoints.length - 1; i >= 0; i--) {
    const v = m.dataPoints[i]?.value;
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

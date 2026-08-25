/**
 * tenant-provisioning-worker — ADR-032 §1.4 step 2: polls `dedicated-cluster`
 * provisioning to completion.
 *
 * Same lifecycle shape as `dual-write-worker.ts` (setInterval, poll-and-act,
 * start/stop/isRunning, re-entrancy guarded) and the same durable-state
 * resumability contract: every tick re-derives its work list from
 * `TenantDbBinding` (`status: 'provisioning'`, `atlasClusterName` set,
 * `provisioning.nextPollAt <= now`) — nothing here is cached in memory, so a
 * gateway restart loses only the in-flight tick (ADR-032 §1.4 step 3).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ IDEMPOTENCY (ADR-032 §1.4 step 3)                                        │
 * │                                                                           │
 * │   `createCluster` on an Atlas-already-exists cluster name is a           │
 * │   no-op-or-error `atlas-admin-client.ts` already treats as "proceed to   │
 * │   polling" (409 branch), not a hard failure. `getClusterState` and       │
 * │   `createScopedDatabaseUser` are naturally idempotent reads/creates. No  │
 * │   new resumability mechanism is needed beyond re-deriving from persisted │
 * │   state, same as ADR-031's worker.                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import mongoose from 'mongoose';
import { TenantDbBindingModel, isConnected, redactMongoUri } from './db.js';
import type { ITenantDbBinding } from './db.js';
import { getClusterState, createScopedDatabaseUser } from './atlas-admin-client.js';
import {
  buildDedicatedMongoUri,
  createScopedCollections,
  checkProvisioningReadiness,
  clusterPollBackoffMs,
  usernameForTenant,
} from './tenant-provisioning.js';
import { createChildLogger } from './logger.js';
import { getAdapter } from '../channels/registry.js';

const log = createChildLogger({ module: 'tenant-provisioning-worker' });

function envSeconds(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** ADR-032 §1.4 default poll cadence — a fresh tick decides the real delay
 *  via `clusterPollBackoffMs`; this is only the worker's own wake interval. */
export const DEFAULT_POLL_SECONDS = envSeconds('TENANT_PROVISIONING_POLL_SECONDS', 30);

/** Marks a binding's `provisioning.nextPollAt` as "polling stopped" (§1.4
 *  step 2 FAILED branch) — far enough in the future the claim query never
 *  matches it again on its own; an operator fixing the underlying Atlas
 *  issue (quota/region) resets it to resume polling. */
export const POLLING_STOPPED_SENTINEL = new Date(8_640_000_000_000_000);

type ClusterBinding = ITenantDbBinding & {
  _id: unknown;
  tenantId: string;
  dbName: string;
  atlasProjectId: string;
  atlasClusterName: string;
};

async function claimDuePolling(now: Date): Promise<ClusterBinding | null> {
  const doc = await TenantDbBindingModel.findOneAndUpdate(
    {
      status: 'provisioning',
      atlasClusterName: { $exists: true, $ne: null },
      'provisioning.nextPollAt': { $lte: now },
    },
    {
      // Provisional reschedule on claim (mirrors dual-write-worker's
      // status->'retrying' flip) — guards against a second worker instance
      // re-claiming the same row before this tick finishes; overwritten
      // below with the real outcome's backoff/terminal value.
      $set: { 'provisioning.nextPollAt': new Date(now.getTime() + DEFAULT_POLL_SECONDS * 1000) },
      $inc: { 'provisioning.attempts': 1 },
    },
    { sort: { 'provisioning.nextPollAt': 1 }, new: true },
  );
  return doc as unknown as ClusterBinding | null;
}

async function alertClusterProvisioningFailed(tenantId: string, clusterName: string, reason: string): Promise<void> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) return;
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) return;

  const message = [
    `\u{1F534} Tenant isolation provisioning FAILED (ADR-032 §1.4)`,
    `tenant=${tenantId} atlasCluster=${clusterName}`,
    `reason: ${reason}`,
    'Polling stopped — requires operator intervention (bad region/tier combo, quota limit); this does not resolve on a timer.',
  ].join('\n');

  try {
    await telegram.send(chatId, message);
  } catch (err) {
    log.error({ tenantId, err }, 'Failed to send cluster-provisioning-failed alert');
  }
}

export type PollOutcome = 'polled' | 'ready' | 'failed' | 'errored';

/**
 * Advance one claimed `dedicated-cluster` binding by exactly one poll:
 * CREATING/UPDATING -> reschedule with backoff; IDLE -> scope a credential,
 * build+verify the dedicated connection, flip provisioning -> migrating on a
 * clean readiness check; FAILED -> alert and stop polling (§1.4 step 2).
 */
export async function pollClusterBinding(binding: ClusterBinding, now: Date): Promise<PollOutcome> {
  const attempt = binding.provisioning?.attempts ?? 1;
  try {
    const state = await getClusterState(binding.atlasProjectId, binding.atlasClusterName);

    if (state.stateName === 'CREATING' || state.stateName === 'UPDATING') {
      await TenantDbBindingModel.updateOne(
        { tenantId: binding.tenantId },
        { $set: { 'provisioning.nextPollAt': new Date(now.getTime() + clusterPollBackoffMs(attempt)) } },
      );
      return 'polled';
    }

    if (state.stateName === 'FAILED') {
      const reason = 'Atlas cluster entered FAILED state';
      await TenantDbBindingModel.updateOne(
        { tenantId: binding.tenantId },
        { $set: { 'provisioning.lastError': reason, 'provisioning.nextPollAt': POLLING_STOPPED_SENTINEL } },
      );
      log.error({ tenantId: binding.tenantId, clusterName: binding.atlasClusterName }, 'Cluster provisioning FAILED — polling stopped, needs operator');
      await alertClusterProvisioningFailed(binding.tenantId, binding.atlasClusterName, reason);
      return 'failed';
    }

    if (state.stateName === 'DELETING') {
      // Not a state this flow should ever observe for a binding still in
      // 'provisioning' — treat like a transient state and keep polling
      // rather than guessing at intent.
      await TenantDbBindingModel.updateOne(
        { tenantId: binding.tenantId },
        { $set: { 'provisioning.nextPollAt': new Date(now.getTime() + clusterPollBackoffMs(attempt)) } },
      );
      return 'polled';
    }

    // IDLE — cluster is ready.
    if (!state.connectionString) {
      throw new Error('Atlas cluster reported IDLE but returned no connectionString');
    }
    const username = usernameForTenant(binding.tenantId);
    const { password } = await createScopedDatabaseUser({
      projectId: binding.atlasProjectId,
      dbName: binding.dbName,
      username,
    });
    const mongoUri = buildDedicatedMongoUri(state.connectionString, username, password, binding.dbName);

    const conn = await mongoose.createConnection(mongoUri, { dbName: binding.dbName }).asPromise();
    try {
      await createScopedCollections(conn);
    } finally {
      await conn.close().catch(() => {});
    }

    const readiness = await checkProvisioningReadiness(mongoUri, binding.dbName);
    if (!readiness.ready) {
      // §1.6 step 4: retry the check itself (bounded, same backoff shape)
      // rather than declaring 'migrating' against an unverified target.
      await TenantDbBindingModel.updateOne(
        { tenantId: binding.tenantId },
        {
          $set: {
            mongoUri,
            'provisioning.lastError': readiness.error,
            'provisioning.nextPollAt': new Date(now.getTime() + clusterPollBackoffMs(attempt)),
          },
        },
      );
      return 'polled';
    }

    await TenantDbBindingModel.updateOne(
      { tenantId: binding.tenantId },
      { $set: { mongoUri, status: 'migrating' }, $unset: { provisioning: 1 } },
    );

    // Log the outcome — the credential itself is redacted below, never raw.
    log.info(
      { tenantId: binding.tenantId, clusterName: binding.atlasClusterName, mongoUri: redactMongoUri(mongoUri) },
      'dedicated-cluster ready — provisioning -> migrating',
    );
    return 'ready';
  } catch (err) {
    log.warn({ tenantId: binding.tenantId, err }, 'Cluster provisioning poll attempt threw — rescheduling with backoff');
    await TenantDbBindingModel.updateOne(
      { tenantId: binding.tenantId },
      {
        $set: {
          'provisioning.lastError': err instanceof Error ? err.message : String(err),
          'provisioning.nextPollAt': new Date(now.getTime() + clusterPollBackoffMs(attempt)),
        },
      },
    ).catch(() => {});
    return 'errored';
  }
}

// ── Poll tick (mirrors dual-write-worker.ts's drainDualWriteQueue) ────────

export interface PollTickResult {
  processed: number;
  polled: number;
  ready: number;
  failed: number;
  errored: number;
}

function emptyPollResult(): PollTickResult {
  return { processed: 0, polled: 0, ready: 0, failed: 0, errored: 0 };
}

function requireDb(): void {
  if (!isConnected() || !TenantDbBindingModel) {
    throw new Error('MongoDB not connected — tenant-provisioning-worker unavailable');
  }
}

let polling = false;

/**
 * Poll all currently-due `dedicated-cluster` provisioning bindings, one
 * atomic claim at a time, up to `max` per tick. Re-entrancy guarded — a slow
 * tick never overlaps the next interval firing. Never throws.
 *
 * @param now injectable clock (claim key + backoff math) for deterministic tests.
 */
export async function pollDedicatedClusterProvisioning(now: Date = new Date(), max = 20): Promise<PollTickResult> {
  if (polling) return emptyPollResult();
  polling = true;
  const result = emptyPollResult();
  try {
    requireDb();
    while (result.processed < max) {
      const binding = await claimDuePolling(now);
      if (!binding) break;
      const outcome = await pollClusterBinding(binding, now).catch((err: unknown) => {
        log.error({ err, tenantId: binding.tenantId }, 'Cluster provisioning poll threw unexpectedly');
        return 'errored' as PollOutcome;
      });
      result.processed++;
      result[outcome]++;
    }
  } catch (err) {
    log.warn({ err }, 'Tenant-provisioning poll tick skipped — DB unavailable');
  } finally {
    polling = false;
  }
  if (result.processed > 0) {
    log.info(result, 'Tenant-provisioning poll tick complete');
  }
  latestResult = { ranAt: now, ...result };
  return result;
}

// ── Lifecycle (mirrors dual-write-worker.ts) ────────────────────────────

export interface TenantProvisioningWorkerStatusResult extends PollTickResult {
  ranAt: Date;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: TenantProvisioningWorkerStatusResult | null = null;

export function startTenantProvisioningWorker(pollSeconds: number = DEFAULT_POLL_SECONDS): void {
  if (intervalId) {
    log.warn('Tenant-provisioning worker already running');
    return;
  }
  const intervalMs = pollSeconds * 1000;
  log.info({ pollSeconds }, 'Starting tenant-provisioning (dedicated-cluster) poll worker');
  intervalId = setInterval(() => {
    pollDedicatedClusterProvisioning(new Date()).catch(err =>
      log.error({ err }, 'Periodic tenant-provisioning poll tick failed'),
    );
  }, intervalMs);
  intervalId.unref?.();
}

export function stopTenantProvisioningWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Tenant-provisioning worker stopped');
  }
}

export function isTenantProvisioningWorkerRunning(): boolean {
  return intervalId !== null;
}

export function getLatestTenantProvisioningWorkerResult(): TenantProvisioningWorkerStatusResult | null {
  return latestResult;
}

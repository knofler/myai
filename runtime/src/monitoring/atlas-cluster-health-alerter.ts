/**
 * atlas-cluster-health-alerter — Atlas resilience alerts for the M0 free-tier
 * cluster (cluster0.example.mongodb.net, measured 2026-08-15).
 *
 * M0 has no SLA, runs on shared infra Atlas can migrate/restart without
 * notice, auto-pauses after 60 days idle, and has no continuous backup/PITR.
 * Client-side hardening (capped pools, retryWrites, the read-only local
 * mirror failover in db-failover.ts) softens the blast radius of an M0
 * incident but can't detect one — this module is the detection half: it
 * polls the Atlas Admin API v2 (read-only) for the four signals that matter
 * on a free tier and pushes an alert (Telegram + emitNotifyEvent dashboard
 * bell/toast + durable history), reusing pool-capacity-alerter's delivery
 * mechanism exactly:
 *
 *   - connections  — above MYAI_ATLAS_ALERT_CONN_PCT% of the tier's cap
 *                     (default 80% of 500, the M0 connection ceiling)
 *   - replication lag — above MYAI_ATLAS_ALERT_REPL_LAG_SECONDS (default 10s)
 *   - disk usage   — above MYAI_ATLAS_ALERT_DISK_PCT% (default 75%)
 *   - cluster paused/resumed — a state TRANSITION (paused now, wasn't last
 *     check, or vice versa) — the free-tier auto-pause-after-60-days-idle
 *     failure mode this whole task exists to catch
 *
 * Upgrading to M10+ is a billing decision for the operator, not something
 * this module (or any autonomous agent) can or should action — see the
 * fleet task this shipped under. This module only detects and alerts.
 *
 * Credentials: ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY (a read-only Atlas
 * project API key — Project Read Only role is sufficient, nothing here
 * writes) plus ATLAS_PROJECT_ID / ATLAS_CLUSTER_NAME. None of these existed
 * in the environment as of 2026-08-15 (grep found zero ATLAS_ keys) — this
 * module is inert (startAtlasClusterHealthAlerts() logs once and returns
 * without starting a poll loop) until an operator provisions them. It never
 * invents or falls back to a different credential source.
 *
 * Dedup: paused/resumed alerts fire once per transition. connections/
 * replication-lag/disk breaches fire once per severity per calendar day
 * (Sydney), same "escalation re-fires, repeat-at-same-severity suppressed"
 * posture as pool-capacity-alerter — a free-tier incident is worth a daily
 * reminder while it persists, not a one-shot.
 */
import {
  listProcesses,
  getProcessMeasurements,
  getClusterPausedState,
  latestMeasurementValue,
  AtlasAdminApiError,
} from '../shared/atlas-admin-client.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { getAdapter } from '../channels/registry.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'atlas-cluster-health-alerter' });

// ── Config ────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface AtlasClusterHealthConfig {
  projectId: string | undefined;
  clusterName: string | undefined;
  /** Connection cap the pct alert is measured against — M0's hard ceiling. */
  connectionCap: number;
  connectionAlertPct: number;
  replicationLagAlertSeconds: number;
  diskAlertPct: number;
}

export function atlasClusterHealthConfig(): AtlasClusterHealthConfig {
  return {
    projectId: process.env.ATLAS_PROJECT_ID,
    clusterName: process.env.ATLAS_CLUSTER_NAME,
    connectionCap: envNum('MYAI_ATLAS_ALERT_CONN_CAP', 500),
    connectionAlertPct: envNum('MYAI_ATLAS_ALERT_CONN_PCT', 80),
    replicationLagAlertSeconds: envNum('MYAI_ATLAS_ALERT_REPL_LAG_SECONDS', 10),
    diskAlertPct: envNum('MYAI_ATLAS_ALERT_DISK_PCT', 75),
  };
}

/** ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY are read directly by
 *  atlas-admin-client.ts at request time — this only checks presence so the
 *  alerter can decide whether to poll at all without ever holding the
 *  secret itself. */
export function atlasCredentialsConfigured(): boolean {
  return Boolean(process.env.ATLAS_PUBLIC_KEY && process.env.ATLAS_PRIVATE_KEY);
}

// ── Pure breach evaluation (unit-testable without I/O) ───────────

export type AtlasHealthSeverity = 'warning' | 'critical';

export interface AtlasClusterSnapshot {
  connections: number | null;
  replicationLagSeconds: number | null;
  diskUsedPct: number | null;
  paused: boolean;
}

export interface AtlasHealthBreach {
  kind: 'connections' | 'replication_lag' | 'disk' | 'cluster_paused' | 'cluster_resumed';
  severity: AtlasHealthSeverity;
  message: string;
  value?: number;
  threshold?: number;
}

/**
 * Compare a fresh snapshot against thresholds AND the previous snapshot's
 * `paused` flag (a transition, not a level, is what matters for pause/
 * resume — the M0 auto-pause failure mode this exists to catch). Pure —
 * no I/O, fully unit-testable.
 */
export function evaluateAtlasClusterHealth(
  snapshot: AtlasClusterSnapshot,
  prevPaused: boolean | null,
  cfg: AtlasClusterHealthConfig,
): AtlasHealthBreach[] {
  const breaches: AtlasHealthBreach[] = [];

  if (snapshot.connections !== null && cfg.connectionCap > 0) {
    const pct = (snapshot.connections / cfg.connectionCap) * 100;
    if (pct >= cfg.connectionAlertPct) {
      breaches.push({
        kind: 'connections',
        severity: 'critical',
        message: `Connections at ${snapshot.connections}/${cfg.connectionCap} (${pct.toFixed(1)}%) — at or above the ${cfg.connectionAlertPct}% alert threshold`,
        value: pct,
        threshold: cfg.connectionAlertPct,
      });
    }
  }

  if (snapshot.replicationLagSeconds !== null && snapshot.replicationLagSeconds >= cfg.replicationLagAlertSeconds) {
    breaches.push({
      kind: 'replication_lag',
      severity: 'critical',
      message: `Replication lag ${snapshot.replicationLagSeconds.toFixed(1)}s — at or above the ${cfg.replicationLagAlertSeconds}s alert threshold`,
      value: snapshot.replicationLagSeconds,
      threshold: cfg.replicationLagAlertSeconds,
    });
  }

  if (snapshot.diskUsedPct !== null && snapshot.diskUsedPct >= cfg.diskAlertPct) {
    breaches.push({
      kind: 'disk',
      severity: 'critical',
      message: `Disk usage at ${snapshot.diskUsedPct.toFixed(1)}% — at or above the ${cfg.diskAlertPct}% alert threshold`,
      value: snapshot.diskUsedPct,
      threshold: cfg.diskAlertPct,
    });
  }

  // Transition only — a steady paused or steady running state is not a
  // fresh event. prevPaused === null means "no prior snapshot" (first boot
  // of this process): never fire on that, there's nothing to compare to.
  if (prevPaused !== null && prevPaused !== snapshot.paused) {
    breaches.push(
      snapshot.paused
        ? {
            kind: 'cluster_paused',
            severity: 'critical',
            message:
              'Cluster transitioned to PAUSED — M0 auto-pauses after 60 days idle, or an operator paused it manually. The gateway will be unable to reach the primary until it is resumed.',
          }
        : {
            kind: 'cluster_resumed',
            severity: 'warning',
            message: 'Cluster transitioned back to RUNNING (resumed from paused).',
          },
    );
  }

  return breaches;
}

// ── Snapshot fetch ────────────────────────────────────────────

/** MongoDB replication-lag measurement name in the Atlas Admin API v2. */
const MEASUREMENT_NAMES = ['CONNECTIONS', 'DISK_PARTITION_UTILIZATION', 'OPLOG_SLAVE_LAG_MASTER_TIME'];

async function fetchSnapshot(cfg: AtlasClusterHealthConfig): Promise<AtlasClusterSnapshot | null> {
  if (!cfg.projectId || !cfg.clusterName) return null;

  const paused = await getClusterPausedState(cfg.projectId, cfg.clusterName);

  const processes = await listProcesses(cfg.projectId);
  // A paused cluster reports zero processes — connections/lag/disk are
  // meaningless while paused, so the snapshot carries only the pause state.
  const process = processes.find(p =>
    p.hostname.toLowerCase().startsWith(cfg.clusterName!.toLowerCase()),
  );
  if (!process) {
    return { connections: null, replicationLagSeconds: null, diskUsedPct: null, paused };
  }

  const measurements = await getProcessMeasurements(cfg.projectId, process.id, MEASUREMENT_NAMES);
  const byName = new Map(measurements.map(m => [m.name, m]));

  return {
    connections: latestMeasurementValue(byName.get('CONNECTIONS')),
    replicationLagSeconds: latestMeasurementValue(byName.get('OPLOG_SLAVE_LAG_MASTER_TIME')),
    diskUsedPct: latestMeasurementValue(byName.get('DISK_PARTITION_UTILIZATION')),
    paused,
  };
}

// ── Alert dispatch ────────────────────────────────────────────

function formatAlertMessage(b: AtlasHealthBreach, clusterName: string): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const icon = b.severity === 'critical' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';
  return [
    `${icon} Atlas cluster "${clusterName}" — ${b.message}`,
    '',
    'This cluster is an M0 free tier: no SLA, shared infra Atlas can migrate/restart without notice, auto-pauses after 60 days idle, no continuous backup/PITR. Client-side hardening (capped pools, read-only local mirror failover) softens the impact but does not fix the underlying tier limitation — the only real fix is an M10+ dedicated upgrade, a billing decision for the operator.',
    `Detected at ${timestamp} UTC`,
  ].join('\n');
}

async function sendTelegram(b: AtlasHealthBreach, clusterName: string): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) return false;
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) return false;
  try {
    await telegram.send(chatId, formatAlertMessage(b, clusterName));
    return true;
  } catch (err) {
    log.error({ err, kind: b.kind }, 'Failed to send Atlas cluster health Telegram alert');
    return false;
  }
}

// ── Dedup watermark ────────────────────────────────────────────

const SEVERITY_RANK: Record<AtlasHealthSeverity, number> = { warning: 1, critical: 2 };

/** key: `${kind}|${dayKey}` -> highest severity rank already alerted that day. */
const alerted = new Map<string, number>();
let lastPaused: boolean | null = null;

function sydneyDayKey(now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(now));
}

export function clearAtlasClusterHealthWatermarks(): void {
  alerted.clear();
  lastPaused = null;
}

// ── Main check runner ─────────────────────────────────────────

export interface AtlasClusterHealthCheckResult {
  ranAt: Date;
  configured: boolean;
  snapshotAvailable: boolean;
  breaches: AtlasHealthBreach[];
  alertsFired: number;
  telegramSent: number;
}

let credentialGapLogged = false;

export async function runAtlasClusterHealthCheck(now: number = Date.now()): Promise<AtlasClusterHealthCheckResult> {
  const ranAt = new Date(now);
  const empty: AtlasClusterHealthCheckResult = {
    ranAt,
    configured: false,
    snapshotAvailable: false,
    breaches: [],
    alertsFired: 0,
    telegramSent: 0,
  };

  const cfg = atlasClusterHealthConfig();
  if (!atlasCredentialsConfigured() || !cfg.projectId || !cfg.clusterName) {
    if (!credentialGapLogged) {
      log.warn(
        'ATLAS_PUBLIC_KEY/ATLAS_PRIVATE_KEY/ATLAS_PROJECT_ID/ATLAS_CLUSTER_NAME not fully configured — ' +
          'Atlas cluster health alerts disabled. Ask the operator to create a read-only Atlas project API key ' +
          '(Project Read Only role) and set these env vars to enable.',
      );
      credentialGapLogged = true;
    }
    return empty;
  }

  try {
    const snapshot = await fetchSnapshot(cfg);
    if (!snapshot) return empty;

    const breaches = evaluateAtlasClusterHealth(snapshot, lastPaused, cfg);
    lastPaused = snapshot.paused;

    const dayKey = sydneyDayKey(now);
    let alertsFired = 0;
    let telegramSent = 0;

    for (const b of breaches) {
      // Transition events (pause/resume) are one-shot per transition, not
      // deduped by day — the state-change IS the dedup key.
      const key = b.kind === 'cluster_paused' || b.kind === 'cluster_resumed' ? b.kind : `${b.kind}|${dayKey}`;
      const rank = SEVERITY_RANK[b.severity];
      if (b.kind !== 'cluster_paused' && b.kind !== 'cluster_resumed') {
        if ((alerted.get(key) ?? 0) >= rank) continue;
        alerted.set(key, rank);
      }
      alertsFired++;

      emitNotifyEvent({
        type: `runner.atlas_cluster_${b.kind}`,
        tenantId: DEFAULT_TENANT_ID,
        title: `Atlas cluster ${cfg.clusterName}: ${b.kind.replace(/_/g, ' ')}`,
        message: formatAlertMessage(b, cfg.clusterName!),
        level: b.severity,
        source: 'atlas-cluster-health-alerter',
        data: { kind: b.kind, value: b.value ?? null, threshold: b.threshold ?? null, cluster: cfg.clusterName },
      });

      if (await sendTelegram(b, cfg.clusterName!)) telegramSent++;
      log.warn({ kind: b.kind, severity: b.severity, value: b.value }, 'Atlas cluster health alert fired');
    }

    return { ranAt, configured: true, snapshotAvailable: true, breaches, alertsFired, telegramSent };
  } catch (err) {
    if (err instanceof AtlasAdminApiError) {
      log.warn({ err, status: err.status }, 'Atlas cluster health check failed (Admin API error, suppressed)');
    } else {
      log.warn({ err }, 'Atlas cluster health check failed (suppressed)');
    }
    return { ...empty, configured: true };
  }
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
const DEFAULT_INTERVAL_MINUTES = 10;

/** No-ops (never starts a poll loop) when Atlas credentials aren't
 *  configured — logs the gap once via runAtlasClusterHealthCheck() rather
 *  than polling forever against a guaranteed-empty config. */
export function startAtlasClusterHealthAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Atlas cluster health alerts already running');
    return;
  }
  if (!atlasCredentialsConfigured()) {
    log.warn(
      'ATLAS_PUBLIC_KEY/ATLAS_PRIVATE_KEY not set — Atlas cluster health alerts NOT started. ' +
        'Ask the operator to create a read-only Atlas project API key to enable.',
    );
    return;
  }
  intervalId = setInterval(() => {
    runAtlasClusterHealthCheck().catch(err => log.error({ err }, 'Periodic Atlas cluster health check failed'));
  }, intervalMinutes * 60 * 1000);
  log.info({ intervalMinutes }, 'Starting Atlas cluster health alerts');
}

export function stopAtlasClusterHealthAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Atlas cluster health alerts stopped');
  }
}

export function isAtlasClusterHealthAlertsRunning(): boolean {
  return intervalId !== null;
}

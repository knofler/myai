/**
 * Security-anomaly alerter — turns the passive hash-chained audit log
 * (core/audit-log.ts) into an active security signal. Three burst detectors
 * read the trail and, on a hit, raise a tenant-admin alert through the
 * notification engine (notifications/event-bus.ts → service.ts, the SAME
 * fan-out `llm/spend-alert.ts` uses for billing alerts — SSE toast +
 * persisted history + push/email per the tenant's preferences).
 *
 *   - repeated permission denials — `rbac.denied` events, N+ from the SAME
 *     actor inside a rolling window (now actually persisted to the trail by
 *     rbac.ts's enforce path — previously only structured-logged).
 *   - mass / bulk data export     — `data.export` events (audit-trail /
 *     memory-bundle / vector-corpus downloads), N+ from the SAME actor
 *     inside a rolling window.
 *   - impossible-travel login     — `session.login` events (fired once per
 *     login from the single `recordSession()` chokepoint every auth method
 *     shares), same user, two logins inside a short window from IPs on
 *     different /16 network prefixes. This is an IP-prefix heuristic PROXY
 *     for geo-distance — this module stays dependency-light (no MaxMind/
 *     geoIP database), matching audit-log.ts's own no-heavy-deps discipline.
 *     Expect some false positives (mobile carriers / VPN exit rotation);
 *     it's a signal to investigate, never a block.
 *
 * Dedup: an in-memory 2h window per (tenantId, kind, actorUserId) — the same
 * discipline `monitoring/health-alerter.ts` uses — so a sustained burst
 * alerts once, not once per event.
 */

import { queryAuditEvents, type AuditEvent } from '../core/audit-log.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { TenantModel, isConnected } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'security-anomaly-alerter' });

export type AnomalyKind = 'permission_denial_burst' | 'mass_export' | 'impossible_travel';

export interface AnomalyFinding {
  kind: AnomalyKind;
  tenantId: string;
  actorUserId: string;
  message: string;
  detail: Record<string, unknown>;
}

// ── Thresholds ────────────────────────────────────────────────
export const DENIAL_BURST_THRESHOLD = 5;
export const DENIAL_BURST_WINDOW_MINUTES = 10;
export const EXPORT_BURST_THRESHOLD = 3;
export const EXPORT_BURST_WINDOW_MINUTES = 15;
export const IMPOSSIBLE_TRAVEL_WINDOW_MINUTES = 60;

// ── Pure detectors (unit-testable with plain AuditEvent[] arrays) ─────────

function withinMinutes(a: string, b: string, minutes: number): boolean {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= minutes * 60_000;
}

function groupByActor(events: AuditEvent[]): Map<string, AuditEvent[]> {
  const groups = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const key = e.actor?.userId;
    if (!key) continue; // no attributable actor (system/api-key without a human) — nothing to alert on
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  return groups;
}

/**
 * Shared burst detector for permission-denial + mass-export: flags the first
 * run of `threshold` events from the SAME actor whose first/last timestamps
 * fall inside `windowMinutes`. One finding per actor per call — repeated
 * calls converge on the same finding, which the alert-dispatch dedup below
 * collapses to a single notification.
 */
function detectBurst(
  events: AuditEvent[],
  kind: AnomalyKind,
  threshold: number,
  windowMinutes: number,
  messageFor: (actorUserId: string, count: number, windowMinutes: number) => string,
): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];
  for (const [actorUserId, actorEvents] of groupByActor(events)) {
    if (actorEvents.length < threshold) continue;
    const sorted = [...actorEvents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let i = 0; i <= sorted.length - threshold; i++) {
      const windowEnd = sorted[i + threshold - 1];
      if (withinMinutes(sorted[i].createdAt, windowEnd.createdAt, windowMinutes)) {
        findings.push({
          kind,
          tenantId: sorted[i].tenantId,
          actorUserId,
          message: messageFor(actorUserId, threshold, windowMinutes),
          detail: { count: threshold, windowMinutes, firstAt: sorted[i].createdAt, lastAt: windowEnd.createdAt },
        });
        break;
      }
    }
  }
  return findings;
}

/** N+ `rbac.denied` events from the same actor within a rolling window. */
export function detectPermissionDenialBurst(events: AuditEvent[]): AnomalyFinding[] {
  return detectBurst(
    events.filter((e) => e.action === 'rbac.denied'),
    'permission_denial_burst',
    DENIAL_BURST_THRESHOLD,
    DENIAL_BURST_WINDOW_MINUTES,
    (actor, count, mins) => `${count}+ permission denials for ${actor} within ${mins} minutes`,
  );
}

/** N+ `data.export` events from the same actor within a rolling window. */
export function detectMassExport(events: AuditEvent[]): AnomalyFinding[] {
  return detectBurst(
    events.filter((e) => e.action === 'data.export'),
    'mass_export',
    EXPORT_BURST_THRESHOLD,
    EXPORT_BURST_WINDOW_MINUTES,
    (actor, count, mins) => `${count}+ bulk data exports by ${actor} within ${mins} minutes`,
  );
}

/** First two octets of an IPv4 address — a coarse "network origin" proxy.
 *  Undefined for anything else (IPv6, hostnames, missing ip) so those never
 *  spuriously match OR mismatch. */
function ipNetworkPrefix(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return undefined;
  return `${parts[0]}.${parts[1]}`;
}

/**
 * Impossible-travel: the SAME user logging in from two IPs on different
 * network prefixes within a window too short for plausible relocation.
 * Compares only CONSECUTIVE logins (each new login vs. the last one) —
 * standard impossible-travel practice and avoids O(n^2) pair comparison.
 */
export function detectImpossibleTravel(events: AuditEvent[]): AnomalyFinding[] {
  const logins = events.filter((e) => e.action === 'session.login');
  const findings: AnomalyFinding[] = [];
  for (const [actorUserId, actorEvents] of groupByActor(logins)) {
    if (actorEvents.length < 2) continue;
    const sorted = [...actorEvents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let i = 1; i < sorted.length; i++) {
      const prevIp = (sorted[i - 1].detail as { ip?: string } | undefined)?.ip;
      const currIp = (sorted[i].detail as { ip?: string } | undefined)?.ip;
      const prevPrefix = ipNetworkPrefix(prevIp);
      const currPrefix = ipNetworkPrefix(currIp);
      if (!prevPrefix || !currPrefix || prevPrefix === currPrefix) continue;
      if (withinMinutes(sorted[i - 1].createdAt, sorted[i].createdAt, IMPOSSIBLE_TRAVEL_WINDOW_MINUTES)) {
        findings.push({
          kind: 'impossible_travel',
          tenantId: sorted[i].tenantId,
          actorUserId,
          message: `Logins for ${actorUserId} from ${prevIp} then ${currIp} within ${IMPOSSIBLE_TRAVEL_WINDOW_MINUTES} minutes`,
          detail: { prevIp, currIp, prevAt: sorted[i - 1].createdAt, currAt: sorted[i].createdAt },
        });
        break;
      }
    }
  }
  return findings;
}

// ── Alert dispatch — dedup + notification engine ──────────────────────────

interface AlertRecord {
  alertedAt: number;
}

const alertHistory = new Map<string, AlertRecord>();

/** Dedup window: 2 hours — same as `monitoring/health-alerter.ts`. */
const DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Clear all alert dedup history (test isolation helper). */
export function clearAnomalyAlertHistory(): void {
  alertHistory.clear();
}

function alertKey(f: AnomalyFinding): string {
  return `${f.tenantId}:${f.kind}:${f.actorUserId}`;
}

function shouldAlert(f: AnomalyFinding): boolean {
  const prev = alertHistory.get(alertKey(f));
  if (!prev) return true;
  return Date.now() - prev.alertedAt >= DEDUP_WINDOW_MS;
}

function emitFinding(f: AnomalyFinding): void {
  emitNotifyEvent({
    type: `security.anomaly.${f.kind}`,
    tenantId: f.tenantId,
    title: 'Security anomaly detected',
    message: f.message,
    level: 'critical',
    source: 'security-anomaly-alerter',
    data: { kind: f.kind, actorUserId: f.actorUserId, ...f.detail },
  });
  alertHistory.set(alertKey(f), { alertedAt: Date.now() });
}

/**
 * Run all three detectors for one tenant over a rolling lookback window and
 * alert (dedup'd) on anything found. Returns every finding from this run
 * regardless of whether it was actually alerted (some may be within the
 * dedup window) — callers that need "was a NEW alert raised" should check
 * the return against `clearAnomalyAlertHistory`/their own bookkeeping, or
 * just trust the emitted `security.anomaly.*` notification.
 */
export function runSecurityAnomalyCheck(tenantId: string, lookbackMinutes = 60): AnomalyFinding[] {
  const since = new Date(Date.now() - lookbackMinutes * 60_000).toISOString();
  const events = queryAuditEvents({
    tenantId,
    action: ['rbac.denied', 'data.export', 'session.login'],
    since,
    limit: 1000,
  });

  const findings = [
    ...detectPermissionDenialBurst(events),
    ...detectMassExport(events),
    ...detectImpossibleTravel(events),
  ];

  for (const f of findings) {
    if (shouldAlert(f)) {
      emitFinding(f);
      log.warn({ tenantId, kind: f.kind, actorUserId: f.actorUserId }, 'security anomaly alert raised');
    }
  }
  return findings;
}

// ── Lifecycle: periodic sweep across every tenant ──────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
const DEFAULT_INTERVAL_MINUTES = 15;

async function allTenantIds(): Promise<string[]> {
  if (!isConnected() || !TenantModel) return [];
  try {
    const docs = await TenantModel.find({}).select('tenantId').lean<Array<{ tenantId: string }>>();
    return docs.map((d) => d.tenantId);
  } catch (err) {
    log.warn({ err }, 'failed to list tenants for security anomaly sweep');
    return [];
  }
}

/** One sweep across every tenant. Never throws — a single tenant's check
 *  failing must not stop the rest from running. */
export async function runSecurityAnomalySweep(): Promise<void> {
  for (const tenantId of await allTenantIds()) {
    try {
      runSecurityAnomalyCheck(tenantId);
    } catch (err) {
      log.warn({ err, tenantId }, 'security anomaly check failed for tenant');
    }
  }
}

export function startSecurityAnomalyAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('security anomaly alerts already running');
    return;
  }
  const intervalMs = intervalMinutes * 60 * 1000;
  runSecurityAnomalySweep().catch((err) => log.error({ err }, 'initial security anomaly sweep failed'));
  intervalId = setInterval(() => {
    runSecurityAnomalySweep().catch((err) => log.error({ err }, 'periodic security anomaly sweep failed'));
  }, intervalMs);
  log.info({ intervalMinutes }, 'security anomaly alerts started');
}

export function stopSecurityAnomalyAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('security anomaly alerts stopped');
  }
}

export function isSecurityAnomalyAlertsRunning(): boolean {
  return intervalId !== null;
}

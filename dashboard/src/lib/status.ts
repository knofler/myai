// Shared public-status aggregation — used by both the /api/status route
// (machine-readable) and the /status page (human UI) so they never drift.
//
// Aggregates the health of every customer-facing component: the gateway
// (deep health), the dashboard's own MongoDB connection, the CLI task-runner,
// rolling uptime, and the incident log. No tenant data — up/down + latency only.

import { connectDB, Task } from './db';
import { GATEWAY_HTTP_URL } from './gateway';
import { readRunnerHealth, getRunnerLiveness } from './runner-health';
import { readIncidents, hasActiveIncident, type Incident } from './incidents';

export type CompStatus = 'operational' | 'degraded' | 'down';

export interface Component {
  status: CompStatus;
  latencyMs?: number;
  detail?: string;
}

export interface UptimeWindow {
  windowMs: number;
  samples: number;
  uptime: number;
  healthy: number;
}

export interface UptimeStats {
  startedAt: string;
  uptimeSeconds: number;
  totalSamples: number;
  current: string | null;
  windows: { hour: UptimeWindow; day: UptimeWindow; week: UptimeWindow };
}

export interface PublicStatus {
  status: CompStatus;
  timestamp: string;
  components: {
    gateway: Component;
    dashboard: Component;
    mongo: Component;
    runner: Component;
  };
  uptime: UptimeStats | null;
  incidents: Incident[];
}

const TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function checkGateway(): Promise<{ gateway: Component; mongo: Component }> {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(`${GATEWAY_HTTP_URL}/health/deep`);
    const latencyMs = Date.now() - start;
    const body = (await res.json()) as {
      status?: string;
      checks?: {
        mongodb?: {
          status?: string;
          details?: { failover?: { active?: boolean; failoverUriHost?: string } };
        };
      };
    };
    const gwStatus: CompStatus =
      body.status === 'healthy' ? 'operational' : body.status === 'degraded' ? 'degraded' : 'down';
    const mongoRaw = body.checks?.mongodb?.status;
    // Read-side failover (MYAI_DB_FAILOVER=local): the gateway is serving
    // READS from the local mirror — show why mongo is degraded, not just that it is.
    const failover = body.checks?.mongodb?.details?.failover;
    const mongo: Component = {
      status: mongoRaw === 'up' ? 'operational' : mongoRaw === 'degraded' ? 'degraded' : 'down',
      ...(failover?.active
        ? { detail: `READ-ONLY failover to local mirror (${failover.failoverUriHost ?? 'local'}) — primary unreachable` }
        : {}),
    };
    return { gateway: { status: gwStatus, latencyMs }, mongo };
  } catch {
    return {
      gateway: { status: 'down', latencyMs: Date.now() - start, detail: 'unreachable' },
      mongo: { status: 'down', detail: 'gateway unreachable' },
    };
  }
}

async function checkDashboard(): Promise<Component> {
  const start = Date.now();
  try {
    await connectDB();
    await Task.estimatedDocumentCount();
    return { status: 'operational', latencyMs: Date.now() - start };
  } catch {
    return { status: 'down', latencyMs: Date.now() - start, detail: 'db unreachable' };
  }
}

async function fetchUptime(): Promise<UptimeStats | null> {
  try {
    const res = await fetchWithTimeout(`${GATEWAY_HTTP_URL}/api/status/uptime`);
    if (!res.ok) return null;
    return (await res.json()) as UptimeStats;
  } catch {
    return null;
  }
}

function runnerComponent(
  runner: Awaited<ReturnType<typeof readRunnerHealth>>,
  liveness: Awaited<ReturnType<typeof getRunnerLiveness>>,
): Component {
  // Liveness heartbeat (gateway-backed, cross-machine) is the stronger signal:
  // no heartbeat within the threshold means the runner process itself appears
  // dead, distinct from a "stall" (alive but stuck on a bad task).
  if (liveness.machines.length > 0 && !liveness.alive) {
    const mins = liveness.machines[0].minutesSince;
    return { status: 'down', detail: `no heartbeat in ${mins}m (last seen ${liveness.lastMachine})` };
  }
  if (!runner || !runner.available) return { status: 'operational', detail: 'no runner data' };
  if (runner.global.stall) {
    return { status: 'degraded', detail: `stalled (${runner.global.stalledRepo ?? 'unknown'})` };
  }
  return { status: 'operational', detail: `${runner.global.firesLast24h} fires/24h` };
}

export function overallOf(components: Component[], incidentActive: boolean): CompStatus {
  if (components.some((c) => c.status === 'down')) return 'down';
  if (incidentActive || components.some((c) => c.status === 'degraded')) return 'degraded';
  return 'operational';
}

/** Assemble the full public status snapshot. Never throws. */
export async function getPublicStatus(): Promise<PublicStatus> {
  const [gw, dashboard, runnerHealth, runnerLiveness, incidents, uptime] = await Promise.all([
    checkGateway(),
    checkDashboard(),
    readRunnerHealth(),
    getRunnerLiveness().catch(() => ({ thresholdMinutes: 25, alive: true, lastHeartbeatAt: null, lastMachine: null, machines: [] })),
    readIncidents(),
    fetchUptime(),
  ]);

  const components = {
    gateway: gw.gateway,
    dashboard,
    mongo: gw.mongo,
    runner: runnerComponent(runnerHealth, runnerLiveness),
  };
  const overall = overallOf(Object.values(components), hasActiveIncident(incidents));

  return {
    status: overall,
    timestamp: new Date().toISOString(),
    components,
    uptime,
    incidents: incidents.incidents,
  };
}

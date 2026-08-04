import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildLogger } from '../shared/logger.js';
import { isConnected, AgentModel, DEFAULT_TENANT_ID, getMongoBootFailure, getDbFailoverState } from '../shared/db.js';
import { isConfigured as isLlmConfigured } from '../llm/provider.js';
import { getAgentCount, getSkillCount } from '../agents/loader.js';
import { listAdapters, getChannelSessionCount } from '../channels/registry.js';
import { getVectorCount } from '../memory/vector-store.js';

const log = createChildLogger({ module: 'health' });

// ── Types ─────────────────────────────────────────────────

export interface ComponentHealth {
  status: 'up' | 'degraded' | 'down';
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  version: string;
  checks: {
    mongodb: ComponentHealth;
    llm: ComponentHealth;
    scheduler: ComponentHealth;
    channels: ComponentHealth;
    agents: ComponentHealth;
    memory: ComponentHealth;
  };
  timestamp: string;
}

// ── Helpers ───────────────────────────────────────────────

/** Read package.json version once at import time. */
let cachedVersion: string | undefined;
function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    // fileURLToPath works on all Node 18+ (import.meta.dirname is Node ≥20.11 only).
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    cachedVersion = pkg.version ?? '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion!;
}

/** Measure wall-clock time of an async function in milliseconds. */
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, latencyMs: Math.round(performance.now() - start) };
}

// ── Individual probes ─────────────────────────────────────

async function checkMongodb(): Promise<ComponentHealth> {
  const connected = isConnected();
  if (!connected) {
    const bootFailure = getMongoBootFailure();
    return {
      status: 'down',
      details: bootFailure ? { state: 'disconnected', bootFailure } : { state: 'disconnected' },
    };
  }

  try {
    const { result: count, latencyMs } = await timed(() => AgentModel.countDocuments());
    // Read-side failover (MYAI_DB_FAILOVER=local): connected, but to the
    // local mirror in READ-ONLY degraded mode — never report that as 'up'.
    const failover = getDbFailoverState();
    if (failover.active) {
      return {
        status: 'degraded',
        latencyMs,
        details: { state: 'connected', agentDocuments: count, failover },
      };
    }
    return {
      status: 'up',
      latencyMs,
      details: { state: 'connected', agentDocuments: count },
    };
  } catch (err) {
    log.warn({ err }, 'MongoDB connected but query failed');
    return {
      status: 'degraded',
      details: { state: 'connected', queryError: (err as Error).message },
    };
  }
}

function checkLlm(): ComponentHealth {
  const configured = isLlmConfigured();
  const providers: string[] = [];

  if (process.env.ANTHROPIC_API_KEY) providers.push('anthropic');
  if (process.env.DEEPSEEK_API_KEY) providers.push('deepseek');
  if (process.env.MOONSHOT_API_KEY || process.env.OPENROUTER_API_KEY) providers.push('moonshot');
  if (process.env.GEMINI_API_KEY) providers.push('gemini');
  // Ollama is always locally available when enabled
  if (process.env.OLLAMA_BASE_URL || process.env.LLM_MODE === 'ollama') providers.push('ollama');

  if (!configured) {
    return {
      status: providers.length > 0 ? 'degraded' : 'down',
      details: { configured: false, availableProviders: providers },
    };
  }

  return {
    status: 'up',
    details: { configured: true, availableProviders: providers },
  };
}

async function checkScheduler(): Promise<ComponentHealth> {
  try {
    const { listSchedules } = await import('../scheduler/schedule-store.js');
    const { result: schedules, latencyMs } = await timed(() => listSchedules(DEFAULT_TENANT_ID, { enabled: true }));
    return {
      status: 'up',
      latencyMs,
      details: { activeSchedules: schedules.length },
    };
  } catch (err) {
    // Scheduler requires MongoDB — gracefully degrade when unavailable
    const message = (err as Error).message;
    const isDbDown = message.includes('MongoDB not connected');
    return {
      status: isDbDown ? 'degraded' : 'down',
      details: { error: message },
    };
  }
}

function checkChannels(): ComponentHealth {
  try {
    const adapters = listAdapters();
    const sessionCount = getChannelSessionCount();
    const enabledCount = adapters.filter(a => a.enabled).length;

    return {
      status: adapters.length > 0 ? 'up' : 'degraded',
      details: {
        registeredAdapters: adapters.length,
        enabledAdapters: enabledCount,
        activeSessions: sessionCount,
      },
    };
  } catch (err) {
    return {
      status: 'down',
      details: { error: (err as Error).message },
    };
  }
}

function checkAgents(): ComponentHealth {
  try {
    const agentCount = getAgentCount();
    const skillCount = getSkillCount();

    return {
      status: agentCount > 0 ? 'up' : 'down',
      details: { agents: agentCount, skills: skillCount },
    };
  } catch (err) {
    return {
      status: 'down',
      details: { error: (err as Error).message },
    };
  }
}

async function checkMemory(): Promise<ComponentHealth> {
  try {
    const { result: vectorCount, latencyMs } = await timed(() => getVectorCount(DEFAULT_TENANT_ID));
    return {
      status: 'up',
      latencyMs,
      details: { totalVectors: vectorCount },
    };
  } catch (err) {
    return {
      status: 'down',
      details: { error: (err as Error).message },
    };
  }
}

// ── Main entry point ──────────────────────────────────────

/**
 * Run a comprehensive deep health check across all subsystems.
 *
 * Each probe is run in parallel for speed. The overall status is derived
 * from the individual checks:
 *   - `healthy`  — ALL checks are `up`
 *   - `degraded` — any check is `degraded` but none `down`
 *   - `unhealthy` — any critical check (mongodb, llm) is `down`
 */
export async function deepHealthCheck(startTime: number): Promise<HealthCheckResult> {
  const [mongodb, scheduler, memory] = await Promise.all([
    checkMongodb(),
    checkScheduler(),
    checkMemory(),
  ]);

  // Synchronous checks — no need to await
  const llm = checkLlm();
  const channels = checkChannels();
  const agents = checkAgents();

  const checks = { mongodb, llm, scheduler, channels, agents, memory };

  // Determine overall status
  const allChecks = Object.values(checks);
  const criticalChecks = [checks.mongodb, checks.llm];

  let status: HealthCheckResult['status'];
  if (criticalChecks.some(c => c.status === 'down')) {
    status = 'unhealthy';
  } else if (allChecks.some(c => c.status === 'down' || c.status === 'degraded')) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  return {
    status,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: getVersion(),
    checks,
    timestamp: new Date().toISOString(),
  };
}

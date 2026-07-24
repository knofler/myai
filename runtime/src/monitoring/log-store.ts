/**
 * Structured JSON request-log ring buffer for the gateway → runner → agent
 * call chain — the log-line counterpart to tracing/tracer.ts's span buffer.
 *
 * Same cross-process constraint tracer.ts documents applies here: the
 * gateway (this Node process), the runner (scripts/cli_task_runner.sh, a bash
 * process), and the agent (the headless `claude -p` process the runner fires)
 * never share memory. Threading is done by CORRELATION ID, not shared state:
 *   - every gateway HTTP request is stamped with a correlation id (incoming
 *     `x-correlation-id` header if the caller already has one — e.g. the
 *     runner threading a task's id through — otherwise a fresh one), echoed
 *     back on the response so the caller can log the same id;
 *   - the runner reports its own log lines via the `logs_record` MCP tool
 *     (mirrors `traces_record`), tagging them with the task id as the
 *     correlation id so a `correlationId` filter on `/logs` reconstructs the
 *     whole gateway→runner story for one task.
 *
 * Persistence: in-memory ring buffer, same tradeoff tracer.ts makes — this is
 * a single self-hosted gateway process with no external log aggregator wired
 * up, so the ring buffer + `/api/logs` + dashboard `/logs` viewer IS the log
 * backend for this deployment shape. Every entry is redacted (message +
 * attributes) at write time via shared/redact.ts, so a secret can never even
 * transiently exist in the buffer.
 */
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../shared/logger.js';
import { deepRedact, redactString } from '../shared/redact.js';

const log = createChildLogger({ module: 'log-store' });

export type LogService = 'gateway' | 'runner' | 'agent';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  /** Epoch ms. */
  ts: number;
  tenantId: string;
  correlationId: string;
  service: LogService;
  level: LogLevel;
  message: string;
  attributes: Record<string, unknown>;
}

export interface RawLogInput {
  tenantId: string;
  correlationId: string;
  service: LogService;
  level?: LogLevel;
  message: string;
  attributes?: Record<string, unknown>;
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  ts?: number;
}

/** Cap on in-memory entries — a ring buffer, not a durable store. */
export const MAX_LOG_ENTRIES = 5000;

let entries: LogEntry[] = [];

/** Test/ops helper: wipe the ring buffer. */
export function clearLogs(): void {
  entries = [];
}

export interface LogFilter {
  /** REQUIRED — fail-closed, same discipline as audit-log.ts's queryAuditEvents. */
  tenantId: string;
  correlationId?: string;
  service?: LogService;
  level?: LogLevel;
  /** Case-insensitive substring match against the (already-redacted) message. */
  q?: string;
  /** Only entries at/after this epoch-ms timestamp — the live-tail "since last poll" cursor. */
  since?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

/**
 * Record one log entry. Never throws — a logging bug must never break the
 * request/task it's observing. Returns null on invalid input or failure.
 */
export function recordLog(input: RawLogInput): LogEntry | null {
  try {
    if (!input.tenantId || !input.correlationId || !input.message) return null;
    const entry: LogEntry = {
      id: randomUUID(),
      ts: Number.isFinite(input.ts) ? (input.ts as number) : Date.now(),
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      service: input.service,
      level: input.level ?? 'info',
      message: redactString(input.message),
      attributes: input.attributes ? (deepRedact(input.attributes) as Record<string, unknown>) : {},
    };
    entries.push(entry);
    if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(entries.length - MAX_LOG_ENTRIES);
    return entry;
  } catch (err) {
    log.warn({ err }, 'Failed to record log entry');
    return null;
  }
}

/** Query the ring buffer (the /logs viewer's backend). Newest first, capped at `limit`. */
export function getLogs(filter: LogFilter): LogEntry[] {
  if (!filter?.tenantId) return [];
  let out = entries.filter((e) => e.tenantId === filter.tenantId);
  if (filter.correlationId) out = out.filter((e) => e.correlationId === filter.correlationId);
  if (filter.service) out = out.filter((e) => e.service === filter.service);
  if (filter.level) out = out.filter((e) => e.level === filter.level);
  if (filter.q) {
    const needle = filter.q.toLowerCase();
    out = out.filter((e) => e.message.toLowerCase().includes(needle));
  }
  if (typeof filter.since === 'number') out = out.filter((e) => e.ts >= (filter.since as number));
  out = [...out].sort((a, b) => b.ts - a.ts);
  const limit = Math.min(Math.max(Math.trunc(filter.limit || DEFAULT_LIMIT), 1), MAX_LIMIT);
  return out.slice(0, limit);
}

/** Distinct correlation ids for a tenant, most-recently-active first — powers the /logs filter dropdown. */
export function getCorrelationIds(tenantId: string): string[] {
  const lastSeen = new Map<string, number>();
  for (const e of entries) {
    if (e.tenantId !== tenantId) continue;
    const prev = lastSeen.get(e.correlationId) ?? 0;
    if (e.ts > prev) lastSeen.set(e.correlationId, e.ts);
  }
  return [...lastSeen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

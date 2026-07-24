/**
 * perf-metrics — gateway hot-path latency meter + slow-query log.
 *
 * Every MCP tool call is timed at the single `executeTool` chokepoint
 * (mcp/tools.ts) and fed here. The registry is in-process and bounded — no DB
 * write on the hot path, so metering NEVER adds latency to the call it measures
 * (the whole point of profiling the hot paths: tasks_claim, context_boot,
 * brain_delta). Two things are kept:
 *
 *   • per-tool latency samples in a bounded ring → p50 / p95 / p99 / max, and
 *   • a bounded slow-query log of the most recent calls over the slow threshold.
 *
 * Both are exposed via the `perf_stats` MCP tool and surfaced on the dashboard
 * /analytics "Gateway performance" card. Because state lives in the gateway
 * process it resets on restart — this is a live operational meter, not a
 * historical store (that is what budgetusages / continuitymetrics are for).
 */
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'perf-metrics' });

/** Latency (ms) at or above which a call is logged as a slow query. */
export const SLOW_QUERY_MS = (() => {
  const raw = Number(process.env.MYAI_SLOW_QUERY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
})();

/** Max latency samples retained per tool (nearest-rank percentiles over these). */
const MAX_SAMPLES_PER_TOOL = 500;
/** Max slow-query entries retained across all tools (most-recent-wins ring). */
const MAX_SLOW_LOG = 100;

interface ToolWindow {
  /** Ring of recent latency samples (ms). Bounded to MAX_SAMPLES_PER_TOOL. */
  samples: number[];
  /** Ring of recent error flags (1/0), pushed/evicted in lockstep with samples. */
  errSamples: number[];
  /** Lifetime totals (survive the ring eviction). */
  count: number;
  sum: number;
  max: number;
  slow: number; // calls at/over SLOW_QUERY_MS
  errors: number;
  lastMs: number;
}

export interface SlowQueryEntry {
  tool: string;
  ms: number;
  tenantId?: string;
  error: boolean;
  /** epoch ms — stamped by the caller (Date.now at record time). */
  at: number;
}

const windows = new Map<string, ToolWindow>();
const slowLog: SlowQueryEntry[] = [];

function windowFor(tool: string): ToolWindow {
  let w = windows.get(tool);
  if (!w) {
    w = { samples: [], errSamples: [], count: 0, sum: 0, max: 0, slow: 0, errors: 0, lastMs: 0 };
    windows.set(tool, w);
  }
  return w;
}

export interface RecordOpts {
  tenantId?: string;
  error?: boolean;
  /** Override the timestamp (tests). Defaults to Date.now(). */
  now?: number;
}

/**
 * Record one completed tool call. Never throws — a metering failure must not
 * bubble into the call it decorates.
 */
export function recordToolLatency(tool: string, ms: number, opts: RecordOpts = {}): void {
  try {
    if (!tool || !Number.isFinite(ms) || ms < 0) return;
    const w = windowFor(tool);
    w.count++;
    w.sum += ms;
    w.lastMs = ms;
    if (ms > w.max) w.max = ms;
    if (opts.error) w.errors++;
    w.samples.push(ms);
    w.errSamples.push(opts.error ? 1 : 0);
    if (w.samples.length > MAX_SAMPLES_PER_TOOL) w.samples.shift();
    if (w.errSamples.length > MAX_SAMPLES_PER_TOOL) w.errSamples.shift();

    if (ms >= SLOW_QUERY_MS) {
      w.slow++;
      slowLog.push({
        tool,
        ms: Math.round(ms),
        tenantId: opts.tenantId,
        error: !!opts.error,
        at: opts.now ?? Date.now(),
      });
      if (slowLog.length > MAX_SLOW_LOG) slowLog.shift();
      log.warn({ tool, ms: Math.round(ms), tenantId: opts.tenantId, error: !!opts.error }, 'slow gateway tool call');
    }
  } catch (err) {
    log.debug({ err, tool }, 'perf metric not recorded');
  }
}

/**
 * Nearest-rank percentile (0–100) over a numeric sample. Returns 0 for an empty
 * sample. Does not mutate the input.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Math.round(sorted[idx]);
}

export interface ToolPerf {
  tool: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  lastMs: number;
  slow: number;
  errors: number;
  /** Number of latency samples the percentiles were computed over. */
  samples: number;
  /**
   * Error rate (0–100) over the recent sample window (errSamples), NOT lifetime.
   * A route that errored early recovers as clean calls push the errors out of
   * the ring — this is what the SLO alerter evaluates so alerts self-clear.
   */
  windowErrorRatePct: number;
}

export interface PerfStats {
  slowQueryThresholdMs: number;
  /** Per-tool rollup, slowest p95 first. */
  tools: ToolPerf[];
  /** Aggregate across all tools. */
  overall: { count: number; avgMs: number; p95Ms: number; slow: number; errors: number };
  /** Most-recent slow calls first (bounded). */
  slowQueries: SlowQueryEntry[];
  /** Tools with the most slow-query hits, hottest first. */
  hotPaths: Array<{ tool: string; slow: number; p95Ms: number; count: number }>;
}

/**
 * Snapshot the live perf registry. Cheap and allocation-only — safe to call per
 * dashboard render.
 */
export function getPerfStats(): PerfStats {
  const tools: ToolPerf[] = [];
  const allSamples: number[] = [];
  let count = 0, sum = 0, slow = 0, errors = 0;

  for (const [tool, w] of windows) {
    count += w.count;
    sum += w.sum;
    slow += w.slow;
    errors += w.errors;
    for (const s of w.samples) allSamples.push(s);
    tools.push({
      tool,
      count: w.count,
      avgMs: w.count > 0 ? Math.round(w.sum / w.count) : 0,
      p50Ms: percentile(w.samples, 50),
      p95Ms: percentile(w.samples, 95),
      p99Ms: percentile(w.samples, 99),
      maxMs: Math.round(w.max),
      lastMs: Math.round(w.lastMs),
      slow: w.slow,
      errors: w.errors,
      samples: w.samples.length,
      windowErrorRatePct: w.errSamples.length > 0
        ? Math.round((w.errSamples.reduce((a, b) => a + b, 0) / w.errSamples.length) * 1000) / 10
        : 0,
    });
  }

  tools.sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count);

  const hotPaths = tools
    .filter((t) => t.slow > 0)
    .sort((a, b) => b.slow - a.slow || b.p95Ms - a.p95Ms)
    .slice(0, 10)
    .map((t) => ({ tool: t.tool, slow: t.slow, p95Ms: t.p95Ms, count: t.count }));

  return {
    slowQueryThresholdMs: SLOW_QUERY_MS,
    tools,
    overall: {
      count,
      avgMs: count > 0 ? Math.round(sum / count) : 0,
      p95Ms: percentile(allSamples, 95),
      slow,
      errors,
    },
    slowQueries: [...slowLog].reverse(),
    hotPaths,
  };
}

/** Reset the registry — test-only helper. */
export function _resetPerfMetrics(): void {
  windows.clear();
  slowLog.length = 0;
}

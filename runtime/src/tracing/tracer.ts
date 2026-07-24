/**
 * Distributed tracing for the gateway → runner → agent call chain.
 *
 * A task flows through three processes that never share memory:
 *   1. gateway  — this Node process (task-store.ts: claimTask/updateTask/failTask)
 *   2. runner   — scripts/cli_task_runner.sh, a bash process that claims the task
 *                 over HTTP (mcp tasks_claim) then shells out to a CLI session
 *   3. agent    — the headless `claude -p` process the runner fires
 *
 * There is no shared process, so context can't be propagated via
 * AsyncLocalStorage/zone-style mechanisms the way a single Node service would.
 * Instead every span is keyed by the task's `traceKey` (its taskId) and both
 * traceId and spanId are DERIVED deterministically (sha1-based) from
 * (traceKey) and (traceId, name) respectively — W3C Trace Context format
 * (32-hex traceId / 16-hex spanId, `toTraceparent` emits the standard
 * `00-{traceId}-{spanId}-{flags}` string). This means the runner (bash) and
 * the gateway (this module) independently compute IDENTICAL span/parent IDs
 * for the same (taskId, span name) pair without ever exchanging them — the
 * runner just reports {name, service, startMs, endMs, status} via the
 * `traces_record` MCP tool (see mcp/tools.ts) and this module does the ID math
 * and storage. No OTel collector/exporter is wired up (single self-hosted
 * gateway process); the in-memory ring buffer + `/traces` HTTP viewer below
 * IS the trace backend for this deployment shape.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'tracer' });

export type SpanService = 'gateway' | 'runner' | 'agent';
export type SpanStatus = 'ok' | 'error';

export interface RecordedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  service: SpanService;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  error?: string;
}

export interface RawSpanInput {
  /** Stable key all spans of one task-lifecycle trace share — the taskId. */
  traceKey: string;
  name: string;
  service: SpanService;
  startMs: number;
  endMs: number;
  status?: SpanStatus;
  attributes?: Record<string, unknown>;
  error?: string;
  /** Name of the parent span within the same trace, if any. */
  parentName?: string;
}

// ── W3C Trace Context ID derivation ─────────────────────────

/** 32 hex chars, deterministic per traceKey — so independent processes agree. */
export function traceIdFromKey(traceKey: string): string {
  return createHash('sha1').update(`traceId:${traceKey}`).digest('hex').slice(0, 32);
}

/** 16 hex chars, deterministic per (traceId, span name). */
export function spanIdFor(traceId: string, name: string): string {
  return createHash('sha1').update(`spanId:${traceId}:${name}`).digest('hex').slice(0, 16);
}

/** W3C traceparent header string: version-traceId-spanId-flags. */
export function toTraceparent(span: Pick<RecordedSpan, 'traceId' | 'spanId' | 'status'>): string {
  const flags = span.status === 'error' ? '00' : '01';
  return `00-${span.traceId}-${span.spanId}-${flags}`;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/** Parse a W3C traceparent string; returns null if malformed. */
export function parseTraceparent(value: string): { traceId: string; spanId: string; sampled: boolean } | null {
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return null;
  return { traceId: m[2].toLowerCase(), spanId: m[3].toLowerCase(), sampled: (parseInt(m[4], 16) & 1) === 1 };
}

// ── Ring buffer store ────────────────────────────────────────

/** Cap on in-memory spans — this is a single-process ring buffer, not a durable store. */
export const MAX_SPANS = 2000;

let spans: RecordedSpan[] = [];

/** Test/ops helper: wipe the ring buffer. */
export function clearSpans(): void {
  spans = [];
}

export interface SpanFilter {
  traceId?: string;
  traceKey?: string;
  service?: SpanService;
  limit?: number;
}

/** Query recorded spans, newest first. */
export function getSpans(filter: SpanFilter = {}): RecordedSpan[] {
  let out = spans;
  const wantTraceId = filter.traceId ?? (filter.traceKey ? traceIdFromKey(filter.traceKey) : undefined);
  if (wantTraceId) out = out.filter((s) => s.traceId === wantTraceId);
  if (filter.service) out = out.filter((s) => s.service === filter.service);
  out = [...out].sort((a, b) => b.startMs - a.startMs);
  return filter.limit ? out.slice(0, filter.limit) : out;
}

/** Distinct trace IDs currently in the buffer, most-recently-active first. */
export function getTraceIds(): string[] {
  const lastSeen = new Map<string, number>();
  for (const s of spans) {
    const prev = lastSeen.get(s.traceId) ?? 0;
    if (s.endMs > prev) lastSeen.set(s.traceId, s.endMs);
  }
  return [...lastSeen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Record one completed span. Never throws — a tracing bug must never break
 * the gateway/runner/agent call it's observing. Returns null on invalid input.
 */
export function recordSpan(input: RawSpanInput): RecordedSpan | null {
  try {
    if (!input.traceKey || !input.name) return null;
    const traceId = traceIdFromKey(input.traceKey);
    const spanId = spanIdFor(traceId, input.name);
    const parentSpanId = input.parentName ? spanIdFor(traceId, input.parentName) : undefined;
    const startMs = Number.isFinite(input.startMs) ? input.startMs : Date.now();
    const endMs = Number.isFinite(input.endMs) && input.endMs >= startMs ? input.endMs : startMs;
    const recorded: RecordedSpan = {
      traceId,
      spanId,
      parentSpanId,
      name: input.name,
      service: input.service,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      status: input.status ?? 'ok',
      attributes: input.attributes ?? {},
      error: input.error,
    };
    spans.push(recorded);
    if (spans.length > MAX_SPANS) spans = spans.slice(spans.length - MAX_SPANS);
    return recorded;
  } catch (err) {
    log.warn({ err }, 'Failed to record span');
    return null;
  }
}

// ── In-process span handle (for gateway-side TS call sites) ────

export interface SpanHandle {
  setAttribute(key: string, value: unknown): void;
  end(status?: SpanStatus, error?: string): RecordedSpan | null;
}

export interface StartSpanOptions {
  traceKey: string;
  name: string;
  service: SpanService;
  parentName?: string;
  attributes?: Record<string, unknown>;
  /** Injectable clock for deterministic tests. */
  nowMs?: () => number;
}

/** Start an in-process span; call `.end()` when the operation completes. */
export function startSpan(opts: StartSpanOptions): SpanHandle {
  const clock = opts.nowMs ?? Date.now;
  const startMs = clock();
  const attributes: Record<string, unknown> = { ...opts.attributes };
  let ended = false;
  return {
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
    },
    end(status: SpanStatus = 'ok', error?: string) {
      if (ended) return null;
      ended = true;
      return recordSpan({
        traceKey: opts.traceKey,
        name: opts.name,
        service: opts.service,
        parentName: opts.parentName,
        startMs,
        endMs: clock(),
        status,
        attributes,
        error,
      });
    },
  };
}

/**
 * Wrap an async operation in a span. Sets status:'error' + records the
 * exception message on throw, always ends the span, then rethrows.
 */
export async function withSpan<T>(opts: StartSpanOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
  const span = startSpan(opts);
  try {
    const result = await fn(span);
    span.end('ok');
    return result;
  } catch (err) {
    span.end('error', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Random 16-hex correlation token — used where no stable traceKey exists yet. */
export function randomSpanToken(): string {
  return randomBytes(8).toString('hex');
}

// ── Minimal trace viewer (self-contained HTML, no build step) ──

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SERVICE_COLOR: Record<SpanService, string> = {
  gateway: '#4f8cc9',
  runner: '#c98c4f',
  agent: '#7fb069',
};

/** Render one trace's spans as a simple indented timeline bar chart. */
function renderTraceRows(traceId: string): string {
  const traceSpans = getSpans({ traceId }).sort((a, b) => a.startMs - b.startMs);
  if (!traceSpans.length) return '<p><em>No spans.</em></p>';
  const min = Math.min(...traceSpans.map((s) => s.startMs));
  const max = Math.max(...traceSpans.map((s) => s.endMs));
  const span = Math.max(1, max - min);
  const rows = traceSpans.map((s) => {
    const left = ((s.startMs - min) / span) * 100;
    const width = Math.max(0.5, ((s.endMs - s.startMs) / span) * 100);
    const color = s.status === 'error' ? '#c94f4f' : SERVICE_COLOR[s.service];
    const depth = s.parentSpanId ? 1 : 0;
    return `
      <div class="row">
        <div class="label" style="padding-left:${depth * 16}px">
          <span class="dot" style="background:${color}"></span>
          ${escapeHtml(s.service)}.${escapeHtml(s.name)} <span class="dur">${s.durationMs}ms</span>
        </div>
        <div class="track"><div class="bar" style="left:${left}%;width:${width}%;background:${color}" title="${escapeHtml(JSON.stringify(s.attributes))}"></div></div>
      </div>`;
  }).join('\n');
  return `<div class="trace">${rows}</div>`;
}

/** Self-contained HTML page for the /traces viewer — no frontend build step. */
export function traceViewerHtml(): string {
  const traceIds = getTraceIds();
  const sections = traceIds.length
    ? traceIds.map((id) => {
        const traceSpans = getSpans({ traceId: id });
        const failed = traceSpans.some((s) => s.status === 'error');
        const taskId = (traceSpans[0]?.attributes?.taskId as string | undefined) ?? id;
        return `
          <section class="trace-block ${failed ? 'failed' : ''}">
            <h3>${escapeHtml(String(taskId))} <small>${escapeHtml(id)}</small></h3>
            ${renderTraceRows(id)}
          </section>`;
      }).join('\n')
    : '<p><em>No traces recorded yet.</em></p>';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>myai — traces</title>
<style>
  body { font: 13px/1.4 -apple-system, system-ui, sans-serif; background:#111; color:#eee; padding:24px; }
  h1 { font-size:16px; }
  .trace-block { margin-bottom:28px; border:1px solid #333; border-radius:6px; padding:12px; }
  .trace-block.failed { border-color:#c94f4f; }
  .trace-block h3 { margin:0 0 10px; font-size:13px; }
  .trace-block h3 small { color:#888; font-weight:normal; margin-left:8px; }
  .row { display:flex; align-items:center; margin:4px 0; }
  .label { width:320px; flex-shrink:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
  .dur { color:#999; margin-left:6px; }
  .track { position:relative; flex:1; height:14px; background:#1c1c1c; border-radius:3px; }
  .bar { position:absolute; top:0; height:14px; border-radius:3px; min-width:2px; }
</style></head>
<body>
  <h1>gateway → runner → agent traces</h1>
  ${sections}
</body></html>`;
}

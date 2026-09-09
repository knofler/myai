/**
 * OTLP/HTTP (JSON) span export — the bridge from the in-process ring buffer
 * (tracing/tracer.ts) to a real OpenTelemetry backend (Jaeger, Tempo,
 * Honeycomb, any OTLP collector).
 *
 * Deliberately zero-dependency: spans here are already completed records with
 * W3C-format IDs, so the full @opentelemetry/sdk machinery (context managers,
 * processors, samplers) buys nothing — we only need the OTLP JSON wire shape
 * and a best-effort batched POST. Gated by the STANDARD OTel env vars so any
 * collector docs apply verbatim:
 *
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  — full traces URL, used verbatim
 *   OTEL_EXPORTER_OTLP_ENDPOINT         — base URL, `/v1/traces` is appended
 *   OTEL_EXPORTER_OTLP_HEADERS          — `k=v,k2=v2` (e.g. Honeycomb team key)
 *
 * Neither endpoint var set → export is a no-op and the ring buffer + /traces
 * viewer remain the only backend (the default self-hosted shape). Export
 * failures are swallowed after a debug log — tracing must never break the
 * gateway call it observes.
 *
 * AIR_GAPPED=true hard-disables export even when an endpoint IS configured —
 * span export is exactly the "telemetry" class of phone-home that
 * core/license.ts's air-gapped promise forbids (same contract as
 * monitoring/sentry.ts honouring a stale SENTRY_DSN). The ring buffer and the
 * local /traces viewer keep working; only the outbound POST is suppressed.
 */
import { isAirGapped } from '../core/license.js';
import { createChildLogger } from '../shared/logger.js';
import type { RecordedSpan, SpanService } from './tracer.js';

const log = createChildLogger({ module: 'otlp-export' });

// ── OTLP JSON wire shapes (subset we emit) ───────────────────

interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string; boolValue?: boolean; intValue?: string; doubleValue?: number };
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
}

export interface OtlpExportPayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
  }>;
}

// OTLP enum values (opentelemetry-proto trace.proto)
const SPAN_KIND_INTERNAL = 1;
const STATUS_CODE_OK = 1;
const STATUS_CODE_ERROR = 2;
const SCOPE = { name: 'myai.tracer', version: '1' };

// ── Env resolution ───────────────────────────────────────────

type EnvLike = Record<string, string | undefined>;

/** Warn once per process (reset by setOtlpDepsForTest) when an operator has an
 *  OTLP endpoint configured that AIR_GAPPED is overriding — silence here would
 *  look like a broken collector instead of a deliberate guarantee. */
let warnedAirGappedOverride = false;

/** Resolve the traces endpoint URL from standard OTel env vars, or null when
 *  export is off. AIR_GAPPED=true always resolves to null — the no-phone-home
 *  promise beats any configured endpoint. */
export function otlpTracesEndpoint(env: EnvLike = process.env): string | null {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const configured = traces || (base ? `${base.replace(/\/+$/, '')}/v1/traces` : null);
  if (configured && isAirGapped(env as NodeJS.ProcessEnv)) {
    if (!warnedAirGappedOverride) {
      warnedAirGappedOverride = true;
      log.warn('OTLP endpoint is set but AIR_GAPPED=true — span export stays disabled (no phone-home in air-gapped mode)');
    }
    return null;
  }
  return configured;
}

/** Parse OTEL_EXPORTER_OTLP_HEADERS (`k=v,k2=v2`, values may be URL-encoded per spec). */
export function parseOtlpHeaders(env: EnvLike = process.env): Record<string, string> {
  const raw = env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value — a lone % must not kill header parsing
    }
    if (key) out[key] = value;
  }
  return out;
}

// ── RecordedSpan → OTLP conversion (pure, unit-testable) ─────

function toOtlpAttributes(attrs: Record<string, unknown>): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') out.push({ key, value: { boolValue: v } });
    else if (typeof v === 'number' && Number.isInteger(v)) out.push({ key, value: { intValue: String(v) } });
    else if (typeof v === 'number') out.push({ key, value: { doubleValue: v } });
    else if (typeof v === 'string') out.push({ key, value: { stringValue: v } });
    else out.push({ key, value: { stringValue: JSON.stringify(v) } });
  }
  return out;
}

/** Convert one recorded span to the OTLP JSON span shape (ms → unix nanos as strings). */
export function spanToOtlp(span: RecordedSpan): OtlpSpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: `${span.startMs}000000`,
    endTimeUnixNano: `${span.endMs}000000`,
    attributes: toOtlpAttributes(span.attributes),
    status: span.status === 'error'
      ? { code: STATUS_CODE_ERROR, ...(span.error ? { message: span.error } : {}) }
      : { code: STATUS_CODE_OK },
  };
}

/**
 * Build one OTLP export request body. Spans are grouped into one resource per
 * originating service so backends render gateway/runner/agent as three
 * services of a single distributed trace.
 */
export function toOtlpPayload(spans: RecordedSpan[]): OtlpExportPayload {
  const byService = new Map<SpanService, RecordedSpan[]>();
  for (const s of spans) {
    const bucket = byService.get(s.service);
    if (bucket) bucket.push(s);
    else byService.set(s.service, [s]);
  }
  return {
    resourceSpans: [...byService.entries()].map(([service, group]) => ({
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: `myai-${service}` } },
          { key: 'service.namespace', value: { stringValue: 'myai' } },
        ],
      },
      scopeSpans: [{ scope: SCOPE, spans: group.map(spanToOtlp) }],
    })),
  };
}

// ── Batched best-effort exporter ─────────────────────────────

/** Flush when the buffer reaches this many spans (a debounce timer flushes sooner). */
export const OTLP_BATCH_SIZE = 32;
const FLUSH_DEBOUNCE_MS = 2000;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;

interface OtlpDeps {
  fetch: FetchLike;
  env: EnvLike;
}

const defaultDeps: OtlpDeps = { fetch: (url, init) => fetch(url, init), env: process.env };
let deps: OtlpDeps = defaultDeps;

let buffer: RecordedSpan[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Test hook: swap fetch/env; pass nothing to restore defaults. Also clears state. */
export function setOtlpDepsForTest(override?: Partial<OtlpDeps>): void {
  deps = { ...defaultDeps, ...override };
  buffer = [];
  warnedAirGappedOverride = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/** Drain the buffer and POST one OTLP request. Never throws. */
export async function flushOtlpSpans(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!buffer.length) return;
  const endpoint = otlpTracesEndpoint(deps.env);
  const batch = buffer;
  buffer = [];
  if (!endpoint) return;
  try {
    await deps.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...parseOtlpHeaders(deps.env) },
      body: JSON.stringify(toOtlpPayload(batch)),
    });
  } catch (err) {
    // Best-effort by design: the batch is dropped, never retried — a down
    // collector must not grow memory or slow the gateway.
    log.debug({ err, endpoint, spans: batch.length }, 'OTLP export failed — batch dropped');
  }
}

/**
 * Queue a completed span for export. No-op unless an OTLP endpoint env var is
 * set. Called by tracer.recordSpan for every span (gateway-side TS spans and
 * runner/agent spans reported via traces_record alike). Never throws.
 */
export function enqueueOtlpSpan(span: RecordedSpan): void {
  try {
    if (!otlpTracesEndpoint(deps.env)) return;
    buffer.push(span);
    if (buffer.length >= OTLP_BATCH_SIZE) {
      void flushOtlpSpans();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => void flushOtlpSpans(), FLUSH_DEBOUNCE_MS);
      flushTimer.unref?.();
    }
  } catch (err) {
    log.debug({ err }, 'Failed to enqueue span for OTLP export');
  }
}

/** Test/introspection helper: spans currently awaiting export. */
export function pendingOtlpSpanCount(): number {
  return buffer.length;
}

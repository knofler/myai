/**
 * Phase 5f — Anthropic Message Batches API client.
 *
 * Anthropic charges 50% off both input AND output tokens for non-realtime
 * batch dispatches (SLA: complete within 24h, typically <1h). Prompt caching
 * still applies on TOP of the 50% — so a cached read in a batch is
 * 0.5 × 0.10 = 0.05× normal input price. Worth it for any workload that:
 *   - Is async/non-interactive (cron-driven, scheduled reports, bulk audits)
 *   - Has ≥2 items in a batch (fixed overhead per batch otherwise dwarfs)
 *   - Tolerates polling latency (~1–60s typical end-to-end for small batches)
 *
 * The only production caller wired today is `morning_sweep` — that workload
 * is the canonical fit (N briefs, same agent, fired once daily). Other async
 * dispatchers (`schedules_create kind=agent` with cron, future `bulk_audit`)
 * can opt in by routing through `runAnthropicBatch`.
 *
 * Lifecycle:
 *   1. submitBatch()  — POST /v1/messages/batches with N requests
 *   2. pollBatch()    — GET retrieve every 5–60s until processing_status='ended'
 *   3. fetchResults() — stream the JSONL result file, map custom_id → response
 *
 * Failure modes (return per-item error, not throw):
 *   - Individual request errored/expired/canceled: surfaced as { error: '...' }
 *   - Batch never created (network/auth): throws
 *   - Polling timeout: throws (caller decides fallback)
 *   - Single request: silently rejected; caller should bypass batch
 */

import type Anthropic from '@anthropic-ai/sdk';
import { getClient } from './anthropic.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'llm-anthropic-batch' });

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const POLL_INITIAL_MS = 5_000;
const POLL_MAX_MS = 60_000;
const POLL_BACKOFF = 1.5;
/** Hard ceiling on total polling duration. Anthropic SLA is 24h but morning_sweep
 *  can't wait that long; if we hit this we fall back to per-request dispatch. */
const POLL_TIMEOUT_MS = 30 * 60_000;

export interface BatchItem {
  /** Caller-supplied stable id (e.g. repo name) used to match results back. */
  customId: string;
  systemPrompt: string;
  message: string;
  maxTokens?: number;
  /** Phase 5d — same caching semantics as the non-batch path. Defaults true. */
  promptCacheEnabled?: boolean;
}

export interface BatchResultEntry {
  customId: string;
  content?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  error?: string;
}

export interface BatchOptions {
  /** Override the polling timeout. Useful in tests. */
  pollTimeoutMs?: number;
  /** Override the initial poll interval. Useful in tests (e.g. 10ms). */
  pollInitialMs?: number;
  /** Provider model id. Defaults to claude-sonnet-4. */
  model?: string;
}

/**
 * Dispatch N requests as a single Anthropic Message Batch.
 *
 * Returns one entry per input item in the same order. Failed items carry
 * `error`; successful items carry `content` + token counts.
 *
 * The caller is responsible for falling back to per-request dispatch if
 * this throws (typically: not enough items to be worth batching, or batch
 * polling timed out).
 */
export async function runAnthropicBatch(
  items: BatchItem[],
  opts: BatchOptions = {},
): Promise<BatchResultEntry[]> {
  const client = getClient();
  if (!client) {
    throw new Error('Anthropic client not initialized — set ANTHROPIC_API_KEY');
  }
  if (items.length === 0) return [];

  const model = opts.model ?? DEFAULT_MODEL;
  const pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const pollInitialMs = opts.pollInitialMs ?? POLL_INITIAL_MS;

  log.info({ count: items.length, model }, 'Submitting Anthropic batch');

  const batch = await submitBatch(client, items, model);
  log.info({ batchId: batch.id, requestCount: items.length }, 'Batch submitted');

  const ended = await pollBatch(client, batch.id, pollTimeoutMs, pollInitialMs);
  log.info({
    batchId: ended.id,
    succeeded: ended.request_counts.succeeded,
    errored: ended.request_counts.errored,
    canceled: ended.request_counts.canceled,
    expired: ended.request_counts.expired,
  }, 'Batch ended');

  const resultMap = await fetchResults(client, ended.id);

  return items.map(item => {
    const entry = resultMap.get(item.customId);
    if (!entry) {
      return { customId: item.customId, error: 'No result returned for this item' };
    }
    return entry;
  });
}

async function submitBatch(
  client: Anthropic,
  items: BatchItem[],
  model: string,
): Promise<Anthropic.Messages.Batches.MessageBatch> {
  const requests = items.map(item => buildBatchRequest(item, model));
  return await client.messages.batches.create({ requests });
}

function buildBatchRequest(
  item: BatchItem,
  model: string,
): Anthropic.Messages.Batches.BatchCreateParams.Request {
  const cacheEnabled = item.promptCacheEnabled !== false;
  // Mirror callAnthropic's caching shape: system as a content-block array with
  // ephemeral marker so identical-prefix calls in the batch (same agent system
  // prompt across N repos) get cache reads.
  const system = cacheEnabled
    ? ([{ type: 'text', text: item.systemPrompt, cache_control: { type: 'ephemeral' } }] as Anthropic.TextBlockParam[])
    : item.systemPrompt;

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: item.maxTokens ?? 4096,
    system,
    messages: [{ role: 'user', content: item.message }],
  };

  return { custom_id: item.customId, params };
}

async function pollBatch(
  client: Anthropic,
  batchId: string,
  timeoutMs: number,
  initialMs: number,
): Promise<Anthropic.Messages.Batches.MessageBatch> {
  const deadline = Date.now() + timeoutMs;
  let interval = initialMs;
  let lastStatus = '';

  while (Date.now() < deadline) {
    const batch = await client.messages.batches.retrieve(batchId);
    if (batch.processing_status !== lastStatus) {
      log.info({ batchId, status: batch.processing_status, counts: batch.request_counts }, 'Batch status changed');
      lastStatus = batch.processing_status;
    }
    if (batch.processing_status === 'ended') return batch;

    await sleep(interval);
    interval = Math.min(interval * POLL_BACKOFF, POLL_MAX_MS);
  }

  throw new Error(`Batch ${batchId} did not complete within ${timeoutMs}ms`);
}

async function fetchResults(
  client: Anthropic,
  batchId: string,
): Promise<Map<string, BatchResultEntry>> {
  const out = new Map<string, BatchResultEntry>();
  const stream = await client.messages.batches.results(batchId);

  for await (const entry of stream) {
    out.set(entry.custom_id, mapResult(entry));
  }
  return out;
}

function mapResult(
  entry: Anthropic.Messages.Batches.MessageBatchIndividualResponse,
): BatchResultEntry {
  const { custom_id, result } = entry;

  if (result.type === 'errored') {
    return { customId: custom_id, error: extractErrorMessage(result.error) };
  }
  if (result.type === 'canceled') {
    return { customId: custom_id, error: 'Request canceled' };
  }
  if (result.type === 'expired') {
    return { customId: custom_id, error: 'Request expired' };
  }

  // succeeded
  const msg = result.message;
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  const usage = msg.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  return {
    customId: custom_id,
    content: text,
    model: msg.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
  };
}

function extractErrorMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Unknown error';
  const e = err as { error?: { message?: string }; message?: string };
  return e.error?.message ?? e.message ?? 'Unknown error';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'llm-moonshot' });

// ── Kimi lane backends ─────────────────────────────────────
//
// The 'moonshot' provider mode is really the Kimi K2 lane — it can be served
// by two OpenAI-compatible backends:
//
//   moonshot   — Moonshot's own cloud API (paid; MOONSHOT_API_KEY)
//   openrouter — OpenRouter's hosted K2, including the free
//                `moonshotai/kimi-k2:free` slug (OPENROUTER_API_KEY)
//
// Direct Moonshot wins when both keys are configured (first-party paid lane
// is the more reliable one); OpenRouter activates only when it is the sole
// key, so the free lane is opt-in and never silently swaps a paid deployment.
// This replaces the 2026-07-24 manual operator recipe ("repoint the moonshot
// provider baseURL to openrouter") with first-class config.

// Moonshot cloud API (kimi-k2.6) — overridable via MOONSHOT_BASE_URL
const MOONSHOT_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
/** OpenRouter's free Kimi K2 slug — the point of the OpenRouter lane. */
const OPENROUTER_DEFAULT_MODEL = 'moonshotai/kimi-k2:free';

// Ollama local API (OpenAI-compatible)
const OLLAMA_DEFAULT_URL = 'http://localhost:11434/v1';

let moonshotApiKey: string | null = null;
let moonshotBaseUrl: string = MOONSHOT_DEFAULT_BASE_URL;
let openrouterApiKey: string | null = null;
let openrouterBaseUrl: string = OPENROUTER_DEFAULT_BASE_URL;
let openrouterModel: string = OPENROUTER_DEFAULT_MODEL;
let ollamaBaseUrl: string = OLLAMA_DEFAULT_URL;

export function initMoonshot(key: string, baseUrl?: string): void {
  moonshotApiKey = key;
  if (baseUrl) moonshotBaseUrl = baseUrl;
  log.info({ baseUrl: moonshotBaseUrl }, 'Moonshot API client initialized');
}

/**
 * Configure the OpenRouter backend for the Kimi lane (free K2 without a paid
 * Moonshot key). Off by default — initProvider() calls this only when
 * OPENROUTER_API_KEY is set. Direct Moonshot still wins when both are keyed.
 */
export function initOpenRouter(key: string, model?: string, baseUrl?: string): void {
  openrouterApiKey = key;
  if (model) openrouterModel = model;
  if (baseUrl) openrouterBaseUrl = baseUrl;
  log.info({ baseUrl: openrouterBaseUrl, model: openrouterModel }, 'OpenRouter (Kimi lane) client initialized');
}

export function initOllama(baseUrl?: string): void {
  if (baseUrl) ollamaBaseUrl = baseUrl;
  log.info({ baseUrl: ollamaBaseUrl }, 'Ollama client initialized');
}

export function isMoonshotConfigured(): boolean {
  return !!(moonshotApiKey || openrouterApiKey);
}

interface KimiBackend {
  backend: 'moonshot' | 'openrouter';
  baseUrl: string;
  apiKey: string;
  providerName: string;
  extraHeaders?: Record<string, string>;
}

function resolveKimiBackend(): KimiBackend {
  if (moonshotApiKey) {
    return { backend: 'moonshot', baseUrl: moonshotBaseUrl, apiKey: moonshotApiKey, providerName: 'Moonshot' };
  }
  if (openrouterApiKey) {
    return {
      backend: 'openrouter',
      baseUrl: openrouterBaseUrl,
      apiKey: openrouterApiKey,
      providerName: 'OpenRouter',
      // OpenRouter's recommended attribution headers — auth itself stays
      // plain `Authorization: Bearer <key>` like every other backend here.
      extraHeaders: {
        'HTTP-Referer': 'https://github.com/knofler/myai',
        'X-Title': 'myai gateway',
      },
    };
  }
  throw new Error('Moonshot client not initialized — set MOONSHOT_API_KEY (or OPENROUTER_API_KEY for the free OpenRouter K2 lane)');
}

/**
 * Map the requested model onto the OpenRouter backend. OpenRouter slugs are
 * always `vendor/model[:variant]`; a requested model without a '/' (e.g. the
 * tier/config default 'kimi-k2.6') is Moonshot-native and is substituted with
 * the configured OpenRouter slug instead of 404ing upstream.
 */
function resolveKimiModel(backend: KimiBackend, requested?: string): string | undefined {
  if (backend.backend !== 'openrouter') return requested;
  if (!requested || !requested.includes('/')) return openrouterModel;
  return requested;
}

/** Introspection for dashboards/tests — which backend serves the Kimi lane. */
export function getKimiLane(): { backend: 'moonshot' | 'openrouter' | 'none'; baseUrl: string | null; model: string | null } {
  if (moonshotApiKey) return { backend: 'moonshot', baseUrl: moonshotBaseUrl, model: null };
  if (openrouterApiKey) return { backend: 'openrouter', baseUrl: openrouterBaseUrl, model: openrouterModel };
  return { backend: 'none', baseUrl: null, model: null };
}

/** Test-only: module-level backend state persists across suites — reset it. */
export function resetKimiLaneForTests(): void {
  moonshotApiKey = null;
  moonshotBaseUrl = MOONSHOT_DEFAULT_BASE_URL;
  openrouterApiKey = null;
  openrouterBaseUrl = OPENROUTER_DEFAULT_BASE_URL;
  openrouterModel = OPENROUTER_DEFAULT_MODEL;
}

export interface MoonshotRequest {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  maxTokens?: number;
}

export interface MoonshotResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
}

/**
 * Call the Kimi lane (OpenAI-compatible) — direct Moonshot cloud, or
 * OpenRouter's hosted K2 when only OPENROUTER_API_KEY is configured.
 */
export async function callMoonshot(req: MoonshotRequest): Promise<MoonshotResponse> {
  const backend = resolveKimiBackend();
  return callOpenAICompatible({
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    extraHeaders: backend.extraHeaders,
    req: { ...req, model: resolveKimiModel(backend, req.model) },
    providerName: backend.providerName,
  });
}

/**
 * Call Ollama local API (OpenAI-compatible).
 * No API key needed — Ollama runs locally.
 */
export async function callOllama(req: MoonshotRequest): Promise<MoonshotResponse> {
  return callOpenAICompatible({
    baseUrl: ollamaBaseUrl,
    req,
    providerName: 'Ollama',
  });
}

/**
 * Stream the Kimi lane response via SSE — direct Moonshot cloud, or
 * OpenRouter's hosted K2 when only OPENROUTER_API_KEY is configured.
 */
export async function* callMoonshotStream(req: MoonshotRequest): AsyncGenerator<string, MoonshotResponse> {
  const backend = resolveKimiBackend();
  return yield* callOpenAICompatibleStream({
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    extraHeaders: backend.extraHeaders,
    req: { ...req, model: resolveKimiModel(backend, req.model) },
    providerName: backend.providerName,
  });
}

/**
 * Stream Ollama local API response via SSE.
 */
export async function* callOllamaStream(req: MoonshotRequest): AsyncGenerator<string, MoonshotResponse> {
  return yield* callOpenAICompatibleStream({
    baseUrl: ollamaBaseUrl,
    req,
    providerName: 'Ollama',
  });
}

// ── Generic OpenAI-compatible helpers ────────────────────

/**
 * HTTP error from an OpenAI-compatible backend, carrying the status code as
 * a typed field so the resilience layer (retry on 429/5xx) and the provider
 * chain's isRetryableError classify it without regexing the message. 429s —
 * how OpenRouter surfaces its free-tier per-minute/per-day limits — also
 * carry the parsed Retry-After hint.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(providerName: string, status: number, body: string, retryAfterMs?: number) {
    const detail = body.length > 600 ? `${body.slice(0, 600)}…` : body;
    super(`${providerName} API ${status}${status === 429 ? ' (rate-limited)' : ''}: ${detail}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function toHttpError(providerName: string, res: Response, body: string): ProviderHttpError {
  let retryAfterMs: number | undefined;
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
    else {
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) retryAfterMs = Math.max(0, at - Date.now());
    }
  }
  return new ProviderHttpError(providerName, res.status, body, retryAfterMs);
}

interface CallOpts {
  baseUrl: string;
  apiKey?: string;
  /** Backend-specific headers (e.g. OpenRouter attribution) — merged after the defaults. */
  extraHeaders?: Record<string, string>;
  req: MoonshotRequest;
  providerName: string;
}

async function callOpenAICompatible(opts: CallOpts): Promise<MoonshotResponse> {
  const { baseUrl, apiKey, extraHeaders, req, providerName } = opts;
  const model = req.model || 'kimi-k2.6:cloud';
  const maxTokens = req.maxTokens || 4096;

  const messages = [
    { role: 'system', content: req.systemPrompt },
    ...req.messages,
  ];

  log.info({
    provider: providerName,
    model,
    messageCount: req.messages.length,
    systemLength: req.systemPrompt.length,
  }, `Calling ${providerName} API`);

  const start = Date.now();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw toHttpError(providerName, res, errorBody);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  const elapsed = Date.now() - start;
  const choice = data.choices[0];

  log.info({
    provider: providerName,
    model: data.model,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    finishReason: choice?.finish_reason,
    elapsed,
  }, `${providerName} API response received`);

  return {
    content: choice?.message?.content || '',
    model: data.model,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    finishReason: choice?.finish_reason || null,
  };
}

async function* callOpenAICompatibleStream(opts: CallOpts): AsyncGenerator<string, MoonshotResponse> {
  const { baseUrl, apiKey, extraHeaders, req, providerName } = opts;
  const model = req.model || 'kimi-k2.6:cloud';
  const maxTokens = req.maxTokens || 4096;

  const messages = [
    { role: 'system', content: req.systemPrompt },
    ...req.messages,
  ];

  log.info({ provider: providerName, model, messageCount: req.messages.length }, `Calling ${providerName} API (streaming)`);
  const start = Date.now();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw toHttpError(providerName, res, errorBody);
  }

  let fullContent = '';
  let finalModel = model;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body for streaming');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data) as {
          choices: Array<{ delta: { content?: string }; finish_reason?: string }>;
          model?: string;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };

        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          yield delta;
        }

        if (parsed.choices?.[0]?.finish_reason) {
          finishReason = parsed.choices[0].finish_reason;
        }
        if (parsed.model) finalModel = parsed.model;
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens;
          outputTokens = parsed.usage.completion_tokens;
        }
      } catch { /* skip malformed SSE lines */ }
    }
  }

  const elapsed = Date.now() - start;
  log.info({ provider: providerName, model: finalModel, inputTokens, outputTokens, finishReason, elapsed }, `${providerName} stream complete`);

  return {
    content: fullContent,
    model: finalModel,
    inputTokens,
    outputTokens,
    finishReason,
  };
}

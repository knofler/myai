import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'llm-moonshot' });

// Moonshot cloud API (kimi-k2.6)
const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';

// Ollama local API (OpenAI-compatible)
const OLLAMA_DEFAULT_URL = 'http://localhost:11434/v1';

let moonshotApiKey: string | null = null;
let ollamaBaseUrl: string = OLLAMA_DEFAULT_URL;

export function initMoonshot(key: string): void {
  moonshotApiKey = key;
  log.info('Moonshot API client initialized');
}

export function initOllama(baseUrl?: string): void {
  if (baseUrl) ollamaBaseUrl = baseUrl;
  log.info({ baseUrl: ollamaBaseUrl }, 'Ollama client initialized');
}

export function isMoonshotConfigured(): boolean {
  return !!moonshotApiKey;
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
 * Call Moonshot/Kimi cloud API (OpenAI-compatible).
 */
export async function callMoonshot(req: MoonshotRequest): Promise<MoonshotResponse> {
  if (!moonshotApiKey) {
    throw new Error('Moonshot client not initialized — set MOONSHOT_API_KEY');
  }

  return callOpenAICompatible({
    baseUrl: MOONSHOT_BASE_URL,
    apiKey: moonshotApiKey,
    req,
    providerName: 'Moonshot',
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
 * Stream Moonshot/Kimi cloud API response via SSE.
 */
export async function* callMoonshotStream(req: MoonshotRequest): AsyncGenerator<string, MoonshotResponse> {
  if (!moonshotApiKey) {
    throw new Error('Moonshot client not initialized — set MOONSHOT_API_KEY');
  }

  return yield* callOpenAICompatibleStream({
    baseUrl: MOONSHOT_BASE_URL,
    apiKey: moonshotApiKey,
    req,
    providerName: 'Moonshot',
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

interface CallOpts {
  baseUrl: string;
  apiKey?: string;
  req: MoonshotRequest;
  providerName: string;
}

async function callOpenAICompatible(opts: CallOpts): Promise<MoonshotResponse> {
  const { baseUrl, apiKey, req, providerName } = opts;
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
    throw new Error(`${providerName} API ${res.status}: ${errorBody}`);
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
  const { baseUrl, apiKey, req, providerName } = opts;
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
    throw new Error(`${providerName} API ${res.status}: ${errorBody}`);
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

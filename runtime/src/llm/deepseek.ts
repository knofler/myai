import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'llm-deepseek' });

const BASE_URL = 'https://api.deepseek.com';

let apiKey: string | null = null;

export function initDeepSeek(key: string): void {
  apiKey = key;
  log.info('DeepSeek API client initialized');
}

export function isDeepSeekConfigured(): boolean {
  return !!apiKey;
}

export interface DeepSeekRequest {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  maxTokens?: number;
}

export interface DeepSeekResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
}

/**
 * Call DeepSeek Chat API (OpenAI-compatible).
 * No SDK needed — just fetch.
 */
export async function callDeepSeek(req: DeepSeekRequest): Promise<DeepSeekResponse> {
  if (!apiKey) {
    throw new Error('DeepSeek client not initialized — set DEEPSEEK_API_KEY');
  }

  const model = req.model || 'deepseek-chat';
  const maxTokens = req.maxTokens || 4096;

  const messages = [
    { role: 'system', content: req.systemPrompt },
    ...req.messages,
  ];

  log.info({
    model,
    messageCount: req.messages.length,
    systemLength: req.systemPrompt.length,
  }, 'Calling DeepSeek API');

  const start = Date.now();

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${errorBody}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  const elapsed = Date.now() - start;
  const choice = data.choices[0];

  log.info({
    model: data.model,
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
    finishReason: choice?.finish_reason,
    elapsed,
  }, 'DeepSeek API response received');

  log.info({ responsePreview: (choice?.message?.content || '').slice(0, 500) }, 'DeepSeek response content');

  return {
    content: choice?.message?.content || '',
    model: data.model,
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
    finishReason: choice?.finish_reason || null,
  };
}

/**
 * Stream DeepSeek Chat API response via SSE.
 * Yields content deltas as they arrive.
 */
export async function* callDeepSeekStream(req: DeepSeekRequest): AsyncGenerator<string, DeepSeekResponse> {
  if (!apiKey) {
    throw new Error('DeepSeek client not initialized — set DEEPSEEK_API_KEY');
  }

  const model = req.model || 'deepseek-chat';
  const maxTokens = req.maxTokens || 4096;

  const messages = [
    { role: 'system', content: req.systemPrompt },
    ...req.messages,
  ];

  log.info({ model, messageCount: req.messages.length }, 'Calling DeepSeek API (streaming)');
  const start = Date.now();

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${errorBody}`);
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
  log.info({ model: finalModel, inputTokens, outputTokens, finishReason, elapsed }, 'DeepSeek stream complete');

  return {
    content: fullContent,
    model: finalModel,
    inputTokens,
    outputTokens,
    finishReason,
  };
}

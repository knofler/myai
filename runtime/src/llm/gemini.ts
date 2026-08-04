import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'llm-gemini' });

// Gemini / AI Studio REST API (Class-B free-tier gateway provider).
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

let geminiApiKey: string | null = null;

export function initGemini(key: string): void {
  geminiApiKey = key;
  log.info('Gemini API client initialized');
}

export function isGeminiConfigured(): boolean {
  return !!geminiApiKey;
}

export interface GeminiRequest {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  maxTokens?: number;
}

export interface GeminiResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }>; role?: string };
  finishReason?: string;
}

interface GeminiApiResponse {
  candidates?: GeminiCandidate[];
  modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Gemini's `contents` array uses 'user' / 'model' roles (not OpenAI's
 * 'user' / 'assistant'), and the system prompt is a separate top-level
 * `systemInstruction` field rather than a leading message.
 */
function toGeminiContents(messages: GeminiRequest['messages']): GeminiContent[] {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

function extractText(candidate: GeminiCandidate | undefined): string {
  return candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
}

/**
 * Call Gemini via the AI Studio / Generative Language REST API.
 */
export async function callGemini(req: GeminiRequest): Promise<GeminiResponse> {
  if (!geminiApiKey) {
    throw new Error('Gemini client not initialized — set GEMINI_API_KEY');
  }

  const model = req.model || 'gemini-2.0-flash';
  const maxTokens = req.maxTokens || 4096;

  log.info({
    model,
    messageCount: req.messages.length,
    systemLength: req.systemPrompt.length,
  }, 'Calling Gemini API');

  const start = Date.now();

  const res = await fetch(`${GEMINI_BASE_URL}/${model}:generateContent?key=${geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: toGeminiContents(req.messages),
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errorBody}`);
  }

  const data = await res.json() as GeminiApiResponse;
  const elapsed = Date.now() - start;
  const candidate = data.candidates?.[0];
  const content = extractText(candidate);

  log.info({
    model: data.modelVersion || model,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    finishReason: candidate?.finishReason,
    elapsed,
  }, 'Gemini API response received');

  return {
    content,
    model: data.modelVersion || model,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    finishReason: candidate?.finishReason ?? null,
  };
}

/**
 * Stream Gemini API response via SSE (`streamGenerateContent?alt=sse`).
 */
export async function* callGeminiStream(req: GeminiRequest): AsyncGenerator<string, GeminiResponse> {
  if (!geminiApiKey) {
    throw new Error('Gemini client not initialized — set GEMINI_API_KEY');
  }

  const model = req.model || 'gemini-2.0-flash';
  const maxTokens = req.maxTokens || 4096;

  log.info({ model, messageCount: req.messages.length }, 'Calling Gemini API (streaming)');
  const start = Date.now();

  const res = await fetch(`${GEMINI_BASE_URL}/${model}:streamGenerateContent?alt=sse&key=${geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: toGeminiContents(req.messages),
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errorBody}`);
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
      if (!data) continue;

      try {
        const parsed = JSON.parse(data) as GeminiApiResponse;
        const candidate = parsed.candidates?.[0];
        const delta = extractText(candidate);
        if (delta) {
          fullContent += delta;
          yield delta;
        }

        if (candidate?.finishReason) finishReason = candidate.finishReason;
        if (parsed.modelVersion) finalModel = parsed.modelVersion;
        if (parsed.usageMetadata) {
          inputTokens = parsed.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = parsed.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      } catch { /* skip malformed SSE lines */ }
    }
  }

  const elapsed = Date.now() - start;
  log.info({ model: finalModel, inputTokens, outputTokens, finishReason, elapsed }, 'Gemini stream complete');

  return {
    content: fullContent,
    model: finalModel,
    inputTokens,
    outputTokens,
    finishReason,
  };
}

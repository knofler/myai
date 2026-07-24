import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'embeddings' });

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// ── Local Embeddings (no API key needed) ────────────────

class LocalEmbeddingProvider implements EmbeddingProvider {
  name = 'local';
  dimensions: number;
  private pipeline: unknown = null;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    const result = await (pipe as CallableFunction)(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data as Float32Array);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  private async getPipeline(): Promise<unknown> {
    if (this.pipeline) return this.pipeline;

    try {
      // Dynamic import — @xenova/transformers
      const mod = await import('@xenova/transformers');
      this.pipeline = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      log.info('Local embedding model loaded (all-MiniLM-L6-v2)');
      return this.pipeline;
    } catch (err) {
      log.error({ err }, 'Failed to load local embedding model — falling back to hash-based embeddings');
      // Fallback: deterministic hash-based pseudo-embeddings (not semantic, but works for testing)
      this.pipeline = async (text: string) => {
        const dims = this.dimensions;
        const values = new Float32Array(dims);
        for (let i = 0; i < text.length && i < dims; i++) {
          values[i % dims] += text.charCodeAt(i) / 128;
        }
        // Normalize
        const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
        for (let i = 0; i < dims; i++) values[i] /= norm;
        return { data: values };
      };
      return this.pipeline;
    }
  }
}

// ── OpenAI Embeddings ───────────────────────────────────

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai';
  dimensions: number;
  private apiKey: string;
  private model: string;

  constructor(dimensions: number, model: string) {
    this.dimensions = dimensions;
    this.apiKey = process.env.OPENAI_API_KEY || '';
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY not set');

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });

    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status}`);

    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map(d => d.embedding);
  }
}

// ── Factory ─────────────────────────────────────────────

let _provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (_provider) return _provider;

  const config = getConfig();
  const { provider, model, dimensions } = config.memory.embedding;

  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    _provider = new OpenAIEmbeddingProvider(dimensions, model || 'text-embedding-3-small');
    log.info({ provider: 'openai', model }, 'Using OpenAI embeddings');
  } else {
    _provider = new LocalEmbeddingProvider(dimensions);
    log.info({ provider: 'local', dimensions }, 'Using local embeddings');
  }

  return _provider;
}

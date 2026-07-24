import { AIPatternModel, isConnected } from '../shared/db.js';
import { getConfig } from '../shared/config.js';
import { getEmbeddingProvider } from './embeddings.js';
import { createChildLogger } from '../shared/logger.js';
import type { IAIPattern } from '../shared/db.js';

const log = createChildLogger({ module: 'memory-search' });

export interface SearchResult {
  patternId: string;
  title: string;
  tags: string[];
  category: string;
  confidence: number;
  usageCount: number;
  score: number;
  scoreBreakdown: {
    vector: number;
    tagOverlap: number;
    confidence: number;
    recency: number;
  };
}

/**
 * Hybrid search: vector similarity + tag overlap + confidence + recency.
 */
export async function hybridSearch(
  query: string,
  tags: string[] = [],
  topN?: number,
): Promise<SearchResult[]> {
  const config = getConfig();
  const n = topN ?? config.memory.search.topN;
  const weights = config.memory.search.weights;

  if (!isConnected()) {
    log.warn('MongoDB not connected — cannot search patterns');
    return [];
  }

  // Get all patterns with embeddings
  const patterns = await AIPatternModel.find({}).select('+embedding').lean<IAIPattern[]>();

  if (patterns.length === 0) return [];

  // Compute query embedding
  const provider = getEmbeddingProvider();
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await provider.embed(query);
  } catch (err) {
    log.warn({ err }, 'Embedding failed — falling back to tag-only search');
  }

  const now = Date.now();
  const queryTagsLower = tags.map(t => t.toLowerCase());

  const scored: SearchResult[] = patterns.map(p => {
    // Vector similarity
    let vectorScore = 0;
    if (queryEmbedding && p.embedding && p.embedding.length > 0) {
      vectorScore = cosineSimilarity(queryEmbedding, p.embedding);
    }

    // Tag overlap
    let tagScore = 0;
    if (queryTagsLower.length > 0 && p.tags.length > 0) {
      const patternTagsLower = p.tags.map(t => t.toLowerCase());
      const overlap = queryTagsLower.filter(t => patternTagsLower.includes(t)).length;
      tagScore = overlap / Math.max(queryTagsLower.length, 1);
    }

    // Confidence (normalized 0-1, already is)
    const confidenceScore = p.confidence;

    // Recency: decays over 30 days
    const daysSinceUse = (now - new Date(p.lastUsed).getTime()) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - daysSinceUse / 30);

    // Weighted score
    const score =
      weights.vector * vectorScore +
      weights.tagOverlap * tagScore +
      weights.confidence * confidenceScore +
      weights.recency * recencyScore;

    return {
      patternId: p.patternId,
      title: p.title,
      tags: p.tags,
      category: p.category,
      confidence: p.confidence,
      usageCount: p.usageCount,
      score,
      scoreBreakdown: {
        vector: vectorScore,
        tagOverlap: tagScore,
        confidence: confidenceScore,
        recency: recencyScore,
      },
    };
  });

  // Sort by score descending, return top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}

/**
 * Tag-only search (no embeddings needed).
 */
export async function searchByTags(tags: string[], topN?: number): Promise<SearchResult[]> {
  return hybridSearch('', tags, topN);
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

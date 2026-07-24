import { hybridSearch } from './search.js';
import { createChildLogger } from '../shared/logger.js';
import type { SearchResult } from './search.js';

const log = createChildLogger({ module: 'context-builder' });

export interface ContextBlock {
  patterns: SearchResult[];
  text: string;
  tokenEstimate: number;
}

/**
 * Build an LLM-ready context block from the most relevant SONA patterns.
 */
export async function buildContext(
  query: string,
  tags: string[] = [],
  maxTokens: number = 2000,
): Promise<ContextBlock> {
  const results = await hybridSearch(query, tags, 10);

  if (results.length === 0) {
    return { patterns: [], text: '', tokenEstimate: 0 };
  }

  // Build text block within token budget (~4 chars per token)
  const maxChars = maxTokens * 4;
  const lines: string[] = ['=== SONA Context (relevant patterns) ===', ''];
  let charCount = lines[0].length;
  const included: SearchResult[] = [];

  for (const r of results) {
    const line = `### ${r.title} [confidence: ${r.confidence.toFixed(2)}, score: ${r.score.toFixed(3)}, used: ${r.usageCount}x]\nTags: ${r.tags.join(', ')}\n`;

    if (charCount + line.length > maxChars) break;

    lines.push(line);
    charCount += line.length;
    included.push(r);
  }

  lines.push('=== End SONA Context ===');
  const text = lines.join('\n');

  log.debug({ query, matched: included.length, tokenEstimate: Math.ceil(text.length / 4) }, 'Context built');

  return {
    patterns: included,
    text,
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

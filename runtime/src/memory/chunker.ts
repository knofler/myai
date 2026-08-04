import { createChildLogger } from '../shared/logger.js';
import type { IVector } from '../shared/db.js';

const log = createChildLogger({ module: 'chunker' });

export interface Chunk {
  content: string;
  source: IVector['source'];
  tags: string[];
  metadata: Record<string, unknown>;
}

/**
 * Chunk STATE.md by H2/H3 sections. Each section becomes one vector.
 */
export function chunkStateFile(content: string): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = content.split('\n');

  let currentSection = '';
  let currentContent: string[] = [];
  let sectionDepth = 0;

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)/);
    const h3Match = line.match(/^### (.+)/);

    if (h2Match || h3Match) {
      // Flush previous section
      if (currentSection && currentContent.length > 0) {
        const text = currentContent.join('\n').trim();
        if (text.length > 20) {
          chunks.push({
            content: `## ${currentSection}\n${text}`,
            source: 'state',
            tags: extractTags(text),
            metadata: { section: currentSection, depth: sectionDepth },
          });
        }
      }

      currentSection = (h2Match ? h2Match[1] : h3Match![1]).trim();
      sectionDepth = h2Match ? 2 : 3;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Flush last section
  if (currentSection && currentContent.length > 0) {
    const text = currentContent.join('\n').trim();
    if (text.length > 20) {
      chunks.push({
        content: `## ${currentSection}\n${text}`,
        source: 'state',
        tags: extractTags(text),
        metadata: { section: currentSection, depth: sectionDepth },
      });
    }
  }

  log.debug({ sections: chunks.length }, 'STATE.md chunked');
  return chunks;
}

/**
 * Chunk AI_AGENT_HANDOFF.md by session blocks.
 */
export function chunkHandoffFile(content: string): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = content.split('\n');

  let currentBlock = '';
  let blockLines: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)/);

    if (h2Match) {
      // Flush previous block
      if (currentBlock && blockLines.length > 0) {
        const text = blockLines.join('\n').trim();
        if (text.length > 20) {
          chunks.push({
            content: `## ${currentBlock}\n${text}`,
            source: 'handoff',
            tags: extractTags(text),
            metadata: { block: currentBlock },
          });
        }
      }

      currentBlock = h2Match[1].trim();
      blockLines = [];
    } else {
      blockLines.push(line);
    }
  }

  // Flush last block
  if (currentBlock && blockLines.length > 0) {
    const text = blockLines.join('\n').trim();
    if (text.length > 20) {
      chunks.push({
        content: `## ${currentBlock}\n${text}`,
        source: 'handoff',
        tags: extractTags(text),
        metadata: { block: currentBlock },
      });
    }
  }

  log.debug({ blocks: chunks.length }, 'Handoff chunked');
  return chunks;
}

/**
 * Chunk a rotated archive file (state/archive/*.md) by `### Session:` blocks.
 * Each session block becomes one chunk so retrieval ranks at session granularity.
 */
export function chunkArchiveFile(content: string, sourceFile: string): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = content.split('\n');

  let currentHeader = '';
  let blockLines: string[] = [];

  const flush = () => {
    if (!currentHeader || blockLines.length === 0) return;
    const text = blockLines.join('\n').trim();
    if (text.length < 20) return;
    const dateMatch = currentHeader.match(/(\d{4}-\d{2}-\d{2})/);
    chunks.push({
      content: `### ${currentHeader}\n${text}`,
      source: 'archive',
      tags: extractTags(currentHeader + ' ' + text),
      metadata: {
        sessionHeader: currentHeader,
        sessionDate: dateMatch ? dateMatch[1] : undefined,
        sourceFile,
      },
    });
  };

  for (const line of lines) {
    const h3Match = line.match(/^### Session: (.+)/);
    if (h3Match) {
      flush();
      currentHeader = `Session: ${h3Match[1].trim()}`;
      blockLines = [];
    } else if (currentHeader) {
      blockLines.push(line);
    }
  }
  flush();

  log.debug({ sourceFile, sessions: chunks.length }, 'Archive file chunked');
  return chunks;
}

/**
 * Chunk a brain session atom (repos/<ns>/sessions/*.md in the brain git store)
 * into a single vector. One atom = one chunk — atoms are already compact
 * (~300 tokens, per the wrap-up brain_commit contract). `metadata.sessionDate`
 * (derived from the `written:` frontmatter timestamp) is the cross-source
 * dedup key against the later archive-rotation embedding of the same session
 * (see chunkArchiveFile's `sessionDate`) — indexBrainAtoms/indexArchiveFiles
 * use it to avoid double-embedding one session from both the brain atom and
 * its eventual STATE.md archive block.
 */
export function chunkBrainAtom(raw: string, file: string): Chunk | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!fmMatch) return null;
  const [, frontmatter, rest] = fmMatch;
  const body = rest.trim();
  if (body.length < 20) return null;

  const field = (key: string) => frontmatter.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1]?.trim();
  const slug = field('slug') || file.replace(/\.md$/, '');
  const topic = field('topic') || 'general';
  const written = field('written');
  const host = field('host');
  const sessionDate = written && /^\d{8}T/.test(written)
    ? `${written.slice(0, 4)}-${written.slice(4, 6)}-${written.slice(6, 8)}`
    : undefined;

  return {
    content: `### Session atom: ${slug}\n${body}`,
    source: 'brain',
    tags: extractTags(body),
    metadata: { slug, topic, written, host, sessionDate, atomFile: file },
  };
}

/**
 * Chunk a git commit message into a single vector.
 */
export function chunkCommit(message: string, sha: string): Chunk {
  return {
    content: message,
    source: 'commit',
    tags: extractTags(message),
    metadata: { sha },
  };
}

/**
 * Chunk a PR description into a single vector.
 */
export function chunkPR(title: string, body: string, prNumber: number): Chunk {
  const content = `PR #${prNumber}: ${title}\n\n${body}`;
  return {
    content,
    source: 'pr',
    tags: extractTags(content),
    metadata: { prNumber, title },
  };
}

/**
 * Extract tags from text — looks for common tech keywords.
 */
function extractTags(text: string): string[] {
  const lower = text.toLowerCase();
  const tagPool = [
    'docker', 'mongodb', 'mongoose', 'express', 'next.js', 'react', 'typescript',
    'telegram', 'discord', 'mcp', 'rag', 'vector', 'embedding', 'auth', 'jwt',
    'api', 'webhook', 'ci/cd', 'github', 'vercel', 'render', 'test', 'bug',
    'feature', 'security', 'performance', 'migration', 'sona', 'pattern',
    'dashboard', 'gateway', 'hook', 'session', 'deploy', 'pr', 'branch',
    'tailwind', 'shadcn', 'playwright', 'vitest', 'schema', 'index',
  ];

  const found = tagPool.filter(tag => lower.includes(tag));

  // Also extract PR numbers
  const prMatches = text.match(/#\d+/g);
  if (prMatches) found.push(...prMatches.map(m => `pr${m}`));

  return [...new Set(found)].slice(0, 10);
}

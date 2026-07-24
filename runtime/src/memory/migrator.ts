import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { AIPatternModel, AgentModel, SkillModel, isConnected } from '../shared/db.js';
import { getConfig } from '../shared/config.js';
import { getEmbeddingProvider } from './embeddings.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'memory-migrator' });

/**
 * Migrate file-based SONA patterns (memory/patterns/*.json) to MongoDB.
 * Idempotent — skips patterns already in the database.
 */
export async function migratePatterns(): Promise<{ migrated: number; skipped: number; failed: number }> {
  if (!isConnected()) {
    log.warn('MongoDB not connected — skipping pattern migration');
    return { migrated: 0, skipped: 0, failed: 0 };
  }

  const config = getConfig();
  const patternsDir = resolve(config.aiRoot, 'memory', 'patterns');

  if (!existsSync(patternsDir)) {
    log.info({ path: patternsDir }, 'No patterns directory — nothing to migrate');
    return { migrated: 0, skipped: 0, failed: 0 };
  }

  const files = readdirSync(patternsDir).filter(f => f.startsWith('pat-') && f.endsWith('.json'));
  let migrated = 0, skipped = 0, failed = 0;

  for (const file of files) {
    try {
      const raw = readFileSync(join(patternsDir, file), 'utf-8');
      const data = JSON.parse(raw);

      const patternId = data.id || file.replace('.json', '');

      // Check if already in DB
      const existing = await AIPatternModel.findOne({ patternId });
      if (existing) {
        skipped++;
        continue;
      }

      await AIPatternModel.create({
        patternId,
        title: data.title || patternId,
        description: data.description || '',
        tags: data.tags || [],
        category: data.category || 'approach',
        context: data.context || {},
        pattern: data.pattern || {},
        outcome: data.outcome || {},
        confidence: data.scoring?.confidence ?? 0.5,
        usageCount: data.scoring?.usage_count ?? 0,
        successCount: data.scoring?.success_count ?? 0,
        failureCount: data.scoring?.failure_count ?? 0,
        lastUsed: data.scoring?.last_used ? new Date(data.scoring.last_used) : new Date(),
        lastScored: data.scoring?.last_scored ? new Date(data.scoring.last_scored) : new Date(),
        createdBy: data.metadata?.created_by || 'migration',
        createdAt: data.metadata?.created_at ? new Date(data.metadata.created_at) : new Date(),
      });

      migrated++;
    } catch (err) {
      log.error({ file, err }, 'Failed to migrate pattern');
      failed++;
    }
  }

  log.info({ migrated, skipped, failed, total: files.length }, 'Pattern migration complete');
  return { migrated, skipped, failed };
}

/**
 * Compute embeddings for all patterns that don't have one yet.
 */
export async function indexEmbeddings(): Promise<{ indexed: number; skipped: number; failed: number }> {
  if (!isConnected()) return { indexed: 0, skipped: 0, failed: 0 };

  const provider = getEmbeddingProvider();
  const patterns = await AIPatternModel.find({}).select('+embedding').lean();

  let indexed = 0, skipped = 0, failed = 0;

  for (const p of patterns) {
    if (p.embedding && p.embedding.length > 0) {
      skipped++;
      continue;
    }

    try {
      // Create text representation for embedding
      const text = [p.title, p.description, ...(p.tags || [])].filter(Boolean).join(' ');
      const embedding = await provider.embed(text);

      await AIPatternModel.updateOne(
        { patternId: p.patternId },
        { $set: { embedding } },
      );

      indexed++;
    } catch (err) {
      log.error({ patternId: p.patternId, err }, 'Failed to index embedding');
      failed++;
    }
  }

  log.info({ indexed, skipped, failed }, 'Pattern embedding indexing complete');
  return { indexed, skipped, failed };
}

/**
 * Compute embeddings for agents and skills that don't have one yet.
 * Stores embeddings in MongoDB alongside the documents.
 */
export async function indexAgentSkillEmbeddings(): Promise<{ indexed: number; skipped: number; failed: number }> {
  if (!isConnected()) return { indexed: 0, skipped: 0, failed: 0 };

  const provider = getEmbeddingProvider();
  let indexed = 0, skipped = 0, failed = 0;

  // Index agent embeddings
  const agents = await AgentModel.find({}).select('+embedding').lean();
  for (const a of agents) {
    if (a.embedding && a.embedding.length > 0) {
      skipped++;
      continue;
    }

    try {
      const text = [a.name, a.description, a.category, ...(a.tools || [])].filter(Boolean).join(' ');
      const embedding = await provider.embed(text);
      await AgentModel.updateOne({ name: a.name }, { $set: { embedding } });
      indexed++;
    } catch (err) {
      log.error({ agent: a.name, err }, 'Failed to index agent embedding');
      failed++;
    }
  }

  // Index skill embeddings
  const skills = await SkillModel.find({}).select('+embedding').lean();
  for (const s of skills) {
    if (s.embedding && s.embedding.length > 0) {
      skipped++;
      continue;
    }

    try {
      const text = [s.name, s.description, ...(s.triggers || [])].filter(Boolean).join(' ');
      const embedding = await provider.embed(text);
      await SkillModel.updateOne({ name: s.name }, { $set: { embedding } });
      indexed++;
    } catch (err) {
      log.error({ skill: s.name, err }, 'Failed to index skill embedding');
      failed++;
    }
  }

  log.info({ indexed, skipped, failed }, 'Agent/skill embedding indexing complete');
  return { indexed, skipped, failed };
}

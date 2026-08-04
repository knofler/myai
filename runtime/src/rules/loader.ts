import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { RuleModel, isConnected } from '../shared/db.js';
import { getDbFailoverState } from '../shared/db-failover.js';

const log = createChildLogger({ module: 'rule-loader' });

export interface RuleDefinition {
  name: string;
  description: string;
  category: string;
  content: string;
  filePath: string;
}

const rules = new Map<string, RuleDefinition>();

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Rule files to load from the AI root.
 * Each entry: [name, relative path, category, description]
 */
const RULE_FILES: Array<[string, string, string, string]> = [
  ['ai-rules', 'documentation/AI_RULES.md', 'governance', 'Global AI agent instructions — tech stack, code quality, multi-agent protocol'],
  ['multi-agent-routing', 'documentation/MULTI_AGENT_ROUTING.md', 'routing', 'Multi-agent routing reference — 13 specialists, parallel dispatch lanes'],
  ['swarm-coordination', 'documentation/SWARM_COORDINATION.md', 'coordination', 'Swarm coordination protocol — 4 topologies, lifecycle, anti-drift'],
  ['cost-aware-routing', 'documentation/COST_AWARE_ROUTING.md', 'routing', 'Cost-aware routing — 5 tiers, complexity estimator, budget guards'],
  ['sona-neural-learning', 'documentation/SONA_NEURAL_LEARNING.md', 'learning', 'SONA neural learning — pattern store, scoring, context builder'],
  ['claude-md', 'CLAUDE.md', 'governance', 'Master CLAUDE.md — repo structure, keywords, state management'],
];

export function loadRules(): Map<string, RuleDefinition> {
  const config = getConfig();

  for (const [name, relativePath, category, description] of RULE_FILES) {
    const filePath = resolve(config.aiRoot, relativePath);

    if (!existsSync(filePath)) {
      log.debug({ name, path: filePath }, 'Rule file not found — skipping');
      continue;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      rules.set(name, { name, description, category, content, filePath });
    } catch (err) {
      log.error({ name, filePath, err }, 'Failed to load rule');
    }
  }

  log.info({ count: rules.size }, 'Rules loaded');
  return rules;
}

/**
 * Sync rules to MongoDB with content hashing — only writes changed docs.
 */
export async function syncRulesToDatabase(): Promise<{ upserted: number; unchanged: number }> {
  if (!isConnected()) {
    log.warn('MongoDB not connected — skipping rule sync');
    return { upserted: 0, unchanged: 0 };
  }
  if (getDbFailoverState().active) {
    // bulkWrite bypasses the read-only guard plugin — skip explicitly.
    log.warn('READ-ONLY DB failover active — skipping rule sync (mirror must not diverge)');
    return { upserted: 0, unchanged: 0 };
  }

  const now = new Date();

  const existingRules = await RuleModel.find({}, { name: 1, contentHash: 1 }).lean();
  const ruleHashMap = new Map(existingRules.map(r => [r.name, (r as Record<string, unknown>).contentHash as string]));

  const ops = [];
  let unchanged = 0;

  for (const r of rules.values()) {
    const hash = contentHash(r.content);

    if (ruleHashMap.get(r.name) === hash) {
      unchanged++;
      continue;
    }

    ops.push({
      updateOne: {
        filter: { name: r.name },
        update: {
          $set: {
            name: r.name,
            description: r.description,
            category: r.category,
            content: r.content,
            filePath: r.filePath,
            contentHash: hash,
            loadedAt: now,
          },
        },
        upsert: true,
      },
    });
  }

  let upserted = 0;
  if (ops.length > 0) {
    const result = await RuleModel.bulkWrite(ops);
    upserted = result.upsertedCount + result.modifiedCount;
  }

  const ruleNames = Array.from(rules.keys());
  await RuleModel.deleteMany({ name: { $nin: ruleNames } });

  const result = { upserted, unchanged };
  log.info(result, 'Rules synced to MongoDB');
  return result;
}

export function getRule(name: string): RuleDefinition | undefined {
  return rules.get(name);
}

export function listRules(category?: string): RuleDefinition[] {
  const all = Array.from(rules.values());
  if (!category) return all;
  return all.filter(r => r.category === category);
}

export function getRuleCount(): number {
  return rules.size;
}

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import matter from 'gray-matter';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { AgentModel, SkillModel, isConnected } from '../shared/db.js';
import type { AgentDefinition, SkillDefinition } from '../shared/types.js';

const log = createChildLogger({ module: 'agent-loader' });

const agents = new Map<string, AgentDefinition>();
const skills = new Map<string, SkillDefinition>();

/** SHA-256 hash of content — used to skip unchanged docs on upsert */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function loadAgents(): Map<string, AgentDefinition> {
  const config = getConfig();
  const agentsDir = resolve(config.aiRoot, 'agents');

  if (!existsSync(agentsDir)) {
    log.warn({ path: agentsDir }, 'Agents directory not found');
    return agents;
  }

  const files = readdirSync(agentsDir).filter(f => f.endsWith('.md') && f !== 'README.md' && f !== 'CATALOG.md');

  for (const file of files) {
    try {
      const filePath = join(agentsDir, file);
      const raw = readFileSync(filePath, 'utf-8');

      let name = file.replace('.md', '');
      let description = '';
      let tools: string[] = [];
      let instructions = raw;

      try {
        const { data, content } = matter(raw);
        name = data.name || name;
        description = data.description || '';
        tools = Array.isArray(data.tools)
          ? data.tools
          : typeof data.tools === 'string'
            ? data.tools.split(',').map((t: string) => t.trim())
            : [];
        instructions = content.trim();
      } catch {
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          const descMatch = fm.match(/^description:\s*(.+)$/m);
          const toolsMatch = fm.match(/^tools:\s*(.+)$/m);
          if (nameMatch) name = nameMatch[1].trim();
          if (descMatch) description = descMatch[1].trim();
          if (toolsMatch) tools = toolsMatch[1].split(',').map((t: string) => t.trim());
          instructions = raw.slice(fmMatch[0].length).trim();
        }
      }

      const category = name.includes('-') ? name.split('-')[0] : 'core';

      agents.set(name, { name, description, tools, category, instructions, filePath });
    } catch (err) {
      log.error({ file, err }, 'Failed to load agent');
    }
  }

  log.info({ count: agents.size }, 'Agents loaded');
  return agents;
}

export function loadSkills(): Map<string, SkillDefinition> {
  const config = getConfig();
  const skillsDir = resolve(config.aiRoot, 'skills');

  if (!existsSync(skillsDir)) {
    log.warn({ path: skillsDir }, 'Skills directory not found');
    return skills;
  }

  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dir of dirs) {
    const skillFile = join(skillsDir, dir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    try {
      const raw = readFileSync(skillFile, 'utf-8');
      const { data, content } = matter(raw);

      const name = data.name || dir;
      const description = data.description || '';

      const triggers = description
        .replace(/['"]/g, '')
        .split(',')
        .map((t: string) => t.trim().toLowerCase())
        .filter(Boolean);

      skills.set(name, {
        name,
        description,
        triggers,
        playbook: content.trim(),
        filePath: skillFile,
      });
    } catch (err) {
      log.error({ dir, err }, 'Failed to parse skill');
    }
  }

  log.info({ count: skills.size }, 'Skills loaded');
  return skills;
}

/**
 * Sync agents and skills to MongoDB.
 * Uses content hashing to skip unchanged documents — only writes diffs.
 * Runs on every startup to guarantee DB matches files.
 */
export async function syncToDatabase(): Promise<{ agents: { upserted: number; unchanged: number }; skills: { upserted: number; unchanged: number } }> {
  if (!isConnected()) {
    log.warn('MongoDB not connected — skipping agent/skill sync');
    return { agents: { upserted: 0, unchanged: 0 }, skills: { upserted: 0, unchanged: 0 } };
  }

  const now = new Date();

  // ── Agents ──────────────────────────────────────────
  // Fetch existing hashes from DB in one query
  const existingAgents = await AgentModel.find({}, { name: 1, contentHash: 1 }).lean();
  const agentHashMap = new Map(existingAgents.map(a => [a.name, (a as Record<string, unknown>).contentHash as string]));

  const agentOps = [];
  let agentUnchanged = 0;

  for (const a of agents.values()) {
    const hash = contentHash(a.instructions + a.description);

    if (agentHashMap.get(a.name) === hash) {
      agentUnchanged++;
      continue;
    }

    agentOps.push({
      updateOne: {
        filter: { name: a.name },
        update: {
          $set: {
            name: a.name,
            description: a.description,
            tools: a.tools,
            category: a.category,
            instructions: a.instructions,
            filePath: a.filePath,
            contentHash: hash,
            loadedAt: now,
          },
          $unset: { embedding: '' }, // Clear embedding so it gets re-indexed
        },
        upsert: true,
      },
    });
  }

  let agentUpserted = 0;
  if (agentOps.length > 0) {
    const result = await AgentModel.bulkWrite(agentOps);
    agentUpserted = result.upsertedCount + result.modifiedCount;
  }

  // Remove agents no longer on disk
  const agentNames = Array.from(agents.keys());
  await AgentModel.deleteMany({ name: { $nin: agentNames } });

  // ── Skills ──────────────────────────────────────────
  const existingSkills = await SkillModel.find({}, { name: 1, contentHash: 1 }).lean();
  const skillHashMap = new Map(existingSkills.map(s => [s.name, (s as Record<string, unknown>).contentHash as string]));

  const skillOps = [];
  let skillUnchanged = 0;

  for (const s of skills.values()) {
    const hash = contentHash(s.playbook + s.description);

    if (skillHashMap.get(s.name) === hash) {
      skillUnchanged++;
      continue;
    }

    skillOps.push({
      updateOne: {
        filter: { name: s.name },
        update: {
          $set: {
            name: s.name,
            description: s.description,
            triggers: s.triggers,
            playbook: s.playbook,
            filePath: s.filePath,
            contentHash: hash,
            loadedAt: now,
          },
          $unset: { embedding: '' },
        },
        upsert: true,
      },
    });
  }

  let skillUpserted = 0;
  if (skillOps.length > 0) {
    const result = await SkillModel.bulkWrite(skillOps);
    skillUpserted = result.upsertedCount + result.modifiedCount;
  }

  const skillNames = Array.from(skills.keys());
  await SkillModel.deleteMany({ name: { $nin: skillNames } });

  const result = {
    agents: { upserted: agentUpserted, unchanged: agentUnchanged },
    skills: { upserted: skillUpserted, unchanged: skillUnchanged },
  };

  log.info(result, 'Agents/skills synced to MongoDB');
  return result;
}

export function getAgent(name: string): AgentDefinition | undefined {
  return agents.get(name);
}

export function getSkill(name: string): SkillDefinition | undefined {
  return skills.get(name);
}

export function listAgents(category?: string): AgentDefinition[] {
  const all = Array.from(agents.values());
  if (!category) return all;
  return all.filter(a => a.category === category);
}

export function listSkills(agentName?: string): SkillDefinition[] {
  const all = Array.from(skills.values());
  if (!agentName) return all;
  return all.filter(s => s.name.startsWith(agentName) || s.name.includes(agentName));
}

export function getAgentCount(): number {
  return agents.size;
}

export function getSkillCount(): number {
  return skills.size;
}

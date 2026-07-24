import { getAgent, listSkills } from './loader.js';
import { buildContext } from '../memory/context-builder.js';
import { complete, isConfigured } from '../llm/provider.js';
import { emit } from '../hooks/event-bus.js';
import { ensureWorkspace } from './workspace.js';
import { createChildLogger } from '../shared/logger.js';
import type { AgentDefinition, SkillDefinition } from '../shared/types.js';

const log = createChildLogger({ module: 'agent-runtime' });

/**
 * In-gateway agent execution (MYAI_GATEWAY Phase 6).
 *
 * `executeAgent` runs a specialist agent directly inside the gateway:
 * it constructs the full prompt from the agent's markdown definition,
 * injects matching skill playbooks and SONA memory context, then calls
 * the configured LLM provider chain (`llm/provider.ts`).
 *
 * Passthrough mode: when no LLM provider is configured, the constructed
 * prompt is returned instead of an LLM answer (`executed: false`,
 * `provider: 'passthrough'`). This preserves the "Claude IS the model"
 * pattern — a CLI session can take the prompt and run it itself.
 */

export interface AgentExecuteOptions {
  /** Attach the run to an existing gateway session (used by the spawner). */
  sessionId?: string;
  maxTokens?: number;
  /** Max skill playbooks to inject (default 3). */
  maxSkills?: number;
  /** Char budget per injected skill playbook (default 4000). */
  skillCharBudget?: number;
  /** Include SONA memory context (default true; silently skipped if DB is down). */
  includeMemory?: boolean;
  /** Token budget for the SONA context block (default 1500). */
  memoryTokens?: number;
  /** Create a per-session scratch workspace and mention it in the prompt. */
  workspace?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  agentName: string;
  /** LLM answer, or the constructed prompt in passthrough mode. */
  output: string;
  /** False when no LLM provider is configured (passthrough). */
  executed: boolean;
  provider?: string;
  model?: string;
  costUsd?: number;
  skillsInjected: string[];
  memoryPatterns: number;
  durationMs: number;
  workspace?: string;
}

/**
 * Score skills against the task text: +1 per trigger phrase contained in the
 * task, +2 when the task names the skill itself. Trigger phrases shorter than
 * 4 chars are ignored (stop-word noise from comma-split descriptions).
 */
export function matchSkills(task: string, maxSkills = 3): SkillDefinition[] {
  const text = task.toLowerCase();
  const scored: Array<{ skill: SkillDefinition; score: number }> = [];

  for (const skill of listSkills()) {
    let score = 0;
    if (text.includes(skill.name.toLowerCase())) score += 2;
    for (const trigger of skill.triggers) {
      if (trigger.length >= 4 && text.includes(trigger)) score += 1;
    }
    if (score > 0) scored.push({ skill, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSkills)
    .map(s => s.skill);
}

export interface BuiltAgentPrompt {
  /**
   * BRAIN B-8 (prompt-cache-aware ordering): the STABLE prefix — agent
   * identity, instructions, and the runtime execution frame. Byte-identical
   * across repeated calls for the same agent + options, regardless of task,
   * so it is the block marked `cache_control` in `callAnthropic` — cache
   * reads cost 0.1x input instead of paying full price every call.
   */
  systemPrompt: string;
  /**
   * The VOLATILE suffix — per-task skill playbooks + SONA memory context.
   * Recomputed every call (different task → different matches/retrieval), so
   * it is appended AFTER the cache boundary: it never busts the stable
   * prefix's cache, and providers that don't support cache splitting just
   * get it folded back into one system string.
   */
  volatileSuffix: string;
  skillsInjected: string[];
  memoryPatterns: number;
}

/**
 * Construct the system prompt for an in-gateway agent run, split at the
 * prompt-cache boundary (BRAIN B-8): a stable prefix (agent identity +
 * instructions + runtime execution frame) that repeats byte-for-byte across
 * calls, and a volatile suffix (matched skill playbooks, char-budgeted, +
 * SONA memory context) that changes per task.
 */
export async function buildAgentPrompt(
  agent: AgentDefinition,
  task: string,
  opts: AgentExecuteOptions = {},
): Promise<BuiltAgentPrompt> {
  const maxSkills = opts.maxSkills ?? 3;
  const skillCharBudget = opts.skillCharBudget ?? 4000;

  // ── Stable prefix (cache boundary sits right after this) ────────────
  const stableParts: string[] = [
    `You are ${agent.name}, a specialist AI agent running inside the myAI gateway agent runtime.`,
    `Category: ${agent.category}`,
    `Description: ${agent.description}`,
    '',
    'Your instructions:',
    agent.instructions,
    '',
    'EXECUTION CONTEXT: You are executing a single task headlessly inside the gateway.',
    'Produce the complete deliverable as markdown in your reply. You have no file-system,',
    'git, or shell tools on this path — never claim to have performed such actions;',
    'output artifacts inline instead.',
  ];

  // ── Volatile suffix — skill injection ────────────────────────────────
  const volatileParts: string[] = [];
  const skills = maxSkills > 0 ? matchSkills(task, maxSkills) : [];
  for (const skill of skills) {
    const playbook = skill.playbook.length > skillCharBudget
      ? skill.playbook.slice(0, skillCharBudget) + '\n…(playbook truncated)'
      : skill.playbook;
    volatileParts.push('', `## Skill playbook: ${skill.name}`, playbook);
  }

  // ── Volatile suffix — SONA memory context (best-effort — DB may be down) ──
  let memoryPatterns = 0;
  if (opts.includeMemory !== false) {
    try {
      const context = await buildContext(task, [], opts.memoryTokens ?? 1500);
      if (context.text) {
        volatileParts.push('', context.text);
        memoryPatterns = context.patterns.length;
      }
    } catch (err) {
      log.debug({ err }, 'SONA context unavailable — continuing without');
    }
  }

  return {
    systemPrompt: stableParts.join('\n'),
    volatileSuffix: volatileParts.join('\n').trim(),
    skillsInjected: skills.map(s => s.name),
    memoryPatterns,
  };
}

/**
 * Execute an agent directly in the gateway. Emits `agent:dispatch` (blockable)
 * before the run and `agent:complete` after.
 */
export async function executeAgent(
  agentName: string,
  task: string,
  opts: AgentExecuteOptions = {},
): Promise<AgentRunResult> {
  const agent = getAgent(agentName);
  if (!agent) throw new Error(`Agent "${agentName}" not found`);

  const started = Date.now();

  const dispatchResult = await emit('agent:dispatch', {
    sessionId: opts.sessionId,
    agentName,
    metadata: { task: task.slice(0, 500), ...(opts.metadata ?? {}) },
  });
  if (dispatchResult.block) {
    throw new Error(`Agent dispatch blocked: ${dispatchResult.reason}`);
  }

  let workspace: string | undefined;
  if (opts.workspace && opts.sessionId) {
    workspace = ensureWorkspace(opts.sessionId);
  }

  const prompt = await buildAgentPrompt(agent, task, opts);
  // Workspace path is session-specific (changes every run that has one) — it
  // belongs with the volatile suffix, after the prompt-cache boundary, never
  // mixed into the stable prefix.
  const volatileSuffix = workspace
    ? `${prompt.volatileSuffix}\n\nWorkspace directory for this session: ${workspace}`.trim()
    : prompt.volatileSuffix;
  const systemPrompt = prompt.systemPrompt;

  let result: AgentRunResult;

  if (!isConfigured()) {
    // Passthrough mode — no LLM configured. Return the constructed prompt so
    // a CLI Claude session (which IS the model) can execute it directly.
    const fullPrompt = volatileSuffix ? `${systemPrompt}\n\n${volatileSuffix}` : systemPrompt;
    result = {
      agentName,
      output: `${fullPrompt}\n\n---\n\nTASK:\n${task}`,
      executed: false,
      provider: 'passthrough',
      skillsInjected: prompt.skillsInjected,
      memoryPatterns: prompt.memoryPatterns,
      durationMs: Date.now() - started,
      workspace,
    };
  } else {
    const llmResponse = await complete({
      systemPrompt,
      volatileSuffix: volatileSuffix || undefined,
      messages: [{ role: 'user', content: task }],
      maxTokens: opts.maxTokens,
    });

    if (!llmResponse) {
      throw new Error(`Agent "${agentName}" run returned no response from the LLM provider chain`);
    }

    result = {
      agentName,
      output: llmResponse.content,
      executed: true,
      provider: llmResponse.provider,
      model: llmResponse.model,
      costUsd: llmResponse.costUsd,
      skillsInjected: prompt.skillsInjected,
      memoryPatterns: prompt.memoryPatterns,
      durationMs: Date.now() - started,
      workspace,
    };
  }

  await emit('agent:complete', {
    sessionId: opts.sessionId,
    agentName,
    metadata: {
      executed: result.executed,
      provider: result.provider,
      durationMs: result.durationMs,
      skillsInjected: result.skillsInjected,
    },
  });

  log.info({
    agentName,
    executed: result.executed,
    provider: result.provider,
    skills: result.skillsInjected.length,
    memoryPatterns: result.memoryPatterns,
    durationMs: result.durationMs,
  }, 'Agent run complete');

  return result;
}

import { prioritizeRepos } from '../repos/repo-registry.js';
import { executeTool } from '../mcp/tools.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';
import { getAdapter } from '../channels/registry.js';
import { createChildLogger } from '../shared/logger.js';
import { getConfig } from '../shared/config.js';
import { loadAgents } from '../agents/loader.js';
import { runAnthropicBatch, type BatchResultEntry } from '../llm/anthropic-batch.js';
import { wrapBatchResult } from '../llm/provider.js';
import { recordBudgetUsage } from '../llm/budget-guard.js';
import { getBudgetStatus } from '../llm/budget-stats.js';

const log = createChildLogger({ module: 'morning-sweep' });

export interface MorningSweepInput {
  topN?: number | string;
  agent?: string;
  telegramChatId?: string;
  briefMaxTokens?: number;
  /** Force the batch path on/off. Default: respect config.llm.batchEnabled. */
  useBatch?: boolean;
  /** Skip dispatch if daily spend already exceeds this USD amount. Default: no limit. */
  dailySpendCapUsd?: number;
}

export interface RepoBrief {
  repo: string;
  score: number;
  reasons: string[];
  openTasks: number;
  staleDays: number;
  brief?: string;
  briefError?: string;
}

export interface MorningSweepResult {
  topN: number;
  agent: string;
  ranAt: Date;
  reposConsidered: number;
  briefs: RepoBrief[];
  report: string;
  delivery: { telegram: boolean; telegramChatId?: string; telegramError?: string };
  /** Phase 5f — set when briefs were produced via Anthropic batch dispatch. */
  batchMode?: boolean;
  /** Set when the sweep was skipped because daily spend exceeded the cap. */
  budgetSkipped?: boolean;
}

const DEFAULT_TOP_N = 3;
const DEFAULT_AGENT = 'project-manager';
const MAX_TOP_N = 20;
/** Batching a single item costs more than it saves (fixed polling overhead).
 *  Below this we always use the per-request path even when batch is enabled. */
const BATCH_MIN_ITEMS = 2;

function clampTopN(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_TOP_N;
  const normalized = typeof raw === 'string' ? raw.trim() : raw;
  if (normalized === '') return DEFAULT_TOP_N;
  const num = typeof normalized === 'number' ? normalized : Number(normalized);
  if (!Number.isFinite(num)) return DEFAULT_TOP_N;
  const n = Math.floor(num);
  if (n <= 0) return 0;
  return Math.min(n, MAX_TOP_N);
}

interface RankedEntry {
  repo: string;
  score: number;
  reasons: string[];
  openTasks: number;
  staleDays: number;
}

function buildBriefMessage(entry: RankedEntry): string {
  return [
    `Morning sweep brief for ${entry.repo}.`,
    `Attention score: ${entry.score}. Reasons: ${entry.reasons.join('; ') || 'no specific signals'}.`,
    `Open tasks: ${entry.openTasks}. Handoff stale ${entry.staleDays}d.`,
    '',
    'In ≤4 sentences: what is the highest-leverage thing to do in this repo today, and why?',
  ].join('\n');
}

/** Decide whether the batch path is viable for this sweep. */
function shouldBatch(top: RankedEntry[], explicit: boolean | undefined, agentName: string): boolean {
  if (explicit === false) return false;
  if (top.length < BATCH_MIN_ITEMS) return false;

  const config = getConfig();
  if (explicit !== true && !config.llm.batchEnabled) return false;
  // Batch is Anthropic-only; the provider chain must put `api` first
  // (or have it as the sole mode) for the discount to apply.
  if (config.llm.mode !== 'api') return false;
  if (!config.llm.apiKey) return false;

  // Validate the agent exists. The batch path doesn't have a per-call
  // "agent not found" surface, so we check once upfront.
  const agents = loadAgents();
  if (!agents.has(agentName)) return false;

  return true;
}

export async function runMorningSweep(input: MorningSweepInput = {}): Promise<MorningSweepResult> {
  const topN = clampTopN(input.topN);
  const agent = input.agent ?? DEFAULT_AGENT;
  const briefMaxTokens = input.briefMaxTokens ?? 600;
  const telegramChatId = input.telegramChatId ?? process.env.TELEGRAM_DEFAULT_CHAT;
  const ranAt = new Date();

  log.info({ topN, agent, telegramChatId: telegramChatId ? '<set>' : '<none>' }, 'Morning sweep starting');

  // Budget guard: check daily spend before dispatching LLM calls
  const dailyCap = input.dailySpendCapUsd ?? (getConfig().budgets?.monthlyDailyCapUsd);
  if (dailyCap && dailyCap > 0) {
    try {
      const budgetStatus = await getBudgetStatus(DEFAULT_TENANT_ID);
      if (budgetStatus.today >= dailyCap) {
        const skipMsg = `Morning sweep skipped — daily spend $${budgetStatus.today.toFixed(2)} exceeds cap $${dailyCap.toFixed(2)}`;
        log.warn({ today: budgetStatus.today, cap: dailyCap }, skipMsg);
        return {
          topN,
          agent,
          ranAt,
          reposConsidered: 0,
          briefs: [],
          report: `# Morning Sweep — ${ranAt.toISOString().slice(0, 10)}\n\n_${skipMsg}_`,
          delivery: { telegram: false },
          budgetSkipped: true,
        };
      }
      log.info({ todaySpend: budgetStatus.today, dailyCap }, 'Budget check passed');
    } catch (err) {
      log.warn({ err }, 'Budget check failed — proceeding with sweep');
    }
  }

  const ranked = await prioritizeRepos(DEFAULT_TENANT_ID);
  const top = ranked.slice(0, topN);

  const useBatch = shouldBatch(top, input.useBatch, agent);
  log.info({ topCount: top.length, useBatch }, 'Brief dispatch path chosen');

  let briefs: RepoBrief[];
  if (useBatch) {
    briefs = await dispatchViaBatch(top, agent, briefMaxTokens);
  } else {
    briefs = await dispatchPerRequest(top, agent, briefMaxTokens);
  }

  const report = composeReport(ranAt, agent, ranked.length, briefs, topN);

  const delivery: MorningSweepResult['delivery'] = { telegram: false };
  if (telegramChatId) {
    delivery.telegramChatId = telegramChatId;
    const tg = getAdapter('telegram');
    if (!tg) {
      delivery.telegramError = 'Telegram adapter not registered';
    } else if (!tg.enabled) {
      delivery.telegramError = 'Telegram adapter not enabled';
    } else {
      try {
        await tg.send(telegramChatId, report);
        delivery.telegram = true;
      } catch (err) {
        delivery.telegramError = (err as Error).message;
      }
    }
  }

  log.info({
    reposConsidered: ranked.length,
    briefs: briefs.length,
    delivered: delivery.telegram,
    batchMode: useBatch,
  }, 'Morning sweep complete');

  return {
    topN,
    agent,
    ranAt,
    reposConsidered: ranked.length,
    briefs,
    report,
    delivery,
    batchMode: useBatch,
  };
}

/** Original per-request path — one agents_invoke per repo, serial. */
async function dispatchPerRequest(
  top: RankedEntry[],
  agentName: string,
  briefMaxTokens: number,
): Promise<RepoBrief[]> {
  const briefs: RepoBrief[] = [];
  for (const entry of top) {
    const repoBrief: RepoBrief = {
      repo: entry.repo,
      score: entry.score,
      reasons: entry.reasons,
      openTasks: entry.openTasks,
      staleDays: entry.staleDays,
    };
    const message = buildBriefMessage(entry);

    try {
      const dispatch = await executeTool('agents_invoke', {
        agent: agentName,
        message,
        repo: entry.repo,
        includeMemoryContext: true,
        maxTokens: briefMaxTokens,
      }) as { content?: string; error?: string };

      if (dispatch?.error) {
        repoBrief.briefError = dispatch.error;
      } else if (dispatch?.content) {
        repoBrief.brief = dispatch.content.trim();
      } else {
        repoBrief.briefError = 'Empty response from agent';
      }
    } catch (err) {
      repoBrief.briefError = (err as Error).message;
    }

    briefs.push(repoBrief);
  }
  return briefs;
}

/**
 * Batch path — one Anthropic Message Batch covering all repos.
 *
 * The system prompt (agent instructions) is identical across every batch
 * item, so the second-onward request hits the prompt cache. Stacked with
 * the 50% batch discount, a 3-repo sweep typically pays ~0.55× of what
 * the per-request path would. End-to-end latency is dominated by polling
 * (~10–60s for small batches).
 *
 * On any batch failure (submit throws, polling timeout, item-level error)
 * we degrade gracefully: items that errored get `briefError`, and if the
 * whole batch throws we fall back to the per-request path.
 */
async function dispatchViaBatch(
  top: RankedEntry[],
  agentName: string,
  briefMaxTokens: number,
): Promise<RepoBrief[]> {
  const agents = loadAgents();
  const agentDef = agents.get(agentName);
  if (!agentDef) {
    // shouldBatch already validated this, but guard for safety.
    log.warn({ agentName }, 'Batch path requested but agent not found — falling back to per-request');
    return dispatchPerRequest(top, agentName, briefMaxTokens);
  }

  // Build memory_context per repo in parallel — these are independent DB reads.
  const messages = await Promise.all(
    top.map(async entry => {
      const baseMessage = buildBriefMessage(entry);
      try {
        const ctx = await executeTool('memory_context', {
          repo: entry.repo,
          query: baseMessage,
        }) as { text?: string };
        const ctxText = ctx?.text ?? '';
        return ctxText
          ? `${ctxText}\n\n---\n\n${baseMessage}`
          : baseMessage;
      } catch (err) {
        log.warn({ err, repo: entry.repo }, 'memory_context failed in batch path — sending without context');
        return baseMessage;
      }
    }),
  );

  const batchItems = top.map((entry, i) => ({
    customId: entry.repo,
    systemPrompt: agentDef.instructions,
    message: messages[i],
    maxTokens: briefMaxTokens,
  }));

  let results: BatchResultEntry[];
  try {
    results = await runAnthropicBatch(batchItems);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Batch dispatch failed — falling back to per-request path');
    return dispatchPerRequest(top, agentName, briefMaxTokens);
  }

  const briefs: RepoBrief[] = top.map((entry, i) => {
    const result = results[i];
    const base: RepoBrief = {
      repo: entry.repo,
      score: entry.score,
      reasons: entry.reasons,
      openTasks: entry.openTasks,
      staleDays: entry.staleDays,
    };
    if (result.error) {
      return { ...base, briefError: result.error };
    }
    if (!result.content) {
      return { ...base, briefError: 'Empty response from batch' };
    }
    return { ...base, brief: result.content.trim() };
  });

  // Record one audit row per successful batch item so the dashboard sees
  // batch share-of-traffic + savings. Failures are not recorded (consistent
  // with how the per-request path skips audit when the LLM errored).
  for (const result of results) {
    if (result.error || result.content === undefined) continue;
    const llmRes = wrapBatchResult({
      content: result.content,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheCreationInputTokens: result.cacheCreationInputTokens,
      cacheReadInputTokens: result.cacheReadInputTokens,
    });
    try {
      await recordBudgetUsage(
        { systemPrompt: agentDef.instructions, messages: [] },
        llmRes,
        { tenantId: DEFAULT_TENANT_ID, channelType: 'scheduler', agentName },
      );
    } catch (err) {
      log.warn({ err, repo: result.customId }, 'Failed to record budget usage for batch item');
    }
  }

  return briefs;
}

function composeReport(ranAt: Date, agent: string, total: number, briefs: RepoBrief[], topN: number): string {
  const date = ranAt.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Daily Morning Sweep — ${date}`);
  lines.push('');
  lines.push(`Considered ${total} repo(s); reporting top ${briefs.length} by attention score (briefer: ${agent}).`);
  lines.push('');

  if (!briefs.length) {
    if (topN === 0) {
      lines.push(`_topN=0 — no briefs requested. ${total} repo(s) ranked but skipped._`);
    } else if (total === 0) {
      lines.push('_No repos require attention today._');
    } else {
      lines.push('_No briefs produced (all errored or filtered out)._');
    }
    return lines.join('\n');
  }

  briefs.forEach((b, i) => {
    lines.push(`## ${i + 1}. ${b.repo} — score ${b.score}`);
    lines.push('');
    if (b.reasons.length) {
      lines.push(`**Signals:** ${b.reasons.join(' · ')}`);
      lines.push('');
    }
    if (b.brief) {
      lines.push(b.brief);
    } else if (b.briefError) {
      lines.push(`_Brief unavailable: ${b.briefError}_`);
    }
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}

/**
 * Phase 5b — Budget guard.
 *
 * Two exports:
 *   - `applyBudgetGuard(req, ctx)` — pre-call. Reads MTD/today/per-channel
 *     spend, decides whether to block (hard cap) or rewrite the model
 *     (soft cap → cheaper tier). Returns the (possibly rewritten) request
 *     plus a `spendSnapshot` so the caller can include it in block messages.
 *   - `recordBudgetUsage(req, res, ctx)` — post-call. Writes one row to
 *     `BudgetUsageModel` with the cost the cost-estimator already attached
 *     to `LlmResponse.costUsd`.
 *
 * Defaults to off. When `config.budgets.enabled === false`,
 * `applyBudgetGuard` returns `{ allow: true, rewrittenReq: req, ... }`
 * synchronously with no DB query, and `recordBudgetUsage` is a no-op.
 * This keeps the gateway behavior byte-identical to pre-Phase-5b for
 * deployments that have not opted in.
 *
 * MTD aggregation is cached for 30s in-process per scope (global /
 * per-day / per-channel) to avoid hammering Mongo on every call. The
 * cache is intentionally small + per-process — there is no cross-process
 * coherence guarantee, but a 30s window is well within budget-cap
 * granularity.
 *
 * If Mongo is disconnected when the guard runs, we log a warning and
 * allow the call through (skipping recording). The guard is an
 * audit-log, not a transaction — failing the LLM call because the
 * audit log is unreachable would be worse than the temporary
 * over-spend risk.
 */

import { randomUUID } from 'node:crypto';
import { BudgetUsageModel, isConnected } from '../shared/db.js';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { tenantScope } from '../shared/scoped-query.js';
import { checkAndEmitSpendAlert } from './spend-alert.js';
import type { LlmRequest, LlmResponse } from './provider.js';

const log = createChildLogger({ module: 'budget-guard' });

/** Providers that don't bill per token. Kept in sync with cost-estimator's FREE_PROVIDERS. */
const FREE_PROVIDER_PREFIXES = new Set(['ollama', 'claude-cli', 'claude-bridge']);

// ── Public types ─────────────────────────────────────────

export type BudgetBlockReason = 'monthly_hard' | 'daily_hard' | 'channel_hard';

export interface BudgetCheckResult {
  /** When false, the caller must NOT dispatch the LLM call. Use the spend
   *  snapshot to compose a structured block message. */
  allow: boolean;
  /** Set when `allow === false`. Identifies which cap tripped. */
  reason?: BudgetBlockReason;
  /** When the guard rewrote `req.toolOpts?.model` (or similar) to a cheaper
   *  tier, this carries the original model id so callers can log/footer it. */
  downgradedFrom?: string;
  /** Possibly-rewritten request. Identical to input when no rewrite occurred. */
  rewrittenReq: LlmRequest;
  /** Short user-facing string for the response footer when a downgrade fired. */
  warning?: string;
  /** Current spend snapshot at the time of the check. Useful for block-message
   *  composition and for the dashboard. */
  spendSnapshot: { mtd: number; today: number; channelMtd?: number };
  /** Tightest remaining budget headroom in USD (min across monthly / daily /
   *  per-channel caps). Set only when budgets are enabled and the call is
   *  allowed. `rewrittenReq.failoverBudget.remainingUsd` carries the same value
   *  so the provider's budget-aware failover filter honours it automatically. */
  remainingUsd?: number;
}

// ── In-process MTD aggregation cache ─────────────────────

interface CacheEntry { value: number; expiresAt: number; }
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

function readCache(key: string): number | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key: string, value: number): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test hook — clears the in-memory aggregation cache. Not exported via index. */
export function _resetBudgetCache(): void {
  cache.clear();
}

// ── Time helpers (UTC) ───────────────────────────────────

function startOfMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfDayUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ── Aggregation primitives ───────────────────────────────

/**
 * Sum `costUsd` across `BudgetUsageModel` documents matching `match`.
 * Cached for 30s by `cacheKey`. Returns 0 on Mongo error or disconnection
 * (callers treat 0 spend as "allow").
 */
async function aggregateCostSum(
  match: Record<string, unknown>,
  cacheKey: string,
): Promise<number> {
  const cached = readCache(cacheKey);
  if (cached !== null) return cached;

  if (!isConnected() || !BudgetUsageModel) {
    log.warn({ cacheKey }, 'budget-guard: MongoDB not connected — assuming 0 spend');
    return 0;
  }

  try {
    // tenant-ok: `match` is always tenant-scoped by callers — built from
    // `{ ...tenantScope(ctx.tenantId), ... }` in applyBudgetGuard above.
    const result = await BudgetUsageModel.aggregate<{ _id: null; total: number }>([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]);
    const total = result[0]?.total ?? 0;
    writeCache(cacheKey, total);
    return total;
  } catch (err) {
    log.warn({ err, cacheKey }, 'budget-guard: aggregation failed — assuming 0 spend');
    return 0;
  }
}

// ── Downgrade table ──────────────────────────────────────

const OPUS_REPLACEMENT = 'claude-sonnet-4-7';
const SONNET_REPLACEMENT = 'claude-haiku-4-5';

function isOpusModel(model: string | undefined): boolean {
  return !!model && model.toLowerCase().startsWith('claude-opus-');
}

function isSonnetModel(model: string | undefined): boolean {
  return !!model && model.toLowerCase().startsWith('claude-sonnet-');
}

/**
 * Rewrite the model in an `LlmRequest`. The model identifier lives on
 * `toolOpts.model` (Anthropic) when the request is going through the
 * Anthropic provider — but the request shape doesn't actually carry a
 * top-level model field (the provider reads `config.llm.model`).
 *
 * For Phase 5b we expose `LlmRequest.model` on `toolOpts` only when set,
 * so the rewrite is observable to provider code that opts in. We pass the
 * effective model used for the downgrade decision through the
 * `downgradedFrom` field of `BudgetCheckResult` so loggers/footers see it.
 *
 * Note: today's `LlmRequest` does NOT have a `model` field. The downgrade
 * decision must be made against `config.llm.model` (the configured default)
 * because that's what the Anthropic provider will actually use. Future
 * lanes can plumb a request-level `model` field through; this guard
 * already routes its decision through `getModelForRequest()` so adding it
 * is a one-line change here.
 */
function getModelForRequest(_req: LlmRequest): string | undefined {
  // For now the only model in scope is the global config default. The
  // request itself doesn't carry a model. When/if a request-level override
  // is added, prefer it here.
  return getConfig().llm.model;
}

/**
 * Apply a model downgrade to the request.
 *
 * `LlmRequest` does not currently carry a request-level model field —
 * the Anthropic provider reads `config.llm.model`. So today the
 * "rewrite" is observable only via:
 *   - `downgradedFrom` + `warning` in the `BudgetCheckResult`
 *   - The audit-log row written by `recordBudgetUsage` (which records
 *     the actual model the provider returned in `LlmResponse.model`)
 *
 * When a follow-up lane plumbs a request-level model override through
 * `LlmRequest`, this function becomes the single place to set it.
 */
function rewriteModel(req: LlmRequest, _newModel: string): LlmRequest {
  // Shallow copy preserves the request reference contract (callers
  // shouldn't see their input mutated). Once `LlmRequest.model` exists,
  // set it here.
  return { ...req };
}

// ── Remaining-budget headroom ────────────────────────────

/**
 * Tightest remaining budget headroom in USD — the min across the monthly,
 * daily, and (when configured) per-channel caps. Can go negative when a cap is
 * already exceeded; the provider's failover filter treats that as "paid
 * fallbacks off, free providers only". Pure — exported for tests.
 */
export function computeRemainingBudgetUsd(
  snapshot: { mtd: number; today: number; channelMtd?: number },
  budgets: { monthlyHardCapUsd: number; monthlyDailyCapUsd: number; perChannelMonthlyCapUsd?: number },
): number {
  const headrooms = [
    budgets.monthlyHardCapUsd - snapshot.mtd,
    budgets.monthlyDailyCapUsd - snapshot.today,
  ];
  if (typeof budgets.perChannelMonthlyCapUsd === 'number' && typeof snapshot.channelMtd === 'number') {
    headrooms.push(budgets.perChannelMonthlyCapUsd - snapshot.channelMtd);
  }
  return Math.min(...headrooms);
}

/** Stamp the failover budget hint onto a request without mutating the input. */
function withFailoverBudget(req: LlmRequest, remainingUsd: number): LlmRequest {
  return { ...req, failoverBudget: { ...req.failoverBudget, remainingUsd } };
}

// ── Public: applyBudgetGuard ─────────────────────────────

export async function applyBudgetGuard(
  req: LlmRequest,
  ctx: { tenantId: string; channelId?: string },
): Promise<BudgetCheckResult> {
  const config = getConfig();
  const budgets = config.budgets;

  // Disabled or bypass channel: allow with empty snapshot, no DB query.
  if (!budgets || !budgets.enabled) {
    return { allow: true, rewrittenReq: req, spendSnapshot: { mtd: 0, today: 0 } };
  }
  if (ctx.channelId && budgets.bypassChannelIds.includes(ctx.channelId)) {
    return { allow: true, rewrittenReq: req, spendSnapshot: { mtd: 0, today: 0 } };
  }

  // Aggregate current spend (cached 30s). Every match is scoped to the tenant
  // (ADR-010 §3.5), so the monthly/daily caps are PER-TENANT spend meters — a
  // forgotten tenant throws via `tenantScope`. Cache keys are tenant-namespaced
  // so two tenants never read each other's cached totals.
  const t = tenantScope(ctx.tenantId);
  const monthStart = startOfMonthUTC();
  const dayStart = startOfDayUTC();
  const monthKey = `${ctx.tenantId}:mtd:${monthStart.toISOString()}`;
  const dayKey = `${ctx.tenantId}:day:${dayStart.toISOString()}`;

  const [mtd, today] = await Promise.all([
    aggregateCostSum({ ...t, createdAt: { $gte: monthStart } }, monthKey),
    aggregateCostSum({ ...t, createdAt: { $gte: dayStart } }, dayKey),
  ]);

  let channelMtd: number | undefined;
  if (ctx.channelId && typeof budgets.perChannelMonthlyCapUsd === 'number') {
    const channelKey = `${ctx.tenantId}:channel:${ctx.channelId}:${monthStart.toISOString()}`;
    channelMtd = await aggregateCostSum(
      { ...t, channelId: ctx.channelId, createdAt: { $gte: monthStart } },
      channelKey,
    );
  }

  const spendSnapshot = { mtd, today, channelMtd };
  const remainingUsd = computeRemainingBudgetUsd(spendSnapshot, budgets);

  // Hard caps — order: monthly → daily → per-channel. First trip wins.
  if (mtd >= budgets.monthlyHardCapUsd) {
    return { allow: false, reason: 'monthly_hard', rewrittenReq: req, spendSnapshot };
  }
  if (today >= budgets.monthlyDailyCapUsd) {
    return { allow: false, reason: 'daily_hard', rewrittenReq: req, spendSnapshot };
  }
  if (
    typeof budgets.perChannelMonthlyCapUsd === 'number' &&
    typeof channelMtd === 'number' &&
    channelMtd >= budgets.perChannelMonthlyCapUsd
  ) {
    return { allow: false, reason: 'channel_hard', rewrittenReq: req, spendSnapshot };
  }

  // Soft caps / downgrade. Free providers are never downgraded — they cost 0.
  // (We still return their requests unchanged; the actual provider routing
  // happens in dispatchByMode.)
  const effectiveModel = getModelForRequest(req);
  const opusThreshold = budgets.monthlyHardCapUsd * budgets.downgradeOpusThreshold;
  const sonnetThreshold = budgets.monthlyHardCapUsd * budgets.downgradeSonnetThreshold;

  // Sonnet downgrade trips at >=90% AND model is sonnet.
  // Opus downgrade trips at >=80% AND model is opus.
  // We check sonnet first because the sonnet threshold is higher and at >=90%
  // we want sonnet→haiku regardless of whether opus→sonnet would also have
  // fired (opus is not in scope at this point — it'd already be sonnet).
  if (mtd >= sonnetThreshold && isSonnetModel(effectiveModel)) {
    const pct = Math.round((mtd / budgets.monthlyHardCapUsd) * 100);
    return {
      allow: true,
      downgradedFrom: effectiveModel,
      rewrittenReq: withFailoverBudget(rewriteModel(req, SONNET_REPLACEMENT), remainingUsd),
      warning: `⚠️ Budget at ${pct}% — downgraded ${effectiveModel} → ${SONNET_REPLACEMENT}`,
      spendSnapshot,
      remainingUsd,
    };
  }
  if (mtd >= opusThreshold && isOpusModel(effectiveModel)) {
    const pct = Math.round((mtd / budgets.monthlyHardCapUsd) * 100);
    return {
      allow: true,
      downgradedFrom: effectiveModel,
      rewrittenReq: withFailoverBudget(rewriteModel(req, OPUS_REPLACEMENT), remainingUsd),
      warning: `⚠️ Budget at ${pct}% — downgraded ${effectiveModel} → ${OPUS_REPLACEMENT}`,
      spendSnapshot,
      remainingUsd,
    };
  }

  return { allow: true, rewrittenReq: withFailoverBudget(req, remainingUsd), spendSnapshot, remainingUsd };
}

// ── Public: recordBudgetUsage ────────────────────────────

export async function recordBudgetUsage(
  req: LlmRequest,
  res: LlmResponse,
  ctx: { tenantId: string; channelId?: string; channelType?: string; agentName?: string; userId?: string },
): Promise<void> {
  const config = getConfig();
  if (!config.budgets || !config.budgets.enabled) return;
  if (ctx.channelId && config.budgets.bypassChannelIds.includes(ctx.channelId)) return;

  if (!isConnected() || !BudgetUsageModel) {
    log.warn('budget-guard: MongoDB not connected — skipping usage record');
    return;
  }

  // Normalise provider into the audit-log "provider" field. Free providers
  // still get a row with costUsd: 0 so dashboards can show free-provider
  // share-of-traffic.
  const provider = String(res.provider ?? 'unknown');
  const isFree = [...FREE_PROVIDER_PREFIXES].some(p => provider.startsWith(p));

  try {
    await BudgetUsageModel.create({
      ...tenantScope(ctx.tenantId),
      callId: randomUUID(),
      channelId: ctx.channelId,
      channelType: ctx.channelType,
      agentName: ctx.agentName,
      userId: ctx.userId,
      provider,
      model: res.model ?? 'unknown',
      inputTokens: res.inputTokens ?? 0,
      outputTokens: res.outputTokens ?? 0,
      costUsd: isFree ? 0 : (res.costUsd ?? 0),
      toolIterations: res.toolIterations,
      cappedToolUses: !!(res.cappedToolUses && res.cappedToolUses.length > 0),
      cacheCreationInputTokens: res.cacheCreationInputTokens,
      cacheReadInputTokens: res.cacheReadInputTokens,
      batchMode: res.batchMode,
      metadata: undefined,
    });

    // Invalidate aggregation caches so the next guard sees the fresh row
    // promptly (otherwise we'd wait up to 30s for cache expiry, which is fine
    // for budget-cap purposes but surprising in tests / dashboards).
    cache.clear();

    // Tenant-facing 80%/100%-of-plan-included-spend alert (FINOPS). Fire and
    // forget — never let a notification hiccup slow down or fail the LLM
    // call this usage row rides along with. Distinct from this guard's own
    // internal hard caps above.
    void checkAndEmitSpendAlert(ctx.tenantId).catch(err =>
      log.warn({ err }, 'budget-guard: checkAndEmitSpendAlert failed (suppressed)'),
    );
  } catch (err) {
    // Audit-log failure must not crash the gateway. Log and move on.
    log.warn({ err }, 'budget-guard: recordBudgetUsage failed (suppressed)');
  }
}

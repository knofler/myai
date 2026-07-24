/**
 * Budget-aware provider failover.
 *
 * The chain walker in `provider.ts::complete()` already falls over from one
 * provider to the next on a recoverable error (network / 429 / timeout /
 * circuit-open / rate-limit-exhausted), with per-provider circuit breaker +
 * exponential backoff living in `resilience.ts`. What that walker does NOT
 * know about is COST: a cheap primary (e.g. DeepSeek) failing can cascade the
 * call straight onto an expensive fallback (e.g. Claude Opus on `api`) even
 * when the tenant is already near its budget cap — exactly the wrong direction.
 *
 * This module is the missing budget dimension. Given a failover chain, a
 * remaining-budget figure, and a rough token estimate, `budgetAwareChain`
 * drops the paid fallback hops whose estimated cost would blow the remaining
 * budget while ALWAYS keeping:
 *   - the primary provider (index 0) — you always attempt the call you routed to
 *   - every free provider (Ollama / claude-cli / claude-bridge) — the sovereign
 *     floor, so a laptop with Ollama keeps working even at zero budget
 *
 * It is intentionally a pure module (no config / DB / IO) so it is trivially
 * unit-testable. `provider.ts` wires the config-derived models in; the budget
 * guard (the one place that knows a tenant's remaining spend) stamps the
 * budget figure onto the request. Default-off: when no budget figure is
 * supplied the chain is returned unchanged.
 */

import { estimateCost } from './cost-estimator.js';

/**
 * Map an `LLM_MODE` / router provider mode to the `LlmProviderId` the cost
 * estimator prices against. Unknown modes fall through unchanged (estimateCost
 * returns 0 for anything it can't price, which is the safe "don't block" answer).
 */
const MODE_TO_PROVIDER_ID: Record<string, string> = {
  api: 'claude-api',
  deepseek: 'deepseek-api',
  moonshot: 'moonshot-api',
  ollama: 'ollama',
  bridge: 'claude-bridge',
  direct: 'claude-cli',
};

/**
 * Estimate the USD cost of a single failover hop for a rough token budget.
 * Free/local modes (ollama, bridge, direct) always return 0 — they never bill.
 */
export function estimateModeCost(
  mode: string,
  model: string | undefined,
  estInputTokens: number,
  estOutputTokens: number,
): number {
  const providerId = MODE_TO_PROVIDER_ID[mode] ?? mode;
  return estimateCost(providerId, model, estInputTokens, estOutputTokens);
}

/**
 * Very rough token estimate from raw text length (~4 chars/token). Used only
 * to size the failover budget check — real token accounting comes back on the
 * response. Deliberately conservative-ish; a mild over-estimate errs on the
 * side of dropping an expensive fallback rather than over-spending.
 */
export function estimateRequestTokens(
  systemPrompt: string,
  messages: ReadonlyArray<{ content: string }>,
): number {
  const chars =
    (systemPrompt?.length ?? 0) +
    messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.ceil(chars / 4);
}

export interface BudgetAwareChainInput {
  /** Ordered failover chain (primary first), as built by `buildModeChain`. */
  chain: readonly string[];
  /** Remaining tenant budget in USD. Negative means already over cap. */
  remainingBudgetUsd: number;
  /** Rough input-token estimate for the call. */
  estInputTokens: number;
  /** Rough output-token estimate for the call (e.g. `req.maxTokens`). */
  estOutputTokens: number;
  /**
   * Resolve the model id a given hop would actually use. `index` lets the
   * caller apply the router's model override to the primary hop only (fallback
   * hops use their own provider-default model — see provider.ts chain walker).
   */
  modelForMode: (mode: string, index: number) => string | undefined;
}

export interface DroppedHop {
  mode: string;
  index: number;
  estimatedCostUsd: number;
}

export interface BudgetAwareChainResult {
  /** The filtered chain. Never empty when the input chain was non-empty. */
  chain: string[];
  /** Paid fallback hops removed because they'd exceed the remaining budget. */
  dropped: DroppedHop[];
}

/**
 * Filter a failover chain down to the hops the tenant can afford.
 *
 * Rules:
 *   - index 0 (primary) is always kept — you attempt the call you routed to.
 *   - free hops (estimated cost 0) are always kept — the sovereign floor.
 *   - any other hop is kept only if its estimated cost ≤ remaining budget.
 *
 * The primary already passed the pre-call budget guard, so keeping it is safe;
 * the point of this filter is to stop a *fallback* from cascading onto a
 * pricier provider than the tenant can pay for.
 */
export function budgetAwareChain(input: BudgetAwareChainInput): BudgetAwareChainResult {
  const kept: string[] = [];
  const dropped: DroppedHop[] = [];

  input.chain.forEach((mode, index) => {
    const model = input.modelForMode(mode, index);
    const cost = estimateModeCost(mode, model, input.estInputTokens, input.estOutputTokens);
    // Primary always attempted; free hops (cost 0) always retained even when
    // the tenant is over budget; paid fallbacks gated on remaining headroom.
    if (index === 0 || cost === 0 || cost <= input.remainingBudgetUsd) {
      kept.push(mode);
    } else {
      dropped.push({ mode, index, estimatedCostUsd: cost });
    }
  });

  // Safety net: never hand back an empty chain — always attempt the primary.
  if (kept.length === 0 && input.chain.length > 0) {
    kept.push(input.chain[0]);
  }

  return { chain: kept, dropped };
}

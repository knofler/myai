// Pure function: token counts × per-million-token rates → USD cost per LLM call.
// Pricing table sourced from documentation/COST_AWARE_ROUTING.md (verified 2026-05-03).
// Update the table when provider rates change.

export interface PricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
}

// Exact-match table. Keys are model identifiers as returned by each provider.
// For versioned models (e.g. claude-sonnet-4-5-20250929), the fuzzy matcher
// below falls back to the closest prefix match.
const PRICING: Record<string, PricingEntry> = {
  // ── DeepSeek ─────────────────────────────────────
  'deepseek-v3': { inputPerMillion: 0.27, outputPerMillion: 1.10 },
  'deepseek-v3.2': { inputPerMillion: 0.27, outputPerMillion: 1.10 },
  'deepseek-v4-flash': { inputPerMillion: 0.27, outputPerMillion: 1.10 },
  'deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.10 },
  'deepseek-r1': { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  'deepseek-reasoner': { inputPerMillion: 0.55, outputPerMillion: 2.19 },

  // ── Anthropic Claude ─────────────────────────────
  // Haiku family
  'claude-haiku-4-5': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'claude-3-5-haiku': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  // Sonnet family
  'claude-sonnet-4-7': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-sonnet-4-6': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-sonnet-4-5': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-3-5-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  // Opus family
  'claude-opus-4-8': { inputPerMillion: 5.00, outputPerMillion: 25.00 },
  'claude-opus-4-7': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-opus-4-6': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-3-opus': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  // Fable family (free for this account until 2026-06-22 — router prefers it
  // during the window; this entry prices post-window usage)
  'claude-fable-5': { inputPerMillion: 10.00, outputPerMillion: 50.00 },

  // ── Moonshot / Kimi ──────────────────────────────
  'moonshot-v1-8k': { inputPerMillion: 0.20, outputPerMillion: 2.00 },
  'moonshot-v1-32k': { inputPerMillion: 0.50, outputPerMillion: 5.00 },
  'moonshot-v1-128k': { inputPerMillion: 2.00, outputPerMillion: 20.00 },
  'kimi-k2': { inputPerMillion: 0.20, outputPerMillion: 2.00 },
  'kimi-k2.6': { inputPerMillion: 0.20, outputPerMillion: 2.00 },
  // OpenRouter-hosted free K2 slug (Kimi lane via OPENROUTER_API_KEY, no paid
  // Moonshot key). Free tier bills $0; a paid OpenRouter slug needs its own entry.
  'moonshotai/kimi-k2:free': { inputPerMillion: 0, outputPerMillion: 0 },

  // ── Google Gemini ────────────────────────────────
  // Class-B free-tier gateway provider (research/bulk lane). Rates below
  // price PAID-tier usage past the free quota — AI Studio's free tier bills
  // $0 until the per-model rate limit, at which point these apply.
  'gemini-2.0-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30 },
  'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },
};

/** Providers that don't bill per token (local Ollama, CLI). */
const FREE_PROVIDERS = new Set(['ollama', 'claude-cli', 'claude-bridge']);

/**
 * Anthropic prompt-cache pricing multipliers (Phase 5d).
 * - Cache WRITE (creating a fresh cache entry): 1.25× the normal input price.
 * - Cache READ (hitting an existing entry): 0.10× the normal input price.
 *
 * Source: Anthropic pricing page, 5-minute ephemeral cache tier. The
 * 1-hour extended cache has different multipliers (2.0× write, 0.10× read)
 * — we use 5-min defaults because that matches the SDK's `ephemeral` type.
 */
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.10;

/**
 * Phase 5f — Anthropic Message Batches API multiplier. Applied uniformly to
 * input, output, cache-write, and cache-read costs. Stacks with cache pricing:
 * a batched cache read pays 0.5 × 0.10 = 0.05× normal input rate.
 *
 * Only relevant for the Anthropic provider; other providers don't offer batch
 * pricing today.
 */
const BATCH_MULT = 0.5;

/**
 * Estimate USD cost for an LLM call.
 *
 * Returns 0 when:
 * - Provider is local/free (ollama, claude-cli, claude-bridge)
 * - Model is unknown (no pricing entry, no fuzzy match)
 * - Token counts are missing
 *
 * Always returns a non-negative number. Callers can rely on `costUsd` being
 * present and additive.
 *
 * Phase 5d — when prompt caching is engaged on Anthropic, the response carries
 * additional token counts (cache create + cache read). Pass them as the
 * optional 5th / 6th args to charge them at the cache-tier multipliers.
 * Non-cached input tokens still pay full price.
 */
export function estimateCost(
  provider: string,
  model: string | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheCreationTokens?: number,
  cacheReadTokens?: number,
  batchMode?: boolean,
): number {
  if (FREE_PROVIDERS.has(provider)) return 0;
  if (!model) return 0;

  const tokensIn = Number.isFinite(inputTokens) && (inputTokens as number) >= 0 ? (inputTokens as number) : 0;
  const tokensOut = Number.isFinite(outputTokens) && (outputTokens as number) >= 0 ? (outputTokens as number) : 0;
  const tokensCacheCreate = Number.isFinite(cacheCreationTokens) && (cacheCreationTokens as number) >= 0 ? (cacheCreationTokens as number) : 0;
  const tokensCacheRead = Number.isFinite(cacheReadTokens) && (cacheReadTokens as number) >= 0 ? (cacheReadTokens as number) : 0;
  if (tokensIn === 0 && tokensOut === 0 && tokensCacheCreate === 0 && tokensCacheRead === 0) return 0;

  const pricing = lookupPricing(model);
  if (!pricing) return 0;

  const inputCost = (tokensIn / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (tokensOut / 1_000_000) * pricing.outputPerMillion;
  const cacheWriteCost = (tokensCacheCreate / 1_000_000) * pricing.inputPerMillion * CACHE_WRITE_MULT;
  const cacheReadCost = (tokensCacheRead / 1_000_000) * pricing.inputPerMillion * CACHE_READ_MULT;
  const subtotal = inputCost + outputCost + cacheWriteCost + cacheReadCost;
  return batchMode ? subtotal * BATCH_MULT : subtotal;
}

/**
 * Resolve a model identifier to its pricing entry.
 * Tries exact match first, then prefix match against known keys (so
 * `claude-sonnet-4-5-20250929` resolves to `claude-sonnet-4-5`).
 */
function lookupPricing(model: string): PricingEntry | null {
  const normalized = model.toLowerCase();
  if (PRICING[normalized]) return PRICING[normalized];

  // Prefix match — keys sorted longest-first so more-specific matches win.
  const keys = Object.keys(PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.startsWith(key)) return PRICING[key];
  }
  return null;
}

/** Expose for tests / dashboard inspection. Not for routing decisions. */
export function getPricingTable(): Readonly<Record<string, PricingEntry>> {
  return PRICING;
}

/** Exposed for dashboard/cost docs. Cache pricing multipliers vs base input rate. */
export function getCacheMultipliers(): Readonly<{ write: number; read: number }> {
  return { write: CACHE_WRITE_MULT, read: CACHE_READ_MULT };
}

/** Exposed for dashboard/cost docs. Anthropic batch pricing multiplier vs realtime. */
export function getBatchMultiplier(): number {
  return BATCH_MULT;
}

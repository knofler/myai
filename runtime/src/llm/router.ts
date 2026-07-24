/**
 * Tier-based LLM routing.
 *
 * Maps workloads (agent name, channel type, tool name, complexity score) to
 * provider + model + fallback chain. The routing table follows the cost-aware
 * routing plan in `documentation/COST_AWARE_ROUTING.md`:
 *
 *   Tier 0 (skip-LLM)  : templates / grep / fs — tried before LLM calls
 *   Budget              : DeepSeek V3 or Haiku 4.5 — scheduled tools, Telegram
 *   Standard            : Sonnet 4.6 — generic agent invocations
 *   Premium             : Sonnet 4.6 + prompt caching — solution-architect, refactors
 *   Ultra               : Opus 4.6 (gated) — tech-lead final PR review
 *   Fable               : Fable 5 — the free Max 20x runner workhorse (see below)
 *   Kimi                : Moonshot Kimi — wired placeholder, DISABLED until a token lands
 *
 * The router does NOT dispatch LLM calls — it only decides which provider and
 * model to use. Callers feed the `RoutingDecision` into `provider.ts` which
 * handles actual dispatch + resilience + fallback chains.
 *
 * Env overrides:
 *   LLM_TIER_DEFAULT       — force a default tier ('budget' | 'standard' | 'premium' | 'ultra' | 'fable' | 'kimi')
 *   FABLE_FREE_UNTIL       — ISO timestamp ending the Fable free window (default 2026-06-22T23:59:59Z)
 *   FABLE_WINDOW_DISABLED  — set to '1' to opt out of the Fable free-window override
 *   MOONSHOT_API_KEY       — presence enables the 'kimi' tier; absent -> transparently
 *                            falls back to 'budget' (deepseek)
 *
 * Fable free window: until FABLE_FREE_UNTIL, every decision is overridden to
 * claude-fable-5 on the Anthropic API (free for this account during the
 * window). The override auto-reverts by date check — no code change needed on
 * 2026-06-22; routing falls back to the tier table the moment the window ends.
 *
 * Complexity-level routing (plan/jam/multi-lane-distribution.md, P1b): a
 * coarser, named alternative to the numeric 0-1 `complexity` score —
 * trivial/low/standard/high/critical — each mapped to a distinct tier for
 * unattended 'runner' execution (the free-time CLI runner) vs 'interactive'
 * execution (a user-present session). DeepSeek is restricted to trivial work;
 * Fable is the runner's default workhorse for standard/high; high escalates to
 * Opus if the runner-side attempt stalls; critical/novel is NEVER autonomized
 * — it always resolves to an interactive Opus decision regardless of the
 * requested mode (see `autonomizable` on `RoutingDecision`).
 */

import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'llm-router' });

// ── Public types ────────────────────────────────────────────

export type RoutingTier = 'budget' | 'standard' | 'premium' | 'ultra' | 'fable' | 'kimi';

/** Named complexity buckets from plan/jam/multi-lane-distribution.md. */
export type ComplexityLevel = 'trivial' | 'low' | 'standard' | 'high' | 'critical';

/** Whether the call runs unattended (the free-time runner) or with a user present. */
export type ExecutionMode = 'runner' | 'interactive';

export interface RoutingContext {
  /** Explicit tier override — skips all heuristic mapping. */
  tier?: RoutingTier;
  /** Agent name (e.g. 'solution-architect', 'tech-lead'). */
  agent?: string;
  /** Channel through which the request arrived. */
  channelType?: string; // 'telegram' | 'scheduler' | 'mcp' | 'websocket'
  /** MCP tool name being executed (e.g. 'morning_sweep'). */
  tool?: string;
  /** Complexity score between 0 and 1. When >= 0.8, tier upgrades to premium. */
  complexity?: number;
  /**
   * Named complexity level (trivial..critical) — takes priority over
   * agent/channel/tool mapping, one step below an explicit `tier` override.
   * Resolved together with `mode` via the complexity->model map.
   */
  complexityLevel?: ComplexityLevel;
  /**
   * Execution mode for `complexityLevel` resolution. Defaults to 'runner' for
   * the scheduler channel, 'interactive' otherwise. Ignored unless
   * `complexityLevel` is also set.
   */
  mode?: ExecutionMode;
}

export interface RoutingDecision {
  /** Provider mode identifier matching `LLM_MODE` values in provider.ts. */
  provider: string; // 'api' | 'deepseek' | 'moonshot' | 'ollama'
  /** Model identifier to use for the call. */
  model: string;
  /** Ordered fallback chain of provider modes (first entry is the primary). */
  chain: string[];
  /** Whether prompt caching should be enabled for this call. */
  cacheable: boolean;
  /** Whether batch dispatch (Anthropic Message Batches API) is allowed. */
  batchable: boolean;
  /** Human-readable explanation of why this routing was chosen. */
  reason: string;
  /**
   * False only for 'critical' complexity — the caller (dispatch cycle) MUST
   * NOT run this decision unattended and must queue it for an interactive
   * session instead. True (the default) for every other path.
   */
  autonomizable: boolean;
  /**
   * Present only for a 'high'-complexity runner decision: the model to
   * escalate to (Opus) if the Fable attempt stalls rather than erroring
   * cleanly — a hint for the dispatch cycle's stall-handling, not consulted
   * by route() itself.
   */
  escalateTo?: string;
}

// ── Model identifiers ───────────────────────────────────────

const MODELS = {
  budget_haiku: 'claude-haiku-4-5',
  budget_deepseek: 'deepseek-chat',
  standard: 'claude-sonnet-4-6',
  premium: 'claude-sonnet-4-6',
  ultra: 'claude-opus-4-8',
  fable: 'claude-fable-5',
  // Moonshot's default model (config.ts `moonshotModel`) — kept in sync so the
  // 'kimi' tier and the failover-injection path never diverge on model id.
  kimi: 'kimi-k2.6',
} as const;

// ── Fable free window ───────────────────────────────────────
//
// claude-fable-5 is free for this account until 2026-06-22. While the window
// is open, all routing decisions are overridden to Fable on the Anthropic API
// — "aggressive on Fable, conservative on paid" (user directive 2026-06-12).
// After the window closes the override is a no-op and tier routing resumes.

const FABLE_FREE_UNTIL_DEFAULT = '2026-06-22T23:59:59Z';

/** True while the Fable free window is open (env-tunable, auto-reverting). */
export function isFableWindowActive(now: Date = new Date()): boolean {
  if (process.env.FABLE_WINDOW_DISABLED === '1') return false;
  const raw = process.env.FABLE_FREE_UNTIL || FABLE_FREE_UNTIL_DEFAULT;
  const until = new Date(raw);
  if (Number.isNaN(until.getTime())) return false;
  return now < until;
}

// ── Tier definitions (provider, model, chain, cache, batch) ─

interface TierConfig {
  provider: string;
  model: string;
  chain: string[];
  cacheable: boolean;
  batchable: boolean;
}

const TIER_CONFIGS: Record<RoutingTier, TierConfig> = {
  budget: {
    provider: 'deepseek',
    model: MODELS.budget_deepseek,
    chain: ['deepseek', 'api'],
    cacheable: false,
    batchable: true,
  },
  standard: {
    provider: 'api',
    model: MODELS.standard,
    chain: ['api', 'deepseek'],
    cacheable: false,
    batchable: false,
  },
  premium: {
    provider: 'api',
    model: MODELS.premium,
    chain: ['api'],
    cacheable: true,
    batchable: false,
  },
  ultra: {
    provider: 'api',
    model: MODELS.ultra,
    chain: ['api'],
    cacheable: true,
    batchable: false,
  },
  fable: {
    provider: 'api',
    // Fable is Opus-class quality on the free Max 20x subscription window —
    // the runner's default workhorse (plan/jam/multi-lane-distribution.md).
    // deepseek is the backstop so a Fable outage/window-close never stalls
    // the queue ("keep chains for fallback so nothing stalls").
    model: MODELS.fable,
    chain: ['api', 'deepseek'],
    cacheable: true,
    batchable: false,
  },
  kimi: {
    // DISABLED placeholder until a Moonshot token lands — see
    // isKimiConfigured(). Wired now so agentMap/channelMap/complexity routing
    // can reference it ahead of time; route() transparently demotes any
    // resolution to 'kimi' back to 'budget' (deepseek) while unconfigured.
    provider: 'moonshot',
    model: MODELS.kimi,
    chain: ['moonshot', 'deepseek', 'api'],
    cacheable: false,
    batchable: true,
  },
};

// ── Agent → tier mapping ────────────────────────────────────

const AGENT_TIER_MAP: Record<string, RoutingTier> = {
  // Premium agents — complex multi-file work, architecture decisions
  'solution-architect': 'premium',
  'frontend-specialist': 'standard',
  'api-specialist': 'standard',
  'database-specialist': 'standard',
  'devops-specialist': 'standard',
  'security-specialist': 'premium',

  // Ultra — gated to PR review only (but agent name signals it)
  'tech-lead': 'ultra',

  // Standing agents — scheduled autonomous work. Default to Fable (free,
  // Opus-class, the runner's workhorse per plan/jam/multi-lane-distribution.md)
  // rather than paid deepseek/api; pass complexityLevel: 'trivial' for
  // genuinely mechanical runs to get deepseek/ollama instead — deepseek is
  // restricted to trivial work.
  'standing-pr-reviewer': 'fable',
  'standing-doc-gardener': 'fable',
  'standing-dep-watcher': 'fable',
  'standing-security-auditor': 'fable',
  'standing-status-reporter': 'fable',
};

// ── Channel → tier mapping ──────────────────────────────────

const CHANNEL_TIER_MAP: Record<string, RoutingTier> = {
  telegram: 'budget',   // Speed > cost; Haiku 4.5 primary, DeepSeek fallback
  scheduler: 'fable',   // Runner's default workhorse — free Max 20x Fable, not paid api
  mcp: 'standard',      // Standard agent invocations
  websocket: 'standard',
};

// ── Channel-specific overrides (different primary for some channels) ──

const CHANNEL_OVERRIDES: Record<string, Partial<TierConfig>> = {
  // Telegram: Haiku primary (lower latency) → DeepSeek fallback
  telegram: {
    provider: 'api',
    model: MODELS.budget_haiku,
    chain: ['api', 'deepseek'],
  },
};

// ── Tool → batchable + tier mapping ─────────────────────────

interface ToolRouting {
  tier: RoutingTier;
  batchable: boolean;
}

const TOOL_ROUTING_MAP: Record<string, ToolRouting> = {
  morning_sweep: { tier: 'budget', batchable: true },
  evening_sweep: { tier: 'budget', batchable: false },
  health_check: { tier: 'budget', batchable: true },
  audit_schedule: { tier: 'budget', batchable: true },
};

// ── Complexity threshold ────────────────────────────────────

const COMPLEXITY_UPGRADE_THRESHOLD = 0.8;

// ── Complexity-level → model map (plan/jam/multi-lane-distribution.md P1b) ──

interface ComplexityRouting {
  /** Tier selected when running unattended via the free-time CLI runner. */
  runner: RoutingTier;
  /** Tier selected when a user is present in an interactive session. */
  interactive: RoutingTier;
  /** Runner-side escalation target if the primary attempt stalls ('high' only). */
  escalateOnStall?: RoutingTier;
  /** False only for critical/novel — must never run unattended. */
  autonomizable: boolean;
}

const COMPLEXITY_MODEL_MAP: Record<ComplexityLevel, ComplexityRouting> = {
  // deepseek restricted to trivial — ollama is an equally valid free local
  // alternative for the same bucket, chosen by the caller's provider config.
  trivial: { runner: 'budget', interactive: 'budget', autonomizable: true },
  // 'kimi' here is the intended steady state; while unconfigured (no
  // MOONSHOT_API_KEY) route() transparently demotes it to 'budget' (deepseek)
  // — "low -> deepseek (-> kimi later)".
  low: { runner: 'kimi', interactive: 'standard', autonomizable: true },
  standard: { runner: 'fable', interactive: 'standard', autonomizable: true },
  high: { runner: 'fable', interactive: 'ultra', escalateOnStall: 'ultra', autonomizable: true },
  // Critical/novel is NEVER autonomized — always resolves interactive
  // regardless of the requested mode; see resolveComplexityTier().
  critical: { runner: 'ultra', interactive: 'ultra', autonomizable: false },
};

/** Resolve a named complexity level + execution mode to a tier + explanation. */
function resolveComplexityTier(
  level: ComplexityLevel,
  mode: ExecutionMode,
): { tier: RoutingTier; reason: string; autonomizable: boolean; escalateTo?: string } {
  const routing = COMPLEXITY_MODEL_MAP[level];

  if (!routing.autonomizable) {
    return {
      tier: routing.interactive,
      reason: `complexity '${level}' is never autonomized -> queued for interactive review, not the runner`,
      autonomizable: false,
    };
  }

  const tier = mode === 'runner' ? routing.runner : routing.interactive;
  const escalateTo = mode === 'runner' && routing.escalateOnStall
    ? TIER_CONFIGS[routing.escalateOnStall].model
    : undefined;

  return {
    tier,
    reason: `complexity '${level}' (${mode}) -> ${tier} tier` + (escalateTo ? ` (escalate to ${escalateTo} if stalled)` : ''),
    autonomizable: true,
    escalateTo,
  };
}

// ── Core routing function ───────────────────────────────────

/**
 * Determine the optimal provider, model, and fallback chain for a given
 * routing context. Evaluates signals in priority order:
 *
 *   1. Explicit `tier` override in context
 *   2. Named `complexityLevel` + `mode` (trivial..critical -> complexity map)
 *   3. Tool-specific routing (morning_sweep, etc.)
 *   4. Agent-specific tier mapping
 *   5. Channel-specific tier mapping
 *   6. `LLM_TIER_DEFAULT` env var
 *   7. Fallback to 'standard' tier
 *
 * After tier resolution, complexity >= 0.8 upgrades budget/standard to premium,
 * and an unconfigured 'kimi' tier is demoted to 'budget' (deepseek).
 */
export function route(ctx: RoutingContext = {}): RoutingDecision {
  let tier: RoutingTier;
  let reason: string;
  let autonomizable = true;
  let escalateTo: string | undefined;

  // 1. Explicit tier override (validate — callers may pass arbitrary
  //    strings via MCP args; an invalid tier must not crash routing)
  if (ctx.tier && isValidTier(ctx.tier)) {
    tier = ctx.tier;
    reason = `explicit tier override: ${tier}`;
  }
  // 2. Named complexity level (takes the mode from ctx.mode, defaulting to
  //    'runner' for the scheduler channel and 'interactive' otherwise)
  else if (ctx.complexityLevel && ctx.complexityLevel in COMPLEXITY_MODEL_MAP) {
    const mode: ExecutionMode = ctx.mode ?? (ctx.channelType === 'scheduler' ? 'runner' : 'interactive');
    const resolved = resolveComplexityTier(ctx.complexityLevel, mode);
    tier = resolved.tier;
    reason = resolved.reason;
    autonomizable = resolved.autonomizable;
    escalateTo = resolved.escalateTo;
  }
  // 3. Tool-specific routing
  else if (ctx.tool && ctx.tool in TOOL_ROUTING_MAP) {
    const toolConfig = TOOL_ROUTING_MAP[ctx.tool];
    tier = toolConfig.tier;
    reason = `tool '${ctx.tool}' mapped to ${tier}`;
  }
  // 4. Agent-specific tier
  else if (ctx.agent && ctx.agent in AGENT_TIER_MAP) {
    tier = AGENT_TIER_MAP[ctx.agent];
    reason = `agent '${ctx.agent}' mapped to ${tier}`;
  }
  // 5. Channel-specific tier
  else if (ctx.channelType && ctx.channelType in CHANNEL_TIER_MAP) {
    tier = CHANNEL_TIER_MAP[ctx.channelType];
    reason = `channel '${ctx.channelType}' mapped to ${tier}`;
  }
  // 6. LLM_TIER_DEFAULT env var
  else if (process.env.LLM_TIER_DEFAULT && isValidTier(process.env.LLM_TIER_DEFAULT)) {
    tier = process.env.LLM_TIER_DEFAULT as RoutingTier;
    reason = `LLM_TIER_DEFAULT env: ${tier}`;
  }
  // 7. Default
  else {
    tier = 'standard';
    reason = 'default tier';
  }

  // Kimi is a wired placeholder (provider: moonshot) — DISABLED until a
  // Moonshot token lands. Any path resolving to 'kimi' before a key is
  // configured falls back to the deepseek-primary budget tier rather than
  // dispatching through an unconfigured provider.
  if (tier === 'kimi' && !isKimiConfigured()) {
    reason += ' -> kimi disabled (no MOONSHOT_API_KEY yet), falling back to deepseek';
    tier = 'budget';
  }

  // Complexity upgrade: budget/standard → premium when complexity >= 0.8
  if (
    typeof ctx.complexity === 'number' &&
    ctx.complexity >= COMPLEXITY_UPGRADE_THRESHOLD &&
    (tier === 'budget' || tier === 'standard')
  ) {
    const originalTier = tier;
    tier = 'premium';
    reason += ` -> upgraded to premium (complexity ${ctx.complexity.toFixed(2)} >= ${COMPLEXITY_UPGRADE_THRESHOLD})`;
    log.info(
      { originalTier, upgradedTier: tier, complexity: ctx.complexity },
      'Complexity upgrade applied',
    );
  }

  // Build the decision from the tier config.
  // NOTE: clone `chain` explicitly — a shallow `{ ...config }` copies the array
  // by reference, so any in-place mutation below would corrupt the shared
  // TIER_CONFIGS const for every subsequent call.
  const config = { ...TIER_CONFIGS[tier], chain: [...TIER_CONFIGS[tier].chain] };

  // Apply channel-specific overrides (e.g. Telegram uses Haiku primary within budget tier)
  if (ctx.channelType && ctx.channelType in CHANNEL_OVERRIDES && tier === 'budget') {
    const override = CHANNEL_OVERRIDES[ctx.channelType];
    if (override.provider) config.provider = override.provider;
    if (override.model) config.model = override.model;
    if (override.chain) config.chain = [...override.chain];
    reason += ` (channel override: ${ctx.channelType})`;
  }

  // Provider diversity / failover (2026-07-17): when a Moonshot/Kimi key is
  // configured, insert it into the fallback chain immediately AHEAD of the paid
  // Anthropic API — spend cheap alternative-provider capacity before premium
  // Claude spend, and give the budget/standard tiers a second non-Anthropic
  // provider so a DeepSeek outage doesn't fall straight through to paid Claude.
  // Skipped entirely when unkeyed, so no wasted failed attempts until Kimi is
  // set up. See plan/MULTI_PROVIDER_ORCHESTRATION.md.
  if (process.env.MOONSHOT_API_KEY && !config.chain.includes('moonshot')) {
    const apiIdx = config.chain.indexOf('api');
    if (apiIdx >= 0) config.chain.splice(apiIdx, 0, 'moonshot');
    else config.chain.push('moonshot');
    reason += ' (+kimi failover)';
  }

  // Tool-specific batchable override
  let batchable = config.batchable;
  if (ctx.tool && ctx.tool in TOOL_ROUTING_MAP) {
    batchable = TOOL_ROUTING_MAP[ctx.tool].batchable;
  }

  const decision: RoutingDecision = {
    provider: config.provider,
    model: config.model,
    chain: [...config.chain],
    cacheable: config.cacheable,
    batchable,
    reason,
    autonomizable,
    ...(escalateTo ? { escalateTo } : {}),
  };

  // Fable free-window override: while open, every call routes to claude-fable-5
  // on the Anthropic API. DeepSeek stays in the chain as a fallback. Prompt
  // caching on: Fable calls are free during the window, and post-window the
  // cache discount applies. Auto-reverts when the window closes (date check).
  if (isFableWindowActive()) {
    decision.provider = 'api';
    decision.model = MODELS.fable;
    decision.chain = ['api', ...decision.chain.filter((p) => p !== 'api')];
    decision.cacheable = true;
    decision.reason += ` -> Fable free window override (claude-fable-5 until ${process.env.FABLE_FREE_UNTIL || FABLE_FREE_UNTIL_DEFAULT})`;
  }

  log.debug({ ctx, decision }, 'Routing decision');

  return decision;
}

// ── Dashboard / inspection ──────────────────────────────────

export interface RoutingConfig {
  tiers: Record<RoutingTier, TierConfig>;
  agentMap: Record<string, RoutingTier>;
  channelMap: Record<string, RoutingTier>;
  channelOverrides: Record<string, Partial<TierConfig>>;
  toolMap: Record<string, ToolRouting>;
  complexityThreshold: number;
  /** Named complexity->tier map (plan/jam/multi-lane-distribution.md P1b). */
  complexityMap: Record<ComplexityLevel, ComplexityRouting>;
  envDefault: string | undefined;
  fableWindow: { active: boolean; until: string; model: string };
  /** Kimi (Moonshot) tier status — enabled once MOONSHOT_API_KEY is set. */
  kimiTier: { enabled: boolean; provider: string; model: string };
}

/**
 * Return the full routing configuration for dashboard inspection or debugging.
 * Read-only snapshot — mutations do not affect routing behavior.
 */
export function getRoutingConfig(): RoutingConfig {
  return {
    tiers: structuredClone(TIER_CONFIGS),
    agentMap: { ...AGENT_TIER_MAP },
    channelMap: { ...CHANNEL_TIER_MAP },
    channelOverrides: structuredClone(CHANNEL_OVERRIDES),
    toolMap: { ...TOOL_ROUTING_MAP },
    complexityThreshold: COMPLEXITY_UPGRADE_THRESHOLD,
    complexityMap: structuredClone(COMPLEXITY_MODEL_MAP),
    envDefault: process.env.LLM_TIER_DEFAULT,
    fableWindow: {
      active: isFableWindowActive(),
      until: process.env.FABLE_FREE_UNTIL || FABLE_FREE_UNTIL_DEFAULT,
      model: MODELS.fable,
    },
    kimiTier: {
      enabled: isKimiConfigured(),
      provider: TIER_CONFIGS.kimi.provider,
      model: TIER_CONFIGS.kimi.model,
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────

const VALID_TIERS = new Set<string>(['budget', 'standard', 'premium', 'ultra', 'fable', 'kimi']);

function isValidTier(value: string): value is RoutingTier {
  return VALID_TIERS.has(value);
}

/** True once a Moonshot/Kimi API key is configured — until then the 'kimi'
 *  tier is a wired placeholder that transparently falls back to deepseek. */
export function isKimiConfigured(): boolean {
  return !!process.env.MOONSHOT_API_KEY;
}

import { z } from 'zod';

// ── Gateway Message ─────────────────────────────────────

export const MessageRole = z.enum(['user', 'assistant', 'system', 'channel']);
export type MessageRole = z.infer<typeof MessageRole>;

export const GatewayMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  role: MessageRole,
  content: z.string(),
  agentName: z.string().optional(),
  channelType: z.string().optional(),
  channelId: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
  timestamp: z.date().default(() => new Date()),
});
export type GatewayMessage = z.infer<typeof GatewayMessageSchema>;

// ── Session ─────────────────────────────────────────────

export const SessionStatus = z.enum(['active', 'idle', 'compacting', 'closed']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export interface Session {
  id: string;
  /** Owning tenant (ADR-010 §3.5). Stamped on create; scopes every DB write. */
  tenantId: string;
  agentName: string;
  status: SessionStatus;
  messages: GatewayMessage[];
  workspace: string;
  createdAt: Date;
  lastActivity: Date;
  metadata: Record<string, unknown>;
}

// ── Agent Definition ────────────────────────────────────

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  category: string;
  instructions: string;
  filePath: string;
}

// ── Skill Definition ────────────────────────────────────

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  playbook: string;
  filePath: string;
}

// ── WebSocket Protocol ──────────────────────────────────

export const WsMessageType = z.enum([
  'session.create',
  'session.message',
  'session.close',
  'session.list',
  'session.export',
  'session.import',
  'session.recall',
  'agent.list',
  'agent.detail',
  'ping',
  'pong',
  'error',
  'event',
]);
export type WsMessageType = z.infer<typeof WsMessageType>;

export const WsIncoming = z.object({
  type: WsMessageType,
  id: z.string().optional(),
  sessionId: z.string().optional(),
  agentName: z.string().optional(),
  content: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  // betaC context-sharing: session.import carries the export bundle; session.recall
  // carries optional { agentName, limit, perSessionMessages } in metadata.
  bundle: z.unknown().optional(),
  preserveId: z.boolean().optional(),
});
export type WsIncoming = z.infer<typeof WsIncoming>;

export interface WsOutgoing {
  type: WsMessageType;
  id?: string;
  sessionId?: string;
  data?: unknown;
  error?: string;
  timestamp: string;
}

// ── Config ──────────────────────────────────────────────

export interface GatewayConfig {
  server: {
    httpPort: number;
    wsPort: number;
    host: string;
  };
  database: {
    uri: string;
    name: string;
    /** Read-side failover posture (MONGO_MIRROR.md). 'local' = on primary
     *  connect failure, fall back to the local mirror in an explicit, logged,
     *  READ-ONLY degraded mode. Never automatic — opt-in via MYAI_DB_FAILOVER. */
    failover: 'none' | 'local';
    /** Local-mirror URI used when failover fires. Defaults to the compose
     *  local mongo (`mongo` service host) when unset. */
    failoverUri?: string;
  };
  aiRoot: string;
  sessions: {
    compactionThreshold: number;
    compactionKeepRecent: number;
    idleTimeoutMinutes: number;
    maxConcurrentSessions: number;
  };
  memory: {
    embedding: {
      provider: 'local' | 'openai';
      model: string;
      dimensions: number;
    };
    search: {
      topN: number;
      weights: {
        vector: number;
        tagOverlap: number;
        confidence: number;
        recency: number;
      };
    };
  };
  hooks: {
    enableBashCompat: boolean;
    bashHooksDir: string;
    userHooksDir: string;
    defaultTimeout: number;
  };
  llm: {
    enabled: boolean;
    mode: 'bridge' | 'direct' | 'api' | 'deepseek' | 'moonshot' | 'gemini' | 'ollama';
    /** Comma-separated provider chain for auto-fallback. When set and the
     * primary mode call fails with a recoverable network error
     * (ECONNRESET / ENETUNREACH / ETIMEDOUT / fetch-network), the router walks
     * through this chain in order. Empty/unset = no fallback (legacy behavior). */
    modeChain?: string[];
    bridgeUrl: string;
    timeoutMs: number;
    apiKey?: string;
    model?: string;
    deepseekApiKey?: string;
    deepseekModel?: string;
    moonshotApiKey?: string;
    moonshotModel?: string;
    /** Override the Moonshot base URL (MOONSHOT_BASE_URL) — point the Kimi
     * lane at any OpenAI-compatible host without a code change. */
    moonshotBaseUrl?: string;
    /** OpenRouter backend for the Kimi lane (OPENROUTER_API_KEY) — free K2
     * without a paid Moonshot key. Direct Moonshot wins when both are set. */
    openrouterApiKey?: string;
    /** OpenRouter model slug (OPENROUTER_MODEL) — default `moonshotai/kimi-k2:free`. */
    openrouterModel?: string;
    /** OpenRouter base URL override (OPENROUTER_BASE_URL). */
    openrouterBaseUrl?: string;
    geminiApiKey?: string;
    geminiModel?: string;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
    /** Phase 5d — enable Anthropic prompt caching for the `api` provider.
     * Marks system prompt + tools list with `cache_control: ephemeral` on
     * every call so subsequent identical-prefix calls within 5 min are
     * charged at 0.10× input rate. Default true (pure cost win; SDK
     * silently ignores cache markers on blocks below the model's minimum
     * cacheable size). Override via `PROMPT_CACHE_ENABLED=false`. */
    promptCacheEnabled: boolean;
    /** Phase 5f — enable Anthropic Message Batches API for non-realtime
     * dispatchers. Today only `morning_sweep` opts in (the scheduler ships
     * a daily report; latency-tolerant by definition). When true AND the
     * Anthropic provider is configured AND topN ≥ 2, the sweep submits a
     * single batch instead of N synchronous calls. 50% discount on input +
     * output, stacked with prompt-cache. Override via `BATCH_ENABLED=false`. */
    batchEnabled: boolean;
  };
  channels: {
    telegram: {
      enabled: boolean;
      token: string;
      allowedChatIds: string[];
    };
    discord: {
      enabled: boolean;
      token: string;
      allowedChannelIds: string[];
    };
  };
  /**
   * Chat-mode tool-use config. When `enabled` and the inbound `channelId`
   * is in `allowedChatIds`, the channel-mode message-router wires a curated
   * subset of MCP tools (see `runtime/src/tools/chat-tools.ts:CHAT_MODE_TOOL_WHITELIST`)
   * into the LLM call so Telegram/Discord users can trigger real tool execution
   * (memory search, state read, repo status, task list/create, etc.).
   *
   * Requires Anthropic provider — DeepSeek/Moonshot/Ollama don't run the
   * tool-use loop. `LLM_MODE=api` (or `api` in `LLM_MODE_CHAIN`) is the
   * minimum prerequisite.
   *
   * Per-tool execution is whitelist-enforced by `executeChatTool` and
   * audit-logged via the structured logger.
   */
  chatTools: {
    enabled: boolean;
    allowedChatIds: string[];
    /** Hard cap on how many tool-use iterations a single user turn may consume. */
    maxIterations: number;
  };
  /**
   * Phase 5b — Budget guards + tier downgrade.
   *
   * When `enabled`, the message-router consults `applyBudgetGuard` before
   * every LLM call to block (hard caps) or rewrite the model (soft caps).
   * Defaults to **off** — when disabled, the guard returns `allow:true`
   * synchronously with no DB query, so behavior is byte-identical to
   * pre-Phase-5b for any deployment that hasn't opted in.
   *
   * Caps are env-driven only. There is no admin endpoint to mutate them
   * from a running gateway: changing a cap requires a restart. This is
   * deliberate — a compromised admin token cannot disable guards.
   *
   * See `documentation/COST_AWARE_ROUTING.md` and
   * `plan/PHASE_5B_BUDGET_GUARDS.md` for the full design.
   */
  budgets: BudgetConfig;
  /**
   * M1 multi-tenancy (ADR-010). Row-level `tenantId` scoping for the gateway.
   *
   * Day-1 (data model) ships with `enforce: false` so behaviour is identical
   * to the single-tenant gateway: every scoped record defaults to
   * `defaultTenantId`, and the (later) auth middleware maps unauthenticated /
   * loopback callers to that same tenant. Flip `enforce: true` (hosted
   * multi-tenant) only once the auth layer + migration are in place — then an
   * unresolved credential is rejected with no default fallback.
   */
  tenancy: TenancyConfig;
  /**
   * Data-residency / region pinning (ADR-023). See {@link RegionConfig}.
   */
  region: RegionConfig;
  /**
   * Product-usage metering (ADR-014, S2). Controls the `UsageEvent` write path.
   * The meter is on by default (a Mongo insert at a chokepoint is operationally
   * free); flip `enabled: false` to disable all emission, or drop `sampleRate`
   * below 1 as a load-shed guard in non-billing environments. See MeteringConfig.
   */
  metering: MeteringConfig;
  /**
   * In-gateway inline execution path (MYAI_GATEWAY ph6). Runs short deterministic
   * tasks in-process via a whitelisted tool — no CLI-runner fire, no LLM spend.
   * Defaults to **off**; when disabled the inline path is a no-op and every task
   * falls through to the CLI runner / dispatch worker unchanged. See
   * `architecture/ADR-018-in-gateway-inline-execution.md`.
   */
  agentRuntime: AgentRuntimeConfig;
  logging: {
    level: string;
    pretty: boolean;
  };
}

/**
 * Config for the inline execution lane (ADR-018). All fields env-driven.
 */
export interface AgentRuntimeConfig {
  /** Master switch. When false, inline classification always returns ineligible. Env: INLINE_EXEC_ENABLED (default false). */
  inlineEnabled: boolean;
  /** Max inline executions per rolling window (quota bound). Env: INLINE_EXEC_QUOTA (default 20). */
  inlineQuotaPerWindow: number;
  /** Rolling-window length in seconds for the quota counter. Env: INLINE_EXEC_WINDOW_SEC (default 3600). */
  inlineWindowSeconds: number;
}

/**
 * Usage-metering config (ADR-014). The sampling guard: `enabled` gates all
 * emission; `sampleRate` (0..1) probabilistically drops events as a safety
 * valve when volume is unexpectedly high. Default `sampleRate: 1` records every
 * event — billable meters must not silently under-count, so <1 is only for
 * dev/non-billing environments and should be flagged in ops.
 */
export interface MeteringConfig {
  /** Master on/off. Env: METERING_ENABLED (default true). */
  enabled: boolean;
  /** Fraction of events to record, 0..1. Env: METERING_SAMPLE_RATE (default 1). */
  sampleRate: number;
}

/**
 * Tenancy config (ADR-010). See `architecture/ADR-010-multi-tenant-scoping.md`.
 */
export interface TenancyConfig {
  /** The tenant every existing/single-operator record maps to. Env: DEFAULT_TENANT_ID. Default: "default". */
  defaultTenantId: string;
  /** When false (default), unauthenticated/loopback callers resolve to `defaultTenantId`. When true, a valid per-tenant key is required. Env: TENANT_ENFORCE. */
  enforce: boolean;
  /** Shared secret that lets a non-loopback trusted caller (e.g. the CLI runner over the Docker bridge) act as `defaultTenantId`. When unset, the header bypass is disabled. Env: GATEWAY_LOCAL_TOKEN. */
  localToken?: string;
  /**
   * The PRIOR local token, kept valid until `previousLocalTokenExpiresAt` so a
   * rotation (`myai rotate-keys local`) has zero downtime — callers still
   * holding the old token keep working until the grace window elapses. Env:
   * GATEWAY_LOCAL_TOKEN_PREVIOUS.
   */
  previousLocalToken?: string;
  /** Epoch-ms cutoff after which `previousLocalToken` is rejected. Env: GATEWAY_LOCAL_TOKEN_PREVIOUS_EXPIRES_AT. */
  previousLocalTokenExpiresAt?: number;
}

/**
 * Data-residency / region pinning (ADR-023). Each region is served by its own
 * physical gateway deployment; `gatewayRegion` declares which one THIS process
 * is. `core/region-guard.ts` rejects a resolved (non-local) tenant whose
 * `Tenant.region` doesn't match — so a tenant pinned to `eu` can never have its
 * records read/written, or its off-hours runner tasks claimed, by a `us`- or
 * `au`-region gateway.
 */
export interface RegionConfig {
  /** Master switch. Default false — a single-region deployment never rejects on region. Env: REGION_ENFORCE. */
  enforce: boolean;
  /** Which region this gateway process serves. Unset → region-guard is a no-op regardless of `enforce`. Env: GATEWAY_REGION. */
  gatewayRegion?: 'us' | 'eu' | 'au';
}

/**
 * Budget-guard config (Phase 5b). All thresholds are fractions of
 * `monthlyHardCapUsd` (0..1). Order of checks in `applyBudgetGuard`:
 * monthly hard → daily hard → per-channel hard → soft-cap downgrade.
 *
 * `enabled: false` (default) → no DB queries, no rewrites, no recording.
 */
export interface BudgetConfig {
  /** Master switch. When false, guards are no-ops. Default: false. */
  enabled: boolean;
  /** Hard ceiling on month-to-date USD spend across all channels. */
  monthlyHardCapUsd: number;
  /** Hard ceiling on today's UTC USD spend across all channels. Field name kept per plan §3.2 even though semantically it is a daily cap. */
  monthlyDailyCapUsd: number;
  /** Optional per-channel monthly USD cap. When undefined, no per-channel ceiling. */
  perChannelMonthlyCapUsd?: number;
  /** Threshold (fraction of monthlyHardCapUsd) at which a soft warning is surfaced. Currently informational. */
  warnThreshold: number;
  /** Threshold at which `claude-opus-*` models are rewritten to `claude-sonnet-4-7`. */
  downgradeOpusThreshold: number;
  /** Threshold at which `claude-sonnet-*` models are rewritten to `claude-haiku-4-5`. */
  downgradeSonnetThreshold: number;
  /** Channel IDs that bypass all guards (ops/admin chats). Comma-separated env. */
  bypassChannelIds: string[];
}

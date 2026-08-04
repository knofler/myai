import { z } from 'zod';
import { createChildLogger } from './logger.js';
import type { GatewayConfig } from './types.js';

const log = createChildLogger({ module: 'config-validator' });

const PortSchema = z.number().int().min(1).max(65535);

const GatewayConfigSchema = z.object({
  server: z.object({
    httpPort: PortSchema,
    wsPort: PortSchema,
    host: z.string().min(1),
  }).refine(d => d.httpPort !== d.wsPort, {
    message: 'httpPort and wsPort must be different',
  }),
  database: z.object({
    uri: z.string().min(1),
    name: z.string().min(1),
    // Defaulted (not required) so hand-built configs predating the field stay valid.
    failover: z.enum(['none', 'local']).default('none'),
    failoverUri: z.string().min(1).optional(),
  }),
  aiRoot: z.string().min(1),
  sessions: z.object({
    compactionThreshold: z.number().int().min(1),
    compactionKeepRecent: z.number().int().min(1),
    idleTimeoutMinutes: z.number().int().min(1),
    maxConcurrentSessions: z.number().int().min(1),
  }),
  memory: z.object({
    embedding: z.object({
      provider: z.enum(['local', 'openai']),
      model: z.string().min(1),
      dimensions: z.number().int().min(1),
    }),
    search: z.object({
      topN: z.number().int().min(1),
      weights: z.object({
        vector: z.number().min(0).max(1),
        tagOverlap: z.number().min(0).max(1),
        confidence: z.number().min(0).max(1),
        recency: z.number().min(0).max(1),
      }),
    }),
  }),
  llm: z.object({
    enabled: z.boolean(),
    mode: z.enum(['bridge', 'direct', 'api', 'deepseek', 'moonshot', 'ollama']),
    modeChain: z.array(z.string()).optional(),
    bridgeUrl: z.string(),
    timeoutMs: z.number().int().min(1000).max(600_000),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    deepseekApiKey: z.string().optional(),
    deepseekModel: z.string().optional(),
    moonshotApiKey: z.string().optional(),
    moonshotModel: z.string().optional(),
    ollamaBaseUrl: z.string().optional(),
    ollamaModel: z.string().optional(),
    promptCacheEnabled: z.boolean(),
    batchEnabled: z.boolean(),
  }),
  channels: z.object({
    telegram: z.object({
      enabled: z.boolean(),
      token: z.string(),
      allowedChatIds: z.array(z.string()),
    }),
    discord: z.object({
      enabled: z.boolean(),
      token: z.string(),
      allowedChannelIds: z.array(z.string()),
    }),
  }),
  chatTools: z.object({
    enabled: z.boolean(),
    allowedChatIds: z.array(z.string()),
    maxIterations: z.number().int().min(1).max(50),
  }),
  budgets: z.object({
    enabled: z.boolean(),
    monthlyHardCapUsd: z.number().min(0),
    monthlyDailyCapUsd: z.number().min(0),
    perChannelMonthlyCapUsd: z.number().min(0).optional(),
    warnThreshold: z.number().min(0).max(1),
    downgradeOpusThreshold: z.number().min(0).max(1),
    downgradeSonnetThreshold: z.number().min(0).max(1),
    bypassChannelIds: z.array(z.string()),
  }),
  hooks: z.object({
    enableBashCompat: z.boolean(),
    bashHooksDir: z.string(),
    userHooksDir: z.string(),
    defaultTimeout: z.number().int().min(100),
  }),
  agentRuntime: z.object({
    inlineEnabled: z.boolean(),
    inlineQuotaPerWindow: z.number().int().min(0),
    inlineWindowSeconds: z.number().int().min(1),
  }),
  logging: z.object({
    level: z.string(),
    pretty: z.boolean(),
  }),
});

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateConfig(config: GatewayConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = GatewayConfigSchema.safeParse(config);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  // Semantic warnings (not schema errors)
  if (config.llm.enabled && config.llm.mode === 'api' && !config.llm.apiKey) {
    warnings.push('LLM enabled with mode=api but no ANTHROPIC_API_KEY set');
  }
  if (config.llm.enabled && config.llm.mode === 'deepseek' && !config.llm.deepseekApiKey) {
    warnings.push('LLM enabled with mode=deepseek but no DEEPSEEK_API_KEY set');
  }
  if (config.channels.telegram.enabled && !config.channels.telegram.token) {
    warnings.push('Telegram enabled but no bot token configured');
  }
  if (config.channels.discord.enabled && !config.channels.discord.token) {
    warnings.push('Discord enabled but no bot token configured');
  }
  if (config.budgets.enabled && config.budgets.monthlyHardCapUsd <= 0) {
    warnings.push('Budget guards enabled but monthlyHardCapUsd is 0 — all calls will be blocked');
  }
  if (config.budgets.downgradeOpusThreshold >= config.budgets.downgradeSonnetThreshold) {
    warnings.push('downgradeOpusThreshold >= downgradeSonnetThreshold — Opus downgrade may never trigger before Sonnet downgrade');
  }
  if (config.chatTools.enabled && !config.llm.apiKey) {
    warnings.push('Chat tools enabled but no Anthropic API key — tool-use loop requires the api provider');
  }

  const weights = config.memory.search.weights;
  const weightSum = weights.vector + weights.tagOverlap + weights.confidence + weights.recency;
  if (Math.abs(weightSum - 1.0) > 0.01) {
    warnings.push(`Search weights sum to ${weightSum.toFixed(2)} instead of 1.0 — results may be skewed`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateAndLog(config: GatewayConfig): boolean {
  const result = validateConfig(config);

  if (result.errors.length > 0) {
    log.error({ errors: result.errors }, 'Config validation failed');
  }
  for (const w of result.warnings) {
    log.warn(w);
  }
  if (result.valid && result.warnings.length === 0) {
    log.info('Config validation passed');
  }

  return result.valid;
}

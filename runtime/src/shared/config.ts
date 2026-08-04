import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { GatewayConfig } from './types.js';

/**
 * The GATEWAY_LOCAL_TOKEN fallback baked into docker-compose.yml and
 * .mcp.json (`${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}`) — both files
 * ship in the npm package and the public mirror, so this value is PUBLIC
 * KNOWLEDGE, not a secret. loadConfig() refuses to treat it as a valid local
 * credential when tenancy.enforce=true (see below); it must never be
 * accepted as-is on a deployment reachable beyond loopback.
 */
export const KNOWN_DEFAULT_LOCAL_TOKEN = 'myai-local-bridge-dev';

const DEFAULTS: GatewayConfig = {
  server: { httpPort: 3200, wsPort: 3201, host: '0.0.0.0' },
  database: {
    uri: 'mongodb://admin:password@localhost:27017/myai?authSource=admin',
    name: 'myai',
    // Read-side failover to the local `myai mirror` copy (MONGO_MIRROR.md).
    // Off by default — never an automatic/silent swap (2026-07-04 split-brain
    // lesson). Opt in with MYAI_DB_FAILOVER=local.
    failover: 'none' as 'none' | 'local',
    failoverUri: undefined,
  },
  aiRoot: resolve(process.cwd(), '..'),
  sessions: { compactionThreshold: 50, compactionKeepRecent: 10, idleTimeoutMinutes: 1440, maxConcurrentSessions: 100 },
  memory: {
    embedding: { provider: 'local', model: 'all-MiniLM-L6-v2', dimensions: 384 },
    search: { topN: 5, weights: { vector: 0.5, tagOverlap: 0.2, confidence: 0.2, recency: 0.1 } },
  },
  llm: {
    enabled: false,
    mode: 'bridge' as 'bridge' | 'direct' | 'api',
    modeChain: undefined,
    bridgeUrl: 'http://host.docker.internal:3202',
    timeoutMs: 180_000,
    apiKey: undefined,
    model: 'claude-sonnet-4-20250514',
    deepseekApiKey: undefined,
    deepseekModel: 'deepseek-chat',
    moonshotApiKey: undefined,
    moonshotModel: 'kimi-k2.6',
    moonshotBaseUrl: undefined,
    openrouterApiKey: undefined,
    openrouterModel: 'moonshotai/kimi-k2:free',
    openrouterBaseUrl: undefined,
    geminiApiKey: undefined,
    geminiModel: 'gemini-2.0-flash',
    ollamaBaseUrl: 'http://host.docker.internal:11434/v1',
    ollamaModel: 'kimi-k2.6:cloud',
    promptCacheEnabled: true,
    batchEnabled: true,
  },
  channels: {
    telegram: { enabled: false, token: '', allowedChatIds: [] },
    discord: { enabled: false, token: '', allowedChannelIds: [] },
  },
  chatTools: { enabled: false, allowedChatIds: [], maxIterations: 5 },
  budgets: {
    enabled: false,
    monthlyHardCapUsd: 50,
    monthlyDailyCapUsd: 5,
    perChannelMonthlyCapUsd: undefined,
    warnThreshold: 0.5,
    downgradeOpusThreshold: 0.8,
    downgradeSonnetThreshold: 0.9,
    bypassChannelIds: [],
  },
  hooks: { enableBashCompat: true, bashHooksDir: '../hooks', userHooksDir: './hooks', defaultTimeout: 5000 },
  // M1 multi-tenancy (ADR-010). Enforcement is now ON by default: all 8 scoped
  // collections route through getTenantScope/scoped-query and the §3.4 grep-gate
  // backstops regressions, so unresolved/non-loopback callers must present a
  // valid tenant key (or the GATEWAY_LOCAL_TOKEN bridge token) — no silent
  // DEFAULT_TENANT_ID fallback. Loopback callers (host CLI runner, hooks,
  // dashboard via localhost) stay trusted; the in-cluster dashboard authenticates
  // over the Docker bridge with GATEWAY_LOCAL_TOKEN. Override with TENANT_ENFORCE=false
  // to restore the pre-enforcement single-operator fallback.
  tenancy: {
    defaultTenantId: 'default',
    enforce: true,
    localToken: undefined,
    previousLocalToken: undefined,
    previousLocalTokenExpiresAt: undefined,
  },
  // Data-residency / region pinning (ADR-023). Off by default (no
  // GATEWAY_REGION configured) — a single-region deployment never rejects on
  // region, identical behaviour to pre-ADR-023. Set GATEWAY_REGION +
  // REGION_ENFORCE=true on each regional gateway deployment to enforce.
  region: { enforce: false, gatewayRegion: undefined },
  metering: { enabled: true, sampleRate: 1 },
  // In-gateway inline execution (ADR-018) — off by default; opt-in via env.
  agentRuntime: { inlineEnabled: false, inlineQuotaPerWindow: 20, inlineWindowSeconds: 3600 },
  logging: { level: 'info', pretty: true },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv, sv);
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result;
}

export function loadConfig(configPath?: string): GatewayConfig {
  let fileConfig: Partial<GatewayConfig> = {};

  const paths = [
    configPath,
    resolve(process.cwd(), 'gateway.config.json'),
    resolve(process.cwd(), '..', 'runtime', 'gateway.config.json'),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      fileConfig = JSON.parse(readFileSync(p, 'utf-8'));
      break;
    }
  }

  // Deep-clone DEFAULTS before merging: deepMerge only recurses into keys
  // fileConfig actually overrides, so any nested object fileConfig doesn't
  // touch (the common case — no gateway.config.json — is ALL of them) comes
  // back as the SAME reference as the module-level DEFAULTS constant. Several
  // call sites below (env overrides, the GATEWAY_LOCAL_TOKEN refusal) mutate
  // `config.tenancy` in place, which would otherwise permanently corrupt
  // DEFAULTS.tenancy for every later loadConfig() call in this process.
  const config: GatewayConfig = deepMerge(structuredClone(DEFAULTS), fileConfig);

  // Environment variable overrides
  if (process.env.GATEWAY_HTTP_PORT) config.server.httpPort = Number(process.env.GATEWAY_HTTP_PORT);
  if (process.env.GATEWAY_WS_PORT) config.server.wsPort = Number(process.env.GATEWAY_WS_PORT);
  if (process.env.GATEWAY_HOST) config.server.host = process.env.GATEWAY_HOST;
  if (process.env.MONGODB_URI) config.database.uri = process.env.MONGODB_URI;
  if (process.env.MONGODB_NAME) config.database.name = process.env.MONGODB_NAME;
  // Read-side local-first failover (MONGO_MIRROR.md follow-up). Explicit
  // opt-in only: MYAI_DB_FAILOVER=local makes connectDB() fall back to the
  // local mirror in a logged, READ-ONLY degraded mode when the primary
  // (Atlas) is unreachable at boot. Any other value keeps it off.
  if (process.env.MYAI_DB_FAILOVER === 'local') config.database.failover = 'local';
  if (process.env.MYAI_DB_FAILOVER === 'none' || process.env.MYAI_DB_FAILOVER === 'false' || process.env.MYAI_DB_FAILOVER === '0') {
    config.database.failover = 'none';
  }
  if (process.env.MYAI_DB_FAILOVER_URI) config.database.failoverUri = process.env.MYAI_DB_FAILOVER_URI;
  if (process.env.AI_ROOT) config.aiRoot = process.env.AI_ROOT;
  if (process.env.LOG_LEVEL) config.logging.level = process.env.LOG_LEVEL;
  if (process.env.EMBEDDING_PROVIDER) config.memory.embedding.provider = process.env.EMBEDDING_PROVIDER as 'local' | 'openai';
  if (process.env.LLM_ENABLED === 'true' || process.env.LLM_ENABLED === '1') config.llm.enabled = true;
  if (process.env.LLM_MODE) config.llm.mode = process.env.LLM_MODE as 'bridge' | 'direct' | 'api' | 'deepseek' | 'moonshot' | 'gemini' | 'ollama';
  if (process.env.ANTHROPIC_API_KEY) { config.llm.apiKey = process.env.ANTHROPIC_API_KEY; if (!process.env.LLM_MODE) config.llm.mode = 'api'; }
  if (process.env.LLM_MODEL) config.llm.model = process.env.LLM_MODEL;
  if (process.env.DEEPSEEK_API_KEY) { config.llm.deepseekApiKey = process.env.DEEPSEEK_API_KEY; if (!process.env.LLM_MODE && !process.env.ANTHROPIC_API_KEY) config.llm.mode = 'deepseek'; }
  if (process.env.DEEPSEEK_MODEL) config.llm.deepseekModel = process.env.DEEPSEEK_MODEL;
  if (process.env.MOONSHOT_API_KEY) { config.llm.moonshotApiKey = process.env.MOONSHOT_API_KEY; if (!process.env.LLM_MODE && !process.env.ANTHROPIC_API_KEY && !process.env.DEEPSEEK_API_KEY) config.llm.mode = 'moonshot'; }
  if (process.env.MOONSHOT_MODEL) config.llm.moonshotModel = process.env.MOONSHOT_MODEL;
  if (process.env.MOONSHOT_BASE_URL) config.llm.moonshotBaseUrl = process.env.MOONSHOT_BASE_URL;
  // OpenRouter backend for the Kimi lane — free K2 slug without a paid
  // Moonshot key. Becomes the default mode only when it is the sole key.
  if (process.env.OPENROUTER_API_KEY) { config.llm.openrouterApiKey = process.env.OPENROUTER_API_KEY; if (!process.env.LLM_MODE && !process.env.ANTHROPIC_API_KEY && !process.env.DEEPSEEK_API_KEY && !process.env.MOONSHOT_API_KEY) config.llm.mode = 'moonshot'; }
  if (process.env.OPENROUTER_MODEL) config.llm.openrouterModel = process.env.OPENROUTER_MODEL;
  if (process.env.OPENROUTER_BASE_URL) config.llm.openrouterBaseUrl = process.env.OPENROUTER_BASE_URL;
  if (process.env.GEMINI_API_KEY) { config.llm.geminiApiKey = process.env.GEMINI_API_KEY; if (!process.env.LLM_MODE && !process.env.ANTHROPIC_API_KEY && !process.env.DEEPSEEK_API_KEY && !process.env.MOONSHOT_API_KEY && !process.env.OPENROUTER_API_KEY) config.llm.mode = 'gemini'; }
  if (process.env.GEMINI_MODEL) config.llm.geminiModel = process.env.GEMINI_MODEL;
  if (process.env.OLLAMA_BASE_URL) config.llm.ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
  if (process.env.OLLAMA_MODEL) config.llm.ollamaModel = process.env.OLLAMA_MODEL;
  if (process.env.LLM_BRIDGE_URL) config.llm.bridgeUrl = process.env.LLM_BRIDGE_URL;
  if (process.env.LLM_TIMEOUT_MS) config.llm.timeoutMs = Number(process.env.LLM_TIMEOUT_MS);
  if (process.env.LLM_MODE_CHAIN) {
    const chain = process.env.LLM_MODE_CHAIN.split(',').map(s => s.trim()).filter(Boolean);
    config.llm.modeChain = chain.length ? chain : undefined;
  }
  // Phase 5d — prompt caching on the Anthropic provider. Default true; only
  // explicit `false` / `0` disables. Pure cost win at scale; SDK ignores cache
  // markers on short prompts so even non-cacheable workloads are no-ops.
  if (process.env.PROMPT_CACHE_ENABLED === 'false' || process.env.PROMPT_CACHE_ENABLED === '0') {
    config.llm.promptCacheEnabled = false;
  }
  // Phase 5f — Anthropic Message Batches API. Default true; explicit false/0 disables.
  // Only consulted by `morning_sweep` today; other call sites are unaffected.
  if (process.env.BATCH_ENABLED === 'false' || process.env.BATCH_ENABLED === '0') {
    config.llm.batchEnabled = false;
  }
  const hostMachine = process.env.HOST_HOSTNAME || '';
  if (process.env.TELEGRAM_BOT_TOKEN) { config.channels.telegram.token = process.env.TELEGRAM_BOT_TOKEN; config.channels.telegram.enabled = true; }
  if (process.env.TELEGRAM_ENABLED === 'false' || process.env.TELEGRAM_ENABLED === '0') config.channels.telegram.enabled = false;
  if (process.env.TELEGRAM_HOST && !hostMachine.startsWith(process.env.TELEGRAM_HOST)) config.channels.telegram.enabled = false;
  if (process.env.TELEGRAM_ALLOWED_CHATS) config.channels.telegram.allowedChatIds = process.env.TELEGRAM_ALLOWED_CHATS.split(',').map(s => s.trim());
  if (process.env.DISCORD_BOT_TOKEN) { config.channels.discord.token = process.env.DISCORD_BOT_TOKEN; config.channels.discord.enabled = true; }
  if (process.env.DISCORD_ENABLED === 'false' || process.env.DISCORD_ENABLED === '0') config.channels.discord.enabled = false;
  if (process.env.DISCORD_HOST && !hostMachine.startsWith(process.env.DISCORD_HOST)) config.channels.discord.enabled = false;
  if (process.env.DISCORD_ALLOWED_CHANNELS) config.channels.discord.allowedChannelIds = process.env.DISCORD_ALLOWED_CHANNELS.split(',').map(s => s.trim());

  // Chat-mode tool-use (Phase C — real MCP tools via Telegram/Discord)
  if (process.env.CHAT_TOOLS_ENABLED === 'true' || process.env.CHAT_TOOLS_ENABLED === '1') config.chatTools.enabled = true;
  if (process.env.CHAT_TOOL_ALLOWED_CHATS) {
    config.chatTools.allowedChatIds = process.env.CHAT_TOOL_ALLOWED_CHATS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (process.env.CHAT_TOOL_MAX_ITERATIONS) {
    const n = Number(process.env.CHAT_TOOL_MAX_ITERATIONS);
    if (Number.isFinite(n) && n > 0) config.chatTools.maxIterations = n;
  }

  // Budget guards (Phase 5b — opt-in only; defaults are off so existing
  // deployments behave identically until BUDGETS_ENABLED is set).
  if (process.env.BUDGETS_ENABLED === 'true' || process.env.BUDGETS_ENABLED === '1') {
    config.budgets.enabled = true;
  }
  if (process.env.BUDGET_MONTHLY_HARD_USD) {
    const n = Number(process.env.BUDGET_MONTHLY_HARD_USD);
    if (Number.isFinite(n) && n >= 0) config.budgets.monthlyHardCapUsd = n;
  }
  if (process.env.BUDGET_DAILY_HARD_USD) {
    const n = Number(process.env.BUDGET_DAILY_HARD_USD);
    if (Number.isFinite(n) && n >= 0) config.budgets.monthlyDailyCapUsd = n;
  }
  if (process.env.BUDGET_PER_CHANNEL_MONTHLY_USD) {
    const n = Number(process.env.BUDGET_PER_CHANNEL_MONTHLY_USD);
    if (Number.isFinite(n) && n >= 0) config.budgets.perChannelMonthlyCapUsd = n;
  }
  if (process.env.BUDGET_WARN_THRESHOLD) {
    const n = Number(process.env.BUDGET_WARN_THRESHOLD);
    if (Number.isFinite(n) && n >= 0 && n <= 1) config.budgets.warnThreshold = n;
  }
  if (process.env.BUDGET_DOWNGRADE_OPUS) {
    const n = Number(process.env.BUDGET_DOWNGRADE_OPUS);
    if (Number.isFinite(n) && n >= 0 && n <= 1) config.budgets.downgradeOpusThreshold = n;
  }
  if (process.env.BUDGET_DOWNGRADE_SONNET) {
    const n = Number(process.env.BUDGET_DOWNGRADE_SONNET);
    if (Number.isFinite(n) && n >= 0 && n <= 1) config.budgets.downgradeSonnetThreshold = n;
  }
  if (process.env.BUDGET_BYPASS_CHATS) {
    config.budgets.bypassChannelIds = process.env.BUDGET_BYPASS_CHATS.split(',').map(s => s.trim()).filter(Boolean);
  }

  // M1 multi-tenancy (ADR-010). Enforcement defaults ON (see defaults above).
  // DEFAULT_TENANT_ID must match the const in db.ts (schema default) — both read
  // the same env var so they cannot diverge.
  if (process.env.DEFAULT_TENANT_ID) config.tenancy.defaultTenantId = process.env.DEFAULT_TENANT_ID;
  // TENANT_ENFORCE is now an explicit override of the on-by-default posture:
  // set it to 'false'/'0' to restore the pre-enforcement single-operator fallback.
  if (process.env.TENANT_ENFORCE === 'true' || process.env.TENANT_ENFORCE === '1') config.tenancy.enforce = true;
  if (process.env.TENANT_ENFORCE === 'false' || process.env.TENANT_ENFORCE === '0') config.tenancy.enforce = false;
  if (process.env.GATEWAY_LOCAL_TOKEN) config.tenancy.localToken = process.env.GATEWAY_LOCAL_TOKEN;
  // Dual-valid rotation grace window (`myai rotate-keys local`): the OLD token
  // keeps authenticating until the expiry passes, so rotating never 401s an
  // in-flight caller still holding it.
  if (process.env.GATEWAY_LOCAL_TOKEN_PREVIOUS) {
    config.tenancy.previousLocalToken = process.env.GATEWAY_LOCAL_TOKEN_PREVIOUS;
  }
  if (process.env.GATEWAY_LOCAL_TOKEN_PREVIOUS_EXPIRES_AT) {
    const ms = Number(process.env.GATEWAY_LOCAL_TOKEN_PREVIOUS_EXPIRES_AT);
    if (Number.isFinite(ms)) config.tenancy.previousLocalTokenExpiresAt = ms;
  }
  // SECURITY: never let the published fallback become the ACTUAL running
  // credential. Under enforce=true it would otherwise grant a non-loopback
  // caller (Docker bridge, LAN when the port is published) the default
  // tenant at plan 'scale' — refuse it outright rather than silently
  // trusting a value anyone can read in the npm package. Under
  // enforce=false the no-key branch already grants every caller the
  // default tenant regardless of token (MVP single-operator fallback), so
  // refusing would change nothing but the operator still deserves a loud
  // heads-up that their bridge token is publicly known.
  if (config.tenancy.localToken === KNOWN_DEFAULT_LOCAL_TOKEN) {
    if (config.tenancy.enforce) {
      // eslint-disable-next-line no-console
      console.error(
        '\n' + '='.repeat(78) + '\n' +
        'SECURITY: GATEWAY_LOCAL_TOKEN is the published default value\n' +
        `("${KNOWN_DEFAULT_LOCAL_TOKEN}") — this ships in the public npm package\n` +
        'and mirror, so it is not a secret. Refusing to accept it as a valid\n' +
        'local-bridge credential while tenancy.enforce=true; non-loopback\n' +
        'callers (Docker bridge, LAN) presenting it will get 401.\n' +
        'Fix: run `myai rotate-keys local` (or set a real random\n' +
        'GATEWAY_LOCAL_TOKEN in .env) to generate a private token.\n' +
        '='.repeat(78) + '\n',
      );
      config.tenancy.localToken = undefined;
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `SECURITY WARNING: GATEWAY_LOCAL_TOKEN is the published default ("${KNOWN_DEFAULT_LOCAL_TOKEN}") ` +
        '— this is public knowledge, not a secret. Run `myai rotate-keys local` to generate a real one ' +
        'before exposing this gateway beyond localhost.',
      );
    }
  }

  // Data-residency / region pinning (ADR-023).
  if (process.env.GATEWAY_REGION === 'us' || process.env.GATEWAY_REGION === 'eu' || process.env.GATEWAY_REGION === 'au') {
    config.region.gatewayRegion = process.env.GATEWAY_REGION;
  }
  if (process.env.REGION_ENFORCE === 'true' || process.env.REGION_ENFORCE === '1') config.region.enforce = true;
  if (process.env.REGION_ENFORCE === 'false' || process.env.REGION_ENFORCE === '0') config.region.enforce = false;

  // Usage metering (ADR-014). On by default; sampling guard is env-tunable.
  if (process.env.METERING_ENABLED === 'false' || process.env.METERING_ENABLED === '0') config.metering.enabled = false;
  if (process.env.METERING_ENABLED === 'true' || process.env.METERING_ENABLED === '1') config.metering.enabled = true;
  if (process.env.METERING_SAMPLE_RATE) {
    const n = Number(process.env.METERING_SAMPLE_RATE);
    if (Number.isFinite(n) && n >= 0 && n <= 1) config.metering.sampleRate = n;
  }

  // In-gateway inline execution (ADR-018 — opt-in; defaults off so behaviour is
  // identical until INLINE_EXEC_ENABLED is set).
  if (process.env.INLINE_EXEC_ENABLED === 'true' || process.env.INLINE_EXEC_ENABLED === '1') {
    config.agentRuntime.inlineEnabled = true;
  }
  if (process.env.INLINE_EXEC_QUOTA) {
    const n = Number(process.env.INLINE_EXEC_QUOTA);
    if (Number.isFinite(n) && n >= 0) config.agentRuntime.inlineQuotaPerWindow = Math.floor(n);
  }
  if (process.env.INLINE_EXEC_WINDOW_SEC) {
    const n = Number(process.env.INLINE_EXEC_WINDOW_SEC);
    if (Number.isFinite(n) && n > 0) config.agentRuntime.inlineWindowSeconds = Math.floor(n);
  }

  // Resolve AI_ROOT to absolute path
  if (!config.aiRoot.startsWith('/')) {
    config.aiRoot = resolve(process.cwd(), config.aiRoot);
  }

  return config;
}

let _config: GatewayConfig | null = null;

export function getConfig(): GatewayConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

/**
 * B-9 client-side metadata obfuscation (plan §4 B-9 — the "Cursor pattern").
 * Opt-in flag + per-install salt used to pseudonymise identifiers before
 * descriptors are embedded/upserted to a REMOTE index (Atlas). Exposed as a
 * standalone reader rather than a field on `GatewayConfig` so the memory
 * boundary has a single source of truth without widening the validated schema.
 *
 * DEFAULT OFF — mirrors B-5's embed/index hooks and RUNNER_LOCAL_TIER, which
 * ship dark pending validation. When OFF the store/search path is byte-for-byte
 * the pre-B-9 behaviour. Flip on with `BRAIN_OBFUSCATE_REMOTE=1`.
 */
export interface BrainObfuscationConfig {
  /** Master switch. Env: BRAIN_OBFUSCATE_REMOTE (`true`/`1`). Default false. */
  obfuscateRemote: boolean;
  /** Per-install HMAC salt. Stable within an install (so query and corpus tokens
   *  match) but MUST differ across installs (so descriptors are unlinkable).
   *  Resolved by `resolveObfuscationSalt()`: an explicit BRAIN_OBFUSCATE_SALT, else
   *  a *non-default* GATEWAY_LOCAL_TOKEN, else a random per-install salt minted and
   *  persisted to LOCAL disk on first enable. Never a fixed shared literal — that
   *  made every install produce identical tokens, defeating unlinkability (B-9's
   *  whole point). Empty string only when obfuscation is OFF or could not be
   *  enabled safely (in which case `obfuscateRemote` is false). */
  salt: string;
}

/**
 * Where the auto-generated per-install obfuscation salt is persisted when the
 * operator enables BRAIN_OBFUSCATE_REMOTE without supplying an explicit
 * BRAIN_OBFUSCATE_SALT (and without a distinct GATEWAY_LOCAL_TOKEN). Kept on
 * LOCAL disk only, under the same `~/.myai` root the brain store + obf-map-store
 * already use (mirror of `myaiHome()` in `core/brain.ts`, inlined here to keep
 * this low-level config module free of the heavier brain.ts import graph).
 */
function myaiHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MYAI_HOME || join(homedir(), '.myai');
}

function obfuscateSaltPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(myaiHomeDir(env), 'brain', 'obfuscate-salt');
}

/**
 * Resolve (and if necessary mint + persist) the per-install obfuscation salt for
 * an enabled BRAIN_OBFUSCATE_REMOTE. Priority:
 *   1. BRAIN_OBFUSCATE_SALT — an explicit, operator-chosen per-install salt.
 *   2. GATEWAY_LOCAL_TOKEN — the per-install bridge token, but ONLY when it is a
 *      real random token, never the published KNOWN_DEFAULT_LOCAL_TOKEN (that
 *      value ships in the npm package + mirror, so every install that left it at
 *      the default would share it — exactly the cross-install linkability this
 *      guards against).
 *   3. A random 32-byte salt generated ONCE and persisted to LOCAL disk (0600),
 *      stable across restarts but unique per install.
 *
 * This deliberately NO LONGER falls back to a fixed literal default: a shared
 * constant salt made every such install produce byte-identical descriptor
 * tokens, defeating B-9's cross-install unlinkability guarantee — a false sense
 * of privacy. Returns '' only when no per-install salt is resolvable AND the
 * auto-salt could not be persisted; the caller then refuses to enable
 * obfuscation rather than fall open to a shared/ephemeral salt.
 */
function resolveObfuscationSalt(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.BRAIN_OBFUSCATE_SALT || '').trim();
  if (explicit) return explicit;

  const localToken = (env.GATEWAY_LOCAL_TOKEN || '').trim();
  if (localToken && localToken !== KNOWN_DEFAULT_LOCAL_TOKEN) return localToken;

  // No per-install salt supplied — reuse the persisted auto-salt, or mint one.
  const path = obfuscateSaltPath(env);
  if (existsSync(path)) {
    try {
      const saved = readFileSync(path, 'utf8').trim();
      if (saved) return saved;
    } catch {
      // fall through to (re)generate
    }
  }

  const generated = randomBytes(32).toString('hex');
  try {
    const dir = join(myaiHomeDir(env), 'brain');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 0o600 — the salt is a per-install secret; anyone who reads it can
    // recompute this install's obfuscation tokens.
    writeFileSync(path, generated, { mode: 0o600 });
    // Warns exactly once per install (the next call finds the file and is
    // silent) — a loud heads-up that no explicit salt was set, without spamming.
    // eslint-disable-next-line no-console
    console.warn(
      'SECURITY: BRAIN_OBFUSCATE_REMOTE is enabled without an explicit ' +
      'BRAIN_OBFUSCATE_SALT (and no distinct GATEWAY_LOCAL_TOKEN). Generated a ' +
      `random per-install salt and persisted it to ${path}. Set an explicit ` +
      'BRAIN_OBFUSCATE_SALT in .env if the salt must survive a home-dir reset or ' +
      'be shared across replicas of THIS install.',
    );
    return generated;
  } catch (err) {
    // Persisting failed (e.g. read-only home). Fail LOUD and refuse rather than
    // obfuscate with a value we cannot make stable+per-install — an ephemeral
    // salt breaks recall on restart, and the old fixed default was shared.
    // eslint-disable-next-line no-console
    console.error(
      '\n' + '='.repeat(78) + '\n' +
      'SECURITY: BRAIN_OBFUSCATE_REMOTE is enabled but no per-install salt is\n' +
      'resolvable and the auto-generated salt could not be persisted\n' +
      `(${(err as Error).message}). Refusing to obfuscate with a shared or\n` +
      'ephemeral salt — that would ship a FALSE sense of privacy (linkable\n' +
      'descriptors across installs). Remote obfuscation is DISABLED for this\n' +
      'process. Fix: set an explicit BRAIN_OBFUSCATE_SALT in .env.\n' +
      '='.repeat(78) + '\n',
    );
    return '';
  }
}

export function getBrainObfuscation(): BrainObfuscationConfig {
  const wantRemote =
    process.env.BRAIN_OBFUSCATE_REMOTE === 'true' || process.env.BRAIN_OBFUSCATE_REMOTE === '1';
  // DEFAULT OFF — salt is unused by callers on this path, so keep it out of the
  // filesystem entirely: the off-path stays byte-for-byte the pre-B-9 behaviour.
  if (!wantRemote) return { obfuscateRemote: false, salt: '' };

  const salt = resolveObfuscationSalt();
  // Fail-loud, fail-SAFE: resolveObfuscationSalt() returns '' (and logs loudly)
  // only when no per-install salt could be resolved or persisted. Do NOT enable
  // obfuscation with an empty/shared salt — leaving it "on" would be a false
  // sense of privacy. Disable instead.
  if (!salt) return { obfuscateRemote: false, salt: '' };
  return { obfuscateRemote: true, salt };
}

export function setConfig(config: GatewayConfig): void {
  _config = config;
}

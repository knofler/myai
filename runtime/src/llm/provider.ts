import { spawn } from 'node:child_process';
import { createChildLogger } from '../shared/logger.js';
import { getConfig } from '../shared/config.js';
import { callAnthropic, initClient, getClient } from './anthropic.js';
import { callDeepSeek, callDeepSeekStream, initDeepSeek, isDeepSeekConfigured } from './deepseek.js';
import { callMoonshot, callMoonshotStream, callOllama, callOllamaStream, initMoonshot, initOpenRouter, initOllama, isMoonshotConfigured } from './moonshot.js';
import { callGemini, callGeminiStream, initGemini } from './gemini.js';
import { estimateCost } from './cost-estimator.js';
import { withResilience, CircuitOpenError, RateLimitExhaustedError, ProviderMaintenanceError } from './resilience.js';
import { probeOllamaCached, pickOllamaModel, offlineNotice } from './offline.js';
import { route } from './router.js';
import { budgetAwareChain, estimateRequestTokens } from './failover.js';
import type { RoutingContext } from './router.js';
import type { GatewayMessage } from '../shared/types.js';
import type { AnthropicToolOptions } from './anthropic.js';
import type { ToolUseBlock } from '../tools/chat-tools.js';

const log = createChildLogger({ module: 'llm-provider' });

export type LlmProviderId = 'claude-api' | 'deepseek-api' | 'moonshot-api' | 'gemini-api' | 'ollama' | 'claude-cli' | 'claude-bridge';

export interface LlmRequest {
  systemPrompt: string;
  /**
   * BRAIN B-8 (prompt-cache-aware ordering) — content that changes every
   * call (per-task skill matches, memory retrieval, session workspace path).
   * Only the Anthropic provider actually splits this out as a second,
   * uncached system block after the `systemPrompt` cache boundary
   * (`callAnthropic`); every other provider/mode just folds it back onto
   * `systemPrompt` via `fullSystemPrompt()` since none of them support
   * cache-block splitting.
   */
  volatileSuffix?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  /** Tool-use options. Currently honored ONLY by the Anthropic provider —
   *  other providers silently drop the `tools` field. The mode chain falls
   *  through normally on network errors; the Anthropic provider must be in
   *  the chain (or the primary `LLM_MODE`) for chat-mode tools to actually
   *  fire. */
  toolOpts?: AnthropicToolOptions;
  /** Optional routing context. When provided, the tier router determines
   *  which provider and model to use instead of the static LLM_MODE config. */
  routingContext?: RoutingContext;
  /** Optional budget-aware failover hint. When set, `complete()` drops paid
   *  fallback providers from the chain whose estimated cost would exceed
   *  `remainingUsd`, keeping the primary and every free provider (Ollama /
   *  CLI / bridge). Stamped by the budget guard for budget-enabled tenants;
   *  absent → chain is walked unfiltered (default, byte-identical to before). */
  failoverBudget?: {
    /** Remaining tenant budget in USD. Negative means already over cap. */
    remainingUsd: number;
    /** Rough input-token estimate; defaults to a char-length heuristic. */
    estInputTokens?: number;
    /** Rough output-token estimate; defaults to `maxTokens` or 1024. */
    estOutputTokens?: number;
  };
}

export interface LlmResponse {
  content: string;
  provider: LlmProviderId;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** USD cost estimated from token counts × pricing table. 0 for free/local providers or unknown models. */
  costUsd?: number;
  /** Anthropic only — tool_use blocks executed on the final iteration when
   *  the cap was hit. The blocks ran successfully; the model just didn't get
   *  a chance to synthesize a final reply consuming their results. Empty/
   *  undefined when the loop completed normally. */
  cappedToolUses?: ToolUseBlock[];
  /** Anthropic only — number of tool-use iterations consumed. */
  toolIterations?: number;
  /** Anthropic only (Phase 5d) — tokens written to the prompt cache on this call.
   *  Charged at 1.25× normal input rate. Sum across tool-loop iterations. */
  cacheCreationInputTokens?: number;
  /** Anthropic only (Phase 5d) — tokens read from the prompt cache on this call.
   *  Charged at 0.10× normal input rate. Sum across tool-loop iterations. */
  cacheReadInputTokens?: number;
  /** Anthropic only (Phase 5f) — true when this response was returned by the
   *  Message Batches API. Triggers the 50% cost multiplier in cost-estimator
   *  and is recorded on the budget-usage audit row so the dashboard can
   *  report batch share-of-traffic + realised savings. */
  batchMode?: boolean;
  /** BRAIN B6 — true when this response was served by local Ollama because
   *  the cloud providers were unreachable (offline auto-connect). */
  offlineFallback?: boolean;
  /** BRAIN B6 — user-facing notice channels must surface when offlineFallback
   *  is set, so it is always clear a local model produced the answer. */
  notice?: string;
}

/** Wrap a raw provider result into LlmResponse, computing costUsd from token counts. */
function withCost(
  provider: LlmProviderId,
  result: {
    content: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cappedToolUses?: ToolUseBlock[];
    toolIterations?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    batchMode?: boolean;
  },
): LlmResponse {
  return {
    content: result.content,
    provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: estimateCost(
      provider,
      result.model,
      result.inputTokens,
      result.outputTokens,
      result.cacheCreationInputTokens,
      result.cacheReadInputTokens,
      result.batchMode,
    ),
    cappedToolUses: result.cappedToolUses,
    toolIterations: result.toolIterations,
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    batchMode: result.batchMode,
  };
}

/**
 * Initialize the LLM provider based on config.
 * Call this once at startup.
 */
export function initProvider(): void {
  const config = getConfig();

  // Initialize API clients if keys are available
  if (config.llm.apiKey) {
    initClient(config.llm.apiKey);
    log.info({ model: config.llm.model }, 'Anthropic API client ready');
  }
  if (config.llm.deepseekApiKey) {
    initDeepSeek(config.llm.deepseekApiKey);
    log.info({ model: config.llm.deepseekModel }, 'DeepSeek API client ready');
  }
  if (config.llm.moonshotApiKey) {
    initMoonshot(config.llm.moonshotApiKey, config.llm.moonshotBaseUrl);
    log.info({ model: config.llm.moonshotModel, baseUrl: config.llm.moonshotBaseUrl }, 'Moonshot API client ready');
  }
  if (config.llm.openrouterApiKey) {
    initOpenRouter(config.llm.openrouterApiKey, config.llm.openrouterModel, config.llm.openrouterBaseUrl);
    // Direct Moonshot wins when both keys are set — OpenRouter is the free
    // K2 lane only while it is the sole Kimi-lane key.
    log.info(
      { model: config.llm.openrouterModel, active: !config.llm.moonshotApiKey },
      'OpenRouter (Kimi lane) client ready',
    );
  }
  if (config.llm.geminiApiKey) {
    initGemini(config.llm.geminiApiKey);
    log.info({ model: config.llm.geminiModel }, 'Gemini API client ready');
  }
  // Ollama is always available (no API key), just configure URL
  initOllama(config.llm.ollamaBaseUrl);

  log.info({ mode: config.llm.mode }, `LLM provider: ${config.llm.mode}`);
}

/**
 * Full system text for providers that don't support prompt-cache-boundary
 * splitting (everything except Anthropic — see `callAnthropic`). Folds
 * `volatileSuffix` back onto `systemPrompt` so no content is ever dropped.
 */
function fullSystemPrompt(req: LlmRequest): string {
  return req.volatileSuffix ? `${req.systemPrompt}\n\n${req.volatileSuffix}` : req.systemPrompt;
}

/**
 * Call DeepSeek via their OpenAI-compatible API.
 * Wrapped with resilience: rate-limit → circuit breaker → retry → API call.
 */
async function callDeepSeekApi(req: LlmRequest, modelOverride?: string): Promise<LlmResponse> {
  const config = getConfig();
  const result = await withResilience('deepseek', () =>
    callDeepSeek({
      systemPrompt: fullSystemPrompt(req),
      messages: req.messages,
      model: modelOverride ?? config.llm.deepseekModel,
      maxTokens: req.maxTokens,
    }),
  );
  return withCost('deepseek-api', result);
}

/**
 * Call Moonshot/Kimi via their OpenAI-compatible API.
 * Wrapped with resilience: rate-limit → circuit breaker → retry → API call.
 */
async function callMoonshotApi(req: LlmRequest, modelOverride?: string): Promise<LlmResponse> {
  const config = getConfig();
  const result = await withResilience('moonshot', () =>
    callMoonshot({
      systemPrompt: fullSystemPrompt(req),
      messages: req.messages,
      model: modelOverride ?? config.llm.moonshotModel,
      maxTokens: req.maxTokens,
    }),
  );
  return withCost('moonshot-api', result);
}

/**
 * Call Gemini via the AI Studio / Generative Language REST API.
 * Class-B free-tier gateway provider (research/bulk lane).
 * Wrapped with resilience: rate-limit → circuit breaker → retry → API call.
 */
async function callGeminiApi(req: LlmRequest, modelOverride?: string): Promise<LlmResponse> {
  const config = getConfig();
  const result = await withResilience('gemini', () =>
    callGemini({
      systemPrompt: fullSystemPrompt(req),
      messages: req.messages,
      model: modelOverride ?? config.llm.geminiModel,
      maxTokens: req.maxTokens,
    }),
  );
  return withCost('gemini-api', result);
}

/**
 * Call Ollama local models via OpenAI-compatible API.
 * Wrapped with resilience: rate-limit → circuit breaker → retry → API call.
 */
async function callOllamaApi(req: LlmRequest, modelOverride?: string): Promise<LlmResponse> {
  const config = getConfig();
  const result = await withResilience('ollama', () =>
    callOllama({
      systemPrompt: fullSystemPrompt(req),
      messages: req.messages,
      model: modelOverride ?? config.llm.ollamaModel,
      maxTokens: req.maxTokens,
    }),
  );
  return withCost('ollama', result);
}

/**
 * Call Claude via the Anthropic Messages API.
 *
 * Forwards `req.toolOpts` to the SDK so chat-mode tool-use can run on the
 * Anthropic provider. Other providers silently drop the option.
 * Wrapped with resilience: rate-limit → circuit breaker → retry → API call.
 */
async function callApi(req: LlmRequest, modelOverride?: string): Promise<LlmResponse> {
  const config = getConfig();
  const result = await withResilience('api', () =>
    callAnthropic(
      {
        systemPrompt: req.systemPrompt,
        volatileSuffix: req.volatileSuffix,
        messages: req.messages,
        model: modelOverride ?? config.llm.model,
        maxTokens: req.maxTokens,
        promptCacheEnabled: config.llm.promptCacheEnabled,
      },
      req.toolOpts,
    ),
  );
  return withCost('claude-api', result);
}

/**
 * Call Claude Code CLI via the bridge HTTP endpoint on the host.
 * Gateway (Docker) -> host.docker.internal:3202 -> claude CLI.
 * Wrapped with resilience: rate-limit → circuit breaker → retry → API call.
 */
async function callBridge(prompt: string): Promise<string> {
  return withResilience('bridge', async () => {
    const config = getConfig();
    const bridgeUrl = config.llm.bridgeUrl;

    const res = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Bridge returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as { response: string };
    return data.response;
  });
}

/**
 * Call Claude Code CLI directly (when running outside Docker).
 */
function callCliDirect(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME || '/root' },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Build a flat prompt from system + messages for claude -p (non-conversational mode).
 */
function buildFlatPrompt(req: LlmRequest): string {
  const parts: string[] = [];

  if (req.systemPrompt) {
    parts.push(`<system>\n${fullSystemPrompt(req)}\n</system>\n`);
  }

  for (const msg of req.messages) {
    const prefix = msg.role === 'user' ? 'Human' : 'Assistant';
    parts.push(`${prefix}: ${msg.content}`);
  }

  return parts.join('\n\n');
}

/**
 * Network errors we treat as "recoverable" — meaning the chain walker should
 * try the next provider rather than fail the whole call.
 *
 * Authoritative for both `complete()` and `completeStream()` so the office
 * DeepSeek block (ECONNRESET on TLS handshake) cleanly falls through to the
 * next provider in `LLM_MODE_CHAIN`.
 *
 * Also treats resilience-layer rejections (circuit open, rate-limit
 * exhausted, operator maintenance queue timed out) as recoverable — if one
 * provider is tripped/throttled/under maintenance, the chain should try the
 * next one rather than aborting entirely.
 */
/**
 * HTTP statuses worth failing OVER to the next provider in the chain — transient
 * conditions (rate limit, request timeout, upstream/overloaded) that another
 * provider may not be suffering. Deliberately EXCLUDES 4xx client errors like
 * 400/401/403/404: those signal a bad request/key/model and would fail
 * identically on every hop, so they abort the chain fast rather than burning it.
 */
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * Extract an HTTP status from a provider client's error message. The DeepSeek /
 * Moonshot / Ollama clients throw `Error("<Provider> API <status>: <body>")` on
 * a non-ok response, so the status is only available as text there (unlike the
 * Anthropic SDK, which sets a typed `.status`). Returns undefined when absent.
 */
function httpStatusFromMessage(message?: string): number | undefined {
  if (!message) return undefined;
  const m = /\bAPI (\d{3})\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}

export function isRecoverableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // Resilience layer: circuit breaker open, rate limiter exhausted, or a
  // provider maintenance queue timed out → skip to next provider.
  if (err instanceof CircuitOpenError || err instanceof RateLimitExhaustedError || err instanceof ProviderMaintenanceError) return true;
  const e = err as { code?: string; cause?: { code?: string }; name?: string; message?: string; status?: number; statusCode?: number };
  const code = e.code || e.cause?.code || '';
  if (['ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code)) {
    return true;
  }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  // Node fetch surfaces network failures as TypeError with message "fetch failed"
  if (e.name === 'TypeError' && /fetch/i.test(e.message ?? '')) return true;
  // Retryable HTTP status (429 rate-limit, 5xx / 529 overloaded, 408 timeout):
  // a provider throttling or overloaded should fail over, not abort the chain.
  // Status comes from a typed field (Anthropic SDK) or the client's message.
  const status =
    typeof e.status === 'number' ? e.status
    : typeof e.statusCode === 'number' ? e.statusCode
    : httpStatusFromMessage(e.message);
  if (status !== undefined && RETRYABLE_HTTP_STATUS.has(status)) return true;
  return false;
}

/**
 * Dispatch a single LLM call by mode name. Throws on any provider error.
 *
 * @param modelOverride - When set (from the tier router), overrides the model
 *   that would otherwise come from config (e.g. `config.llm.model`). Bridge
 *   and direct modes do not accept a model selection and silently ignore it.
 */
async function dispatchByMode(mode: string, req: LlmRequest, modelOverride?: string): Promise<LlmResponse> {
  const config = getConfig();
  switch (mode) {
    case 'api':
      if (config.llm.apiKey) return await callApi(req, modelOverride);
      if (config.llm.deepseekApiKey) return await callDeepSeekApi(req, modelOverride);
      throw new Error('api mode requires ANTHROPIC_API_KEY or DEEPSEEK_API_KEY');
    case 'deepseek':
      if (!config.llm.deepseekApiKey) throw new Error('deepseek mode requires DEEPSEEK_API_KEY');
      return await callDeepSeekApi(req, modelOverride);
    case 'moonshot':
      if (!config.llm.moonshotApiKey && !config.llm.openrouterApiKey) {
        throw new Error('moonshot mode requires MOONSHOT_API_KEY (or OPENROUTER_API_KEY for the free K2 lane)');
      }
      return await callMoonshotApi(req, modelOverride);
    case 'gemini':
      if (!config.llm.geminiApiKey) throw new Error('gemini mode requires GEMINI_API_KEY');
      return await callGeminiApi(req, modelOverride);
    case 'ollama':
      return await callOllamaApi(req, modelOverride);
    case 'bridge': {
      const content = await callBridge(buildFlatPrompt(req));
      return withCost('claude-bridge', { content });
    }
    case 'direct': {
      const content = await withResilience('direct', () =>
        callCliDirect(buildFlatPrompt(req), config.llm.timeoutMs),
      );
      return withCost('claude-cli', { content });
    }
    default:
      throw new Error(`Unknown LLM mode: ${mode}`);
  }
}

/**
 * Compose the ordered list of modes to try for a single call: primary `mode`
 * first, then any extra providers from `modeChain`. Duplicates removed,
 * order preserved. When `modeChain` is unset (legacy), just the primary.
 */
export function buildModeChain(primary: string, chain: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of [primary, ...chain]) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    result.push(m);
  }
  return result;
}

/**
 * Resolve the model id a given failover hop would actually dispatch with, so
 * the budget-aware filter can price each hop. Mirrors `dispatchByMode`: the
 * primary hop (index 0) uses the router's `modelOverride` when present;
 * fallback hops use their provider-default model from config. Free modes
 * (ollama/bridge/direct) return their config model — priced as 0 regardless.
 */
function defaultModelForMode(
  mode: string,
  config: ReturnType<typeof getConfig>,
): string | undefined {
  switch (mode) {
    case 'api':
      return config.llm.model;
    case 'deepseek':
      return config.llm.deepseekModel;
    case 'moonshot':
      // OpenRouter-backed Kimi lane dispatches the OpenRouter slug (free =
      // priced at 0 by the estimator); direct Moonshot uses its own model.
      return config.llm.moonshotApiKey
        ? config.llm.moonshotModel
        : (config.llm.openrouterApiKey ? config.llm.openrouterModel : config.llm.moonshotModel);
    case 'gemini':
      return config.llm.geminiModel;
    case 'ollama':
      return config.llm.ollamaModel;
    default:
      return undefined;
  }
}

/**
 * Apply the budget-aware failover filter to a resolved chain. Returns the
 * (possibly trimmed) chain, logging any paid fallbacks dropped for exceeding
 * the tenant's remaining budget. No-op when `req.failoverBudget` is unset.
 */
function applyFailoverBudget(
  chain: string[],
  req: LlmRequest,
  config: ReturnType<typeof getConfig>,
  modelOverride: string | undefined,
): string[] {
  if (!req.failoverBudget) return chain;

  const { remainingUsd } = req.failoverBudget;
  const estInputTokens =
    req.failoverBudget.estInputTokens ?? estimateRequestTokens(fullSystemPrompt(req), req.messages);
  const estOutputTokens = req.failoverBudget.estOutputTokens ?? req.maxTokens ?? 1024;

  const filtered = budgetAwareChain({
    chain,
    remainingBudgetUsd: remainingUsd,
    estInputTokens,
    estOutputTokens,
    modelForMode: (mode, index) =>
      index === 0 && modelOverride ? modelOverride : defaultModelForMode(mode, config),
  });

  if (filtered.dropped.length > 0) {
    log.warn({
      remainingUsd,
      dropped: filtered.dropped,
      originalChain: chain,
      budgetAwareChain: filtered.chain,
    }, 'Budget-aware failover: dropped paid fallback provider(s) that would exceed remaining budget');
  }

  return filtered.chain;
}

/**
 * Send a message to Claude and get a response.
 * Routes through `LLM_MODE` (primary) and optionally falls back through
 * `LLM_MODE_CHAIN` on recoverable network errors. The first provider that
 * returns successfully wins; non-recoverable errors abort the chain.
 *
 * When `req.routingContext` is provided, the tier router determines the
 * provider, model, and fallback chain instead of the static config values.
 */
export async function complete(req: LlmRequest): Promise<LlmResponse | null> {
  const config = getConfig();

  // Resolve chain + optional model override from the tier router or static config.
  let chain: string[];
  let modelOverride: string | undefined;

  if (req.routingContext) {
    const decision = route(req.routingContext);
    chain = buildModeChain(decision.provider, decision.chain);
    modelOverride = decision.model;
    log.info({
      messageCount: req.messages.length,
      routedProvider: decision.provider,
      routedModel: decision.model,
      chain,
      routingReason: decision.reason,
    }, 'LLM request (tier-routed)');
  } else {
    chain = buildModeChain(config.llm.mode, config.llm.modeChain);
    log.info({
      messageCount: req.messages.length,
      primary: config.llm.mode,
      chain,
    }, 'LLM request');
  }

  // Budget-aware failover: drop paid fallback hops the tenant can't afford,
  // keeping the primary + free providers. No-op unless req.failoverBudget set.
  chain = applyFailoverBudget(chain, req, config, modelOverride);

  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    const mode = chain[i];
    try {
      // modelOverride is the router's chosen model for the PRIMARY provider
      // (chain[0]). Fallback providers must use their own default model — a
      // Claude model name handed to DeepSeek/Moonshot/Ollama is incompatible
      // and would fail the whole chain. So only apply it to the first hop.
      const result = await dispatchByMode(mode, req, i === 0 ? modelOverride : undefined);
      if (i > 0) {
        log.warn({
          usedFallbackMode: mode,
          primary: chain[0],
          position: i,
          chain,
        }, 'LLM call succeeded via fallback chain');
        // BRAIN B6 — local Ollama rescued a call after the cloud hops failed:
        // mark the response so channels surface the offline notice.
        if (mode === 'ollama') {
          result.offlineFallback = true;
          result.notice = offlineNotice(result.model);
        }
      }
      return result;
    } catch (err) {
      lastError = err;
      if (!isRecoverableNetworkError(err)) {
        log.error({ err, mode }, 'LLM call failed (non-recoverable)');
        throw err;
      }
      log.warn({
        mode,
        nextInChain: chain[i + 1] ?? '(end)',
        errMessage: (err as Error).message,
      }, 'LLM call failed (recoverable network error), trying next provider in chain');
    }
  }
  // BRAIN B6 — offline auto-connect. Reaching here means EVERY provider in the
  // chain failed with a recoverable network error (non-recoverable errors throw
  // inside the loop), i.e. the cloud is unreachable. If Ollama wasn't already
  // in the chain, probe the local daemon and route through it rather than
  // failing the call — sovereign mode: a laptop with Ollama keeps working.
  if (!chain.includes('ollama')) {
    const probe = await probeOllamaCached();
    if (probe.reachable) {
      const model = pickOllamaModel(probe.models, config.llm.ollamaModel);
      log.warn({
        chain,
        ollamaModel: model,
        installedModels: probe.models,
      }, 'All cloud providers unreachable — auto-connecting to local Ollama (offline mode)');
      try {
        const result = await dispatchByMode('ollama', req, model);
        result.offlineFallback = true;
        result.notice = offlineNotice(result.model);
        return result;
      } catch (err) {
        lastError = err;
        log.error({ err }, 'Ollama offline rescue failed');
      }
    }
  }
  log.error({ chain, lastErrorMessage: (lastError as Error | undefined)?.message }, 'All providers in chain exhausted');
  throw new Error(`All LLM providers failed (chain: ${chain.join(',')}): ${(lastError as Error | undefined)?.message ?? 'unknown error'}`);
}

/**
 * Stream a response from the LLM. Yields content deltas.
 *
 * Streaming providers: DeepSeek, Moonshot, Ollama. Other modes (api/bridge/
 * direct) fall through to non-streaming `complete()` and yield once at end.
 *
 * Chain semantics: if the streaming setup fails BEFORE the first delta is
 * yielded with a recoverable network error, we fall through to `complete()`
 * which walks the full mode chain. Once any byte has been yielded, errors
 * become fatal — we cannot retroactively swap providers mid-stream.
 *
 * When `req.routingContext` is provided, the tier router determines the
 * primary streaming provider and model.
 */
export async function* completeStream(req: LlmRequest): AsyncGenerator<string, LlmResponse | null> {
  const config = getConfig();

  // Resolve routing decision once — used by both pickStreamProvider and the
  // non-streaming fallback path (complete() re-runs route() internally, which
  // is cheap, so we don't need to thread the decision through).
  const routingDecision = req.routingContext ? route(req.routingContext) : undefined;

  if (routingDecision) {
    log.info({
      routedProvider: routingDecision.provider,
      routedModel: routingDecision.model,
      routingReason: routingDecision.reason,
    }, 'LLM stream request (tier-routed)');
  }

  // Pick the streaming-capable provider for the primary mode.
  const streamProvider = pickStreamProvider(config, req, routingDecision?.provider, routingDecision?.model);

  if (streamProvider) {
    try {
      let yieldedAny = false;
      let result: IteratorResult<string, { content: string; model?: string; inputTokens?: number; outputTokens?: number }>;
      while (!(result = await streamProvider.gen.next()).done) {
        yieldedAny = true;
        yield result.value;
      }
      return withCost(streamProvider.providerId, result.value);
    } catch (err) {
      // If we already started yielding deltas, we can't fall back — bail.
      // Otherwise on a recoverable network error, fall through to complete()
      // which uses the full chain.
      if (!isRecoverableNetworkError(err)) throw err;
      const primaryMode = routingDecision?.provider ?? config.llm.mode;
      log.warn({ err: (err as Error).message, mode: primaryMode }, 'Stream setup failed (recoverable), falling back to non-streaming via chain');
    }
  }

  // Non-streaming fallback: yield entire response at once.
  // For api/bridge/direct primary modes — and for streaming-capable modes
  // when the streaming setup network-failed before any byte was yielded.
  const response = await complete(req);
  if (response) yield response.content;
  return response;
}

/**
 * Pick the streaming generator for the current primary mode. Returns null for
 * non-streaming modes (api/bridge/direct).
 *
 * @param primaryModeOverride - When provided (from the tier router), overrides
 *   `config.llm.mode` for provider selection.
 * @param modelOverride - When provided (from the tier router), overrides the
 *   per-provider default model.
 */
function pickStreamProvider(
  config: ReturnType<typeof getConfig>,
  req: LlmRequest,
  primaryModeOverride?: string,
  modelOverride?: string,
): {
  providerId: LlmProviderId;
  gen: AsyncGenerator<string, { content: string; model?: string; inputTokens?: number; outputTokens?: number }>;
} | null {
  const primaryMode = primaryModeOverride ?? config.llm.mode;

  // DeepSeek streaming (also covers api-mode-without-anthropic-key fallback).
  if (primaryMode === 'deepseek' || (primaryMode === 'api' && !config.llm.apiKey && config.llm.deepseekApiKey)) {
    return {
      providerId: 'deepseek-api',
      gen: callDeepSeekStream({
        systemPrompt: fullSystemPrompt(req),
        messages: req.messages,
        model: modelOverride ?? config.llm.deepseekModel,
        maxTokens: req.maxTokens,
      }),
    };
  }
  if (primaryMode === 'moonshot') {
    return {
      providerId: 'moonshot-api',
      gen: callMoonshotStream({
        systemPrompt: fullSystemPrompt(req),
        messages: req.messages,
        model: modelOverride ?? config.llm.moonshotModel,
        maxTokens: req.maxTokens,
      }),
    };
  }
  if (primaryMode === 'gemini') {
    return {
      providerId: 'gemini-api',
      gen: callGeminiStream({
        systemPrompt: fullSystemPrompt(req),
        messages: req.messages,
        model: modelOverride ?? config.llm.geminiModel,
        maxTokens: req.maxTokens,
      }),
    };
  }
  if (primaryMode === 'ollama') {
    return {
      providerId: 'ollama',
      gen: callOllamaStream({
        systemPrompt: fullSystemPrompt(req),
        messages: req.messages,
        model: modelOverride ?? config.llm.ollamaModel,
        maxTokens: req.maxTokens,
      }),
    };
  }
  return null;
}

/**
 * Wrap a batch result so callers can record it through the usual audit pipeline.
 * Always claude-api (only Anthropic offers batch). Sets batchMode=true so the
 * cost estimator applies the 50% multiplier.
 */
export function wrapBatchResult(result: {
  content: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}): LlmResponse {
  return withCost('claude-api', { ...result, batchMode: true });
}

// Re-export resilience observability for the gateway / MCP health endpoint.
export { getProviderHealth, getAllProviderHealth, resetProvider } from './resilience.js';
// Re-export operator maintenance-mode controls for the gateway / MCP tools.
export {
  enterMaintenance,
  exitMaintenance,
  getMaintenanceSnapshot,
  getAllMaintenanceSnapshots,
  ProviderMaintenanceError,
  KNOWN_LLM_PROVIDERS,
  assertKnownProvider,
} from './resilience.js';
export type { MaintenanceState, MaintenanceStatus, MaintenanceSnapshot, KnownLlmProvider } from './resilience.js';

/** Check if LLM provider is configured */
export function isConfigured(): boolean {
  const config = getConfig();
  if (!config.llm.enabled) return false;
  if (config.llm.mode === 'api') return !!(config.llm.apiKey || config.llm.deepseekApiKey);
  if (config.llm.mode === 'deepseek') return !!config.llm.deepseekApiKey;
  if (config.llm.mode === 'moonshot') return !!(config.llm.moonshotApiKey || config.llm.openrouterApiKey);
  if (config.llm.mode === 'gemini') return !!config.llm.geminiApiKey;
  if (config.llm.mode === 'ollama') return true; // Ollama is local, always available
  return true;
}

/** Reset client state */
export function resetClient(): void {
  // Re-init if needed
  const config = getConfig();
  if (config.llm.mode === 'api' && config.llm.apiKey) {
    initClient(config.llm.apiKey);
  }
}

import Anthropic from '@anthropic-ai/sdk';
import { createChildLogger } from '../shared/logger.js';
import type { AnthropicToolSpec, ToolUseBlock } from '../tools/chat-tools.js';

const log = createChildLogger({ module: 'llm-anthropic' });

let client: Anthropic | null = null;

export function initClient(apiKey: string): void {
  client = new Anthropic({ apiKey });
  log.info('Anthropic API client initialized');
}

export function getClient(): Anthropic | null {
  return client;
}

export interface AnthropicRequest {
  systemPrompt: string;
  /**
   * BRAIN B-8 (prompt-cache-aware kernel ordering). Content that changes on
   * every call — per-task skill matches, memory retrieval, session-specific
   * data — and therefore must never sit inside the cached prefix. When set,
   * `systemPrompt` is sent as its own `cache_control`-marked block and
   * `volatileSuffix` is appended as a SECOND, unmarked system block right
   * after it: the stable prefix keeps hitting the cache (0.1x input) even
   * though the volatile block is different on every call.
   */
  volatileSuffix?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  maxTokens?: number;
  /**
   * Phase 5d — Anthropic prompt caching. When true, the system prompt and
   * tools list are sent with `cache_control: { type: 'ephemeral' }` markers.
   * - System prompt: first cached block on every call
   * - Tools: cache marker placed on the LAST tool (Anthropic caches all
   *   tools UP TO the marked one, so marking the last covers everything)
   *
   * Pricing impact (Sonnet 4 5-min cache):
   *   - Cache WRITE: 1.25× normal input price (first call seeds the cache)
   *   - Cache READ: 0.10× normal input price (every subsequent call within 5 min)
   * Break-even at ~1.4 cached calls. Channel-mode workloads (same agent
   * system prompt repeatedly + same tool whitelist) hit ~95%+ cache rates.
   *
   * The SDK silently ignores cache markers on blocks below the per-model
   * minimum cacheable size (1024 tokens for Sonnet, 2048 for Haiku), so
   * setting this true is safe even for short prompts. Default true.
   */
  promptCacheEnabled?: boolean;
}

export interface AnthropicResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /**
   * Set when the tool-use loop hit `maxIterations`. Carries the tool-use
   * blocks the model emitted on the final iteration *that were already
   * executed* — the loop ran out of budget BEFORE the model could synthesize
   * a final reply consuming those tool_results. Useful for surfacing
   * "iteration cap hit" UX. Empty/undefined when the loop terminated normally.
   */
  cappedToolUses?: ToolUseBlock[];
  /** Number of tool-use iterations consumed (0 when no tools wired or model never requested tools). */
  toolIterations?: number;
  /**
   * Phase 5d — prompt caching usage. Both fields are summed across tool-loop
   * iterations. Unset when prompt cache was not requested or the provider
   * did not return cache stats (older SDK / model not supporting it).
   *
   * - `cacheCreationInputTokens`: tokens written to cache on this call
   *   (cache miss — pay 1.25× input price for these).
   * - `cacheReadInputTokens`: tokens read from cache on this call
   *   (cache hit — pay 0.10× input price for these).
   * - `inputTokens` continues to report the non-cached input tokens
   *   (charged at 100%).
   */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Callback invoked for each tool_use block the model emits during a tool
 * iteration. Should return a JSON-serialisable result; the caller stringifies
 * it for the tool_result content block.
 *
 * The ToolUseHandler is responsible for whitelist enforcement + audit logging
 * — see runtime/src/tools/chat-tools.ts:executeChatTool.
 */
export type ToolUseHandler = (call: { id: string; name: string; input: Record<string, unknown> }) => Promise<unknown>;

export interface AnthropicToolOptions {
  /** Tool specs to expose to the model (already whitelist-filtered). */
  tools: AnthropicToolSpec[];
  /** Handler invoked per tool_use block. */
  handle: ToolUseHandler;
  /** Cap iterations so a runaway model can't burn budget. Default 5. */
  maxIterations?: number;
}

/**
 * Call Anthropic Messages API directly.
 * No CLI dependency — just an API key.
 *
 * When `toolOpts` is provided, the model can request tool execution. We
 * iterate up to `toolOpts.maxIterations` times, feeding tool_results back
 * as user turns until the model emits a non-tool-use stop (`end_turn` or
 * `max_tokens`). Tool whitelist + audit are the caller's responsibility
 * — wire via `toolOpts.handle`.
 */
export async function callAnthropic(
  req: AnthropicRequest,
  toolOpts?: AnthropicToolOptions,
): Promise<AnthropicResponse> {
  if (!client) {
    throw new Error('Anthropic client not initialized — set ANTHROPIC_API_KEY');
  }

  const model = req.model || 'claude-sonnet-4-20250514';
  const maxTokens = req.maxTokens || 4096;
  const maxIterations = toolOpts?.maxIterations ?? 5;

  log.info({
    model,
    messageCount: req.messages.length,
    systemLength: req.systemPrompt.length,
    volatileSuffixLength: req.volatileSuffix?.length ?? 0,
    toolsWired: toolOpts ? toolOpts.tools.length : 0,
  }, 'Calling Anthropic API');

  const start = Date.now();

  // Mutable message history — string content for plain turns, content-block
  // arrays once we start carrying assistant tool_use + user tool_result turns.
  // The Anthropic SDK accepts both shapes.
  type AnthropicMessage = Anthropic.MessageParam;
  const messages: AnthropicMessage[] = req.messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreate = 0;
  let totalCacheRead = 0;
  let lastResponse: Anthropic.Message | null = null;
  let iterations = 0;

  // Phase 5d — prompt caching is opt-in via req.promptCacheEnabled.
  // Default ON because:
  //   1. Pure cost win for repeated system prompts (same agent definition
  //      called many times within 5 min)
  //   2. SDK silently ignores cache_control on blocks below the minimum
  //      cacheable size (1024 tokens for Sonnet), so it's a no-op for
  //      short prompts
  //   3. Break-even at ~1.4 calls; our chat-mode workloads do many more
  const cacheEnabled = req.promptCacheEnabled !== false;
  const volatileSuffix = req.volatileSuffix?.trim();
  // BRAIN B-8: when there's volatile content, split the system param into two
  // blocks — the stable prefix (cached) and the volatile suffix (uncached,
  // AFTER the boundary) — so the volatile block changing on every call never
  // busts the stable prefix's cache. With no volatile content this is
  // byte-identical to the pre-B-8 single-block behavior.
  const cachedSystem: Anthropic.TextBlockParam[] | string = cacheEnabled
    ? (volatileSuffix
        ? [
            { type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: volatileSuffix },
          ]
        : [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }])
    : (volatileSuffix ? `${req.systemPrompt}\n\n${volatileSuffix}` : req.systemPrompt);
  const cachedTools = cacheEnabled && toolOpts && toolOpts.tools.length > 0
    ? (toolOpts.tools.map((t, i, arr) =>
        i === arr.length - 1
          ? { ...t, cache_control: { type: 'ephemeral' as const } }
          : t,
      ) as Anthropic.Tool[])
    : toolOpts && toolOpts.tools.length > 0
      ? (toolOpts.tools as Anthropic.Tool[])
      : undefined;

  while (true) {
    const apiArgs: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      system: cachedSystem,
      messages,
    };
    if (cachedTools) {
      apiArgs.tools = cachedTools;
    }

    // SDK overloads complain about params; cast keeps the call site readable.
    const response = await client.messages.create(apiArgs as Anthropic.MessageCreateParamsNonStreaming);
    lastResponse = response;
    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    // Newer SDK versions expose cache_creation_input_tokens / cache_read_input_tokens
    // when prompt caching is engaged. Older SDKs return undefined — treat as 0.
    const usage = response.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
    totalCacheCreate += usage.cache_creation_input_tokens ?? 0;
    totalCacheRead += usage.cache_read_input_tokens ?? 0;

    if (!toolOpts || response.stop_reason !== 'tool_use') {
      // Either no tools wired, or the model finished. Done.
      break;
    }

    iterations++;

    // Append the assistant turn (which contains tool_use blocks) verbatim, then
    // a user turn with one tool_result block per tool_use the model emitted.
    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      try {
        const result = await toolOpts.handle({
          id: block.id,
          name: block.name,
          input: (block.input as Record<string, unknown>) || {},
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });

    if (iterations >= maxIterations) {
      // Don't loop again. The tool_use blocks in this iteration's response
      // were ALREADY executed and their results pushed onto the message
      // history above — the model just doesn't get a chance to synthesize a
      // final reply that consumes those tool_results. Surface them as
      // `cappedToolUses` so the caller can show "iteration cap hit; the
      // following tool calls completed but the agent didn't get to summarize".
      log.warn({ iterations, maxIterations }, 'Tool-use iteration cap reached — returning last response');
      const capped = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, input: (b.input as Record<string, unknown>) || {} }));
      const elapsed = Date.now() - start;
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      log.info({ model: response.model, totalInput, totalOutput, totalCacheCreate, totalCacheRead, elapsed, iterations, capped: true }, 'Anthropic API tool-loop capped');
      return {
        content: text,
        model: response.model,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        stopReason: 'tool_use_capped',
        cappedToolUses: capped,
        toolIterations: iterations,
        ...(cacheEnabled ? { cacheCreationInputTokens: totalCacheCreate, cacheReadInputTokens: totalCacheRead } : {}),
      };
    }
  }

  const elapsed = Date.now() - start;
  const finalText = lastResponse!.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  log.info({
    model: lastResponse!.model,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheCreationInputTokens: totalCacheCreate,
    cacheReadInputTokens: totalCacheRead,
    stopReason: lastResponse!.stop_reason,
    elapsed,
    iterations,
  }, 'Anthropic API response received');

  return {
    content: finalText,
    model: lastResponse!.model,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    stopReason: lastResponse!.stop_reason,
    toolIterations: iterations,
    ...(cacheEnabled ? { cacheCreationInputTokens: totalCacheCreate, cacheReadInputTokens: totalCacheRead } : {}),
  };
}

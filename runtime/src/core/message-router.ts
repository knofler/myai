import { v4 as uuid } from 'uuid';
import { createSession, addMessage, getSession } from './session-manager.js';
import { getAgent } from '../agents/loader.js';
import { createChildLogger } from '../shared/logger.js';
import { emit } from '../hooks/event-bus.js';
import { complete, completeStream, isConfigured } from '../llm/provider.js';
import type { LlmRequest } from '../llm/provider.js';
import type { GatewayMessage } from '../shared/types.js';
import { getConfig } from '../shared/config.js';
import { getChatModeTools, executeChatTool } from '../tools/chat-tools.js';
import type { AnthropicToolOptions } from '../llm/anthropic.js';
import { applyBudgetGuard, recordBudgetUsage } from '../llm/budget-guard.js';
import type { BudgetCheckResult, BudgetBlockReason } from '../llm/budget-guard.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';

const log = createChildLogger({ module: 'message-router' });

export interface RouteResult {
  sessionId: string;
  agentName: string;
  message: GatewayMessage;
  response?: GatewayMessage;
}

/**
 * Hard constraint appended to every channel-mode system prompt. Agent definitions
 * (.claude/agents/*.md) describe agents as if they have Read/Write/Edit/Bash tools
 * — true on the Claude Code CLI, false on the channel path where complete() is
 * called without a tool-use loop. Without this guardrail the LLM confabulates
 * action confirmations ("I created the ADR and pushed it") it cannot actually
 * perform.
 *
 * Used when chat-mode tools are NOT wired (the common case). When tools ARE
 * wired (chat-id allowlisted + Anthropic key present), `CHAT_MODE_TOOL_GUARDRAIL`
 * is used instead — it lists the allowed actions and points the model at the
 * tool surface rather than forbidding all action.
 */
export const CHAT_MODE_GUARDRAIL = `
IMPORTANT — CHAT MODE CONSTRAINTS:
You are running in CHAT MODE (Telegram/Discord/HTTP). You have NO file-system, git, shell, or network tools available. You CANNOT read files, write files, edit files, run commands, commit, push, or invoke any other agent.

When the user asks for an action:
- If the action produces an artifact (ADR, code, spec, plan, diff), output the artifact as markdown in your reply for the user to save manually. Do not claim you saved it.
- If the action requires execution (commit, push, run command, deploy, install), respond with the exact CLI command the user should run, and explicitly state you cannot execute it from chat.

NEVER claim past actions you did not take. Do not say "I created", "I wrote", "I saved", "I committed", "I pushed", "I merged", "I edited", "I ran", "I executed", "I deployed", "I installed", "I configured", or "I fixed" unless you are referring to text you produced in the current reply. Describe what should be done; let the user execute.
`.trim();

/**
 * Used when chat-mode tools ARE wired — the model can actually call a curated
 * subset of MCP tools. We still forbid action claims OUTSIDE tool calls
 * (because non-whitelisted ops like git push, file write, etc. remain
 * impossible from chat) but encourage the model to USE tools for read
 * operations rather than guess.
 */
export const CHAT_MODE_TOOL_GUARDRAIL = `
IMPORTANT — CHAT MODE WITH TOOLS:
You are running in CHAT MODE (Telegram/Discord/HTTP) with a CURATED set of read-mostly tools available (memory search, state read, repo status, task list/create, agent/skill discovery). Use them to answer factual questions about the framework state — do NOT guess.

You do NOT have file write, git, shell, deploy, or PR-creation tools. For any action requiring those:
- If it produces an artifact (ADR, code, spec, plan, diff), output the artifact as markdown in your reply for the user to save manually.
- If it requires execution (commit, push, run command, deploy, install), respond with the exact CLI command and explicitly state you cannot execute it from chat.

NEVER claim past actions outside tool calls. The only past actions you can truthfully claim are tool calls the system actually executed for you in this turn — those will appear as tool_result blocks in the conversation history.
`.trim();

/**
 * Regex matches first-person past-tense action verbs that imply file/git/shell
 * effects. Used to detect hallucinated action claims in LLM responses (Option D
 * defense-in-depth alongside the system-prompt guardrail).
 *
 * Notes:
 * - Supports both ASCII (`'`) and curly (`’` U+2019) apostrophes — LLMs often
 *   emit Unicode punctuation.
 * - `ran` was deliberately removed: it matched too many benign phrases like
 *   "I ran into an issue", "I ran out of time". `executed` covers the shell
 *   action-claim case without ambiguity.
 *
 * Word boundaries + alternation; case-insensitive.
 */
const HALLUCINATION_VERB_PATTERN = /\bI(?:['’]ve|\s+have)?\s+(?:just\s+)?(created|wrote|written|saved|added|committed|pushed|merged|deployed|deleted|removed|updated|edited|installed|executed|configured|fixed|implemented|generated|built|published|opened|closed|submitted)\b/i;

export function detectFalseActionClaims(content: string): boolean {
  return HALLUCINATION_VERB_PATTERN.test(content);
}

const HALLUCINATION_FOOTER = '\n\n⚠️ _Note: this reply was generated in chat mode — no files, commits, or commands were actually executed. If the response describes an action as completed, treat that as a description of what should be done, not what was done._';

/**
 * Compose a structured user-facing block message when the budget guard
 * trips a hard cap. We avoid raw $ values in the user-facing text
 * (estimator-derived; not invoice-accurate) but include them in the
 * response metadata so dashboards and logs can show exact figures.
 */
function composeBudgetBlockMessage(reason: BudgetBlockReason, snapshot: { mtd: number; today: number; channelMtd?: number }): string {
  const config = getConfig();
  const budgets = config.budgets;
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  switch (reason) {
    case 'monthly_hard':
      return `🛑 Monthly budget reached (${fmt(snapshot.mtd)} / ${fmt(budgets.monthlyHardCapUsd)}). Switch to a free local provider (e.g. \`ollama\`) or wait for the next billing cycle. — gateway budget guard`;
    case 'daily_hard':
      return `🛑 Daily budget reached (${fmt(snapshot.today)} / ${fmt(budgets.monthlyDailyCapUsd)}). Try again after 00:00 UTC, or switch to a free local provider. — gateway budget guard`;
    case 'channel_hard':
      return `🛑 This channel's monthly budget is reached (${fmt(snapshot.channelMtd ?? 0)} / ${fmt(budgets.perChannelMonthlyCapUsd ?? 0)}). Use another channel or contact ops. — gateway budget guard`;
  }
}

/**
 * Build a system prompt for the agent including its instructions
 * and the current session context.
 */
function buildSystemPrompt(
  agent: { name: string; description: string; instructions: string; category: string },
  toolsEnabled: boolean,
): string {
  return [
    `You are ${agent.name}, a specialist AI agent.`,
    `Category: ${agent.category}`,
    `Description: ${agent.description}`,
    '',
    'Your instructions:',
    agent.instructions,
    '',
    'Keep responses concise and helpful. Use markdown formatting when appropriate.',
    'You are responding via a messaging channel (Telegram/Discord/HTTP) — keep messages under 2000 characters when possible.',
    '',
    toolsEnabled ? CHAT_MODE_TOOL_GUARDRAIL : CHAT_MODE_GUARDRAIL,
  ].join('\n');
}

/**
 * Decide whether to wire chat-mode tools for this message. All conditions
 * must hold:
 *   - `chatTools.enabled` true in config
 *   - Anthropic API key configured AND `LLM_MODE=api` OR `api` in
 *     `LLM_MODE_CHAIN` (other providers silently drop `toolOpts`, so wiring
 *     them would only mislead the model via the tool-enabled guardrail
 *     while no tools actually fire)
 *   - The metadata identifies a chatId in the per-channel allowlist
 *     (`chatTools.allowedChatIds`)
 *
 * Returns null when tools should not be wired, or `AnthropicToolOptions`
 * with the whitelisted tool set + a handler that audit-logs each call.
 */
export function buildChatModeToolOpts(
  agentName: string,
  metadata: Record<string, unknown>,
): AnthropicToolOptions | null {
  const config = getConfig();
  if (!config.chatTools?.enabled) return null;
  if (!config.llm.apiKey) {
    log.warn('chatTools.enabled but ANTHROPIC_API_KEY missing — tool-use requires Anthropic provider; skipping');
    return null;
  }
  // Verify Anthropic is actually in the call path. `api` in LLM_MODE OR in the
  // fallback chain means the Anthropic provider will run for at least some
  // calls — without this, a user with `LLM_MODE=bridge` + `ANTHROPIC_API_KEY`
  // set would get the tool-enabled guardrail but no tools would ever fire.
  const modeChain = [config.llm.mode, ...(config.llm.modeChain ?? [])];
  if (!modeChain.includes('api')) {
    log.warn({ mode: config.llm.mode, chain: config.llm.modeChain }, 'chatTools.enabled but LLM_MODE/chain does not include "api" — Anthropic provider will not be called; skipping');
    return null;
  }
  const channelType = typeof metadata.channelType === 'string' ? metadata.channelType : '';
  const channelId = typeof metadata.channelId === 'string' ? metadata.channelId : '';
  const userId = typeof metadata.userId === 'string' ? metadata.userId : 'unknown';
  if (!channelType || !channelId) {
    // No channel context — this is a direct API call, not a chat. Skip.
    return null;
  }
  const allowed = config.chatTools.allowedChatIds || [];
  if (allowed.length > 0 && !allowed.includes(channelId)) {
    log.info({ channelType, channelId, allowedCount: allowed.length }, 'chat-tools: chat not in allowlist — skipping tool wiring');
    return null;
  }

  return {
    tools: getChatModeTools(),
    maxIterations: config.chatTools.maxIterations ?? 5,
    handle: async (call) => {
      return executeChatTool(call.name, call.input, {
        channelType,
        channelId,
        userId,
        agentName,
      });
    },
  };
}

/**
 * Convert session messages to Claude API format.
 * Only include the last N messages to stay within context limits.
 */
function buildMessageHistory(messages: GatewayMessage[], maxMessages = 20): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.metadata?.placeholder)
    .slice(-maxMessages)
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
}

export async function routeMessage(
  sessionId: string | undefined,
  agentName: string,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<RouteResult> {
  // Validate agent exists
  const agent = getAgent(agentName);
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found`);
  }

  // Get or create session
  let session = sessionId ? getSession(sessionId) : undefined;
  if (!session) {
    session = await createSession(DEFAULT_TENANT_ID, agentName, metadata);
  }

  // Create user message
  const userMessage: GatewayMessage = {
    id: uuid(),
    sessionId: session.id,
    role: 'user',
    content,
    agentName,
    metadata,
    timestamp: new Date(),
  };

  // Emit message:before hook (can block)
  const hookResult = await emit('message:before', {
    sessionId: session.id,
    agentName,
    message: userMessage,
  });

  if (hookResult.block) {
    throw new Error(`Message blocked: ${hookResult.reason}`);
  }

  // Add user message to session
  await addMessage(session.id, userMessage);

  log.info({
    sessionId: session.id,
    agentName,
    contentLength: content.length,
    llmEnabled: isConfigured(),
  }, 'Message routed');

  let responseContent: string;
  let responseMeta: Record<string, unknown> = {};

  if (isConfigured()) {
    // Build conversation history (exclude the message we just added — we'll include it explicitly)
    const priorMessages = buildMessageHistory(session.messages.slice(0, -1));
    const allMessages = [...priorMessages, { role: 'user' as const, content }];

    // Decide whether chat-mode tools should engage for this message.
    const toolOpts = buildChatModeToolOpts(agentName, metadata);
    const toolsEnabled = toolOpts !== null;

    try {
      const llmReq = {
        systemPrompt: buildSystemPrompt(agent, toolsEnabled),
        messages: allMessages,
        toolOpts: toolOpts ?? undefined,
      };

      // Phase 5b — budget guard. Default-off; no DB query unless BUDGETS_ENABLED.
      const channelId = typeof metadata.channelId === 'string' ? metadata.channelId : undefined;
      const channelType = typeof metadata.channelType === 'string' ? metadata.channelType : undefined;
      const guard = await applyBudgetGuard(llmReq, { tenantId: DEFAULT_TENANT_ID, channelId });

      if (!guard.allow && guard.reason) {
        responseContent = composeBudgetBlockMessage(guard.reason, guard.spendSnapshot);
        responseMeta = {
          budgetBlocked: true,
          budgetReason: guard.reason,
          spendSnapshot: guard.spendSnapshot,
        };
      } else {
        const llmResponse = await complete(guard.rewrittenReq);

        if (llmResponse) {
          responseContent = llmResponse.content;
          responseMeta = {
            provider: llmResponse.provider,
            toolsEnabled,
            toolIterations: llmResponse.toolIterations ?? 0,
          };
          if (guard.downgradedFrom) {
            responseMeta.budgetDowngradedFrom = guard.downgradedFrom;
          }
          if (llmResponse.cappedToolUses && llmResponse.cappedToolUses.length > 0) {
            // Tool-use iteration cap hit. The blocks in `cappedToolUses` ran
            // successfully — the model just didn't get to synthesize a final
            // reply that consumed their results. Surface to user so they know
            // why the answer might feel truncated.
            responseMeta.toolUseCapped = true;
            const toolNames = llmResponse.cappedToolUses.map(t => t.name).join(', ');
            responseContent = responseContent + `\n\n⚠️ _Tool-use iteration cap reached (${llmResponse.toolIterations} step(s)). Final tools ran (${toolNames}) but the agent did not get to summarise the combined results. Ask a more specific question or break the request into smaller steps._`;
          }
          if (llmResponse.offlineFallback && llmResponse.notice) {
            // BRAIN B6 — cloud unreachable, local Ollama answered. Always tell the user.
            responseMeta.offlineFallback = true;
            responseContent = responseContent + `\n\n⚠️ _${llmResponse.notice}_`;
          }
          if (guard.warning) {
            responseContent = responseContent + '\n\n' + guard.warning;
          }
          // Fire-and-forget audit-log write. Failures are logged inside the
          // module; a failed audit must not crash the gateway.
          void recordBudgetUsage(guard.rewrittenReq, llmResponse, {
            tenantId: DEFAULT_TENANT_ID,
            channelId,
            channelType,
            agentName: agent.name,
          });
        } else {
          responseContent = `[${agent.name}] LLM provider returned no response. Check that the Claude CLI bridge is running.`;
          responseMeta = { placeholder: true, error: 'no_response' };
        }
      }
    } catch (err) {
      log.error({ err, agentName }, 'LLM call failed');
      responseContent = `[${agent.name}] Error calling LLM: ${(err as Error).message}`;
      responseMeta = { placeholder: true, error: (err as Error).message };
    }
  } else {
    // No LLM configured — return placeholder
    responseContent = `[${agent.name}] Message received. Agent has ${agent.tools.length} tools available. Session has ${session.messages.length} messages.\n\nNote: Set LLM_ENABLED=true and start the Claude CLI bridge to enable AI responses.`;
    responseMeta = { placeholder: true };
  }

  // Defense-in-depth: if the LLM confabulated a past-tense action claim despite
  // the system-prompt guardrail, append a clarifying footer so the user is not
  // misled. See `detectFalseActionClaims` and `HALLUCINATION_FOOTER` above.
  if (!responseMeta.placeholder && detectFalseActionClaims(responseContent)) {
    log.warn({ sessionId: session.id, agentName }, 'False action claim detected — appending hallucination footer');
    responseContent = responseContent + HALLUCINATION_FOOTER;
    responseMeta = { ...responseMeta, hallucinationGuard: true };
  }

  // Create response message
  const response: GatewayMessage = {
    id: uuid(),
    sessionId: session.id,
    role: 'assistant',
    content: responseContent,
    agentName: agent.name,
    metadata: {
      agentCategory: agent.category,
      ...responseMeta,
    },
    timestamp: new Date(),
  };

  await addMessage(session.id, response);

  // Emit message:after hook
  await emit('message:after', {
    sessionId: session.id,
    agentName: agent.name,
    message: response,
  });

  // Real-time activity event (in-app SSE + history). Fire-and-forget; isolated
  // from the response path by the bus.
  emitNotifyEvent({
    type: 'message.routed',
    tenantId: DEFAULT_TENANT_ID,
    title: `${agent.name} replied`,
    level: 'info',
    source: 'message-router',
    data: { sessionId: session.id, agentName: agent.name },
  });

  return {
    sessionId: session.id,
    agentName: agent.name,
    message: userMessage,
    response,
  };
}

/**
 * Stream a message through the LLM and yield content deltas.
 * Handles session management, but lets the caller decide how to deliver chunks.
 */
export async function* routeMessageStream(
  sessionId: string | undefined,
  agentName: string,
  content: string,
  metadata: Record<string, unknown> = {},
): AsyncGenerator<string, RouteResult> {
  const agent = getAgent(agentName);
  if (!agent) throw new Error(`Agent "${agentName}" not found`);

  let session = sessionId ? getSession(sessionId) : undefined;
  if (!session) {
    session = await createSession(DEFAULT_TENANT_ID, agentName, metadata);
  }

  const userMessage: GatewayMessage = {
    id: uuid(),
    sessionId: session.id,
    role: 'user',
    content,
    agentName,
    metadata,
    timestamp: new Date(),
  };

  const hookResult = await emit('message:before', { sessionId: session.id, agentName, message: userMessage });
  if (hookResult.block) throw new Error(`Message blocked: ${hookResult.reason}`);

  await addMessage(session.id, userMessage);

  log.info({ sessionId: session.id, agentName, contentLength: content.length }, 'Message routed (streaming)');

  let fullContent = '';

  if (isConfigured()) {
    const priorMessages = buildMessageHistory(session.messages.slice(0, -1));
    const allMessages = [...priorMessages, { role: 'user' as const, content }];

    // Tool-use is incompatible with delta-streaming in this loop — tool_use
    // blocks arrive at the end and require synchronous tool execution + a
    // follow-up call. When tools are wired for this chat, force the
    // non-streaming path (yielding once at end). The Telegram in-place edit
    // still works; the user just sees the final reply rather than progressive
    // chunks for that turn.
    const toolOpts = buildChatModeToolOpts(agentName, metadata);
    const toolsEnabled = toolOpts !== null;

    // Phase 5b — budget guard. Default-off; no DB query unless BUDGETS_ENABLED.
    // We pre-check before the stream starts; once any byte is yielded we
    // cannot retroactively swap or block (matches the existing fallback contract).
    const streamChannelId = typeof metadata.channelId === 'string' ? metadata.channelId : undefined;
    const streamChannelType = typeof metadata.channelType === 'string' ? metadata.channelType : undefined;
    const baseReq = {
      systemPrompt: buildSystemPrompt(agent, toolsEnabled),
      messages: allMessages,
      toolOpts: toolOpts ?? undefined,
    };
    const streamGuard = await applyBudgetGuard(baseReq, { tenantId: DEFAULT_TENANT_ID, channelId: streamChannelId });

    if (!streamGuard.allow && streamGuard.reason) {
      fullContent = composeBudgetBlockMessage(streamGuard.reason, streamGuard.spendSnapshot);
      yield fullContent;
    } else if (toolsEnabled) {
      const llmResponse = await complete(streamGuard.rewrittenReq);
      if (llmResponse) {
        fullContent = llmResponse.content;
        if (llmResponse.cappedToolUses && llmResponse.cappedToolUses.length > 0) {
          const toolNames = llmResponse.cappedToolUses.map(t => t.name).join(', ');
          fullContent += `\n\n⚠️ _Tool-use iteration cap reached (${llmResponse.toolIterations} step(s)). Final tools ran (${toolNames}) but the agent did not get to summarise the combined results._`;
        }
        if (llmResponse.offlineFallback && llmResponse.notice) {
          fullContent += `\n\n⚠️ _${llmResponse.notice}_`;
        }
        if (streamGuard.warning) {
          fullContent += '\n\n' + streamGuard.warning;
        }
        void recordBudgetUsage(streamGuard.rewrittenReq, llmResponse, {
          tenantId: DEFAULT_TENANT_ID,
          channelId: streamChannelId,
          channelType: streamChannelType,
          agentName: agent.name,
        });
        yield fullContent;
      }
    } else {
      const gen = completeStream(streamGuard.rewrittenReq);

      let result: IteratorResult<string, import('../llm/provider.js').LlmResponse | null>;
      while (!(result = await gen.next()).done) {
        fullContent += result.value;
        yield result.value;
      }

      if (!fullContent && result.value) {
        fullContent = result.value.content;
      }
      if (result.value) {
        if (result.value.offlineFallback && result.value.notice) {
          const offlineLine = `\n\n⚠️ _${result.value.notice}_`;
          yield offlineLine;
          fullContent += offlineLine;
        }
        if (streamGuard.warning) {
          yield '\n\n' + streamGuard.warning;
          fullContent += '\n\n' + streamGuard.warning;
        }
        void recordBudgetUsage(streamGuard.rewrittenReq, result.value, {
          tenantId: DEFAULT_TENANT_ID,
          channelId: streamChannelId,
          channelType: streamChannelType,
          agentName: agent.name,
        });
      }
    }
  } else {
    fullContent = `[${agent.name}] Message received. Set LLM_ENABLED=true to enable AI responses.`;
    yield fullContent;
  }

  // Defense-in-depth: yield a clarifying footer if the streamed content
  // contained a confabulated action claim. We can't prepend (chunks already
  // delivered), so we append — Telegram edits the message in place so the
  // final view will include the warning.
  let hallucinationGuard = false;
  if (isConfigured() && detectFalseActionClaims(fullContent)) {
    log.warn({ sessionId: session.id, agentName }, 'False action claim detected in stream — yielding hallucination footer');
    yield HALLUCINATION_FOOTER;
    fullContent += HALLUCINATION_FOOTER;
    hallucinationGuard = true;
  }

  const response: GatewayMessage = {
    id: uuid(),
    sessionId: session.id,
    role: 'assistant',
    content: fullContent,
    agentName: agent.name,
    metadata: { agentCategory: agent.category, ...(hallucinationGuard ? { hallucinationGuard: true } : {}) },
    timestamp: new Date(),
  };

  await addMessage(session.id, response);
  await emit('message:after', { sessionId: session.id, agentName: agent.name, message: response });

  emitNotifyEvent({
    type: 'message.routed',
    tenantId: DEFAULT_TENANT_ID,
    title: `${agent.name} replied`,
    level: 'info',
    source: 'message-router',
    data: { sessionId: session.id, agentName: agent.name, streamed: true },
  });

  return {
    sessionId: session.id,
    agentName: agent.name,
    message: userMessage,
    response,
  };
}

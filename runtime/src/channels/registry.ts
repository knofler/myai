import { createChildLogger } from '../shared/logger.js';
import type { ChannelAdapter, ChannelConfig, ChannelMessage } from './types.js';
import { routeMessage, routeMessageStream } from '../core/message-router.js';
import { getSession, listSessions } from '../core/session-manager.js';
import { getAgent, listAgents } from '../agents/loader.js';
import type { TelegramAdapter } from './telegram.js';
import { parseChannelCommand, type ChannelCommand } from './command-parser.js';

const log = createChildLogger({ module: 'channel-registry' });

const adapters = new Map<string, ChannelAdapter>();

// Map channel sessions: "telegram:12345" → sessionId
const channelSessions = new Map<string, string>();

/** Simple agent routing from message content. Supports `/agent <name>` command. */
function selectAgent(content: string, currentSessionAgent?: string): string {
  // Explicit agent switch: /agent frontend-specialist
  const agentCmd = content.match(/^\/agent\s+(\S+)/i);
  if (agentCmd) {
    const name = agentCmd[1];
    if (getAgent(name)) return name;
  }

  // Keep current session agent if one exists
  if (currentSessionAgent && getAgent(currentSessionAgent)) {
    return currentSessionAgent;
  }

  // Default to solution-architect
  return 'solution-architect';
}

export function registerAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.type, adapter);
  log.info({ type: adapter.type }, 'Channel adapter registered');
}

export function getAdapter(type: string): ChannelAdapter | undefined {
  return adapters.get(type);
}

export function listAdapters(): ChannelAdapter[] {
  return Array.from(adapters.values());
}

/** Start all enabled adapters */
export async function startChannels(config: ChannelConfig): Promise<void> {
  for (const adapter of adapters.values()) {
    if (adapter.enabled) {
      try {
        await adapter.start();
        log.info({ type: adapter.type }, 'Channel started');
      } catch (err) {
        log.error({ type: adapter.type, err }, 'Channel failed to start');
      }
    }
  }
}

/** Stop all adapters */
export async function stopChannels(): Promise<void> {
  for (const adapter of adapters.values()) {
    try {
      await adapter.stop();
      log.info({ type: adapter.type }, 'Channel stopped');
    } catch (err) {
      log.error({ type: adapter.type, err }, 'Channel failed to stop');
    }
  }
}

/**
 * Dispatch a one-shot channel command (Phase 3 Chunk C).
 *
 * `invoke-agent` / `invoke-skill` run a single LLM call via the MCP tools
 * (agents_invoke / skills_invoke) — no conversational session, no history.
 * The Telegram "thinking…" UX is reused so the user gets immediate feedback.
 * `list-skills` / `skill-usage` are quick informational replies.
 *
 * Access control is already enforced upstream by each adapter (Telegram drops
 * messages from chats outside `allowedChatIds` before they reach here), so
 * dispatch matches the trust level of the existing conversational `/agent`.
 *
 * executeTool is imported dynamically to sidestep the registry → mcp/tools →
 * scheduler/morning-sweep → registry module cycle at load time.
 */
async function handleChannelCommand(command: ChannelCommand, msg: ChannelMessage): Promise<void> {
  const adapter = getAdapter(msg.channelType);
  if (!adapter) {
    log.warn({ channelType: msg.channelType }, 'No adapter for channel command');
    return;
  }
  const tg = msg.channelType === 'telegram' ? (adapter as TelegramAdapter) : null;

  // Informational replies — no LLM, answer immediately.
  if (command.kind === 'skill-usage') {
    await adapter.send(msg.channelId, command.name
      ? `Usage: \`/skill ${command.name}: <message>\`\nProvide a message after the colon. Use \`/skill list\` to see all skills.`
      : `Usage: \`/skill <name>: <message>\`\nRun a skill once with your message. \`/skill list\` shows all skills.`);
    return;
  }

  const { executeTool } = await import('../mcp/tools.js');

  if (command.kind === 'list-skills') {
    const result = await executeTool('skills_list', {}) as { skills?: Array<{ name: string; triggers?: string[] }> };
    const skills = result?.skills ?? [];
    if (skills.length === 0) {
      await adapter.send(msg.channelId, 'No skills available.');
      return;
    }
    const list = skills.map(s => `- \`${s.name}\``).join('\n');
    await adapter.send(msg.channelId, `Available skills (${skills.length}) — run with \`/skill <name>: <message>\`:\n${list}`);
    return;
  }

  // invoke-agent | invoke-skill — single LLM dispatch.
  if (command.kind !== 'invoke-agent' && command.kind !== 'invoke-skill') return;
  const isAgent = command.kind === 'invoke-agent';
  const toolName = isAgent ? 'agents_invoke' : 'skills_invoke';
  const toolArgs = isAgent
    ? { agent: command.name, message: command.message }
    : { skill: command.name, message: command.message };

  let thinkingMsgId: number | null = null;
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  if (tg) {
    await tg.sendTyping(msg.channelId).catch(() => {});
    thinkingMsgId = await tg.sendThinking(msg.channelId).catch(() => null);
    typingInterval = setInterval(() => tg.sendTyping(msg.channelId).catch(() => {}), 4000);
  }

  const startTime = Date.now();
  try {
    const result = await executeTool(toolName, toolArgs) as {
      content?: string;
      error?: string;
      provider?: string;
      costUsd?: number;
    };
    if (typingInterval) clearInterval(typingInterval);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    let body: string;
    if (result?.error) {
      body = `⚠️ ${result.error}`;
    } else {
      const header = isAgent ? `🤖 *${command.name}*` : `🛠 *${command.name}*`;
      const meta = [result?.provider, typeof result?.costUsd === 'number' ? `$${result.costUsd.toFixed(4)}` : null]
        .filter(Boolean).join(' · ');
      body = `${header}${meta ? ` _(${meta})_` : ''}\n\n${result?.content ?? 'No response'}\n\n_⏱ ${elapsed}s_`;
    }

    if (tg && thinkingMsgId) {
      const edited = await tg.editMessage(msg.channelId, thinkingMsgId, body);
      if (!edited) await tg.send(msg.channelId, body);
    } else {
      await adapter.send(msg.channelId, body);
    }
  } catch (err) {
    if (typingInterval) clearInterval(typingInterval);
    log.error({ channelType: msg.channelType, toolName, error: (err as Error).message }, 'One-shot command dispatch failed');
    const errBody = `Error: ${(err as Error).message}`;
    if (tg && thinkingMsgId) {
      await tg.editMessage(msg.channelId, thinkingMsgId, errBody).catch(() => {});
    } else {
      await adapter.send(msg.channelId, errBody).catch(() => {});
    }
  }
}

/**
 * Handle an incoming message from any channel.
 * Routes through the gateway message router, then sends the response
 * back through the channel adapter.
 */
export async function handleChannelMessage(msg: ChannelMessage): Promise<void> {
  const channelKey = `${msg.channelType}:${msg.channelId}`;

  log.info({
    channelType: msg.channelType,
    channelId: msg.channelId,
    userId: msg.userId,
    userName: msg.userName,
    contentLength: msg.content.length,
  }, 'Channel message received');

  // Phase 3 Chunk C — one-shot command center. `/agent <name>: <msg>` and
  // `/skill <name>: <msg>` dispatch a single invocation via the MCP tools
  // (agents_invoke / skills_invoke) without touching the conversational
  // session. Colon-less `/agent <name>` and `/agent list` fall through
  // (kind: 'none') to the existing conversational routing below.
  const command = parseChannelCommand(msg.content);
  if (command.kind !== 'none') {
    await handleChannelCommand(command, msg);
    return;
  }

  // Find or create a session for this channel+chat
  let sessionId = channelSessions.get(channelKey);

  // Verify session still exists
  if (sessionId && !getSession(sessionId)) {
    channelSessions.delete(channelKey);
    sessionId = undefined;
  }

  // Handle /agent command — switch agent and respond with confirmation
  const agentCmd = msg.content.match(/^\/agent\s+(\S+)/i);
  if (agentCmd) {
    const requestedAgent = agentCmd[1];
    if (requestedAgent === 'list') {
      const agents = listAgents().map(a => `- \`${a.name}\` — ${a.description.slice(0, 80)}`).join('\n');
      const adapter = getAdapter(msg.channelType);
      if (adapter) await adapter.send(msg.channelId, `Available agents:\n${agents}`);
      return;
    }
    if (!getAgent(requestedAgent)) {
      const adapter = getAdapter(msg.channelType);
      if (adapter) await adapter.send(msg.channelId, `Agent "${requestedAgent}" not found. Use /agent list to see available agents.`);
      return;
    }
    // Clear session to start fresh with new agent
    channelSessions.delete(channelKey);
    sessionId = undefined;
  }

  // Get current session's agent or select based on message
  const currentAgent = sessionId ? getSession(sessionId)?.agentName : undefined;
  const agentName = selectAgent(msg.content, currentAgent);

  // Strip /agent command from content before routing
  const routeContent = agentCmd ? msg.content.replace(/^\/agent\s+\S+\s*/, '').trim() || `Hello, I'd like to work with ${agentName}.` : msg.content;

  const adapter = getAdapter(msg.channelType);
  const isTelegram = adapter && msg.channelType === 'telegram';
  const tg = isTelegram ? adapter as TelegramAdapter : null;

  // Send instant "Thinking..." message + typing indicator (Telegram only)
  let thinkingMsgId: number | null = null;
  if (tg) {
    await tg.sendTyping(msg.channelId).catch(() => {});
    thinkingMsgId = await tg.sendThinking(msg.channelId).catch(() => null);
  }

  const startTime = Date.now();

  // Keep typing indicator alive (Telegram expires it after ~5s)
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  if (tg) {
    typingInterval = setInterval(() => tg.sendTyping(msg.channelId).catch(() => {}), 4000);
  }

  const routeMeta = {
    channelType: msg.channelType,
    channelId: msg.channelId,
    userId: msg.userId,
    userName: msg.userName,
    ...msg.metadata,
  };

  try {
    // Telegram: use streaming to progressively edit the "Thinking..." message
    if (tg && thinkingMsgId) {
      let accumulated = '';
      let lastEditLen = 0;
      let lastEditTime = 0;
      const EDIT_INTERVAL_MS = 1500;   // Edit at most every 1.5s
      const EDIT_MIN_CHARS = 80;       // Or when 80+ new chars accumulated

      const gen = routeMessageStream(sessionId, agentName, routeContent, routeMeta);
      let iterResult: IteratorResult<string, import('../core/message-router.js').RouteResult>;

      while (!(iterResult = await gen.next()).done) {
        accumulated += iterResult.value;
        const now = Date.now();
        const newChars = accumulated.length - lastEditLen;

        // Edit periodically — not every delta (Telegram rate limits edits)
        if (newChars >= EDIT_MIN_CHARS || (now - lastEditTime > EDIT_INTERVAL_MS && newChars > 0)) {
          await tg.editMessage(msg.channelId, thinkingMsgId, accumulated + '\n\n_...typing_').catch(() => {});
          lastEditLen = accumulated.length;
          lastEditTime = now;
        }
      }

      if (typingInterval) clearInterval(typingInterval);

      const result = iterResult.value;
      channelSessions.set(channelKey, result.sessionId);

      // Final edit with complete response + timing
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const finalContent = `${accumulated || result.response?.content || 'No response'}\n\n_⏱ ${elapsed}s_`;
      const edited = await tg.editMessage(msg.channelId, thinkingMsgId, finalContent);
      if (!edited) await tg.send(msg.channelId, finalContent);

    } else {
      // Non-Telegram or no thinking message: use standard non-streaming route
      const result = await routeMessage(sessionId, agentName, routeContent, routeMeta);
      if (typingInterval) clearInterval(typingInterval);

      channelSessions.set(channelKey, result.sessionId);

      if (result.response && adapter) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const content = `${result.response.content}\n\n_⏱ ${elapsed}s_`;
        await adapter.send(msg.channelId, content);
      }
    }
  } catch (err) {
    if (typingInterval) clearInterval(typingInterval);
    log.error({ channelKey, error: (err as Error).message, stack: (err as Error).stack }, 'Failed to handle channel message');

    // Edit thinking message with error, or send new
    if (thinkingMsgId && tg) {
      await tg.editMessage(msg.channelId, thinkingMsgId, `Error: ${(err as Error).message}`).catch(() => {});
    } else if (adapter) {
      await adapter.send(msg.channelId, `Error: ${(err as Error).message}`);
    }
  }
}

/** Clear a channel session (e.g. on /start to reset conversation) */
export function clearChannelSession(channelType: string, channelId: string): void {
  const key = `${channelType}:${channelId}`;
  channelSessions.delete(key);
}

/** Get active channel sessions count */
export function getChannelSessionCount(): number {
  return channelSessions.size;
}

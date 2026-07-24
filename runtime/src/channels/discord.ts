import { createChildLogger } from '../shared/logger.js';
import { handleChannelMessage } from './registry.js';
import type { ChannelAdapter, ChannelConfig } from './types.js';

const log = createChildLogger({ module: 'channel-discord' });

/**
 * Discord Bot adapter using the Discord Gateway API.
 * Zero dependencies — uses native WebSocket + fetch against the Discord API.
 *
 * Implements just enough of the Discord Gateway to receive messages:
 * - IDENTIFY handshake
 * - HEARTBEAT keep-alive
 * - MESSAGE_CREATE dispatch
 */
export class DiscordAdapter implements ChannelAdapter {
  readonly type = 'discord';
  readonly enabled: boolean;

  private token: string;
  private allowedChannelIds: Set<string>;
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastSequence: number | null = null;
  private botUserId: string | null = null;
  private running = false;

  private readonly API_BASE = 'https://discord.com/api/v10';
  private readonly GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

  constructor(config: NonNullable<ChannelConfig['discord']>) {
    this.enabled = config.enabled && !!config.token;
    this.token = config.token;
    this.allowedChannelIds = new Set(config.allowedChannelIds || []);
  }

  async start(): Promise<void> {
    if (!this.enabled) return;

    // Verify token
    const me = await this.apiCall('/users/@me');
    if (!me.id) throw new Error(`Discord bot auth failed: ${JSON.stringify(me)}`);
    this.botUserId = me.id;

    log.info({ botName: me.username, botId: me.id }, 'Discord bot authenticated');

    this.running = true;
    this.connectGateway();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Shutting down');
      this.ws = null;
    }
  }

  async send(channelId: string, content: string): Promise<void> {
    // Discord has a 2000 char limit
    const chunks = this.splitMessage(content, 2000);
    for (const chunk of chunks) {
      await this.apiCall(`/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: chunk }),
      });
    }
  }

  private connectGateway(): void {
    this.ws = new WebSocket(this.GATEWAY_URL);

    this.ws.onopen = () => {
      log.info('Discord Gateway connected');
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(String(event.data));
      this.handleGatewayMessage(data);
    };

    this.ws.onclose = (event) => {
      log.warn({ code: event.code, reason: event.reason }, 'Discord Gateway closed');
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      // Reconnect after 5s if still running
      if (this.running) {
        setTimeout(() => this.connectGateway(), 5000);
      }
    };

    this.ws.onerror = (err) => {
      log.error({ err }, 'Discord Gateway error');
    };
  }

  private handleGatewayMessage(data: { op: number; d: any; s?: number; t?: string }): void {
    if (data.s) this.lastSequence = data.s;

    switch (data.op) {
      case 10: // HELLO — start heartbeating and identify
        this.startHeartbeat(data.d.heartbeat_interval);
        this.identify();
        break;

      case 11: // HEARTBEAT_ACK
        break;

      case 0: // DISPATCH
        this.handleDispatch(data.t!, data.d);
        break;

      case 1: // HEARTBEAT request
        this.sendHeartbeat();
        break;

      case 7: // RECONNECT
        log.info('Discord requested reconnect');
        this.ws?.close(4000, 'Reconnecting');
        break;

      case 9: // INVALID SESSION
        log.warn('Discord invalid session — re-identifying in 5s');
        setTimeout(() => this.identify(), 5000);
        break;
    }
  }

  private identify(): void {
    this.ws?.send(JSON.stringify({
      op: 2,
      d: {
        token: this.token,
        intents: 1 << 9 | 1 << 15, // GUILD_MESSAGES | MESSAGE_CONTENT
        properties: {
          os: 'linux',
          browser: 'myai-gateway',
          device: 'myai-gateway',
        },
      },
    }));
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), intervalMs);
    // Send first heartbeat immediately
    this.sendHeartbeat();
  }

  private sendHeartbeat(): void {
    this.ws?.send(JSON.stringify({ op: 1, d: this.lastSequence }));
  }

  private async handleDispatch(eventType: string, data: any): Promise<void> {
    if (eventType === 'READY') {
      log.info({ user: data.user.username, guilds: data.guilds.length }, 'Discord bot ready');
      return;
    }

    if (eventType !== 'MESSAGE_CREATE') return;

    // Ignore own messages
    if (data.author.id === this.botUserId) return;

    // Ignore bot messages
    if (data.author.bot) return;

    const channelId = data.channel_id;

    // Access control
    if (this.allowedChannelIds.size > 0 && !this.allowedChannelIds.has(channelId)) {
      return; // silently ignore — too noisy to log every message in non-allowed channels
    }

    // Only respond to messages that mention the bot or are in DMs
    const isDM = data.guild_id === undefined;
    const mentionsBot = data.mentions?.some((m: any) => m.id === this.botUserId);

    if (!isDM && !mentionsBot) return;

    // Strip bot mention from content
    let content = data.content;
    if (mentionsBot) {
      content = content.replace(/<@!?\d+>/g, '').trim();
    }

    if (!content) return;

    await handleChannelMessage({
      channelType: 'discord',
      channelId,
      userId: data.author.id,
      userName: data.author.username,
      content,
      replyToId: data.referenced_message?.id,
    });
  }

  private async apiCall(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${this.API_BASE}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
    return res.json();
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf('\n', maxLen);
      if (splitIdx < maxLen / 2) splitIdx = maxLen;
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx);
    }
    return chunks;
  }
}

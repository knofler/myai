import { createChildLogger } from '../shared/logger.js';
import type { ChannelAdapter } from './types.js';

const log = createChildLogger({ module: 'channel-slack' });

/**
 * Slack adapter — outgoing Incoming Webhook only, no bot/Gateway connection.
 * Unlike Telegram/Discord (a fixed bot token, chat ids resolved at send time),
 * a Slack Incoming Webhook URL already encodes the destination workspace +
 * channel, so `channelId` passed to send() IS the webhook URL itself — either
 * the fleet-wide default (`SLACK_DEFAULT_WEBHOOK`, resolved by the notifier's
 * getDefaultChatId) or a tenant's own webhook (resolved by slack-notify.ts).
 * There is nothing to poll, so start()/stop() are no-ops.
 */
export class SlackAdapter implements ChannelAdapter {
  readonly type = 'slack';
  readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(webhookUrl: string, content: string): Promise<void> {
    if (!webhookUrl) throw new Error('Slack webhook URL required');
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Slack webhook post failed: ${res.status} ${body.slice(0, 200)}`);
    }
    log.debug({ status: res.status }, 'Slack webhook delivered');
  }
}

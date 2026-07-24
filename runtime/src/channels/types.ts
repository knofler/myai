/**
 * Channel abstraction — Telegram, Discord, or any messaging platform
 * that can send/receive messages through the gateway.
 */

export interface ChannelMessage {
  channelType: string;       // 'telegram' | 'discord'
  channelId: string;         // chat/channel ID on the platform
  userId: string;            // platform user ID
  userName?: string;         // display name
  content: string;           // message text
  replyToId?: string;        // platform message ID being replied to
  metadata?: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly type: string;
  readonly enabled: boolean;

  /** Connect to the platform and start listening */
  start(): Promise<void>;

  /** Disconnect gracefully */
  stop(): Promise<void>;

  /** Send a message to a specific channel/chat */
  send(channelId: string, content: string): Promise<void>;
}

export interface ChannelConfig {
  telegram?: {
    enabled: boolean;
    token: string;
    allowedChatIds?: string[];  // restrict to specific chats (empty = allow all)
  };
  discord?: {
    enabled: boolean;
    token: string;
    allowedChannelIds?: string[];
  };
}

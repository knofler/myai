import { createChildLogger } from '../shared/logger.js';
import { handleChannelMessage, clearChannelSession } from './registry.js';
import { isConfigured } from '../llm/provider.js';
import { executeTool } from '../mcp/tools.js';
import { SYSTEM_CONTEXT } from '../core/tenant-context.js';
import type { ChannelAdapter, ChannelConfig } from './types.js';

const log = createChildLogger({ module: 'channel-telegram' });

/** A single inline-keyboard button (Telegram Bot API `InlineKeyboardButton`, callback subset). */
export interface InlineButton {
  text: string;
  callback_data: string;
}

// rvw:<a|r>:<reviewId> — the review-approval callback contract (review-approval.ts mints it).
const REVIEW_CALLBACK_RE = /^rvw:([ar]):(.+)$/;

/**
 * Telegram Bot adapter using the Bot API via HTTPS polling.
 * No external dependencies — uses native fetch + long polling.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly type = 'telegram';
  readonly enabled: boolean;

  private token: string;
  private allowedChatIds: Set<string>;
  private baseUrl: string;
  private polling = false;
  private offset = 0;
  private abortController: AbortController | null = null;

  /** Send "typing..." chat action to show the bot is alive */
  async sendTyping(chatId: string): Promise<void> {
    await this.apiCall('sendChatAction', { chat_id: chatId, action: 'typing' });
  }

  /** Send a placeholder message and return its message_id for later editing */
  async sendThinking(chatId: string): Promise<number | null> {
    const result = await this.apiCall('sendMessage', {
      chat_id: chatId,
      text: '💭 _Thinking..._',
      parse_mode: 'Markdown',
    });
    return result.ok ? result.result.message_id : null;
  }

  /** Edit an existing message (used to replace "Thinking..." with the real response) */
  async editMessage(chatId: string, messageId: number, content: string): Promise<boolean> {
    const result = await this.apiCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: content,
      parse_mode: 'Markdown',
    });
    if (!result.ok) {
      // Markdown may fail — retry as plain text
      const plain = await this.apiCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: content,
      });
      return plain.ok;
    }
    return true;
  }

  constructor(config: NonNullable<ChannelConfig['telegram']>) {
    this.enabled = config.enabled && !!config.token;
    this.token = config.token;
    this.allowedChatIds = new Set(config.allowedChatIds || []);
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
  }

  async start(): Promise<void> {
    if (!this.enabled) return;

    // Verify token by calling getMe
    const me = await this.apiCall('getMe');
    if (!me.ok) {
      throw new Error(`Telegram bot auth failed: ${JSON.stringify(me)}`);
    }

    log.info({ botName: me.result.username, botId: me.result.id }, 'Telegram bot connected');

    // Start long polling
    this.polling = true;
    this.poll();
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Send a message with an inline keyboard (e.g. the review Approve/Reject
   * prompt) and return its message_id for later editing. Falls back to plain
   * text (no parse_mode) if Telegram rejects the Markdown, same as `send`.
   */
  async sendWithButtons(chatId: string, content: string, buttons: InlineButton[][]): Promise<number | null> {
    const reply_markup = { inline_keyboard: buttons };
    let result = await this.apiCall('sendMessage', {
      chat_id: chatId,
      text: content,
      parse_mode: 'Markdown',
      reply_markup,
    });
    if (!result.ok) {
      log.warn({ error: result.description }, 'Markdown send-with-buttons failed — retrying as plain text');
      result = await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: content,
        reply_markup,
      });
    }
    return result.ok ? result.result.message_id : null;
  }

  /** Acknowledge a callback_query — dismisses the button's loading spinner. */
  private async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
    await this.apiCall('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text, show_alert: showAlert } : {}),
    });
  }

  /**
   * Handle a tapped inline-keyboard button. Currently only the review
   * Approve/Reject contract (`rvw:<a|r>:<reviewId>`) is recognised — anything
   * else is acknowledged (dismiss the spinner) and otherwise ignored.
   */
  private async handleCallbackQuery(cq: {
    id: string;
    data?: string;
    from?: { id?: number | string };
    message?: { chat?: { id?: number | string }; message_id?: number; text?: string };
  }): Promise<void> {
    const data = cq.data || '';
    const chatId = cq.message?.chat?.id != null ? String(cq.message.chat.id) : '';

    // Same access control as inbound messages — a chat outside the allowlist
    // gets no action, just a dismissed spinner.
    if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(chatId)) {
      log.warn({ chatId }, 'Telegram callback_query from unauthorized chat — ignoring');
      await this.answerCallbackQuery(cq.id, 'Not authorized', true).catch(() => {});
      return;
    }

    const match = data.match(REVIEW_CALLBACK_RE);
    if (!match) {
      await this.answerCallbackQuery(cq.id).catch(() => {});
      return;
    }

    const [, action, reviewId] = match as [string, 'a' | 'r', string];
    const userId = cq.from?.id != null ? String(cq.from.id) : 'unknown';

    try {
      const { resolvePendingReview } = await import('../notifications/review-approval.js');
      const outcome = await resolvePendingReview(reviewId, action, userId);

      if (outcome.ok && outcome.taskId && outcome.tenantId && outcome.targetStatus) {
        try {
          await executeTool(
            'tasks_update',
            { taskId: outcome.taskId, status: outcome.targetStatus },
            { ...SYSTEM_CONTEXT, tenantId: outcome.tenantId },
          );
        } catch (err) {
          log.error({ err, taskId: outcome.taskId }, 'Failed to apply review-approval task transition');
          await this.answerCallbackQuery(cq.id, 'Failed to update task', true).catch(() => {});
          return;
        }
      }

      await this.answerCallbackQuery(cq.id, outcome.text, !outcome.ok).catch(() => {});
      if (chatId && cq.message?.message_id) {
        const prefix = cq.message.text ? `${cq.message.text}\n\n` : '';
        await this.editMessage(chatId, cq.message.message_id, `${prefix}${outcome.ok ? '✅' : '⚠️'} ${outcome.text}`).catch(() => {});
      }
    } catch (err) {
      log.error({ err, reviewId }, 'Failed to handle review-approval callback_query');
      await this.answerCallbackQuery(cq.id, 'Error processing action', true).catch(() => {});
    }
  }

  async send(channelId: string, content: string): Promise<void> {
    // Telegram has a 4096 char limit per message
    const chunks = this.splitMessage(content, 4096);
    for (const chunk of chunks) {
      // Try Markdown first, fall back to plain text if Telegram rejects it
      const result = await this.apiCall('sendMessage', {
        chat_id: channelId,
        text: chunk,
        parse_mode: 'Markdown',
      });
      if (!result.ok) {
        log.warn({ error: result.description }, 'Markdown send failed — retrying as plain text');
        await this.apiCall('sendMessage', {
          chat_id: channelId,
          text: chunk,
        });
      }
    }
  }

  private async poll(): Promise<void> {
    while (this.polling) {
      try {
        this.abortController = new AbortController();
        const result = await this.apiCall('getUpdates', {
          offset: this.offset,
          timeout: 30,         // long poll: 30 seconds
          allowed_updates: ['message', 'callback_query'],
        }, this.abortController.signal);

        if (!result.ok || !result.result) continue;

        for (const update of result.result) {
          this.offset = update.update_id + 1;

          // Skip edited messages — we only process new messages
          if (update.edited_message) continue;

          if (update.callback_query) {
            await this.handleCallbackQuery(update.callback_query);
            continue;
          }

          if (update.message?.text) {
            const chatId = String(update.message.chat.id);

            // Access control
            if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(chatId)) {
              log.warn({ chatId }, 'Telegram message from unauthorized chat — ignoring');
              continue;
            }

            // Handle bot commands
            if (update.message.text === '/start') {
              clearChannelSession('telegram', chatId);
              const llmStatus = isConfigured() ? 'AI responses enabled' : 'AI not configured (set ANTHROPIC_API_KEY)';
              await this.send(chatId, `Connected to myAI gateway.\n${llmStatus}\n\nCommands:\n/help — show all commands\n/work [repo] — dispatch work\n/dispatch — full dispatch cycle\n/schedules — list schedules\n/health — health check\n/brief — morning brief\n/sweep — evening sweep\n/agent <name>: <msg> — run an agent once\n/skill <name>: <msg> — run a skill once\n\nSend any message to chat with the current agent.`);
              continue;
            }
            if (update.message.text === '/help') {
              await this.send(chatId, `myAI Gateway Commands:\n\n*Status & Info:*\n/help — this message\n/status — check gateway status\n/health — health check + alerts\n/queue — task queue summary\n/costs — today's and MTD spend\n/repos — managed repos with health status\n/providers — LLM provider health\n/schedules — list active schedules\n\n*Actions:*\n/brief — run morning brief on demand\n/sweep — run evening sweep on demand\n/work [repo] — dispatch work (auto-pick or specify repo)\n/dispatch — run full dispatch cycle\n\n*Conversational (multi-turn):*\n/agent list — show all available agents\n/agent <name> — switch to a specific agent\n\n*One-shot dispatch (single invocation):*\n/agent <name>: <message> — run an agent once\n/skill list — show all available skills\n/skill <name>: <message> — run a skill once\n\nJust type normally to chat with the current agent (default: solution-architect).`);
              continue;
            }
            if (update.message.text === '/status') {
              const llmStatus = isConfigured() ? 'enabled' : 'disabled (no API key)';
              await this.send(chatId, `Gateway status: online\nLLM: ${llmStatus}`);
              continue;
            }

            // /queue — task queue summary
            if (update.message.text === '/queue') {
              try {
                const result = await executeTool('tasks_list', { status: 'pending,working,review,blocked' }) as any;
                const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
                if (tasks.length === 0) {
                  await this.send(chatId, 'Task Queue:\nNo pending tasks.');
                } else {
                  const top = tasks.slice(0, 10);
                  const lines = top.map((t: any) => {
                    const priority = t.priority ?? '?';
                    const title = t.title ?? 'untitled';
                    const repo = t.repo ?? '';
                    const status = t.status ?? 'unknown';
                    return `P${priority}: ${title}${repo ? ` (${repo})` : ''} — ${status}`;
                  });
                  const header = `Task Queue (${tasks.length} total):`;
                  await this.send(chatId, `${header}\n${lines.join('\n')}`);
                }
              } catch (err) {
                log.error({ err }, 'Failed to execute /queue command');
                await this.send(chatId, 'Failed to retrieve task queue.');
              }
              continue;
            }

            // /costs — budget status
            if (update.message.text === '/costs') {
              try {
                const result = await executeTool('budgets_status', {}) as any;
                // budgets_status returns BudgetStatus: today, mtd, monthlyHardCapUsd, monthlyDailyCapUsd
                const today = result?.today != null ? `$${Number(result.today).toFixed(2)}` : 'N/A';
                const mtd = result?.mtd != null ? Number(result.mtd).toFixed(2) : 'N/A';
                const limit = result?.monthlyHardCapUsd != null ? Number(result.monthlyHardCapUsd).toFixed(2) : '50.00';
                const dailyCap = result?.monthlyDailyCapUsd != null ? `$${Number(result.monthlyDailyCapUsd).toFixed(2)}` : '$5.00';
                const pct = (result?.mtd != null && result?.monthlyHardCapUsd != null && Number(result.monthlyHardCapUsd) > 0)
                  ? `${Math.round((Number(result.mtd) / Number(result.monthlyHardCapUsd)) * 100)}%`
                  : 'N/A';
                await this.send(chatId, `Budget Status:\nToday: ${today}\nMTD: $${mtd} / $${limit} (${pct})\nDaily cap: ${dailyCap}`);
              } catch (err) {
                log.error({ err }, 'Failed to execute /costs command');
                await this.send(chatId, 'Failed to retrieve budget status.');
              }
              continue;
            }

            // /brief — morning sweep on demand
            if (update.message.text === '/brief') {
              try {
                await this.send(chatId, 'Running morning brief...');
                const result = await executeTool('morning_sweep', { topN: 3, telegramChatId: chatId });
                const text = typeof result === 'string' ? result : (result as any)?.summary ?? JSON.stringify(result);
                await this.send(chatId, text);
              } catch (err) {
                log.error({ err }, 'Failed to execute /brief command');
                await this.send(chatId, 'Failed to run morning brief.');
              }
              continue;
            }

            // /sweep — evening sweep on demand
            if (update.message.text === '/sweep') {
              try {
                await this.send(chatId, 'Running evening sweep...');
                const result = await executeTool('evening_sweep', { telegramChatId: chatId });
                const text = typeof result === 'string' ? result : (result as any)?.summary ?? JSON.stringify(result);
                await this.send(chatId, text);
              } catch (err) {
                log.error({ err }, 'Failed to execute /sweep command');
                await this.send(chatId, 'Failed to run evening sweep.');
              }
              continue;
            }

            // /repos — managed repos with health status
            if (update.message.text === '/repos') {
              try {
                const result = await executeTool('health_status', {}) as any;
                const repos = Array.isArray(result?.repos) ? result.repos : [];
                if (repos.length === 0) {
                  await this.send(chatId, 'Managed Repos:\nNo repos found.');
                } else {
                  const lines = repos.map((r: any) => {
                    const name = r.name ?? r.repo ?? 'unknown';
                    const healthy = r.healthy ?? r.status === 'ok';
                    const indicator = healthy ? 'OK' : 'ISSUE';
                    const detail = r.issues ? ` — ${r.issues}` : '';
                    return `[${indicator}] ${name}${detail}`;
                  });
                  await this.send(chatId, `Managed Repos (${repos.length}):\n${lines.join('\n')}`);
                }
              } catch (err) {
                log.error({ err }, 'Failed to execute /repos command');
                await this.send(chatId, 'Failed to retrieve repo health.');
              }
              continue;
            }

            // /work [repo] — manual dispatch to a specific repo or auto-pick
            if (update.message.text.startsWith('/work')) {
              const repoArg = update.message.text.replace(/^\/work\s*/, '').trim();
              try {
                if (repoArg) {
                  await this.send(chatId, `Dispatching work to ${repoArg}...`);
                  const result = await executeTool('dispatch_cycle', { maxTasks: 1, repos: repoArg }) as any;
                  const dispatched = result?.tasksDispatched ?? 0;
                  const skipped = result?.tasksSkipped ?? 0;
                  await this.send(chatId, `Dispatch to ${repoArg}:\nDispatched: ${dispatched}\nSkipped: ${skipped}${result?.error ? `\nError: ${result.error}` : ''}`);
                } else {
                  await this.send(chatId, 'Dispatching work (auto-pick top repo)...');
                  const result = await executeTool('dispatch_cycle', { maxTasks: 3 }) as any;
                  const dispatched = result?.tasksDispatched ?? 0;
                  const skipped = result?.tasksSkipped ?? 0;
                  await this.send(chatId, `Auto-dispatch:\nDispatched: ${dispatched}\nSkipped: ${skipped}`);
                }
              } catch (err) {
                log.error({ err }, 'Failed to execute /work command');
                await this.send(chatId, `Failed to dispatch: ${(err as Error).message}`);
              }
              continue;
            }

            // /dispatch — trigger full dispatch cycle
            if (update.message.text === '/dispatch') {
              try {
                await this.send(chatId, 'Running full dispatch cycle...');
                const result = await executeTool('dispatch_cycle', {}) as any;
                const dispatched = result?.tasksDispatched ?? 0;
                const skipped = result?.tasksSkipped ?? 0;
                const duration = result?.durationMs ? `${Math.round(result.durationMs / 1000)}s` : 'N/A';
                await this.send(chatId, `Dispatch Cycle Complete:\nDispatched: ${dispatched}\nSkipped: ${skipped}\nDuration: ${duration}`);
              } catch (err) {
                log.error({ err }, 'Failed to execute /dispatch command');
                await this.send(chatId, `Failed to run dispatch: ${(err as Error).message}`);
              }
              continue;
            }

            // /schedules — list active schedules
            if (update.message.text === '/schedules') {
              try {
                const result = await executeTool('schedules_list', {}) as any;
                const schedules = Array.isArray(result?.schedules) ? result.schedules : (Array.isArray(result) ? result : []);
                if (schedules.length === 0) {
                  await this.send(chatId, 'Schedules:\nNo schedules configured.');
                } else {
                  const lines = schedules.map((s: any) => {
                    const name = s.name ?? 'unnamed';
                    const cron = s.cron ?? '?';
                    const enabled = s.enabled !== false ? 'ON' : 'OFF';
                    const lastStatus = s.lastStatus ?? 'never';
                    return `[${enabled}] ${name} — ${cron} (last: ${lastStatus})`;
                  });
                  await this.send(chatId, `Schedules (${schedules.length}):\n${lines.join('\n')}`);
                }
              } catch (err) {
                log.error({ err }, 'Failed to execute /schedules command');
                await this.send(chatId, 'Failed to retrieve schedules.');
              }
              continue;
            }

            // /health — health check status + alerts
            if (update.message.text === '/health') {
              try {
                const result = await executeTool('health_status', {}) as any;
                const overall = result?.gateway?.status ?? result?.overall ?? 'unknown';
                const parts: string[] = [`Health: ${overall}`];

                if (result?.gateway) {
                  parts.push(`Gateway: ${result.gateway.status ?? 'ok'}`);
                }
                if (result?.database) {
                  parts.push(`MongoDB: ${result.database.status ?? result.database}`);
                }
                if (result?.llm) {
                  parts.push(`LLM: ${result.llm.status ?? result.llm}`);
                }
                if (result?.repos) {
                  const repoCount = Array.isArray(result.repos) ? result.repos.length : (result.repos.count ?? '?');
                  parts.push(`Repos: ${repoCount}`);
                }
                await this.send(chatId, parts.join('\n'));
              } catch (err) {
                log.error({ err }, 'Failed to execute /health command');
                await this.send(chatId, 'Failed to retrieve health status.');
              }
              continue;
            }

            // /providers — LLM provider health
            if (update.message.text === '/providers') {
              try {
                const result = await executeTool('provider_health', {}) as any;
                const providers = Array.isArray(result?.providers) ? result.providers : [];
                if (providers.length === 0) {
                  await this.send(chatId, 'LLM Providers:\nNo provider data available.');
                } else {
                  const lines = providers.map((p: any) => {
                    const name = p.name ?? 'unknown';
                    const state = p.circuit_breaker ?? p.state ?? 'unknown';
                    let indicator: string;
                    if (state === 'closed' || state === 'healthy' || state === 'ok') {
                      indicator = 'OK';
                    } else if (state === 'half-open' || state === 'degraded') {
                      indicator = 'WARN';
                    } else {
                      indicator = 'DOWN';
                    }
                    const latency = p.latency_ms != null ? ` ${p.latency_ms}ms` : '';
                    return `[${indicator}] ${name} — ${state}${latency}`;
                  });
                  await this.send(chatId, `LLM Providers:\n${lines.join('\n')}`);
                }
              } catch (err) {
                log.error({ err }, 'Failed to execute /providers command');
                await this.send(chatId, 'Failed to retrieve provider health.');
              }
              continue;
            }

            await handleChannelMessage({
              channelType: 'telegram',
              channelId: chatId,
              userId: String(update.message.from?.id || 'unknown'),
              userName: update.message.from?.first_name || update.message.from?.username,
              content: update.message.text,
              replyToId: update.message.reply_to_message ? String(update.message.reply_to_message.message_id) : undefined,
            });
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') break;
        log.error({ err }, 'Telegram polling error — retrying in 5s');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  private async apiCall(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const url = `${this.baseUrl}/${method}`;
    const opts: RequestInit = {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal,
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
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
      // Try to split at a newline
      let splitIdx = remaining.lastIndexOf('\n', maxLen);
      if (splitIdx < maxLen / 2) splitIdx = maxLen; // no good newline, hard split
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx);
    }
    return chunks;
  }
}

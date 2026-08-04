/**
 * Chat-mode tool whitelist + Anthropic tool-spec adapter + audit log.
 *
 * Phase C: real MCP tool-use on the channel path. Telegram/Discord/HTTP
 * messages can now trigger tool execution via Anthropic's tool-use loop —
 * but only:
 *   1. When `chatTools.enabled` is true in config (env: CHAT_TOOLS_ENABLED=1)
 *   2. When the channel `chatId` is in `chatTools.allowedChatIds`
 *      (env: CHAT_TOOL_ALLOWED_CHATS=12345,67890)
 *   3. When the requested tool is in CHAT_MODE_TOOL_WHITELIST below
 *
 * Default whitelist is read-leaning: memory/state/repos/agents/skills/tasks
 * inspection plus `tasks_create` for actionable follow-up. Excluded for v1:
 * `state_update` (writes to state files), `schedules_*` (creates background
 * routines), `morning_sweep` (orchestrates LLM calls — re-entry risk),
 * `agents_invoke`/`skills_invoke` (re-entry into the LLM via a different
 * code path — keep tool-loop iteration accounting simple).
 *
 * The whitelist is intentionally conservative. Expand once we have:
 *   - Mongo-backed `ToolExecution` audit collection (we log to logger only
 *     for v1)
 *   - Per-tool rate limits
 *   - User-facing confirmation prompts for high-impact tools
 */

import { TOOL_DEFINITIONS, executeTool } from '../mcp/tools.js';
import type { McpToolDef } from '../mcp/tools.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'chat-tools' });

/** Tools that Telegram/Discord users can trigger via tool-use loop. */
export const CHAT_MODE_TOOL_WHITELIST: ReadonlyArray<string> = Object.freeze([
  // Memory + RAG (read-only)
  'memory_search',
  'memory_context',
  'memory_stats',
  // State (read-only)
  'state_read',
  // Tasks (read + create only — no mutation of existing rows from chat)
  'tasks_list',
  'tasks_create',
  'tasks_next',
  // Repos (read-only)
  'repos_list',
  'repos_status',
  'repos_priority',
  // Discovery
  'agents_list',
  'skills_list',
  // Schedules (read-only)
  'schedules_list',
  // Budgets — Phase 5b — read-only spend visibility. Mutators excluded by design (caps are env-driven).
  'budgets_status',
  'budgets_breakdown',
  'budgets_suggestions',
]);

/** Anthropic tool-spec format. Mirrors the SDK's expected shape. */
export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: McpToolDef['inputSchema'];
}

/** Anthropic tool_use content block returned by the model. */
export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Lookup an MCP tool definition by name. */
function findToolDef(name: string): McpToolDef | undefined {
  return TOOL_DEFINITIONS.find(t => t.name === name);
}

/** Predicate — is this tool name allowed in chat mode? */
export function isChatToolAllowed(name: string): boolean {
  return CHAT_MODE_TOOL_WHITELIST.includes(name);
}

/**
 * Build Anthropic tool specs for the chat-mode whitelist. Filters out any
 * whitelist entries whose MCP definition is missing (defensive — should
 * never happen unless the registry drifts from the whitelist).
 */
export function getChatModeTools(): AnthropicToolSpec[] {
  const specs: AnthropicToolSpec[] = [];
  for (const name of CHAT_MODE_TOOL_WHITELIST) {
    const def = findToolDef(name);
    if (!def) {
      log.warn({ tool: name }, 'Whitelisted chat tool has no MCP definition — drift between TOOL_DEFINITIONS and CHAT_MODE_TOOL_WHITELIST');
      continue;
    }
    specs.push({
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    });
  }
  return specs;
}

/**
 * Audit log payload. Args + result values are redacted by default so we
 * don't leak user prompts, state-file contents, or memory-search snippets
 * into log aggregators. The base logger has no `redact` config; redaction
 * happens HERE at the call site.
 *
 * For deeper forensics, the caller can opt into raw values by setting
 * env var `CHAT_TOOL_AUDIT_RAW=1` (e.g. for local debugging only — never
 * in production).
 */
export interface ToolAuditEntry {
  channelType: string;
  channelId: string;
  userId: string;
  agentName: string;
  toolName: string;
  argKeys: string[];
  argSize: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  resultSize?: number;
  /** Redacted-by-default. Only present when CHAT_TOOL_AUDIT_RAW=1. */
  argsRaw?: Record<string, unknown>;
  /** Redacted-by-default. Only present when CHAT_TOOL_AUDIT_RAW=1. Truncated to 200 chars. */
  resultPreview?: string;
}

function isRawAuditEnabled(): boolean {
  return process.env.CHAT_TOOL_AUDIT_RAW === '1' || process.env.CHAT_TOOL_AUDIT_RAW === 'true';
}

/**
 * Audit-log a chat-mode tool execution. v1 logs to the logger only;
 * future revisions should write to a Mongo `ToolExecution` collection
 * for query + dashboard visibility.
 */
export function recordToolExecution(entry: ToolAuditEntry): void {
  log.info(entry, 'chat-mode tool execution');
}

/**
 * Execute a chat-mode tool with the whitelist enforced. Throws if the
 * tool is not whitelisted. Returns the raw tool result; the caller is
 * responsible for serializing for the model.
 *
 * Audit log records key-set and sizes by default — raw values only when
 * `CHAT_TOOL_AUDIT_RAW=1`.
 */
export async function executeChatTool(
  name: string,
  args: Record<string, unknown>,
  audit: Pick<ToolAuditEntry, 'channelType' | 'channelId' | 'userId' | 'agentName'>,
): Promise<unknown> {
  const argKeys = Object.keys(args);
  const argSize = safeSize(args);
  const raw = isRawAuditEnabled();

  if (!isChatToolAllowed(name)) {
    const msg = `Tool "${name}" is not whitelisted for chat mode`;
    recordToolExecution({
      ...audit,
      toolName: name,
      argKeys,
      argSize,
      durationMs: 0,
      ok: false,
      error: msg,
      ...(raw ? { argsRaw: args } : {}),
    });
    throw new Error(msg);
  }
  const start = Date.now();
  try {
    const result = await executeTool(name, args);
    recordToolExecution({
      ...audit,
      toolName: name,
      argKeys,
      argSize,
      durationMs: Date.now() - start,
      ok: true,
      resultSize: safeSize(result),
      ...(raw ? { argsRaw: args, resultPreview: previewResult(result) } : {}),
    });
    return result;
  } catch (err) {
    recordToolExecution({
      ...audit,
      toolName: name,
      argKeys,
      argSize,
      durationMs: Date.now() - start,
      ok: false,
      error: (err as Error).message,
      ...(raw ? { argsRaw: args } : {}),
    });
    throw err;
  }
}

function safeSize(value: unknown): number {
  try {
    return typeof value === 'string' ? value.length : JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function previewResult(result: unknown, maxLen = 200): string {
  try {
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
  } catch {
    return '<unserializable>';
  }
}

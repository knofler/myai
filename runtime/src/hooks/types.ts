import type { GatewayMessage, Session } from '../shared/types.js';

// ── Hook Events ─────────────────────────────────────────

export type HookEvent =
  | 'session:start'
  | 'session:end'
  | 'message:before'
  | 'message:after'
  | 'agent:dispatch'
  | 'agent:complete'
  | 'tool:before'
  | 'tool:after'
  | 'error'
  | 'health:check';

// ── Hook Context ────────────────────────────────────────

export interface HookContext {
  event: HookEvent;
  sessionId?: string;
  session?: Session;
  agentName?: string;
  message?: GatewayMessage;
  toolName?: string;
  error?: Error;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

// ── Hook Result ─────────────────────────────────────────

export interface HookResult {
  /** If true, the action that triggered this hook is blocked */
  block?: boolean;
  /** Reason for blocking (shown in logs) */
  reason?: string;
  /** Additional metadata to attach to the event */
  metadata?: Record<string, unknown>;
}

// ── Hook Handler ────────────────────────────────────────

export type HookHandler = (ctx: HookContext) => Promise<HookResult | void>;

// ── Hook Registration ───────────────────────────────────

export interface HookRegistration {
  /** Unique name for this hook */
  name: string;
  /** Which event(s) this hook listens to */
  events: HookEvent[];
  /** The handler function */
  handler: HookHandler;
  /** Lower number = runs first. Built-in: 50, user TS: 75, bash-compat: 90 */
  priority: number;
  /** Timeout in ms. 0 = no timeout */
  timeout: number;
  /** Whether this hook is active */
  enabled: boolean;
  /** Source: 'builtin' | 'user' | 'bash' */
  source: 'builtin' | 'user' | 'bash';
}

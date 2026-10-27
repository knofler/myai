// claude-models.ts — the one place the default / retired Claude model ids live.
// Dependency-free on purpose: config.ts, anthropic.ts and anthropic-batch.ts all
// import it, and many unit tests vi.mock('../shared/config.js') wholesale.

/**
 * The Claude model the `api` provider uses when nothing more specific is
 * routed — every failover hop onto `api` (e.g. budget tier: deepseek → api)
 * dispatches with this. Kept in step with the router's `MODELS.standard`.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Claude model ids the Anthropic API no longer serves (404 not_found_error).
 * `.env.example` shipped `LLM_MODEL=claude-sonnet-4-20250514` for months, so
 * copied `.env` files still carry it; honouring it turns every api hop into a
 * hard failure — the dashboard /ask box died this way the moment DeepSeek was
 * unreachable. A retired id is ignored (with a warning) in favour of the default.
 */
export const RETIRED_CLAUDE_MODELS: ReadonlySet<string> = new Set([
  'claude-sonnet-4-20250514',
]);

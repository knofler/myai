/**
 * Offline detection + Ollama auto-connect (BRAIN B6).
 *
 * When every cloud provider in the LLM mode chain fails with a recoverable
 * network error (machine offline, provider outage, circuits open), the chain
 * walker in provider.ts calls `probeOllamaCached()` to ask the local Ollama
 * daemon whether it can serve inference instead. If it can, the call is
 * re-dispatched through the ollama provider and the response carries an
 * explicit offline notice — the user always knows a local model answered.
 *
 * Degraded-read (no gateway at all) is a separate path: git pull the brain
 * repo and read the compiled artifacts directly. See
 * documentation/BRAIN_OFFLINE.md for the full degradation ladder.
 */
import { createChildLogger } from '../shared/logger.js';
import { getConfig } from '../shared/config.js';

const log = createChildLogger({ module: 'llm-offline' });

export interface OllamaProbeResult {
  reachable: boolean;
  /** Model tags installed on the daemon (from GET /api/tags). */
  models: string[];
  latencyMs?: number;
  error?: string;
}

const PROBE_TIMEOUT_MS = 1_500;
const PROBE_CACHE_TTL_MS = 30_000;

let cached: { result: OllamaProbeResult; at: number } | null = null;

/** Strip the OpenAI-compat `/v1` suffix so we can hit Ollama's native API. */
export function ollamaRootUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

/**
 * Health-probe the local Ollama daemon via GET /api/tags.
 * Never throws — an unreachable daemon is a normal, expected state.
 */
export async function probeOllama(baseUrl?: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<OllamaProbeResult> {
  const root = ollamaRootUrl(baseUrl ?? getConfig().llm.ollamaBaseUrl ?? 'http://localhost:11434/v1');
  const start = performance.now();
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { reachable: false, models: [], error: `HTTP ${res.status}` };
    }
    const data = await res.json() as { models?: Array<{ name?: string }> };
    const models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    return { reachable: true, models, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return { reachable: false, models: [], error: (err as Error).message };
  }
}

/**
 * Cached probe — the offline rescue path may fire on every request while the
 * network is down; one probe per TTL window is enough.
 */
export async function probeOllamaCached(baseUrl?: string): Promise<OllamaProbeResult> {
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.result;
  const result = await probeOllama(baseUrl);
  cached = { result, at: Date.now() };
  if (!result.reachable) {
    log.debug({ error: result.error }, 'Ollama probe: daemon unreachable');
  }
  return result;
}

/** Test hook / manual reset — e.g. after the operator starts Ollama. */
export function resetOllamaProbeCache(): void {
  cached = null;
}

/**
 * Pick the model to run on Ollama. Prefer the configured model when the
 * daemon actually has it (exact tag or same base name before the `:` tag);
 * otherwise fall back to the first installed model so auto-connect still
 * works on a box where the configured default was never pulled.
 */
export function pickOllamaModel(installed: string[], configured?: string): string | undefined {
  if (configured) {
    const base = configured.split(':')[0];
    if (installed.some((m) => m === configured || m.split(':')[0] === base)) return configured;
  }
  if (installed.length > 0) return installed[0];
  return configured; // nothing listed — let the daemon decide/error
}

/** The user-visible notice attached to responses served by the offline path. */
export function offlineNotice(model?: string): string {
  return `Offline mode: cloud LLM providers unreachable — this response was served by local Ollama${model ? ` (${model})` : ''}. Quality may differ from cloud models; normal routing resumes automatically once connectivity returns.`;
}

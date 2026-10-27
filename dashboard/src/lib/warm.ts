// Warm the server data cache (perceived-performance playbook, layer 2 "warm").
//
// After a container restart (the 08:00 boot rebuilds it every morning) the
// first /brain and /context visit paid ~2s filling the cache. The server now
// warms itself once at startup (instrumentation.ts) by calling /api/warm.
//
// Each read MUST use exactly the args the screens use, or it fills an entry
// nobody reads: the shell badge calls fetchBrainExplore([]) → {sections: []},
// /context calls fetchBrainExplore() → {}, and the /brain overview tab asks for
// TAB_SECTIONS.overview. Keep WARM_READS in step with those call sites.
import { cachedGatewayRead } from '@/lib/server-cache';

export const WARM_READS: ReadonlyArray<{ tool: string; args: Record<string, unknown>; screen: string }> = [
  { tool: 'brain_health', args: { record: false }, screen: 'shell badge, /brain advanced' },
  { tool: 'brain_explore', args: { sections: [] }, screen: 'shell badge, /brain advanced' },
  { tool: 'brain_explore', args: {}, screen: '/context' },
  { tool: 'brain_explore', args: { sections: ['atoms', 'provenance'] }, screen: '/brain overview' },
];
// brain_host_status is NOT warmed: on a self-hosted stack the gateway answers
// "the local operator tenant is self-hosted — not hostable" (an error → null),
// so it can never be cached and would make /api/warm report 502 forever.

export interface WarmResult {
  tool: string;
  screen: string;
  ms: number;
  ok: boolean;
}

/** One at a time: every read hits the same gateway, which walks the same brain git store. */
export async function runWarm(): Promise<WarmResult[]> {
  const out: WarmResult[] = [];
  for (const r of WARM_READS) {
    const t = Date.now();
    const v = await cachedGatewayRead<unknown>(r.tool, r.args);
    out.push({ tool: r.tool, screen: r.screen, ms: Date.now() - t, ok: v !== null });
  }
  return out;
}

const TOKEN_KEY = '__myaiWarmToken';

/** Per-process random token: only this server process (its startup hook) can call /api/warm. */
export function warmToken(): string {
  const g = globalThis as Record<string, unknown>;
  if (typeof g[TOKEN_KEY] !== 'string') g[TOKEN_KEY] = crypto.randomUUID();
  return g[TOKEN_KEY] as string;
}

/** Startup self-call (instrumentation) or a scheduler with CRON_SECRET (Vercel cron sends `Bearer`). */
export function warmAuthorized(headers: Headers): boolean {
  if (headers.get('x-warm-token') === warmToken()) return true;
  const secret = process.env.CRON_SECRET;
  return !!secret && headers.get('authorization') === `Bearer ${secret}`;
}

// Hook enable/disable toggle logic (MYAI_DASHBOARD.md §3.2) — the pure parts
// of the /api/hooks PATCH route and the registry hooks-tab toggle, split out
// so they're unit-testable without Next.js request machinery.

export interface HookPatch {
  name: string;
  enabled: boolean;
}

/** Validate a PATCH /api/hooks body. Returns null on any malformed input. */
export function parseHookPatch(body: unknown): HookPatch | null {
  if (typeof body !== 'object' || body === null) return null;
  const { name, enabled } = body as Record<string, unknown>;
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return null;
  if (typeof enabled !== 'boolean') return null;
  return { name, enabled };
}

/** Optimistic update: new list with one hook's enabled flag flipped. */
export function toggleHookInList<T extends { name: string; enabled: boolean }>(
  hooks: T[],
  name: string,
  enabled: boolean,
): T[] {
  return hooks.map(h => (h.name === name ? { ...h, enabled } : h));
}

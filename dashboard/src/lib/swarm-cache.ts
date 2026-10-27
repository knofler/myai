// Short per-tenant snapshot cache for GET /api/swarm — absorbs several tabs and
// phones polling every 10s. Every swarm/mail ACTION route clears it, so the
// console's refresh right after Approve/Stop/Ack always sees the new state.
// (Per server instance: on Vercel another warm instance may serve a snapshot
// at most TTL_MS old — that bound is why it is 3s, not longer.)
const TTL_MS = 3_000;
const store = new Map<string, { at: number; value: unknown }>();

export function getCachedSnapshot<T>(tenantId: string): T | null {
  const hit = store.get(tenantId);
  return hit && Date.now() - hit.at < TTL_MS ? (hit.value as T) : null;
}

export function setCachedSnapshot(tenantId: string, value: unknown): void {
  store.set(tenantId, { at: Date.now(), value });
}

export function invalidateSwarmCache(): void {
  store.clear();
}

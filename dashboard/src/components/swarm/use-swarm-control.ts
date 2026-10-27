'use client';

// useSwarmControl — poll GET /api/swarm/control (the gateway's swarm_live
// aggregate) for surfaces outside /swarm, e.g. Today's swarm decisions and
// summary. Several components on one page each poll; the route's 3s
// per-tenant cache makes that one gateway read. null = not loaded yet.
import { useEffect, useState } from 'react';
import type { SwarmControlResponse } from '@/lib/swarm-control';

export function useSwarmControl(intervalMs = 30_000): SwarmControlResponse | null {
  const [data, setData] = useState<SwarmControlResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/swarm/control', { cache: 'no-store' });
        if (res.ok && alive) setData((await res.json()) as SwarmControlResponse);
      } catch {
        /* keep the last good snapshot; the next tick retries */
      }
    };
    void load();
    const t = setInterval(() => void load(), intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return data;
}

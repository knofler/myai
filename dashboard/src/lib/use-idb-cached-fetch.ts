'use client';

// Stale-while-revalidate client data hook (web-perceived-performance
// playbook, layers 3-4): on mount, paint whatever snapshot IndexedDB has for
// `key` immediately — no spinner for a repeat visit — then fetch `url` live
// and persist the result as the next snapshot. Repeats every `pollMs` while
// the tab is visible, same polling discipline as the hand-rolled version this
// replaces (components/swarm-ops-console.tsx pre-task-f0ee909e).
//
// A failed fetch (network down, gateway unreachable) never clears what's on
// screen — it keeps the last good data and flips `offline` true, so a caller
// renders "showing cached data from Xs ago · offline" instead of a blank
// error state (operator NOTE, task-f0ee909e: gateway fetch failures must
// degrade gracefully).
import { useCallback, useEffect, useRef, useState } from 'react';
import { readCache, writeCache } from '@/lib/idb-cache';

export interface CachedFetchState<T> {
  data: T | null;
  /** ISO timestamp of the data currently shown — from cache or the last successful fetch. */
  fetchedAt: string | null;
  /** True until the first paint (cache or live) has happened. */
  loading: boolean;
  /** True when the most recent fetch failed — `data` is stale, not missing. */
  offline: boolean;
  error: string | null;
  /** Force an immediate fetch (e.g. after a write action), bypassing the poll interval. */
  refresh: () => Promise<void>;
}

export function useIdbCachedFetch<T>(key: string, url: string, { pollMs }: { pollMs?: number } = {}): CachedFetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may write state: a slow poll that resolves after
  // a later one (or after a refresh()) must not clobber the newer result.
  const seq = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    inFlight.current = true;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fresh = (await res.json()) as T;
      if (mine !== seq.current) return;
      const now = new Date().toISOString();
      setData(fresh);
      setFetchedAt(now);
      setOffline(false);
      setError(null);
      void writeCache(key, fresh);
    } catch (err) {
      if (mine !== seq.current) return;
      setOffline(true);
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      if (mine === seq.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [key, url]);

  // Mount: paint the cached snapshot at once, then kick off the live fetch —
  // the two race, but the live fetch always wins once it resolves (it runs
  // through the same seq-guarded setData path).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await readCache<T>(key);
      if (cancelled || !cached) return;
      setData((current) => current ?? cached.data);
      setFetchedAt((current) => current ?? cached.fetchedAt);
      setLoading(false);
    })();
    void load();
    return () => {
      cancelled = true;
    };
  }, [key, load]);

  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !inFlight.current) void load();
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, load]);

  return { data, fetchedAt, loading, offline, error, refresh: load };
}

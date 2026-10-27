// Generic client-side snapshot cache over IndexedDB — the storage primitive
// behind stale-while-revalidate client data (web-perceived-performance
// playbook, layer 4). Prior art: foh's apps/web/lib/queryPersister.ts (same
// repo family, PRs #21-#23) persists a whole React Query client; this repo
// has no React Query dependency, so instead each page/query stores one JSON
// snapshot keyed by a cache key (e.g. 'swarm-console'), read back on the next
// mount so a reload paints the last good data before the live fetch resolves.
//
// IndexedDB rather than localStorage: a snapshot is read/written as a
// structured-cloned object, no synchronous JSON parse on the main thread, and
// no ~5MB cap.
//
// Every failure is swallowed. Storage is a speed-up, never a dependency: with
// none available (a private window, a blocked origin, a full disk, or no
// `indexedDB` global at all — e.g. this module imported during SSR) callers
// just see no cached entry and fall back to a live fetch.

const DB_NAME = 'myai-dashboard-cache';
const STORE = 'snapshots';

export interface CachedEntry<T> {
  data: T;
  /** ISO timestamp of when `data` was fetched (not when it was cached). */
  fetchedAt: string;
}

function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Read the cached entry for `key`, or undefined if absent or storage is unavailable. */
export async function readCache<T>(key: string): Promise<CachedEntry<T> | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as CachedEntry<T> | undefined);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    } finally {
      db.close();
    }
  });
}

/** Write `data` as the cached entry for `key`, stamped with the current time. */
export async function writeCache<T>(key: string, data: T): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const entry: CachedEntry<T> = { data, fetchedAt: new Date().toISOString() };
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    } finally {
      db.close();
    }
  });
}

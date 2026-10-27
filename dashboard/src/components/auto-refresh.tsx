'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Re-fetches the server component data on an interval — keeps every board
 *  live without a websocket. Default cadence: 15s.
 *
 *  Paused while the tab is hidden: a background tab used to keep re-rendering
 *  its route on the server (every 4 s on /fleet) and clearing the router cache
 *  for nothing. Refreshes once when the tab becomes visible again. */
export default function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') Promise.resolve(router.refresh()).catch(() => {});
    };
    const id = setInterval(refresh, seconds * 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [router, seconds]);
  return null;
}

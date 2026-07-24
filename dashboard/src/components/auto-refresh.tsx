'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Re-fetches the server component data on an interval — keeps every board
 *  live without a websocket. Default cadence: 15s. */
export default function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      Promise.resolve(router.refresh()).catch(() => {});
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

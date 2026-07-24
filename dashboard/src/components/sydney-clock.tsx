'use client';

import { useEffect, useState } from 'react';

/** Live Sydney wall clock chip. Renders nothing until mounted to avoid a
 *  server/client hydration mismatch. */
export function SydneyClock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () =>
      setNow(new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-800/80 border border-zinc-700/60 text-xs font-mono text-zinc-300 tabular-nums">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      SYD {now ?? '—'}
    </span>
  );
}

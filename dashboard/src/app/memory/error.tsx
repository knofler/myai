'use client';

import { useEffect } from 'react';

export default function MemoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[myAI] Memory page error:', error);
  }, [error]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mt-12 text-center space-y-4">
        <h2 className="text-lg font-semibold text-[rgb(var(--text-primary))]">Memory store unavailable</h2>
        <p className="text-sm text-[rgb(var(--text-muted))] max-w-md mx-auto">
          {error.message || 'Could not load memory data.'}
        </p>
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[rgb(var(--bg-hover))] border border-zinc-700 text-sm text-[rgb(var(--text-primary))] hover:bg-zinc-700 transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

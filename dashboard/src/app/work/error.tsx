'use client';

import { useEffect } from 'react';

export default function WorkError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[myAI] Work page error:', error);
  }, [error]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mt-12 text-center space-y-4">
        <h2 className="text-lg font-semibold text-[rgb(var(--text-primary))]">Failed to load work queue</h2>
        <p className="text-sm text-[rgb(var(--text-muted))] max-w-md mx-auto">
          {error.message || 'Could not connect to the database.'}
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

'use client';

import { useEffect } from 'react';

export default function SystemError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[myAI] System page error:', error);
  }, [error]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mt-12 text-center space-y-4">
        <h2 className="text-lg font-semibold text-zinc-200">System view unavailable</h2>
        <p className="text-sm text-zinc-500 max-w-md mx-auto">
          {error.message || 'Could not load system data.'}
        </p>
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

'use client';

import { useEffect } from 'react';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[myAI] Root error boundary caught:', error);
  }, [error]);

  return (
    <div className="max-w-xl mx-auto mt-24 text-center space-y-5">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/30">
        <span className="text-2xl text-red-400">!</span>
      </div>
      <h1 className="text-xl font-bold text-zinc-200">Something went wrong</h1>
      <p className="text-sm text-zinc-500 max-w-sm mx-auto">
        {error.message || 'An unexpected error occurred.'}
      </p>
      {error.digest && (
        <p className="text-xs text-zinc-600 font-mono">Digest: {error.digest}</p>
      )}
      <button
        onClick={reset}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        Try again
      </button>
    </div>
  );
}

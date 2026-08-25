'use client';

// Enabled on/off switch for a recurring runner task (task-b8ddab7d) — the one
// interactive control on /work's Recurring tab. PATCHes
// /api/recurring/[recurringId] then refreshes the server component tree.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function RecurringToggle({ recurringId, enabled }: { recurringId: string; enabled: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  async function toggle() {
    setError(false);
    const res = await fetch(`/api/recurring/${encodeURIComponent(recurringId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !enabled }),
    });
    if (!res.ok) {
      setError(true);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isPending}
      role="switch"
      aria-checked={enabled}
      title={error ? 'Toggle failed — try again' : enabled ? 'On — click to pause' : 'Off — click to resume'}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
        error
          ? 'bg-red-500/20 border-red-500/50'
          : enabled
            ? 'bg-emerald-500/30 border-emerald-500/50'
            : 'bg-zinc-700/50 border-zinc-600'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
          enabled ? 'translate-x-[18px] bg-emerald-400' : 'translate-x-[3px] bg-zinc-400'
        }`}
      />
    </button>
  );
}

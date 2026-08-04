'use client';

// Approve/reject buttons for one review-queue entry (ADR-028 §4). Posts to
// the version's decision route, then routes back to the queue on success —
// the transition table (in_review → approved | draft) enforces legality
// server-side, so a double-decision on a stale page just surfaces the 409.
//
// The route is operator-only (requireOperator, src/lib/require-operator.ts —
// x-admin-token vs ADMIN_API_TOKEN, same env var every other operator-only
// dashboard route uses): this panel is only reachable/usable at all on a
// deployment where that token is configured, and the operator running it
// enters the token here — it is never baked into the client bundle.
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function MarketplaceReviewActions({ listingId, version }: { listingId: string; version: string }) {
  const router = useRouter();
  const [reviewedBy, setReviewedBy] = useState('operator');
  const [adminToken, setAdminToken] = useState('');
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'reject') {
    setPending(decision);
    setError(null);
    try {
      const res = await fetch(`/api/marketplace/review/${listingId}/${encodeURIComponent(version)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ decision, reviewedBy }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'decision failed');
        return;
      }
      router.push('/marketplace/review');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={reviewedBy}
        onChange={(e) => setReviewedBy(e.target.value)}
        placeholder="reviewer id"
        className="bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 text-sm text-zinc-200 w-40"
      />
      <input
        type="password"
        value={adminToken}
        onChange={(e) => setAdminToken(e.target.value)}
        placeholder="operator token"
        autoComplete="off"
        className="bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 text-sm text-zinc-200 w-40"
      />
      <button
        type="button"
        onClick={() => decide('approve')}
        disabled={pending !== null}
        className="px-3 py-1.5 text-sm rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-50"
      >
        {pending === 'approve' ? 'Approving…' : 'Approve'}
      </button>
      <button
        type="button"
        onClick={() => decide('reject')}
        disabled={pending !== null}
        className="px-3 py-1.5 text-sm rounded-md bg-red-500/15 border border-red-500/40 text-red-400 hover:bg-red-500/25 disabled:opacity-50"
      >
        {pending === 'reject' ? 'Rejecting…' : 'Reject'}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

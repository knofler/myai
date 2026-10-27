'use client';

// Reviews panel for a marketplace listing detail page — review list (newest
// first) + a submit/edit form gated on the tenant having a live install
// (POST /api/marketplace/listings/[slug]/reviews enforces this server-side;
// the client just reflects `reviewGate`). Same router.refresh()-after-mutate
// posture as MarketplaceInstallPanel: the server is the source of truth.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Review } from '@/lib/marketplace';

const BTN = 'px-3 py-1.5 text-sm rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const BTN_PRIMARY = `${BTN} bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:border-emerald-500/60`;

function Stars({ rating, onPick }: { rating: number; onPick?: (n: number) => void }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onPick}
          onClick={() => onPick?.(n)}
          className={`text-lg leading-none ${n <= rating ? 'text-amber-400' : 'text-zinc-700'} ${onPick ? 'cursor-pointer hover:text-amber-300' : ''}`}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export function MarketplaceReviewsPanel({
  slug,
  reviews,
  myReview,
  reviewGate,
}: {
  slug: string;
  reviews: Review[];
  myReview: Review | null;
  reviewGate: { ok: boolean; reason?: string };
}) {
  const router = useRouter();
  const [rating, setRating] = useState(myReview?.rating ?? 0);
  const [comment, setComment] = useState(myReview?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (rating < 1) {
      setError('pick a star rating');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/marketplace/listings/${slug}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `request failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setError('request failed — dashboard unreachable');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {reviewGate.ok ? (
        <div className="flex flex-col gap-2 pb-4 border-b border-[rgb(var(--border-subtle))]/60">
          <div className="flex items-center gap-3">
            <Stars rating={rating} onPick={setRating} />
            <span className="text-xs text-[rgb(var(--text-muted))]">{myReview ? 'editing your review' : 'leave a review'}</span>
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What did you think?"
            aria-label="Review comment"
            maxLength={2000}
            rows={2}
            className="w-full text-sm bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-md px-2.5 py-2 text-[rgb(var(--text-primary))] placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 focus-visible:ring-2 focus-visible:ring-zinc-500/50"
          />
          <div>
            <button className={BTN_PRIMARY} disabled={busy} onClick={submit}>
              {busy ? 'Saving…' : myReview ? 'Update review' : 'Submit review'}
            </button>
          </div>
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        </div>
      ) : (
        <p className="text-xs text-zinc-600 pb-4 border-b border-[rgb(var(--border-subtle))]/60">{reviewGate.reason}</p>
      )}

      {reviews.length === 0 ? (
        <p className="text-sm text-[rgb(var(--text-muted))]">No reviews yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {reviews.map((r) => (
            <li key={r.reviewId} className="text-sm">
              <div className="flex items-center gap-2">
                <Stars rating={r.rating} />
                <span className="text-label text-[rgb(var(--text-muted))]">{r.installerTenantId}</span>
                <span className="text-label text-zinc-600">{new Date(r.createdAt).toLocaleDateString()}</span>
              </div>
              {r.comment && <p className="text-[rgb(var(--text-secondary))] mt-1">{r.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

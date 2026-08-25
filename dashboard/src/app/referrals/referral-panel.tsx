'use client';

import { useEffect, useState } from 'react';

interface ReferralStats {
  code: string;
  enabled: boolean;
  referralCount: number;
  creditsEarned: number;
}

/**
 * Fetches the tenant's tracked invite code + stats from /api/referrals
 * (JWT-cookie proxy → gateway /api/referrals/me) and renders the shareable
 * `/welcome?ref=<code>` link with a copy button — same copy-to-clipboard
 * mechanic as the savings/proof share cards.
 */
export default function ReferralPanel() {
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/referrals', { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.error) setError(json.error);
        else setStats(json);
      })
      .catch(() => { if (!cancelled) setError('failed to load referral stats'); });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="gel-surface p-5 rounded-2xl border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-muted))]">
        Couldn&apos;t load your referral link — try refreshing.
      </div>
    );
  }
  if (!stats) {
    return <div className="gel-surface p-5 rounded-2xl border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-muted))]">Loading…</div>;
  }

  const link = typeof window !== 'undefined' ? `${window.location.origin}/welcome?ref=${stats.code}` : '';

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — link is still selectable below */ }
  }

  return (
    <div className="gel-surface p-5 rounded-2xl border border-[rgb(var(--border-subtle))] space-y-4">
      {!stats.enabled && (
        <div className="px-3 py-2 rounded-lg bg-amber-950/40 border border-amber-800/40 text-xs text-amber-300">
          The referral program isn&apos;t live yet — sharing this link won&apos;t grant credits until it is.
        </div>
      )}
      <div>
        <span className="block text-xs text-[rgb(var(--text-muted))] mb-1">Your invite link</span>
        <div className="flex gap-2">
          <code className="flex-1 px-3 py-2 rounded-lg bg-[rgb(var(--bg-page))] border border-[rgb(var(--border-subtle))] text-xs text-teal-300 break-all font-mono select-all">
            {link}
          </code>
          <button
            type="button"
            onClick={copyLink}
            className="gel-brand shrink-0 px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 transition"
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div className="flex gap-6 text-sm">
        <div>
          <span className="block text-2xl font-semibold text-[rgb(var(--text-primary))]">{stats.referralCount}</span>
          <span className="text-xs text-[rgb(var(--text-muted))]">Successful referrals</span>
        </div>
        <div>
          <span className="block text-2xl font-semibold text-[rgb(var(--text-primary))]">{stats.creditsEarned}</span>
          <span className="text-xs text-[rgb(var(--text-muted))]">Credits earned</span>
        </div>
      </div>
    </div>
  );
}

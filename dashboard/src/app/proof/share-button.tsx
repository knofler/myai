'use client';

import { useState } from 'react';

/**
 * Copy-to-clipboard + native-share button for the public continuity-savings
 * proof card. Sibling to /savings/share-button.tsx and /recap/share-button.tsx
 * — one tap puts the public share-image URL on the clipboard (or opens the OS
 * share sheet). No auth, no tenant scoping — this is the outward-facing GTM
 * asset, safe to hand to anyone.
 */
export default function ShareButton({ cardUrl, text }: { cardUrl: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = typeof window !== 'undefined' ? new URL(cardUrl, window.location.origin).href : cardUrl;
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.share) {
      try {
        await nav.share({ title: 'myAI — continuity savings', text, url });
        return;
      } catch { /* user cancelled — fall through to copy */ }
    }
    try {
      await nav?.clipboard?.writeText(`${text} ${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — no-op */ }
  }

  return (
    <button
      type="button"
      onClick={share}
      className="inline-flex items-center gap-2 rounded-lg bg-teal-500/10 border border-teal-500/40 px-4 py-2 text-sm font-semibold text-teal-300 hover:bg-teal-500/20 transition-colors"
    >
      <span aria-hidden>↗</span>
      {copied ? 'Copied!' : 'Share this card'}
    </button>
  );
}

'use client';

import { useState } from 'react';

/**
 * Copy-to-clipboard + native-share button for the year-in-review recap card.
 * Sibling to /savings/share-button.tsx — one tap puts the share-image URL on
 * the clipboard (or opens the OS share sheet) so the customer drops the recap
 * into Slack / X / a deck.
 */
export default function ShareButton({ cardUrl, text }: { cardUrl: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = typeof window !== 'undefined' ? new URL(cardUrl, window.location.origin).href : cardUrl;
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.share) {
      try {
        await nav.share({ title: 'myAI — year in review', text, url });
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
      className="inline-flex items-center gap-2 rounded-lg bg-purple-500/10 border border-purple-500/40 px-4 py-2 text-sm font-semibold text-purple-300 hover:bg-purple-500/20 transition-colors"
    >
      <span aria-hidden>↗</span>
      {copied ? 'Copied!' : 'Share this card'}
    </button>
  );
}

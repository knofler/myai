'use client';

import { useState } from 'react';

/**
 * Copy-to-clipboard + native-share button for the savings card. The viral
 * mechanic: one tap puts the share-image URL on the clipboard (or opens the OS
 * share sheet) so the operator drops "myAI saved me N tokens" into Slack / X.
 */
export default function ShareButton({ cardUrl, text }: { cardUrl: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = typeof window !== 'undefined' ? new URL(cardUrl, window.location.origin).href : cardUrl;
    // Native share sheet where available (mobile), else clipboard copy.
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.share) {
      try {
        await nav.share({ title: 'myAI — tokens saved', text, url });
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
      className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/40 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 transition-colors"
    >
      <span aria-hidden>↗</span>
      {copied ? 'Copied!' : 'Share this card'}
    </button>
  );
}

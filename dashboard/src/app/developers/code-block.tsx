'use client';

// Small copy-to-clipboard wrapper for the /developers quickstart snippets —
// same copy affordance as the raw-key reveal in api-keys-manager.tsx, reused
// here so every curl block on the page is copy-pasteable in one click.
import { useState } from 'react';

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (insecure context, permissions) — no-op;
      // the code is still selectable/readable in the <pre>.
    }
  }

  return (
    <div className="relative group rounded-lg border border-[rgb(var(--border-subtle))] bg-black/60 overflow-hidden">
      {label && (
        <div className="px-4 py-1.5 border-b border-[rgb(var(--border-subtle))] text-[11px] uppercase tracking-wide text-[rgb(var(--text-muted))]">
          {label}
        </div>
      )}
      <pre className="px-4 py-3 overflow-x-auto text-xs leading-relaxed text-[rgb(var(--text-primary))]">
        <code>{code}</code>
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 rounded border border-zinc-700 bg-[rgb(var(--bg-surface))]/90 px-2 py-1 text-[11px] text-[rgb(var(--text-secondary))] opacity-0 group-hover:opacity-100 hover:text-[rgb(var(--text-primary))] hover:bg-[rgb(var(--bg-hover))] transition-opacity"
        aria-label="Copy to clipboard"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

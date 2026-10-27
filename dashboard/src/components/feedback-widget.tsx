'use client';

// FeedbackWidget — lightweight in-app feedback capture (design-partner
// program, GRAND_PRODUCT §7.4). A floating button opens a small form; submit
// posts to /api/feedback (JWT-authenticated proxy → gateway core/feedback.ts),
// which persists it and fire-and-forget emails the operator. No reply thread,
// no ticket workflow — the minimum viable loop for an early cohort to get
// feedback in front of the operator without leaving the app.

import { useState } from 'react';
import { usePathname } from 'next/navigation';

type Category = 'bug' | 'idea' | 'general';

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'idea', label: 'Idea' },
  { value: 'bug', label: 'Bug' },
];

export function FeedbackWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>('general');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function reset() {
    setCategory('general');
    setMessage('');
    setError(null);
    setSent(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, message: message.trim(), page: pathname }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'failed to send feedback');
      setSent(true);
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send feedback');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-testid="feedback-widget-open"
        className="fixed bottom-4 right-4 z-40 px-3 py-2 rounded-full gel-brand text-xs font-medium text-teal-100 shadow-lg hover:brightness-110 transition"
        aria-label="Send feedback"
      >
        💬 Feedback
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={() => {
            setOpen(false);
            reset();
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="gel-surface w-full max-w-sm p-5 rounded-2xl border border-[rgb(var(--border-subtle))]"
          >
            {sent ? (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-[rgb(var(--text-primary))]">Thanks! 🙏</h3>
                <p className="text-xs text-[rgb(var(--text-secondary))]">Your feedback was sent to the team.</p>
                <button
                  onClick={() => {
                    setOpen(false);
                    reset();
                  }}
                  className="w-full px-3 py-2 rounded-lg border border-[rgb(var(--border-subtle))] text-xs text-[rgb(var(--text-primary))] hover:border-zinc-700 transition"
                >
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-3">
                <h3 className="text-sm font-semibold text-[rgb(var(--text-primary))]">Send feedback</h3>
                {error && (
                  <div className="px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
                    {error}
                  </div>
                )}
                <div className="flex gap-1.5">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setCategory(c.value)}
                      className={`px-2.5 py-1 rounded-full text-label border transition ${
                        category === c.value
                          ? 'border-teal-600 text-teal-300 bg-teal-950/40'
                          : 'border-[rgb(var(--border-subtle))] text-[rgb(var(--text-muted))]'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="What's working, what's not, what would help?"
                  rows={4}
                  maxLength={4000}
                  required
                  className="w-full px-3 py-2 rounded-lg bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-primary))] placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors resize-none"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      reset();
                    }}
                    className="flex-1 px-3 py-2 rounded-lg border border-[rgb(var(--border-subtle))] text-xs text-[rgb(var(--text-primary))] hover:border-zinc-700 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !message.trim()}
                    className="flex-1 gel-brand px-3 py-2 rounded-lg text-xs font-semibold text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    {busy ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

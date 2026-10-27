'use client';

// Mission Control's ask-or-give-a-task bar (mockup screen 1, plan/design/
// mockups/01-home.png). One input, two modes:
//   ask  → /search?q=…  (the existing brain search)
//   task → POST /api/onboarding/launch (the EXISTING endpoint the first-run
//          wizard uses; it queues a pending Task on a registered repo) then
//          lands on the queue. No new API route.
// The chips are the mockup's Task · Research · Build · More; each one is an
// existing destination, and "More" opens the global action sheet.

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { GLOBAL_ACTION_EVENT } from '@/lib/nav-v2';
import { cn } from '@/lib/utils';

type Mode = 'ask' | 'task';

export function AskBar({ repos }: { repos: string[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>('ask');
  const [text, setText] = useState('');
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Give a task" from the global action sheet lands here as /?ask=task.
  useEffect(() => {
    if (params.get('ask') === 'task') {
      setMode('task');
      inputRef.current?.focus();
    }
  }, [params]);

  const canTask = repos.length > 0;
  const placeholder =
    mode === 'task'
      ? canTask
        ? 'Describe the task…'
        : 'Connect a repo first, then give it a task'
      : 'Ask your AI or give it a task…';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    if (mode === 'ask') {
      router.push(`/search?q=${encodeURIComponent(q)}`);
      return;
    }
    if (!canTask) {
      router.push('/welcome/start');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/onboarding/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Array.from so a 160-char cut never splits a surrogate pair (emoji).
        body: JSON.stringify({ repo, taskTitle: Array.from(q).slice(0, 160).join(''), taskDescription: q, priority: 'P2' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not queue the task (${res.status})`);
      }
      setText('');
      router.push('/work?tab=queue');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue the task');
    } finally {
      setBusy(false);
    }
  }

  const chips: { label: string; onClick: () => void; active?: boolean }[] = [
    // Toggles: tap again to go back to asking (review finding — it was one-way).
    { label: 'Task', active: mode === 'task', onClick: () => { setMode((m) => (m === 'task' ? 'ask' : 'task')); inputRef.current?.focus(); } },
    { label: 'Research', onClick: () => router.push(text.trim() ? `/search?q=${encodeURIComponent(text.trim())}` : '/search') },
    { label: 'Build', onClick: () => router.push('/apps/new') },
    { label: 'More', onClick: () => window.dispatchEvent(new Event(GLOBAL_ACTION_EVENT)) },
  ];

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-3"
      aria-label={mode === 'task' ? 'Give your AI a task' : 'Ask your AI'}
    >
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          maxLength={2000}
          disabled={busy}
          className="min-h-tap min-w-0 flex-1 bg-transparent text-body text-[rgb(var(--text-primary))] outline-none placeholder:text-[rgb(var(--text-muted))]"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          aria-label={mode === 'task' ? 'Queue task' : 'Ask'}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--accent))] text-[rgb(var(--accent-fg))] transition-opacity disabled:opacity-30"
        >
          <span aria-hidden="true">→</span>
        </button>
      </div>

      {mode === 'task' && repos.length > 1 && (
        <label className="mt-2 flex items-center gap-2 text-meta text-[rgb(var(--text-secondary))]">
          <span>for</span>
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="min-h-tap rounded-lg border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-canvas))] px-2 text-meta text-[rgb(var(--text-primary))]"
          >
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={c.onClick}
            aria-pressed={c.active}
            className={cn(
              'min-h-tap rounded-full px-3 text-meta font-medium transition-colors',
              c.active
                ? 'bg-[rgb(var(--accent))]/15 text-[rgb(var(--accent))]'
                : 'bg-[rgb(var(--bg-canvas))] text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))]',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-meta text-[rgb(var(--err))]">
          {error}
        </p>
      )}
    </form>
  );
}

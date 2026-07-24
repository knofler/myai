'use client';

// /apps/new — the "New App" flow (MVP M3 / §7.2 Day 5).
// Describe an app idea → POST /api/apps/new, which registers it in the App
// Directory and queues the agentFlow pipeline (init blueprint) for the
// off-hours runner. On success we route back to /apps where the new card
// shows a "scaffolding queued" status.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const PRIORITIES = [
  { value: 'P1', label: 'P1 — soon' },
  { value: 'P2', label: 'P2 — normal' },
  { value: 'P3', label: 'P3 — whenever' },
] as const;

interface NewAppResult {
  ok: boolean;
  repoName: string;
  taskId: string;
  message: string;
}

export default function NewAppPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [githubSlug, setGithubSlug] = useState('');
  const [priority, setPriority] = useState<string>('P2');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NewAppResult | null>(null);

  const inputCls =
    'w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/apps/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          githubSlug: githubSlug.trim() || undefined,
          priority,
        }),
      });
      const json = (await res.json()) as NewAppResult & { error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || 'could not create app');
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not create app');
    } finally {
      setBusy(false);
    }
  }

  // ── Success panel ───────────────────────────────────────────
  if (result) {
    return (
      <div className="max-w-md mx-auto mt-10">
        <h1 className="text-2xl font-bold text-brand-orange tracking-tight">App queued 🚀</h1>
        <p className="text-sm text-zinc-400 mt-1">{result.message}</p>
        <div className="gel-surface mt-5 p-4 rounded-xl border border-zinc-800 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-500">Repo</span>
            <span className="font-mono text-teal-300">{result.repoName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Task</span>
            <span className="font-mono text-zinc-300 text-xs">{result.taskId}</span>
          </div>
        </div>
        <p className="text-[11px] text-zinc-500 mt-3">
          The agentFlow pipeline scaffolds and builds this app on the next off-hours runner window. Track it on{' '}
          <Link href="/work" className="text-teal-400 hover:text-teal-300">Work → Up Next</Link> and review with{' '}
          <code className="text-zinc-400">ship it</code>.
        </p>
        <div className="flex gap-2 mt-5">
          <button
            onClick={() => router.push('/apps')}
            className="gel-brand flex-1 px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 transition"
          >
            View directory →
          </button>
          <button
            onClick={() => {
              setResult(null);
              setName('');
              setDescription('');
              setGithubSlug('');
              setPriority('P2');
            }}
            className="gel-surface px-3 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
          >
            New another
          </button>
        </div>
      </div>
    );
  }

  // ── Form ────────────────────────────────────────────────────
  return (
    <div className="max-w-md mx-auto mt-10">
      <h1 className="text-2xl font-bold text-brand-orange tracking-tight">New App</h1>
      <p className="text-sm text-zinc-500 mt-1">
        Describe the app. It is registered in your directory and the agentFlow pipeline scaffolds + builds it on the
        next off-hours run.
      </p>

      {error && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">App name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Invoice Tracker"
            className={inputCls}
            maxLength={80}
            required
          />
        </label>
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">What should it do?</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A small web app where freelancers create invoices, email them as PDFs, and track which are paid…"
            className={`${inputCls} min-h-[120px] resize-y`}
            maxLength={2000}
            required
          />
        </label>
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">GitHub repo (optional)</span>
          <input
            value={githubSlug}
            onChange={(e) => setGithubSlug(e.target.value)}
            placeholder="owner/repo"
            className={`${inputCls} font-mono`}
          />
        </label>
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={inputCls}>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={busy || !name.trim() || !description.trim()}
            className="gel-brand flex-1 px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {busy ? 'Queueing…' : 'Create app'}
          </button>
          <Link
            href="/apps"
            className="gel-surface px-3 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

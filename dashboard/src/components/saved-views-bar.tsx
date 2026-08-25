'use client';

// Saved-views bar for /work (task-e8aaf32e) — chips for the user's saved
// task-board views, plus "save current filters as a view". Each chip links to
// /work?view=<id> (server-resolved, shareable within the tenant); the share
// button copies that absolute URL, the × deletes (owner-only, enforced by
// /api/views/[viewId]).
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { hasAnyFilter, describeFilters, MAX_VIEW_NAME, type SavedViewSummary, type SavedViewFilters } from '@/lib/saved-views';

export function SavedViewsBar({
  views,
  current,
  activeViewId,
}: {
  views: SavedViewSummary[];
  current: SavedViewFilters;
  activeViewId?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const canSave = hasAnyFilter(current);
  if (views.length === 0 && !canSave) return null;

  async function saveView(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, filters: current }),
    });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      setError(data?.error ?? 'save failed');
      return;
    }
    setSaving(false);
    setName('');
    startTransition(() => router.refresh());
  }

  async function deleteView(viewId: string, viewName: string) {
    if (!window.confirm(`Delete saved view “${viewName}”?`)) return;
    setError(null);
    const res = await fetch(`/api/views/${encodeURIComponent(viewId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? 'delete failed');
      return;
    }
    startTransition(() => {
      // If the deleted view is the one currently applied, drop back to the bare board.
      if (viewId === activeViewId) router.push('/work');
      else router.refresh();
    });
  }

  async function copyShareUrl(viewId: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/work?view=${viewId}`);
      setCopiedId(viewId);
      setTimeout(() => setCopiedId((c) => (c === viewId ? null : c)), 1500);
    } catch {
      setError('could not copy — copy the address bar instead');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-3" role="group" aria-label="Saved views">
      <span className="text-[11px] uppercase tracking-wider text-zinc-600 mr-1">Views</span>

      {views.map((v) => {
        const isActive = v.viewId === activeViewId;
        return (
          <span
            key={v.viewId}
            className={`inline-flex items-center rounded-full text-xs border ${
              isActive
                ? 'bg-purple-500/15 border-purple-500/40 text-purple-300 font-medium'
                : 'bg-[rgb(var(--bg-surface))]/60 border-[rgb(var(--border-subtle))] text-[rgb(var(--text-secondary))] hover:border-zinc-700'
            }`}
          >
            <Link
              href={`/work?view=${v.viewId}`}
              aria-current={isActive ? 'true' : undefined}
              title={describeFilters(v.filters)}
              className="tap-press pl-3 pr-1.5 py-1.5 hover:text-[rgb(var(--text-primary))]"
            >
              {v.name}
            </Link>
            <button
              type="button"
              onClick={() => copyShareUrl(v.viewId)}
              title={copiedId === v.viewId ? 'Link copied!' : 'Copy shareable link'}
              aria-label={`Copy shareable link for ${v.name}`}
              className="px-1 py-1.5 text-zinc-500 hover:text-emerald-400"
            >
              {copiedId === v.viewId ? '✓' : '⧉'}
            </button>
            <button
              type="button"
              onClick={() => deleteView(v.viewId, v.name)}
              disabled={isPending}
              title={`Delete view ${v.name}`}
              aria-label={`Delete view ${v.name}`}
              className="pl-1 pr-2 py-1.5 text-zinc-600 hover:text-red-400 disabled:opacity-50"
            >
              ×
            </button>
          </span>
        );
      })}

      {canSave && !saving && (
        <button
          type="button"
          onClick={() => { setSaving(true); setError(null); }}
          className="tap-press inline-flex items-center px-3 py-1.5 rounded-full text-xs border border-dashed border-[rgb(var(--border-subtle))] text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] hover:border-zinc-600"
          title="Save the current filter combination as a named view"
        >
          + Save view
        </button>
      )}

      {canSave && saving && (
        <form onSubmit={saveView} className="inline-flex items-center gap-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_VIEW_NAME}
            placeholder="View name (e.g. core P1 in review)"
            aria-label="Saved view name"
            className="px-3 py-1.5 rounded-full text-xs bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] text-[rgb(var(--text-primary))] placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 w-56"
          />
          <button
            type="submit"
            disabled={!name.trim() || isPending}
            className="px-3 py-1.5 rounded-full text-xs border border-purple-500/40 bg-purple-500/15 text-purple-300 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => { setSaving(false); setName(''); setError(null); }}
            className="px-2 py-1.5 text-xs text-zinc-600 hover:text-[rgb(var(--text-primary))]"
          >
            Cancel
          </button>
        </form>
      )}

      {error && <span className="text-xs text-red-400 ml-1">{error}</span>}
    </div>
  );
}

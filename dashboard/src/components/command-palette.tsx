'use client';

// ⌘K command palette — global nav + quick actions (jump to any destination or
// tab, jump to a repo, switch tenant, dispatch a task). No deps; a filtered
// list with keyboard navigation, styled like shadcn's Command. Entry-building
// and filtering are pure functions in command-palette-logic.ts — this file
// stays a thin React/fetch shell around them (same split as nav.tsx).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTenant } from '@/lib/tenant-context';
import {
  NAV_ENTRIES,
  DISPATCH_ACTION_ENTRY,
  buildTenantEntries,
  buildRepoEntries,
  filterEntries,
  clampIndex,
  type PaletteEntry,
} from '@/lib/command-palette-logic';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [repos, setRepos] = useState<string[]>([]);
  const [mode, setMode] = useState<'list' | 'dispatch'>('list');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { current, tenants, switchTenant } = useTenant();

  const entries = useMemo<PaletteEntry[]>(
    () => [
      ...NAV_ENTRIES,
      DISPATCH_ACTION_ENTRY,
      ...buildTenantEntries(tenants, current?.tenantId),
      ...buildRepoEntries(repos),
    ],
    [tenants, current?.tenantId, repos],
  );

  const results = useMemo(() => filterEntries(entries, query), [entries, query]);

  const close = useCallback(() => {
    setOpen(false);
    setMode('list');
    setQuery('');
    setIndex(0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        if (mode === 'dispatch') setMode('list');
        else close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, mode]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, mode]);

  // Repo list is fetched lazily on first open (not on every keystroke) — the
  // palette's own quick actions need it, /projects' fan-out composer already
  // fetches it server-side for its own page.
  useEffect(() => {
    if (!open || repos.length > 0) return;
    let cancelled = false;
    fetch('/api/projects')
      .then((res) => (res.ok ? res.json() : { repos: [] }))
      .then((json) => {
        if (!cancelled && Array.isArray(json.repos)) setRepos(json.repos);
      })
      .catch(() => {
        /* repo jump/dispatch entries just stay absent — nav still works */
      });
    return () => {
      cancelled = true;
    };
  }, [open, repos.length]);

  // Keep the highlighted row in bounds whenever the filtered list changes.
  useEffect(() => {
    setIndex((i) => clampIndex(i, results.length));
  }, [results.length]);

  if (!open) return null;

  const go = (href: string) => {
    close();
    router.push(href);
  };

  const select = (entry: PaletteEntry) => {
    if (entry.kind === 'nav' || entry.kind === 'repo') {
      go(entry.href!);
    } else if (entry.kind === 'tenant' && entry.payload) {
      switchTenant(entry.payload);
      close();
    } else if (entry.actionId === 'dispatch-open') {
      setMode('dispatch');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[18vh]" role="presentation" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'dispatch' ? (
          <DispatchForm repos={repos} onCancel={() => setMode('list')} onDone={close} />
        ) : (
          <>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
                else if (e.key === 'Enter' && results[index]) { select(results[index]); }
              }}
              placeholder="Jump to… or dispatch a task"
              role="combobox"
              aria-expanded="true"
              aria-controls="cmd-palette-list"
              aria-activedescendant={results[index] ? `cmd-opt-${index}` : undefined}
              className="w-full bg-transparent px-4 py-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none border-b border-zinc-800"
            />
            <ul id="cmd-palette-list" role="listbox" className="max-h-[40vh] overflow-y-auto py-1.5">
              {results.length === 0 && <li className="px-4 py-6 text-center text-sm text-zinc-600">No matches.</li>}
              {results.map((e, i) => (
                <li key={e.id} id={`cmd-opt-${i}`} role="option" aria-selected={i === index}>
                  <button
                    tabIndex={-1}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => select(e)}
                    className={`w-full text-left px-4 py-2.5 flex items-baseline justify-between gap-3 ${
                      i === index ? 'bg-teal-500/15 text-teal-200' : 'text-zinc-300'
                    }`}
                  >
                    <span className="text-sm">{e.label}</span>
                    <span className="text-xs text-zinc-600">{e.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-4 py-2 border-t border-zinc-800 text-[10px] text-zinc-600 flex gap-3">
              <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Inline quick-dispatch form — one repo + one title, POSTed as a single-repo
 *  fan-out (the same /api/projects mutation the /projects board's composer
 *  uses), so this never diverges from the "real" dispatch path. */
function DispatchForm({ repos, onCancel, onDone }: { repos: string[]; onCancel: () => void; onDone: () => void }) {
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!repo && repos.length > 0) setRepo(repos[0]);
  }, [repos, repo]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!repo || !title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fanout', repos: [repo], title: title.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'dispatch failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-200">Dispatch a task</h2>
        <button type="button" onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
          ← back
        </button>
      </div>
      {repos.length === 0 ? (
        <p className="text-xs text-zinc-500">No repos registered yet — connect one from the App Directory first.</p>
      ) : (
        <label className="block text-xs text-zinc-500">
          Repo
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200 focus:border-teal-600 outline-none"
          >
            {repos.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
      )}
      <label className="block text-xs text-zinc-500">
        Task
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What should the agent do?"
          className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-teal-600 outline-none"
        />
      </label>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !repo || !title.trim()}
          className="px-3 py-1.5 rounded bg-teal-600/80 text-xs text-teal-50 hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Dispatching…' : 'Dispatch'}
        </button>
      </div>
    </form>
  );
}

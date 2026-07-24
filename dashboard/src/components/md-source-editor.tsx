'use client';

import { useState } from 'react';
import { diffLines, diffStats } from '@/lib/diff';

type Kind = 'agent' | 'skill';

interface FileResponse {
  filePath: string;
  content: string;
}

interface SaveResponse {
  ok: boolean;
  committed: boolean;
  commitSha?: string;
  gitError?: string;
  error?: string;
}

/**
 * In-UI source editor for a single agent/skill .md file — diff preview
 * before save, then a git commit on save (MYAI_DASHBOARD.md §3.2). Lives
 * inside the agent/skill detail panel, collapsed to a button until opened.
 */
export function MdSourceEditor({ kind, name, onSaved }: { kind: Kind; name: string; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveInfo, setSaveInfo] = useState<SaveResponse | null>(null);

  const apiBase = kind === 'agent' ? '/api/agents' : '/api/skills';

  async function openEditor() {
    setOpen(true);
    setError(null);
    setSaveInfo(null);
    if (original !== null) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/${name}/file`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to load source (${res.status})`);
      }
      const data: FileResponse = await res.json();
      setOriginal(data.content);
      setDraft(data.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load source');
    } finally {
      setLoading(false);
    }
  }

  function closeEditor() {
    setOpen(false);
    setShowDiff(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaveInfo(null);
    try {
      const res = await fetch(`${apiBase}/${name}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft, commitMessage: commitMessage || undefined }),
      });
      const data: SaveResponse = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `Save failed (${res.status})`);
      setSaveInfo(data);
      setOriginal(draft);
      setShowDiff(false);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const dirty = original !== null && draft !== original;
  const lines = original !== null ? diffLines(original, draft) : [];
  const stats = diffStats(lines);

  return (
    <div>
      <p className="text-xs text-zinc-500 uppercase mb-1">Source file</p>
      {!open ? (
        <button
          onClick={openEditor}
          disabled={loading}
          className="tap-press text-xs px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Edit source'}
        </button>
      ) : (
        <div className="space-y-3">
          {error && <p className="text-xs text-red-400">{error}</p>}

          {loading ? (
            <p className="text-xs text-zinc-500">Loading…</p>
          ) : (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="w-full h-64 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded-md p-3 text-zinc-300 focus:outline-none focus:border-teal-500/50"
              />

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setShowDiff((v) => !v)}
                  disabled={!dirty}
                  className="tap-press text-xs px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                >
                  {showDiff ? 'Hide diff' : 'Preview diff'}
                </button>
                {dirty && (
                  <span className="text-[10px] text-zinc-500">
                    <span className="text-emerald-400">+{stats.additions}</span>{' '}
                    <span className="text-red-400">-{stats.deletions}</span>
                  </span>
                )}
              </div>

              {showDiff && (
                <pre className="text-xs font-mono bg-zinc-950 border border-zinc-800 rounded-md p-3 overflow-x-auto max-h-64 whitespace-pre-wrap">
                  {lines.map((l, i) => (
                    <div
                      key={i}
                      className={
                        l.type === 'add'
                          ? 'bg-emerald-500/10 text-emerald-300'
                          : l.type === 'remove'
                            ? 'bg-red-500/10 text-red-300'
                            : 'text-zinc-500'
                      }
                    >
                      {l.type === 'add' ? '+ ' : l.type === 'remove' ? '- ' : '  '}
                      {l.text}
                    </div>
                  ))}
                </pre>
              )}

              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder={`chore(${kind}): edit ${name} via dashboard editor`}
                className="w-full text-xs bg-zinc-950 border border-zinc-800 rounded-md px-3 py-1.5 text-zinc-300 focus:outline-none focus:border-teal-500/50"
              />

              {saveInfo && (
                <p className="text-xs text-emerald-400">
                  {saveInfo.committed
                    ? `Saved and committed (${saveInfo.commitSha?.slice(0, 7)}).`
                    : `Saved to disk — not committed${saveInfo.gitError ? `: ${saveInfo.gitError}` : ''}.`}
                </p>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={save}
                  disabled={!dirty || saving}
                  className="tap-press text-xs px-3 py-1.5 rounded-md bg-teal-500/20 text-teal-300 hover:bg-teal-500/30 disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Save & commit'}
                </button>
                <button
                  onClick={closeEditor}
                  className="tap-press text-xs px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

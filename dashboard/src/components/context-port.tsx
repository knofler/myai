'use client';

// CONTEXT-PORT 3 — the download / upload controls for the /context page.
// Client-side because the download triggers a file save and the upload posts a
// FormData file to /api/context/import and shows the result inline.

import { useRef, useState } from 'react';

export function DownloadContextButton() {
  return (
    <a
      href="/api/context/export"
      download
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-teal-500/15 border border-teal-500/30 text-teal-200 hover:bg-teal-500/25 transition-colors active:scale-95"
      data-testid="context-download"
    >
      <span aria-hidden>↓</span> Download my context
    </a>
  );
}

type ImportState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; message: string }
  | { status: 'error'; message: string };

export function UploadContextForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ImportState>({ status: 'idle' });
  const [fileName, setFileName] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setState({ status: 'error', message: 'Choose a bundle file first.' });
      return;
    }
    setState({ status: 'uploading' });
    try {
      const form = new FormData();
      form.append('bundle', file);
      const res = await fetch('/api/context/import', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ status: 'error', message: body.error ?? `import failed (${res.status})` });
        return;
      }
      const imported = body.gateway?.imported ?? body.gateway?.upserted ?? body.validated ?? 0;
      setState({
        status: 'done',
        message: body.message ?? `Imported ${imported} vector${imported === 1 ? '' : 's'} into your corpus.`,
      });
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'upload failed' });
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" data-testid="context-upload-form">
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-zinc-800/70 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 cursor-pointer transition-colors">
          <span aria-hidden>↑</span> Choose bundle…
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
            data-testid="context-upload-input"
          />
        </label>
        {fileName && <span className="text-xs text-zinc-400 font-mono truncate max-w-[16rem]">{fileName}</span>}
        <button
          type="submit"
          disabled={state.status === 'uploading'}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-500/15 border border-purple-500/30 text-purple-200 hover:bg-purple-500/25 disabled:opacity-50 transition-colors active:scale-95"
        >
          {state.status === 'uploading' ? 'Importing…' : 'Import into my context'}
        </button>
      </div>
      {state.status === 'done' && (
        <p className="text-xs text-emerald-400" role="status">
          ✓ {state.message}
        </p>
      )}
      {state.status === 'error' && (
        <p className="text-xs text-red-400" role="alert">
          ✗ {state.message}
        </p>
      )}
    </form>
  );
}

'use client';

import { useState } from 'react';
import { DetailPanel } from '@/components/detail-panel';

interface ArtifactMeta {
  artifactId: string;
  kind: 'diff' | 'build-log' | 'test-report' | 'other';
  filename: string;
  contentType: string;
  sizeBytes: number;
  truncated: boolean;
  createdAt: string;
}

const KIND_LABEL: Record<ArtifactMeta['kind'], string> = {
  diff: 'Diff',
  'build-log': 'Build/test output',
  'test-report': 'Test report',
  other: 'Other',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Downloadable-artifacts affordance for a completed runner task — click opens
 *  a drawer listing whatever the runner captured (diff / build-test output /
 *  reports) with a direct download link per file, so review doesn't require
 *  re-running the task. */
export function TaskArtifactsButton({ taskId, title }: { taskId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactMeta[] | null>(null);

  async function openDrawer() {
    setOpen(true);
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/artifacts`);
      const data = await res.json();
      setArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []);
    } catch {
      setArtifacts([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={openDrawer}
        className="tap-press text-xs text-zinc-400 hover:text-emerald-400 underline decoration-zinc-700"
      >
        Artifacts
      </button>
      <DetailPanel open={open} onClose={() => setOpen(false)} title={title}>
        {loading && <p className="text-sm text-zinc-500">Loading artifacts…</p>}
        {!loading && artifacts?.length === 0 && (
          <p className="text-sm text-zinc-500">No artifacts captured for this task.</p>
        )}
        {!loading && artifacts && artifacts.length > 0 && (
          <ul className="space-y-2">
            {artifacts.map(a => (
              <li key={a.artifactId} className="flex items-center justify-between gap-3 bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate">{a.filename}</p>
                  <p className="text-xs text-zinc-500">
                    {KIND_LABEL[a.kind]} · {fmtBytes(a.sizeBytes)}{a.truncated ? ' · truncated' : ''}
                  </p>
                </div>
                <a
                  href={`/api/tasks/${taskId}/artifacts/${a.artifactId}`}
                  className="shrink-0 text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
                >
                  Download
                </a>
              </li>
            ))}
          </ul>
        )}
      </DetailPanel>
    </>
  );
}

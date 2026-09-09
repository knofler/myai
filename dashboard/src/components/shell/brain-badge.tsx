'use client';

// myAI brain badge — the shell's top-bar echo of the CLI statusline badge
// (DASHBOARD_REDESIGN_2026-09 §Shell): short brain SHA + composite health
// score, colour-graded. Fetches /api/brain/badge once on mount; if the gateway
// is unreachable every field comes back null and it renders a muted "brain —"
// rather than disappearing. Score colour maps to the semantic tokens
// (ok/warn/err) at the standard brain-health thresholds.

import { useEffect, useState } from 'react';
import { Tooltip } from '@/components/ui/tooltip';

interface BrainBadgeData {
  sha: string | null;
  branch: string | null;
  score: number | null;
  grade: string | null;
}

function scoreToken(score: number): string {
  if (score >= 80) return 'rgb(var(--ok))';
  if (score >= 50) return 'rgb(var(--warn))';
  return 'rgb(var(--err))';
}

export function BrainBadge() {
  const [data, setData] = useState<BrainBadgeData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/brain/badge', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: BrainBadgeData | null) => {
        if (!cancelled && json) setData(json);
      })
      .catch(() => {
        /* leave placeholder — the badge is informational, never load-bearing */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sha = data?.sha ? data.sha.slice(0, 7) : null;
  const score = data?.score ?? null;
  const grade = data?.grade ?? null;

  const label = (
    <span className="inline-flex items-center gap-2 rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-raised))] px-2.5 py-1 font-mono text-xs">
      <span aria-hidden="true" className="text-[rgb(var(--accent))]">
        ❋
      </span>
      <span className="text-[rgb(var(--text-secondary))]">{sha ?? '—'}</span>
      {score !== null && (
        <span style={{ color: scoreToken(score) }} className="font-semibold">
          {score}
        </span>
      )}
    </span>
  );

  const tip =
    sha === null
      ? 'myAI brain — gateway unreachable'
      : `brain ${data?.branch ?? 'main'} @ ${sha}${
          score !== null ? ` · health ${score}/100${grade ? ` (${grade})` : ''}` : ''
        }`;

  return (
    <Tooltip content={tip} side="bottom">
      <span aria-label={tip}>{label}</span>
    </Tooltip>
  );
}

// Presentational diff for the marketplace review-queue detail page
// (ADR-028 §4 / implementation checklist item #4): "a reviewer must see the
// diff regardless of what semver bump label the creator chose" — this
// component is that surfaced flag, not buried changelog prose. Added tools
// are the widening the reviewer must scrutinize; removed tools are always a
// safe narrowing (ADR-028 §4) and rendered with lower visual weight.
import { Badge } from '@/components/ui/badge';
import type { DeclaredToolsDiff } from '@/lib/marketplace';

export function DeclaredToolsDiffView({
  declaredTools,
  diff,
  isResubmission,
}: {
  declaredTools: string[];
  diff: DeclaredToolsDiff;
  isResubmission: boolean;
}) {
  if (!isResubmission) {
    return (
      <div>
        <div className="text-xs text-zinc-500 mb-1.5">Declared tools (first submission — nothing to diff against)</div>
        <div className="flex flex-wrap gap-1.5">
          {declaredTools.map((t) => (
            <Badge key={t} className="bg-zinc-700/40 text-zinc-300 border-zinc-600/50">{t}</Badge>
          ))}
        </div>
      </div>
    );
  }

  const unchanged = declaredTools.filter((t) => !diff.added.includes(t));

  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1.5">Declared tools vs. prior approved version</div>
      <div className="flex flex-wrap gap-1.5">
        {unchanged.map((t) => (
          <Badge key={t} className="bg-zinc-700/40 text-zinc-300 border-zinc-600/50">{t}</Badge>
        ))}
        {diff.added.map((t) => (
          <span key={t} data-testid="declared-tool-added" title={`newly declared — not in the prior approved version`}>
            <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/40">+ {t} (new)</Badge>
          </span>
        ))}
        {diff.removed.map((t) => (
          <span key={t} data-testid="declared-tool-removed" title="removed — safe narrowing, no widening review needed">
            <Badge className="bg-zinc-800/60 text-zinc-600 border-zinc-700/50 line-through">− {t}</Badge>
          </span>
        ))}
      </div>
      {diff.added.length > 0 && (
        <p className="mt-2 text-xs text-amber-400" data-testid="widening-warning">
          This version widens the declared tool surface — {diff.added.length === 1
            ? `it adds ${diff.added[0]}`
            : `it adds ${diff.added.join(', ')}`}. Review the minimum-necessary criterion (ADR-027 §2) before approving,
          regardless of the semver bump the creator chose.
        </p>
      )}
    </div>
  );
}

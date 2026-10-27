// Shared status chips for FleetRun-shaped data — extracted from /fleet so
// /projects' "Recent batches" card (ADR-015 §3, type:'task-fanout' runs) can
// render the same visual language as the morning-resume-all console instead
// of inventing a second one.
import { Badge } from '@/components/ui/badge';

const RECOMMENDATION: Record<string, string> = {
  ship: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  merge: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  review: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  fix: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  'wrap-up': 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  attention: 'bg-red-500/15 text-red-400 border-red-500/30',
  idle: 'bg-zinc-600/20 text-[rgb(var(--text-secondary))] border-zinc-600/30',
};

export function RecommendationChip({ value }: { value?: string }) {
  if (!value) return <Badge className={RECOMMENDATION.idle}>idle</Badge>;
  return <Badge className={RECOMMENDATION[value] ?? RECOMMENDATION.idle}>{value}</Badge>;
}

export function ActionStatus({ status }: { status?: string }) {
  const s = (status ?? 'pending').toLowerCase();
  if (s === 'in-progress') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-blue-300">
        <span className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-pulse" />
        in progress
      </span>
    );
  }
  if (s === 'done') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 flex items-center justify-center text-label text-zinc-950 font-bold leading-none">✓</span>
        done
      </span>
    );
  }
  if (s === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400 flex items-center justify-center text-label text-zinc-950 font-bold leading-none">✕</span>
        failed
      </span>
    );
  }
  if (s === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-zinc-600">
        <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
        skipped
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[rgb(var(--text-muted))]">
      <span className="w-2.5 h-2.5 rounded-full bg-zinc-600" />
      pending
    </span>
  );
}

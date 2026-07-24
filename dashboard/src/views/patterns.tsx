import { getPatternsCached } from '@/lib/registry-cache';

export default async function PatternsPage() {
  const patterns = await getPatternsCached();

  return (
    <div>

      <div className="space-y-3">
        {patterns.map(p => {
          const confidence = p.confidence;
          const pct = Math.round(confidence * 100);

          return (
            <div key={p._id} className="gel-surface tap-press bg-zinc-900 border border-zinc-800 rounded-lg p-5 hover:border-zinc-700">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <h3 className="font-medium text-zinc-200">{p.title}</h3>
                  <p className="text-xs text-zinc-500 mt-0.5">{p.description}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`text-lg font-bold ${pct >= 80 ? 'text-emerald-400' : pct >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                    {pct}%
                  </p>
                  <p className="text-[10px] text-zinc-600 uppercase">confidence</p>
                </div>
              </div>

              <div className="w-full h-1.5 bg-zinc-800 rounded-full mb-3">
                <div
                  className={`h-full rounded-full transition-all ${pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>

              <div className="flex flex-wrap gap-1.5 mb-3">
                {p.tags.map(t => (
                  <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400">{t}</span>
                ))}
              </div>

              <div className="flex gap-4 text-xs text-zinc-600">
                <span>Used: {p.usageCount}x</span>
                <span>Success: {p.successCount}</span>
                <span>Failed: {p.failureCount}</span>
                <span>Category: {p.category}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

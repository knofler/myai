import { connectDB, Pattern } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface PatternDoc {
  _id: unknown;
  patternId: string;
  title: string;
  description: string;
  tags: string[];
  category: string;
  confidence: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  lastUsed: Date;
  createdAt: Date;
}

export default async function SonaPage() {
  await connectDB();
  const patterns = await Pattern.find({}).select('-__v').sort({ confidence: -1 }).lean() as unknown as PatternDoc[];

  // Analytics
  const totalPatterns = patterns.length;
  const avgConfidence = totalPatterns > 0
    ? Math.round((patterns.reduce((s, p) => s + (p.confidence || 0), 0) / totalPatterns) * 100)
    : 0;
  const totalUsage = patterns.reduce((s, p) => s + (p.usageCount || 0), 0);
  const highConfidence = patterns.filter(p => (p.confidence || 0) >= 0.8).length;

  // Category distribution
  const categories: Record<string, number> = {};
  for (const p of patterns) {
    const cat = p.category || 'unknown';
    categories[cat] = (categories[cat] || 0) + 1;
  }

  // Tag cloud
  const tagCounts: Record<string, number> = {};
  for (const p of patterns) {
    for (const t of (p.tags || [])) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const maxTagCount = topTags.length > 0 ? topTags[0][1] : 1;

  // Most/least used
  const sorted = [...patterns].sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
  const mostUsed = sorted.slice(0, 3);
  const leastUsed = sorted.slice(-3).reverse();

  return (
    <div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <p className="text-xs text-zinc-500 uppercase">Patterns</p>
          <p className="text-3xl font-bold text-emerald-400 mt-1">{totalPatterns}</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <p className="text-xs text-zinc-500 uppercase">Avg Confidence</p>
          <p className="text-3xl font-bold text-zinc-100 mt-1">{avgConfidence}%</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <p className="text-xs text-zinc-500 uppercase">Total Usage</p>
          <p className="text-3xl font-bold text-zinc-100 mt-1">{totalUsage}x</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <p className="text-xs text-zinc-500 uppercase">High Confidence</p>
          <p className="text-3xl font-bold text-emerald-400 mt-1">{highConfidence}</p>
          <p className="text-[10px] text-zinc-600 mt-0.5">&ge; 80%</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Category Distribution */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Category Distribution</h3>
          <div className="space-y-2">
            {Object.entries(categories).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
              <div key={cat} className="flex items-center gap-3">
                <span className="text-xs text-zinc-400 w-24 shrink-0">{cat}</span>
                <div className="flex-1 h-4 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500/50 rounded-full"
                    style={{ width: `${(count / totalPatterns) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-zinc-500 w-6 text-right">{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Tag Cloud */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Tag Cloud</h3>
          <div className="flex flex-wrap gap-2">
            {topTags.map(([tag, count]) => {
              const size = 0.6 + (count / maxTagCount) * 0.6;
              const opacity = 0.4 + (count / maxTagCount) * 0.6;
              return (
                <span
                  key={tag}
                  className="font-mono px-2 py-0.5 bg-zinc-800 rounded text-emerald-400 transition-colors hover:bg-zinc-700"
                  style={{ fontSize: `${size}rem`, opacity }}
                >
                  {tag}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Most Used */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Most Used</h3>
          <div className="space-y-3">
            {mostUsed.map(p => (
              <div key={p.patternId} className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate">{p.title}</p>
                  <p className="text-[10px] text-zinc-500">{Math.round((p.confidence || 0) * 100)}% confidence</p>
                </div>
                <span className="text-sm font-bold text-emerald-400 shrink-0 ml-3">{p.usageCount}x</span>
              </div>
            ))}
          </div>
        </div>

        {/* Least Used */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Least Used</h3>
          <div className="space-y-3">
            {leastUsed.map(p => (
              <div key={p.patternId} className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate">{p.title}</p>
                  <p className="text-[10px] text-zinc-500">{Math.round((p.confidence || 0) * 100)}% confidence</p>
                </div>
                <span className="text-sm font-bold text-zinc-500 shrink-0 ml-3">{p.usageCount}x</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Confidence Ranking */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">All Patterns by Confidence</h3>
        <div className="space-y-2">
          {patterns.map(p => {
            const pct = Math.round((p.confidence || 0) * 100);
            return (
              <div key={p.patternId} className="flex items-center gap-3">
                <span className="text-xs text-zinc-400 w-48 shrink-0 truncate">{p.title}</span>
                <div className="flex-1 h-3 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className={`text-xs font-mono w-10 text-right ${pct >= 80 ? 'text-emerald-400' : pct >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {pct}%
                </span>
                <span className="text-[10px] text-zinc-600 w-8 text-right">{p.usageCount}x</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

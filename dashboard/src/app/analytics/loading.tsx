export default function AnalyticsLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-32 bg-zinc-800 rounded" />
        <div className="h-4 w-64 bg-zinc-800/60 rounded mt-2" />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
            <div className="h-3 w-20 bg-zinc-800/60 rounded" />
            <div className="h-7 w-16 bg-zinc-800 rounded mt-2" />
          </div>
        ))}
      </div>

      {/* Charts skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[1, 2].map((i) => (
          <div key={i} className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 h-64" />
        ))}
      </div>
    </div>
  );
}

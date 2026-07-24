export default function MemoryLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-28 bg-zinc-800 rounded" />
        <div className="h-4 w-64 bg-zinc-800/60 rounded mt-2" />
      </div>

      {/* Search bar */}
      <div className="h-10 w-full max-w-lg bg-zinc-800/50 rounded-lg mb-6" />

      {/* Memory cards */}
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-3">
              <div className="h-4 w-48 bg-zinc-800 rounded" />
              <div className="h-5 w-14 bg-zinc-800 rounded-full" />
            </div>
            <div className="h-3 w-full bg-zinc-800/60 rounded" />
            <div className="h-3 w-3/4 bg-zinc-800/60 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

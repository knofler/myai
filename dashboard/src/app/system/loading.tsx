export default function SystemLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-28 bg-zinc-800 rounded" />
        <div className="h-4 w-72 bg-zinc-800/60 rounded mt-2" />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-zinc-800 mb-6">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-9 w-24 bg-zinc-800/50 rounded-t-lg" />
        ))}
      </div>

      {/* Content area */}
      <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800/80">
          <div className="h-4 w-36 bg-zinc-800 rounded" />
        </div>
        <div className="p-4 space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="h-4 w-32 bg-zinc-800 rounded" />
              <div className="h-4 w-48 bg-zinc-800/60 rounded" />
              <div className="h-4 w-24 bg-zinc-800/60 rounded ml-auto" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

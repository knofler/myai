export default function RootLoading() {
  return (
    <div className="max-w-7xl mx-auto space-y-5 animate-pulse">
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div>
          <div className="h-7 w-48 bg-zinc-800 rounded" />
          <div className="h-4 w-72 bg-zinc-800/60 rounded mt-2" />
        </div>
        <div className="flex gap-2">
          <div className="h-7 w-20 bg-zinc-800 rounded-md" />
          <div className="h-7 w-20 bg-zinc-800 rounded-md" />
        </div>
      </div>

      {/* Three-column card skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-zinc-900/70 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800/80 flex justify-between">
              <div className="h-4 w-28 bg-zinc-800 rounded" />
              <div className="h-4 w-16 bg-zinc-800/60 rounded" />
            </div>
            <div className="p-4 space-y-3">
              {[1, 2, 3].map((j) => (
                <div key={j} className="flex justify-between items-center">
                  <div className="space-y-1.5">
                    <div className="h-4 w-44 bg-zinc-800 rounded" />
                    <div className="h-3 w-32 bg-zinc-800/60 rounded" />
                  </div>
                  <div className="h-5 w-16 bg-zinc-800 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

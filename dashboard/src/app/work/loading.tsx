export default function WorkLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      {/* Page header */}
      <div className="flex items-start justify-between gap-3 mb-6">
        <div>
          <div className="h-7 w-24 bg-zinc-800 rounded" />
          <div className="h-4 w-80 bg-zinc-800/60 rounded mt-2" />
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-zinc-800 mb-6">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-9 w-28 bg-zinc-800/50 rounded-t-lg" />
        ))}
      </div>

      {/* Data table skeleton */}
      <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800/80 flex justify-between">
          <div className="h-4 w-40 bg-zinc-800 rounded" />
          <div className="h-8 w-64 bg-zinc-800/50 rounded-lg" />
        </div>
        <div className="divide-y divide-zinc-800/50">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="px-4 py-3 flex items-center gap-6">
              <div className="h-5 w-10 bg-zinc-800 rounded-full" />
              <div className="h-4 w-48 bg-zinc-800 rounded" />
              <div className="h-3 w-28 bg-zinc-800/60 rounded" />
              <div className="h-3 w-20 bg-zinc-800/60 rounded" />
              <div className="h-5 w-24 bg-zinc-800 rounded-full" />
              <div className="h-3 w-16 bg-zinc-800/60 rounded ml-auto" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

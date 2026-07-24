export default function RegistryLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-32 bg-zinc-800 rounded" />
        <div className="h-4 w-64 bg-zinc-800/60 rounded mt-2" />
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
            <div className="h-3 w-16 bg-zinc-800/60 rounded" />
            <div className="h-7 w-10 bg-zinc-800 rounded mt-2" />
          </div>
        ))}
      </div>

      {/* Tab bar + table */}
      <div className="flex gap-1 border-b border-zinc-800 mb-6">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-9 w-20 bg-zinc-800/50 rounded-t-lg" />
        ))}
      </div>

      <div className="space-y-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 flex items-center gap-4">
            <div className="h-4 w-40 bg-zinc-800 rounded" />
            <div className="h-3 w-64 bg-zinc-800/60 rounded" />
            <div className="h-5 w-16 bg-zinc-800 rounded-full ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

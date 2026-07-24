export default function AppsLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-20 bg-zinc-800 rounded" />
        <div className="h-4 w-56 bg-zinc-800/60 rounded mt-2" />
      </div>

      {/* Grid of app cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-3 w-3 bg-zinc-800 rounded-full" />
              <div className="h-4 w-32 bg-zinc-800 rounded" />
            </div>
            <div className="h-3 w-full bg-zinc-800/60 rounded" />
            <div className="h-3 w-2/3 bg-zinc-800/60 rounded" />
            <div className="flex gap-2 pt-2">
              <div className="h-5 w-14 bg-zinc-800 rounded-full" />
              <div className="h-5 w-14 bg-zinc-800 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

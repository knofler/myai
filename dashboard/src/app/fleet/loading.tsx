export default function FleetLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-36 bg-zinc-800 rounded" />
        <div className="h-4 w-56 bg-zinc-800/60 rounded mt-2" />
      </div>

      {/* Fleet run card */}
      <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800/80">
          <div className="h-4 w-48 bg-zinc-800 rounded" />
        </div>
        <div className="p-4 space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 bg-zinc-800 rounded-full" />
                <div className="h-4 w-36 bg-zinc-800 rounded" />
              </div>
              <div className="h-5 w-16 bg-zinc-800 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

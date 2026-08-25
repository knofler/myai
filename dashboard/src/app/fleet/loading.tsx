export default function FleetLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-36 bg-[rgb(var(--bg-hover))] rounded" />
        <div className="h-4 w-56 bg-[rgb(var(--bg-hover))]/60 rounded mt-2" />
      </div>

      {/* Fleet run card */}
      <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[rgb(var(--border-subtle))]/80">
          <div className="h-4 w-48 bg-[rgb(var(--bg-hover))] rounded" />
        </div>
        <div className="p-4 space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 bg-[rgb(var(--bg-hover))] rounded-full" />
                <div className="h-4 w-36 bg-[rgb(var(--bg-hover))] rounded" />
              </div>
              <div className="h-5 w-16 bg-[rgb(var(--bg-hover))] rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

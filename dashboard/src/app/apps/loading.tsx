export default function AppsLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-20 bg-[rgb(var(--bg-hover))] rounded" />
        <div className="h-4 w-56 bg-[rgb(var(--bg-hover))]/60 rounded mt-2" />
      </div>

      {/* Grid of app cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-3 w-3 bg-[rgb(var(--bg-hover))] rounded-full" />
              <div className="h-4 w-32 bg-[rgb(var(--bg-hover))] rounded" />
            </div>
            <div className="h-3 w-full bg-[rgb(var(--bg-hover))]/60 rounded" />
            <div className="h-3 w-2/3 bg-[rgb(var(--bg-hover))]/60 rounded" />
            <div className="flex gap-2 pt-2">
              <div className="h-5 w-14 bg-[rgb(var(--bg-hover))] rounded-full" />
              <div className="h-5 w-14 bg-[rgb(var(--bg-hover))] rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

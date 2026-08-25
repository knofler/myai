export default function ActivationFunnelLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-44 bg-[rgb(var(--bg-hover))] rounded" />
        <div className="h-4 w-72 bg-[rgb(var(--bg-hover))]/60 rounded mt-2" />
      </div>

      {/* Filter pills */}
      <div className="flex gap-2 mb-6">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-7 w-24 bg-[rgb(var(--bg-hover))]/60 rounded-lg" />
        ))}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl p-4">
            <div className="h-3 w-20 bg-[rgb(var(--bg-hover))]/60 rounded" />
            <div className="h-7 w-16 bg-[rgb(var(--bg-hover))] rounded mt-2" />
          </div>
        ))}
      </div>

      {/* Funnel + cohort table skeleton */}
      <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl p-4 h-72 mb-8" />
      <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl p-4 h-56" />
    </div>
  );
}

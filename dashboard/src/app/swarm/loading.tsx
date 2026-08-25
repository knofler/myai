export default function SwarmLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-32 bg-[rgb(var(--bg-hover))] rounded" />
        <div className="h-4 w-72 bg-[rgb(var(--bg-hover))]/60 rounded mt-2" />
      </div>

      {/* task card */}
      <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl h-28 mb-6" />

      {/* topology picker */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl h-40" />
        ))}
      </div>

      {/* lanes */}
      <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl h-64" />
    </div>
  );
}

export default function ProjectsLoading() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-40 bg-[rgb(var(--bg-hover))] rounded" />
        <div className="h-4 w-72 bg-[rgb(var(--bg-hover))]/60 rounded mt-2" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-20 bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[1, 2].map((i) => <div key={i} className="h-56 bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl" />)}
      </div>
    </div>
  );
}

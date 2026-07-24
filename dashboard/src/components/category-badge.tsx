const COLORS: Record<string, string> = {
  analysis: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  content: 'bg-pink-500/10 text-pink-400 border-pink-500/20',
  core: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  data: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  dev: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  devops: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  frontend: 'bg-green-500/10 text-green-400 border-green-500/20',
  github: 'bg-gray-500/10 text-gray-300 border-gray-500/20',
  neural: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  ops: 'bg-red-500/10 text-red-400 border-red-500/20',
  security: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  swarm: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  governance: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  routing: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  coordination: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  learning: 'bg-lime-500/10 text-lime-400 border-lime-500/20',
};

export function CategoryBadge({ category }: { category: string }) {
  const color = COLORS[category] || COLORS.core;
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded border ${color}`}>
      {category}
    </span>
  );
}

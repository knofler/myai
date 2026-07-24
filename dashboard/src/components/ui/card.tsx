// Layered card primitives — the section container used by every page.

export function Card({
  title,
  meta,
  accent,
  children,
  className = '',
}: {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  accent?: 'purple' | 'blue' | 'emerald' | 'red' | 'amber';
  children: React.ReactNode;
  className?: string;
}) {
  const accentBorder: Record<string, string> = {
    purple: 'border-purple-500/30',
    blue: 'border-blue-500/30',
    emerald: 'border-emerald-500/30',
    red: 'border-red-500/30',
    amber: 'border-amber-500/30',
  };
  const accentTitle: Record<string, string> = {
    purple: 'text-purple-300',
    blue: 'text-blue-300',
    emerald: 'text-emerald-300',
    red: 'text-red-300',
    amber: 'text-amber-300',
  };
  return (
    <section className={`gel-surface bg-zinc-900/70 border ${accent ? accentBorder[accent] : 'border-zinc-800'} rounded-xl overflow-hidden ${className}`}>
      {(title || meta) && (
        <div className="px-4 py-3 border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-2">
          <h2 className={`text-sm font-semibold ${accent ? accentTitle[accent] : 'text-zinc-200'}`}>{title}</h2>
          {meta && <span className="text-xs text-zinc-500">{meta}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

const STAT_ACCENTS: Record<string, string> = {
  green: 'text-emerald-400',
  red: 'text-red-400',
  blue: 'text-blue-400',
  yellow: 'text-yellow-400',
  purple: 'text-purple-300',
  gray: 'text-zinc-100',
};

export function StatCard({
  label,
  value,
  sub,
  accent = 'gray',
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: keyof typeof STAT_ACCENTS;
}) {
  return (
    <div className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
      <p className="text-[11px] text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${STAT_ACCENTS[accent]}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-1">{sub}</p>}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="p-8 text-center text-sm text-zinc-600">{children}</div>;
}

/* ── Consistent table cell styles (server tables) ──────────── */

export function THead({ cols }: { cols: { label: string; align?: 'left' | 'right' | 'center'; className?: string }[] }) {
  return (
    <thead>
      <tr className="text-left text-[11px] text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
        {cols.map((c) => (
          <th key={c.label} className={`px-4 py-2.5 font-medium ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''} ${c.className ?? ''}`}>
            {c.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

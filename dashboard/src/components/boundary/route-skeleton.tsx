// Shared per-route loading skeleton. Pick the `variant` closest to the page's
// real layout (checked against the live page in the browser) so the loading
// frame doesn't jump/reflow once data arrives.
type Variant = 'list' | 'table' | 'grid' | 'stats' | 'form' | 'doc' | 'hero' | 'tabs' | 'detail';

function ListBody() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-3">
            <div className="h-4 w-48 bg-[rgb(var(--bg-hover))] rounded" />
            <div className="h-5 w-14 bg-[rgb(var(--bg-hover))] rounded-full" />
          </div>
          <div className="h-3 w-full bg-[rgb(var(--bg-hover))]/60 rounded" />
          <div className="h-3 w-3/4 bg-[rgb(var(--bg-hover))]/60 rounded" />
        </div>
      ))}
    </div>
  );
}

function TableBody() {
  return (
    <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[rgb(var(--border-subtle))]/80 flex justify-between">
        <div className="h-4 w-40 bg-[rgb(var(--bg-hover))] rounded" />
        <div className="h-8 w-56 bg-[rgb(var(--bg-hover))]/50 rounded-lg" />
      </div>
      <div className="divide-y divide-[rgb(var(--border-subtle))]/50">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="px-4 py-3 flex items-center gap-6">
            <div className="h-4 w-40 bg-[rgb(var(--bg-hover))] rounded" />
            <div className="h-3 w-28 bg-[rgb(var(--bg-hover))]/60 rounded" />
            <div className="h-3 w-20 bg-[rgb(var(--bg-hover))]/60 rounded" />
            <div className="h-5 w-24 bg-[rgb(var(--bg-hover))] rounded-full" />
            <div className="h-3 w-16 bg-[rgb(var(--bg-hover))]/60 rounded ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

function GridBody() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl p-4 h-36 space-y-2">
          <div className="h-4 w-24 bg-[rgb(var(--bg-hover))] rounded" />
          <div className="h-3 w-full bg-[rgb(var(--bg-hover))]/60 rounded" />
          <div className="h-3 w-2/3 bg-[rgb(var(--bg-hover))]/60 rounded" />
        </div>
      ))}
    </div>
  );
}

function StatsBody() {
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl p-4">
            <div className="h-3 w-20 bg-[rgb(var(--bg-hover))]/60 rounded" />
            <div className="h-7 w-16 bg-[rgb(var(--bg-hover))] rounded mt-2" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[1, 2].map((i) => (
          <div key={i} className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl p-4 h-64" />
        ))}
      </div>
    </>
  );
}

function FormBody() {
  return (
    <div className="max-w-xl bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl p-5 space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-3 w-24 bg-[rgb(var(--bg-hover))]/60 rounded" />
          <div className="h-10 w-full bg-[rgb(var(--bg-hover))] rounded-lg" />
        </div>
      ))}
      <div className="h-10 w-32 bg-[rgb(var(--bg-hover))] rounded-lg" />
    </div>
  );
}

function DocBody() {
  return (
    <div className="max-w-3xl space-y-2">
      {[100, 95, 88, 92, 60, 0, 90, 96, 70, 40].map((w, i) =>
        w === 0 ? (
          <div key={i} className="h-4" />
        ) : (
          <div key={i} className="h-3 bg-[rgb(var(--bg-hover))]/60 rounded" style={{ width: `${w}%` }} />
        ),
      )}
    </div>
  );
}

function HeroBody() {
  return (
    <>
      <div className="h-48 bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl mb-8" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl h-32" />
        ))}
      </div>
    </>
  );
}

function TabsBody() {
  return (
    <>
      <div className="flex gap-1 border-b border-[rgb(var(--border-subtle))] mb-6">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-9 w-24 bg-[rgb(var(--bg-hover))]/50 rounded-t-lg" />
        ))}
      </div>
      <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl h-64" />
    </>
  );
}

function DetailBody() {
  return (
    <div className="space-y-4">
      <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl h-40" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl h-28" />
        <div className="bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl h-28" />
      </div>
    </div>
  );
}

const BODIES: Record<Variant, () => React.JSX.Element> = {
  list: ListBody,
  table: TableBody,
  grid: GridBody,
  stats: StatsBody,
  form: FormBody,
  doc: DocBody,
  hero: HeroBody,
  tabs: TabsBody,
  detail: DetailBody,
};

export function RouteSkeleton({
  variant = 'list',
  maxWidth = 'max-w-7xl',
  titleWidth = 'w-32',
  showSubtitle = true,
}: {
  variant?: Variant;
  maxWidth?: string;
  titleWidth?: string;
  showSubtitle?: boolean;
}) {
  const Body = BODIES[variant];
  return (
    <div className={`${maxWidth} mx-auto animate-pulse`}>
      <div className="mb-6">
        <div className={`h-7 ${titleWidth} bg-[rgb(var(--bg-hover))] rounded`} />
        {showSubtitle && <div className="h-4 w-72 bg-[rgb(var(--bg-hover))]/60 rounded mt-2" />}
      </div>
      <Body />
    </div>
  );
}

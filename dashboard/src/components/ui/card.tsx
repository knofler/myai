// Layered card primitives — the section container used by every page.
import Link from 'next/link';
import { Icon, type IconName } from '@/components/ui/icon';
import { TONE, type Tone } from '@/components/ui/tone';

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
    <section className={`gel-surface bg-[rgb(var(--bg-surface))]/70 border ${accent ? accentBorder[accent] : 'border-[rgb(var(--border-subtle))]'} rounded-xl overflow-hidden ${className}`}>
      {(title || meta) && (
        <div className="px-4 py-3 border-b border-[rgb(var(--border-subtle))]/80 flex flex-wrap items-center justify-between gap-2">
          <h2 className={`text-sm font-semibold ${accent ? accentTitle[accent] : 'text-[rgb(var(--text-primary))]'}`}>{title}</h2>
          {meta && <span className="text-xs text-[rgb(var(--text-muted))]">{meta}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

// Legacy `accent` names map onto the shared tone vocabulary (ui/tone.ts) so the
// 12 existing callers keep compiling while they migrate to `tone` + `icon`.
const ACCENT_TONE: Record<string, Tone> = {
  green: 'ok',
  red: 'err',
  blue: 'accent',
  yellow: 'warn',
  purple: 'accent',
  gray: 'muted',
};

/**
 * StatCard — the homepage summary tile, for every page.
 *
 * D5 (operator directive 2026-09-16): "replicate home page pattern everywhere
 * like big icons and meaningful messages." The homepage tile is a tinted glyph
 * box (colour = meaning), a big number, and a sentence-case label. This used to
 * be an UPPERCASE TRACKING-WIDER micro-label over a coloured number in a
 * bordered box — the console look. Same data, homepage treatment.
 *
 * `icon` + `tone` are the new pattern; `accent` is kept for callers that have
 * not migrated yet. `href` makes the whole tile a tap target, like home.
 */
export function StatCard({
  label,
  value,
  sub,
  accent = 'gray',
  icon,
  tone,
  href,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: keyof typeof ACCENT_TONE;
  icon?: IconName;
  tone?: Tone;
  href?: string;
}) {
  const t: Tone = tone ?? ACCENT_TONE[accent] ?? 'muted';
  const body = (
    <>
      <span
        aria-hidden="true"
        className={`flex h-10 w-10 items-center justify-center rounded-xl ${TONE[t].box} ${TONE[t].glyph}`}
      >
        <Icon name={icon ?? 'dot'} size="md" />
      </span>
      {/* Operator 2026-09-18: "boxes need to be larger" — the number is the
          point of a stat tile, so it reads at 30px with the label at meta size. */}
      <span className="text-3xl font-semibold leading-none tracking-tight text-[rgb(var(--text-primary))]">{value}</span>
      <span className="text-meta text-[rgb(var(--text-secondary))]">{label}</span>
      {sub && <span className="text-label text-[rgb(var(--text-muted))]">{sub}</span>}
    </>
  );
  const base = 'flex flex-col gap-3 rounded-2xl bg-[rgb(var(--bg-surface))] p-4 md:p-5';
  if (href) {
    return (
      <Link href={href} className={`tap-press min-h-tap ${base} transition-colors hover:bg-[rgb(var(--bg-hover))]`}>
        {body}
      </Link>
    );
  }
  return <div className={base}>{body}</div>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="p-8 text-center text-sm text-zinc-600">{children}</div>;
}

/* ── Consistent table cell styles (server tables) ──────────── */

export function THead({ cols }: { cols: { label: string; align?: 'left' | 'right' | 'center'; className?: string }[] }) {
  return (
    <thead>
      <tr className="text-left text-label text-[rgb(var(--text-muted))] border-b border-[rgb(var(--border-subtle))] uppercase tracking-wider">
        {cols.map((c) => (
          <th key={c.label} className={`px-4 py-2.5 font-medium ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''} ${c.className ?? ''}`}>
            {c.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

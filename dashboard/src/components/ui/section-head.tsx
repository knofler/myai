// SectionHead — the homepage's section heading ("Currently running · View all ›"),
// extracted verbatim so every other page can open a section the same way
// instead of the uppercase tracking-wider micro-label that read as a console.
// Classes are identical to the original in app/page.tsx — a pure extraction.
import Link from 'next/link';
import { TONE, type Tone } from '@/components/ui/tone';

export function SectionHead({
  title,
  count,
  href,
  linkLabel = 'View all ›',
  tone,
}: {
  title: string;
  count?: number;
  /** Omit for a section with nothing to drill into. */
  href?: string;
  linkLabel?: string;
  tone?: Tone;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="flex items-center gap-2 text-body font-semibold text-[rgb(var(--text-primary))]">
        {title}
        {count != null && count > 0 && (
          <span
            className={`rounded-full px-2 py-0.5 text-label font-semibold ${
              tone ? `${TONE[tone].box} ${TONE[tone].glyph}` : 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-secondary))]'
            }`}
          >
            {count}
          </span>
        )}
      </h2>
      {href && (
        <Link href={href} className="text-meta font-medium text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))]">
          {linkLabel}
        </Link>
      )}
    </div>
  );
}

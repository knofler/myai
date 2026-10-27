import { Icon, type IconName } from '@/components/ui/icon';

/**
 * PageHeader — the top of every page.
 *
 * D5 (operator directive 2026-09-16): "homepage for the app looks good, rest
 * still looks Linux console, replicate home page pattern everywhere like big
 * icons and meaningful messages."
 *
 * Two things the homepage does that this did not, and that made every other
 * page read as a console:
 *
 *   1. A BIG ICON. There was no icon slot at all, so a page opened with a bare
 *      text heading sitting directly on a dense table.
 *   2. A MEANINGFUL MESSAGE. `subtitle` is small and dim (text-meta,
 *      --text-secondary) — fine for a qualifier like "last 24h", wrong for the
 *      thing the reader actually wants. The homepage instead leads with a
 *      plain-English sentence that answers "what happened and what needs me"
 *      ("Your AI handled 3 things in the last 24 hours. 1 needs your
 *      decision."). That is `summary`: full-size body copy in --text-primary.
 *
 * Use `summary` for the answer and `subtitle` for the qualifier. A page with
 * neither is almost certainly still a console screen.
 *
 * Both new props are optional, so all 33 existing callers keep working
 * unchanged and can adopt the pattern one page at a time.
 */
export function PageHeader({
  title,
  icon,
  summary,
  subtitle,
  children,
}: {
  title: string;
  /** Big glyph to the left of the title — the homepage pattern. */
  icon?: IconName;
  /** The plain-English answer. Body-size, primary colour. Say what happened. */
  summary?: React.ReactNode;
  /** The small dim qualifier underneath ("last 24 hours", "3 repos"). */
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {icon && (
          <span
            className="mt-0.5 inline-flex items-center justify-center rounded-xl bg-[rgb(var(--bg-surface))] p-2.5 text-[rgb(var(--text-secondary))]"
            aria-hidden="true"
          >
            <Icon name={icon} size="lg" />
          </span>
        )}
        <div>
          {/* DESIGN_LANGUAGE §2/§3: the title is --text-primary at `text-title`
              (32/38) — coral now means "intelligence", not "heading". The
              subtitle is a real contrast step down: smaller AND dimmer. */}
          <h1 className="text-title font-bold tracking-tight text-[rgb(var(--text-primary))]">{title}</h1>
          {summary && (
            <p className="mt-1.5 max-w-2xl text-body text-[rgb(var(--text-primary))]">{summary}</p>
          )}
          {subtitle && <p className="text-meta text-[rgb(var(--text-secondary))] mt-1">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="mt-1 flex items-center gap-2">{children}</div>}
    </div>
  );
}

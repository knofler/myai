// Shared chrome for the public trust pages (/privacy, /terms, /security) and
// the compliance pack (/dpa, /subprocessors). Renders full-bleed (no dashboard
// sidebar — these are added to AppShell's FULL_BLEED list) so a prospective
// buyer can read them without a login. Header carries the myAI mark + a link
// back to the landing page; the footer cross-links the other trust documents
// so the whole pack is one click apart.
import Link from 'next/link';
import { CookieSettingsButton } from '@/components/cookie-consent';
import { IconTile, type IconName } from '@/components/ui/icon';

const TRUST_LINKS: { href: string; label: string }[] = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/acceptable-use', label: 'Acceptable Use' },
  { href: '/security', label: 'Security' },
  { href: '/dpa', label: 'DPA' },
  { href: '/subprocessors', label: 'Subprocessors' },
];

export function LegalShell({
  title,
  updated,
  intro,
  icon,
  children,
}: {
  title: string;
  updated: string;
  intro?: React.ReactNode;
  /**
   * Optional big glyph beside the title (DESIGN_LANGUAGE §5a). /security is a
   * product claim as much as a legal one, so it takes the icon; the legal pack
   * proper (terms, privacy, DPA, subprocessors, acceptable use) passes nothing
   * and renders exactly as before. Deliberately NOT a PageHeader: this shell
   * already emits the page's one <h1>, and a second one on a public,
   * SEO-indexed page would duplicate the title.
   */
  icon?: IconName;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[rgb(var(--bg-page))] text-[rgb(var(--text-primary))]">
      {/* Header */}
      <header className="border-b border-[rgb(var(--border-subtle))]">
        <div className="max-w-3xl mx-auto px-5 md:px-8 py-4 flex items-center justify-between">
          <Link href="/welcome" className="font-bold text-brand-orange">
            myAI
          </Link>
          <nav className="flex items-center gap-4 text-xs text-[rgb(var(--text-muted))]">
            {TRUST_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-[rgb(var(--text-primary))]">
                {l.label}
              </Link>
            ))}
            <Link href="/operator-login" className="hover:text-[rgb(var(--text-primary))]">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      {/* Body */}
      <main className="max-w-3xl mx-auto px-5 md:px-8 py-10 md:py-14">
        <div className="flex items-start gap-3">
          {icon && <IconTile name={icon} className="mt-0.5" />}
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{title}</h1>
            <p className="mt-2 text-xs text-[rgb(var(--text-muted))]">Last updated: {updated}</p>
          </div>
        </div>
        {intro && <div className="mt-5 text-sm text-[rgb(var(--text-secondary))] leading-relaxed">{intro}</div>}
        <div className="mt-8 space-y-8">{children}</div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[rgb(var(--border-subtle))]">
        <div className="max-w-3xl mx-auto px-5 md:px-8 py-6 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-600">
          <span className="font-bold text-brand-orange">myAI</span>
          <div className="flex items-center gap-4">
            {TRUST_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-[rgb(var(--text-secondary))]">
                {l.label}
              </Link>
            ))}
            <a
              href="https://github.com/knofler/myai/blob/main/SECURITY.md"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[rgb(var(--text-secondary))]"
            >
              SECURITY.md
            </a>
            <a
              href="https://github.com/knofler/myai/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[rgb(var(--text-secondary))]"
            >
              License
            </a>
            {/* Re-opens the consent banner — withdrawing consent must be as easy as giving it. */}
            <CookieSettingsButton className="hover:text-[rgb(var(--text-secondary))]" />
          </div>
        </div>
      </footer>
    </div>
  );
}

// Small typographic helpers so the three trust pages read consistently.
export function Section({ heading, id, children }: { heading: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id}>
      <h2 className="text-lg font-semibold text-[rgb(var(--text-primary))]">{heading}</h2>
      <div className="mt-3 text-sm text-[rgb(var(--text-secondary))] leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc pl-5 space-y-2 text-sm text-[rgb(var(--text-secondary))]">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

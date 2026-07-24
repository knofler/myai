// Shared chrome for the public trust pages (/privacy, /terms, /security).
// Renders full-bleed (no dashboard sidebar — these are added to AppShell's
// FULL_BLEED list) so a prospective buyer can read them without a login.
// Header carries the myAI mark + a link back to the landing page; the footer
// cross-links the other trust documents so the whole pack is one click apart.
import Link from 'next/link';

const TRUST_LINKS: { href: string; label: string }[] = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/security', label: 'Security' },
];

export function LegalShell({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-900">
        <div className="max-w-3xl mx-auto px-5 md:px-8 py-4 flex items-center justify-between">
          <Link href="/welcome" className="font-bold text-brand-orange">
            myAI
          </Link>
          <nav className="flex items-center gap-4 text-xs text-zinc-500">
            {TRUST_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-zinc-200">
                {l.label}
              </Link>
            ))}
            <Link href="/login" className="hover:text-zinc-200">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      {/* Body */}
      <main className="max-w-3xl mx-auto px-5 md:px-8 py-10 md:py-14">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-xs text-zinc-500">Last updated: {updated}</p>
        {intro && <div className="mt-5 text-sm text-zinc-400 leading-relaxed">{intro}</div>}
        <div className="mt-8 space-y-8">{children}</div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900">
        <div className="max-w-3xl mx-auto px-5 md:px-8 py-6 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-600">
          <span className="font-bold text-brand-orange">myAI</span>
          <div className="flex items-center gap-4">
            {TRUST_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-zinc-400">
                {l.label}
              </Link>
            ))}
            <a
              href="https://github.com/knofler/myai/blob/main/SECURITY.md"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-400"
            >
              SECURITY.md
            </a>
            <a
              href="https://github.com/knofler/myai/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-400"
            >
              License
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// Small typographic helpers so the three trust pages read consistently.
export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-100">{heading}</h2>
      <div className="mt-3 text-sm text-zinc-400 leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc pl-5 space-y-2 text-sm text-zinc-400">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

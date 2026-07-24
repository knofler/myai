// IndependentWelcome — the /welcome right-column panel for the Independent
// Edition (self-hosted, single operator, no signup). Rendered instead of
// <LandingSignup> when MYAI_EDITION=independent (the portable-stack default).
//
// There is no account to create when you are running your own gateway, so this
// panel skips signup entirely and points the operator straight at the local
// loop: the 5-minute quickstart commands, then one-tap links into the running
// dashboard (directory, work queue, idea→app). Pure server component — static
// content + links, no client hooks.

import Link from 'next/link';

const QUICKSTART = [
  'npm i -g ai-management',
  'myai init .            # guided setup: key + profile + scan dir',
  'myai up                # gateway + dashboard + mongo on localhost',
  'myai scan ~/code --register',
] as const;

const JUMPS = [
  { href: '/apps', label: 'Your repo directory', desc: 'Everything myai scan registered.' },
  { href: '/work?tab=queue', label: 'The work queue', desc: 'Queue a task — the runner builds it off-hours.' },
  { href: '/welcome/start', label: 'Queue your first task', desc: 'A guided four-step first run.' },
] as const;

export function IndependentWelcome() {
  return (
    <div className="gel-surface rounded-2xl border border-zinc-800 p-5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-zinc-100">Running locally</span>
        <span className="px-2 py-0.5 rounded-md bg-brand-orange/15 border border-brand-orange/40 text-[11px] font-medium text-brand-orange">
          Independent Edition
        </span>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Your gateway, your keys, your machine. No account — you are already in.
      </p>

      {/* 5-minute quickstart */}
      <div className="mt-4">
        <div className="text-[11px] uppercase tracking-widest text-zinc-600">Download → running in 5 minutes</div>
        <pre className="mt-2 px-3 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-teal-300 overflow-x-auto font-mono leading-relaxed">
          {QUICKSTART.join('\n')}
        </pre>
      </div>

      {/* jump into the running dashboard */}
      <div className="mt-4 space-y-2">
        {JUMPS.map((j) => (
          <Link
            key={j.href}
            href={j.href}
            className="block px-3 py-2 rounded-lg border border-zinc-800 hover:border-teal-700 transition-colors"
          >
            <div className="text-sm font-medium text-zinc-200">{j.label} →</div>
            <div className="text-xs text-zinc-500">{j.desc}</div>
          </Link>
        ))}
      </div>

      <p className="mt-4 text-xs text-zinc-600">
        Self-hosting docs live in the repo README. Want multi-tenant signup instead?
        Set <code className="text-zinc-400">MYAI_EDITION=team</code>.
      </p>
    </div>
  );
}

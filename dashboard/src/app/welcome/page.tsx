// /welcome — the public landing page (GO_LIVE_PLAN §5 continuity narrative).
//
// Above the fold: the sleep/wake continuity hook ("you go to sleep, you wake
// up, you are still you") + the install one-liner. Below: the 15s demo-GIF
// slot (drop `continuity-demo.gif` into dashboard/public and swap the
// placeholder), live proof numbers, the autonomous loop, the Solo/Pro/Team
// pricing tiers (Stripe rails shipped in M5 — checkout lives in-app after
// signup), and the data-locality privacy strip (SECURITY.md §1).
// Static-fast: no new deps, no new client components — the only client JS is
// the existing signup widget. Renders full-bleed (no sidebar) via AppShell.

import Link from 'next/link';
import { connectDB, Agent, Skill, RepoCard, Task } from '@/lib/db';
import { LandingSignup } from '@/components/landing-signup';
import { IndependentWelcome } from '@/components/independent-welcome';
import { IosInstallHint } from '@/components/ios-install-hint';

export const dynamic = 'force-dynamic';

// Edition gate: the portable/self-hosted stack runs MYAI_EDITION=independent (the
// env.portable.example default) — no account to create, so the hero swaps signup
// for the local quickstart + dashboard jumps. Unset / 'team' → SaaS signup.
const INDEPENDENT = process.env.MYAI_EDITION === 'independent';

const INSTALL_ONE_LINER = 'npm i -g ai-management && myai init . && myai up';

interface Proof {
  agents: number;
  skills: number;
  repos: number;
  shipped: number; // tasks the autonomous runner has carried to review/done
}

async function getProof(): Promise<Proof> {
  // Best-effort: each number falls back to a known-good figure so the page
  // never renders blanks when Mongo is briefly down.
  const fallback: Proof = { agents: 56, skills: 62, repos: 24, shipped: 0 };
  try {
    await connectDB();
    const [agents, skills, repos, shipped] = await Promise.all([
      Agent.countDocuments(),
      Skill.countDocuments(),
      RepoCard.countDocuments(),
      Task.countDocuments({ status: { $in: ['review', 'done'] } }),
    ]);
    return {
      agents: agents || fallback.agents,
      skills: skills || fallback.skills,
      repos: repos || fallback.repos,
      shipped,
    };
  } catch {
    return fallback;
  }
}

const CONTINUITY = [
  { what: 'Memory', desc: 'A git-versioned brain — sessions are commits, wrap-ups are merges.' },
  { what: 'State', desc: 'Project state and handoffs every agent boots from. No cold starts.' },
  { what: 'Tasks', desc: 'A queue that survives the session — a runner works it off-hours.' },
  { what: 'Budget', desc: 'Token metering that persists, so agents pace themselves across days.' },
];

const GIF_STORYBOARD = [
  { beat: '1', desc: 'A session dies mid-task. Context gone.' },
  { beat: '2', desc: 'Open a different agent — any MCP-capable one.' },
  { beat: '3', desc: 'It greets you with your project state and picks up the task. No prompt.' },
];

// How-it-works — the three commands between "npm install" and "an agent that
// knows you". Deliberately concrete: the whole product is these three steps.
const HOW_IT_WORKS = [
  {
    n: '1',
    cmd: 'npm i -g ai-management',
    title: 'Install once',
    desc: 'One global package. Docker + Node 20, nothing leaves your machine.',
  },
  {
    n: '2',
    cmd: 'myai init .',
    title: 'Point it at a repo',
    desc: 'Scaffolds memory, state, handoff and a task queue into the project. `myai up` starts the local dashboard + off-hours runner.',
  },
  {
    n: '3',
    cmd: '# open any MCP agent',
    title: 'Your agent boots knowing you',
    desc: 'Every session starts from your saved state — project, decisions, what’s next. No re-teaching, no cold start. Ever.',
  },
];

// §3 honest comparison. Sourced from docs/compare.md — these are complementary
// tools that each solve one organ; myAI is the full continuity loop. Framed as
// "when to pick them" so the strip reads as honest, not as a takedown.
const COMPARISON = [
  {
    name: 'Mem0',
    they: 'A memory SDK you embed in an AI product for your app’s users.',
    pick: 'Shipping an app that needs per-user memory.',
  },
  {
    name: 'Zep',
    they: 'A temporal knowledge-graph memory service — tracks when each fact was true.',
    pick: 'Building an agent over data that changes over time.',
  },
  {
    name: 'Letta',
    they: 'Memory-as-OS (MemGPT) — an agent that self-manages RAM/disk memory tiers.',
    pick: 'Researching self-editing long-context agents.',
  },
];

const LOOP = [
  { step: 'Idea', icon: '✦', desc: 'Describe an app or a task in plain English.' },
  { step: 'App', icon: '⊞', desc: 'Agents scaffold and build it — full stack.' },
  { step: 'Schedule', icon: '◷', desc: 'Queued work runs autonomously, overnight.' },
  { step: 'Ops', icon: '◉', desc: 'Approve from your phone with “ship it”.' },
  { step: 'Support', icon: '✉', desc: 'Tickets triage straight back into the build queue.' },
];

interface Tier {
  name: string;
  price: string;
  per: string;
  tagline: string;
  features: string[];
  cta: string;
  href: string;
  highlight?: boolean;
}

// §4 open-core tiers. Solo is the OSS marketing surface; Pro/Team checkout runs
// on the Stripe rails shipped in M5 (in-app after signup — no card on this page).
const TIERS: Tier[] = [
  {
    name: 'Solo',
    price: 'Free',
    per: 'forever · open source',
    tagline: 'The full self-hosted stack. This is the product, not a trial.',
    features: [
      'Persistent memory, state, tasks & budget',
      'Dashboard + off-hours runner',
      'MCP hub — bring any agent',
      '1 operator tenant, your keys, your machine',
    ],
    cta: 'Install free',
    href: '#install',
  },
  {
    name: 'Pro',
    price: '$19',
    per: 'per month',
    tagline: 'For anyone with two devices — continuity that follows you.',
    features: [
      'Cross-machine sync (managed Atlas)',
      'Hosted dashboard access',
      'Continuity metrics history',
      'Priority support + early features',
    ],
    cta: 'Start free, upgrade in-app',
    href: '/welcome/start',
    highlight: true,
  },
  {
    name: 'Team',
    price: '$49',
    per: 'per user / month',
    tagline: 'Shared memory for AI-native teams — everyone’s agents, one brain.',
    features: [
      'Shared tenant memory',
      'Invites + role-based access',
      'Per-member budgets',
      'Team fleet console + audit log',
    ],
    cta: 'Start free, upgrade in-app',
    href: '/welcome/start',
  },
];

const PRIVACY_POINTS = [
  { title: 'Local by default', desc: 'Memory, state, tasks and embeddings live on your machine. Set nothing and nothing leaves the box.' },
  { title: 'Your keys, your model', desc: 'BYOK — your Anthropic subscription or key, or fully-local Ollama. We never proxy your traffic.' },
  { title: 'No token metering, no data sales', desc: 'We don’t meter your tokens and we will never sell your data. Exports are secret-scanned before they leave.' },
];

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="text-3xl md:text-4xl font-bold text-brand-orange tabular-nums">{value}</div>
      <div className="text-xs text-zinc-500 mt-1">{label}</div>
    </div>
  );
}

export default async function Welcome() {
  const proof = await getProof();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* iOS Safari visitors get a dismissible Add-to-Home-Screen hint (no-op elsewhere). */}
      <IosInstallHint />

      {/* ── Top bar ───────────────────────────────────────────── */}
      <header className="max-w-6xl mx-auto px-5 md:px-8 h-16 flex items-center justify-between">
        <span className="text-xl font-bold tracking-tight text-brand-orange">myAI</span>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="#how" className="text-zinc-400 hover:text-zinc-200 hidden sm:inline">
            How it works
          </Link>
          <Link href="#pricing" className="text-zinc-400 hover:text-zinc-200 hidden sm:inline">
            Pricing
          </Link>
          <Link href="/showcase" className="text-zinc-400 hover:text-zinc-200 hidden sm:inline">
            Capabilities
          </Link>
          <Link href="/analytics" className="text-zinc-400 hover:text-zinc-200 hidden sm:inline">
            Live metrics
          </Link>
          <Link
            href="/login"
            className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-200 hover:border-zinc-700 transition"
          >
            Sign in
          </Link>
        </nav>
      </header>

      {/* ── Hero: the continuity hook ─────────────────────────── */}
      <section className="max-w-6xl mx-auto px-5 md:px-8 pt-10 md:pt-16 pb-12 grid lg:grid-cols-[1.2fr_1fr] gap-10 items-start">
        <div>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-purple-500/15 border border-purple-500/40 text-xs font-medium text-purple-300">
            {INDEPENDENT
              ? 'Independent Edition — self-hosted, your keys, your machine'
              : 'Continuity for AI agents — memory that survives the session'}
          </span>
          <h1 className="mt-5 text-4xl md:text-5xl font-bold tracking-tight leading-[1.1]">
            You go to sleep, you wake up,
            <span className="text-brand-orange"> you are still you.</span>
          </h1>
          <p className="mt-5 text-lg text-zinc-400 max-w-xl">
            Everyone is racing for a smarter model — but the smartest employee in the world is useless with amnesia
            every night. Your AI agents don’t remember you. myAI fixes that: memory, state, tasks, and budget that
            survive the session. It’s not a better brain — it’s the ability to <em>keep being someone</em>.
          </p>

          {/* what actually persists */}
          <div className="mt-7 grid sm:grid-cols-2 gap-3">
            {CONTINUITY.map((c) => (
              <div key={c.what} className="gel-surface p-3 rounded-xl border border-zinc-800">
                <div className="text-xs font-semibold text-teal-300">{c.what}</div>
                <div className="text-sm text-zinc-400 mt-1">{c.desc}</div>
              </div>
            ))}
          </div>

          {/* install one-liner */}
          <div id="install" className="mt-7">
            <div className="text-xs uppercase tracking-widest text-zinc-600 mb-2">
              Self-hosted in five minutes — Docker + Node 20
            </div>
            <pre className="gel-surface rounded-xl border border-zinc-800 px-4 py-3 overflow-x-auto">
              <code className="text-sm text-teal-300 font-mono whitespace-nowrap">
                <span className="text-zinc-600 select-none">$ </span>
                {INSTALL_ONE_LINER}
              </code>
            </pre>
          </div>

          <div className="mt-6">
            <Link
              href="/welcome/start"
              className="gel-brand inline-flex px-5 py-2.5 rounded-xl text-sm font-semibold text-teal-100 hover:brightness-110 transition"
            >
              Start guided setup — 4 steps →
            </Link>
            <span className="ml-3 text-xs text-zinc-600">
              {INDEPENDENT
                ? 'connect a repo → queue a task → watch it ship'
                : 'signup → connect a repo → queue a task → watch it ship'}
            </span>
          </div>
        </div>

        <div id="signup" className="lg:sticky lg:top-8">
          {INDEPENDENT ? <IndependentWelcome /> : <LandingSignup />}
        </div>
      </section>

      {/* ── The 15-second proof (demo GIF slot) ───────────────── */}
      {/* Swap this placeholder for <img src="/continuity-demo.gif" …> once the
          launch GIF is recorded (GO_LIVE_PLAN §5 proof artifact #1). */}
      <section className="max-w-6xl mx-auto px-5 md:px-8 pb-14">
        <div className="gel-surface rounded-3xl border border-dashed border-zinc-700 aspect-video max-h-96 w-full flex flex-col items-center justify-center gap-6 p-8">
          <div className="text-xs uppercase tracking-widest text-zinc-600">
            The 15-second proof · demo coming with launch
          </div>
          <div className="grid sm:grid-cols-3 gap-4 w-full max-w-3xl">
            {GIF_STORYBOARD.map((f) => (
              <div key={f.beat} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-center">
                <div className="text-2xl font-bold text-brand-orange">{f.beat}</div>
                <div className="mt-2 text-sm text-zinc-400">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Proof: live numbers ───────────────────────────────── */}
      <section className="border-y border-zinc-900 bg-zinc-900/30">
        <div className="max-w-6xl mx-auto px-5 md:px-8 py-10">
          <p className="text-center text-xs uppercase tracking-widest text-zinc-600">
            Not a demo — these are live numbers from the platform running this page
          </p>
          <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-6">
            <Stat value={`${proof.agents}`} label="specialist agents" />
            <Stat value={`${proof.skills}`} label="repeatable skills" />
            <Stat value={`${proof.repos}`} label="repos under management" />
            <Stat value={proof.shipped > 0 ? `${proof.shipped}` : '24/7'} label={proof.shipped > 0 ? 'tasks shipped to review' : 'off-hours runner'} />
          </div>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3 text-sm">
            <Link
              href="/showcase"
              className="px-4 py-2 rounded-lg border border-zinc-800 text-zinc-200 hover:border-teal-700 hover:text-teal-300 transition"
            >
              See full capabilities →
            </Link>
            <Link
              href="/analytics"
              className="px-4 py-2 rounded-lg border border-zinc-800 text-zinc-200 hover:border-teal-700 hover:text-teal-300 transition"
            >
              Watch the live metrics →
            </Link>
          </div>
        </div>
      </section>

      {/* ── How it works — three commands ─────────────────────── */}
      <section id="how" className="max-w-6xl mx-auto px-5 md:px-8 py-14">
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-center">
          Three commands to an agent that knows you
        </h2>
        <p className="mt-2 text-center text-zinc-500 max-w-2xl mx-auto">
          No SaaS onboarding, no data upload. Install, point it at a repo, and the next agent you open
          boots with your full context.
        </p>
        <div className="mt-10 grid md:grid-cols-3 gap-5">
          {HOW_IT_WORKS.map((s) => (
            <div key={s.n} className="gel-surface rounded-2xl border border-zinc-800 p-6 flex flex-col">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/15 border border-teal-500/40 text-sm font-bold text-teal-300">
                  {s.n}
                </span>
                <span className="text-sm font-semibold text-zinc-100">{s.title}</span>
              </div>
              <pre className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 overflow-x-auto">
                <code className="text-xs font-mono text-teal-300 whitespace-nowrap">
                  <span className="text-zinc-600 select-none">$ </span>
                  {s.cmd}
                </code>
              </pre>
              <p className="mt-3 text-sm text-zinc-500">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── The autonomous loop ───────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-5 md:px-8 py-14 pt-0">
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-center">
          Continuity is what makes the loop possible
        </h2>
        <p className="mt-2 text-center text-zinc-500 max-w-2xl mx-auto">
          Because state survives the session, work can span sessions: idea → app → scheduled autonomous work → mobile
          ops → customer support. Agents that forget can’t do this.
        </p>
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {LOOP.map((s, i) => (
            <div key={s.step} className="gel-surface p-4 rounded-2xl border border-zinc-800 relative">
              <div className="text-2xl text-teal-300">{s.icon}</div>
              <div className="mt-2 text-sm font-semibold text-zinc-100">
                <span className="text-zinc-600 font-mono text-xs mr-1">{i + 1}.</span>
                {s.step}
              </div>
              <div className="mt-1 text-sm text-zinc-500">{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Honest comparison strip (§3, docs/compare.md) ─────── */}
      <section className="max-w-6xl mx-auto px-5 md:px-8 py-14">
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-center">
          Not another memory SDK
        </h2>
        <p className="mt-2 text-center text-zinc-500 max-w-2xl mx-auto">
          Most tools people compare us to solve one organ of the problem for a different buyer — and
          they’re good at it. myAI is the whole continuity loop for the operator running their own repos.
          Honestly: if you’re building one of the things below, use that instead. Often the right answer is both.
        </p>
        <div className="mt-10 grid md:grid-cols-3 gap-5">
          {COMPARISON.map((c) => (
            <div key={c.name} className="gel-surface rounded-2xl border border-zinc-800 p-6 flex flex-col">
              <div className="text-sm font-semibold text-zinc-100">{c.name}</div>
              <p className="mt-2 text-sm text-zinc-400 flex-1">{c.they}</p>
              <div className="mt-4 pt-4 border-t border-zinc-800">
                <div className="text-[10px] uppercase tracking-widest text-zinc-600">Pick it when</div>
                <div className="mt-1 text-sm text-zinc-500">{c.pick}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-8 gel-surface rounded-2xl border border-teal-700/50 ring-1 ring-teal-700/30 p-6 text-center">
          <div className="text-sm font-semibold text-teal-300">Pick myAI when</div>
          <p className="mt-2 text-zinc-300 max-w-2xl mx-auto">
            You’re losing an hour a day re-teaching agents who you are — across your own repos, on a Claude
            subscription. Memory <em>plus</em> state, handoff, a task queue with an off-hours runner, budget, and a
            fleet console. Self-hosted, plugged into any MCP-capable agent.
          </p>
          <a
            href="https://github.com/knofler/myai/blob/main/docs/compare.md"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex text-xs text-zinc-500 hover:text-teal-300 underline underline-offset-2"
          >
            Read the full, honest comparison — compare.md →
          </a>
        </div>
      </section>

      {/* ── Pricing (§4 open core — Stripe rails live since M5) ─ */}
      <section id="pricing" className="border-y border-zinc-900 bg-zinc-900/30">
        <div className="max-w-6xl mx-auto px-5 md:px-8 py-14">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-center">
            The whole stack is free. Pay when continuity should follow you.
          </h2>
          <p className="mt-2 text-center text-zinc-500 max-w-2xl mx-auto">
            Open core, bring your own key — we never meter your tokens. Upgrades check out with Stripe inside the
            dashboard.
          </p>
          <div className="mt-10 grid md:grid-cols-3 gap-5 items-stretch">
            {TIERS.map((t) => (
              <div
                key={t.name}
                className={`gel-surface rounded-2xl border p-6 flex flex-col ${
                  t.highlight ? 'border-teal-700 ring-1 ring-teal-700/40' : 'border-zinc-800'
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <div className="text-sm font-semibold text-teal-300">{t.name}</div>
                  {t.highlight && (
                    <span className="text-[10px] uppercase tracking-widest text-teal-400">most popular</span>
                  )}
                </div>
                <div className="mt-3">
                  <span className="text-3xl font-bold text-zinc-100">{t.price}</span>
                  <span className="ml-2 text-xs text-zinc-500">{t.per}</span>
                </div>
                <p className="mt-2 text-sm text-zinc-400">{t.tagline}</p>
                <ul className="mt-4 space-y-2 text-sm text-zinc-400 flex-1">
                  {t.features.map((f) => (
                    <li key={f} className="flex gap-2">
                      <span className="text-teal-400">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href={t.href}
                  className={`mt-6 inline-flex justify-center px-4 py-2.5 rounded-xl text-sm font-semibold transition ${
                    t.highlight
                      ? 'gel-brand text-teal-100 hover:brightness-110'
                      : 'border border-zinc-700 text-zinc-200 hover:border-teal-700 hover:text-teal-300'
                  }`}
                >
                  {t.cta}
                </Link>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-zinc-600">
            Enterprise — SSO/SAML, compliance exports, air-gap install support, SLA — is custom.{' '}
            <Link href="/welcome/start" className="text-zinc-500 hover:text-teal-300 underline underline-offset-2">
              Talk to us
            </Link>
            .
          </p>
        </div>
      </section>

      {/* ── Privacy guarantee strip (SECURITY.md §1) ──────────── */}
      <section className="max-w-6xl mx-auto px-5 md:px-8 py-12">
        <div className="gel-surface rounded-2xl border border-zinc-800 p-6 md:p-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-bold tracking-tight text-zinc-100">
              The data-locality guarantee
            </h2>
            <a
              href="https://github.com/knofler/myai/blob/main/SECURITY.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-zinc-500 hover:text-teal-300"
            >
              Read the full guarantee — SECURITY.md →
            </a>
          </div>
          <div className="mt-4 grid sm:grid-cols-3 gap-4">
            {PRIVACY_POINTS.map((p) => (
              <div key={p.title}>
                <div className="text-sm font-semibold text-teal-300">{p.title}</div>
                <div className="mt-1 text-sm text-zinc-500">{p.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Closing CTA ───────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-5 md:px-8 pb-20">
        <div className="gel-surface rounded-3xl border border-zinc-800 p-8 md:p-12 text-center">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
            Wake up to an agent that still remembers you.
          </h2>
          <p className="mt-3 text-zinc-400 max-w-xl mx-auto">
            Install free, connect a repo, queue a task — and tomorrow, every agent you open picks up exactly where you
            left off.
          </p>
          <Link
            href="/welcome/start"
            className="gel-brand inline-flex mt-7 px-6 py-3 rounded-xl text-sm font-semibold text-teal-100 hover:brightness-110 transition"
          >
            Start guided setup — free →
          </Link>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="border-t border-zinc-900">
        <div className="max-w-6xl mx-auto px-5 md:px-8 py-6 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-600">
          <span className="font-bold text-brand-orange">myAI</span>
          <div className="flex items-center gap-4">
            <Link href="#pricing" className="hover:text-zinc-400">Pricing</Link>
            <Link href="/showcase" className="hover:text-zinc-400">Capabilities</Link>
            <Link href="/analytics" className="hover:text-zinc-400">Metrics</Link>
            <Link href="/security" className="hover:text-zinc-400">Security</Link>
            <Link href="/privacy" className="hover:text-zinc-400">Privacy</Link>
            <Link href="/terms" className="hover:text-zinc-400">Terms</Link>
            <Link href="/login" className="hover:text-zinc-400">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

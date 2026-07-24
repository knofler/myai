// /showcase — THE single capability page for myAI (ai_management).
//
// This is NOT a per-repo README aggregator (that lived at the old
// /documentation, which now redirects here). It is one polished, visual
// page that answers: what is myAI, how does the autonomous loop work, what
// can it do (with LIVE counts), and — at the bottom — the full master
// SHOWCASE.md rendered nicely.
//
// Brand: 'myAI' wordmark + the H1 are Claude orange (#D97757, the
// --brand-orange token). Interactive accents stay blue-green.

import Link from 'next/link';
import { connectDB, Agent, Skill, Schedule } from '@/lib/db';
import { callGateway } from '@/lib/gateway';
import { readShowcase } from '@/lib/docs';
import { Markdown } from '@/lib/markdown';
import { Card, EmptyState } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

/* ── Live counts ────────────────────────────────────────────────
   Best-effort: each source falls back to a sensible static figure so the
   page never renders blanks when Mongo or the gateway is briefly down. */

interface Counts {
  agents: number;
  skills: number;
  mcpTools: number;
  repos: number;
  schedules: number;
}

async function gatewayToolCount(): Promise<number> {
  try {
    const url = process.env.GATEWAY_MCP_URL ?? 'http://gateway:3100/mcp';
    // ADR-010: bridge token for non-loopback gateway calls under enforce=true.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.GATEWAY_LOCAL_TOKEN) headers['x-gateway-local-token'] = process.env.GATEWAY_LOCAL_TOKEN;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return 0;
    const json = (await res.json()) as { result?: { tools?: unknown[] } };
    return json?.result?.tools?.length ?? 0;
  } catch {
    return 0;
  }
}

async function getCounts(): Promise<Counts> {
  const fallback: Counts = { agents: 56, skills: 62, mcpTools: 44, repos: 24, schedules: 0 };

  const [dbCounts, mcpTools, reposList] = await Promise.all([
    (async () => {
      try {
        await connectDB();
        const [agents, skills, schedules] = await Promise.all([
          Agent.countDocuments(),
          Skill.countDocuments(),
          Schedule.countDocuments(),
        ]);
        return { agents, skills, schedules };
      } catch {
        return null;
      }
    })(),
    gatewayToolCount(),
    callGateway<{ repos?: unknown[] }>('repos_list'),
  ]);

  return {
    agents: dbCounts?.agents || fallback.agents,
    skills: dbCounts?.skills || fallback.skills,
    schedules: dbCounts?.schedules ?? fallback.schedules,
    mcpTools: mcpTools || fallback.mcpTools,
    repos: reposList?.repos?.length || fallback.repos,
  };
}

/* ── Building blocks ────────────────────────────────────────────── */

function CountTile({ value, label, sub }: { value: React.ReactNode; label: string; sub?: string }) {
  return (
    <div className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 text-center">
      <p className="text-3xl font-bold text-teal-300 tabular-nums">{value}</p>
      <p className="text-xs font-medium text-zinc-300 mt-1">{label}</p>
      {sub && <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function Capability({
  icon,
  title,
  body,
  badge,
}: {
  icon: string;
  title: string;
  body: string;
  badge?: string;
}) {
  return (
    <div className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 hover:border-teal-500/30 transition-colors">
      <div className="flex items-center gap-2.5">
        <span className="text-lg leading-none text-teal-300" aria-hidden>{icon}</span>
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        {badge && (
          <span className="ml-auto gel-badge text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-teal-500/10 text-teal-300 border border-teal-500/25">
            {badge}
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-400 mt-2 leading-relaxed">{body}</p>
    </div>
  );
}

// One labelled step in the autonomous-loop flow.
function FlowStep({ n, label, desc }: { n: number; label: string; desc: string }) {
  return (
    <div className="flex-1 min-w-[8.5rem] gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-teal-500/15 border border-teal-500/30 text-[10px] font-bold text-teal-300 tabular-nums">
          {n}
        </span>
        <span className="text-xs font-semibold text-zinc-100">{label}</span>
      </div>
      <p className="text-[11px] text-zinc-500 mt-1.5 leading-snug">{desc}</p>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────── */

export default async function ShowcasePage() {
  const [counts, showcaseMd] = await Promise.all([getCounts(), readShowcase()]);

  const loop: { label: string; desc: string }[] = [
    { label: 'Idea', desc: 'Describe an app in plain English' },
    { label: 'App', desc: 'Blueprint scaffolds a full prod-ready repo' },
    { label: 'Schedule', desc: 'Queue work for the off-hours runner' },
    { label: 'Automate', desc: 'Agents build & ship autonomously' },
    { label: 'Remote', desc: 'Drive it all from your phone' },
    { label: 'Support', desc: 'Health alerts + bug/feature triage' },
  ];

  const capabilities = [
    { icon: '◈', title: 'Multi-agent specialists', body: 'Domain-owning agents auto-discovered by Claude Code — architecture, frontend, API, DB, security, ops, swarm coordination and more. Parallel lanes prevent collisions.', badge: `${counts.agents} agents` },
    { icon: '⚡', title: 'Skill playbooks', body: 'Repeatable, named procedures with trigger keywords — code review, OWASP audit, blueprint scaffold, productionise. Loaded on demand, zero idle token cost.', badge: `${counts.skills} skills` },
    { icon: '⊹', title: 'MCP gateway', body: 'A local gateway exposing tools for memory, scheduling, repo orchestration, routing and recall — shared by every repo on the machine.', badge: `${counts.mcpTools} tools` },
    { icon: '◉', title: 'Mission Control', body: 'This dashboard: what is running, what needs you, what is next — live across the whole fleet. Installable PWA, mobile-first.', badge: 'live' },
    { icon: '⏱', title: 'Scheduling platform', body: 'A work queue an off-hours autonomous runner drains on the free model window — schedule a task, walk away, review the diff in the morning.', badge: `${counts.schedules} scheduled` },
    { icon: '✦', title: 'Blueprint', body: 'One keyword scaffolds a full Next.js + TypeScript + Tailwind + Mongo + Sentry repo wired to the framework — idea to production app.', badge: 'idea→prod' },
    { icon: '☎', title: 'Remote control', body: 'Drive sessions from your phone — Telegram alerts and a CLI-mobile branch bridge keep CLI and mobile sessions perfectly in sync.', badge: 'mobile' },
    { icon: '⊞', title: 'Multi-org orchestration', body: `A single hub managing ${counts.repos} repos — per-repo state, handoffs, health cards and READMEs, all self-contained and portable.`, badge: `${counts.repos} repos` },
    { icon: '⇄', title: 'Cost routing', body: 'Tier-aware model routing maps each agent/task to the right model, prefers the free Fable window for batch work, and meters real token spend.', badge: 'tiered' },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* ── (a) Hero — what myAI is + one-line pitch ──────────────── */}
      <section className="gel-orange rounded-2xl px-6 py-8">
        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-400 font-semibold">Showcase</p>
        <h1 className="text-4xl font-bold tracking-tight mt-1 text-brand-orange">myAI</h1>
        <p className="text-base text-zinc-200 mt-3 max-w-2xl font-medium">
          An AI brain you drop into any codebase. It crawls the repo, learns the architecture, and works
          like an employee — multi-agent, autonomous, mobile-controllable.
        </p>
        <p className="text-sm text-zinc-400 mt-2 max-w-2xl">
          Generic AI assistants forget everything each session. myAI gives them persistent memory,
          cross-repo awareness, scheduled autonomous work, and human oversight from your phone.
        </p>
        <div className="mt-5 flex flex-wrap gap-2 text-xs">
          <Link href="/" className="px-3 py-1.5 rounded-lg gel-brand border border-teal-500/40 text-teal-200 hover:border-teal-400 transition-colors">
            Open Mission Control →
          </Link>
          <Link href="/work" className="px-3 py-1.5 rounded-lg gel-surface border border-zinc-700 text-zinc-300 hover:text-zinc-100 transition-colors">
            See the work queue
          </Link>
          <Link href="/proof" className="px-3 py-1.5 rounded-lg gel-surface border border-zinc-700 text-zinc-300 hover:text-zinc-100 transition-colors">
            Public proof page ↗
          </Link>
        </div>
      </section>

      {/* ── Live counts strip ─────────────────────────────────────── */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <CountTile value={counts.agents} label="Specialist agents" sub="auto-discovered" />
        <CountTile value={counts.skills} label="Skill playbooks" sub="trigger keywords" />
        <CountTile value={counts.mcpTools} label="MCP gateway tools" sub="shared fleet-wide" />
        <CountTile value={counts.repos} label="Managed repos" sub="one hub" />
        <CountTile value="24/7" label="Off-hours runner" sub="free-window work" />
      </section>

      {/* ── (b) The autonomous loop ───────────────────────────────── */}
      <section>
        <h2 className="text-lg font-bold text-zinc-100">The autonomous loop</h2>
        <p className="text-sm text-zinc-500 mt-1 mb-4">
          One continuous cycle — from a sentence to a shipped, supported app.
        </p>
        <div className="flex flex-wrap items-stretch gap-2">
          {loop.map((s, i) => (
            <FlowStep key={s.label} n={i + 1} label={s.label} desc={s.desc} />
          ))}
        </div>
      </section>

      {/* ── (c) Key capabilities ──────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-bold text-zinc-100">What it can do</h2>
        <p className="text-sm text-zinc-500 mt-1 mb-4">
          Capabilities shipping today — counts are live where the gateway and database are reachable.
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {capabilities.map((c) => (
            <Capability key={c.title} {...c} />
          ))}
        </div>
      </section>

      {/* ── Sibling products — clearly-structured placeholders ────── */}
      <section>
        <h2 className="text-lg font-bold text-zinc-100">The platform</h2>
        <p className="text-sm text-zinc-500 mt-1 mb-4">
          myAI is the first of three products. The others get their own showcase, done right.
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="gel-surface bg-zinc-900/70 border border-teal-500/30 rounded-xl p-4">
            <p className="text-sm font-semibold text-teal-300">myAI</p>
            <p className="text-[11px] text-zinc-400 mt-1">The AI management framework — this page.</p>
            <span className="inline-block mt-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-300 border border-teal-500/25">live</span>
          </div>
          <div className="bg-zinc-900/40 border border-dashed border-zinc-700 rounded-xl p-4">
            <p className="text-sm font-semibold text-zinc-400">agentflow</p>
            <p className="text-[11px] text-zinc-500 mt-1">Visual agent workflow builder. Showcase coming soon.</p>
            <span className="inline-block mt-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700">planned</span>
          </div>
          <div className="bg-zinc-900/40 border border-dashed border-zinc-700 rounded-xl p-4">
            <p className="text-sm font-semibold text-zinc-400">connect</p>
            <p className="text-[11px] text-zinc-500 mt-1">Bug &amp; feature intake hub for shipped apps. Showcase coming soon.</p>
            <span className="inline-block mt-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700">planned</span>
          </div>
        </div>
      </section>

      {/* ── (d) Full SHOWCASE.md, rendered nicely ─────────────────── */}
      <section>
        <h2 className="text-lg font-bold text-zinc-100 mb-1">Full capability reference</h2>
        <p className="text-sm text-zinc-500 mb-4">
          The master <code className="text-zinc-400">SHOWCASE.md</code>, rendered live.
        </p>
        {showcaseMd ? (
          <Card>
            <div className="px-6 py-6 max-h-[70vh] overflow-y-auto">
              <Markdown source={showcaseMd} />
            </div>
          </Card>
        ) : (
          <Card title="SHOWCASE.md not found">
            <EmptyState>
              Could not read <code className="text-zinc-400">SHOWCASE.md</code>. The dashboard reads it from
              the master repo mounted read-only at <code className="text-zinc-400">AI_ROOT</code> — verify the
              volume mount in <code className="text-zinc-400">docker-compose.yml</code>.
            </EmptyState>
          </Card>
        )}
      </section>
    </div>
  );
}

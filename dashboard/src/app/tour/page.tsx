// /tour — the animated brain tour: how myAI's brain works, scene by scene.
// Two cuts of the same eight scenes (08:00 boot → memory atoms → distillation →
// vector RAG → MCP gateway → local runner CI → multi-model swarm → smarter
// tomorrow), both self-contained HTML served from /public/tour/:
//   walkthrough — step-by-step SVG walkthrough with Prev/Next and a telemetry feed
//   reel        — the cinematic looping reel (16:9, plays on its own)
// URL-driven tabs (?tab=), embedded full-width in an iframe so the animation
// keeps its own controls and timing.
import { PageHeader } from '@/components/page-header';
import { TabBar, type TabDef } from '@/components/ui/tabs';
import { ReplayAppTourButton } from '@/components/replay-app-tour-button';

export const metadata = {
  title: 'Brain tour · myAI',
  description: "An animated tour of how myAI's brain works — boot, memory, distillation, RAG, gateway, CI and the swarm.",
};

// Phone view (below md): the desktop canvas is unreadable at 390 px, so phones
// get the looping video plus one card per scene (cropped 6 s clip + plain text)
// — the same media as the public blog post. Desktop keeps the interactive tour.
const SCENES = [
  { title: '08:00 — every Mac wakes itself up', text: 'Each machine starts its own myAI, pulls the latest code and memory, checks everything is healthy and writes a report, so a session is waiting when you sit down.' },
  { title: 'Memory that works like git', text: 'The brain is a git repository: each session’s notes are a commit and wrap up merges them, so nothing is lost and any Mac can rebuild it.' },
  { title: 'Distilled, so it stays small', text: 'Notes are distilled into a one-line brief, the working context and a roll-up, so a new session reads the short version first.' },
  { title: '“Have we solved this before?”', text: 'Past sessions are searchable; an agent checks the brain for an earlier fix before it starts writing code.' },
  { title: 'One gateway for every AI tool', text: 'Every tool connects through one local MCP gateway: shared tasks, memory, mailbox and swarm, all behind a token.' },
  { title: 'Work happens while you’re away', text: 'A local runner works the queue after hours, and CI runs on your own self-hosted runner instead of paid cloud minutes.' },
  { title: 'One goal, many models', text: 'A swarm splits a goal into up to five ordered tasks across Claude, Codex, Antigravity and local models, with approval, a budget and a stop button.' },
  { title: 'Tomorrow starts smarter', text: 'Every wrap-up records what was learned, and the next morning’s boot starts from there.' },
];

const TABS: TabDef[] = [
  { id: 'walkthrough', label: 'Walkthrough' },
  { id: 'reel', label: 'Cinematic reel' },
];

export default async function TourPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: raw } = await searchParams;
  const tab = TABS.some((t) => t.id === raw) ? (raw as string) : 'walkthrough';
  const src = tab === 'reel' ? '/tour/reel.html' : '/tour/walkthrough.html';
  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        icon="brain"
        title="Brain tour"
        summary="How myAI's brain works, in eight animated scenes: the 08:00 boot, memory, distillation, RAG, the gateway, local CI and the swarm."
        subtitle="Walkthrough steps through each scene; the cinematic reel loops on its own."
      >
        <ReplayAppTourButton />
      </PageHeader>
      {/* Phone: video + scene cards (readable at 390 px). */}
      <div className="md:hidden space-y-5">
        <video
          className="block w-full rounded-xl border border-[rgb(var(--border-subtle))] bg-black"
          src="/tour/media/brain-tour.mp4"
          poster="/tour/media/poster.jpg"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label="Animated brain tour, eight scenes, looping"
        />
        <ol className="space-y-4">
          {SCENES.map((s, i) => (
            <li key={s.title} className="overflow-hidden rounded-xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]">
              <video
                className="block aspect-video w-full bg-black object-cover"
                src={`/tour/media/scene-${i + 1}.mp4`}
                poster={`/tour/media/scene-${i + 1}.jpg`}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                aria-hidden="true"
              />
              <div className="p-4">
                <p className="font-mono text-xs uppercase tracking-widest text-[rgb(var(--warn))]">Scene {i + 1}</p>
                <h2 className="mt-1 text-lg font-semibold text-[rgb(var(--text-primary))]">{s.title}</h2>
                <p className="mt-1 text-sm text-[rgb(var(--text-secondary))]">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="hidden md:block">
      <TabBar base="/tour" tabs={TABS} active={tab} />
      <div className="mt-6 overflow-hidden rounded-xl border border-[rgb(var(--border-subtle))] bg-black">
        <iframe
          key={src}
          src={src}
          title={tab === 'reel' ? 'Brain tour — cinematic reel' : 'Brain tour — walkthrough'}
          className="block h-[80vh] min-h-[640px] w-full"
          allow="fullscreen"
        />
      </div>
      <p className="mt-3 text-sm text-[rgb(var(--text-muted))]">
        <a className="underline" href={src} target="_blank" rel="noreferrer">Open full screen</a>
      </p>
      </div>
    </div>
  );
}

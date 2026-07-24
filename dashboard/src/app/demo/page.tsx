// /demo — THE adoption demo, as a shareable showcase page.
//
// The thesis, made visual: connect your context through myAI and the cheapest
// free/local model (Ollama gemma3:4b) answers like a frontier model. The SAME
// question is asked to the SAME model twice — raw (no context) vs booted with
// the operator's `context_boot` bundle — and shown side by side.
//
// Data source: dashboard/public/demo/killer-demo.json, produced by
// `scripts/killer_demo.sh` (a real, reproducible run against live Ollama).
// The page reads it from the filesystem at request time so a fresh run is
// reflected immediately; if it's missing, an EmptyState explains how to
// generate it.

import fs from 'node:fs';
import path from 'node:path';
import { Card, EmptyState } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

interface Side {
  answer: string;
  ms: number | null;
  chars: number;
}
interface DemoArtifact {
  schema: string;
  generatedAt: string;
  provider: string;
  model: string;
  question: string;
  repo: string | null;
  thesis: string;
  context: { activeProject: string | null; tokenEstimate: number | null; deeperCount: number };
  raw: Side;
  booted: Side;
}

function readArtifact(): DemoArtifact | null {
  try {
    const p = path.join(process.cwd(), 'public', 'demo', 'killer-demo.json');
    const raw = fs.readFileSync(p, 'utf8');
    const a = JSON.parse(raw) as DemoArtifact;
    if (a?.schema?.startsWith('myai.killer-demo') && a.raw && a.booted) return a;
    return null;
  } catch {
    return null;
  }
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export default function DemoPage() {
  const a = readArtifact();

  return (
    <main className="max-w-5xl mx-auto px-4 py-10 space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold" style={{ color: 'var(--brand-orange, #D97757)' }}>
          The cheapest AI, punching like a frontier model
        </h1>
        <p className="text-zinc-400 max-w-3xl">
          Same question. Same free local model. The only difference: one is booted with{' '}
          <span className="text-zinc-200 font-medium">your context</span>, through myAI. Connect your
          context once and every model — even a 4B one running on your laptop — knows who you are,
          what you&apos;re working on, and what&apos;s next.
        </p>
      </header>

      {!a ? (
        <Card title="No demo run yet" accent="amber">
          <div className="p-6">
            <EmptyState>
              Generate a live side-by-side against a real Ollama model:
              <pre className="mt-3 bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs text-zinc-300 overflow-x-auto">
{`# with Ollama running and the myAI gateway up:
bash scripts/killer_demo.sh                 # gemma3:4b, default question
bash scripts/killer_demo.sh --model mistral:7b-instruct`}
              </pre>
              <p className="mt-3 text-xs text-zinc-500">
                It writes <code>dashboard/public/demo/killer-demo.json</code>, which this page reads.
              </p>
            </EmptyState>
          </div>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
              model: <span className="text-zinc-100 font-mono">{a.model}</span>
            </span>
            <span className="px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
              provider: {a.provider}
            </span>
            <span className="px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
              context: ~{a.context.tokenEstimate ?? '?'} tokens
            </span>
            {a.context.activeProject && (
              <span className="px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
                project: <span className="font-mono">{a.context.activeProject}</span>
              </span>
            )}
          </div>

          <Card title="The question" accent="blue">
            <p className="p-4 text-zinc-200 text-lg font-medium">&ldquo;{a.question}&rdquo;</p>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 items-start">
            <Card title="(A) Raw — no context" accent="red" meta={`${fmtMs(a.raw.ms)} · ${a.raw.chars} chars`}>
              <div className="p-4">
                <p className="text-xs text-red-300/80 mb-2">Generic. It doesn&apos;t know you — so it asks you to explain everything.</p>
                <pre className="whitespace-pre-wrap text-sm text-zinc-300 leading-relaxed max-h-[28rem] overflow-y-auto">{a.raw.answer}</pre>
              </div>
            </Card>

            <Card title="(B) Booted with your context via myAI" accent="emerald" meta={`${fmtMs(a.booted.ms)} · ${a.booted.chars} chars`}>
              <div className="p-4">
                <p className="text-xs text-emerald-300/80 mb-2">Expert, personalized, correct — and usually faster (no rambling).</p>
                <pre className="whitespace-pre-wrap text-sm text-zinc-100 leading-relaxed max-h-[28rem] overflow-y-auto">{a.booted.answer}</pre>
              </div>
            </Card>
          </div>

          <Card accent="purple">
            <div className="p-5 text-center space-y-1">
              <p className="text-lg font-semibold text-purple-200">{a.thesis}</p>
              <p className="text-xs text-zinc-500">
                Reproduce it: <code className="text-zinc-400">bash scripts/killer_demo.sh</code> ·
                generated {new Date(a.generatedAt).toLocaleString()}
              </p>
            </div>
          </Card>
        </>
      )}
    </main>
  );
}

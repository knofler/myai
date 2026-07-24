'use client';

// ProductTour — the first-run interactive walk to the continuity aha-moment.
//
// This is the on-screen counterpart to CONTINUITY_DEMO.md: it takes a brand-new
// operator, in a few clicks, from "what is this?" to the one idea the whole
// product rests on — *agents are disposable, your context isn't*. It runs ONCE
// per browser (gated on localStorage) the first time Mission Control loads, and
// can be replayed any time via the `myai:tour:start` window event (wired to the
// "Take the tour" affordance and used by the headless demo-GIF capture).
//
// Zero new deps by design — a centred coach-mark stepper in pure React + the
// existing Tailwind design tokens (gel-surface / brand-orange / teal). It does
// NOT anchor to page-specific DOM, so it works identically on a zero-repo fresh
// install and a busy dev machine. Every interactive element carries a
// data-testid so scripts/capture_demo_gif.mjs can drive it deterministically.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canSkip,
  shouldAutoAdvance,
  SKIP_REVEAL_MS,
  AUTO_ADVANCE_MS,
} from './product-tour-logic';

const STORAGE_KEY = 'myai:tour:v1:done';
export const TOUR_START_EVENT = 'myai:tour:start';

interface Step {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  /** Optional highlighted continuity pillars, shown as chips. */
  pillars?: { label: string; note: string }[];
}

// The narrative mirrors the CONTINUITY_DEMO.md storyboard beat-for-beat, minus
// the terminal choreography — this is the "why" the GIF proves.
const STEPS: Step[] = [
  {
    id: 'intro',
    eyebrow: 'Welcome to myAI',
    title: 'The smartest employee in the world is useless with amnesia.',
    body: "Every night your AI agents forget who you are and where things stood. This 60-second tour shows the one thing myAI changes — and why it changes everything.",
  },
  {
    id: 'persists',
    eyebrow: 'What survives the session',
    title: 'Your context lives in your layer, not the agent’s.',
    body: 'Four things persist outside any single session, so a fresh agent boots with everything it needs — no cold start, no re-teaching.',
    pillars: [
      { label: 'Memory', note: 'A git-versioned brain — sessions are commits.' },
      { label: 'State', note: 'Project state every agent boots from.' },
      { label: 'Handoff', note: 'Exactly where the last agent stopped.' },
      { label: 'Tasks', note: 'A queue that outlives the session.' },
    ],
  },
  {
    id: 'kill',
    eyebrow: 'The demo',
    title: 'Kill an agent mid-task.',
    body: 'An agent is halfway through a feature — the search typeahead, handoff saved. Then Ctrl+C. Terminal dead, session gone, no wrap-up. In every other tool, that work just evaporated.',
  },
  {
    id: 'aha',
    eyebrow: 'The aha-moment',
    title: 'A different, blank agent picks it up — with one command.',
    body: '`myai connect-agent claude --install` in an empty folder. The new agent greets you by name, knows the active project, reads the handoff, and continues exactly where the dead one stopped. Different agent. Zero re-teaching.',
  },
  {
    id: 'line',
    eyebrow: 'That’s the product',
    title: 'Agents are disposable. Your context isn’t.',
    body: 'Because state survives the session, work can span sessions: idea → app → scheduled autonomous work → mobile ops. Ready to see it for real?',
  },
];

function markSeen() {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* private-mode / storage-disabled — the tour simply re-shows, harmless */
  }
}

export function ProductTour() {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  // The exit is briefly withheld on the opening slide so the value lands first;
  // `skipReady` flips true after the reveal delay (or immediately from slide 2).
  const [skipReady, setSkipReady] = useState(false);
  // Once the user drives (Next/Back/keyboard), auto-advance stops fighting them.
  const interactedRef = useRef(false);

  const reset = useCallback(() => {
    interactedRef.current = false;
    setSkipReady(false);
    setI(0);
    setOpen(true);
  }, []);

  // First-run auto-open + replay listener. Guarded so it never fires during SSR.
  useEffect(() => {
    let seen = '1';
    try {
      seen = window.localStorage.getItem(STORAGE_KEY) ?? '';
    } catch {
      seen = '';
    }
    if (!seen) reset();
    const replay = () => reset();
    window.addEventListener(TOUR_START_EVENT, replay);
    return () => window.removeEventListener(TOUR_START_EVENT, replay);
  }, [reset]);

  const close = useCallback(() => {
    setOpen(false);
    markSeen();
  }, []);

  // A skip attempt (Esc / backdrop / skip link) is only honoured once the exit
  // has been revealed — never a hard trap, just a short beat of engagement.
  const trySkip = useCallback(() => {
    if (skipReady) close();
  }, [skipReady, close]);

  // `manual` distinguishes a user-driven advance (which stops auto-advance) from
  // the auto-advance timer calling next() itself.
  const next = useCallback((manual = true) => {
    if (manual) interactedRef.current = true;
    setI((prev) => {
      if (prev >= STEPS.length - 1) {
        setOpen(false);
        markSeen();
        return prev;
      }
      return prev + 1;
    });
  }, []);

  const back = useCallback(() => {
    interactedRef.current = true;
    setI((prev) => Math.max(0, prev - 1));
  }, []);

  // Per-slide timers: reveal the exit on the opening slide, and auto-advance the
  // leading value slides until the user takes control.
  useEffect(() => {
    if (!open) return;
    const timers: ReturnType<typeof setTimeout>[] = [];

    if (canSkip(i, Infinity)) {
      setSkipReady(true);
    } else {
      setSkipReady(false);
      timers.push(setTimeout(() => setSkipReady(true), SKIP_REVEAL_MS));
    }

    if (shouldAutoAdvance(i, STEPS.length, interactedRef.current)) {
      timers.push(setTimeout(() => next(false), AUTO_ADVANCE_MS));
    }

    return () => timers.forEach(clearTimeout);
  }, [open, i, next]);

  // Keyboard: Esc skips (once revealed), ←/→ navigate.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') trySkip();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, trySkip, next, back]);

  if (!open) return null;

  const step = STEPS[i];
  const isLast = i === STEPS.length - 1;
  const autoAdvancing = shouldAutoAdvance(i, STEPS.length, interactedRef.current);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      data-testid="product-tour"
    >
      {/* backdrop — dismissal is gated until the exit is revealed, so it stays
          inert (not a hard trap) during the brief opening beat. */}
      <button
        aria-label={skipReady ? 'Close tour' : 'Tour is starting'}
        onClick={trySkip}
        aria-disabled={!skipReady}
        className="absolute inset-0 bg-zinc-950/80 backdrop-blur-sm"
        data-testid="tour-backdrop"
      />

      {/* card */}
      <div className="gel-surface relative w-full max-w-lg rounded-3xl border border-zinc-800 p-7 shadow-2xl">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-widest text-teal-300" data-testid="tour-eyebrow">
            {step.eyebrow}
          </span>
          {autoAdvancing && (
            <span
              className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-zinc-500"
              data-testid="tour-autoadvance"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" />
              Auto
            </span>
          )}
        </div>

        <h2
          id="tour-title"
          className="mt-3 text-2xl font-bold leading-tight tracking-tight text-zinc-100"
          data-testid="tour-title"
        >
          {step.title}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400" data-testid="tour-body">
          {step.body}
        </p>

        {step.pillars && (
          <div className="mt-5 grid grid-cols-2 gap-3">
            {step.pillars.map((p) => (
              <div key={p.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="text-xs font-semibold text-brand-orange">{p.label}</div>
                <div className="mt-1 text-xs text-zinc-500">{p.note}</div>
              </div>
            ))}
          </div>
        )}

        {/* progress dots */}
        <div className="mt-6 flex items-center gap-1.5" data-testid="tour-progress">
          {STEPS.map((s, idx) => (
            <span
              key={s.id}
              className={`h-1.5 rounded-full transition-all ${
                idx === i ? 'w-6 bg-teal-400' : 'w-1.5 bg-zinc-700'
              }`}
            />
          ))}
        </div>

        {/* controls */}
        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={back}
            disabled={i === 0}
            className="text-sm text-zinc-500 hover:text-zinc-300 disabled:opacity-0"
            data-testid="tour-back"
          >
            ← Back
          </button>

          {isLast ? (
            <a
              href="/welcome/start"
              onClick={close}
              className="gel-brand inline-flex rounded-xl px-5 py-2.5 text-sm font-semibold text-teal-100 transition hover:brightness-110"
              data-testid="tour-cta"
            >
              Start guided setup →
            </a>
          ) : (
            <button
              onClick={() => next()}
              className="gel-brand inline-flex rounded-xl px-5 py-2.5 text-sm font-semibold text-teal-100 transition hover:brightness-110"
              data-testid="tour-next"
            >
              Next →
            </button>
          )}
        </div>

        {/* Skip — deliberately de-emphasised (small, muted, secondary) and only
            offered once the opening value has had a beat to land. Never front and
            centre; the value is the loud thing, not the exit. */}
        <div className="mt-4 h-4 text-center">
          {skipReady && (
            <button
              onClick={close}
              className="text-[11px] text-zinc-600 underline-offset-2 transition hover:text-zinc-400 hover:underline"
              data-testid="tour-skip"
            >
              Skip for now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

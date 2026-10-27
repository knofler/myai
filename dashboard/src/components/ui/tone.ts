// Tone — colour = meaning (plan/DESIGN_LANGUAGE.md §2). One map, shared by the
// homepage tiles, StatCard, SectionHead and any other primitive that tints a
// glyph box, so every page gets the SAME emerald/teal/amber/red treatment
// instead of five near-misses. Nothing here is decorative:
//   ok      — completed / settled / healthy       (emerald)
//   accent  — live / running / active system state (teal)
//   warn    — needs the operator                   (amber)
//   err     — failed / blocked                     (red)
//   muted   — queued / idle / informational        (no colour)
export type Tone = 'ok' | 'accent' | 'warn' | 'err' | 'muted';

export const TONE: Record<Tone, { box: string; glyph: string }> = {
  ok: { box: 'bg-[rgb(var(--ok))]/15', glyph: 'text-[rgb(var(--ok))]' },
  accent: { box: 'bg-[rgb(var(--accent))]/15', glyph: 'text-[rgb(var(--accent))]' },
  warn: { box: 'bg-[rgb(var(--warn))]/15', glyph: 'text-[rgb(var(--warn))]' },
  err: { box: 'bg-[rgb(var(--err))]/15', glyph: 'text-[rgb(var(--err))]' },
  muted: { box: 'bg-[rgb(var(--bg-hover))]', glyph: 'text-[rgb(var(--text-muted))]' },
};

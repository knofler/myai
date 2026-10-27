// BrandMark — the myAI logo lockup used in the shell.
//
// WHY this exists (operator, 2026-09-12: "myAI icon can be made better more
// prominent"): the app shell rendered the brand as bare text — `myAI`, or a
// lone lowercase `m` when the rail was collapsed — while a real mark sat unused
// in public/icon.svg. A text-only brand reads as a heading, not an identity,
// and the collapsed rail's solitary `m` was unrecognisable as a logo at all.
//
// The badge deliberately mirrors public/icon.svg (same squircle, same coral
// gradient, same wordmark treatment) so the favicon, the installed-PWA icon and
// the in-app mark are visibly the SAME object rather than three near-misses.
// Inline SVG, not <img>: it needs no extra request, scales crisply at any DPR,
// and inherits the page's colour transitions.

interface BrandMarkProps {
  /** Badge edge length in px. The wordmark scales with it. */
  size?: number;
  /** Render the "myAI" wordmark beside the badge. */
  withWordmark?: boolean;
  className?: string;
}

export function BrandMark({ size = 28, withWordmark = false, className }: BrandMarkProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        // Decorative: every call site wraps this in a link that already carries
        // an accessible name ("Mission Control").
        aria-hidden="true"
        focusable="false"
        className="shrink-0"
      >
        <defs>
          {/* A single shared gradient id is safe here — every instance defines
              an identical stop list, so a duplicate resolves to the same paint. */}
          {/* Token-driven, never hex: --brand-orange is the single source of
              truth (design-tokens.test.ts enforces no hex outside theme.ts),
              and color-mix derives the highlight/shadow ends so the mark
              re-themes with the palette instead of drifting from it. */}
          <linearGradient id="myai-mark-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="color-mix(in srgb, rgb(var(--brand-orange)) 82%, white)" />
            <stop offset="0.55" stopColor="rgb(var(--brand-orange))" />
            <stop offset="1" stopColor="color-mix(in srgb, rgb(var(--brand-orange)) 72%, black)" />
          </linearGradient>
          <linearGradient id="myai-mark-fg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgb(var(--text-primary))" />
            <stop offset="1" stopColor="color-mix(in srgb, rgb(var(--text-primary)) 88%, rgb(var(--brand-orange)))" />
          </linearGradient>
        </defs>
        {/* Dark plate behind the gradient, as in icon.svg — it keeps the mark
            legible on both the canvas and a light print/export background. */}
        <rect width="48" height="48" rx="13" fill="rgb(var(--bg-page))" />
        <rect x="3" y="3" width="42" height="42" rx="11" fill="url(#myai-mark-bg)" />
        <text
          x="24"
          y="31"
          textAnchor="middle"
          fontFamily="ui-rounded, -apple-system, system-ui, sans-serif"
          fontSize="22"
          fontWeight="800"
          letterSpacing="-1.2"
          fill="url(#myai-mark-fg)"
        >
          m
        </text>
      </svg>
      {withWordmark && (
        <span
          className="text-lg font-bold leading-none tracking-tight text-brand-orange"
          style={{ fontSize: Math.round(size * 0.64) }}
        >
          myAI
        </span>
      )}
    </span>
  );
}

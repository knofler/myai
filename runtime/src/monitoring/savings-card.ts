/**
 * savings-card.ts — the viral "tokens saved" share card.
 *
 * Renders a dependency-free 1200×630 (OG-standard) SVG that reads
 * "myAI saved me N tokens / $X this month". It is the shareable artifact behind
 * the per-user cold-start savings loop: a member drops it into Slack / X / a
 * README and it links back. Pure string builder — no fonts, no network, no DOM —
 * so it renders identically at the gateway, in the dashboard share-image route,
 * and in tests.
 *
 * The canonical copy lives here (unit-tested via vitest). The dashboard keeps a
 * byte-for-byte mirror at dashboard/src/lib/savings-card.ts because the two
 * packages don't share code (same convention as db.ts's read mirrors).
 */

export interface SavingsCardData {
  /** Who the card is for — a display name or handle. Falls back to "my team". */
  name?: string;
  /** Cold-start tokens saved this month (the headline number). */
  tokens: number;
  /** USD value of those tokens. */
  usd: number;
  /** Context blocks served this month. */
  boots: number;
  /** All-time cumulative tokens saved (the footer flex). */
  allTimeTokens?: number;
  /** Period label, e.g. "this month". */
  period?: string;
}

/** XML-escape a string for safe interpolation into SVG text nodes. */
export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Compact human token count: 12 → "12", 1500 → "1.5K", 2_400_000 → "2.4M". */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(v);
}

/** USD with cents under $100, whole dollars above, comma-grouped. */
export function fmtUsd(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  const digits = v > 0 && v < 100 ? 2 : 0;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * Build the share-card SVG. Deterministic and safe for any input (negatives /
 * NaN clamp to 0, text is XML-escaped).
 */
export function renderSavingsCardSvg(data: SavingsCardData): string {
  const name = escapeXml((data.name?.trim() || 'my team').slice(0, 40));
  const period = escapeXml((data.period?.trim() || 'this month').slice(0, 24));
  const tokens = fmtTokens(data.tokens);
  const usd = fmtUsd(data.usd);
  const boots = Number.isFinite(data.boots) ? Math.max(0, Math.round(data.boots)) : 0;
  const allTime = data.allTimeTokens && data.allTimeTokens > 0
    ? `${fmtTokens(data.allTimeTokens)} tokens saved all-time`
    : `${boots.toLocaleString('en-US')} cold starts skipped ${period}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="myAI saved ${name} ${tokens} tokens (${usd}) ${period}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0a0a"/>
      <stop offset="1" stop-color="#111827"/>
    </linearGradient>
    <linearGradient id="num" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#34d399"/>
      <stop offset="1" stop-color="#10b981"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="8" fill="#10b981"/>
  <text x="80" y="130" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="34" font-weight="700" fill="#a1a1aa" letter-spacing="1">myAI</text>
  <text x="80" y="250" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="52" font-weight="600" fill="#e4e4e7">saved ${name}</text>
  <text x="80" y="410" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="150" font-weight="800" fill="url(#num)">${tokens} tokens</text>
  <text x="80" y="490" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="56" font-weight="700" fill="#e4e4e7">${usd} worth of re-teaching, ${period}</text>
  <text x="80" y="560" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="28" fill="#71717a">${escapeXml(allTime)}</text>
  <text x="1120" y="560" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="26" fill="#52525b">myai.dev</text>
</svg>`;
}

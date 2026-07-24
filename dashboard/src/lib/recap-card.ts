/**
 * recap-card.ts — the shareable "year in review" card (dashboard mirror).
 *
 * ⚠ BYTE-FOR-BYTE MIRROR of runtime/src/monitoring/recap-card.ts — the two
 * packages don't share code (same convention as savings-card.ts). The
 * canonical, unit-tested copy lives in the runtime; keep them in sync. Renders
 * a dependency-free 1200x630 (OG-standard) SVG summarizing the tenant's usage
 * recap. Pure string builder — safe to render in the /recap/card route.
 */

export interface RecapCardData {
  name?: string;
  tasksShipped: number;
  engineerHoursSaved: number;
  appsGenerated: number;
  offhoursMinutes: number;
  period?: string;
}

export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function fmtCount(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return v.toLocaleString('en-US');
}

export function fmtHours(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  return v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US');
}

export function renderRecapCardSvg(data: RecapCardData): string {
  const name = escapeXml((data.name?.trim() || 'my team').slice(0, 40));
  const period = escapeXml((data.period?.trim() || 'the past year').slice(0, 32));
  const tasks = fmtCount(data.tasksShipped);
  const hours = fmtHours(data.engineerHoursSaved);
  const apps = fmtCount(data.appsGenerated);
  const offMin = fmtCount(data.offhoursMinutes);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="myAI year in review for ${name}: ${tasks} tasks shipped, ${hours} engineer-hours saved, ${apps} apps generated, ${offMin} off-hours minutes, ${period}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0a0a"/>
      <stop offset="1" stop-color="#1e1b4b"/>
    </linearGradient>
    <linearGradient id="num" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#a78bfa"/>
      <stop offset="1" stop-color="#818cf8"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="8" fill="#818cf8"/>
  <text x="80" y="100" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="#a1a1aa" letter-spacing="1">myAI · year in review</text>
  <text x="80" y="150" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="42" font-weight="600" fill="#e4e4e7">${name}, ${period}</text>
  <text x="80" y="280" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="120" font-weight="800" fill="url(#num)">${hours} hrs</text>
  <text x="80" y="330" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="40" font-weight="700" fill="#e4e4e7">of engineer time saved</text>
  <text x="80" y="440" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="34" font-weight="600" fill="#c7d2fe">${tasks} tasks shipped</text>
  <text x="80" y="490" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="34" font-weight="600" fill="#c7d2fe">${apps} apps generated</text>
  <text x="80" y="540" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="34" font-weight="600" fill="#c7d2fe">${offMin} off-hours minutes worked</text>
  <text x="1120" y="590" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="26" fill="#52525b">myai.dev</text>
</svg>`;
}

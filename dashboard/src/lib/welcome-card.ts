/**
 * welcome-card.ts — the public /welcome landing page's Open Graph / Twitter
 * share card. Dependency-free 1200×630 (OG-standard) SVG, same convention as
 * lib/proof-card.ts: a pure, DB-free renderer the route hands live-or-fallback
 * numbers to, so link unfurls (Slack/X/iMessage/README) carry the pitch and
 * the live proof numbers instead of the generic dashboard favicon.
 */

import { escapeXml } from './proof-card';
import type { WelcomeProof } from './welcome-proof';

export function renderWelcomeCardSvg(proof: WelcomeProof): string {
  const agents = Math.max(0, Math.round(proof.agents));
  const skills = Math.max(0, Math.round(proof.skills));
  const repos = Math.max(0, Math.round(proof.repos));
  const stats = escapeXml(
    `${agents} specialist agents · ${skills} repeatable skills · ${repos} repos under management`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="myAI — you go to sleep, you wake up, you are still you.">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0a0a"/>
      <stop offset="1" stop-color="#111827"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="8" fill="#cc4426"/>
  <text x="80" y="130" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="34" font-weight="700" fill="#a1a1aa" letter-spacing="1">myAI · continuity for AI agents</text>
  <text x="80" y="230" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="64" font-weight="800" fill="#e4e4e7">You go to sleep, you wake up,</text>
  <text x="80" y="305" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="64" font-weight="800" fill="#cc4426">you are still you.</text>
  <text x="80" y="380" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="30" fill="#a1a1aa">Memory, state, tasks and budget that survive the session.</text>
  <text x="80" y="480" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="26" fill="#5eead4">${stats}</text>
  <text x="1120" y="560" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="26" fill="#52525b">myai.dev/welcome</text>
</svg>`;
}

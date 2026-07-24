/**
 * proof-card.ts — the PUBLIC "continuity savings" share card (GTM proof
 * asset, GO_LIVE_PLAN.md §5 proof-artifact list item 2: "the number").
 *
 * Distinct from lib/savings-card.ts (the tenant-scoped "myAI saved YOU N
 * tokens this month" card behind a login + tenant cookie at /savings/card).
 * This card carries no tenant id, repo name, or cost figure — just the
 * platform-wide, anonymized cold-start token-savings ratio (myAI vs
 * re-reading STATE.md + the handoff every session), the same comparison
 * scripts/brain_token_eval.py runs locally. Renders a dependency-free
 * 1200×630 (OG-standard) SVG anyone can embed with no auth:
 * <img src="https://<host>/proof/card">.
 */

import { fmtTokens } from './format';
import type { ContinuitySavings } from './proof';

/** XML-escape a string for safe interpolation into SVG text nodes. */
export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the public proof-card SVG. Deterministic and safe for any input
 * (the caller — computeContinuitySavings — already clamps to sane values,
 * but text is XML-escaped regardless).
 */
export function renderProofCardSvg(data: ContinuitySavings): string {
  const ratio = escapeXml(data.ratioLabel);
  const pct = Number.isFinite(data.reductionPct) ? Math.max(0, Math.min(100, Math.round(data.reductionPct))) : 0;
  const boots = Number.isFinite(data.measuredBoots) ? Math.max(0, Math.round(data.measuredBoots)) : 0;
  const sub = boots > 0
    ? escapeXml(`measured across ${boots.toLocaleString('en-US')} real cold starts`)
    : escapeXml('benchmark: scripts/brain_token_eval.py (STATE.md + handoff vs the compiled brief)');
  const legacy = fmtTokens(data.legacyAvgTokens);
  const brain = fmtTokens(data.brainAvgTokens);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="myAI: ${ratio} fewer tokens, ${pct}% cold-start reduction">
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
  <text x="80" y="130" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="34" font-weight="700" fill="#a1a1aa" letter-spacing="1">myAI · continuity</text>
  <text x="80" y="250" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="52" font-weight="600" fill="#e4e4e7">fewer tokens to re-teach a fresh agent</text>
  <text x="80" y="410" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="150" font-weight="800" fill="url(#num)">${ratio}</text>
  <text x="80" y="490" font-family="ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="56" font-weight="700" fill="#e4e4e7">${pct}% cold-start token reduction</text>
  <text x="80" y="560" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="26" fill="#71717a">${sub} · ${legacy} → ${brain} tok/boot</text>
  <text x="1120" y="560" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="26" fill="#52525b">myai.dev/proof</text>
</svg>`;
}

// GET /proof/card — the PUBLIC "continuity savings" share image (GTM proof
// asset, GO_LIVE_PLAN.md §5 proof-artifact list item 2: "the number").
//
// Distinct from /savings/card (tenant-scoped, behind login + the myai_tenant
// cookie): this route takes no cookie, no tenant id, no query params — it is
// the same cross-tenant anonymized aggregate as /proof itself, rendered as an
// image so it can be dropped straight into Slack / X / a README / Show HN and
// unfurl as a card: <img src="https://<host>/proof/card">. Already public via
// middleware's PUBLIC_PREFIXES ('/proof' matches by startsWith).

import { getPublicContinuitySavings } from '@/lib/continuity-public';
import { renderProofCardSvg } from '@/lib/proof-card';

export const dynamic = 'force-dynamic';

export async function GET() {
  const savings = await getPublicContinuitySavings();
  const svg = renderProofCardSvg(savings);

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // The ratio moves slowly (aggregate across the whole platform) — cache
      // generously so a viral share doesn't hammer the DB.
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}

// GET /savings/card — the shareable "tokens saved" image (viral loop).
//
// Renders the month-to-date cold-start savings as a 1200×630 OG-standard SVG
// ("myAI saved me N tokens / $X this month"). Drop the URL into Slack / X / a
// README and it unfurls as a card that links back. Tenant-scoped from the
// myai_tenant cookie; ?userId scopes to one member, ?name overrides the label.
//
// SVG (not PNG) keeps it dependency-free and crisp; most unfurlers accept SVG,
// and it embeds directly via <img src="/savings/card">.

import { connectDB } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { getUserSavings } from '@/lib/savings';
import { renderSavingsCardSvg } from '@/lib/savings-card';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = url.searchParams.get('userId')?.trim() || undefined;
  const name = url.searchParams.get('name')?.trim() || undefined;

  let month = { tokens: 0, boots: 0, usd: 0 };
  let total = { tokens: 0 };
  try {
    await connectDB();
    const tenantId = await getActiveTenant();
    const summary = await getUserSavings(tenantFilter(tenantId), { userId });
    month = summary.month;
    total = summary.total;
  } catch {
    // DB down — still render a (zeroed) card rather than 500.
  }

  const svg = renderSavingsCardSvg({
    name: name ?? (userId ? `member ${userId}` : 'my team'),
    tokens: month.tokens,
    usd: month.usd,
    boots: month.boots,
    allTimeTokens: total.tokens,
    period: 'this month',
  });

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // Short cache — the number climbs through the day but needn't be live.
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}

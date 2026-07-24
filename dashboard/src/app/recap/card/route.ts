// GET /recap/card — the shareable "year in review" image (viral loop).
//
// Renders the trailing-12-month usage recap as a 1200x630 OG-standard SVG
// ("myAI shipped N tasks / saved H engineer-hours this year"). Sibling to
// /savings/card. Tenant-scoped from the myai_tenant cookie; ?name overrides
// the team-name label.

import { connectDB, Tenant } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { getUsageRecap } from '@/lib/usage-recap';
import { renderRecapCardSvg } from '@/lib/recap-card';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const nameOverride = url.searchParams.get('name')?.trim() || undefined;

  let name = nameOverride ?? 'my team';
  let recap = { tasksShipped: 0, engineerHoursSaved: 0, appsGenerated: 0, offhoursMinutes: 0 };
  try {
    await connectDB();
    const tenantId = await getActiveTenant();
    const [summary, tenantDoc] = await Promise.all([
      getUsageRecap(tenantFilter(tenantId)),
      Tenant.findOne({ tenantId }).select('name').lean() as Promise<{ name?: string } | null>,
    ]);
    recap = summary;
    if (!nameOverride && tenantDoc?.name) name = tenantDoc.name;
  } catch {
    // DB down — still render a (zeroed) card rather than 500.
  }

  const svg = renderRecapCardSvg({
    name,
    tasksShipped: recap.tasksShipped,
    engineerHoursSaved: recap.engineerHoursSaved,
    appsGenerated: recap.appsGenerated,
    offhoursMinutes: recap.offhoursMinutes,
    period: 'the past year',
  });

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // Short cache — the numbers climb through the day but needn't be live.
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}

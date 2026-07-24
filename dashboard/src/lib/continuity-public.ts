// Cross-tenant read for the PUBLIC continuity-savings proof stat (/proof,
// /proof/card). Unlike lib/savings.ts (per-tenant, behind login), this query
// intentionally carries NO tenantId filter — same "anonymized aggregate, no
// tenant/repo/cost attribution" contract as app/proof/page.tsx's other stats.
// Degrades to computeContinuitySavings' documented fallback (never throws,
// never zeros) so the public page and share card always render something.

import { connectDB, ContinuityMetric } from './db';
import { computeContinuitySavings, type ContinuitySavings } from './proof';

export async function getPublicContinuitySavings(): Promise<ContinuitySavings> {
  try {
    await connectDB();
    const rows = await ContinuityMetric.aggregate<{
      _id: null;
      legacyTokens: number;
      brainTokens: number;
      measuredBoots: number;
    }>([
      { $match: { tool: { $in: ['context_boot', 'brain_delta'] }, baselineTokens: { $gt: 0 } } },
      {
        $group: {
          _id: null,
          legacyTokens: { $sum: '$baselineTokens' },
          brainTokens: { $sum: '$tokens' },
          measuredBoots: { $sum: 1 },
        },
      },
    ]);
    const row = rows[0];
    if (!row) return computeContinuitySavings({ legacyTokens: 0, brainTokens: 0, measuredBoots: 0 });
    return computeContinuitySavings(row);
  } catch {
    return computeContinuitySavings({ legacyTokens: 0, brainTokens: 0, measuredBoots: 0 });
  }
}

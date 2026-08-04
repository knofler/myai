// /api/budget-caps — per-tenant operator overrides of the BUDGET_* env-var
// caps (Phase 5b §8 follow-up). Backs the "Apply suggestion" button on the
// adaptive budget-cap suggestions panel (views/budgets.tsx +
// components/budget-suggestions-panel.tsx), which previously only displayed
// numbers with no write path.
//
//   • GET   — this tenant's stored cap overrides (or null if none set yet).
//   • PATCH — set one cap field, tagged with its source (adaptive-suggested
//             vs manual) so the audit trail in `history` can tell them apart.
//
// TENANCY: writes go straight to the dashboard's Mongo connection scoped to
// the active tenant — same pattern as /api/routing-policy — not the gateway
// bridge token.
import { NextResponse } from 'next/server';
import { connectDB, BudgetCapOverride } from '@/lib/db';
import { getActiveTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIELDS = ['monthlyHardCapUsd', 'dailyCapUsd', 'perChannelCapUsd'] as const;
type Field = (typeof FIELDS)[number];

function isField(v: unknown): v is Field {
  return typeof v === 'string' && (FIELDS as readonly string[]).includes(v);
}

export async function GET() {
  const tenantId = await getActiveTenant();
  try {
    await connectDB();
    const doc = await BudgetCapOverride.findOne({ tenantId }).lean();
    return NextResponse.json({ ok: true, override: doc ?? null });
  } catch (err) {
    console.error('[api/budget-caps] GET failed:', err);
    return NextResponse.json({ error: 'could not load budget cap overrides' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const { field, valueUsd, source } = (body ?? {}) as Record<string, unknown>;
  if (!isField(field)) {
    return NextResponse.json({ error: `field must be one of ${FIELDS.join(', ')}` }, { status: 400 });
  }
  const value = Number(valueUsd);
  if (!Number.isFinite(value) || value < 0) {
    return NextResponse.json({ error: 'valueUsd must be a non-negative number' }, { status: 400 });
  }
  const appliedSource = source === 'adaptive-suggested' ? 'adaptive-suggested' : 'manual';

  const tenantId = await getActiveTenant();
  try {
    await connectDB();
    const now = new Date();
    const existing = await BudgetCapOverride.findOne({ tenantId }).lean() as Record<string, unknown> | null;
    const previousValueUsd = existing && typeof existing[field] === 'number' ? (existing[field] as number) : null;

    const doc = await BudgetCapOverride.findOneAndUpdate(
      { tenantId },
      {
        $set: { [field]: value, updatedAt: now },
        $setOnInsert: { tenantId },
        $push: {
          history: {
            $each: [{ field, valueUsd: value, previousValueUsd, source: appliedSource, appliedAt: now }],
            $slice: -50,
          },
        },
      },
      { upsert: true, new: true },
    ).lean();

    return NextResponse.json({ ok: true, override: doc });
  } catch (err) {
    console.error('[api/budget-caps] PATCH failed:', err);
    return NextResponse.json({ error: 'could not save budget cap override' }, { status: 500 });
  }
}

// Persisted `PayoutLedgerEntry` store (ADR-019 §1 / implementation checklist
// item #1 — "db.ts schemas + indexes for the four entities; stores
// (marketplace-store.ts) calling this model layer; tenant-scoped reads per
// ADR-010"). Replaces the prior in-memory `globalThis`-cached Map — the
// gateway rebuild dependency that follow-up #4's payout-run endpoint was
// blocked on ("still fixture-only"). `completeMarketplaceCharge`
// (marketplace-store.ts) appends charge rows; the payout-run route
// (api/marketplace/payouts/run) is the only other writer — it clears elapsed
// `pending` rows to `available` and appends `payout` rows.
//
// `entryId` is the Stripe object id (PaymentIntent/session/invoice) that
// proves the charge happened — appends are idempotent on it (the schema's
// unique index), mirroring the ADR-014 meter-event dedup pattern (a
// redelivered webhook event never double-appends).
//
// Reads are scoped by `creatorTenantId` (ADR-010) — the CREATOR tenant being
// paid, not the installer/buyer — matching the ADR-019 §1 ledger ownership.
import { connectDB, PayoutLedgerEntry as PayoutLedgerEntryModel } from './db';
import type { PayoutLedgerEntry } from './marketplace-billing';
import { DEFAULT_HOLD_DAYS } from './marketplace-billing';

interface LedgerDoc {
  creatorTenantId: string;
  entryId: string;
  listingId: string;
  installId?: string;
  type: PayoutLedgerEntry['type'];
  status: PayoutLedgerEntry['status'];
  grossUsd: number;
  platformFeeUsd: number;
  creatorNetUsd: number;
  currency: string;
  occurredAt: Date | string;
  payoutBatchId?: string;
  createdAt: Date | string;
}

function toEntry(doc: LedgerDoc): PayoutLedgerEntry {
  return {
    creatorTenantId: doc.creatorTenantId,
    entryId: doc.entryId,
    listingId: doc.listingId,
    installId: doc.installId,
    type: doc.type,
    status: doc.status,
    grossUsd: doc.grossUsd,
    platformFeeUsd: doc.platformFeeUsd,
    creatorNetUsd: doc.creatorNetUsd,
    currency: doc.currency,
    occurredAt: new Date(doc.occurredAt).toISOString(),
    payoutBatchId: doc.payoutBatchId,
    createdAt: new Date(doc.createdAt).toISOString(),
  };
}

/** MongoServerError E11000 — the unique `entryId` index rejecting a duplicate. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Has this charge event already been appended? The idempotency check the
 *  webhook handler runs before building+appending a new row. */
export async function hasLedgerEntry(entryId: string): Promise<boolean> {
  await connectDB();
  const doc = await PayoutLedgerEntryModel.findOne({ entryId }).select('_id').lean();
  return doc !== null;
}

export async function getLedgerEntry(entryId: string): Promise<PayoutLedgerEntry | undefined> {
  await connectDB();
  const doc = await PayoutLedgerEntryModel.findOne({ entryId }).lean<LedgerDoc | null>();
  return doc ? toEntry(doc) : undefined;
}

/**
 * Append a charge/payout row. Append-only per ADR-019 §2: throws on a
 * duplicate `entryId` (caught from the schema's unique-index violation)
 * rather than silently overwriting — callers MUST check `hasLedgerEntry`
 * first if a re-append is a legitimate no-op (e.g. a redelivered webhook),
 * not treat this as an upsert.
 */
export async function appendLedgerEntry(entry: Omit<PayoutLedgerEntry, 'createdAt'>): Promise<PayoutLedgerEntry> {
  await connectDB();
  const withTimestamp: PayoutLedgerEntry = { ...entry, createdAt: new Date().toISOString() };
  try {
    await PayoutLedgerEntryModel.create(withTimestamp);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new Error(`ledger entry ${entry.entryId} already appended (append-only — no overwrite)`);
    }
    throw err;
  }
  return withTimestamp;
}

/** Every ledger row for one creator tenant (payout-balance rollup input). */
export async function listLedgerForCreator(creatorTenantId: string): Promise<PayoutLedgerEntry[]> {
  await connectDB();
  const docs = await PayoutLedgerEntryModel.find({ creatorTenantId }).sort({ occurredAt: 1 }).lean<LedgerDoc[]>();
  return docs.map(toEntry);
}

/** Every ledger row for one listing (creator-earnings-by-listing views). */
export async function listLedgerForListing(listingId: string): Promise<PayoutLedgerEntry[]> {
  await connectDB();
  const docs = await PayoutLedgerEntryModel.find({ listingId }).sort({ occurredAt: 1 }).lean<LedgerDoc[]>();
  return docs.map(toEntry);
}

/** Distinct creator tenant ids that have ANY ledger activity — the payout
 *  run's candidate set (checked one by one against `computeCreatorBalance` +
 *  `decidePayoutWithConnect`; most will simply come back ineligible). */
export async function listCreatorTenantIds(): Promise<string[]> {
  await connectDB();
  return PayoutLedgerEntryModel.distinct('creatorTenantId');
}

/**
 * Flip every `pending` row whose hold window has elapsed to `available` —
 * the status mutation connect-payout.ts's `isClearanceElapsed` doc comment
 * says belongs to the store ("this only answers 'may I clear this row now',
 * it never mutates anything itself"). A single bulk update across all
 * creators (equivalent to calling `isClearanceElapsed` per pending row for a
 * fixed `holdDays`, since occurredAt is what it compares against `now`).
 * Run at the top of every payout run so `computeCreatorBalance` sees
 * up-to-date `available` balances.
 */
export async function clearElapsedPendingEntries(
  now: Date = new Date(),
  holdDays: number = DEFAULT_HOLD_DAYS,
): Promise<number> {
  await connectDB();
  const cutoff = new Date(now.getTime() - holdDays * 24 * 60 * 60 * 1000);
  const res = await PayoutLedgerEntryModel.updateMany(
    { status: 'pending', occurredAt: { $lte: cutoff } },
    { $set: { status: 'available' } },
  ).exec();
  return (res as { modifiedCount?: number })?.modifiedCount ?? 0;
}

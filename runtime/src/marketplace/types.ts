/**
 * Public agent/skill marketplace — data-model types (ADR-019, spec slice).
 *
 * SPEC ONLY — there is no live marketplace yet. These types define the model
 * layer the eventual db.ts schemas, stores, and MCP tools code against; the
 * pure state-machine + revenue-share logic in this folder is unit-tested now so
 * the contract is nailed down before any DB or gateway wiring exists.
 *
 * Two axes, mirrored from the two-meter architecture (ADR-014):
 *  - a CATALOG axis (MarketplaceListing + ListingVersion) — what creators
 *    publish; content-addressed by manifest hash (ties into the existing
 *    security-integrity SHA-256 manifest so an installed package is verifiable).
 *  - a COMMERCE axis (Install + PayoutLedgerEntry) — who installed what, and the
 *    append-only revenue-share ledger that a payout run reads. The ledger is the
 *    money source-of-truth; installs are provenance.
 *
 * Every persisted entity is tenant-scoped (ADR-010): a listing is owned by its
 * CREATOR tenant; an install belongs to the INSTALLER tenant; a ledger entry
 * belongs to the CREATOR tenant being paid. The scope field is named per entity
 * to keep "whose row is this" unambiguous at the query site.
 */

/** What a listing packages. Closed vocabulary — additive only. */
export type ListingKind = 'agent' | 'skill';

/** How a listing is monetised. `free` short-circuits all commerce. */
export type PricingModel = 'free' | 'one_time' | 'subscription' | 'usage';

/**
 * Listing lifecycle. A listing is the catalog entry; its versions carry the
 * artifact. The listing status gates discoverability and installability.
 *
 *   draft ─────────► in_review ──► approved ──► published
 *     ▲                  │                          │
 *     │(resubmit)        ▼(reject)          ┌───────┴────────┐
 *     └──────────────  rejected             ▼                ▼
 *                                        suspended ◄──►  (published)
 *                                            │
 *                                            ▼
 *                                         delisted  (terminal)
 */
export type ListingStatus =
  | 'draft'       // creator editing; not visible
  | 'in_review'   // submitted; awaiting platform review
  | 'rejected'    // review failed; creator may edit → resubmit
  | 'approved'    // review passed; not yet live
  | 'published'   // live + installable
  | 'suspended'   // temporarily pulled (policy / creator) — existing installs keep running
  | 'delisted';   // permanently removed from catalog (terminal); installs grandfathered

/** A published, immutable version of a listing's artifact. */
export type VersionStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'published'   // installable
  | 'yanked';     // pulled (security) — blocks NEW installs of this version only

/** Lifecycle of one tenant's install of a listing. */
export type InstallStatus =
  | 'active'      // installed + enabled
  | 'disabled'    // installed but turned off (no execution, still billed if subscription until uninstalled)
  | 'uninstalled';// removed (terminal)

/** Revenue-share ledger entry types. Append-only; a correction is a new entry. */
export type LedgerEntryType =
  | 'sale'                // one_time purchase
  | 'subscription_cycle'  // one billing period of a subscription install
  | 'usage'               // metered usage roll-up (reads UsageEvent — ADR-014)
  | 'refund_reversal'     // negates a prior sale/cycle (negative amounts)
  | 'adjustment'          // manual correction (support / dispute)
  | 'payout';             // funds moved to the creator (negative net, settles balance)

/** Where a ledger entry sits in the payout pipeline. */
export type LedgerEntryStatus =
  | 'pending'    // earned but inside the hold/clearance window
  | 'available'  // cleared; counts toward the next payout batch
  | 'paid'       // included in a completed payout
  | 'reversed';  // cancelled by a refund_reversal

// ── Catalog axis ──────────────────────────────────────────

export interface MarketplaceListing {
  creatorTenantId: string;      // scope — the tenant that owns/earns from this listing
  listingId: string;            // stable id
  slug: string;                 // url-safe, unique per catalog
  kind: ListingKind;
  title: string;
  summary: string;
  status: ListingStatus;
  pricingModel: PricingModel;
  priceUsd: number;             // 0 for free/usage-only; per-period for subscription
  currency: string;             // ISO 4217; 'USD' for v1
  /** Creator's share of gross, in basis points (7000 = 70%). Resolved from platform default at publish. */
  revenueShareBps: number;
  category: string;
  tags: string[];
  latestVersion?: string;       // semver of the current published version
  installCount: number;
  ratingAvg: number;            // 0..5
  ratingCount: number;
  createdBy: string;            // userId of the creator principal (ADR-013)
  publishedAt?: string;         // ISO — set on first transition to published
  createdAt: string;
  updatedAt: string;
}

export interface ListingVersion {
  creatorTenantId: string;      // scope (mirrors the parent listing)
  listingId: string;
  version: string;              // semver
  status: VersionStatus;
  /** SHA-256 of the packaged artifact — the integrity anchor (security-integrity manifest). */
  manifestHash: string;
  changelog: string;
  artifactUri: string;          // where the package bytes live (opaque to the model)
  /**
   * `PackageCapabilities.declaredTools` (ADR-027 §2), frozen from the
   * manifest at submission — the tool surface this version claims. Carried on
   * the version (not the listing) because it's what a reviewer diffs against
   * the listing's prior published/approved version to spot capability
   * widening (ADR-028 §4).
   */
  declaredTools: string[];
  reviewedBy?: string;          // userId of the platform reviewer
  publishedAt?: string;
  createdAt: string;
}

// ── Commerce axis ─────────────────────────────────────────

export interface Install {
  installerTenantId: string;    // scope — the tenant that installed it
  installId: string;
  listingId: string;
  version: string;              // pinned version at install time
  status: InstallStatus;
  installedBy: string;          // userId
  pricePaidUsd: number;         // amount charged at install (0 for free)
  billingRef?: string;          // link to the billing/Stripe record
  installedAt: string;
  updatedAt: string;
}

export interface PayoutLedgerEntry {
  creatorTenantId: string;      // scope — the creator being paid
  entryId: string;              // unique — idempotency key
  listingId: string;
  installId?: string;           // provenance; absent for adjustments/payouts
  type: LedgerEntryType;
  status: LedgerEntryStatus;
  grossUsd: number;             // customer-charged amount (negative for refund/payout)
  platformFeeUsd: number;       // platform's cut (0 for payout/adjustment rows)
  creatorNetUsd: number;        // gross - fee (negative for refund/payout)
  currency: string;
  occurredAt: string;           // event time (billing period boundary, sale time, …)
  payoutBatchId?: string;       // set when included in a payout run
  createdAt: string;
}

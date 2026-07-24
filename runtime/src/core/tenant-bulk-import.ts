/**
 * Bulk tenant provisioning (reseller/agency onboarding).
 *
 * An operator/reseller uploads a CSV or JSON row set (name, plan, seats,
 * adminEmail) and this module validates it, previews it (`dryRun`), or
 * commits it — one tenant + owner account per row, with a per-row result so
 * a partial failure never hides which rows actually landed.
 *
 * Distinct from single-tenant CRUD (dashboard/CLI) and the reseller billing
 * hierarchy — this is only the mass-onboarding path. Reuses the same
 * `provisionTenant` primitive signup uses. Unlike signup, the CSV/JSON row
 * carries no password: the owner row is seeded with an unusable random
 * placeholder hash and the admin claims the account via the existing
 * password-reset "set your own password" email — invites can't mint an
 * `owner`, so that path (not the invite path) is the one that fits here.
 */
import crypto from 'node:crypto';
import { UserModel, type TenantPlan, type UserRole } from '../shared/db.js';
import { provisionTenant } from './tenant-keys.js';
import { hashPassword } from './user-auth.js';
import { requestPasswordReset } from './password-reset.js';
import { planLimits } from './billing.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'tenant-bulk-import' });

const VALID_PLANS: ReadonlySet<string> = new Set(['free', 'solo', 'team', 'scale']);
const MAX_ROWS_PER_BATCH = 500;
const MAX_NAME_LENGTH = 200;

// ── Input parsing (CSV / JSON → raw string-keyed rows) ──────────────────────

/** Lowercase, alnum-only key so header variants ("Admin Email", "admin_email",
 *  "email") all resolve to the same canonical field. */
function normalizeKey(k: string): string {
  return k.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

/** Minimal dependency-free CSV parser: header row + comma-separated values,
 *  double-quote escaping (`""` inside a quoted field). */
export function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = (cells[idx] ?? '').trim();
    });
    rows.push(row);
  }
  return rows;
}

class BulkImportInputError extends Error {}

function rawRowsFromInput(format: 'csv' | 'json', data: unknown): Record<string, unknown>[] {
  if (format === 'csv') {
    if (typeof data !== 'string') throw new BulkImportInputError('csv format requires a string `data` payload');
    return parseCsvRows(data);
  }
  // json
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new BulkImportInputError('json format `data` string is not valid JSON');
    }
  }
  if (!Array.isArray(data)) throw new BulkImportInputError('json format requires an array of row objects');
  return data.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new BulkImportInputError(`row ${i + 1} is not an object`);
    }
    return row as Record<string, unknown>;
  });
}

function getField(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const nk = normalizeKey(k);
    for (const rk of Object.keys(row)) {
      if (normalizeKey(rk) === nk) return row[rk];
    }
  }
  return undefined;
}

// ── Row validation ───────────────────────────────────────────────────────────

export interface NormalizedImportRow {
  name: string;
  plan: TenantPlan;
  seats: number;
  adminEmail: string;
}

function validateRow(raw: Record<string, unknown>): { row: NormalizedImportRow; errors: string[] } {
  const errors: string[] = [];

  const nameRaw = getField(raw, 'name', 'tenantName', 'tenant');
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!name) errors.push('name is required');
  else if (name.length > MAX_NAME_LENGTH) errors.push(`name must be ${MAX_NAME_LENGTH} characters or fewer`);

  const planRaw = getField(raw, 'plan');
  const planStr = typeof planRaw === 'string' ? planRaw.trim().toLowerCase() : String(planRaw ?? '').trim().toLowerCase();
  if (!planStr) errors.push('plan is required');
  else if (!VALID_PLANS.has(planStr)) errors.push(`plan must be one of: ${[...VALID_PLANS].join(', ')}`);
  const plan = (VALID_PLANS.has(planStr) ? planStr : 'free') as TenantPlan;

  const seatsRaw = getField(raw, 'seats', 'seatCount');
  let seats = 0;
  if (seatsRaw === undefined || seatsRaw === null || seatsRaw === '') {
    errors.push('seats is required');
  } else {
    const n = typeof seatsRaw === 'number' ? seatsRaw : Number(seatsRaw);
    if (!Number.isInteger(n) || n < 1) {
      errors.push('seats must be a positive integer');
    } else {
      seats = n;
    }
  }

  const emailRaw = getField(raw, 'adminEmail', 'admin_email', 'email', 'owneremail');
  const adminEmail = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
  if (!adminEmail || !adminEmail.includes('@')) errors.push('adminEmail must be a valid email address');

  if (seats > 0 && VALID_PLANS.has(planStr)) {
    const maxSeats = planLimits(plan).teamSeats;
    if (maxSeats >= 0 && seats > maxSeats) {
      errors.push(`seats (${seats}) exceeds the '${plan}' plan's limit of ${maxSeats}`);
    }
  }

  return { row: { name, plan, seats, adminEmail }, errors };
}

// ── Report shape ─────────────────────────────────────────────────────────────

export type BulkImportRowStatus = 'valid' | 'invalid' | 'created' | 'error';

export interface BulkImportRowResult {
  row: number; // 1-based, excluding the header
  name: string;
  plan: TenantPlan;
  seats: number;
  adminEmail: string;
  status: BulkImportRowStatus;
  tenantId?: string;
  /** Show-once raw API key — present only for a freshly `created` row. */
  apiKey?: string;
  errors?: string[];
}

export interface BulkImportReport {
  batchId: string;
  dryRun: boolean;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdRows: number;
  failedRows: number;
  results: BulkImportRowResult[];
}

export interface BulkImportInput {
  format: 'csv' | 'json';
  data: unknown;
  /** Defaults to true — a bulk tenant-creation call must be explicitly
   *  opted OUT of preview mode (`dryRun: false`) to actually write anything. */
  dryRun?: boolean;
  /** Operator identity for traceability — stamped into each created tenant's metadata. */
  provisionedBy?: string;
}

async function provisionRow(
  row: NormalizedImportRow,
  batchId: string,
  provisionedBy: string | undefined,
): Promise<{ tenantId: string; apiKey: string }> {
  const tenantId = `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const { tenant, rawKey } = await provisionTenant({
    tenantId,
    name: row.name,
    plan: row.plan,
    ownerEmail: row.adminEmail,
    env: 'live',
    metadata: {
      seats: row.seats,
      provisionedVia: 'bulk-import',
      bulkBatchId: batchId,
      ...(provisionedBy ? { provisionedBy } : {}),
    },
  });

  const userId = `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  // Nobody knows this password — the admin claims the account via the
  // password-reset email sent below (same "set your own password" UX an
  // invite gives a joining member; the invite path itself can't mint an owner).
  const placeholderHash = await hashPassword(crypto.randomBytes(24).toString('hex'));
  await UserModel.create({
    userId,
    tenantId,
    email: row.adminEmail,
    passwordHash: placeholderHash,
    displayName: row.adminEmail.split('@')[0],
    role: 'owner' as UserRole,
  });

  try {
    await requestPasswordReset(row.adminEmail);
  } catch (err) {
    // Claim-account email failing must not roll back the already-committed
    // tenant + owner row — the operator still gets the raw key below and can
    // hand it (or a manual reset link) to the admin themselves.
    log.warn({ tenantId, adminEmail: row.adminEmail, err }, 'bulk-import: claim-account email failed to send');
  }

  log.info({ tenantId, adminEmail: row.adminEmail, plan: tenant.plan, batchId }, 'bulk-import: tenant provisioned');
  return { tenantId, apiKey: rawKey };
}

/**
 * Validate (and, unless `dryRun`, provision) every row of a bulk tenant-import
 * batch. Never throws for row-level problems — those surface as `invalid`/
 * `error` entries in the report; it only throws for a structurally unusable
 * payload (unparsable CSV/JSON, wrong `data` shape, or over the row cap).
 */
export async function bulkImportTenants(input: BulkImportInput): Promise<BulkImportReport> {
  const dryRun = input.dryRun ?? true;
  const rawRows = rawRowsFromInput(input.format, input.data);
  if (rawRows.length === 0) throw new BulkImportInputError('no rows found in the uploaded data');
  if (rawRows.length > MAX_ROWS_PER_BATCH) {
    throw new BulkImportInputError(`batch has ${rawRows.length} rows — max ${MAX_ROWS_PER_BATCH} per import`);
  }

  const batchId = `bulk_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const results: BulkImportRowResult[] = [];
  const seenEmails = new Set<string>();

  for (let i = 0; i < rawRows.length; i++) {
    const rowNum = i + 1;
    const { row, errors } = validateRow(rawRows[i]);

    if (row.adminEmail) {
      if (seenEmails.has(row.adminEmail)) {
        errors.push('adminEmail is duplicated within this batch');
      } else {
        seenEmails.add(row.adminEmail);
      }
    }

    if (!errors.length && row.adminEmail) {
      const existing = await UserModel.findOne({ email: row.adminEmail }).lean();
      if (existing) errors.push('adminEmail is already registered to an existing account');
    }

    if (errors.length) {
      results.push({ row: rowNum, ...row, status: 'invalid', errors });
      continue;
    }

    if (dryRun) {
      results.push({ row: rowNum, ...row, status: 'valid' });
      continue;
    }

    try {
      const created = await provisionRow(row, batchId, input.provisionedBy);
      results.push({ row: rowNum, ...row, status: 'created', tenantId: created.tenantId, apiKey: created.apiKey });
    } catch (err) {
      results.push({
        row: rowNum,
        ...row,
        status: 'error',
        errors: [err instanceof Error ? err.message : 'provisioning failed'],
      });
    }
  }

  const invalidRows = results.filter((r) => r.status === 'invalid').length;
  const failedRows = results.filter((r) => r.status === 'error').length;
  const createdRows = results.filter((r) => r.status === 'created').length;
  const validRows = results.filter((r) => r.status === 'valid').length;

  log.info(
    { batchId, dryRun, totalRows: rawRows.length, validRows, invalidRows, createdRows, failedRows },
    'bulk-import: batch complete',
  );

  return {
    batchId,
    dryRun,
    totalRows: rawRows.length,
    validRows,
    invalidRows,
    createdRows,
    failedRows,
    results,
  };
}

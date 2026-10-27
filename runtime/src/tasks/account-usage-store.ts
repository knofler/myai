/**
 * Account usage ledger (multi-Mac phase 2 — plan/MULTI_MAC_SWARM_BRIEF.md).
 *
 * The question it answers: "how much of each ACCOUNT's 5-hour and weekly quota
 * is used right now, across BOTH Macs?" Three inputs, best first:
 *
 *  1. REAL readings (`account_readings`): Claude Code's statusLine payload
 *     carries `rate_limits.five_hour/seven_day.used_percentage` + `resets_at`
 *     (verified on 2.1.289), agy writes its quota file, and the operator gives
 *     /usage readings (the only source of the per-model Fable/Opus rows).
 *  2. Token buckets (`account_usage`): hourly per account × host × model,
 *     recomputed from each Mac's own transcripts (deduped by message.id) and
 *     SET on every push, so re-pushing never double-counts.
 *  3. A fitted scale: every real reading is paired with the weighted tokens of
 *     its window; least squares gives `k` (percent per weighted token) per
 *     account × window. Then
 *        anchored estimate = last real % + k × weighted tokens since it
 *     (headless runner fires and quiet nights have no statusLine, so they are
 *     extrapolated from the freshest real anchor, not guessed from zero).
 *
 * Token weights are PRIORS relative to Sonnet output = 1 (API list-price
 * ratios): Opus/Fable ×5/3, Haiku ×1/3; input 0.2, cache-create 0.25,
 * cache-read 0.02 of an output token. They are fixed in this phase; the fitted
 * `k` absorbs the account's overall scale.
 *
 * All windows use each account's OWN reset times (tech's week is Sat→Sat,
 * personal's Mon→Mon) — never a shared week.
 */
import { AccountUsageModel, AccountReadingModel, AccountAssetModel, isConnected } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedUpdateOne } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'account-usage-store' });

export const MAX_BUCKETS_PER_CALL = 5000;
export const MAX_READINGS_PER_CALL = 200;
export const MAX_ASSETS_PER_CALL = 50;
export const LOOKBACK_DAYS = 14;
export const FRESH_READING_MS = 15 * 60_000;
export const HOT_READING_MS = 30 * 60_000;
export const FIVE_HOURS_MS = 5 * 3_600_000;
export const SEVEN_DAYS_MS = 7 * 86_400_000;
export const DEFAULT_RESERVE_WEEKLY = 0.33;
export const DEFAULT_RESERVE_FIVE_HOUR = 0.40;
/** Start nudging to spend expiring cloud-session credit this many days ahead —
 *  enough runway to actually route a few big builds to a cloud session. */
export const CLOUD_CREDIT_NUDGE_DAYS = 45;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ASSET_KINDS = ['full_reset', 'cloud_credit', 'spend_flag'] as const;
const SOURCES = ['statusline', 'agy', 'operator'] as const;

export class AccountUsageValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'AccountUsageValidationError'; }
}

// ── shapes ────────────────────────────────────────────────────────────────
export interface UsageBucket {
  account: string; host: string; hour: Date; model: string;
  output: number; input: number; cacheCreate: number; cacheRead: number;
}
export interface UsageReading {
  account: string; host: string; source: typeof SOURCES[number]; at: Date;
  fiveHourPct?: number; fiveHourResetsAt?: Date;
  sevenDayPct?: number; sevenDayResetsAt?: Date;
  fablePct?: number; opusPct?: number; note?: string;
}
export interface UsageAsset {
  account: string; kind: typeof ASSET_KINDS[number];
  usd?: number; expires?: Date; active: boolean; note?: string;
}

// ── weights ───────────────────────────────────────────────────────────────
export const TYPE_WEIGHTS = { output: 1, input: 0.2, cacheCreate: 0.25, cacheRead: 0.02 } as const;
export function modelFamily(model: string): 'opus' | 'fable' | 'sonnet' | 'haiku' | 'other' {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('fable')) return 'fable';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}
export const FAMILY_WEIGHTS: Record<ReturnType<typeof modelFamily>, number> = {
  opus: 5 / 3, fable: 5 / 3, sonnet: 1, haiku: 1 / 3, other: 1,
};
export function weightOf(b: Pick<UsageBucket, 'model' | 'output' | 'input' | 'cacheCreate' | 'cacheRead'>): number {
  const t = b.output * TYPE_WEIGHTS.output + b.input * TYPE_WEIGHTS.input
    + b.cacheCreate * TYPE_WEIGHTS.cacheCreate + b.cacheRead * TYPE_WEIGHTS.cacheRead;
  return t * FAMILY_WEIGHTS[modelFamily(b.model)];
}

export interface TokenTotals { output: number; input: number; cacheCreate: number; cacheRead: number; weighted: number }
const zero = (): TokenTotals => ({ output: 0, input: 0, cacheCreate: 0, cacheRead: 0, weighted: 0 });

/** Sum buckets whose hour falls in [from, to). Hour granularity: a bucket counts
 *  when its hour START lies in the window — fine for 5h/7d windows. */
export function sumWindow(buckets: UsageBucket[], from: number, to: number): TokenTotals {
  const t = zero();
  for (const b of buckets) {
    const h = b.hour.getTime();
    if (h < from || h >= to) continue;
    t.output += b.output; t.input += b.input; t.cacheCreate += b.cacheCreate; t.cacheRead += b.cacheRead;
    t.weighted += weightOf(b);
  }
  return t;
}

// ── calibration ───────────────────────────────────────────────────────────
type Win = 'fiveHour' | 'sevenDay';
/** The window a reading's percentage covers: [resetsAt − length, at]. */
export function windowStart(r: UsageReading, win: Win): number {
  const len = win === 'fiveHour' ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
  const resets = win === 'fiveHour' ? r.fiveHourResetsAt : r.sevenDayResetsAt;
  return resets ? resets.getTime() - len : r.at.getTime() - len;
}

export interface Fit { k: number | null; capacity: number | null; n: number }
/** Least squares through the origin: pct ≈ k · weighted → k = Σxy / Σx². */
export function fitScale(buckets: UsageBucket[], readings: UsageReading[], win: Win): Fit {
  let sxy = 0; let sxx = 0; let n = 0;
  for (const r of readings) {
    const y = win === 'fiveHour' ? r.fiveHourPct : r.sevenDayPct;
    if (typeof y !== 'number' || r.source === 'agy') continue;
    const x = sumWindow(buckets, windowStart(r, win), r.at.getTime() + 1).weighted;
    if (x <= 0) continue;
    sxy += x * y; sxx += x * x; n++;
  }
  if (n === 0 || sxx === 0) return { k: null, capacity: null, n };
  const k = sxy / sxx;
  return { k, capacity: k > 0 ? 100 / k : null, n };
}

// ── per-account status ────────────────────────────────────────────────────
export interface WindowStatus {
  pct: number | null;
  source: 'real' | 'anchored' | 'estimate' | 'unknown';
  resetsAt: string | null;
  readingAt: string | null;
  readingHost: string | null;
}
export interface AccountStatus {
  account: string;
  fiveHour: WindowStatus;
  sevenDay: WindowStatus;
  perModel: { fablePct: number | null; opusPct: number | null; at: string | null };
  fit: { fiveHour: Fit; sevenDay: Fit };
  tokens: { last5h: TokenTotals; last7d: TokenTotals; byHost7d: Record<string, number> };
  hot: boolean;
  headroomPct: number | null;
  reserve: { weekly: number; fiveHour: number };
  assets: Array<{ kind: string; usd: number | null; expires: string | null; active: boolean; note: string | null }>;
  flags: string[];
  recommendations: string[];
}

const iso = (d?: Date | null) => (d ? d.toISOString() : null);
const round1 = (x: number) => Math.round(x * 10) / 10;

function windowStatus(buckets: UsageBucket[], readings: UsageReading[], win: Win, fit: Fit, now: number): WindowStatus {
  const len = win === 'fiveHour' ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
  const pctOf = (r: UsageReading) => (win === 'fiveHour' ? r.fiveHourPct : r.sevenDayPct);
  const resetsOf = (r: UsageReading) => (win === 'fiveHour' ? r.fiveHourResetsAt : r.sevenDayResetsAt);
  const latest = readings
    .filter(r => typeof pctOf(r) === 'number')
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const base = { readingAt: iso(latest?.at), readingHost: latest?.host ?? null };
  if (latest) {
    const resets = resetsOf(latest);
    const stillSameWindow = !resets || now < resets.getTime();
    if (stillSameWindow) {
      if (now - latest.at.getTime() <= FRESH_READING_MS) {
        return { pct: pctOf(latest)!, source: 'real', resetsAt: iso(resets), ...base };
      }
      if (fit.k !== null) {
        const since = sumWindow(buckets, latest.at.getTime() + 1, now + 1).weighted;
        return { pct: round1(Math.min(100, pctOf(latest)! + fit.k * since)), source: 'anchored', resetsAt: iso(resets), ...base };
      }
      return { pct: pctOf(latest)!, source: 'anchored', resetsAt: iso(resets), ...base };
    }
    // The reading's window has reset: the new window started at `resets`
    // (rolled forward by whole windows if several passed).
    let start = resets!.getTime();
    while (start + len <= now) start += len;
    if (fit.k !== null) {
      const used = sumWindow(buckets, start, now + 1).weighted;
      return { pct: round1(Math.min(100, fit.k * used)), source: 'estimate', resetsAt: new Date(start + len).toISOString(), ...base };
    }
    return { pct: null, source: 'unknown', resetsAt: new Date(start + len).toISOString(), ...base };
  }
  if (fit.k !== null) {
    const used = sumWindow(buckets, now - len, now + 1).weighted;
    return { pct: round1(Math.min(100, fit.k * used)), source: 'estimate', resetsAt: null, ...base };
  }
  return { pct: null, source: 'unknown', resetsAt: null, ...base };
}

export interface StatusOptions { now?: number; reserveWeekly?: number; reserveFiveHour?: number }

export function computeAccountStatus(
  account: string, buckets: UsageBucket[], readings: UsageReading[], assets: UsageAsset[], opts: StatusOptions = {},
): AccountStatus {
  const now = opts.now ?? Date.now();
  const reserveWeekly = opts.reserveWeekly ?? DEFAULT_RESERVE_WEEKLY;
  const reserveFiveHour = opts.reserveFiveHour ?? DEFAULT_RESERVE_FIVE_HOUR;
  const fit = { fiveHour: fitScale(buckets, readings, 'fiveHour'), sevenDay: fitScale(buckets, readings, 'sevenDay') };
  const fiveHour = windowStatus(buckets, readings, 'fiveHour', fit.fiveHour, now);
  const sevenDay = windowStatus(buckets, readings, 'sevenDay', fit.sevenDay, now);

  const op = readings.filter(r => r.source === 'operator' && (typeof r.fablePct === 'number' || typeof r.opusPct === 'number'))
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const byHost7d: Record<string, number> = {};
  for (const b of buckets) {
    if (b.hour.getTime() >= now - SEVEN_DAYS_MS) byHost7d[b.host] = Math.round((byHost7d[b.host] ?? 0) + weightOf(b));
  }
  // HOT = an interactive session for this account refreshed its statusLine
  // recently (only interactive sessions run a statusLine) → leave it alone.
  const hot = readings.some(r => r.source === 'statusline' && now - r.at.getTime() <= HOT_READING_MS);

  let headroomPct: number | null = null;
  if (fiveHour.pct !== null && sevenDay.pct !== null) {
    headroomPct = round1(Math.min(100 * (1 - reserveWeekly) - sevenDay.pct, 100 * (1 - reserveFiveHour) - fiveHour.pct));
  }

  const flags: string[] = [];
  const recommendations: string[] = [];
  const day = 86_400_000;
  for (const a of assets.filter(x => x.active)) {
    const left = a.expires ? Math.ceil((a.expires.getTime() - now) / day) : null;
    if (a.kind === 'spend_flag') {
      flags.push(`Usage credits ON with NO monthly limit${a.note ? ` (${a.note})` : ''} — set a monthly limit`);
    } else if (a.kind === 'full_reset' && left !== null && left >= 0) {
      if ((sevenDay.pct ?? 0) >= 90) recommendations.push(`weekly ${sevenDay.pct}% — consider the banked FULL RESET (expires in ${left}d); operator action only`);
      else if (left <= 7) recommendations.push(`banked FULL RESET expires in ${left}d and is unused — use it or lose it (operator action only)`);
    } else if (a.kind === 'cloud_credit' && left !== null && left >= 0 && (a.usd ?? 0) > 0) {
      if (left <= CLOUD_CREDIT_NUDGE_DAYS) recommendations.push(`US$${a.usd} cloud-session credit expires in ${left}d — route a big self-contained build to a claude.ai/code cloud session`);
    }
  }
  if (sevenDay.source === 'unknown' || fiveHour.source === 'unknown') {
    recommendations.push('no usable reading yet — open a session on this account (statusLine) or give a /usage reading');
  }

  return {
    account, fiveHour, sevenDay,
    perModel: { fablePct: op?.fablePct ?? null, opusPct: op?.opusPct ?? null, at: iso(op?.at) },
    fit,
    tokens: { last5h: sumWindow(buckets, now - FIVE_HOURS_MS, now + 1), last7d: sumWindow(buckets, now - SEVEN_DAYS_MS, now + 1), byHost7d },
    hot, headroomPct, reserve: { weekly: reserveWeekly, fiveHour: reserveFiveHour },
    assets: assets.map(a => ({ kind: a.kind, usd: a.usd ?? null, expires: iso(a.expires), active: a.active, note: a.note ?? null })),
    flags, recommendations,
  };
}

// ── validation ────────────────────────────────────────────────────────────
function name(v: unknown, field: string): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!NAME_RE.test(s)) throw new AccountUsageValidationError(`${field} must match ${NAME_RE}`);
  return s;
}
function count(v: unknown, field: string): number {
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new AccountUsageValidationError(`${field} must be a non-negative number`);
  return Math.round(n);
}
function pct(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new AccountUsageValidationError(`${field} must be 0..100`);
  return n;
}
function date(v: unknown, field: string, required = false): Date | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new AccountUsageValidationError(`${field} is required`);
    return undefined;
  }
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new AccountUsageValidationError(`${field} is not a valid date`);
  return d;
}

export function validateBucket(b: Record<string, unknown>): UsageBucket {
  const hour = date(b.hour, 'hour', true)!;
  hour.setUTCMinutes(0, 0, 0);
  const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim().slice(0, 100) : 'unknown';
  return { account: name(b.account, 'account'), host: name(b.host, 'host'), hour, model,
    output: count(b.output, 'output'), input: count(b.input, 'input'),
    cacheCreate: count(b.cacheCreate, 'cacheCreate'), cacheRead: count(b.cacheRead, 'cacheRead') };
}
export function validateReading(r: Record<string, unknown>): UsageReading {
  const source = String(r.source ?? '') as UsageReading['source'];
  if (!(SOURCES as readonly string[]).includes(source)) throw new AccountUsageValidationError(`source must be one of ${SOURCES.join('|')}`);
  const out: UsageReading = { account: name(r.account, 'account'), host: name(r.host, 'host'), source, at: date(r.at, 'at', true)!,
    fiveHourPct: pct(r.fiveHourPct, 'fiveHourPct'), fiveHourResetsAt: date(r.fiveHourResetsAt, 'fiveHourResetsAt'),
    sevenDayPct: pct(r.sevenDayPct, 'sevenDayPct'), sevenDayResetsAt: date(r.sevenDayResetsAt, 'sevenDayResetsAt'),
    fablePct: pct(r.fablePct, 'fablePct'), opusPct: pct(r.opusPct, 'opusPct'),
    note: typeof r.note === 'string' ? r.note.slice(0, 300) : undefined };
  if ([out.fiveHourPct, out.sevenDayPct, out.fablePct, out.opusPct].every(v => v === undefined)) {
    throw new AccountUsageValidationError('a reading needs at least one percentage');
  }
  return out;
}
export function validateAsset(a: Record<string, unknown>): UsageAsset {
  const kind = String(a.kind ?? '') as UsageAsset['kind'];
  if (!(ASSET_KINDS as readonly string[]).includes(kind)) throw new AccountUsageValidationError(`kind must be one of ${ASSET_KINDS.join('|')}`);
  const usd = a.usd === undefined || a.usd === null ? undefined : count(a.usd, 'usd');
  return { account: name(a.account, 'account'), kind, usd, expires: date(a.expires, 'expires'),
    active: a.active === undefined ? true : a.active === true || a.active === 'true',
    note: typeof a.note === 'string' ? a.note.slice(0, 300) : undefined };
}

// ── I/O ───────────────────────────────────────────────────────────────────
export interface RecordInput { buckets?: unknown[]; readings?: unknown[]; assets?: unknown[] }
export interface RecordResult { buckets: number; readings: number; assets: number; connected: boolean }

export async function recordAccountUsage(tenantId: string, input: RecordInput): Promise<RecordResult> {
  const buckets = (input.buckets ?? []).map(b => validateBucket(b as Record<string, unknown>));
  const readings = (input.readings ?? []).map(r => validateReading(r as Record<string, unknown>));
  const assets = (input.assets ?? []).map(a => validateAsset(a as Record<string, unknown>));
  if (buckets.length > MAX_BUCKETS_PER_CALL) throw new AccountUsageValidationError(`at most ${MAX_BUCKETS_PER_CALL} buckets per call`);
  if (readings.length > MAX_READINGS_PER_CALL) throw new AccountUsageValidationError(`at most ${MAX_READINGS_PER_CALL} readings per call`);
  if (assets.length > MAX_ASSETS_PER_CALL) throw new AccountUsageValidationError(`at most ${MAX_ASSETS_PER_CALL} assets per call`);
  if (!isConnected()) return { buckets: 0, readings: 0, assets: 0, connected: false };
  // SET, never $inc: each push carries the full recomputed hour → idempotent.
  for (const b of buckets) {
    await scopedUpdateOne(AccountUsageModel, tenantId,
      { account: b.account, host: b.host, hour: b.hour, modelId: b.model },
      { $set: { output: b.output, input: b.input, cacheCreate: b.cacheCreate, cacheRead: b.cacheRead } }, { upsert: true });
  }
  for (const r of readings) {
    const { account, host, source, at, ...rest } = r;
    await scopedUpdateOne(AccountReadingModel, tenantId, { account, host, source, at }, { $set: rest }, { upsert: true });
  }
  for (const a of assets) {
    const { account, kind, ...rest } = a;
    await scopedUpdateOne(AccountAssetModel, tenantId, { account, kind }, { $set: rest }, { upsert: true });
  }
  log.info({ tenantId, buckets: buckets.length, readings: readings.length, assets: assets.length }, 'account usage recorded');
  return { buckets: buckets.length, readings: readings.length, assets: assets.length, connected: true };
}

export async function getAccountUsageStatus(
  tenantId: string, opts: StatusOptions & { account?: string } = {},
): Promise<{ accounts: AccountStatus[]; weights: { type: typeof TYPE_WEIGHTS; family: typeof FAMILY_WEIGHTS }; connected: boolean }> {
  const weights = { type: TYPE_WEIGHTS, family: FAMILY_WEIGHTS };
  if (!isConnected()) return { accounts: [], weights, connected: false };
  const now = opts.now ?? Date.now();
  const since = new Date(now - LOOKBACK_DAYS * 86_400_000);
  const acct = opts.account ? { account: name(opts.account, 'account') } : {};
  const [buckets, readings, assets] = await Promise.all([
    scopedFind(AccountUsageModel, tenantId, { ...acct, hour: { $gte: since } }).lean(),
    scopedFind(AccountReadingModel, tenantId, { ...acct, at: { $gte: since } }).lean(),
    scopedFind(AccountAssetModel, tenantId, acct).lean(),
  ]) as unknown as [UsageBucket[], UsageReading[], UsageAsset[]];
  const names = new Set<string>([...buckets, ...readings, ...assets].map(d => d.account));
  const toDate = <T extends object>(d: T, keys: string[]) => {
    const o = { ...d } as Record<string, unknown>;
    for (const k of keys) if (o[k] && !(o[k] instanceof Date)) o[k] = new Date(o[k] as string);
    return o as unknown as T;
  };
  // Stored as modelId (mongoose Document#model collides); the API says `model`.
  const B = buckets.map(b => {
    const o = toDate(b, ['hour']) as UsageBucket & { modelId?: string };
    return { ...o, model: o.model ?? o.modelId ?? 'unknown' };
  });
  const R = readings.map(r => toDate(r, ['at', 'fiveHourResetsAt', 'sevenDayResetsAt']));
  const A = assets.map(a => toDate(a, ['expires']));
  const accounts = [...names].sort().map(n => computeAccountStatus(n,
    B.filter(b => b.account === n), R.filter(r => r.account === n), A.filter(a => a.account === n), { ...opts, now }));
  return { accounts, weights, connected: true };
}

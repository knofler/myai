/**
 * atlas-index-health-alerter — alerts when the Atlas Vector Search index
 * self-heal keeps landing on a non-'ok' outcome, boot after boot.
 *
 * `ensureAtlasVectorSearchIndex()` (memory/atlas-search-index.ts, the PR #390
 * empty-recall fix) silently self-heals the `vectors` Atlas Search index on
 * every gateway boot, returning one of: created / updated / recreated / ok /
 * skipped / failed. A ONE-TIME created/updated/recreated (first boot ever, or
 * Atlas UI drift repaired) is expected and healthy: the self-heal did its
 * job and the next boot should see 'ok'. The SAME non-'ok' outcome firing on
 * every boot in a row means something is actively fighting the index
 * definition — an M0 tier silently dropping the index, two gateway replicas
 * racing on `createSearchIndex`, a bad migration, manual Atlas UI drift being
 * reapplied — and today that produces nothing but a boot-time log line
 * nobody watches.
 *
 * This module counts consecutive boots whose `ensureAtlasVectorSearchIndex()`
 * result was NOT 'ok' or 'skipped' (i.e. created/updated/recreated/failed —
 * 'skipped' means the backend isn't Atlas, a normal non-incident state) and
 * fires an alert once the streak reaches
 * `MYAI_ATLAS_INDEX_NONOK_ALERT_THRESHOLD` (default 3) consecutive boots —
 * reusing pool-capacity-alerter's delivery (Telegram + emitNotifyEvent
 * dashboard bell/toast + durable history).
 *
 * Cross-boot memory: unlike pool-capacity-alerter's in-memory dedup Map (that
 * module runs on a live interval within one long-lived process), this counter
 * MUST survive process restarts — the whole point is spotting a pattern
 * across separate boots. State is persisted in Mongo
 * (AtlasIndexHealthStateModel, shared/db.ts) rather than kept in-process.
 *
 * Dedup: "fixed it once" vs "something keeps breaking it" — a boot whose
 * action IS 'ok' or 'skipped' resets the streak to zero and re-arms the
 * alert; the alert itself fires exactly once per streak (once per incident),
 * not once per boot, even if the streak keeps growing past the threshold.
 */
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { getAdapter } from '../channels/registry.js';
import { AtlasIndexHealthStateModel, DEFAULT_TENANT_ID, isConnected } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import type { EnsureVectorIndexResult } from '../memory/atlas-search-index.js';

const log = createChildLogger({ module: 'atlas-index-health-alerter' });

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Consecutive non-ok boots before the alert fires (default 3). */
export function atlasIndexNonOkAlertThreshold(): number {
  return envNum('MYAI_ATLAS_INDEX_NONOK_ALERT_THRESHOLD', 3);
}

/** Actions that mean the self-heal did NOT settle on a healthy steady state this boot. */
const NON_OK_ACTIONS: ReadonlySet<EnsureVectorIndexResult['action']> = new Set([
  'created',
  'updated',
  'recreated',
  'failed',
]);

// ── Pure state transition (unit-testable without I/O) ───────────

export interface AtlasIndexHealthCounterState {
  consecutiveNonOk: number;
  /** Set once an alert has fired for the CURRENT streak; cleared when the streak resets. */
  alertedThisIncident: boolean;
}

export const INITIAL_ATLAS_INDEX_HEALTH_STATE: AtlasIndexHealthCounterState = {
  consecutiveNonOk: 0,
  alertedThisIncident: false,
};

export interface AtlasIndexHealthEvaluation {
  next: AtlasIndexHealthCounterState;
  shouldAlert: boolean;
}

/**
 * Fold this boot's ensureAtlasVectorSearchIndex() action into the persisted
 * streak. A boot landing on 'ok' (index already correct) or 'skipped' (not
 * an Atlas backend — a normal non-incident state, not a repair) resets the
 * streak and re-arms the alert for the next incident. Any other action
 * (created/updated/recreated/failed) means the self-heal did NOT settle this
 * boot and extends the streak; the alert fires the FIRST time the streak
 * reaches `threshold` and is suppressed for the rest of that streak.
 */
export function evaluateAtlasIndexHealth(
  prev: AtlasIndexHealthCounterState,
  action: EnsureVectorIndexResult['action'],
  threshold: number,
): AtlasIndexHealthEvaluation {
  if (!NON_OK_ACTIONS.has(action)) {
    return { next: { ...INITIAL_ATLAS_INDEX_HEALTH_STATE }, shouldAlert: false };
  }
  const consecutiveNonOk = prev.consecutiveNonOk + 1;
  const shouldAlert = consecutiveNonOk >= threshold && !prev.alertedThisIncident;
  return {
    next: { consecutiveNonOk, alertedThisIncident: prev.alertedThisIncident || shouldAlert },
    shouldAlert,
  };
}

// ── Alert dispatch ────────────────────────────────────────────

function formatAlertMessage(index: string, streak: number, threshold: number, lastAction: string): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return [
    `\u{1F6A8} Atlas Search Index — "${index}" self-heal non-ok on ${streak} consecutive boots (last: ${lastAction})`,
    `Threshold: ${threshold}`,
    '',
    'ensureAtlasVectorSearchIndex() (memory/atlas-search-index.ts) has not settled on \'ok\' for this many boots in a row — something keeps forcing a create/update/recreate repair or failing outright. Possible causes: an M0 cluster silently dropping the index, two gateway replicas racing on createSearchIndex, a bad migration, or manual Atlas UI drift being reapplied.',
    'A one-time create/update/recreate on boot is healthy self-heal; this many consecutive non-ok boots is not.',
    `Detected at ${timestamp} UTC`,
  ].join('\n');
}

async function sendTelegram(index: string, streak: number, threshold: number, lastAction: string): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ index }, 'No enabled Telegram adapter — Atlas index health alert not sent to Telegram');
    return false;
  }
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ index }, 'TELEGRAM_DEFAULT_CHAT not set — Atlas index health alert not sent to Telegram');
    return false;
  }
  try {
    await telegram.send(chatId, formatAlertMessage(index, streak, threshold, lastAction));
    return true;
  } catch (err) {
    log.error({ index, err }, 'Failed to send Atlas index health Telegram alert');
    return false;
  }
}

// ── Boot-time check runner ────────────────────────────────────

export interface AtlasIndexHealthCheckResult extends AtlasIndexHealthEvaluation {
  telegramSent: boolean;
}

/**
 * Load the persisted streak for `result.index`, fold in this boot's action,
 * persist the updated streak, and — exactly once per incident — fire the
 * alert (dashboard bell/toast + Telegram). Never throws: a DB hiccup means
 * this boot has no cross-boot memory (returns null), same non-fatal posture
 * as ensureAtlasVectorSearchIndex() itself.
 */
export async function checkAtlasIndexHealth(
  result: Pick<EnsureVectorIndexResult, 'action' | 'index'>,
): Promise<AtlasIndexHealthCheckResult | null> {
  const threshold = atlasIndexNonOkAlertThreshold();
  try {
    if (!isConnected()) return null;

    const doc = await AtlasIndexHealthStateModel.findOne({ index: result.index });
    const prev: AtlasIndexHealthCounterState = doc
      ? { consecutiveNonOk: doc.consecutiveNonOk, alertedThisIncident: doc.alertedThisIncident }
      : INITIAL_ATLAS_INDEX_HEALTH_STATE;

    const evaluation = evaluateAtlasIndexHealth(prev, result.action, threshold);

    await AtlasIndexHealthStateModel.findOneAndUpdate(
      { index: result.index },
      {
        $set: {
          consecutiveNonOk: evaluation.next.consecutiveNonOk,
          alertedThisIncident: evaluation.next.alertedThisIncident,
          lastAction: result.action,
        },
      },
      { upsert: true },
    );

    let telegramSent = false;
    if (evaluation.shouldAlert) {
      const streak = evaluation.next.consecutiveNonOk;

      // Dashboard bell/toast + durable history — in-process, always lands.
      emitNotifyEvent({
        type: 'runner.atlas_index_repeat_nonok',
        tenantId: DEFAULT_TENANT_ID,
        title: `Atlas index "${result.index}" non-ok (${result.action}) ${streak}x in a row`,
        message: formatAlertMessage(result.index, streak, threshold, result.action),
        level: 'critical',
        source: 'atlas-index-health-alerter',
        data: { index: result.index, consecutiveNonOk: streak, threshold, lastAction: result.action },
      });

      telegramSent = await sendTelegram(result.index, streak, threshold, result.action);
      log.warn({ index: result.index, streak, threshold, action: result.action }, 'Atlas index repeated-non-ok alert fired');
    }

    return { ...evaluation, telegramSent };
  } catch (err) {
    log.warn({ err, index: result.index }, 'Atlas index health check failed (suppressed)');
    return null;
  }
}

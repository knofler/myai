import { loadConfig, setConfig } from '../shared/config.js';
import { validateAndLog } from '../shared/config-validator.js';
import { getLogger } from '../shared/logger.js';
import { connectDB, recordMongoBootFailure, redactMongoUri, DEFAULT_TENANT_ID } from '../shared/db.js';
import { seedReposFromManagedFile, seedReposFromRepoCards } from '../repos/repo-registry.js';
import { ensureDefaultTenant } from './tenant-keys.js';
import { ensureBootstrapAdmin } from './user-auth.js';
import { loadAgents, loadSkills, syncToDatabase, getAgentCount, getSkillCount } from '../agents/loader.js';
import { registerWorkspaceCleanupHook } from '../agents/workspace.js';
import { createHttpServer, startHttpServer } from './server.js';
import { startWsServer } from '../ws/handler.js';
import { loadAllHooks, syncHooksToDatabase } from '../hooks/loader.js';
import { emit, getHookCount } from '../hooks/event-bus.js';
import { loadRules, syncRulesToDatabase, getRuleCount } from '../rules/loader.js';
import { migratePatterns, indexEmbeddings, indexAgentSkillEmbeddings } from '../memory/migrator.js';
import { runMigrations } from '../shared/migration-runner.js';
import { registerAdapter, getAdapter, stopChannels } from '../channels/registry.js';
import { TelegramAdapter } from '../channels/telegram.js';
import { DiscordAdapter } from '../channels/discord.js';
import { startHostControl, stopHostControl } from '../channels/host-control.js';
import { initProvider } from '../llm/provider.js';
import { startMcpServer } from '../mcp/handler.js';
import { indexMasterRepo } from '../memory/indexer.js';
import { ensureAtlasVectorSearchIndex } from '../memory/atlas-search-index.js';
import { checkAtlasIndexHealth } from '../monitoring/atlas-index-health-alerter.js';
import { startScheduler, stopScheduler } from '../scheduler/scheduler.js';
import { startWebhookDispatcher, stopWebhookDispatcher } from '../webhooks/webhook-dispatcher.js';
import { startOAuthRefreshWorker, stopOAuthRefreshWorker } from '../connectors/oauth-refresh-worker.js';
import { seedDefaultSchedules } from '../scheduler/seed-schedules.js';
import { startHealthAlerts, stopHealthAlerts } from '../monitoring/health-alerter.js';
import { startSloAlerts, stopSloAlerts } from '../monitoring/slo-alerter.js';
import { startQueueWaitAlerts, stopQueueWaitAlerts } from '../monitoring/queue-wait-alerter.js';
import { startPriorityAgingSweep, stopPriorityAgingSweep } from '../tasks/priority-aging.js';
import { startSecurityAnomalyAlerts, stopSecurityAnomalyAlerts } from '../monitoring/security-anomaly-alerter.js';
import { startPoolCapacityAlerts, stopPoolCapacityAlerts } from '../monitoring/pool-capacity-alerter.js';
import { startPoolCapacityDriftAlerts, stopPoolCapacityDriftAlerts } from '../monitoring/pool-capacity-drift-alerter.js';
import { startMongoMirrorAlerts, stopMongoMirrorAlerts } from '../monitoring/mongo-mirror-alerter.js';
import { startDockerVmDiskAlerts, stopDockerVmDiskAlerts } from '../monitoring/docker-vm-disk-alerter.js';
import { startBudgetReconciliation, stopBudgetReconciliation } from '../monitoring/budget-reconciliation.js';
import { initSentry, flushSentry } from '../monitoring/sentry.js';

const startTime = Date.now();

export async function bootstrap(configPath?: string): Promise<void> {
  // Load configuration
  const config = loadConfig(configPath);
  setConfig(config);

  const log = getLogger();
  log.info('Starting myAI gateway...');

  // Error tracking — opt-in via SENTRY_DSN, PII-scrubbed. No-op when unset.
  await initSentry();

  // Fail closed: a hard config-validation error (not a warning) means the
  // gateway would start in a broken/unsafe state, so abort startup instead.
  // Warnings are logged and tolerated.
  if (!validateAndLog(config)) {
    throw new Error('Config validation failed — aborting startup (see logged errors above).');
  }

  // Connect to MongoDB
  try {
    await connectDB();
    // ADR-010 §5 step 11 — seed the `default` tenant so DEFAULT_TENANT_ID always
    // has a Tenant row (single-operator local use under TENANT_ENFORCE=false).
    // Idempotent: no-op when the row already exists, never overwrites its key.
    try {
      await ensureDefaultTenant(config.tenancy.defaultTenantId);
      log.info({ tenantId: config.tenancy.defaultTenantId }, 'Default tenant ensured');
    } catch (err) {
      log.warn({ err }, 'Default-tenant seed failed — continuing (enforce=false default still works)');
    }
    // Anti-lockout: seed/re-sync the bootstrap admin from ADMIN_EMAIL/ADMIN_PASSWORD
    // so a login-walled (hosted) deployment always has a known operator account.
    // No-op when those env vars are unset (local dev relies on loopback trust).
    try {
      await ensureBootstrapAdmin();
    } catch (err) {
      log.warn({ err }, 'Bootstrap-admin seed failed — continuing (loopback access still works)');
    }
  } catch (err) {
    // Loud and specific on purpose (LL 2026-07-04-gateway-ciworkspace-splitbrain /
    // the 2026-07-06 localhost:27017-misdirection incident): a quiet one-line
    // warn with the error discarded is exactly how a misdirected MONGODB_URI
    // ran undetected for weeks. error-level + the redacted host lets a log
    // scan catch it immediately, and getMongoBootFailure() keeps it visible
    // on /health/deep long after this line has scrolled by.
    recordMongoBootFailure(err as Error, config.database.uri);
    log.error(
      { err, mongoUriHost: redactMongoUri(config.database.uri) },
      'BOOT CHECK FAILED: MongoDB unreachable at startup — gateway running WITHOUT persistence. ' +
        'Verify MONGODB_URI points at the compose service host (e.g. "mongo"), not "localhost".',
    );
  }

  // Idempotent startup migration runner (deploy self-heal): applies any
  // pending migration exactly once, tracked in MigrationRecordModel. No-ops
  // when Mongo didn't connect above. /readyz gates on the result so a deploy
  // never serves traffic mid-migration or after a failed one.
  try {
    const migrationStatus = await runMigrations();
    if (migrationStatus.allApplied) {
      log.info({ applied: migrationStatus.applied }, 'Startup migrations applied');
    } else {
      log.error({ status: migrationStatus }, 'Startup migrations incomplete — /readyz will report not-ready until resolved');
    }
  } catch (err) {
    log.error({ err }, 'Startup migration runner threw — /readyz will report not-ready until resolved');
  }

  // Load agents and skills from AI root (file → memory)
  loadAgents();
  loadSkills();
  log.info({ agents: getAgentCount(), skills: getSkillCount(), aiRoot: config.aiRoot }, 'Framework loaded');

  // Load hooks (built-in TypeScript + legacy bash)
  loadAllHooks();
  // Phase 6 agent runtime: remove a session's scratch workspace on session:end.
  registerWorkspaceCleanupHook();
  log.info({ hooks: getHookCount() }, 'Hooks loaded');

  // Load rules (documentation, governance, routing)
  loadRules();
  log.info({ rules: getRuleCount() }, 'Rules loaded');

  // Sync everything to MongoDB
  try {
    const agentSkillSync = await syncToDatabase();
    log.info(agentSkillSync, 'Agents/skills synced to MongoDB');

    const hookSync = await syncHooksToDatabase();
    log.info({ hooks: hookSync }, 'Hooks synced to MongoDB');

    const ruleSync = await syncRulesToDatabase();
    log.info({ rules: ruleSync }, 'Rules synced to MongoDB');
  } catch (err) {
    log.warn({ err }, 'MongoDB sync failed — serving from memory only');
  }

  // ADR-021: seed the repos roster (DB) from managed_repos.txt for the default
  // tenant. Idempotent + insert-only, so it's safe on every boot; non-fatal.
  try {
    const repoSeed = await seedReposFromManagedFile(DEFAULT_TENANT_ID);
    if (repoSeed.seeded > 0) log.info(repoSeed, 'Repos roster seeded from managed_repos.txt');
  } catch (err) {
    log.warn({ err }, 'Repos roster seed failed — continuing (txt seed still served via union)');
  }

  // ADR-021 Phase 2 tail: also seed repocards-only repos (e.g. EXO) that have
  // no counterpart in managed_repos.txt. Idempotent + insert-only; non-fatal.
  try {
    const cardSeed = await seedReposFromRepoCards(DEFAULT_TENANT_ID);
    if (cardSeed.seeded > 0) log.info(cardSeed, 'Repos roster seeded from repocards (card-only repos)');
  } catch (err) {
    log.warn({ err }, 'Repocards roster seed failed — continuing');
  }

  // Self-heal the Atlas Vector Search index (root cause of the PR #390 empty
  // recall): create/repair `vector_index` on `vectors` so it survives cluster
  // rebuilds. No-op on local mongo; non-fatal — the embedded-ANN fallback in
  // vector-store.ts keeps recall alive either way.
  try {
    const vectorIndex = await ensureAtlasVectorSearchIndex();
    if (vectorIndex.action !== 'ok' && vectorIndex.action !== 'skipped') {
      log.info(vectorIndex, 'Atlas vector search index ensured');
    }
    // Reliability: alert (Telegram + dashboard bell) when the self-heal keeps
    // landing on a non-'ok' outcome (created/updated/recreated/failed) across
    // repeated consecutive boots — a one-time repair is healthy, a repeated
    // one means something keeps fighting the index definition (e.g. an M0
    // tier silently dropping it, or replicas racing on createSearchIndex).
    // Non-fatal; never blocks boot.
    await checkAtlasIndexHealth(vectorIndex);
  } catch (err) {
    log.warn({ err }, 'Atlas vector index ensure threw — continuing on the embedded-ANN fallback');
  }

  // Migrate SONA patterns from file → MongoDB and index embeddings
  try {
    const migration = await migratePatterns();
    if (migration.migrated > 0) log.info(migration, 'Patterns migrated');
    const indexing = await indexEmbeddings();
    if (indexing.indexed > 0) log.info(indexing, 'Pattern embeddings indexed');
    const asIndexing = await indexAgentSkillEmbeddings();
    if (asIndexing.indexed > 0) log.info(asIndexing, 'Agent/skill embeddings indexed');
  } catch (err) {
    log.warn({ err }, 'Memory migration/indexing failed — continuing without');
  }

  // Index master repo state files into vectors (non-blocking)
  indexMasterRepo().catch(err => log.warn({ err }, 'Master repo indexing failed — continuing without'));

  // Initialize LLM provider (API key, bridge, or CLI)
  initProvider();

  // Start HTTP server. The shutdown callback below runs only AFTER the HTTP
  // server has stopped accepting new connections and drained every in-flight
  // request (see startHttpServer) — background workers must not disappear out
  // from under a request still being served.
  const app = createHttpServer();
  startHttpServer(app, async (signal) => {
    log.info('HTTP server drained — stopping background workers...');
    stopScheduler();
    stopHealthAlerts();
    stopSloAlerts();
    stopQueueWaitAlerts();
    stopPoolCapacityAlerts();
    stopPoolCapacityDriftAlerts();
    stopMongoMirrorAlerts();
    stopDockerVmDiskAlerts();
    stopPriorityAgingSweep();
    stopSecurityAnomalyAlerts();
    stopBudgetReconciliation();
    stopWebhookDispatcher();
    stopOAuthRefreshWorker();
    stopHostControl();
    await stopChannels();
    await emit('session:end', { metadata: { signal } });
    await flushSentry();
  });

  // Start MCP server (port 3100 — Streamable HTTP for Claude Code)
  const mcpPort = Number(process.env.MCP_PORT) || 3100;
  startMcpServer(mcpPort, config.server.host);

  // Start WebSocket server
  startWsServer();

  // Register messaging channels (Telegram, Discord)
  registerAdapter(new TelegramAdapter(config.channels.telegram));
  registerAdapter(new DiscordAdapter(config.channels.discord));

  // Telegram: use host control (file-based) to decide which machine polls.
  // Only start non-Telegram channels here; Telegram is managed by host-control.
  if (config.channels.discord.enabled) {
    const discord = getAdapter('discord');
    if (discord) await discord.start().catch(err => log.error({ err }, 'Discord start failed'));
  }
  startHostControl();

  // Phase 3: Autonomous scheduler — ticks every minute, dispatches due schedules
  // via agents_invoke/skills_invoke MCP tools. Disabled when SCHEDULER_DISABLED=1.
  if (process.env.SCHEDULER_DISABLED !== '1') {
    startScheduler();
    // Opt-in boot seeding: a fresh gateway comes up with the standard
    // schedules (morning/evening sweeps) already live. Default off — seeded
    // schedules invoke agents daily and consume the shared token budget.
    if (process.env.SEED_SCHEDULES_ON_BOOT === '1') {
      seedDefaultSchedules()
        .then(r => log.info(r, 'Default schedules seeded on boot'))
        .catch(err => log.warn({ err }, 'Boot schedule seeding failed — continuing'));
    }
  } else {
    log.info('Scheduler disabled by SCHEDULER_DISABLED=1');
  }

  // Phase 4: Proactive health alerting — runs comprehensive checks every 30min
  // and sends Telegram alerts on degraded/unhealthy state. Disabled when
  // HEALTH_ALERTS_DISABLED=1.
  if (process.env.HEALTH_ALERTS_DISABLED !== '1') {
    startHealthAlerts();
  } else {
    log.info('Health alerts disabled by HEALTH_ALERTS_DISABLED=1');
  }

  // Per-route SLO alerting — evaluates the live perf meter (p95 latency +
  // windowed error rate) every 5min and fires cooldown-guarded Telegram alerts
  // on breach. Complements the hot-path perf metric. Disable with SLO_ALERTS_DISABLED=1.
  if (process.env.SLO_ALERTS_DISABLED !== '1') {
    startSloAlerts();
  } else {
    log.info('SLO alerts disabled by SLO_ALERTS_DISABLED=1');
  }

  // Queue-wait starvation SLO — pre-claim enqueue→claim latency per priority.
  // Alerts when a pending P0/P1 task waits beyond its SLO budget with no
  // runner claiming it. Distinct from age-based priority auto-escalation
  // (tasks/priority-aging.ts) and the stale-review reminder. Disable with
  // QUEUE_WAIT_ALERTS_DISABLED=1.
  if (process.env.QUEUE_WAIT_ALERTS_DISABLED !== '1') {
    startQueueWaitAlerts();
  } else {
    log.info('Queue-wait alerts disabled by QUEUE_WAIT_ALERTS_DISABLED=1');
  }

  // Subscription-pool capacity floor — watches state/pool-capacity.json (the
  // runner-budget/pacing-ledger bridge artifact) and pushes a Telegram +
  // dashboard-bell alert when a pool's weekly remaining budget crosses the
  // configured threshold. The operator's OWN pool — distinct from the
  // per-tenant spend alert (llm/spend-alert.ts). Disable with
  // POOL_CAPACITY_ALERTS_DISABLED=1.
  if (process.env.POOL_CAPACITY_ALERTS_DISABLED !== '1') {
    startPoolCapacityAlerts();
  } else {
    log.info('Pool-capacity alerts disabled by POOL_CAPACITY_ALERTS_DISABLED=1');
  }

  // Pool-capacity ground-truth drift self-check (task-0824a68e) alert bridge
  // (task-05526048) — watches state/pool-capacity-drift-status.json (the
  // pool_capacity_drift_check.sh bridge artifact) and pushes the same
  // Telegram + dashboard-bell alert as the pool-capacity floor check above
  // when the incremental ledger disagrees with a fresh transcript re-derive
  // beyond tolerance, instead of that only ever reaching
  // ~/.ai-cli-runner/pool-capacity-drift.log. Disable with
  // POOL_CAPACITY_DRIFT_ALERTS_DISABLED=1.
  if (process.env.POOL_CAPACITY_DRIFT_ALERTS_DISABLED !== '1') {
    startPoolCapacityDriftAlerts();
  } else {
    log.info('Pool-capacity-drift alerts disabled by POOL_CAPACITY_DRIFT_ALERTS_DISABLED=1');
  }

  // Mongo-mirror schedule health — watches state/mongo-mirror-status.json (the
  // $MYAI_HOME/mongo-mirror.last + schedule-install bridge artifact) and
  // pushes a Telegram + dashboard-bell alert when the scheduled Atlas→local
  // mirror's last run failed or the schedule looks stale, instead of that
  // only being visible via an on-demand `myai doctor` run (task-906c973f).
  // Disable with MONGO_MIRROR_ALERTS_DISABLED=1.
  if (process.env.MONGO_MIRROR_ALERTS_DISABLED !== '1') {
    startMongoMirrorAlerts();
  } else {
    log.info('Mongo-mirror alerts disabled by MONGO_MIRROR_ALERTS_DISABLED=1');
  }

  // Docker VM disk-pressure guard — watches state/docker-vm-disk-status.json
  // (the `docker run --rm alpine df -P /` bridge artifact) and pushes a
  // Telegram + dashboard-bell alert before usage reaches RUNBOOK.md #1's
  // documented WT_PANIC crash-loop threshold, instead of that only being
  // caught after myai-mongo is already crash-looping. Disable with
  // DOCKER_VM_DISK_ALERTS_DISABLED=1.
  if (process.env.DOCKER_VM_DISK_ALERTS_DISABLED !== '1') {
    startDockerVmDiskAlerts();
  } else {
    log.info('Docker-vm-disk alerts disabled by DOCKER_VM_DISK_ALERTS_DISABLED=1');
  }

  // Age-based priority auto-escalation (tasks/priority-aging.ts) — bumps a
  // pending task's priority the longer it waits (config-driven hours curve),
  // so nothing starves indefinitely at the bottom of the queue. Distinct from
  // the queue-wait SLO alert above (which only alerts, never mutates) and
  // from fair-share scheduling (cross-tenant). Disable with
  // PRIORITY_AGING_DISABLED=1.
  if (process.env.PRIORITY_AGING_DISABLED !== '1') {
    startPriorityAgingSweep();
  } else {
    log.info('Priority aging sweep disabled by PRIORITY_AGING_DISABLED=1');
  }

  // Security-anomaly alerting — sweeps the hash-chained audit trail every
  // 15min for impossible-travel logins, mass/bulk data exports, and
  // permission-denial bursts, raising a tenant-admin alert via the
  // notification engine. Disable with SECURITY_ANOMALY_ALERTS_DISABLED=1.
  if (process.env.SECURITY_ANOMALY_ALERTS_DISABLED !== '1') {
    startSecurityAnomalyAlerts();
  } else {
    log.info('Security anomaly alerts disabled by SECURITY_ANOMALY_ALERTS_DISABLED=1');
  }

  // Provider invoice reconciliation (Phase 5b follow-up) — once a day, diffs
  // the estimator's per-provider BudgetUsage totals for the previous closed
  // UTC day against the actual invoiced USD (manual entry or the Anthropic
  // Admin API) and alerts on drift beyond BUDGET_RECONCILE_DRIFT_PCT. Disable
  // with BUDGET_RECONCILIATION_DISABLED=1.
  if (process.env.BUDGET_RECONCILIATION_DISABLED !== '1') {
    startBudgetReconciliation();
  } else {
    log.info('Budget reconciliation disabled by BUDGET_RECONCILIATION_DISABLED=1');
  }

  // Outbound webhooks — fan lifecycle events out to tenant-registered HTTP
  // endpoints (HMAC-signed, retry + backoff + dead-letter). Inert until a
  // tenant registers an endpoint; disable with WEBHOOKS_DISABLED=1.
  startWebhookDispatcher();

  // Proactively refresh expiring connector OAuth tokens (Vercel/Dropbox) in
  // the background so a scheduled run never fails on a dead credential.
  // Escalates to a re-auth nudge only when no refresh token is on file or the
  // provider rejects it. Disable with CONNECTOR_OAUTH_REFRESH_DISABLED=1.
  startOAuthRefreshWorker();

  const elapsed = Date.now() - startTime;
  log.info({
    httpPort: config.server.httpPort,
    wsPort: config.server.wsPort,
    startupMs: elapsed,
  }, 'myAI gateway ready');

  // Fire session:start hooks
  await emit('session:start', { metadata: { startupMs: elapsed } });
}

// Graceful shutdown is wired centrally in core/shutdown.ts, registered once
// via startHttpServer()'s onDrained callback above. Do NOT register a second
// SIGTERM/SIGINT handler here — a prior version did, and the two handlers
// raced: this one called process.exit(0) as soon as its own cleanup finished,
// which could kill the process while shutdown.ts's server.close() was still
// draining in-flight HTTP requests.

// Auto-start when run directly
const isMainModule = process.argv[1]?.includes('core/index') || process.argv[1]?.includes('dist/core/index');
if (isMainModule) {
  bootstrap().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

import express from 'express';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { setupGracefulShutdown, isShutdownInProgress } from './shutdown.js';
import { isConnected, AgentModel, SkillModel, HookModel, RuleModel, DEFAULT_TENANT_ID } from '../shared/db.js';
import { listAgents, getAgent, listSkills, getSkill, getAgentCount, getSkillCount } from '../agents/loader.js';
import { executeAgent } from '../agents/runtime.js';
import { runPipeline, loadStages } from '../agents/pipeline.js';
import { listRules, getRule, getRuleCount } from '../rules/loader.js';
import { createSession, closeSession, getSession, listSessions, getSessionCount, getActiveSessionCount, exportSession, importSession, recallSessionContext } from './session-manager.js';
import type { SessionExport } from './session-manager.js';
import { routeMessage } from './message-router.js';
import { listHooks, getHookCount, enableHook } from '../hooks/event-bus.js';
import { applyHookToggle, parseBashHookName, readDisabledScripts } from '../hooks/settings-patch.js';
import { hybridSearch } from '../memory/search.js';
import { buildContext } from '../memory/context-builder.js';
import { searchVectors, getVectorCount } from '../memory/vector-store.js';
import { exportMemoryBundle, importMemoryBundle, exportVectorCorpus, importVectorCorpus, VECTOR_SOURCES } from '../memory/export-import.js';
import type { MemoryBundleManifest, MemoryBundleFile, VectorCorpusEntry } from '../memory/export-import.js';
import { indexMasterRepo, indexAllRepos } from '../memory/indexer.js';
import { listAdapters, getChannelSessionCount } from '../channels/registry.js';
import { isConfigured as isLlmConfigured } from '../llm/provider.js';
import { getBudgetStatus, getBudgetBreakdown, getBudgetUsage } from '../llm/budget-stats.js';
import { getBudgetCapSuggestions } from '../llm/budget-advisor.js';
import { getSpendAlertStatus } from '../llm/spend-alert.js';
import { summarizeUsage, getUsageBreakdown } from '../shared/usage-store.js';
import { createSchedule, updateSchedule, getSchedule, listSchedules, deleteSchedule } from '../scheduler/schedule-store.js';
import type { ListSchedulesFilter } from '../scheduler/schedule-store.js';
import { createTask, updateTask, listTasks, nextTask, countTasks, getTask } from '../tasks/task-store.js';
import type { ListTasksFilter } from '../tasks/task-store.js';
import { BulkBlockGuardError } from '../tasks/bulk-block-guard.js';
import { taskLogRelay, wrapBackpressureSafe } from '../tasks/task-log-relay.js';
import type { TaskLogChunk } from '../tasks/task-log-relay.js';
import { listRepoCards, upsertRepoCard } from '../repos/app-card-store.js';
import type { RepoCardLevel } from '../repos/app-card-store.js';
import { listPlan } from '../repos/plan-store.js';
import { writeHandoff, readHandoff, listLatestHandoffs } from '../repos/handoff-store.js';
import { computeNextRun, isValidCronExpr } from '../scheduler/scheduler.js';
import { executeTool } from '../mcp/tools.js';
import { ctxFromReq } from './auth.js';
import { hostedBrainTransportRouter } from './hosted-brain-transport.js';
import type { ScheduleKind, ScheduleStatus, TaskPriority, TaskStatus, UserRole } from '../shared/db.js';
import { deepHealthCheck } from './health.js';
import { getMigrationStatus } from '../shared/migration-runner.js';
import { getLatestHealthCheckResult, getHealthAlertStatus, runHealthCheck } from '../monitoring/health-alerter.js';
import { getUptimeStats } from '../monitoring/uptime.js';
import { applyMiddleware } from './middleware.js';
import { buildOpenApiSpec, docsHtml } from './openapi.js';
import { getSpans, getTraceIds, traceViewerHtml } from '../tracing/tracer.js';
import { getLogs, getCorrelationIds, type LogService, type LogLevel } from '../monitoring/log-store.js';
import { handleGitHubWebhook, verifySignature } from '../webhooks/github-handler.js';
import { resolveGithubWebhookSecret, isDuplicateDelivery } from '../webhooks/inbound-webhook-store.js';
import { handleConnectIngest } from '../webhooks/connect-handler.js';
import { signup, login, getCurrentUser, verifyJwt, JWT_EXPIRES_SECONDS } from './user-auth.js';
import type { JwtPayload } from './user-auth.js';
import { listUserSessions, revokeSession, revokeAllSessions } from './user-sessions.js';
import { createInvite, listInvites, revokeInvite, lookupInvite, listMembers, changeMemberRole } from './invites.js';
import { verdictFor, tenantRepos, EntitlementError } from './entitlements.js';
import { createApiKey, listApiKeys, rotateApiKey as rotateScopedApiKey, revokeApiKey, API_KEY_SCOPES } from './tenant-api-keys.js';
import { rotateApiKey as rotateTenantBootstrapKey } from './tenant-keys.js';
import { requestPasswordReset, resetPassword, lookupPasswordReset } from './password-reset.js';
import { getWhoami } from './whoami.js';
import { requestMagicLink, consumeMagicLink, lookupMagicLink } from './magic-link.js';
import { requestAccountUnlock, consumeAccountUnlock, lookupAccountUnlock } from './account-unlock.js';
import {
  enrollTotp,
  confirmTotpEnrollment,
  verifyTotpLogin,
  disableTotp,
  regenerateRecoveryCodes,
  getTotpStatus,
  setTenantRequire2fa,
} from './totp-mfa.js';
import { requestErasure, cancelErasure, getErasureStatus } from './account-erasure.js';
import { mintGiftCode, previewGiftCode, redeemGiftCode, listGiftCodes, revokeGiftCode } from './gift-codes.js';
import {
  getTenantSsoConfig,
  verifyOidcIdToken,
  verifyAndExtractSaml,
  resolveSsoLogin,
} from './sso.js';
import { authRateLimit, LOGIN_POLICY, SIGNUP_POLICY, RESET_POLICY, MAGIC_LINK_POLICY, ACCOUNT_UNLOCK_POLICY } from './auth-rate-limit.js';
import { AuthError, type CtxRole } from './tenant-context.js';
import {
  assertCapability,
  resolveRestRole,
  roleHasCapability,
  resourcePermissionGrid,
  type Capability,
} from './rbac.js';
import { getShadowDenials, summarizeShadowDenials } from '../monitoring/rbac-shadow-store.js';
import {
  queryAuditEvents,
  exportAuditEvents,
  recordAuditEvent,
  verifyAuditChain,
  auditActorFromCtx,
  type AuditAction,
  type AuditExportFormat,
} from './audit-log.js';
import { buildAccessReview, accessReviewToCsv } from './access-review.js';
import { buildEvidenceReport, evidenceReportToDownload } from './evidence.js';
import { bulkImportTenants } from './tenant-bulk-import.js';
import { getTenantMcpTools, setTenantMcpTools } from './tenant-mcp-tools.js';
import { sseManager } from '../notifications/sse-manager.js';
import { startNotificationService } from '../notifications/service.js';
import { startReviewApprovalService } from '../notifications/review-approval.js';
import type { NotifyEvent } from '../notifications/event-bus.js';
import { getPreferences, updatePreferences, sanitizePrefsPatch } from '../notifications/preferences.js';
import { getVapidPublicKey, isPushConfigured, isValidSubscription, saveSubscription, removeSubscription, countSubscriptions } from '../notifications/web-push.js';
import { isEmailConfigured } from '../notifications/email-notify.js';
import {
  createEndpoint as createWebhookEndpoint,
  listEndpoints as listWebhookEndpoints,
  updateEndpoint as updateWebhookEndpoint,
  deleteEndpoint as deleteWebhookEndpoint,
  listDeliveries as listWebhookDeliveries,
  replayDelivery as replayWebhookDelivery,
} from '../webhooks/webhook-store.js';
import { WEBHOOK_EVENTS } from '../webhooks/outbound-events.js';
import type { WebhookDeliveryStatus } from '../shared/db.js';

const log = createChildLogger({ module: 'http-server' });

// OpenAPI document is static — build once on first request, reuse thereafter.
let cachedOpenApiSpec: Record<string, unknown> | undefined;

export function createHttpServer() {
  const app = express();

  // Apply production middleware (security headers, CORS, body parsing, logging, rate limiting)
  const { applyErrorHandlers, stopRateLimitCleanup } = applyMiddleware(app);

  // Stash the rate-limiter cleanup so the shutdown handler in startHttpServer can
  // stop its setInterval — otherwise the timer leaks on restart (FOLLOWUP-178b).
  app.locals.stopRateLimitCleanup = stopRateLimitCleanup;

  // Wire the notification event bus → SSE + DB persistence (idempotent).
  // Subscribing here means the /api/notifications/stream endpoint is live for
  // any app instance, not only the full bootstrap() process.
  startNotificationService();
  // Telegram remote-approve (C1): distinct listener on the same bus — fires an
  // explicit actionable message with inline buttons on the review edge, rather
  // than the passive SSE/DB surfacing startNotificationService() wires up.
  startReviewApprovalService();

  const startTime = Date.now();

  // ── Auth (M2 — dashboard signup/login, password + JWT cookie) ─────────────
  // Human login layer grafted on top of the API-key tenancy: signup provisions a
  // tenant + owner user + API key atomically; login/me/logout manage the JWT
  // session cookie. The per-tenant API key remains the machine credential.

  // Device fingerprint captured at every token-mint point (signup/login/magic-
  // link/SSO/TOTP-verify) so the session-management UI can show what device/IP
  // a session belongs to. `req.ip` only honours X-Forwarded-For when
  // TRUST_PROXY is set (see middleware.ts) — same posture as the rate limiter.
  const deviceFromReq = (req: Request): { userAgent?: string; ip?: string } => ({
    userAgent: req.header('user-agent'),
    ip: req.ip || req.socket.remoteAddress || undefined,
  });

  app.post('/api/auth/signup', authRateLimit('signup', SIGNUP_POLICY), async (req: Request, res: Response) => {
    try {
      const result = await signup(req.body, deviceFromReq(req));
      res.cookie('myai_token', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: JWT_EXPIRES_SECONDS * 1000,
        path: '/',
      });
      res.status(201).json({
        token: result.token,
        apiKey: result.apiKey, // absent on invite joins — never re-exposed
        tenantId: result.tenantId,
        userId: result.userId,
        tenantName: result.tenantName,
        plan: result.plan,
        role: result.role,
      });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('signup failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/login', authRateLimit('login', LOGIN_POLICY), async (req: Request, res: Response) => {
    try {
      const result = await login(req.body, deviceFromReq(req));
      // TOTP-enabled account: no cookie yet — the dashboard must complete
      // /api/auth/totp/verify with the pendingToken + a code first.
      if (result.mfaRequired) {
        res.json(result);
        return;
      }
      res.cookie('myai_token', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: JWT_EXPIRES_SECONDS * 1000,
        path: '/',
      });
      res.json(result);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('login failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── TOTP 2FA (enroll → confirm → login-time verify; disable + recovery
  // codes; per-tenant enforce policy) — core/totp.ts (crypto) + core/totp-mfa.ts
  // (orchestration). Enroll/confirm/disable/regenerate/status are session-JWT
  // authenticated (the user acting on their own account); verify is PUBLIC —
  // it's the second half of login, authenticated by the short-lived pendingToken
  // instead of a session cookie (there is no session yet).

  app.post('/api/auth/totp/enroll', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      const result = await enrollTotp(payload.sub);
      res.json(result);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('TOTP enrollment failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/totp/confirm', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await confirmTotpEnrollment(payload.sub, String(b.code ?? ''));
      recordAuditEvent({
        tenantId: payload.tid,
        actor: { userId: payload.sub, role: payload.role as CtxRole, via: 'jwt' },
        action: 'totp.enable',
        target: payload.sub,
      });
      res.json(result); // recovery codes are show-once — only this response carries them
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('TOTP confirmation failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // No IP-keyed authRateLimit here — the dashboard proxies every tenant's
  // calls through one source IP (see auth-rate-limit.ts header), which would
  // throttle all accounts together. checkTotpVerifyRate (totp.ts) inside
  // verifyTotpLogin is keyed per-userId instead.
  app.post('/api/auth/totp/verify', async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await verifyTotpLogin(String(b.pendingToken ?? ''), String(b.code ?? ''), deviceFromReq(req));
      res.cookie('myai_token', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: JWT_EXPIRES_SECONDS * 1000,
        path: '/',
      });
      res.json(result);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('TOTP verification failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/auth/totp/status', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      res.json(await getTotpStatus(payload.sub));
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('TOTP status lookup failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/totp/disable', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await disableTotp(payload.sub, String(b.code ?? ''));
      recordAuditEvent({
        tenantId: payload.tid,
        actor: { userId: payload.sub, role: payload.role as CtxRole, via: 'jwt' },
        action: 'totp.disable',
        target: payload.sub,
      });
      res.json(result);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('TOTP disable failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/totp/recovery-codes/regenerate', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await regenerateRecoveryCodes(payload.sub, String(b.code ?? ''));
      res.json(result); // show-once, same as confirm
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('recovery code regeneration failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // Per-tenant enforce policy toggle — owner/admin only (members capability,
  // same gate as api-keys/role-change: this changes every member's login
  // requirements, not just the caller's own account).
  app.post('/api/auth/tenant/2fa-policy', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await setTenantRequire2fa(payload.tid, !!b.enabled);
      recordAuditEvent({
        tenantId: payload.tid,
        actor: { userId: payload.sub, role: payload.role as CtxRole, via: 'jwt' },
        action: 'totp.policy_change',
        target: payload.tid,
        detail: { require2fa: result.require2fa },
      });
      res.json(result);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('2FA policy update failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/auth/me', async (req: Request, res: Response) => {
    try {
      const token = req.cookies?.myai_token || req.header('authorization')?.replace('Bearer ', '');
      if (!token) { res.status(401).json({ error: 'not authenticated' }); return; }
      const payload = verifyJwt(token);
      const user = await getCurrentUser(payload);
      res.json(user);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('unauthorized');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.clearCookie('myai_token', { path: '/' });
    res.json({ ok: true });
  });

  // `myai whoami` (CLI) — per-tenant API-key authenticated (NOT in REST_EXEMPT,
  // so core/auth.ts `authenticate()` already rejected an invalid/missing key
  // before this runs). Distinct from `/api/auth/me` above (JWT-cookie dashboard
  // session) — this is the CLI's own session-identity check after `myai login`.
  app.get('/api/auth/whoami', async (req: Request, res: Response) => {
    try {
      res.json(await getWhoami(ctxFromReq(req)));
    } catch (err) {
      log.error({ err }, 'whoami failed');
      res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
    }
  });

  // ── Active session / device management ────────────────────────────────────
  // JWT-authenticated (cookie or Bearer). Lists/revokes the UserSession rows
  // every login method records (core/user-sessions.ts). Revoking the CURRENT
  // session also clears the cookie so the caller is logged out immediately
  // rather than riding it out until the revocation check catches their next
  // request (see the sessionRevocationGuard in middleware.ts).

  app.get('/api/auth/sessions', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      const sessions = await listUserSessions(payload.sub, payload.sid);
      res.json({ sessions });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('failed to list sessions', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/sessions/:sessionId/revoke', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      const sessionId = String(req.params.sessionId);
      const { revoked } = await revokeSession(payload.sub, sessionId);
      if (!revoked) {
        res.status(404).json({ error: 'session not found', code: 'NOT_FOUND' });
        return;
      }
      recordAuditEvent({
        tenantId: payload.tid,
        actor: { userId: payload.sub, role: payload.role as CtxRole, via: 'jwt' },
        action: 'session.revoke',
        target: sessionId,
      });
      const currentRevoked = sessionId === payload.sid;
      if (currentRevoked) res.clearCookie('myai_token', { path: '/' });
      // `currentRevoked` lets a dashboard-style proxy (which forwards the JWT
      // as a Bearer token rather than terminating the cookie itself) know it
      // must clear its OWN session cookie too.
      res.json({ ok: true, currentRevoked });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('failed to revoke session', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/sessions/revoke-all', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const includeCurrent = !!b.includeCurrent;
      const { revokedCount } = await revokeAllSessions(payload.sub, includeCurrent ? {} : { exceptSessionId: payload.sid });
      recordAuditEvent({
        tenantId: payload.tid,
        actor: { userId: payload.sub, role: payload.role as CtxRole, via: 'jwt' },
        action: 'session.revoke_all',
        target: payload.sub,
        detail: { revokedCount, includeCurrent },
      });
      if (includeCurrent) res.clearCookie('myai_token', { path: '/' });
      res.json({ ok: true, revokedCount, currentRevoked: includeCurrent });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('failed to revoke sessions', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── Password reset (Team tier — forgot-password via email) ───────────────
  // Public + rate-limited like login. `forgot` always answers { ok: true } so
  // the surface never confirms whether an address has an account; the token
  // travels only in the reset email (console transport when SMTP is unset).

  app.post('/api/auth/password/forgot', authRateLimit('reset', RESET_POLICY), async (req: Request, res: Response) => {
    try {
      res.json(await requestPasswordReset(String((req.body ?? {}).email ?? '')));
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('reset request failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/password/reset', authRateLimit('reset', RESET_POLICY), async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json(await resetPassword(String(b.token ?? ''), String(b.password ?? '')));
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('password reset failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/auth/password/lookup', async (req: Request, res: Response) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!token) return res.status(400).json({ error: 'token required', code: 'BAD_REQUEST' });
      res.json(await lookupPasswordReset(token));
    } catch (err) {
      log.error({ err }, 'password reset lookup failed');
      res.status(500).json({ error: 'lookup failed', code: 'INTERNAL' });
    }
  });

  // ── Magic-link (passwordless) login — PRIMARY auth path alongside password
  // sign-in, distinct from password reset / email verification. `request`
  // always answers { ok: true } so this surface never confirms whether an
  // address has an account; `consume` burns the single-use token and mints
  // the SAME session cookie password login does.

  app.post('/api/auth/magic-link/request', authRateLimit('magic-link', MAGIC_LINK_POLICY), async (req: Request, res: Response) => {
    try {
      res.json(await requestMagicLink(String((req.body ?? {}).email ?? '')));
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('magic link request failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/magic-link/consume', authRateLimit('magic-link', MAGIC_LINK_POLICY), async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await consumeMagicLink(String(b.token ?? ''), deviceFromReq(req));
      res.cookie('myai_token', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: JWT_EXPIRES_SECONDS * 1000,
        path: '/',
      });
      res.json(result);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('magic link login failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/auth/magic-link/lookup', async (req: Request, res: Response) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!token) return res.status(400).json({ error: 'token required', code: 'BAD_REQUEST' });
      res.json(await lookupMagicLink(token));
    } catch (err) {
      log.error({ err }, 'magic link lookup failed');
      res.status(500).json({ error: 'lookup failed', code: 'INTERNAL' });
    }
  });

  // ── Account auto-unlock (self-serve post-lockout recovery via email) ─────
  // login() fires the unlock email automatically the instant it locks the
  // account (see user-auth.ts) — `request` here is just the resend path if
  // that email didn't arrive in time, and always answers { ok: true } so this
  // surface never confirms whether an address has an account or is locked.
  // `consume` only clears the lock; it does NOT log the user in.

  app.post('/api/auth/account/unlock/request', authRateLimit('unlock', ACCOUNT_UNLOCK_POLICY), async (req: Request, res: Response) => {
    try {
      res.json(await requestAccountUnlock(String((req.body ?? {}).email ?? '')));
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('unlock request failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/account/unlock/consume', authRateLimit('unlock', ACCOUNT_UNLOCK_POLICY), async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json(await consumeAccountUnlock(String(b.token ?? '')));
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('account unlock failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/auth/account/unlock/lookup', async (req: Request, res: Response) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!token) return res.status(400).json({ error: 'token required', code: 'BAD_REQUEST' });
      res.json(await lookupAccountUnlock(token));
    } catch (err) {
      log.error({ err }, 'account unlock lookup failed');
      res.status(500).json({ error: 'lookup failed', code: 'INTERNAL' });
    }
  });

  // ── Enterprise SSO (SAML / OIDC — GRAND_PRODUCT Phase 3) ──────────────────
  // A second, env-gated-per-tenant login path. `getTenantSsoConfig` returns null
  // (→ 404) unless the master gate SSO_ENABLED is on AND the tenant has a config
  // block in SSO_CONFIG. On success we mint the SAME session cookie password
  // login does, so downstream RBAC/scoping is auth-method-agnostic. Public
  // surface (no API key): the IdP round-trip IS the authentication.

  const setSessionCookie = (res: Response, token: string): void => {
    res.cookie('myai_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: JWT_EXPIRES_SECONDS * 1000,
      path: '/',
    });
  };

  // Discovery: does this tenant have SSO, and where does the IdP live?
  app.get('/api/auth/sso/metadata', (req: Request, res: Response) => {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
    const cfg = tenantId ? getTenantSsoConfig(tenantId) : null;
    if (!cfg) { res.json({ enabled: false }); return; }
    res.json({
      enabled: true,
      provider: cfg.provider,
      authorizationEndpoint: cfg.authorizationEndpoint,
      entryPoint: cfg.entryPoint,
    });
  });

  // OIDC callback: the dashboard completes the code exchange with the IdP and
  // posts the resulting id_token here (+ optional nonce it set on the auth req).
  app.post('/api/auth/sso/oidc/callback', authRateLimit('login', LOGIN_POLICY), async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const tenantId = String(b.tenantId ?? '');
      const idToken = String(b.idToken ?? '');
      const cfg = getTenantSsoConfig(tenantId);
      if (!cfg || cfg.provider !== 'oidc') throw new AuthError('SSO not enabled for tenant', 404, 'NOT_FOUND');
      if (!idToken) throw new AuthError('id_token required', 400, 'BAD_REQUEST');
      const claims = verifyOidcIdToken(idToken, cfg, {
        expectedNonce: typeof b.nonce === 'string' ? b.nonce : undefined,
      });
      const result = await resolveSsoLogin({ tenantId, claims, cfg, ...deviceFromReq(req) });
      setSessionCookie(res, result.token);
      res.json(result);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('SSO login failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // SAML callback (HTTP-POST binding): the IdP posts a base64 SAMLResponse.
  app.post('/api/auth/sso/saml/callback', authRateLimit('login', LOGIN_POLICY), async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const tenantId = String(b.tenantId ?? '');
      const samlResponse = String(b.SAMLResponse ?? b.samlResponse ?? '');
      const cfg = getTenantSsoConfig(tenantId);
      if (!cfg || cfg.provider !== 'saml') throw new AuthError('SSO not enabled for tenant', 404, 'NOT_FOUND');
      if (!samlResponse) throw new AuthError('SAMLResponse required', 400, 'BAD_REQUEST');
      const claims = verifyAndExtractSaml(samlResponse, cfg);
      const result = await resolveSsoLogin({ tenantId, claims, cfg, ...deviceFromReq(req) });
      setSessionCookie(res, result.token);
      res.json(result);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('SSO login failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── Tenant invites + members (Team tier — M2 gap close) ──────────────────
  // JWT-authenticated (cookie or Bearer JWT — these paths are exempt from the
  // API-key middleware, so Bearer here is the session JWT the dashboard proxy
  // forwards). Lookup is public-by-token for the signup page's join banner.

  const jwtFromReq = (req: Request): JwtPayload => {
    const token = req.cookies?.myai_token || req.header('authorization')?.replace('Bearer ', '');
    if (!token) throw new AuthError('not authenticated');
    return verifyJwt(token);
  };

  // ── RBAC v1 REST enforcement (ADR-013 §3/§4 — slice 2) ─────────────────────
  // Shadow/enforce guard for the mutation routes in REST_ROUTE_CAPS. The role
  // is server-derived (session-JWT claim → resolved tenant ctx → default
  // `member`), never from caller args. Returns true when the request was
  // BLOCKED (response already sent) so the handler can early-return. Honors
  // RBAC_ENFORCE: shadow mode logs `rbac.shadow` and allows; enforce mode 403s.
  const rbacRole = (req: Request): CtxRole => resolveRestRole(req, verifyJwt);
  const enforceRbac = (req: Request, res: Response, cap: Capability): boolean => {
    try {
      assertCapability(
        { tenantId: ctxFromReq(req).tenantId, role: rbacRole(req) },
        cap,
        { action: `${req.method} ${req.path}` },
      );
      return false;
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return true;
      }
      throw err;
    }
  };
  // Hard membership gate for the already-strict invite/member routes — matrix
  // capability, but NEVER shadow-weakened (they shipped as hard owner/admin
  // gates; slice 2 only unifies them on the same matrix).
  const requireMembersHard = (payload: JwtPayload): void => {
    if (!roleHasCapability(payload.role as CtxRole, 'members')) {
      throw new AuthError('requires member-management capability (owner or admin)', 403, 'FORBIDDEN');
    }
  };

  app.post('/api/auth/invites', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload); // RBAC: only owner/admin may invite (ADR-013 §4)
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await createInvite({
        tenantId: payload.tid,
        invitedBy: payload.sub,
        inviterRole: payload.role,
        email: String(b.email ?? ''),
        role: b.role as never,
        expiresInDays: typeof b.expiresInDays === 'number' ? b.expiresInDays : undefined,
      });
      res.status(201).json(result); // token is show-once — only this response carries it
    } catch (err) {
      if (err instanceof EntitlementError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...err.verdict });
        return;
      }
      const e = err instanceof AuthError ? err : new AuthError('invite failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/auth/invites', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload); // RBAC: member-management capability (ADR-013 §4)
      const invites = await listInvites(payload.tid);
      res.json({ count: invites.length, invites });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('failed to list invites', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // POST body { inviteId } rather than DELETE /:id — keeps the path static so
  // the exact-match REST_EXEMPT set in auth.ts covers it.
  app.post('/api/auth/invites/revoke', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload); // RBAC: member-management capability (ADR-013 §4)
      const inviteId = String((req.body ?? {}).inviteId ?? '');
      if (!inviteId) return res.status(400).json({ error: 'inviteId required', code: 'BAD_REQUEST' });
      const invite = await revokeInvite(payload.tid, inviteId, { userId: payload.sub, role: payload.role as UserRole });
      res.json({ revoked: true, invite });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('revoke failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/auth/invites/lookup', async (req: Request, res: Response) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!token) return res.status(400).json({ error: 'token required', code: 'BAD_REQUEST' });
      res.json(await lookupInvite(token));
    } catch (err) {
      log.error({ err }, 'invite lookup failed');
      res.status(500).json({ error: 'lookup failed', code: 'INTERNAL' });
    }
  });

  app.get('/api/auth/members', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      const members = await listMembers(payload.tid);
      res.json({ count: members.length, members });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('failed to list members', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // Change a member's role (ADR-013 §4 — RBAC v1 slice 3). Static path (body
  // carries { userId, role }) so the exact-match REST_EXEMPT set covers it —
  // same convention as /api/auth/invites/revoke. Hard `members`-capability gate
  // (owner/admin); the spec rules (no owner touch, admin-can't-grant-admin,
  // last-owner protection) live in changeMemberRole.
  app.post('/api/auth/members/role', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const targetUserId = String(b.userId ?? '');
      const newRole = String(b.role ?? '');
      if (!targetUserId || !newRole) {
        return res.status(400).json({ error: 'userId and role required', code: 'BAD_REQUEST' });
      }
      const member = await changeMemberRole({
        tenantId: payload.tid,
        actorUserId: payload.sub,
        actorRole: payload.role,
        targetUserId,
        newRole: newRole as UserRole,
      });
      res.json({ member });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('role change failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── Self-serve account deletion (GDPR/CCPA right-to-erasure, core/account-erasure.ts) ──
  // Owner-only (`billing` capability — only owner/system/operator hold it, same
  // gate as the billing routes; a mere admin cannot delete the whole tenant).
  // Request stamps a grace-window purge date + audit record; cancel undoes it
  // within the window; status is a plain read. The irreversible purge itself
  // runs out-of-band (an operator/cron sweep — see account-erasure.ts).
  const requireBillingHard = (payload: JwtPayload): void => {
    if (!roleHasCapability(payload.role as CtxRole, 'billing')) {
      throw new AuthError('requires the tenant owner', 403, 'FORBIDDEN');
    }
  };

  app.post('/api/auth/account/erasure', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireBillingHard(payload);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const request = await requestErasure({
        tenantId: payload.tid,
        requestedBy: payload.sub,
        requestedRole: payload.role,
        reason: typeof b.reason === 'string' ? b.reason : undefined,
      });
      res.json({ request });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('erasure request failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/auth/account/erasure', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireBillingHard(payload);
      const request = await getErasureStatus(payload.tid);
      res.json({ request });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('erasure status lookup failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/account/erasure/cancel', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireBillingHard(payload);
      const request = await cancelErasure({
        tenantId: payload.tid,
        actorUserId: payload.sub,
        actorRole: payload.role,
      });
      res.json({ request });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('erasure cancel failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── Gift / redeemable subscription codes (GROWTH — core/gift-codes.ts) ─────
  // Mint/list/revoke mint a platform-wide grant with no redeeming tenant in
  // scope — operator-only, gated by requireAdmin (x-admin-token), same
  // cross-tenant posture as the budgets routes. Preview is a public-by-code
  // read (any authenticated user, before they commit to redeeming). Redeem is
  // tenant-scoped and owner-only (`billing` capability — same hard gate as
  // account erasure, since it mutates the tenant's plan/credit balance).

  app.post('/api/gift-codes', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const result = await mintGiftCode({
          createdBy: typeof b.createdBy === 'string' && b.createdBy ? b.createdBy : 'operator',
          actorRole: 'operator',
          grantType: b.grantType as never,
          grantPlan: b.grantPlan as never,
          grantMonths: typeof b.grantMonths === 'number' ? b.grantMonths : undefined,
          grantCredits: typeof b.grantCredits === 'number' ? b.grantCredits : undefined,
          maxRedemptions: typeof b.maxRedemptions === 'number' ? b.maxRedemptions : undefined,
          expiresInDays: typeof b.expiresInDays === 'number' ? b.expiresInDays : undefined,
          note: typeof b.note === 'string' ? b.note : undefined,
          code: typeof b.code === 'string' ? b.code : undefined,
        });
        res.status(201).json(result);
      } catch (err) {
        const e = err instanceof AuthError ? err : new AuthError('mint failed', 500, 'INTERNAL');
        res.status(e.status).json({ error: e.message, code: e.code });
      }
    });
  });

  app.get('/api/gift-codes', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      try {
        const codes = await listGiftCodes();
        res.json({ count: codes.length, codes });
      } catch (err) {
        log.error({ err }, 'gift-codes list failed');
        res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
      }
    });
  });

  app.post('/api/gift-codes/revoke', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      try {
        const codeId = String((req.body ?? {}).codeId ?? '');
        if (!codeId) return res.status(400).json({ error: 'codeId required', code: 'BAD_REQUEST' });
        const giftCode = await revokeGiftCode(codeId, 'operator');
        res.json({ revoked: true, giftCode });
      } catch (err) {
        const e = err instanceof AuthError ? err : new AuthError('revoke failed', 500, 'INTERNAL');
        res.status(e.status).json({ error: e.message, code: e.code });
      }
    });
  });

  app.get('/api/gift-codes/preview', async (req: Request, res: Response) => {
    try {
      jwtFromReq(req); // any authenticated user may preview a code before redeeming
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) return res.status(400).json({ error: 'code required', code: 'BAD_REQUEST' });
      res.json(await previewGiftCode(code));
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('preview failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/gift-codes/redeem', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireBillingHard(payload); // RBAC: redemption mutates tenant billing state — owner only
      const code = String((req.body ?? {}).code ?? '');
      if (!code) return res.status(400).json({ error: 'code required', code: 'BAD_REQUEST' });
      const result = await redeemGiftCode({
        code,
        tenantId: payload.tid,
        actorRole: payload.role as CtxRole,
        redeemedBy: payload.sub,
      });
      res.json(result);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('redeem failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── Scoped per-tenant API keys (ADR-010 §3.6 — create/list/rotate/revoke) ──
  // JWT-cookie authenticated, owner/admin gated (members capability — minting a
  // machine credential is privileged). Tenant-scoped inside the store. The raw
  // key is returned ONCE by create/rotate; list/revoke never expose it. Rotation
  // carries a grace window so callers swap keys with zero downtime.

  app.get('/api/auth/api-keys', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload); // RBAC: key management requires owner/admin
      const keys = await listApiKeys(payload.tid);
      res.json({ count: keys.length, keys, scopes: API_KEY_SCOPES });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('failed to list api keys', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/api-keys', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await createApiKey({
        tenantId: payload.tid,
        name: String(b.name ?? ''),
        scopes: Array.isArray(b.scopes) ? (b.scopes as string[]) : undefined,
        env: b.env === 'test' ? 'test' : 'live',
        actor: { userId: payload.sub, role: payload.role as CtxRole },
      });
      res.status(201).json(result); // rawKey is show-once — only this response carries it
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('api key create failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // Static path (body carries { keyId, graceMinutes }) so the exact-match
  // REST_EXEMPT set covers it — same convention as /api/auth/invites/revoke.
  app.post('/api/auth/api-keys/rotate', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const keyId = String(b.keyId ?? '');
      if (!keyId) return res.status(400).json({ error: 'keyId required', code: 'BAD_REQUEST' });
      const result = await rotateScopedApiKey({
        tenantId: payload.tid,
        keyId,
        graceMinutes: typeof b.graceMinutes === 'number' ? b.graceMinutes : undefined,
        actor: { userId: payload.sub, role: payload.role as CtxRole },
      });
      res.json(result); // new rawKey is show-once
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('api key rotate failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/auth/api-keys/revoke', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload);
      const keyId = String((req.body ?? {}).keyId ?? '');
      if (!keyId) return res.status(400).json({ error: 'keyId required', code: 'BAD_REQUEST' });
      const key = await revokeApiKey({
        tenantId: payload.tid,
        keyId,
        actor: { userId: payload.sub, role: payload.role as CtxRole },
      });
      res.json({ revoked: true, key });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('api key revoke failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── Tenant bootstrap-key self-rotation (operator, LOCAL-TRUST only) ────────
  // Distinct from the scoped-key rotate above (JWT/owner-gated, per named key).
  // This rotates a tenant's single legacy `apiKeyHash`/`apiKeyPrefix`
  // (tenant-keys.ts — the credential ADR-010 M4's off-hours runner and other
  // machine callers hold) with the SAME zero-downtime grace-window pattern.
  // Gated by local trust (loopback or GATEWAY_LOCAL_TOKEN) rather than a JWT
  // session, so `myai rotate-keys tenant <id>` or a scheduled job can call it
  // directly with no dashboard login — but that also means it is NOT
  // tenant-scoped by the caller's own credential, so any tenantId may be
  // rotated. Never expose this path to a non-local-trust caller.
  app.post('/api/auth/tenant-key/rotate', async (req: Request, res: Response) => {
    try {
      if (!req.tenant?.local) {
        throw new AuthError('local trust required', 403, 'FORBIDDEN');
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const tenantId = String(b.tenantId ?? '');
      if (!tenantId) return res.status(400).json({ error: 'tenantId required', code: 'BAD_REQUEST' });
      const env = b.env === 'test' ? 'test' : 'live';
      const graceMinutes = typeof b.graceMinutes === 'number' ? b.graceMinutes : undefined;
      const rawKey = await rotateTenantBootstrapKey(tenantId, env, graceMinutes);
      recordAuditEvent({
        tenantId,
        actor: { role: 'operator', via: 'local' },
        action: 'tenantkey.rotate',
        target: tenantId,
        detail: { graceMinutes },
      });
      res.json({ tenantId, rawKey }); // new raw key is show-once
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('tenant key rotate failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── Audit trail + permission matrix (ADR-013 §5 — RBAC v2 governance) ──────
  // The in-dashboard audit-log viewer's backend. Members-capability gated
  // (owner/admin) and tenant-scoped inside the store — a viewer/member can never
  // read another member's privileged-action trail. Query filters mirror the
  // AuditQuery shape; export streams a JSON or CSV download for SOC2 evidence.

  app.get('/api/auth/audit', (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload); // RBAC: audit read requires member-mgmt (ADR-013 §5)
      const q = req.query;
      const events = queryAuditEvents({
        tenantId: payload.tid,
        action: typeof q.action === 'string' ? (q.action as AuditAction) : undefined,
        actorUserId: typeof q.actorUserId === 'string' ? q.actorUserId : undefined,
        since: typeof q.since === 'string' ? q.since : undefined,
        until: typeof q.until === 'string' ? q.until : undefined,
        limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
      });
      res.json({ count: events.length, events });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('failed to read audit trail', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/auth/audit/export', (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload);
      const q = req.query;
      const format: AuditExportFormat = q.format === 'csv' ? 'csv' : 'json';
      const { body, contentType, filename } = exportAuditEvents(
        {
          tenantId: payload.tid,
          action: typeof q.action === 'string' ? (q.action as AuditAction) : undefined,
          actorUserId: typeof q.actorUserId === 'string' ? q.actorUserId : undefined,
          since: typeof q.since === 'string' ? q.since : undefined,
          until: typeof q.until === 'string' ? q.until : undefined,
        },
        format,
      );
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(body);
      // Bulk-export detector input (security-anomaly-alerter) — fired after a
      // successful send so a malformed request never pollutes the trail.
      recordAuditEvent({
        tenantId: payload.tid,
        actor: { userId: payload.sub, role: payload.role as CtxRole, via: 'jwt' },
        action: 'data.export',
        target: 'audit-trail',
        detail: { format },
      });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('audit export failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // Tamper-evidence check (ADR-013 §5 hash chain): recomputes this tenant's
  // hash chain from the on-disk trail and reports any gap/mutation. Same
  // members-gated, tenant-scoped guard as the read/export routes above.
  app.get('/api/auth/audit/verify', (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload);
      res.json(verifyAuditChain(payload.tid));
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('audit chain verification failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // The per-resource permission matrix the dashboard "Permissions" panel renders
  // (RBAC v2). Read-only projection of the static role→capability lattice — any
  // authenticated tenant member may view what each role is allowed to do.
  app.get('/api/auth/permissions', (req: Request, res: Response) => {
    try {
      jwtFromReq(req); // any authenticated member may read the matrix
      res.json({ grid: resourcePermissionGrid() });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('failed to read permissions', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // RBAC shadow-mode denials (ADR-013 §6 soak visibility). Answers "if
  // RBAC_ENFORCE flips on today, which callers/tools would 403?" from the
  // ring buffer `assertCapability` writes to in shadow mode (rbac-shadow-store.ts)
  // — never the durable audit trail, which only gets `rbac.denied` once
  // enforcement is actually on. Members-capability gated + tenant-scoped, same
  // posture as the audit trail above.
  app.get('/api/auth/rbac/shadow-denials', (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload); // RBAC: shadow-denial visibility requires member-mgmt (ADR-013 §6)
      const q = req.query;
      const since = typeof q.since === 'string' ? Number(q.since) : undefined;
      const events = getShadowDenials({
        tenantId: payload.tid,
        role: typeof q.role === 'string' ? (q.role as CtxRole) : undefined,
        capability: typeof q.capability === 'string' ? (q.capability as Capability) : undefined,
        action: typeof q.action === 'string' ? q.action : undefined,
        since: Number.isFinite(since) ? since : undefined,
        limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
      });
      const summary = summarizeShadowDenials(payload.tid, Number.isFinite(since) ? since : undefined);
      res.json({ count: events.length, events, summary });
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('failed to read rbac shadow denials', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── Quarterly access review (ADR-013 §5 — SOC2 CC6.1–CC6.3) ────────────────
  // Who has access, at what role, last-active + stale flags. Members-capability
  // gated (owner/admin) and tenant-scoped via listMembers. ?staleAfterDays
  // overrides the 90-day window; ?format=csv streams a download for the binder.
  app.get('/api/auth/access-review', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload); // RBAC: access review requires member-mgmt (ADR-013 §5)
      const q = req.query;
      const members = await listMembers(payload.tid);
      const staleAfterDays = typeof q.staleAfterDays === 'string' ? Number(q.staleAfterDays) : undefined;
      const review = buildAccessReview(payload.tid, members, {
        ...(Number.isFinite(staleAfterDays as number) ? { staleAfterDays: staleAfterDays as number } : {}),
      });
      if (q.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="access-review-${payload.tid}-${review.generatedAt.slice(0, 10)}.csv"`);
        return res.send(accessReviewToCsv(review));
      }
      res.json(review);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('access review failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // The SOC2 evidence-export report (ADR-013 §5): access review + audit-trail
  // coverage in one auditor-ready JSON bundle. Members-capability gated,
  // tenant-scoped. ?since/?until bound the audit period; both echoed into the
  // report. Always a JSON download (Content-Disposition attachment).
  app.get('/api/auth/evidence', async (req: Request, res: Response) => {
    try {
      const payload = jwtFromReq(req);
      requireMembersHard(payload); // RBAC: evidence export requires member-mgmt (ADR-013 §5)
      const q = req.query;
      const since = typeof q.since === 'string' ? q.since : undefined;
      const until = typeof q.until === 'string' ? q.until : undefined;
      const staleAfterDays = typeof q.staleAfterDays === 'string' ? Number(q.staleAfterDays) : undefined;
      const [members, events] = [
        await listMembers(payload.tid),
        queryAuditEvents({ tenantId: payload.tid, since, until, limit: 1000 }),
      ];
      const report = buildEvidenceReport({
        tenantId: payload.tid,
        members,
        events,
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(Number.isFinite(staleAfterDays as number) ? { staleAfterDays: staleAfterDays as number } : {}),
      });
      const { body, contentType, filename } = evidenceReportToDownload(report);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(body);
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError('evidence export failed', 500, 'INTERNAL');
      res.status(e.status).json({ error: e.message, code: e.code });
    }
  });

  // ── Bulk tenant provisioning (reseller/agency onboarding) ───────────────────
  // Operator-only (requireAdmin / x-admin-token — same cross-tenant posture as
  // the budgets/usage routes below): mass-creates tenants + owner accounts from
  // a CSV/JSON row set (name, plan, seats, adminEmail). `dryRun` (default true
  // unless the caller passes `dryRun: false`) validates and previews without
  // writing anything; every row gets its own status in the report so a partial
  // batch failure never hides which tenants actually landed.
  app.post('/api/tenants/bulk-import', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      try {
        const { format, data, dryRun, provisionedBy } = (req.body ?? {}) as Record<string, unknown>;
        if (format !== 'csv' && format !== 'json') {
          res.status(400).json({ error: "format must be 'csv' or 'json'", code: 'BAD_REQUEST' });
          return;
        }
        const report = await bulkImportTenants({
          format,
          data,
          dryRun: typeof dryRun === 'boolean' ? dryRun : undefined,
          provisionedBy: typeof provisionedBy === 'string' ? provisionedBy : undefined,
        });
        res.json(report);
      } catch (err) {
        log.warn({ err }, 'bulk tenant import rejected');
        res.status(400).json({ error: err instanceof Error ? err.message : 'bulk import failed', code: 'BAD_REQUEST' });
      }
    });
  });

  // ── Per-org MCP tool visibility override (Wave-2 #15 follow-up) ─────────────
  // Admin surface for `ITenant.mcpToolAllowlist` / `.mcpToolDenylist`
  // (core/rbac.ts `OPERATOR_ONLY_TOOLS` / `isToolVisibleForTenant`, d67f3f9).
  // Operator-only (requireAdmin / x-admin-token — same cross-tenant posture as
  // bulk-import above): a tenant can never grant itself an operator-tool
  // exception, so there is deliberately no self-serve equivalent.
  app.get('/api/tenants/:id/mcp-tools', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      try {
        const view = await getTenantMcpTools(String(req.params.id));
        res.json(view);
      } catch (err) {
        const e = err instanceof AuthError ? err : new AuthError('mcp-tools read failed', 500, 'INTERNAL');
        res.status(e.status).json({ error: e.message, code: e.code });
      }
    });
  });

  app.patch('/api/tenants/:id/mcp-tools', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const view = await setTenantMcpTools(String(req.params.id), {
          mcpToolAllowlist: b.mcpToolAllowlist,
          mcpToolDenylist: b.mcpToolDenylist,
        });
        log.info({ route: '/api/tenants/:id/mcp-tools', tenantId: String(req.params.id) }, 'admin updated tenant mcp-tools override');
        res.json(view);
      } catch (err) {
        const e = err instanceof AuthError ? err : new AuthError('mcp-tools update failed', 500, 'INTERNAL');
        res.status(e.status).json({ error: e.message, code: e.code });
      }
    });
  });

  // ── Hosted brain git transport (ADR-017, transport-route slice) ───────
  // `git http-backend` behind gateway auth: mounted at /brain so it matches
  // the `hostedRemoteUrl()` shape exactly (`.../brain/<tenantId>.git`).
  // Authenticates itself per-request (hosted-brain token, HTTP Basic) inside
  // the router — see hosted-brain-transport.ts header — and is exempted from
  // the tenant-API-key `authenticate()` middleware above via
  // isHostedBrainTransportPath (core/auth.ts).
  app.use('/brain', hostedBrainTransportRouter());

  // ── Health ───────────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      mongodb: isConnected() ? 'connected' : 'disconnected',
    });
  });

  app.get('/health/deep', async (_req: Request, res: Response) => {
    try {
      const result = await deepHealthCheck(startTime);
      const httpStatus = result.status === 'healthy' ? 200 : result.status === 'degraded' ? 200 : 503;
      res.status(httpStatus).json(result);
    } catch (err) {
      log.error({ err }, 'Deep health check failed');
      res.status(500).json({ status: 'unhealthy', error: (err as Error).message });
    }
  });

  // Liveness — process is alive and the event loop is responsive. Deliberately
  // does NOT check Mongo/migrations: a transient dependency blip must not
  // trigger a container restart loop that compounds the outage. That's what
  // /readyz is for. Stays 200 through the SIGTERM drain window so the
  // platform never force-kills a process that's still finishing in-flight
  // requests — only readiness flips immediately on shutdown.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) });
  });

  // Readiness — gates on Mongo connectivity + every startup migration having
  // applied + not mid-shutdown. A load balancer/orchestrator uses this to
  // decide whether to route traffic here: never before migrations are done,
  // never after SIGTERM starts draining.
  app.get('/readyz', (_req: Request, res: Response) => {
    const migrations = getMigrationStatus();
    const mongodb = isConnected();
    const draining = isShutdownInProgress();
    const ready = mongodb && migrations.allApplied && !draining;

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      mongodb: mongodb ? 'connected' : 'disconnected',
      migrations,
      draining,
    });
  });

  app.get('/api/health/alerts', async (req: Request, res: Response) => {
    try {
      const forceRun = req.query.run === 'true';
      const latest = forceRun ? await runHealthCheck() : getLatestHealthCheckResult();
      const alerting = getHealthAlertStatus();
      res.json({ latest, alerting });
    } catch (err) {
      log.error({ err }, 'Health alerts endpoint failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Rolling availability derived from periodic deep health checks. Public —
  // this is what the customer-facing status page renders as "99.9% / 24h".
  app.get('/api/status/uptime', (_req: Request, res: Response) => {
    res.json(getUptimeStats());
  });

  // ── API docs (OpenAPI 3.1 + self-contained HTML reference) ──

  app.get('/api/openapi.json', (_req: Request, res: Response) => {
    cachedOpenApiSpec ??= buildOpenApiSpec();
    res.json(cachedOpenApiSpec);
  });

  app.get('/api/docs', (_req: Request, res: Response) => {
    res.type('html').send(docsHtml('/api/openapi.json'));
  });

  // ── Distributed tracing (gateway→runner→agent spans) ───

  app.get('/traces', (_req: Request, res: Response) => {
    res.type('html').send(traceViewerHtml());
  });

  app.get('/api/traces', (req: Request, res: Response) => {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    res.json({ traceIds: getTraceIds().slice(0, Number.isFinite(limit) ? limit : 100) });
  });

  app.get('/api/traces/:traceId', (req: Request, res: Response) => {
    const traceId = String(req.params.traceId);
    res.json({ traceId, spans: getSpans({ traceId }) });
  });

  // ── Structured request logging (correlation ids, gateway→runner→agent) ──
  // Tenant-scoped backend for the dashboard's /logs live-tail viewer
  // (monitoring/log-store.ts). Same tenant resolution as /api/tasks — the
  // authenticate() middleware already ran, so ctxFromReq(req).tenantId is the
  // caller's own tenant; there is no cross-tenant read path here.

  app.get('/api/logs', (req: Request, res: Response) => {
    const tenantId = ctxFromReq(req).tenantId;
    const q = req.query;
    const entries = getLogs({
      tenantId,
      correlationId: typeof q.correlationId === 'string' ? q.correlationId : undefined,
      service: typeof q.service === 'string' ? (q.service as LogService) : undefined,
      level: typeof q.level === 'string' ? (q.level as LogLevel) : undefined,
      q: typeof q.q === 'string' ? q.q : undefined,
      since: typeof q.since === 'string' ? Number(q.since) : undefined,
      limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
    });
    res.json({ count: entries.length, entries });
  });

  app.get('/api/logs/correlation-ids', (req: Request, res: Response) => {
    const tenantId = ctxFromReq(req).tenantId;
    res.json({ correlationIds: getCorrelationIds(tenantId) });
  });

  // ── Status ───────────────────────────────────────────

  app.get('/status', (_req: Request, res: Response) => {
    res.json({
      name: 'myai',
      version: '0.1.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      mongodb: isConnected() ? 'connected' : 'disconnected',
      llm: isLlmConfigured() ? 'configured' : 'not_configured',
      agents: getAgentCount(),
      skills: getSkillCount(),
      hooks: getHookCount(),
      rules: getRuleCount(),
      sessions: {
        total: getSessionCount(),
        active: getActiveSessionCount(),
      },
    });
  });

  // ── Agents (MongoDB first, fallback to memory) ──────

  app.get('/api/agents', async (req: Request, res: Response) => {
    try {
      if (isConnected()) {
        const filter: Record<string, unknown> = {};
        if (typeof req.query.category === 'string') filter.category = req.query.category;
        if (typeof req.query.search === 'string') {
          filter.$or = [
            { name: { $regex: req.query.search, $options: 'i' } },
            { description: { $regex: req.query.search, $options: 'i' } },
          ];
        }
        const agents = await AgentModel.find(filter).select('-instructions -__v').sort({ category: 1, name: 1 }).lean();
        return res.json({ count: agents.length, source: 'mongodb', agents });
      }
    } catch (err) {
      log.warn({ err }, 'MongoDB agent query failed — falling back to memory');
    }

    // Fallback to in-memory
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const agents = listAgents(category);
    res.json({
      count: agents.length,
      source: 'memory',
      agents: agents.map(a => ({
        name: a.name,
        description: a.description.slice(0, 200),
        category: a.category,
        tools: a.tools,
      })),
    });
  });

  app.get('/api/agents/:name', async (req: Request, res: Response) => {
    try {
      if (isConnected()) {
        const agent = await AgentModel.findOne({ name: String(req.params.name) }).select('-__v').lean();
        if (agent) return res.json(agent);
      }
    } catch (err) {
      log.warn({ err }, 'MongoDB agent lookup failed — falling back to memory');
    }

    const agent = getAgent(String(req.params.name));
    if (!agent) return res.status(404).json({ error: `Agent "${String(req.params.name)}" not found` });
    res.json(agent);
  });

  // ── Skills (MongoDB first, fallback to memory) ──────

  app.get('/api/skills', async (req: Request, res: Response) => {
    try {
      if (isConnected()) {
        const filter: Record<string, unknown> = {};
        if (typeof req.query.search === 'string') {
          filter.$or = [
            { name: { $regex: req.query.search, $options: 'i' } },
            { description: { $regex: req.query.search, $options: 'i' } },
            { triggers: { $regex: req.query.search, $options: 'i' } },
          ];
        }
        const skills = await SkillModel.find(filter).select('-playbook -__v').sort({ name: 1 }).lean();
        return res.json({ count: skills.length, source: 'mongodb', skills });
      }
    } catch (err) {
      log.warn({ err }, 'MongoDB skill query failed — falling back to memory');
    }

    const agent = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    const allSkills = listSkills(agent);
    res.json({
      count: allSkills.length,
      source: 'memory',
      skills: allSkills.map(s => ({
        name: s.name,
        description: s.description.slice(0, 200),
        triggers: s.triggers.slice(0, 5),
      })),
    });
  });

  app.get('/api/skills/:name', async (req: Request, res: Response) => {
    try {
      if (isConnected()) {
        const skill = await SkillModel.findOne({ name: String(req.params.name) }).select('-__v').lean();
        if (skill) return res.json(skill);
      }
    } catch (err) {
      log.warn({ err }, 'MongoDB skill lookup failed — falling back to memory');
    }

    const skill = getSkill(String(req.params.name));
    if (!skill) return res.status(404).json({ error: `Skill "${String(req.params.name)}" not found` });
    res.json(skill);
  });

  // ── Hooks (MongoDB first, fallback to memory) ───────

  app.get('/api/hooks', async (_req: Request, res: Response) => {
    try {
      if (isConnected()) {
        const hooks = await HookModel.find({}).select('-__v').sort({ priority: 1 }).lean();
        return res.json({ count: hooks.length, source: 'mongodb', hooks });
      }
    } catch (err) {
      log.warn({ err }, 'MongoDB hook query failed — falling back to memory');
    }

    const all = listHooks();
    res.json({
      count: all.length,
      source: 'memory',
      hooks: all.map(h => ({
        name: h.name,
        events: h.events,
        priority: h.priority,
        enabled: h.enabled,
        source: h.source,
        timeout: h.timeout,
        lastToggle: h.lastToggle,
      })),
    });
  });

  // Enable/disable a hook (MYAI_DASHBOARD.md §3.2). Bash hooks are the
  // settings.json-backed kind — the toggle patches .claude/settings.json
  // (moving the entry to/from the disabledHooks mirror key, preserving every
  // unrelated key) so the change survives restarts AND applies to Claude Code
  // sessions, then flips the in-memory registration and the Mongo mirror.
  // Body instead of a path param because hook names contain slashes.
  //
  // Governance (task-bd18a5ec): this toggle can flip a safety/guardrail hook
  // (no-push-to-main, secret-scan, …) off with one click, so every call is
  // recorded to the RBAC v1 audit trail (`hook.toggle`, ADR-013 §5) with
  // actor + before/after state, and the same record is mirrored onto the
  // hook (Mongo doc + in-memory registration) as `lastToggle` for the
  // dashboard tooltip.
  app.patch('/api/hooks', async (req: Request, res: Response) => {
    const { name, enabled } = (req.body ?? {}) as { name?: unknown; enabled?: unknown };
    if (typeof name !== 'string' || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must be { name: string, enabled: boolean }' });
    }

    const ctx = ctxFromReq(req);
    const settingsPath = resolve(getConfig().aiRoot, '.claude', 'settings.json');
    const bashParsed = parseBashHookName(name);

    // Best-effort snapshot of the state BEFORE mutating anything — bash hooks
    // are authoritative via settings.json's disabledHooks mirror, others via
    // the in-memory registry, falling back to the Mongo mirror. undefined
    // means genuinely unknown (e.g. first-ever toggle of an unseen hook).
    let previousState: boolean | undefined;
    if (bashParsed && existsSync(settingsPath)) {
      try {
        const disabledScripts = readDisabledScripts(settingsPath);
        previousState = !disabledScripts.has(`${bashParsed.subdir}/${bashParsed.script}`);
      } catch {
        // fall through to the other sources below
      }
    }
    if (previousState === undefined) {
      previousState = listHooks().find(h => h.name === name)?.enabled;
    }
    if (previousState === undefined && isConnected()) {
      try {
        const doc = await HookModel.findOne({ name }).select('enabled').lean();
        if (doc) previousState = doc.enabled;
      } catch (err) {
        log.warn({ err, hook: name }, 'MongoDB hook lookup (pre-toggle) failed');
      }
    }

    let settingsPatched = false;
    if (bashParsed) {
      try {
        settingsPatched = applyHookToggle(settingsPath, name, enabled).changed;
      } catch (err) {
        log.error({ err, hook: name }, 'settings.json hook toggle failed');
        return res.status(500).json({ error: `settings.json patch failed: ${err instanceof Error ? err.message : 'unknown error'}` });
      }
    }

    const inMemory = enableHook(name, enabled);

    const actor = auditActorFromCtx(ctx);
    const lastToggle = {
      actorUserId: actor.userId,
      role: actor.role,
      via: actor.via,
      previousState: previousState ?? enabled,
      newState: enabled,
      at: new Date().toISOString(),
    };

    let inDb = false;
    if (isConnected()) {
      try {
        const result = await HookModel.updateOne({ name }, { $set: { enabled, lastToggle } });
        inDb = result.matchedCount > 0;
      } catch (err) {
        log.warn({ err, hook: name }, 'MongoDB hook toggle update failed');
      }
    }

    if (!inMemory && !inDb && !settingsPatched) {
      return res.status(404).json({ error: `Hook "${name}" not found` });
    }

    // Mirror onto the in-memory registration so the tooltip works without Mongo.
    const registration = listHooks().find(h => h.name === name);
    if (registration) registration.lastToggle = lastToggle;

    recordAuditEvent({
      tenantId: ctx.tenantId,
      actor,
      action: 'hook.toggle',
      target: name,
      detail: { previousState: previousState ?? null, newState: enabled },
    });

    res.json({ ok: true, name, enabled, settingsPatched, lastToggle });
  });

  // ── Rules (MongoDB first, fallback to memory) ───────

  app.get('/api/rules', async (req: Request, res: Response) => {
    try {
      if (isConnected()) {
        const filter: Record<string, unknown> = {};
        if (typeof req.query.category === 'string') filter.category = req.query.category;
        const rules = await RuleModel.find(filter).select('-content -__v').sort({ category: 1, name: 1 }).lean();
        return res.json({ count: rules.length, source: 'mongodb', rules });
      }
    } catch (err) {
      log.warn({ err }, 'MongoDB rule query failed — falling back to memory');
    }

    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const rules = listRules(category);
    res.json({
      count: rules.length,
      source: 'memory',
      rules: rules.map(r => ({
        name: r.name,
        description: r.description,
        category: r.category,
      })),
    });
  });

  app.get('/api/rules/:name', async (req: Request, res: Response) => {
    try {
      if (isConnected()) {
        const rule = await RuleModel.findOne({ name: String(req.params.name) }).select('-__v').lean();
        if (rule) return res.json(rule);
      }
    } catch (err) {
      log.warn({ err }, 'MongoDB rule lookup failed — falling back to memory');
    }

    const rule = getRule(String(req.params.name));
    if (!rule) return res.status(404).json({ error: `Rule "${String(req.params.name)}" not found` });
    res.json(rule);
  });

  // ── Managed Repos ───────────────────────────────────

  // App-directory cards — one-point pointer per repo (URLs + status).
  app.get('/api/repos-cards', async (req: Request, res: Response) => {
    const cards = await listRepoCards(ctxFromReq(req).tenantId);
    res.json({ count: cards.length, cards });
  });

  app.post('/api/repos-cards', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.repoName) return res.status(400).json({ error: 'repoName required' });
    const card = await upsertRepoCard(ctxFromReq(req).tenantId, {
      repoName: b.repoName as string,
      description: b.description as string | undefined,
      group: b.group as string | undefined,
      localhostUrl: b.localhostUrl as string | undefined,
      appUrl: b.appUrl as string | undefined,
      apiUrl: b.apiUrl as string | undefined,
      mongo: b.mongo as string | undefined,
      vercelUrl: b.vercelUrl as string | undefined,
      dnsUrl: b.dnsUrl as string | undefined,
      lastStatus: b.lastStatus as string | undefined,
      lastStatusLevel: b.lastStatusLevel as RepoCardLevel | undefined,
      reportedBy: b.reportedBy as string | undefined,
    });
    if (!card) return res.status(503).json({ error: 'DB not connected' });
    res.status(201).json(card);
  });

  // New-app: idea → agentFlow pipeline + directory registration.
  // Backs the `myai new-app "<idea>"` CLI command; shares the new_app MCP handler.
  app.post('/api/new-app', async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.idea || typeof b.idea !== 'string' || !b.idea.trim()) {
        return res.status(400).json({ error: 'idea required' });
      }
      const result = await executeTool('new_app', b, ctxFromReq(req)) as { ok?: boolean; error?: string };
      // The handler always registers the directory card; an agentFlow trigger
      // failure surfaces as { ok: false, error } but is still a 200 (the app is
      // tracked) so the CLI can report the partial outcome.
      res.status(result.ok ? 201 : 200).json(result);
    } catch (err) {
      log.error({ err }, 'new-app failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Brain — git-versioned agent memory (BRAIN B2). REST parity for the
  // read/write verbs the dashboard and host scripts need; the session verbs
  // (branch/checkout/merge/revert) stay MCP-only. All routes delegate to
  // executeTool so ADR-010 tenant-dir scoping lives in exactly one place.
  const brainRoute = (tool: string, argsOf: (req: Request) => Record<string, unknown>) =>
    async (req: Request, res: Response) => {
      try {
        res.json(await executeTool(tool, argsOf(req), ctxFromReq(req)));
      } catch (err) {
        const msg = (err as Error).message || 'brain error';
        // Every guarded brain failure is prefixed "brain: " — caller error, not server fault.
        res.status(msg.startsWith('brain: ') ? 400 : 500).json({ error: msg });
      }
    };
  app.get('/api/brain', brainRoute('brain_status', () => ({})));
  app.get('/api/brain/explore', brainRoute('brain_explore', (req) => ({
    atomLimit: typeof req.query.atomLimit === 'string' ? parseInt(req.query.atomLimit, 10) : undefined,
  })));
  app.get('/api/brain/log', brainRoute('brain_log', (req) => ({
    ref: typeof req.query.ref === 'string' ? req.query.ref : undefined,
    path: typeof req.query.path === 'string' ? req.query.path : undefined,
    limit: typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined,
  })));
  app.get('/api/brain/diff', brainRoute('brain_diff', (req) => ({
    from: typeof req.query.from === 'string' ? req.query.from : undefined,
    to: typeof req.query.to === 'string' ? req.query.to : undefined,
    path: typeof req.query.path === 'string' ? req.query.path : undefined,
    patch: req.query.patch === '1' || req.query.patch === 'true',
  })));
  app.post('/api/brain/commit', brainRoute('brain_commit', (req) => (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/brain/stash', brainRoute('brain_stash', (req) => (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/brain/pop', brainRoute('brain_pop', (req) => (req.body ?? {}) as Record<string, unknown>));
  // Federated search — one query across every repo namespace's atoms AND the
  // RAG session corpus. The dashboard search box's data source.
  app.get('/api/brain/search', brainRoute('brain_search', (req) => ({
    query: typeof req.query.query === 'string' ? req.query.query : '',
    repo: typeof req.query.repo === 'string' ? req.query.repo : undefined,
    k: typeof req.query.k === 'string' ? parseInt(req.query.k, 10) : undefined,
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
  })));

  // 10-day improvement plan (day-by-day focus schedule per repo).
  app.get('/api/plan', async (req: Request, res: Response) => {
    const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
    const days = await listPlan(ctxFromReq(req).tenantId, repo);
    res.json({ count: days.length, days });
  });

  // First-class handoff store (betaC) — queryable replacement for the
  // git-synced AI_AGENT_HANDOFF.md. Read latest (or per-repo list), write entry.
  app.get('/api/handoff', async (req: Request, res: Response) => {
    const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
    const tenantId = ctxFromReq(req).tenantId;
    if (!repo) {
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
      const handoffs = await listLatestHandoffs(tenantId, Number.isFinite(limit) ? limit : 100);
      return res.json({ count: handoffs.length, handoffs });
    }
    const history = typeof req.query.history === 'string' ? parseInt(req.query.history, 10) : 0;
    const result = await readHandoff(tenantId, repo, { historyLimit: Number.isFinite(history) ? history : 0 });
    res.json(result);
  });

  app.post('/api/handoff', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.repo) return res.status(400).json({ error: 'repo required' });
    if (!b.content || !String(b.content).trim()) return res.status(400).json({ error: 'content required' });
    const handoff = await writeHandoff(ctxFromReq(req).tenantId, {
      repo: b.repo as string,
      content: b.content as string,
      summary: b.summary as string | undefined,
      author: b.author as string | undefined,
      branch: b.branch as string | undefined,
      machine: b.machine as string | undefined,
      sessionId: b.sessionId as string | undefined,
    });
    if (!handoff) return res.status(503).json({ error: 'DB not connected' });
    res.status(201).json(handoff);
  });

  app.get('/api/repos', (_req: Request, res: Response) => {
    const config = getConfig();
    const reposFile = resolve(config.aiRoot, 'config', 'managed_repos.txt');

    if (!existsSync(reposFile)) {
      return res.json({ count: 0, repos: [], error: 'managed_repos.txt not found' });
    }

    const raw = readFileSync(reposFile, 'utf-8');
    const lines = raw.split('\n');
    const repos = [];
    let currentGroup = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('#')) {
        currentGroup = trimmed.replace(/^#+\s*/, '').replace(/\s*—.*$/, '').trim();
        continue;
      }

      const repoPath = trimmed.replace('~/', `${process.env.HOME || '/root'}/`);
      const name = basename(repoPath);

      // Check accessibility (works on host, not inside Docker container)
      const aiDir = existsSync(resolve(repoPath, 'AI'));
      const stateFile = resolve(repoPath, 'AI', 'state', 'STATE.md');
      const claudeFile = resolve(repoPath, 'AI', 'CLAUDE.md');
      const geminiFile = resolve(repoPath, 'AI', 'GEMINI.md');

      const hasState = existsSync(stateFile);
      const hasClaude = existsSync(claudeFile);
      const hasGemini = existsSync(geminiFile);

      let stateFresh = false;
      if (hasState) {
        try {
          const stat = statSync(stateFile);
          const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
          stateFresh = ageHours < 72;
        } catch { /* ignore */ }
      }

      repos.push({
        name,
        path: trimmed,
        group: currentGroup,
        accessible: aiDir,
        aiDir,
        stateExists: hasState,
        stateFresh,
        claudeMd: hasClaude,
        geminiMd: hasGemini,
      });
    }

    res.json({ count: repos.length, repos });
  });

  // ── Channels ─────────────────────────────────────────

  app.get('/api/channels', (_req: Request, res: Response) => {
    const adapters = listAdapters();
    res.json({
      count: adapters.length,
      activeSessions: getChannelSessionCount(),
      channels: adapters.map(a => ({
        type: a.type,
        enabled: a.enabled,
      })),
    });
  });

  // ── Memory / SONA ───────────────────────────────────

  app.post('/api/memory/search', async (req: Request, res: Response) => {
    try {
      const { query, tags, topN } = req.body;
      if (!query && (!tags || tags.length === 0)) {
        return res.status(400).json({ error: 'query or tags required' });
      }
      const results = await hybridSearch(query || '', tags || [], topN);
      res.json({ count: results.length, results });
    } catch (err) {
      log.error({ err }, 'Memory search failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/memory/context', async (req: Request, res: Response) => {
    try {
      const { query, tags, maxTokens } = req.body;
      if (!query) return res.status(400).json({ error: 'query required' });
      const context = await buildContext(query, tags || [], maxTokens);
      res.json(context);
    } catch (err) {
      log.error({ err }, 'Context build failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Memory bundle export / import (`myai memory export|import`) ─────
  // Portable corpus: JSON manifest + markdown files, no embeddings — import
  // re-embeds on this gateway and dedups by content hash.

  app.get('/api/memory/export', async (req: Request, res: Response) => {
    try {
      const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      if (source && !(VECTOR_SOURCES as string[]).includes(source)) {
        return res.status(400).json({ error: `source must be one of ${VECTOR_SOURCES.join('|')}` });
      }
      const ctx = ctxFromReq(req);
      const bundle = await exportMemoryBundle(ctx.tenantId, {
        repo,
        source: source as (typeof VECTOR_SOURCES)[number] | undefined,
      });
      res.json(bundle);
      // Bulk-export detector input (security-anomaly-alerter).
      recordAuditEvent({
        tenantId: ctx.tenantId,
        actor: auditActorFromCtx(ctx),
        action: 'data.export',
        target: 'memory-bundle',
        detail: { repo, source, fileCount: bundle.files?.length },
      });
    } catch (err) {
      log.error({ err }, 'Memory export failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/memory/import', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'work')) return; // RBAC: memory import is `work` (ADR-013 §3)
      const b = (req.body ?? {}) as { manifest?: Partial<MemoryBundleManifest>; files?: MemoryBundleFile[] };
      if (!Array.isArray(b.files) || b.files.length === 0) {
        return res.status(400).json({ error: 'files required — array of { path, content }' });
      }
      const result = await importMemoryBundle(ctxFromReq(req).tenantId, { manifest: b.manifest, files: b.files });
      res.json(result);
    } catch (err) {
      log.error({ err }, 'Memory import failed');
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Vectors (RAG) ───────────────────────────────────

  // Full vector corpus WITH embeddings — the lossless dump behind
  // `myai context export`. The memory bundle above is embedding-free; this is
  // for operators who want to own + restore the exact vectors.
  app.get('/api/vectors/export', async (req: Request, res: Response) => {
    try {
      const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      if (source && !(VECTOR_SOURCES as string[]).includes(source)) {
        return res.status(400).json({ error: `source must be one of ${VECTOR_SOURCES.join('|')}` });
      }
      const ctx = ctxFromReq(req);
      const corpus = await exportVectorCorpus(ctx.tenantId, {
        repo,
        source: source as (typeof VECTOR_SOURCES)[number] | undefined,
      });
      res.json(corpus);
      // Bulk-export detector input (security-anomaly-alerter).
      recordAuditEvent({
        tenantId: ctx.tenantId,
        actor: auditActorFromCtx(ctx),
        action: 'data.export',
        target: 'vector-corpus',
        detail: { repo, source, entryCount: corpus.count },
      });
    } catch (err) {
      log.error({ err }, 'Vector corpus export failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/vectors/import', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'work')) return; // RBAC: vector import is `work` (ADR-013 §3)
      const b = (req.body ?? {}) as {
        kind?: string; formatVersion?: number;
        embedding?: { dimensions?: number }; entries?: Partial<VectorCorpusEntry>[];
      };
      if (!Array.isArray(b.entries)) {
        return res.status(400).json({ error: 'entries required — array of corpus entries' });
      }
      const result = await importVectorCorpus(ctxFromReq(req).tenantId, b);
      res.json(result);
    } catch (err) {
      log.error({ err }, 'Vector corpus import failed');
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/vectors/search', async (req: Request, res: Response) => {
    try {
      const { query, repo, source, tags, limit } = req.body;
      if (!query) return res.status(400).json({ error: 'query required' });
      const results = await searchVectors(ctxFromReq(req).tenantId, { query, repo, source, tags, limit });
      res.json({ count: results.length, results });
    } catch (err) {
      log.error({ err }, 'Vector search failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/vectors/stats', async (req: Request, res: Response) => {
    try {
      const total = await getVectorCount(ctxFromReq(req).tenantId);
      res.json({ total });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/vectors/index', async (req: Request, res: Response) => {
    try {
      const { scope } = req.body;
      const results = scope === 'all' ? await indexAllRepos() : await indexMasterRepo();
      const totalStored = results.reduce((s, r) => s + r.stored, 0);
      res.json({ scope: scope || 'master', totalStored, results });
    } catch (err) {
      log.error({ err }, 'Indexing failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Sessions ─────────────────────────────────────────

  app.post('/api/sessions', async (req: Request, res: Response) => {
    try {
      const { agentName, metadata } = req.body;
      if (!agentName) return res.status(400).json({ error: 'agentName required' });

      const agent = getAgent(agentName);
      if (!agent) return res.status(404).json({ error: `Agent "${agentName}" not found` });

      const session = await createSession(ctxFromReq(req).tenantId, agentName, metadata || {});
      res.status(201).json({ sessionId: session.id, agentName: session.agentName, status: session.status });
    } catch (err) {
      log.error({ err }, 'Failed to create session');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/sessions', (req: Request, res: Response) => {
    const all = listSessions(undefined, ctxFromReq(req).tenantId);
    res.json({
      count: all.length,
      sessions: all.map(s => ({
        id: s.id,
        agentName: s.agentName,
        status: s.status,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
      })),
    });
  });

  // Static sub-path — MUST precede `/api/sessions/:id` so it isn't swallowed as id="recall".
  app.get('/api/sessions/recall', async (req: Request, res: Response) => {
    const tenantId = ctxFromReq(req).tenantId;
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
    const per = typeof req.query.perSessionMessages === 'string' ? parseInt(req.query.perSessionMessages, 10) : undefined;
    const result = await recallSessionContext(tenantId, {
      agentName: typeof req.query.agentName === 'string' ? req.query.agentName : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      perSessionMessages: Number.isFinite(per) ? per : undefined,
    });
    res.json(result);
  });

  app.get('/api/sessions/:id', (req: Request, res: Response) => {
    const session = getSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({
      id: session.id,
      agentName: session.agentName,
      status: session.status,
      messageCount: session.messages.length,
      messages: session.messages.slice(-20),
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      metadata: session.metadata,
    });
  });

  app.delete('/api/sessions/:id', async (req: Request, res: Response) => {
    try {
      await closeSession(String(req.params.id));
      res.json({ status: 'closed' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Session export / import + cross-session recall (betaC context-sharing) ─
  // Lets a session's context follow the user between devices. Export → portable
  // bundle; import on another device (stamped with the importing tenant); recall →
  // a ready-to-inject digest of recent cross-session activity.

  app.get('/api/sessions/:id/export', async (req: Request, res: Response) => {
    const bundle = await exportSession(ctxFromReq(req).tenantId, String(req.params.id));
    if (!bundle) return res.status(404).json({ error: 'Session not found' });
    res.json(bundle);
  });

  app.post('/api/sessions/import', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const bundle = (b.bundle ?? b) as SessionExport;
    if (!bundle || typeof bundle !== 'object' || !(bundle as SessionExport).session) {
      return res.status(400).json({ error: 'bundle required' });
    }
    try {
      const session = await importSession(ctxFromReq(req).tenantId, bundle, { preserveId: Boolean(b.preserveId) });
      res.status(201).json({ sessionId: session.id, agentName: session.agentName, messageCount: session.messages.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Messages ─────────────────────────────────────────

  app.post('/api/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const { content, metadata } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });

      const session = getSession(String(req.params.id));
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const result = await routeMessage(session.id, session.agentName, content, metadata || {});
      res.json({
        sessionId: result.sessionId,
        agentName: result.agentName,
        messageId: result.message.id,
        response: result.response,
      });
    } catch (err) {
      log.error({ err }, 'Failed to route message');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Budget admin endpoints ──────────────────────────
  //
  // Three read-only endpoints, all gated by `X-Admin-Token` matching the
  // `ADMIN_API_TOKEN` env var. The token is intentionally separate from the
  // chat/channel auth — these endpoints expose spend data for ops, not for
  // end-user channels.
  //
  // If `ADMIN_API_TOKEN` is unset, the endpoints return 503: we cannot grant
  // access without a configured token. This is more conservative than
  // returning 401 (a 401 might suggest the token is wrong; 503 makes it clear
  // the server is not configured for admin access).
  //
  // Audit-log line is emitted on each successful request — token is never
  // logged, request body is not read.

  function requireAdmin(req: Request, res: Response, next: () => void): void {
    const expected = process.env.ADMIN_API_TOKEN;
    if (!expected) {
      res.status(503).json({ error: 'admin_disabled', code: 'ADMIN_DISABLED' });
      return;
    }
    const provided = req.header('x-admin-token');
    if (!provided || provided !== expected) {
      res.status(401).json({ error: 'unauthorized', code: 'UNAUTHORIZED' });
      return;
    }
    next();
  }

  app.get('/api/budgets/status', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      log.info({ route: '/api/budgets/status', ip: req.ip }, 'budget admin endpoint accessed');
      try {
        const status = await getBudgetStatus(ctxFromReq(req).tenantId);
        res.json(status);
      } catch (err) {
        log.error({ err }, 'budgets/status failed');
        res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
      }
    });
  });

  app.get('/api/budgets/breakdown', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      log.info({ route: '/api/budgets/breakdown', ip: req.ip }, 'budget admin endpoint accessed');
      try {
        const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
        const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;

        let from: Date | undefined;
        let to: Date | undefined;
        if (fromRaw) {
          const d = new Date(fromRaw);
          if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid from timestamp', code: 'BAD_REQUEST' });
          from = d;
        }
        if (toRaw) {
          const d = new Date(toRaw);
          if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid to timestamp', code: 'BAD_REQUEST' });
          to = d;
        }

        const breakdown = await getBudgetBreakdown(ctxFromReq(req).tenantId, { from, to });
        res.json(breakdown);
      } catch (err) {
        log.error({ err }, 'budgets/breakdown failed');
        res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
      }
    });
  });

  app.get('/api/budgets/usage', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      log.info({ route: '/api/budgets/usage', ip: req.ip }, 'budget admin endpoint accessed');
      try {
        const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
        const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;
        const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : undefined;
        const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
        const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
        const limitRaw = typeof req.query.limit === 'string' ? req.query.limit : undefined;

        let from: Date | undefined;
        let to: Date | undefined;
        if (fromRaw) {
          const d = new Date(fromRaw);
          if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid from timestamp', code: 'BAD_REQUEST' });
          from = d;
        }
        if (toRaw) {
          const d = new Date(toRaw);
          if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid to timestamp', code: 'BAD_REQUEST' });
          to = d;
        }

        let limit: number | undefined;
        if (limitRaw !== undefined) {
          const n = Number(limitRaw);
          if (!Number.isFinite(n)) return res.status(400).json({ error: 'invalid limit', code: 'BAD_REQUEST' });
          limit = n;
        }

        const usage = await getBudgetUsage(ctxFromReq(req).tenantId, { from, to, channelId, provider, userId, limit, cursor });
        res.json(usage);
      } catch (err) {
        log.error({ err }, 'budgets/usage failed');
        res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
      }
    });
  });

  // Phase 5b §8 follow-up — adaptive cap suggestions. Read-only: like the
  // routes above, there is no corresponding PUT — caps stay env-driven and
  // restart-gated (plan/PHASE_5B_BUDGET_GUARDS.md §3.5). This endpoint only
  // ever *suggests*; nothing here mutates config.
  app.get('/api/budgets/suggestions', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      log.info({ route: '/api/budgets/suggestions', ip: req.ip }, 'budget admin endpoint accessed');
      try {
        const lookbackRaw = typeof req.query.lookbackDays === 'string' ? req.query.lookbackDays : undefined;
        let lookbackDays: number | undefined;
        if (lookbackRaw !== undefined) {
          const n = Number(lookbackRaw);
          if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'invalid lookbackDays', code: 'BAD_REQUEST' });
          lookbackDays = n;
        }

        const suggestions = await getBudgetCapSuggestions(ctxFromReq(req).tenantId, { lookbackDays });
        res.json(suggestions);
      } catch (err) {
        log.error({ err }, 'budgets/suggestions failed');
        res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
      }
    });
  });

  // ── Usage meter (product events — ADR-014 S2 slice 2) ─
  //
  // The read side of the PRODUCT meter (UsageEvent), sibling to the budget
  // (resource-meter) endpoints above. Same operator-token gate. `/summary`
  // returns quantity totals per group key (the invoicing-contract read);
  // `/breakdown` returns the multi-dimension rollup (tool / member / repo /
  // day) the dashboard `/system → Usage` tab renders.

  app.get('/api/usage/summary', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      log.info({ route: '/api/usage/summary', ip: req.ip }, 'usage admin endpoint accessed');
      try {
        const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
        const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;
        const groupByRaw = typeof req.query.groupBy === 'string' ? req.query.groupBy : undefined;

        let from: Date | undefined;
        let to: Date | undefined;
        if (fromRaw) {
          const d = new Date(fromRaw);
          if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid from timestamp', code: 'BAD_REQUEST' });
          from = d;
        }
        if (toRaw) {
          const d = new Date(toRaw);
          if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid to timestamp', code: 'BAD_REQUEST' });
          to = d;
        }

        let groupBy: 'type' | 'day' | 'repo' | undefined;
        if (groupByRaw !== undefined) {
          if (groupByRaw !== 'type' && groupByRaw !== 'day' && groupByRaw !== 'repo') {
            return res.status(400).json({ error: 'groupBy must be one of type|day|repo', code: 'BAD_REQUEST' });
          }
          groupBy = groupByRaw;
        }

        const summary = await summarizeUsage(ctxFromReq(req).tenantId, { from, to, groupBy });
        res.json(summary);
      } catch (err) {
        log.error({ err }, 'usage/summary failed');
        res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
      }
    });
  });

  app.get('/api/usage/breakdown', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      log.info({ route: '/api/usage/breakdown', ip: req.ip }, 'usage admin endpoint accessed');
      try {
        const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
        const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;

        let from: Date | undefined;
        let to: Date | undefined;
        if (fromRaw) {
          const d = new Date(fromRaw);
          if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid from timestamp', code: 'BAD_REQUEST' });
          from = d;
        }
        if (toRaw) {
          const d = new Date(toRaw);
          if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid to timestamp', code: 'BAD_REQUEST' });
          to = d;
        }

        const breakdown = await getUsageBreakdown(ctxFromReq(req).tenantId, { from, to });
        res.json(breakdown);
      } catch (err) {
        log.error({ err }, 'usage/breakdown failed');
        res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
      }
    });
  });

  // ── Schedules ────────────────────────────────────────
  //
  // CRUD mirrors the schedules_* MCP tools — same store module
  // (scheduler/schedule-store.js), same cron validation, same nextRun
  // computation. Mutations are unauthenticated to match MCP behavior.

  app.get('/api/schedules', async (req: Request, res: Response) => {
    try {
      const filter: ListSchedulesFilter = {};
      if (req.query.enabled === 'true') filter.enabled = true;
      else if (req.query.enabled === 'false') filter.enabled = false;
      if (typeof req.query.kind === 'string') filter.kind = req.query.kind as ScheduleKind;
      if (typeof req.query.status === 'string') filter.status = req.query.status as ScheduleStatus;
      if (typeof req.query.limit === 'string') {
        const n = Number(req.query.limit);
        if (!Number.isFinite(n)) return res.status(400).json({ error: 'invalid limit' });
        filter.limit = n;
      }
      const schedules = await listSchedules(ctxFromReq(req).tenantId, filter);
      res.json({ count: schedules.length, schedules });
    } catch (err) {
      log.error({ err }, 'Failed to list schedules');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/schedules', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'configure')) return; // RBAC: schedule create is `configure` (ADR-013 §3)
      const { name, cronExpr, kind, target, message, repo, includeMemoryContext, enabled } = req.body ?? {};
      if (!name || !cronExpr || !kind || !target || !message) {
        return res.status(400).json({ error: 'name, cronExpr, kind, target, and message required' });
      }
      if (kind !== 'agent' && kind !== 'skill' && kind !== 'tool') {
        return res.status(400).json({ error: 'kind must be one of: agent, skill, tool' });
      }
      if (!isValidCronExpr(cronExpr)) {
        return res.status(400).json({ error: `Invalid cron expression: "${cronExpr}". Use 5-field format (min hour day month dow), e.g. "0 9 * * *".` });
      }
      const schedule = await createSchedule(ctxFromReq(req).tenantId, {
        name,
        cronExpr,
        kind,
        target,
        message,
        repo,
        includeMemoryContext,
        enabled,
        nextRun: computeNextRun(cronExpr),
      });
      res.status(201).json(schedule);
    } catch (err) {
      log.error({ err }, 'Failed to create schedule');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/schedules/:id', async (req: Request, res: Response) => {
    try {
      const schedule = await getSchedule(ctxFromReq(req).tenantId, String(req.params.id));
      if (!schedule) return res.status(404).json({ error: `Schedule "${String(req.params.id)}" not found` });
      res.json(schedule);
    } catch (err) {
      log.error({ err }, 'Failed to get schedule');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/schedules/:id', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'configure')) return; // RBAC: schedule update is `configure` (ADR-013 §3)
      const { name, cronExpr, message, repo, includeMemoryContext, enabled } = req.body ?? {};
      if (cronExpr !== undefined && !isValidCronExpr(cronExpr)) {
        return res.status(400).json({ error: `Invalid cron expression: "${cronExpr}".` });
      }
      const updated = await updateSchedule(ctxFromReq(req).tenantId, {
        scheduleId: String(req.params.id),
        name,
        cronExpr,
        message,
        repo,
        includeMemoryContext,
        enabled,
        // Same rule as the schedules_update MCP handler: recompute nextRun
        // only when the cron expression changes.
        nextRun: cronExpr !== undefined ? computeNextRun(cronExpr) : undefined,
      });
      if (!updated) return res.status(404).json({ error: `Schedule "${String(req.params.id)}" not found` });
      res.json(updated);
    } catch (err) {
      log.error({ err }, 'Failed to update schedule');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/schedules/:id', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'configure')) return; // RBAC: schedule delete is `configure` (ADR-013 §3)
      const scheduleId = String(req.params.id);
      const deleted = await deleteSchedule(ctxFromReq(req).tenantId, scheduleId);
      if (!deleted) return res.status(404).json({ error: `Schedule "${scheduleId}" not found` });
      res.json({ deleted: true, scheduleId });
    } catch (err) {
      log.error({ err }, 'Failed to delete schedule');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/schedules/:id/run', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'configure')) return; // RBAC: manual run is `configure` (ADR-013 §3)
      const scheduleId = String(req.params.id);
      // Delegate to the schedules_run_now MCP handler so manual REST runs share
      // its exact dispatch + recordRunResult behavior (preserved nextRun, etc.).
      const result = await executeTool('schedules_run_now', { scheduleId }, ctxFromReq(req)) as { error?: string; dispatched?: boolean };
      // Not-found comes back as a bare { error } with no `dispatched` key;
      // dispatch failures include { dispatched: false } and are still 200
      // because the run was processed and recorded against the schedule.
      if (result && typeof result.error === 'string' && result.dispatched === undefined) {
        return res.status(404).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      log.error({ err }, 'Failed to run schedule');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Tasks ────────────────────────────────────────────
  //
  // Mirrors the tasks_* MCP tools — same store module (tasks/task-store.js),
  // same filters, same defaulting (priority P2, source manual).

  app.get('/api/tasks', async (req: Request, res: Response) => {
    try {
      const filter: ListTasksFilter = {};
      if (typeof req.query.repo === 'string') filter.repo = req.query.repo;
      if (typeof req.query.status === 'string') filter.status = req.query.status as TaskStatus;
      if (typeof req.query.priority === 'string') filter.priority = req.query.priority as TaskPriority;
      if (typeof req.query.assignedAgent === 'string') filter.assignedAgent = req.query.assignedAgent;
      if (typeof req.query.limit === 'string') {
        const n = Number(req.query.limit);
        if (!Number.isFinite(n)) return res.status(400).json({ error: 'invalid limit' });
        filter.limit = n;
      }
      const tasks = await listTasks(ctxFromReq(req).tenantId, filter);
      res.json({ count: tasks.length, tasks });
    } catch (err) {
      log.error({ err }, 'Failed to list tasks');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/tasks/next', async (req: Request, res: Response) => {
    try {
      const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
      const tenantId = ctxFromReq(req).tenantId;
      const task = await nextTask(tenantId, repo);
      if (!task) return res.json({ message: 'No pending tasks' });
      const counts = await countTasks(tenantId, { repo });
      res.json({ task, queueSummary: counts });
    } catch (err) {
      log.error({ err }, 'Failed to get next task');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/tasks', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'work')) return; // RBAC: task creation is `work` (ADR-013 §3)
      const { repo, title, description, priority, assignedAgent, recommendedModel, source, sourceId, notes } = req.body ?? {};
      if (!repo || !title) return res.status(400).json({ error: 'repo and title required' });
      const ctx = ctxFromReq(req);
      // Plan-tier repo cap (hard cap) — only relevant when this repo is NEW for
      // the tenant; a repo already in flight keeps queueing tasks freely.
      if (!ctx.local) {
        const known = await tenantRepos(ctx.tenantId);
        const verdict = verdictFor('repos', ctx.plan ?? 'free', known.length + (known.includes(repo) ? 0 : 1));
        if (!verdict.allowed) throw new EntitlementError(verdict);
      }
      const task = await createTask(ctx.tenantId, { repo, title, description, priority, assignedAgent, recommendedModel, source, sourceId, notes });
      res.status(201).json(task);
    } catch (err) {
      if (err instanceof EntitlementError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...err.verdict });
        return;
      }
      log.error({ err }, 'Failed to create task');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/tasks/:id', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'work')) return; // RBAC: task update is `work` (ADR-013 §3)
      const { repo, status, priority, assignedAgent, recommendedModel, prUrl, notes, telegramMessageId, supersededBy, operatorAuthorized } = req.body ?? {};
      const task = await updateTask(ctxFromReq(req).tenantId, {
        taskId: String(req.params.id),
        repo,
        status,
        priority,
        assignedAgent,
        recommendedModel,
        prUrl,
        notes,
        telegramMessageId,
        supersededBy,
        operatorAuthorized,
      });
      if (!task) return res.status(404).json({ error: `Task "${String(req.params.id)}" not found` });
      res.json(task);
    } catch (err) {
      if (err instanceof BulkBlockGuardError) {
        res.status(409).json({ error: err.message, code: 'BULK_BLOCK_GUARD' });
        return;
      }
      log.error({ err }, 'Failed to update task');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Live task-output relay (streaming runner log over SSE) ──
  //
  // Distinct from the lifecycle-event SSE stream above (/api/notifications/
  // stream — dotted task/plan/runner state transitions): this streams the
  // raw in-progress log *body* of one running task so the dashboard can
  // render live tail output mid-task. The runner POSTs incremental chunks as
  // it produces them; the dashboard opens the SSE stream to receive them
  // (plus a short backlog for replay on late-open). Tenant scoping is
  // enforced here, once, via the tenant-scoped `getTask` lookup — the relay
  // module itself only ever sees already-authorized taskIds.

  app.post('/api/tasks/:id/log', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'work')) return; // RBAC: log ingest is a runner `work` action (ADR-013 §3)
      const taskId = String(req.params.id);
      const task = await getTask(ctxFromReq(req).tenantId, taskId);
      if (!task) return res.status(404).json({ error: `Task "${taskId}" not found`, code: 'NOT_FOUND' });

      const { text, stream, done } = req.body ?? {};
      if (done) {
        taskLogRelay.end(taskId);
        return res.json({ ok: true, done: true });
      }
      if (typeof text !== 'string' || !text) {
        return res.status(400).json({ error: 'text required', code: 'BAD_REQUEST' });
      }
      if (stream !== undefined && stream !== 'stdout' && stream !== 'stderr') {
        return res.status(400).json({ error: 'stream must be "stdout" or "stderr"', code: 'BAD_REQUEST' });
      }
      const chunk = taskLogRelay.append(taskId, { text, stream });
      res.json({ ok: true, seq: chunk.seq });
    } catch (err) {
      log.error({ err }, 'Failed to append task log chunk');
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  app.get('/api/tasks/:id/log/stream', async (req: Request, res: Response) => {
    const taskId = String(req.params.id);
    try {
      const task = await getTask(ctxFromReq(req).tenantId, taskId);
      if (!task) return res.status(404).json({ error: `Task "${taskId}" not found`, code: 'NOT_FOUND' });
    } catch (err) {
      log.error({ err, taskId }, 'Failed to resolve task for log stream');
      return res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    (res as unknown as { flush?: () => void }).flush?.();

    const rawSend = (chunk: TaskLogChunk): boolean => {
      // Node's Writable#write return value IS the backpressure signal: false
      // means the internal buffer is over highWaterMark and the caller
      // should wait for 'drain' before writing more.
      res.write(`event: ${chunk.dropped ? 'log.gap' : chunk.done ? 'log.end' : 'log.chunk'}\n`);
      return res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    const send = wrapBackpressureSafe(rawSend, resume => res.once('drain', resume));

    const { backlog, unsubscribe } = taskLogRelay.subscribe(taskId, send);
    for (const chunk of backlog) send(chunk);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* socket already gone — close handler will clean up */
      }
    }, 25_000);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  // ── Orchestration (fleet overview + dispatch cycle) ──

  app.get('/api/fleet', async (req: Request, res: Response) => {
    try {
      // Same code path as the fleet_overview MCP tool (handler degrades
      // gracefully per section when the DB is unavailable).
      const overview = await executeTool('fleet_overview', {}, ctxFromReq(req));
      res.json(overview);
    } catch (err) {
      log.error({ err }, 'Fleet overview failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Admin-gated: a dispatch cycle invokes specialist agents and spends real
  // LLM budget, so unlike the schedule/task CRUD above it requires the
  // X-Admin-Token header (same gate as the budget endpoints).
  app.post('/api/dispatch', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      log.info({ route: '/api/dispatch', ip: req.ip }, 'dispatch endpoint accessed');
      try {
        // Delegate to the dispatch_cycle MCP handler so REST and MCP share
        // identical input handling (maxTasks clamped 1–10, dailySpendCapUsd
        // accepting numeric strings, optional telegramChatId).
        const result = await executeTool('dispatch_cycle', (req.body ?? {}) as Record<string, unknown>, ctxFromReq(req));
        res.json(result);
      } catch (err) {
        log.error({ err }, 'dispatch cycle failed');
        res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
      }
    });
  });

  // ── Agent runtime (Phase 6) ──────────────────────────────
  // Admin-gated like /api/dispatch: an in-gateway agent run spends real LLM
  // budget. With no LLM configured the run returns the constructed prompt
  // (passthrough mode, executed: false).

  app.post('/api/agents/:name/execute', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      try {
        const { task, maxTokens, maxSkills, includeMemory, sessionId } = (req.body ?? {}) as Record<string, unknown>;
        if (typeof task !== 'string' || !task.trim()) {
          return res.status(400).json({ error: 'task (string) required' });
        }
        const result = await executeAgent(String(req.params.name), task, {
          sessionId: typeof sessionId === 'string' ? sessionId : undefined,
          maxTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
          maxSkills: typeof maxSkills === 'number' ? maxSkills : undefined,
          includeMemory: typeof includeMemory === 'boolean' ? includeMemory : undefined,
        });
        res.json(result);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('not found')) return res.status(404).json({ error: message });
        log.error({ err, agent: req.params.name }, 'Agent execute failed');
        res.status(500).json({ error: message });
      }
    });
  });

  app.get('/api/pipeline/stages', (_req: Request, res: Response) => {
    const stages = loadStages();
    res.json({ count: stages.length, stages: stages.map(s => ({ id: s.id, name: s.name, description: s.description })) });
  });

  app.post('/api/pipeline/run', (req: Request, res: Response) => {
    requireAdmin(req, res, async () => {
      try {
        const { idea, fromStage, toStage, maxTokens } = (req.body ?? {}) as Record<string, unknown>;
        if (typeof idea !== 'string' || !idea.trim()) {
          return res.status(400).json({ error: 'idea (string) required' });
        }
        const result = await runPipeline(idea, {
          fromStage: typeof fromStage === 'string' ? fromStage : undefined,
          toStage: typeof toStage === 'string' ? toStage : undefined,
          executeOptions: typeof maxTokens === 'number' ? { maxTokens } : undefined,
        });
        res.json(result);
      } catch (err) {
        log.error({ err }, 'Pipeline run failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });
  });

  // ── Webhooks ─────────────────────────────────────────────
  //
  // GitHub webhook receiver — inbound events → task create/advance. Two
  // routes share one implementation:
  //   POST /api/webhooks/github            legacy/self-host: single secret
  //                                        from GITHUB_WEBHOOK_SECRET, scoped
  //                                        to the default tenant. Unchanged
  //                                        behaviour for existing installs.
  //   POST /api/webhooks/github/:tenantId  per-tenant: secret resolved from
  //                                        that tenant's own
  //                                        Tenant.githubWebhookSecret (falls
  //                                        back to the env var only for the
  //                                        default tenant) — each tenant
  //                                        points their repos at their own
  //                                        URL instead of sharing one secret.
  //
  // Both dedupe by x-github-delivery (InboundWebhookDeliveryModel, unique per
  // tenant+source+deliveryId — inbound-webhook-store.ts) so a GitHub-retried
  // delivery is a no-op instead of double-creating a task.
  //
  // Signature verification uses the parsed body stringified back to JSON —
  // this works because GitHub sends JSON with Content-Type: application/json
  // and Express re-serialises deterministically for payloads that round-trip
  // cleanly (which GitHub's do).

  async function receiveGithubWebhook(tenantId: string, req: Request, res: Response): Promise<void> {
    const event = req.headers['x-github-event'] as string || '';
    const signature = req.headers['x-hub-signature-256'] as string || '';
    const delivery = req.headers['x-github-delivery'] as string || '';

    const secret = await resolveGithubWebhookSecret(tenantId);
    if (secret) {
      const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!verifySignature(payload, signature, secret)) {
        log.warn({ delivery, event, tenantId }, 'GitHub webhook signature verification failed');
        res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
        return;
      }
    } else {
      log.warn({ tenantId }, 'No GitHub webhook secret configured for tenant — skipping signature verification');
    }

    if (delivery && await isDuplicateDelivery(tenantId, 'github', delivery)) {
      log.info({ delivery, event, tenantId }, 'Duplicate GitHub webhook delivery — skipped');
      res.json({ handled: false, event, summary: 'Duplicate delivery — already processed' });
      return;
    }

    try {
      const headers: Record<string, string> = {
        'x-github-event': event,
        'x-hub-signature-256': signature,
        'x-github-delivery': delivery,
        'x-myai-tenant-id': tenantId,
      };

      const result = await handleGitHubWebhook(headers, req.body);
      res.json(result);
    } catch (err) {
      log.error({ err, delivery, event, tenantId }, 'GitHub webhook handler failed');
      res.status(500).json({ error: 'Webhook processing failed', code: 'WEBHOOK_ERROR' });
    }
  }

  app.post('/api/webhooks/github', (req: Request, res: Response) => {
    void receiveGithubWebhook(DEFAULT_TENANT_ID, req, res);
  });

  app.post('/api/webhooks/github/:tenantId', (req: Request, res: Response) => {
    void receiveGithubWebhook(String(req.params.tenantId), req, res);
  });

  // ── Connect Hub bridge (S1 ticket→task) ──────────────────
  //
  // A managed app's Connect Hub POSTs a triaged bug/feature here and the
  // gateway turns it into a queued task. Signature verification mirrors the
  // GitHub webhook (HMAC-SHA256 over the JSON body), keyed on
  // CONNECT_WEBHOOK_SECRET. The connect-side emit lives in a companion task.

  app.post('/api/webhooks/connect', async (req: Request, res: Response) => {
    const signature = (req.headers['x-connect-signature-256'] as string) || '';
    const secret = process.env.CONNECT_WEBHOOK_SECRET || '';

    if (secret) {
      const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!verifySignature(payload, signature, secret)) {
        log.warn('Connect Hub webhook signature verification failed');
        res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
        return;
      }
    } else {
      log.warn('CONNECT_WEBHOOK_SECRET not set — skipping signature verification');
    }

    try {
      const result = await handleConnectIngest(req.body);
      res.status(result.taskCreated ? 201 : 200).json(result);
    } catch (err) {
      log.error({ err }, 'Connect Hub bridge handler failed');
      res.status(500).json({ error: 'Connect bridge processing failed', code: 'CONNECT_BRIDGE_ERROR' });
    }
  });

  // ── Notifications ─────────────────────────────────────
  //
  // POST sends a notification through the notifier engine.
  // GET retrieves recent notification history from the DB.

  app.post('/api/notifications', async (req: Request, res: Response) => {
    try {
      const { message, channels, chatId, level, title, source } = req.body ?? {};
      if (!message) return res.status(400).json({ error: 'message required', code: 'BAD_REQUEST' });

      const result = await executeTool('notifications_send', { message, channels, chatId, level, title, source }, ctxFromReq(req));
      res.json(result);
    } catch (err) {
      log.error({ err }, 'Failed to send notification');
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── Billing — tenant-facing spend-alert status ────────
  //
  // GET /api/billing/spend-status is the read-side for the tenant-facing
  // 80%/100%-of-plan-included-spend banner (FINOPS): the same status the
  // spend-alert check computes post-call (llm/spend-alert.ts), but on-demand
  // for the dashboard to poll/render without waiting for the next LLM call.
  // Tenant-scoped by the caller's own API key (ctxFromReq), NOT admin-gated —
  // this is the tenant's own spend, unlike /api/budgets/* which is an
  // operator-only view of the internal execution-cap meter.

  app.get('/api/billing/spend-status', async (req: Request, res: Response) => {
    try {
      const status = await getSpendAlertStatus(ctxFromReq(req).tenantId);
      res.json(status);
    } catch (err) {
      log.error({ err }, 'billing/spend-status failed');
      res.status(500).json({ error: 'internal_error', code: 'INTERNAL_ERROR' });
    }
  });

  app.get('/api/notifications', async (req: Request, res: Response) => {
    try {
      const limitRaw = typeof req.query.limit === 'string' ? req.query.limit : undefined;
      let limit = 20;
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'invalid limit', code: 'BAD_REQUEST' });
        limit = Math.min(Math.floor(n), 200);
      }

      const result = await executeTool('notifications_history', { limit }, ctxFromReq(req));
      res.json(result);
    } catch (err) {
      log.error({ err }, 'Failed to retrieve notification history');
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── Notifications — real-time SSE stream ──────────────
  //
  // GET /api/notifications/stream opens a long-lived Server-Sent Events
  // connection. The notification service (event bus → sseManager) pushes events
  // for the caller's tenant only. A heartbeat comment keeps the socket alive
  // through idle-timeout proxies; the connection is torn down on client close.

  app.get('/api/notifications/stream', (req: Request, res: Response) => {
    const { tenantId } = ctxFromReq(req);

    // SSE headers. `securityHeaders` middleware set Cache-Control: no-store
    // already; we override to no-cache and disable proxy buffering so events
    // flush immediately rather than being held in a reverse-proxy buffer.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Open the stream with a comment so EventSource fires `onopen` promptly.
    res.write(': connected\n\n');
    (res as unknown as { flush?: () => void }).flush?.();

    const send = (event: NotifyEvent): void => {
      // Named SSE event (the dotted type) + JSON payload. A client can listen
      // generically via onmessage or per-type via addEventListener(type).
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    sseManager.addClient(tenantId, send);

    // ~25s heartbeat (under the common 30–60s proxy idle window).
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* socket already gone — close handler will clean up */
      }
    }, 25_000);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      sseManager.removeClient(tenantId, send);
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  // ── Notifications — web push subscriptions (Phase 6) ──
  //
  // The dashboard PWA registers its PushManager subscription here; the
  // notification service pushes to it when the tenant has no open SSE
  // connection. 404 on the key endpoint = VAPID not configured (feature off).

  app.get('/api/notifications/vapid-public-key', (_req: Request, res: Response) => {
    const key = getVapidPublicKey();
    if (!key || !isPushConfigured()) {
      return res.status(404).json({ error: 'web push not configured — set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY', code: 'PUSH_NOT_CONFIGURED' });
    }
    res.json({ key });
  });

  app.post('/api/notifications/push-subscriptions', async (req: Request, res: Response) => {
    try {
      const { tenantId } = ctxFromReq(req);
      const sub = req.body?.subscription ?? req.body;
      if (!isValidSubscription(sub)) {
        return res.status(400).json({ error: 'invalid subscription — need { endpoint, keys: { p256dh, auth } }', code: 'BAD_REQUEST' });
      }
      await saveSubscription(tenantId, sub, req.headers['user-agent']);
      const count = await countSubscriptions(tenantId);
      res.status(201).json({ ok: true, subscriptions: count });
    } catch (err) {
      log.error({ err }, 'Failed to save push subscription');
      res.status(503).json({ error: (err as Error).message, code: 'SERVICE_UNAVAILABLE' });
    }
  });

  app.delete('/api/notifications/push-subscriptions', async (req: Request, res: Response) => {
    try {
      const { tenantId } = ctxFromReq(req);
      const endpoint = req.body?.endpoint;
      if (typeof endpoint !== 'string' || !endpoint) {
        return res.status(400).json({ error: 'endpoint required', code: 'BAD_REQUEST' });
      }
      const removed = await removeSubscription(tenantId, endpoint);
      res.json({ ok: true, removed });
    } catch (err) {
      log.error({ err }, 'Failed to remove push subscription');
      res.status(503).json({ error: (err as Error).message, code: 'SERVICE_UNAVAILABLE' });
    }
  });

  // ── Notifications — preferences (Phase 7) ─────────────

  app.get('/api/notifications/preferences', async (req: Request, res: Response) => {
    const { tenantId } = ctxFromReq(req);
    const prefs = await getPreferences(tenantId); // never throws — defaults on DB down
    const subscriptions = await countSubscriptions(tenantId);
    res.json({ ...prefs, pushConfigured: isPushConfigured(), emailConfigured: isEmailConfigured(), subscriptions });
  });

  app.put('/api/notifications/preferences', async (req: Request, res: Response) => {
    const { tenantId } = ctxFromReq(req);
    let patch;
    try {
      patch = sanitizePrefsPatch(req.body);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message, code: 'BAD_REQUEST' });
    }
    try {
      const prefs = await updatePreferences(tenantId, patch);
      res.json({ ...prefs, pushConfigured: isPushConfigured(), emailConfigured: isEmailConfigured() });
    } catch (err) {
      log.error({ err }, 'Failed to update notification preferences');
      res.status(503).json({ error: (err as Error).message, code: 'SERVICE_UNAVAILABLE' });
    }
  });

  // ── Outbound webhooks — tenant-registered integrations ────────────────
  //
  // A tenant registers HTTPS endpoints and subscribes to task/plan/runner
  // lifecycle events. The dispatcher (webhooks/webhook-dispatcher.ts) POSTs an
  // HMAC-signed payload on each matching event with at-least-once delivery. The
  // signing secret is returned ONCE (on create) and never again.

  app.get('/api/webhooks', async (req: Request, res: Response) => {
    try {
      const endpoints = await listWebhookEndpoints(ctxFromReq(req).tenantId);
      res.json({ endpoints, events: WEBHOOK_EVENTS });
    } catch (err) {
      log.error({ err }, 'Failed to list webhooks');
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  app.post('/api/webhooks', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'configure')) return; // RBAC: webhook create is `configure` (ADR-013 §3)
      const { url, events, description } = req.body ?? {};
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url required', code: 'BAD_REQUEST' });
      }
      const endpoint = await createWebhookEndpoint(ctxFromReq(req).tenantId, { url, events, description });
      res.status(201).json({ endpoint });
    } catch (err) {
      // Validation errors (bad url / unknown event) are client errors.
      const msg = (err as Error).message;
      const isValidation = /url must|unknown event|events must/i.test(msg);
      res.status(isValidation ? 400 : 500).json({ error: msg, code: isValidation ? 'BAD_REQUEST' : 'INTERNAL_ERROR' });
    }
  });

  app.put('/api/webhooks/:id', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'configure')) return; // RBAC: webhook update is `configure` (ADR-013 §3)
      const { url, events, active, description } = req.body ?? {};
      const endpoint = await updateWebhookEndpoint(ctxFromReq(req).tenantId, String(req.params.id), { url, events, active, description });
      if (!endpoint) return res.status(404).json({ error: 'endpoint not found', code: 'NOT_FOUND' });
      res.json({ endpoint });
    } catch (err) {
      const msg = (err as Error).message;
      const isValidation = /url must|unknown event|events must/i.test(msg);
      res.status(isValidation ? 400 : 500).json({ error: msg, code: isValidation ? 'BAD_REQUEST' : 'INTERNAL_ERROR' });
    }
  });

  app.delete('/api/webhooks/:id', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'configure')) return; // RBAC: webhook delete is `configure` (ADR-013 §3)
      const removed = await deleteWebhookEndpoint(ctxFromReq(req).tenantId, String(req.params.id));
      if (!removed) return res.status(404).json({ error: 'endpoint not found', code: 'NOT_FOUND' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  app.get('/api/webhooks/deliveries', async (req: Request, res: Response) => {
    try {
      const endpointId = typeof req.query.endpointId === 'string' ? req.query.endpointId : undefined;
      const status = typeof req.query.status === 'string' ? (req.query.status as WebhookDeliveryStatus) : undefined;
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const deliveries = await listWebhookDeliveries(ctxFromReq(req).tenantId, { endpointId, status, limit });
      res.json({ deliveries });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  app.post('/api/webhooks/deliveries/:id/replay', async (req: Request, res: Response) => {
    try {
      if (enforceRbac(req, res, 'configure')) return; // RBAC: webhook replay is `configure` (ADR-013 §3)
      const ok = await replayWebhookDelivery(ctxFromReq(req).tenantId, String(req.params.id));
      if (!ok) return res.status(404).json({ error: 'delivery not found', code: 'NOT_FOUND' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // Mount error handlers AFTER all route definitions
  applyErrorHandlers();

  return app;
}

export function startHttpServer(
  app: ReturnType<typeof createHttpServer>,
  onDrained?: (signal: string) => Promise<void>,
): void {
  const config = getConfig();
  const server = app.listen(config.server.httpPort, config.server.host, () => {
    log.info({ port: config.server.httpPort, host: config.server.host }, 'HTTP server listening');
  });

  setupGracefulShutdown(async (signal) => {
    log.info('Closing HTTP server connections...');
    // Stop the rate-limiter sweep interval so it doesn't leak across restarts.
    try {
      (app.locals.stopRateLimitCleanup as (() => void) | undefined)?.();
    } catch (err) {
      log.warn({ err }, 'Failed to stop rate-limit cleanup interval');
    }
    // server.close() stops accepting NEW connections immediately (so /readyz
    // flipping to not-ready above actually matters) and waits for in-flight
    // requests to finish before resolving — the drain. Only once that's done
    // do we tear down schedulers/channels/etc., so nothing they depend on
    // disappears out from under a request still being served.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    if (onDrained) await onDrained(signal);
  });
}

import { ConnectorModel, isConnected } from '../shared/db.js';
import type { IConnector, IConnectorOAuth } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import {
  scopedFind,
  scopedFindOne,
  scopedFindOneAndUpdate,
  scopedDeleteOne,
  tenantScope,
} from '../shared/scoped-query.js';
import { recordAuditEvent, diffFields, type AuditActor } from '../core/audit-log.js';
import { encryptSecret, decryptSecret, encryptSecretMap, decryptSecretMap } from '../core/tenant-secrets.js';
import {
  BUNDLED_CONNECTORS,
  BUNDLED_BY_KEY,
  type ConnectorTransport,
} from './connector-bundle.js';

const log = createChildLogger({ module: 'connector-store' });

/** The connector fields the control-plane config-change audit diffs (ADR-013 §5). */
const CONNECTOR_AUDIT_FIELDS = [
  'label', 'category', 'transport', 'description', 'url', 'command', 'args', 'env', 'requiresEnv', 'enabled',
] as const;

/**
 * Connector fields whose VALUES are secret-bearing — `env` holds the actual
 * injected credential values, and `url`/`command`/`args` routinely embed tokens
 * or connection strings (e.g. `postgres://user:pass@host`). The audit trail is
 * a plaintext JSONL file exposed via GET /api/auth/audit + CSV export, so their
 * from/to values MUST NOT be persisted there — we record only that the field
 * changed. Without this, rotating a token writes both the old and new secret to
 * an immutable, lower-privilege-readable log.
 */
const CONNECTOR_SECRET_FIELDS = new Set<string>(['env', 'url', 'command', 'args']);

/**
 * diffFields over the audit fields, then redact secret-bearing field values to a
 * `[redacted]` marker (undefined preserved, so a set↔unset transition still
 * reads correctly) — the trail records THAT a credential changed, never what to.
 */
function connectorAuditDiff(
  before: IConnector | undefined,
  after: IConnector | undefined,
): ReturnType<typeof diffFields<IConnector>> {
  const diff = diffFields<IConnector>(before, after, CONNECTOR_AUDIT_FIELDS);
  for (const key of Object.keys(diff)) {
    const d = diff[key];
    if (d && CONNECTOR_SECRET_FIELDS.has(key)) {
      diff[key] = {
        from: d.from === undefined ? undefined : '[redacted]',
        to: d.to === undefined ? undefined : '[redacted]',
      };
    }
  }
  return diff;
}

const SYSTEM_ACTOR: AuditActor = { role: 'system', via: 'system' };

export interface ConnectorView {
  key: string;
  label: string;
  category: string;
  transport: ConnectorTransport;
  description?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  requiresEnv?: string[];
  enabled: boolean;
  source: 'bundled' | 'custom';
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpsertConnectorInput {
  key: string;
  label?: string;
  category?: string;
  transport?: ConnectorTransport;
  description?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  requiresEnv?: string[];
  enabled?: boolean;
}

/** `doc.env` is stored envelope-encrypted (ADR-010 §3.7) — decrypt for any reader. */
async function toView(tenantId: string, doc: IConnector): Promise<ConnectorView> {
  return {
    key: doc.key,
    label: doc.label,
    category: doc.category,
    transport: doc.transport,
    description: doc.description,
    url: doc.url,
    command: doc.command,
    args: doc.args,
    env: await decryptSecretMap(tenantId, doc.env),
    requiresEnv: doc.requiresEnv,
    enabled: doc.enabled,
    source: doc.source,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Seed the curated bundle for a tenant. Idempotent: each bundled connector is
 * upserted by key, and only the immutable catalog fields are written on insert
 * — an existing row's `enabled` toggle is preserved on re-seed so calling this
 * again never clobbers an operator's choices. Returns how many were created vs
 * already present. This is what makes a fresh betaC install have working
 * connectors day one.
 */
export async function seedDefaultConnectors(
  tenantId: string,
): Promise<{ seeded: number; existing: number } | null> {
  if (!isConnected() || !ConnectorModel) {
    log.warn('DB not connected — cannot seed connectors');
    return null;
  }

  // Which bundled keys already exist for this tenant — so we report seeded vs
  // existing accurately and never overwrite an operator's `enabled` toggle.
  const present = await scopedFind(ConnectorModel, tenantId, {}).select('key').lean<{ key: string }[]>();
  const presentKeys = new Set(present.map((c) => c.key));

  let seeded = 0;
  let existing = 0;
  for (const def of BUNDLED_CONNECTORS) {
    await scopedFindOneAndUpdate(
      ConnectorModel,
      tenantId,
      { key: def.key },
      {
        // Catalog fields are authoritative for bundled connectors — refresh them
        // so a bundle update propagates, but never touch `enabled` here.
        $set: {
          label: def.label,
          category: def.category,
          transport: def.transport,
          description: def.description,
          url: def.url,
          command: def.command,
          args: def.args,
          env: def.env,
          requiresEnv: def.requiresEnv,
          source: 'bundled',
        },
        $setOnInsert: {
          ...tenantScope(tenantId),
          key: def.key,
          enabled: def.defaultEnabled,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    if (presentKeys.has(def.key)) existing++;
    else seeded++;
  }
  log.info({ tenantId, seeded, existing }, 'connector bundle seeded');
  return { seeded, existing };
}

/**
 * List a tenant's connectors. Auto-seeds the bundle on first read so a brand
 * new tenant never sees an empty connector manager.
 */
export async function listConnectors(tenantId: string): Promise<ConnectorView[]> {
  if (!isConnected() || !ConnectorModel) return [];
  let docs = await scopedFind(ConnectorModel, tenantId, {}).sort({ category: 1, key: 1 }).lean<IConnector[]>();
  if (docs.length === 0) {
    await seedDefaultConnectors(tenantId);
    docs = await scopedFind(ConnectorModel, tenantId, {}).sort({ category: 1, key: 1 }).lean<IConnector[]>();
  }
  return Promise.all(docs.map((d) => toView(tenantId, d)));
}

/**
 * Create or update a connector. A custom connector requires a transport and the
 * matching shape (url for http, command for stdio); a bundled connector can be
 * upserted with just `{key, enabled}` to toggle it without resupplying the
 * catalog fields.
 *
 * Records a `connector.change` control-plane audit event (ADR-013 §5) with a
 * before/after field diff whenever the write actually changes something (or
 * creates a new custom connector) — the admin-config-change compliance trail,
 * distinct from the per-tenant MCP tool-call audit. `actor` defaults to the
 * system principal for internal/seed callers that don't act on an admin's behalf.
 */
export async function upsertConnector(
  tenantId: string,
  input: UpsertConnectorInput,
  actor?: AuditActor,
): Promise<ConnectorView | null> {
  if (!isConnected() || !ConnectorModel) {
    log.warn('DB not connected — cannot upsert connector');
    return null;
  }
  if (!input.key) throw new Error('key is required');

  const bundled = BUNDLED_BY_KEY[input.key];
  const set: Record<string, unknown> = {};
  for (const k of ['label', 'category', 'transport', 'description', 'url', 'command', 'args', 'env', 'requiresEnv', 'enabled'] as const) {
    if (input[k] !== undefined) set[k] = input[k];
  }
  // Envelope-encrypt the real credential values before they ever hit Mongo
  // (ADR-010 §3.7) — a DB dump alone must not leak a tenant's connector
  // secrets. Decrypted back out in toView() for every reader.
  if (input.env !== undefined) {
    set.env = await encryptSecretMap(tenantId, input.env);
  }

  // For a brand-new CUSTOM connector we must have enough to actually run it.
  // (Bundled keys carry their own catalog via the seed, so a bare toggle is OK.)
  if (!bundled) {
    const transport = (input.transport ?? set.transport) as ConnectorTransport | undefined;
    if (transport === 'http' && !input.url) throw new Error('url is required for an http connector');
    if (transport === 'stdio' && !input.command) throw new Error('command is required for a stdio connector');
    if (!transport) throw new Error('transport is required for a custom connector');
    if (!set.label) set.label = input.key;
  }

  const before = await scopedFindOne(ConnectorModel, tenantId, { key: input.key }).lean<IConnector | null>();

  const doc = await scopedFindOneAndUpdate(
    ConnectorModel,
    tenantId,
    { key: input.key },
    {
      $set: set,
      $setOnInsert: {
        ...tenantScope(tenantId),
        key: input.key,
        source: bundled ? 'bundled' : 'custom',
        ...(input.enabled === undefined ? { enabled: true } : {}),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  log.info({ tenantId, key: input.key }, 'connector upserted');

  if (doc) {
    const diff = connectorAuditDiff(before ?? undefined, doc as IConnector);
    if (!before || Object.keys(diff).length > 0) {
      recordAuditEvent({
        tenantId,
        actor: actor ?? SYSTEM_ACTOR,
        action: 'connector.change',
        target: input.key,
        detail: before ? { diff } : { created: true, diff },
      });
    }
  }
  return doc ? toView(tenantId, doc as IConnector) : null;
}

/** Flip a connector's enabled flag. Returns the updated view or null. */
export async function setConnectorEnabled(
  tenantId: string,
  key: string,
  enabled: boolean,
  actor?: AuditActor,
): Promise<ConnectorView | null> {
  return upsertConnector(tenantId, { key, enabled }, actor);
}

/**
 * Remove a connector. Bundled connectors are NOT hard-deleted (a re-seed would
 * just bring them back) — they're disabled instead (audited via
 * `setConnectorEnabled`'s `connector.change` event). Custom connectors are
 * deleted outright, audited here with the deleted doc's fields as the "before"
 * side of the diff. Returns what happened.
 */
export async function removeConnector(
  tenantId: string,
  key: string,
  actor?: AuditActor,
): Promise<{ removed: boolean; disabled: boolean } | null> {
  if (!isConnected() || !ConnectorModel) return null;
  if (BUNDLED_BY_KEY[key]) {
    await setConnectorEnabled(tenantId, key, false, actor);
    return { removed: false, disabled: true };
  }
  const before = await scopedFindOne(ConnectorModel, tenantId, { key }).lean<IConnector | null>();
  const res = await scopedDeleteOne(ConnectorModel, tenantId, { key });
  const removed = (res?.deletedCount ?? 0) > 0;
  if (removed && before) {
    recordAuditEvent({
      tenantId,
      actor: actor ?? SYSTEM_ACTOR,
      action: 'connector.change',
      target: key,
      detail: { removed: true, diff: connectorAuditDiff(before, undefined) },
    });
  }
  return { removed, disabled: false };
}

/**
 * Build an `.mcp.json`-shaped object from a tenant's ENABLED connectors — the
 * artifact a scaffolded project or a CLI session would consume. This is the
 * "day one working connectors" payload.
 */
export async function buildMcpConfig(tenantId: string): Promise<{ mcpServers: Record<string, unknown> }> {
  const connectors = (await listConnectors(tenantId)).filter((c) => c.enabled);
  const mcpServers: Record<string, unknown> = {};
  for (const c of connectors) {
    if (c.transport === 'http') {
      mcpServers[c.key] = { type: 'http', url: c.url };
    } else {
      mcpServers[c.key] = {
        command: c.command,
        args: c.args ?? [],
        ...(c.env ? { env: c.env } : {}),
      };
    }
  }
  return { mcpServers };
}

// ── OAuth token lifecycle (connector auto-refresh) ─────────────────

/** A connector row carrying OAuth state, scoped to its tenant — the sweep's unit of work. */
export interface ExpiringOAuthConnector {
  tenantId: string;
  key: string;
  label: string;
  oauth: IConnectorOAuth;
}

/**
 * Cross-tenant sweep target: every ENABLED connector with an OAuth token that
 * expires at or before `before`. Deliberately unscoped by tenant (mirrors
 * `findDueSchedules`) — the auto-refresh worker sweeps every tenant in one
 * tick under its own per-row tenant context.
 */
export async function findExpiringOAuthConnectors(before: Date): Promise<ExpiringOAuthConnector[]> {
  if (!isConnected() || !ConnectorModel) return [];
  // tenant-ok: deliberate cross-tenant sweep — see doc comment above.
  const docs = await ConnectorModel.find({
    enabled: true,
    'oauth.accessToken': { $exists: true },
    'oauth.expiresAt': { $lte: before },
  }).lean<IConnector[]>();
  // OAuth tokens are stored envelope-encrypted (ADR-010 §3.7) — decrypt here
  // so the refresh worker gets a usable refreshToken to call the provider.
  return Promise.all(
    docs
      .filter((d) => d.oauth)
      .map(async (d) => {
        const oauth = d.oauth as IConnectorOAuth;
        return {
          tenantId: d.tenantId,
          key: d.key,
          label: d.label,
          oauth: {
            ...oauth,
            accessToken: oauth.accessToken ? await decryptSecret(d.tenantId, oauth.accessToken) : oauth.accessToken,
            refreshToken: oauth.refreshToken ? await decryptSecret(d.tenantId, oauth.refreshToken) : oauth.refreshToken,
          },
        };
      }),
  );
}

/** Persist a successful token refresh. */
export async function setConnectorOAuthTokens(
  tenantId: string,
  key: string,
  tokens: { accessToken: string; refreshToken?: string; expiresAt: Date; tokenType?: string; scope?: string },
  now: Date = new Date(),
): Promise<void> {
  if (!isConnected() || !ConnectorModel) return;
  const set: Record<string, unknown> = {
    'oauth.accessToken': await encryptSecret(tenantId, tokens.accessToken),
    'oauth.expiresAt': tokens.expiresAt,
    'oauth.lastRefreshedAt': now,
  };
  if (tokens.refreshToken !== undefined) set['oauth.refreshToken'] = await encryptSecret(tenantId, tokens.refreshToken);
  if (tokens.tokenType !== undefined) set['oauth.tokenType'] = tokens.tokenType;
  if (tokens.scope !== undefined) set['oauth.scope'] = tokens.scope;
  await scopedFindOneAndUpdate(
    ConnectorModel,
    tenantId,
    { key },
    { $set: set, $unset: { 'oauth.lastRefreshError': '' } },
    {},
  );
  log.info({ tenantId, key }, 'connector OAuth token refreshed');
}

/** Record a failed refresh attempt without clobbering the still-live (until expiry) token. */
export async function recordConnectorRefreshFailure(
  tenantId: string,
  key: string,
  error: string,
): Promise<void> {
  if (!isConnected() || !ConnectorModel) return;
  await scopedFindOneAndUpdate(
    ConnectorModel,
    tenantId,
    { key },
    { $set: { 'oauth.lastRefreshError': error } },
    {},
  );
  log.warn({ tenantId, key, error }, 'connector OAuth refresh failed');
}

/** Stamp that we've nudged the tenant to re-authenticate (throttles repeat nudges). */
export async function markConnectorReauthNudged(
  tenantId: string,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  if (!isConnected() || !ConnectorModel) return;
  await scopedFindOneAndUpdate(
    ConnectorModel,
    tenantId,
    { key },
    { $set: { 'oauth.reauthNudgedAt': now } },
    {},
  );
}

/**
 * OpenAPI 3.1 spec + self-contained docs page for the gateway REST API.
 *
 * The spec is hand-authored as a plain object literal (no spec-generation
 * library) and mirrors every Express route registered in core/server.ts.
 * Schema shapes are kept faithful to what the code actually returns:
 * ScheduleView (scheduler/schedule-store.ts), TaskView (tasks/task-store.ts),
 * BudgetStatus/BudgetBreakdown/BudgetUsageRow (llm/budget-stats.ts), and the
 * in-memory fallback shapes for agents/skills/hooks/rules.
 *
 * Exposed via two routes in server.ts:
 *   GET /api/openapi.json  → buildOpenApiSpec() (built once, cached)
 *   GET /api/docs          → docsHtml('/api/openapi.json') — zero-dependency
 *                            HTML page that renders the spec client-side.
 */

type Obj = Record<string, unknown>;

// ── Small builders (plain-object sugar, not a spec library) ──

function ref(name: string): Obj {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description: string, schema: Obj): Obj {
  return { description, content: { 'application/json': { schema } } };
}

function errorResponse(description: string): Obj {
  return jsonResponse(description, ref('Error'));
}

function pathParam(name: string, description: string): Obj {
  return { name, in: 'path', required: true, description, schema: { type: 'string' } };
}

function queryParam(name: string, description: string, schema: Obj): Obj {
  return { name, in: 'query', required: false, description, schema };
}

function jsonBody(schema: Obj, required = true): Obj {
  return { required, content: { 'application/json': { schema } } };
}

const adminSecurity = [{ AdminToken: [] }];
const adminResponses: Obj = {
  '401': errorResponse('X-Admin-Token header missing or wrong (code UNAUTHORIZED)'),
  '503': errorResponse('ADMIN_API_TOKEN not configured on the server (code ADMIN_DISABLED)'),
};

// ── Components / schemas ─────────────────────────────────────

const schemas: Obj = {
  Error: {
    type: 'object',
    description: 'Standard error envelope. `code` is present on admin/dispatch endpoints only.',
    required: ['error'],
    properties: {
      error: { type: 'string', description: 'Human-readable error message' },
      code: { type: 'string', description: 'Machine-readable code (e.g. UNAUTHORIZED, ADMIN_DISABLED, BAD_REQUEST, INTERNAL_ERROR)' },
    },
  },
  Agent: {
    type: 'object',
    description: 'Specialist agent definition. MongoDB-sourced documents may carry extra fields; the in-memory fallback returns this minimal shape.',
    required: ['name', 'description', 'category'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: true,
  },
  Skill: {
    type: 'object',
    description: 'Skill playbook summary. MongoDB-sourced documents may carry extra fields.',
    required: ['name', 'description'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      triggers: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: true,
  },
  Hook: {
    type: 'object',
    required: ['name', 'events', 'priority', 'enabled'],
    properties: {
      name: { type: 'string' },
      events: { type: 'array', items: { type: 'string' } },
      priority: { type: 'number' },
      enabled: { type: 'boolean' },
      source: { type: 'string' },
      timeout: { type: 'number' },
    },
    additionalProperties: true,
  },
  Rule: {
    type: 'object',
    required: ['name', 'description', 'category'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
    },
    additionalProperties: true,
  },
  Repo: {
    type: 'object',
    description: 'A managed repository as parsed from config/managed_repos.txt.',
    required: ['name', 'path', 'group', 'accessible', 'aiDir', 'stateExists', 'stateFresh', 'claudeMd', 'geminiMd'],
    properties: {
      name: { type: 'string' },
      path: { type: 'string' },
      group: { type: 'string', description: 'Section heading the repo appears under in managed_repos.txt' },
      accessible: { type: 'boolean' },
      aiDir: { type: 'boolean', description: 'AI/ folder exists' },
      stateExists: { type: 'boolean' },
      stateFresh: { type: 'boolean', description: 'STATE.md modified within the last 72 hours' },
      claudeMd: { type: 'boolean' },
      geminiMd: { type: 'boolean' },
    },
  },
  Channel: {
    type: 'object',
    required: ['type', 'enabled'],
    properties: {
      type: { type: 'string' },
      enabled: { type: 'boolean' },
    },
  },
  Session: {
    type: 'object',
    description: 'Agent session. The list endpoint returns the summary fields; GET /api/sessions/{id} additionally includes the last 20 messages and metadata.',
    required: ['id', 'agentName', 'status', 'messageCount', 'createdAt', 'lastActivity'],
    properties: {
      id: { type: 'string' },
      agentName: { type: 'string' },
      status: { type: 'string' },
      messageCount: { type: 'integer' },
      messages: { type: 'array', items: { type: 'object' }, description: 'Last 20 messages (detail endpoint only)' },
      metadata: { type: 'object', description: 'Detail endpoint only' },
      createdAt: { type: 'string', format: 'date-time' },
      lastActivity: { type: 'string', format: 'date-time' },
    },
  },
  Schedule: {
    type: 'object',
    description: 'ScheduleView as returned by scheduler/schedule-store.ts.',
    required: ['scheduleId', 'name', 'cronExpr', 'kind', 'target', 'message', 'includeMemoryContext', 'enabled', 'lastStatus', 'runCount', 'errorCount', 'createdAt', 'updatedAt'],
    properties: {
      scheduleId: { type: 'string' },
      name: { type: 'string' },
      cronExpr: { type: 'string', description: '5-field cron expression (min hour day month dow)' },
      kind: { type: 'string', enum: ['agent', 'skill', 'tool'] },
      target: { type: 'string', description: 'Agent name, skill name, or tool name to dispatch' },
      message: { type: 'string' },
      repo: { type: 'string' },
      includeMemoryContext: { type: 'boolean' },
      enabled: { type: 'boolean' },
      lastRun: { type: 'string', format: 'date-time' },
      nextRun: { type: 'string', format: 'date-time' },
      lastStatus: { type: 'string', enum: ['never', 'success', 'error'] },
      lastError: { type: 'string' },
      lastResultSummary: { type: 'string' },
      runCount: { type: 'integer' },
      errorCount: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  Task: {
    type: 'object',
    description: 'TaskView as returned by tasks/task-store.ts.',
    required: ['taskId', 'repo', 'title', 'description', 'priority', 'status', 'source', 'createdAt', 'updatedAt'],
    properties: {
      taskId: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
      status: { type: 'string', enum: ['pending', 'working', 'review', 'done', 'blocked'] },
      assignedAgent: { type: 'string' },
      recommendedModel: { type: 'string' },
      source: { type: 'string', enum: ['manual', 'connect-hub', 'auto-detected', 'scheduler', 'telegram'] },
      sourceId: { type: 'string' },
      prUrl: { type: 'string' },
      notes: { type: 'string' },
      telegramMessageId: { type: 'integer' },
      startedAt: { type: 'string', format: 'date-time' },
      completedAt: { type: 'string', format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  TaskQueueSummary: {
    type: 'object',
    description: 'Per-status task counts (countTasks).',
    required: ['pending', 'working', 'review', 'done', 'blocked'],
    properties: {
      pending: { type: 'integer' },
      working: { type: 'integer' },
      review: { type: 'integer' },
      done: { type: 'integer' },
      blocked: { type: 'integer' },
    },
  },
  BudgetStatus: {
    type: 'object',
    description: 'Global spend snapshot from llm/budget-stats.ts.',
    required: ['enabled', 'mtd', 'today', 'monthlyHardCapUsd', 'monthlyDailyCapUsd', 'warnThreshold', 'downgradeOpusThreshold', 'downgradeSonnetThreshold', 'monthStart', 'dayStart'],
    properties: {
      enabled: { type: 'boolean', description: 'Whether budget guards are enabled (BUDGETS_ENABLED)' },
      mtd: { type: 'number', description: 'Month-to-date spend in USD' },
      today: { type: 'number', description: "Today's spend in USD" },
      monthlyHardCapUsd: { type: 'number' },
      monthlyDailyCapUsd: { type: 'number' },
      perChannelMonthlyCapUsd: { type: 'number' },
      warnThreshold: { type: 'number' },
      downgradeOpusThreshold: { type: 'number' },
      downgradeSonnetThreshold: { type: 'number' },
      monthStart: { type: 'string', format: 'date-time' },
      dayStart: { type: 'string', format: 'date-time' },
      perChannel: {
        type: 'array',
        items: {
          type: 'object',
          required: ['channelId', 'mtd'],
          properties: { channelId: { type: 'string' }, mtd: { type: 'number' } },
        },
      },
    },
  },
  BudgetBreakdown: {
    type: 'object',
    required: ['monthStart', 'byProvider', 'byModel', 'byChannel', 'byUser'],
    properties: {
      monthStart: { type: 'string', format: 'date-time' },
      byProvider: {
        type: 'array',
        items: { type: 'object', properties: { provider: { type: 'string' }, cost: { type: 'number' }, calls: { type: 'integer' } } },
      },
      byModel: {
        type: 'array',
        items: { type: 'object', properties: { model: { type: 'string' }, cost: { type: 'number' }, calls: { type: 'integer' } } },
      },
      byChannel: {
        type: 'array',
        items: { type: 'object', properties: { channelId: { type: ['string', 'null'] }, cost: { type: 'number' }, calls: { type: 'integer' } } },
      },
      byUser: {
        type: 'array',
        items: { type: 'object', properties: { userId: { type: ['string', 'null'] }, cost: { type: 'number' }, calls: { type: 'integer' } } },
      },
    },
  },
  BudgetUsageRow: {
    type: 'object',
    required: ['callId', 'provider', 'model', 'inputTokens', 'outputTokens', 'costUsd', 'createdAt'],
    properties: {
      callId: { type: 'string' },
      channelId: { type: 'string' },
      channelType: { type: 'string' },
      agentName: { type: 'string' },
      userId: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      inputTokens: { type: 'integer' },
      outputTokens: { type: 'integer' },
      costUsd: { type: 'number' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  UsageSummary: {
    type: 'object',
    description: 'Product-meter (UsageEvent) quantity totals per group key. From shared/usage-store.ts::summarizeUsage.',
    required: ['totals', 'groupBy'],
    properties: {
      totals: { type: 'object', additionalProperties: { type: 'number' }, description: 'Summed quantity per group key (event type, day, or repo)' },
      groupBy: { type: 'string', enum: ['type', 'day', 'repo'] },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
    },
  },
  UsageBreakdown: {
    type: 'object',
    description: 'Multi-dimension product-usage rollup (tool / member / repo / day). From shared/usage-store.ts::getUsageBreakdown.',
    required: ['from', 'byType', 'byUser', 'byRepo', 'byDay'],
    properties: {
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      byType: { type: 'array', items: ref('UsageBreakdownGroup') },
      byUser: { type: 'array', items: ref('UsageBreakdownGroup') },
      byRepo: { type: 'array', items: ref('UsageBreakdownGroup') },
      byDay: {
        type: 'array',
        items: {
          type: 'object',
          required: ['day', 'quantity', 'events'],
          properties: { day: { type: 'string', description: 'YYYY-MM-DD (UTC)' }, quantity: { type: 'number' }, events: { type: 'integer' } },
        },
      },
    },
  },
  UsageBreakdownGroup: {
    type: 'object',
    required: ['key', 'quantity', 'events'],
    properties: {
      key: { type: ['string', 'null'], description: 'Group value (event type / userId / repo); null when unattributed' },
      quantity: { type: 'number' },
      events: { type: 'integer' },
    },
  },
};

// ── Paths ────────────────────────────────────────────────────

function buildPaths(): Obj {
  return {
    // ── Health / status ──
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe — uptime + MongoDB connection state',
        operationId: 'getHealth',
        responses: {
          '200': jsonResponse('Service is up', {
            type: 'object',
            required: ['status', 'uptime', 'mongodb'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
              uptime: { type: 'integer', description: 'Seconds since process start' },
              mongodb: { type: 'string', enum: ['connected', 'disconnected'] },
            },
          }),
        },
      },
    },
    '/health/deep': {
      get: {
        tags: ['Health'],
        summary: 'Deep health check across subsystems',
        operationId: 'getDeepHealth',
        responses: {
          '200': jsonResponse('Healthy or degraded', {
            type: 'object',
            required: ['status'],
            properties: { status: { type: 'string', enum: ['healthy', 'degraded'] } },
            additionalProperties: true,
          }),
          '503': jsonResponse('Unhealthy', {
            type: 'object',
            properties: { status: { type: 'string', enum: ['unhealthy'] } },
            additionalProperties: true,
          }),
          '500': jsonResponse('Health check itself failed', {
            type: 'object',
            properties: { status: { type: 'string', enum: ['unhealthy'] }, error: { type: 'string' } },
          }),
        },
      },
    },
    '/status': {
      get: {
        tags: ['Health'],
        summary: 'Gateway status — version, counts of agents/skills/hooks/rules, session totals',
        operationId: 'getStatus',
        responses: {
          '200': jsonResponse('Status snapshot', {
            type: 'object',
            required: ['name', 'version', 'uptime', 'mongodb', 'llm', 'agents', 'skills', 'hooks', 'rules', 'sessions'],
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              uptime: { type: 'integer' },
              mongodb: { type: 'string', enum: ['connected', 'disconnected'] },
              llm: { type: 'string', enum: ['configured', 'not_configured'] },
              agents: { type: 'integer' },
              skills: { type: 'integer' },
              hooks: { type: 'integer' },
              rules: { type: 'integer' },
              sessions: {
                type: 'object',
                properties: { total: { type: 'integer' }, active: { type: 'integer' } },
              },
            },
          }),
        },
      },
    },

    // ── Docs (self) ──
    '/api/openapi.json': {
      get: {
        tags: ['Docs'],
        summary: 'This OpenAPI 3.1 document',
        operationId: 'getOpenApiSpec',
        responses: { '200': jsonResponse('The OpenAPI document', { type: 'object' }) },
      },
    },
    '/api/docs': {
      get: {
        tags: ['Docs'],
        summary: 'Self-contained HTML API reference (renders /api/openapi.json client-side, no CDN)',
        operationId: 'getDocs',
        responses: {
          '200': { description: 'HTML documentation page', content: { 'text/html': { schema: { type: 'string' } } } },
        },
      },
    },

    // ── Agents ──
    '/api/agents': {
      get: {
        tags: ['Agents'],
        summary: 'List agents (MongoDB first, in-memory fallback)',
        operationId: 'listAgents',
        parameters: [
          queryParam('category', 'Filter by agent category', { type: 'string' }),
          queryParam('search', 'Case-insensitive regex over name/description (MongoDB path only)', { type: 'string' }),
        ],
        responses: {
          '200': jsonResponse('Agent list', {
            type: 'object',
            required: ['count', 'source', 'agents'],
            properties: {
              count: { type: 'integer' },
              source: { type: 'string', enum: ['mongodb', 'memory'] },
              agents: { type: 'array', items: ref('Agent') },
            },
          }),
        },
      },
    },
    '/api/agents/{name}': {
      get: {
        tags: ['Agents'],
        summary: 'Get a single agent by name (includes full instructions when found)',
        operationId: 'getAgent',
        parameters: [pathParam('name', 'Agent name')],
        responses: {
          '200': jsonResponse('Agent', ref('Agent')),
          '404': errorResponse('Agent not found'),
        },
      },
    },

    // ── Skills ──
    '/api/skills': {
      get: {
        tags: ['Skills'],
        summary: 'List skills (MongoDB first, in-memory fallback)',
        operationId: 'listSkills',
        parameters: [
          queryParam('search', 'Case-insensitive regex over name/description/triggers (MongoDB path only)', { type: 'string' }),
          queryParam('agent', 'Filter by owning agent (in-memory fallback path only)', { type: 'string' }),
        ],
        responses: {
          '200': jsonResponse('Skill list', {
            type: 'object',
            required: ['count', 'source', 'skills'],
            properties: {
              count: { type: 'integer' },
              source: { type: 'string', enum: ['mongodb', 'memory'] },
              skills: { type: 'array', items: ref('Skill') },
            },
          }),
        },
      },
    },
    '/api/skills/{name}': {
      get: {
        tags: ['Skills'],
        summary: 'Get a single skill by name (includes full playbook when found)',
        operationId: 'getSkill',
        parameters: [pathParam('name', 'Skill name')],
        responses: {
          '200': jsonResponse('Skill', ref('Skill')),
          '404': errorResponse('Skill not found'),
        },
      },
    },

    // ── Hooks ──
    '/api/hooks': {
      get: {
        tags: ['Hooks'],
        summary: 'List event hooks (MongoDB first, in-memory fallback)',
        operationId: 'listHooks',
        responses: {
          '200': jsonResponse('Hook list', {
            type: 'object',
            required: ['count', 'source', 'hooks'],
            properties: {
              count: { type: 'integer' },
              source: { type: 'string', enum: ['mongodb', 'memory'] },
              hooks: { type: 'array', items: ref('Hook') },
            },
          }),
        },
      },
    },

    // ── Rules ──
    '/api/rules': {
      get: {
        tags: ['Rules'],
        summary: 'List rules (MongoDB first, in-memory fallback)',
        operationId: 'listRules',
        parameters: [queryParam('category', 'Filter by rule category', { type: 'string' })],
        responses: {
          '200': jsonResponse('Rule list', {
            type: 'object',
            required: ['count', 'source', 'rules'],
            properties: {
              count: { type: 'integer' },
              source: { type: 'string', enum: ['mongodb', 'memory'] },
              rules: { type: 'array', items: ref('Rule') },
            },
          }),
        },
      },
    },
    '/api/rules/{name}': {
      get: {
        tags: ['Rules'],
        summary: 'Get a single rule by name (includes full content when found)',
        operationId: 'getRule',
        parameters: [pathParam('name', 'Rule name')],
        responses: {
          '200': jsonResponse('Rule', ref('Rule')),
          '404': errorResponse('Rule not found'),
        },
      },
    },

    // ── Repos ──
    '/api/repos': {
      get: {
        tags: ['Repos'],
        summary: 'List managed repositories with AI-framework compliance flags',
        operationId: 'listRepos',
        responses: {
          '200': jsonResponse('Managed repo list (count 0 + error field when managed_repos.txt is missing)', {
            type: 'object',
            required: ['count', 'repos'],
            properties: {
              count: { type: 'integer' },
              repos: { type: 'array', items: ref('Repo') },
              error: { type: 'string', description: 'Present only when managed_repos.txt is not found' },
            },
          }),
        },
      },
    },

    // ── Channels ──
    '/api/channels': {
      get: {
        tags: ['Channels'],
        summary: 'List channel adapters and active channel session count',
        operationId: 'listChannels',
        responses: {
          '200': jsonResponse('Channel list', {
            type: 'object',
            required: ['count', 'activeSessions', 'channels'],
            properties: {
              count: { type: 'integer' },
              activeSessions: { type: 'integer' },
              channels: { type: 'array', items: ref('Channel') },
            },
          }),
        },
      },
    },

    // ── Memory / SONA ──
    '/api/memory/search': {
      post: {
        tags: ['Memory'],
        summary: 'Hybrid memory search (keyword + tags)',
        operationId: 'searchMemory',
        requestBody: jsonBody({
          type: 'object',
          description: 'At least one of `query` or non-empty `tags` is required.',
          properties: {
            query: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            topN: { type: 'integer' },
          },
        }),
        responses: {
          '200': jsonResponse('Search results', {
            type: 'object',
            required: ['count', 'results'],
            properties: { count: { type: 'integer' }, results: { type: 'array', items: { type: 'object' } } },
          }),
          '400': errorResponse('query or tags required'),
          '500': errorResponse('Search failed'),
        },
      },
    },
    '/api/memory/context': {
      post: {
        tags: ['Memory'],
        summary: 'Build a token-bounded context block from the memory store',
        operationId: 'buildMemoryContext',
        requestBody: jsonBody({
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            maxTokens: { type: 'integer' },
          },
        }),
        responses: {
          '200': jsonResponse('Assembled context', { type: 'object' }),
          '400': errorResponse('query required'),
          '500': errorResponse('Context build failed'),
        },
      },
    },

    '/api/memory/export': {
      get: {
        tags: ['Memory'],
        summary: 'Export the memory corpus as a portable bundle (JSON manifest + markdown files, no embeddings)',
        operationId: 'exportMemoryBundle',
        parameters: [
          { name: 'repo', in: 'query', schema: { type: 'string' } },
          { name: 'source', in: 'query', schema: { type: 'string', enum: ['state', 'handoff', 'commit', 'pr', 'pattern', 'bug', 'code', 'feature', 'archive'] } },
        ],
        responses: {
          '200': jsonResponse('Portable memory bundle', {
            type: 'object',
            required: ['manifest', 'files'],
            properties: {
              manifest: { type: 'object' },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['path', 'content'],
                  properties: { path: { type: 'string' }, content: { type: 'string' } },
                },
              },
            },
          }),
          '400': errorResponse('invalid source'),
          '500': errorResponse('Export failed'),
        },
      },
    },
    '/api/memory/import': {
      post: {
        tags: ['Memory'],
        summary: 'Import a memory bundle — re-embeds each entry on this gateway, dedup by content hash',
        operationId: 'importMemoryBundle',
        requestBody: jsonBody({
          type: 'object',
          required: ['files'],
          properties: {
            manifest: { type: 'object' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                required: ['path', 'content'],
                properties: { path: { type: 'string' }, content: { type: 'string' } },
              },
            },
          },
        }),
        responses: {
          '200': jsonResponse('Import summary', {
            type: 'object',
            properties: {
              filesTotal: { type: 'integer' },
              parsed: { type: 'integer' },
              invalid: { type: 'array', items: { type: 'object' } },
              dedupedInBundle: { type: 'integer' },
              hashMismatches: { type: 'integer' },
              stored: { type: 'integer' },
              skippedExisting: { type: 'integer' },
              failed: { type: 'integer' },
            },
          }),
          '400': errorResponse('files required / invalid bundle'),
        },
      },
    },

    // ── Vectors (RAG) ──
    '/api/vectors/search': {
      post: {
        tags: ['Vectors'],
        summary: 'Semantic vector search over the embedded corpus',
        operationId: 'searchVectors',
        requestBody: jsonBody({
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            repo: { type: 'string' },
            source: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer' },
          },
        }),
        responses: {
          '200': jsonResponse('Vector matches', {
            type: 'object',
            required: ['count', 'results'],
            properties: { count: { type: 'integer' }, results: { type: 'array', items: { type: 'object' } } },
          }),
          '400': errorResponse('query required'),
          '500': errorResponse('Vector search failed'),
        },
      },
    },
    '/api/vectors/stats': {
      get: {
        tags: ['Vectors'],
        summary: 'Total stored vector count',
        operationId: 'getVectorStats',
        responses: {
          '200': jsonResponse('Vector stats', {
            type: 'object',
            required: ['total'],
            properties: { total: { type: 'integer' } },
          }),
          '500': errorResponse('Count failed'),
        },
      },
    },
    '/api/vectors/index': {
      post: {
        tags: ['Vectors'],
        summary: 'Run the embedding indexer over the master repo or all managed repos',
        operationId: 'indexVectors',
        requestBody: jsonBody({
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['master', 'all'], description: 'Any value other than "all" indexes the master repo only (default master)' },
          },
        }, false),
        responses: {
          '200': jsonResponse('Indexing result', {
            type: 'object',
            required: ['scope', 'totalStored', 'results'],
            properties: {
              scope: { type: 'string' },
              totalStored: { type: 'integer' },
              results: { type: 'array', items: { type: 'object' } },
            },
          }),
          '500': errorResponse('Indexing failed'),
        },
      },
    },

    // ── Sessions / messages ──
    '/api/sessions': {
      get: {
        tags: ['Sessions'],
        summary: 'List sessions (summary shape, no message bodies)',
        operationId: 'listSessions',
        responses: {
          '200': jsonResponse('Session list', {
            type: 'object',
            required: ['count', 'sessions'],
            properties: { count: { type: 'integer' }, sessions: { type: 'array', items: ref('Session') } },
          }),
        },
      },
      post: {
        tags: ['Sessions'],
        summary: 'Create a session bound to an agent',
        operationId: 'createSession',
        requestBody: jsonBody({
          type: 'object',
          required: ['agentName'],
          properties: {
            agentName: { type: 'string' },
            metadata: { type: 'object' },
          },
        }),
        responses: {
          '201': jsonResponse('Session created', {
            type: 'object',
            required: ['sessionId', 'agentName', 'status'],
            properties: {
              sessionId: { type: 'string' },
              agentName: { type: 'string' },
              status: { type: 'string' },
            },
          }),
          '400': errorResponse('agentName required'),
          '404': errorResponse('Agent not found'),
          '500': errorResponse('Session creation failed'),
        },
      },
    },
    '/api/sessions/{id}': {
      get: {
        tags: ['Sessions'],
        summary: 'Get session detail (last 20 messages + metadata)',
        operationId: 'getSession',
        parameters: [pathParam('id', 'Session id')],
        responses: {
          '200': jsonResponse('Session detail', ref('Session')),
          '404': errorResponse('Session not found'),
        },
      },
      delete: {
        tags: ['Sessions'],
        summary: 'Close a session',
        operationId: 'closeSession',
        parameters: [pathParam('id', 'Session id')],
        responses: {
          '200': jsonResponse('Closed', {
            type: 'object',
            required: ['status'],
            properties: { status: { type: 'string', enum: ['closed'] } },
          }),
          '500': errorResponse('Close failed'),
        },
      },
    },
    '/api/sessions/{id}/messages': {
      post: {
        tags: ['Sessions'],
        summary: 'Send a message into a session and get the agent response',
        operationId: 'postSessionMessage',
        parameters: [pathParam('id', 'Session id')],
        requestBody: jsonBody({
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string' },
            metadata: { type: 'object' },
          },
        }),
        responses: {
          '200': jsonResponse('Routed message + response', {
            type: 'object',
            required: ['sessionId', 'agentName', 'messageId', 'response'],
            properties: {
              sessionId: { type: 'string' },
              agentName: { type: 'string' },
              messageId: { type: 'string' },
              response: { type: 'object', description: 'Agent response payload' },
            },
          }),
          '400': errorResponse('content required'),
          '404': errorResponse('Session not found'),
          '500': errorResponse('Routing failed'),
        },
      },
    },

    // ── Budgets (admin) ──
    '/api/budgets/status': {
      get: {
        tags: ['Budgets'],
        summary: 'Global spend snapshot (MTD / today / caps / thresholds)',
        operationId: 'getBudgetStatus',
        security: adminSecurity,
        responses: {
          '200': jsonResponse('Budget status', ref('BudgetStatus')),
          ...adminResponses,
          '500': errorResponse('Internal error (code INTERNAL_ERROR)'),
        },
      },
    },
    '/api/budgets/breakdown': {
      get: {
        tags: ['Budgets'],
        summary: 'Spend breakdown by provider / model / channel / member',
        operationId: 'getBudgetBreakdown',
        security: adminSecurity,
        parameters: [
          queryParam('from', 'Window start (any Date-parsable timestamp; defaults to UTC start-of-month)', { type: 'string', format: 'date-time' }),
          queryParam('to', 'Window end (any Date-parsable timestamp)', { type: 'string', format: 'date-time' }),
        ],
        responses: {
          '200': jsonResponse('Breakdown', ref('BudgetBreakdown')),
          '400': errorResponse('Invalid from/to timestamp (code BAD_REQUEST)'),
          ...adminResponses,
          '500': errorResponse('Internal error (code INTERNAL_ERROR)'),
        },
      },
    },
    '/api/budgets/usage': {
      get: {
        tags: ['Budgets'],
        summary: 'Paginated raw LLM usage rows',
        operationId: 'getBudgetUsage',
        security: adminSecurity,
        parameters: [
          queryParam('from', 'Window start timestamp', { type: 'string', format: 'date-time' }),
          queryParam('to', 'Window end timestamp', { type: 'string', format: 'date-time' }),
          queryParam('channelId', 'Filter by channel id', { type: 'string' }),
          queryParam('provider', 'Filter by LLM provider', { type: 'string' }),
          queryParam('userId', 'Filter by tenant member (User.userId)', { type: 'string' }),
          queryParam('cursor', 'ISO createdAt of the last row from the previous page', { type: 'string' }),
          queryParam('limit', 'Page size (default 50, capped at 500)', { type: 'integer' }),
        ],
        responses: {
          '200': jsonResponse('Usage page', {
            type: 'object',
            required: ['rows'],
            properties: {
              rows: { type: 'array', items: ref('BudgetUsageRow') },
              nextCursor: { type: 'string', description: 'Present when more rows are available' },
            },
          }),
          '400': errorResponse('Invalid from/to/limit (code BAD_REQUEST)'),
          ...adminResponses,
          '500': errorResponse('Internal error (code INTERNAL_ERROR)'),
        },
      },
    },

    // ── Usage meter (product events, admin) — ADR-014 S2 ──
    '/api/usage/summary': {
      get: {
        tags: ['Usage'],
        summary: 'Product-usage quantity totals (grouped by type / day / repo)',
        operationId: 'getUsageSummary',
        security: adminSecurity,
        parameters: [
          queryParam('from', 'Window start (any Date-parsable timestamp; defaults to store default)', { type: 'string', format: 'date-time' }),
          queryParam('to', 'Window end (exclusive)', { type: 'string', format: 'date-time' }),
          queryParam('groupBy', 'Group key (default type)', { type: 'string', enum: ['type', 'day', 'repo'] }),
        ],
        responses: {
          '200': jsonResponse('Usage summary', ref('UsageSummary')),
          '400': errorResponse('Invalid from/to/groupBy (code BAD_REQUEST)'),
          ...adminResponses,
          '500': errorResponse('Internal error (code INTERNAL_ERROR)'),
        },
      },
    },
    '/api/usage/breakdown': {
      get: {
        tags: ['Usage'],
        summary: 'Product-usage rollup by tool / member / repo / day',
        operationId: 'getUsageBreakdown',
        security: adminSecurity,
        parameters: [
          queryParam('from', 'Window start (defaults to UTC start-of-month)', { type: 'string', format: 'date-time' }),
          queryParam('to', 'Window end (exclusive)', { type: 'string', format: 'date-time' }),
        ],
        responses: {
          '200': jsonResponse('Usage breakdown', ref('UsageBreakdown')),
          '400': errorResponse('Invalid from/to timestamp (code BAD_REQUEST)'),
          ...adminResponses,
          '500': errorResponse('Internal error (code INTERNAL_ERROR)'),
        },
      },
    },

    // ── Schedules ──
    '/api/schedules': {
      get: {
        tags: ['Schedules'],
        summary: 'List schedules',
        operationId: 'listSchedules',
        parameters: [
          queryParam('enabled', 'Filter by enabled flag ("true" / "false")', { type: 'string', enum: ['true', 'false'] }),
          queryParam('kind', 'Filter by schedule kind', { type: 'string', enum: ['agent', 'skill', 'tool'] }),
          queryParam('status', 'Filter by last run status', { type: 'string', enum: ['never', 'success', 'error'] }),
          queryParam('limit', 'Max results (store default 100)', { type: 'integer' }),
        ],
        responses: {
          '200': jsonResponse('Schedule list', {
            type: 'object',
            required: ['count', 'schedules'],
            properties: { count: { type: 'integer' }, schedules: { type: 'array', items: ref('Schedule') } },
          }),
          '400': errorResponse('Invalid limit'),
          '500': errorResponse('Store error (e.g. MongoDB not connected)'),
        },
      },
      post: {
        tags: ['Schedules'],
        summary: 'Create a schedule (5-field cron, nextRun computed server-side)',
        operationId: 'createSchedule',
        'x-required-capability': 'configure', // RBAC v1 (ADR-013)
        requestBody: jsonBody({
          type: 'object',
          required: ['name', 'cronExpr', 'kind', 'target', 'message'],
          properties: {
            name: { type: 'string' },
            cronExpr: { type: 'string', description: '5-field cron expression, e.g. "0 9 * * *"' },
            kind: { type: 'string', enum: ['agent', 'skill', 'tool'] },
            target: { type: 'string' },
            message: { type: 'string' },
            repo: { type: 'string' },
            includeMemoryContext: { type: 'boolean', default: false },
            enabled: { type: 'boolean', default: true },
          },
        }),
        responses: {
          '201': jsonResponse('Created schedule', ref('Schedule')),
          '400': errorResponse('Missing required fields, unknown kind, or invalid cron expression'),
          '500': errorResponse('Store error'),
        },
      },
    },
    '/api/schedules/{id}': {
      get: {
        tags: ['Schedules'],
        summary: 'Get a schedule by id',
        operationId: 'getSchedule',
        parameters: [pathParam('id', 'Schedule id (sched-…)')],
        responses: {
          '200': jsonResponse('Schedule', ref('Schedule')),
          '404': errorResponse('Schedule not found'),
          '500': errorResponse('Store error'),
        },
      },
      patch: {
        tags: ['Schedules'],
        summary: 'Update a schedule (nextRun recomputed only when cronExpr changes)',
        operationId: 'updateSchedule',
        'x-required-capability': 'configure', // RBAC v1 (ADR-013)
        parameters: [pathParam('id', 'Schedule id')],
        requestBody: jsonBody({
          type: 'object',
          properties: {
            name: { type: 'string' },
            cronExpr: { type: 'string' },
            message: { type: 'string' },
            repo: { type: 'string' },
            includeMemoryContext: { type: 'boolean' },
            enabled: { type: 'boolean' },
          },
        }),
        responses: {
          '200': jsonResponse('Updated schedule', ref('Schedule')),
          '400': errorResponse('Invalid cron expression'),
          '404': errorResponse('Schedule not found'),
          '500': errorResponse('Store error'),
        },
      },
      delete: {
        tags: ['Schedules'],
        summary: 'Delete a schedule',
        operationId: 'deleteSchedule',
        'x-required-capability': 'configure', // RBAC v1 (ADR-013)
        parameters: [pathParam('id', 'Schedule id')],
        responses: {
          '200': jsonResponse('Deleted', {
            type: 'object',
            required: ['deleted', 'scheduleId'],
            properties: { deleted: { type: 'boolean', enum: [true] }, scheduleId: { type: 'string' } },
          }),
          '404': errorResponse('Schedule not found'),
          '500': errorResponse('Store error'),
        },
      },
    },
    '/api/schedules/{id}/run': {
      post: {
        tags: ['Schedules'],
        summary: 'Run a schedule immediately (delegates to the schedules_run_now MCP handler; preserves nextRun)',
        operationId: 'runScheduleNow',
        'x-required-capability': 'configure', // RBAC v1 (ADR-013)
        parameters: [pathParam('id', 'Schedule id')],
        responses: {
          '200': jsonResponse('Run result — dispatch failures are still 200 with dispatched: false', {
            type: 'object',
            properties: {
              dispatched: { type: 'boolean' },
              error: { type: 'string', description: 'Present when the dispatch failed' },
              schedule: ref('Schedule'),
            },
            additionalProperties: true,
          }),
          '404': errorResponse('Schedule not found'),
          '500': errorResponse('Handler error'),
        },
      },
    },

    // ── Tasks ──
    '/api/tasks': {
      get: {
        tags: ['Tasks'],
        summary: 'List tasks',
        operationId: 'listTasks',
        parameters: [
          queryParam('repo', 'Filter by repo', { type: 'string' }),
          queryParam('status', 'Filter by status', { type: 'string', enum: ['pending', 'working', 'review', 'done', 'blocked'] }),
          queryParam('priority', 'Filter by priority', { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }),
          queryParam('assignedAgent', 'Filter by assigned agent', { type: 'string' }),
          queryParam('limit', 'Max results (store default 50)', { type: 'integer' }),
        ],
        responses: {
          '200': jsonResponse('Task list', {
            type: 'object',
            required: ['count', 'tasks'],
            properties: { count: { type: 'integer' }, tasks: { type: 'array', items: ref('Task') } },
          }),
          '400': errorResponse('Invalid limit'),
          '500': errorResponse('Store error'),
        },
      },
      post: {
        tags: ['Tasks'],
        summary: 'Create a task (defaults: priority P2, source manual)',
        operationId: 'createTask',
        'x-required-capability': 'work', // RBAC v1 (ADR-013)
        requestBody: jsonBody({
          type: 'object',
          required: ['repo', 'title'],
          properties: {
            repo: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], default: 'P2' },
            assignedAgent: { type: 'string' },
            recommendedModel: { type: 'string' },
            source: { type: 'string', enum: ['manual', 'connect-hub', 'auto-detected', 'scheduler', 'telegram'], default: 'manual' },
            sourceId: { type: 'string' },
            notes: { type: 'string' },
          },
        }),
        responses: {
          '201': jsonResponse('Created task', ref('Task')),
          '400': errorResponse('repo and title required'),
          '500': errorResponse('Store error'),
        },
      },
    },
    '/api/tasks/next': {
      get: {
        tags: ['Tasks'],
        summary: 'Highest-priority pending task plus a per-status queue summary',
        operationId: 'getNextTask',
        parameters: [queryParam('repo', 'Restrict to one repo', { type: 'string' })],
        responses: {
          '200': jsonResponse('Next task, or { message: "No pending tasks" } when the queue is empty', {
            type: 'object',
            properties: {
              task: ref('Task'),
              queueSummary: ref('TaskQueueSummary'),
              message: { type: 'string', description: 'Only present when the queue is empty' },
            },
          }),
          '500': errorResponse('Store error'),
        },
      },
    },
    '/api/tasks/{id}': {
      patch: {
        tags: ['Tasks'],
        summary: 'Update a task (status transitions stamp startedAt/completedAt)',
        operationId: 'updateTask',
        'x-required-capability': 'work', // RBAC v1 (ADR-013)
        parameters: [pathParam('id', 'Task id (task-…)')],
        requestBody: jsonBody({
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'working', 'review', 'done', 'blocked'] },
            priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
            assignedAgent: { type: 'string' },
            recommendedModel: { type: 'string' },
            prUrl: { type: 'string' },
            notes: { type: 'string' },
            telegramMessageId: { type: 'integer' },
          },
        }),
        responses: {
          '200': jsonResponse('Updated task', ref('Task')),
          '404': errorResponse('Task not found'),
          '500': errorResponse('Store error'),
        },
      },
    },

    // ── Orchestration ──
    '/api/fleet': {
      get: {
        tags: ['Orchestration'],
        summary: 'Fleet overview across managed repos (delegates to the fleet_overview MCP handler)',
        operationId: 'getFleetOverview',
        responses: {
          '200': jsonResponse('Fleet overview (repos / tasks / schedules / spend / topRepos)', {
            type: 'object',
            additionalProperties: true,
          }),
          '500': errorResponse('Handler error'),
        },
      },
    },
    '/api/dispatch': {
      post: {
        tags: ['Orchestration'],
        summary: 'Run a dispatch cycle (invokes specialist agents — spends real LLM budget; admin-gated)',
        operationId: 'runDispatchCycle',
        security: adminSecurity,
        requestBody: jsonBody({
          type: 'object',
          properties: {
            maxTasks: { type: 'integer', minimum: 1, maximum: 10, description: 'Clamped 1–10 by the dispatch_cycle handler' },
            dailySpendCapUsd: { type: 'number', description: 'Numeric strings also accepted' },
            telegramChatId: { type: 'string' },
          },
        }, false),
        responses: {
          '200': jsonResponse('Dispatch cycle result', {
            type: 'object',
            properties: {
              tasksProcessed: { type: 'integer' },
              tasksSucceeded: { type: 'integer' },
              tasksFailed: { type: 'integer' },
              tasksSkipped: { type: 'integer' },
              totalCostUsd: { type: 'number' },
              details: { type: 'array', items: { type: 'object' } },
            },
            additionalProperties: true,
          }),
          ...adminResponses,
          '500': errorResponse('Internal error (code INTERNAL_ERROR)'),
        },
      },
    },

    // ── Tenants (admin) ──
    '/api/tenants/bulk-import': {
      post: {
        tags: ['Tenants'],
        summary: 'Bulk-provision tenants + owner accounts from a CSV/JSON row set (reseller/agency onboarding, admin-gated)',
        operationId: 'bulkImportTenants',
        security: adminSecurity,
        requestBody: jsonBody({
          type: 'object',
          required: ['format', 'data'],
          properties: {
            format: { type: 'string', enum: ['csv', 'json'], description: "'csv' expects a raw CSV string in `data`; 'json' expects an array (or JSON-encoded string of an array) of row objects" },
            data: { description: 'CSV text, or a JSON array of {name, plan, seats, adminEmail} rows' },
            dryRun: { type: 'boolean', description: 'Validate/preview only, no writes. Defaults to true — pass false to actually provision.' },
            provisionedBy: { type: 'string', description: 'Operator identity, stamped into each created tenant’s metadata' },
          },
        }),
        responses: {
          '200': jsonResponse('Per-row validation/provisioning report', {
            type: 'object',
            required: ['batchId', 'dryRun', 'totalRows', 'validRows', 'invalidRows', 'createdRows', 'failedRows', 'results'],
            properties: {
              batchId: { type: 'string' },
              dryRun: { type: 'boolean' },
              totalRows: { type: 'integer' },
              validRows: { type: 'integer' },
              invalidRows: { type: 'integer' },
              createdRows: { type: 'integer' },
              failedRows: { type: 'integer' },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    row: { type: 'integer' },
                    name: { type: 'string' },
                    plan: { type: 'string', enum: ['free', 'solo', 'team', 'scale'] },
                    seats: { type: 'integer' },
                    adminEmail: { type: 'string' },
                    status: { type: 'string', enum: ['valid', 'invalid', 'created', 'error'] },
                    tenantId: { type: 'string' },
                    apiKey: { type: 'string', description: 'Show-once raw API key — present only on a freshly created row' },
                    errors: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          }),
          '400': errorResponse("format must be 'csv'/'json', unparsable data, or over the per-batch row cap (code BAD_REQUEST)"),
          ...adminResponses,
        },
      },
    },

    // ── Notifications ───────────────────────────────────

    '/api/notifications': {
      post: {
        tags: ['Notifications'],
        summary: 'Send a notification to one or more channels',
        operationId: 'sendNotification',
        requestBody: jsonBody({
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Notification body text' },
            channels: { type: 'array', items: { type: 'string' }, description: 'Target channels (default: all enabled)' },
            chatId: { type: 'string', description: 'Specific chat/channel ID' },
            level: { type: 'string', enum: ['info', 'warning', 'error', 'critical'], description: 'Severity level (default: info)' },
            title: { type: 'string', description: 'Bold title line' },
            source: { type: 'string', description: 'Source identifier (e.g. webhook, health-alert)' },
          },
          required: ['message'],
        }),
        responses: {
          '200': jsonResponse('Notification result', {
            type: 'object',
            properties: {
              sent: { type: 'array', items: { type: 'object' } },
              totalSent: { type: 'integer' },
              totalFailed: { type: 'integer' },
            },
          }),
          '400': errorResponse('Missing message field'),
          '500': errorResponse('Internal error'),
        },
      },
      get: {
        tags: ['Notifications'],
        summary: 'Get recent notification history',
        operationId: 'listNotifications',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 20 } },
        ],
        responses: {
          '200': jsonResponse('Notification history', {
            type: 'object',
            properties: {
              count: { type: 'integer' },
              notifications: { type: 'array', items: { type: 'object' } },
            },
          }),
        },
      },
    },

    // ── Webhooks ─────────────────────────────────────────

    '/api/webhooks/github': {
      post: {
        tags: ['Webhooks'],
        summary: 'Receive GitHub webhook events (issues, PRs, CI, pushes)',
        operationId: 'handleGitHubWebhook',
        description: 'Verifies HMAC-SHA256 signature against GITHUB_WEBHOOK_SECRET env var. Auto-creates tasks from issues, sends Telegram notifications for PRs and CI failures.',
        parameters: [
          { name: 'x-github-event', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'x-hub-signature-256', in: 'header', schema: { type: 'string' } },
          { name: 'x-github-delivery', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: jsonBody({ type: 'object', additionalProperties: true }),
        responses: {
          '200': jsonResponse('Webhook result', {
            type: 'object',
            properties: {
              handled: { type: 'boolean' },
              event: { type: 'string' },
              action: { type: 'string' },
              summary: { type: 'string' },
              taskCreated: { type: 'string' },
              notificationSent: { type: 'boolean' },
            },
          }),
          '401': errorResponse('Invalid webhook signature'),
          '500': errorResponse('Internal error'),
        },
      },
    },

    '/api/webhooks/github/{tenantId}': {
      post: {
        tags: ['Webhooks'],
        summary: 'Receive GitHub webhook events scoped to one tenant',
        operationId: 'handleGitHubWebhookForTenant',
        description: 'Per-tenant variant of /api/webhooks/github: verifies HMAC-SHA256 against that tenant\'s own Tenant.githubWebhookSecret (falls back to GITHUB_WEBHOOK_SECRET only for the default tenant). Dedupes by x-github-delivery. Auto-creates tasks from issues, advances tasks referenced in push commit messages, sends Telegram notifications for PRs and CI failures.',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'x-github-event', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'x-hub-signature-256', in: 'header', schema: { type: 'string' } },
          { name: 'x-github-delivery', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: jsonBody({ type: 'object', additionalProperties: true }),
        responses: {
          '200': jsonResponse('Webhook result', {
            type: 'object',
            properties: {
              handled: { type: 'boolean' },
              event: { type: 'string' },
              action: { type: 'string' },
              summary: { type: 'string' },
              taskCreated: { type: 'string' },
              notificationSent: { type: 'boolean' },
              tasksAdvanced: { type: 'array', items: { type: 'string' } },
            },
          }),
          '401': errorResponse('Invalid webhook signature'),
          '500': errorResponse('Internal error'),
        },
      },
    },

    // ── Health Alerts ────────────────────────────────────

    '/api/health/alerts': {
      get: {
        tags: ['Alerts'],
        summary: 'Get health alerting status and latest check result',
        operationId: 'getHealthAlerts',
        parameters: [
          { name: 'run', in: 'query', schema: { type: 'boolean' }, description: 'Set to true to force an immediate check cycle' },
        ],
        responses: {
          '200': jsonResponse('Health alert status', {
            type: 'object',
            properties: {
              latest: { type: 'object', nullable: true },
              alerting: {
                type: 'object',
                properties: {
                  active: { type: 'boolean' },
                  intervalMinutes: { type: 'integer' },
                  lastRun: { type: 'string', format: 'date-time', nullable: true },
                  lastOverall: { type: 'string', nullable: true },
                  dedupWindowHours: { type: 'number' },
                  trackedAlerts: { type: 'integer' },
                },
              },
            },
          }),
        },
      },
    },
  };
}

// ── Public API ───────────────────────────────────────────────

export function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'myAI Gateway API',
      version: '0.1.0',
      description:
        'REST surface of the myAI management gateway — the local orchestration hub for the AI framework. ' +
        'Exposes specialist agents and skill playbooks, memory/RAG search over the embedded corpus, ' +
        'agent sessions and message routing, cron-style schedules, the cross-repo task queue, ' +
        'fleet orchestration (overview + dispatch cycles), and admin-gated LLM budget/spend reporting.\n\n' +
        'RBAC v1 (ADR-013): mutation routes require a capability derived from the caller\'s ' +
        'server-side role (`viewer` < `member` < `admin` < `owner`; machine principals `system`/`operator`). ' +
        'Capabilities: `read` (viewer+), `work` (member+, e.g. task create/update), `configure` ' +
        '(admin+, e.g. schedule CRUD), `members` (admin+, e.g. invites), `billing` (owner+). ' +
        'Each enforced operation is annotated with `x-required-capability`. Enforcement is gated by ' +
        'the `RBAC_ENFORCE` flag — off (default) runs in shadow mode (logs `rbac.shadow`, allows); ' +
        'on returns 403 FORBIDDEN. Budget routes additionally require the operator `X-Admin-Token`.',
    },
    servers: [{ url: 'http://localhost:3200', description: 'Local gateway' }],
    tags: [
      { name: 'Health', description: 'Liveness, deep health, and gateway status' },
      { name: 'Docs', description: 'This spec and the HTML reference' },
      { name: 'Agents', description: 'Specialist agent registry' },
      { name: 'Skills', description: 'Skill playbook registry' },
      { name: 'Hooks', description: 'Event hooks' },
      { name: 'Rules', description: 'Framework rules' },
      { name: 'Repos', description: 'Managed repositories' },
      { name: 'Channels', description: 'Channel adapters' },
      { name: 'Memory', description: 'SONA memory search and context building' },
      { name: 'Vectors', description: 'RAG vector search and indexing' },
      { name: 'Sessions', description: 'Agent sessions and message routing' },
      { name: 'Budgets', description: 'LLM spend reporting (admin-gated)' },
      { name: 'Tenants', description: 'Cross-tenant provisioning (admin-gated)' },
      { name: 'Schedules', description: 'Cron-style schedule CRUD and manual runs' },
      { name: 'Tasks', description: 'Cross-repo task queue' },
      { name: 'Orchestration', description: 'Fleet overview and dispatch cycles' },
      { name: 'Notifications', description: 'Cross-channel notification delivery' },
      { name: 'Webhooks', description: 'Inbound webhook receivers (GitHub)' },
      { name: 'Alerts', description: 'Proactive health alerting' },
    ],
    paths: buildPaths(),
    components: {
      schemas,
      securitySchemes: {
        AdminToken: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Admin-Token',
          description:
            'Must match the ADMIN_API_TOKEN env var. Endpoints return 503 ADMIN_DISABLED when the server has no token configured, 401 UNAUTHORIZED on a missing/wrong header.',
        },
        SessionJWT: {
          type: 'apiKey',
          in: 'cookie',
          name: 'myai_token',
          description:
            'Session JWT (also accepted as `Authorization: Bearer <jwt>`). Carries the caller\'s ' +
            'role claim, which RBAC v1 (ADR-013) maps to capabilities. Routes marked ' +
            '`x-required-capability` return 403 FORBIDDEN when the role lacks the capability and ' +
            'RBAC_ENFORCE is on (shadow mode otherwise).',
        },
      },
    },
  };
}

/**
 * Minimal self-contained docs page. Fetches the OpenAPI document from
 * `specUrl` and renders it entirely client-side with vanilla JS + inline CSS —
 * no external CDN scripts, works offline. Operations are grouped by tag,
 * collapsible via <details>, with method-colored badges.
 */
export function docsHtml(specUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>myAI Gateway API — Reference</title>
<style>
  :root {
    --bg: #0f1117; --panel: #161a23; --border: #262c3a; --text: #d7dce5;
    --muted: #8b94a7; --accent: #7aa2f7;
    --get: #2f81f7; --post: #3fb950; --patch: #d29922; --put: #a371f7; --delete: #f85149;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 8px; }
  .server { color: var(--accent); font-family: ui-monospace, monospace; font-size: 13px; }
  h2 { font-size: 18px; margin: 36px 0 10px; padding-bottom: 6px;
       border-bottom: 1px solid var(--border); }
  .tag-desc { color: var(--muted); font-size: 13px; margin: -6px 0 10px; }
  details.op { background: var(--panel); border: 1px solid var(--border);
               border-radius: 8px; margin: 8px 0; }
  details.op > summary { display: flex; align-items: center; gap: 10px;
                         padding: 10px 14px; cursor: pointer; list-style: none; }
  details.op > summary::-webkit-details-marker { display: none; }
  .badge { font: 700 11px/1 ui-monospace, monospace; color: #fff; padding: 5px 8px;
           border-radius: 4px; min-width: 52px; text-align: center; letter-spacing: .5px; }
  .badge.get { background: var(--get); } .badge.post { background: var(--post); }
  .badge.patch { background: var(--patch); } .badge.put { background: var(--put); }
  .badge.delete { background: var(--delete); }
  .path { font-family: ui-monospace, monospace; font-size: 14px; }
  .sum { color: var(--muted); font-size: 13px; flex: 1; text-align: right; }
  .lock { font-size: 13px; }
  .body { padding: 4px 16px 14px; border-top: 1px solid var(--border); }
  .body h4 { margin: 12px 0 6px; font-size: 13px; text-transform: uppercase;
             letter-spacing: .6px; color: var(--muted); }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; }
  code, pre { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
  pre { background: #0b0d12; border: 1px solid var(--border); border-radius: 6px;
        padding: 10px 12px; overflow-x: auto; white-space: pre; margin: 6px 0; }
  .status { font-weight: 700; } .s2 { color: var(--post); } .s4 { color: var(--patch); }
  .s5 { color: var(--delete); }
  .err { color: var(--delete); padding: 24px; }
</style>
</head>
<body>
<main>
  <h1 id="title">Loading…</h1>
  <p class="sub" id="desc"></p>
  <p class="server" id="server"></p>
  <div id="content"></div>
</main>
<script>
(function () {
  'use strict';
  var SPEC_URL = ${JSON.stringify(specUrl)};
  var METHODS = ['get', 'post', 'put', 'patch', 'delete'];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function resolve(spec, schema) {
    if (schema && schema.$ref) {
      var name = String(schema.$ref).split('/').pop();
      var resolved = spec.components && spec.components.schemas && spec.components.schemas[name];
      return { name: name, schema: resolved || {} };
    }
    return { name: null, schema: schema || {} };
  }

  // Render a schema as compact indented text (resolving $refs up to 2 levels).
  function schemaText(spec, schema, indent, depth) {
    var r = resolve(spec, schema);
    var s = r.schema;
    var prefix = r.name ? r.name + ' ' : '';
    if (depth > 2) return prefix || '…';
    if (s.enum) return prefix + (s.type || 'string') + ' (' + s.enum.join(' | ') + ')';
    if (s.type === 'array') {
      return prefix + 'array of ' + schemaText(spec, s.items || {}, indent, depth + 1);
    }
    if (s.type === 'object' || s.properties) {
      var props = s.properties || {};
      var req = s.required || [];
      var keys = Object.keys(props);
      if (!keys.length) return prefix + 'object';
      var pad = '  '.repeat(indent + 1);
      var lines = keys.map(function (k) {
        var star = req.indexOf(k) >= 0 ? '*' : '';
        return pad + k + star + ': ' + schemaText(spec, props[k], indent + 1, depth + 1);
      });
      return prefix + '{\\n' + lines.join('\\n') + '\\n' + '  '.repeat(indent) + '}';
    }
    var t = Array.isArray(s.type) ? s.type.join(' | ') : (s.type || 'any');
    return prefix + t + (s.format ? ' (' + s.format + ')' : '');
  }

  function renderOp(spec, path, method, op) {
    var d = el('details', 'op');
    var summary = el('summary');
    summary.appendChild(el('span', 'badge ' + method, method.toUpperCase()));
    summary.appendChild(el('span', 'path', path));
    if (op.security) summary.appendChild(el('span', 'lock', '\\uD83D\\uDD12'));
    summary.appendChild(el('span', 'sum', op.summary || ''));
    d.appendChild(summary);

    var body = el('div', 'body');

    if (op.parameters && op.parameters.length) {
      body.appendChild(el('h4', null, 'Parameters'));
      var table = el('table');
      var head = el('tr');
      ['Name', 'In', 'Type', 'Description'].forEach(function (h) { head.appendChild(el('th', null, h)); });
      table.appendChild(head);
      op.parameters.forEach(function (p) {
        var tr = el('tr');
        tr.appendChild(el('td', null, p.name + (p.required ? ' *' : '')));
        tr.appendChild(el('td', null, p.in));
        tr.appendChild(el('td', null, schemaText(spec, p.schema || {}, 0, 2)));
        tr.appendChild(el('td', null, p.description || ''));
        table.appendChild(tr);
      });
      body.appendChild(table);
    }

    if (op.requestBody) {
      body.appendChild(el('h4', null, 'Request body' + (op.requestBody.required === false ? ' (optional)' : '')));
      var rbContent = op.requestBody.content || {};
      var rbMedia = rbContent['application/json'] || rbContent[Object.keys(rbContent)[0]] || {};
      var pre = el('pre');
      pre.textContent = schemaText(spec, rbMedia.schema || {}, 0, 0);
      body.appendChild(pre);
    }

    body.appendChild(el('h4', null, 'Responses'));
    Object.keys(op.responses || {}).sort().forEach(function (code) {
      var resp = op.responses[code];
      var line = el('div');
      var cls = 'status s' + code.charAt(0);
      line.appendChild(el('span', cls, code));
      line.appendChild(document.createTextNode(' — ' + (resp.description || '')));
      body.appendChild(line);
      var content = resp.content || {};
      var media = content['application/json'];
      if (media && media.schema) {
        var rp = el('pre');
        rp.textContent = schemaText(spec, media.schema, 0, 0);
        body.appendChild(rp);
      }
    });

    d.appendChild(body);
    return d;
  }

  function render(spec) {
    document.getElementById('title').textContent = spec.info.title + ' — v' + spec.info.version;
    document.getElementById('desc').textContent = spec.info.description || '';
    var servers = (spec.servers || []).map(function (s) { return s.url; }).join(', ');
    document.getElementById('server').textContent = servers ? 'Server: ' + servers : '';

    var groups = {};
    var order = [];
    Object.keys(spec.paths || {}).forEach(function (path) {
      var item = spec.paths[path];
      METHODS.forEach(function (method) {
        if (!item[method]) return;
        var tag = (item[method].tags && item[method].tags[0]) || 'Other';
        if (!groups[tag]) { groups[tag] = []; order.push(tag); }
        groups[tag].push({ path: path, method: method, op: item[method] });
      });
    });

    // Respect spec-declared tag order where available.
    var declared = (spec.tags || []).map(function (t) { return t.name; });
    var tagNames = declared.filter(function (t) { return groups[t]; })
      .concat(order.filter(function (t) { return declared.indexOf(t) < 0; }));

    var content = document.getElementById('content');
    var tagDescs = {};
    (spec.tags || []).forEach(function (t) { tagDescs[t.name] = t.description || ''; });

    tagNames.forEach(function (tag) {
      content.appendChild(el('h2', null, tag));
      if (tagDescs[tag]) content.appendChild(el('p', 'tag-desc', tagDescs[tag]));
      groups[tag].forEach(function (entry) {
        content.appendChild(renderOp(spec, entry.path, entry.method, entry.op));
      });
    });
  }

  fetch(SPEC_URL)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(render)
    .catch(function (err) {
      document.getElementById('title').textContent = 'Failed to load API spec';
      var msg = el('div', 'err', 'Could not fetch ' + SPEC_URL + ': ' + err.message);
      document.getElementById('content').appendChild(msg);
    });
})();
</script>
</body>
</html>
`;
}

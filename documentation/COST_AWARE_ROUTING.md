# Cost-Aware Routing

> Route tasks to the cheapest capable provider. Skip LLM calls entirely when possible. Track costs per session.

## Routing Tiers

```
Task arrives
    │
    ▼
┌─────────────────────────┐
│ Tier 0: Skip-LLM        │  No AI needed — use templates, grep, file ops
│ (cost: $0)               │
└──────────┬──────────────┘
           │ needs reasoning
           ▼
┌─────────────────────────┐
│ Tier 1: Local CLI        │  Claude Code, Gemini CLI, Copilot
│ (cost: $0, time: varies) │  Free but slower, may timeout
└──────────┬──────────────┘
           │ timed out or unavailable
           ▼
┌─────────────────────────┐
│ Tier 2: Budget Cloud     │  DeepSeek V3, Gemini Flash
│ (cost: ~$0.001/req)      │  Cheap, fast, good for most tasks
└──────────┬──────────────┘
           │ needs premium quality
           ▼
┌─────────────────────────┐
│ Tier 3: Premium Cloud    │  Claude Sonnet, GPT-4o
│ (cost: ~$0.01/req)       │  Higher quality, used for complex reasoning
└──────────┬──────────────┘
           │ needs best-in-class
           ▼
┌─────────────────────────┐
│ Tier 4: Ultra            │  Claude Opus, GPT-4 Turbo
│ (cost: ~$0.05/req)       │  Reserved for architecture, complex code gen
└─────────────────────────┘
```

## Tier 0: Skip-LLM Operations

Many tasks don't need an LLM at all. Route these directly:

| Task Type | Method | Example |
|-----------|--------|---------|
| File scaffolding | Templates | `nextjs-page-create` → copy template, replace placeholders |
| Schema generation | Pattern matching | Mongoose schema from field list → template fill |
| Config generation | Deterministic | Docker Compose from stack definition → template |
| Linting/formatting | CLI tools | `eslint --fix`, `prettier --write` |
| Git operations | Shell commands | Commit, push, branch, merge — no LLM needed |
| Status reporting | File reading | Read STATE.md, format as table |
| Health checks | curl/CLI | Hit endpoints, parse responses |
| Dependency audit | npm audit | Run CLI, parse JSON output |

**Implementation:** Each skill playbook should declare `skip_llm: true` if it can be executed purely with templates and shell commands.

## Complexity Estimator

Before routing to an LLM, estimate task complexity:

| Signal | Low (Tier 1-2) | Medium (Tier 2-3) | High (Tier 3-4) |
|--------|----------------|-------------------|-----------------|
| Files touched | 1-2 | 3-5 | 6+ |
| Cross-lane | No | Partial | Full cross-cutting |
| Reasoning depth | Pattern match | Multi-step | Architecture decision |
| Code generation | Boilerplate | Business logic | Algorithm design |
| Context needed | Current file | Module | Full codebase |

**Scoring formula:**
```
complexity = (files_touched * 0.3) + (cross_lane * 0.2) + (reasoning_depth * 0.3) + (context_needed * 0.2)

Route:
  complexity < 0.3  → Tier 1 (local CLI)
  complexity < 0.5  → Tier 2 (budget cloud)
  complexity < 0.8  → Tier 3 (premium cloud)
  complexity >= 0.8 → Tier 4 (ultra)
```

## Provider Cost Table

| Provider | Model | Input (per 1M tokens) | Output (per 1M tokens) | Tier |
|----------|-------|----------------------|------------------------|------|
| DeepSeek | V3 | $0.27 | $1.10 | 2 |
| DeepSeek | R1 | $0.55 | $2.19 | 3 |
| Google | Gemini Flash | $0.075 | $0.30 | 2 |
| Google | Gemini Pro | $1.25 | $5.00 | 3 |
| Anthropic | Haiku 4.5 | $0.80 | $4.00 | 2 |
| Anthropic | Sonnet 4.6 | $3.00 | $15.00 | 3 |
| Anthropic | Opus 4.7 | $15.00 | $75.00 | 4 |
| OpenAI | GPT-4o mini | $0.15 | $0.60 | 2 |
| OpenAI | GPT-4o | $2.50 | $10.00 | 3 |
| Local CLI | Claude/Gemini | $0 | $0 | 1 |

*Prices as of March 2026. Update periodically.*

## Session Cost Tracking

Track cumulative costs per session:

```json
{
  "session_id": "2026-03-28",
  "total_cost_usd": 0.23,
  "requests": [
    {"provider": "deepseek-v3", "tokens_in": 2500, "tokens_out": 1200, "cost": 0.002},
    {"provider": "claude-sonnet", "tokens_in": 5000, "tokens_out": 3000, "cost": 0.060}
  ],
  "tier_distribution": {
    "skip_llm": 12,
    "local_cli": 3,
    "budget_cloud": 8,
    "premium_cloud": 2,
    "ultra": 0
  },
  "savings_vs_ultra": "$4.77 (95% saved)"
}
```

## Budget Guards

| Guard | Trigger | Action |
|-------|---------|--------|
| Session budget | Cost > $1.00 | Warn user, suggest downgrading tiers |
| Single request | Cost > $0.50 | Require confirmation before sending |
| Daily budget | Cost > $5.00 | Block premium/ultra, force budget tier |
| Monthly budget | Cost > $50.00 | Block all cloud, force local CLI only |

Configurable in `memory/config/cost-config.json` (created when needed).

### Budget-Aware Failover Chain

The runtime failover chain (`runtime/src/llm/provider.ts::complete()`) walks the
configured provider chain on any recoverable error (network / HTTP 429 / timeout
/ circuit-open / rate-limit-exhausted), with per-provider circuit-breaker +
exponential backoff supplied by `resilience.ts`. That failover is now **budget
aware**: before a paid fallback provider is attempted, its estimated cost (from
the token estimate × the pricing table) is checked against the tenant's
remaining budget. Fallbacks that would exceed the remaining headroom are
dropped, so a cheap primary failing never silently cascades onto a pricier
provider than the tenant can pay for.

Always retained regardless of budget:

- the **primary** provider (it already passed the pre-call budget guard); and
- every **free** provider (Ollama / claude-cli / claude-bridge) — the sovereign
  floor, so a laptop with Ollama keeps answering even at zero budget.

Wiring: `applyBudgetGuard` (the one place that knows a tenant's remaining spend
across the monthly / daily / per-channel caps) computes `remainingUsd` and
stamps it onto `req.failoverBudget`; `complete()` filters the chain through the
pure `failover.ts::budgetAwareChain`. Default-off — when budgets are disabled
no `failoverBudget` is set and the chain is walked unfiltered (byte-identical to
before). Mitigates GRAND_PRODUCT risk #1 (provider dependency).

## Routing Decision Flow

```
1. Can this be done without an LLM? → Tier 0 (skip)
2. Is a local CLI tool available and fast enough? → Tier 1
3. Estimate complexity
4. Route to cheapest tier that meets complexity requirement
5. On failure/timeout → escalate one tier and retry
6. Track cost and update session totals
7. Warn if approaching budget threshold
```

## Integration Points

| Component | How Cost Routing Connects |
|-----------|--------------------------|
| **Skills** | Each SKILL.md can declare `complexity: low/medium/high` and `skip_llm: true/false` |
| **Swarm coordinator** | Estimates total cost of swarm dispatch before executing |
| **Agent mode** | Reports session cost in status output |
| **Session close** | Logs total session cost to claude_log.md |
| **SONA patterns** | Patterns include cost metrics from when they were created |

## Per-Tenant Control Plane (Phase 3)

Beyond the GLOBAL env config above, each tenant has an editable **routing policy**
(dashboard → `/system` → **Policy** tab). Stored per-tenant in Mongo
(`routingpolicies`), edited via `/api/routing-policy`:

| Field | Meaning |
|-------|---------|
| `enabled` | Master switch — off → tenant inherits the global gateway config |
| `defaultModel` | Fallback model for any priority without an override |
| `priorityOverrides` | Per task-priority (P0–P3) model override |
| `monthlyBudgetUsd` | Monthly spend cap (0 = unlimited) |
| `softLimitPct` | Fraction of cap where the token guard **downgrades** premium/ultra → standard |
| `hardLimitPct` | Fraction of cap where the token guard **blocks cloud** (local CLI only) |

The pure core (validation, `resolveModel`, `budgetState`, `tokenGuardAction`,
`sanitizePolicy`) lives in `dashboard/src/lib/routing-policy.ts` and is unit-
tested (`routing-policy.test.ts`). The live Policy tab shows month-to-date spend
against the cap using the same soft/hard math the guard enforces.

**Gateway enforcement:** the dashboard is the control plane (read/write). For the
gateway router to *enforce* per-tenant policy it must read the `routingpolicies`
collection at dispatch time and apply `resolveModel` / `tokenGuardAction` — that
change ships from the MASTER checkout and requires a gateway rebuild.

## Implementation Status

This is a documentation-first design. Implementation will be added to AgentFlow (`knofler/agentFlow`) in `src/lib/ai/`:
- `src/lib/ai/cost-estimator.ts` — already exists (basic version)
- `src/lib/ai/router.ts` — already has provider fallback chains
- New: complexity scoring, tier selection, budget guards, session tracking

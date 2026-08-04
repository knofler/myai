# Changelog

All notable changes to **`ai-management`** (the `myai` CLI and the AI
Management Framework it installs) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.2] — 2026-08-04

### Removed
- **Removed the paid bug-bounty program.** myAI's vulnerability disclosure is now **responsible-disclosure only** — no monetary rewards. Deleted `documentation/BUG_BOUNTY_PROGRAM.md`, removed the paid-track references and $25–$1,500 payout tiers from `SECURITY.md` §7 and the dashboard security page, and stated credit-on-request only.

### Fixed
- Dashboard security page: replaced the residual "email the maintainer" line with the PVR-only intake (consistent with the v0.7.1 `SECURITY.md` §7 fix).

## [0.7.1] — 2026-08-04

### Security
- **Fixed the private vulnerability-disclosure intake** (reported privately). Enabled GitHub Private Vulnerability Reporting on the public repo so the "Report a vulnerability" button is available to external reporters — the preferred channel `SECURITY.md` §7 already promised.
- `SECURITY.md` §7: GitHub Security Advisories on `knofler/myai` is now the sole documented private channel; removed the non-functional "email the maintainer" fallback (no such address was ever published).
- `BUG_BOUNTY_PROGRAM.md` §4: corrected the intake target from the private `knofler/ai_management` (invisible to external reporters) to the public `knofler/myai`, so the disclosure policy and the bounty program no longer name different repos.

## [0.7.0] — 2026-08-04

### Added
- feat(marketplace): package myai-marketplace CLI as an installable bin (ADR-028 §6)
- feat(db): ADR-030 §2 getConnectionForTenant chokepoint — shared-tier no-op path
- feat(db): ADR-030 §4 isolationTier field + TenantDbBinding collection (schema-only)
- feat(marketplace): ADR-029 §5/§6 staging TTL sweep + per-tenant artifact upload quota
- feat(marketplace): ADR-029 §4 fetch-time artifact hash-recheck helper
- feat(marketplace): wire marketplace_publish upload path to the ADR-029 artifact store
- feat(runner): reap stale 'working' tasks past leaseUntil back to pending
- feat(runner): wire Codex/Gemini CLIs as L4 external-CLI runner backends
- feat(marketplace): ADR-029 artifact put/get-by-key interface + local backend
- feat(marketplace): operator review-queue UI with declaredTools widening diff (ADR-028 §4)
- feat(rbac): export marketplaceExposableTools() allowlist (ADR-028 §5)
- feat(marketplace): implement myai-marketplace validate/pack local CLI (ADR-028 §3)
- Merge pull request #400 from knofler/test
- feat(marketplace): implement marketplace_publish MCP tool (ADR-019 #2, ADR-028 §3)
- feat(ops): archive fully-popped prefixes of runner_backlog.jsonl
- feat(ops): schema/lint check for config/runner_backlog.jsonl
- feat(ops): surface queue_topup.sh planner drift on the SCHEDULE banner
- feat(ops): false-healthy empty-queue detector for the fleet
- feat(dashboard): replace connect 'coming soon' placeholder on /showcase with real content
- feat(dashboard): replace agentFlow 'coming soon' placeholder on /showcase with real content
- feat(fleet): wire ADR-015 §3 — FleetRun for the /projects fan-out composer
- feat(dashboard): surface task-defer starvation on /work Up Next tab
- feat(brain): implement B-4's $MYAI_RERANK_CMD hook backend
- feat(observability): promote pricing-staleness warning to SCHEDULE banner
- feat(soc2): continuous evidence store for Type II observation window (ADR-013 §5 follow-up)
- feat(billing): daily usage-metering reconcile sweep (ADR-014 follow-up)
- feat(runner): runner-lease runs log + dashboard view (ADR-011 slice 7)
- feat(runner): concurrency-lease dual-account binding (ADR-011 slice 6)
- feat(marketplace): Stripe Connect payout wiring for revenue-share enforcement (ADR-019 follow-up #4)
- feat(dashboard): surface work-type routing decision on task views (task-de8b40ff)
- feat(dashboard): surface agentic-fallback per-provider pass-rate on PoolCapacityPanel
- feat(myai-init): default greenfield scaffolds to bypassPermissions
- feat(runner): wire all-pools-capped exhaustion into agentic_fallback demotion lane
- feat(hooks): surface backlog-well-low warning on the SCHEDULE banner (task-d8a33c2f)
- feat(monitoring): alert on N consecutive route_task_model exhaustion defers
- feat(monitoring): wire pool-capacity drift detection into the alert pipeline
- feat(dashboard): Retrieval strategy card surfacing the retrieval_bandit's favored arm
- feat(observability): lane filter chip + fallback-ratio stat for execution-lane stamp (task-47098709)
- feat(budgets): add one-click apply for adaptive budget-cap suggestions
- feat(repos): tag headless new-app self-registration with its own provenance
- feat(observability): surface agentic-fallback day-ledger on dashboard + session close (task-eac0704e)
- feat(dashboard): add gift-codes admin tab (mint/list/revoke)
- feat(agentic-fallback): opt-in queue-depth overflow trigger (ADR follow-up)
- feat(agentic-fallback): per-provider quality ledger + rolling pass-rate
- feat(agentic-fallback): pre-run pricing-staleness check for DeepSeek/Kimi $/token table
- feat(router): wire the 13-work-type routing table from MULTI_PROVIDER_ORCHESTRATION.md §3
- feat(cli): wire `myai new-app <idea>` to agentFlow's headless pipeline
- feat(gateway): pool-capacity ground-truth drift self-check (task-0824a68e)
- feat(brain): ADR-023 Slice P2/P3 — onboarding upsell moment + cross-machine-sync KPI
- feat(doctor): warn when the runner-backlog well runs low (task-618ccbe7)
- feat(alerts): proactive alert on the API-credit RESERVE hard cap (task-d383b7e8)
- feat(brain): wire retrieval_bandit's recommended config into live B-3/B-4 loop
- feat(ops): proactive Docker VM disk-pressure guard before mongo WT_PANIC
- feat(dashboard): hosted-brain provisioning UI (ADR-023 Slice P1a)
- feat(revenue): nightly MRR-snapshot job + real historical NRR cohorts
- feat(security): admin surface for per-org MCP tool visibility override (task-01af5b05)
- feat(dashboard): surface adaptive budget-cap suggestions (Phase 5b §8 follow-up)
- feat(ops): push alert for the mongo-mirror schedule check (task-906c973f)
- feat(governance): audit-log PATCH /api/hooks toggles (task-bd18a5ec)
- feat(runner): stamp execution lane (claude|agentic-fallback) on task docs (task-b1776200)
- feat(brain): thread ADR-020 topic/tier into B-8 bundle ordering (task-82e5416b)
- feat(dashboard): Fleet Overview v0 observability fields on /projects (task-5911555d)
- feat(rbac): persist shadow-mode denials + surface a soak panel (ADR-013 §6)
- feat(ci): guard MCP tool surface against silent regression (Mythos Track 3)
- feat(router): stamp {routedProfile,routedModel,routedComplexity} on tasks for dashboard audit trail
- feat(monitoring): alert on repeated Atlas index recreate-on-wrong-type self-heal
- feat(monitoring): alert on agentic-fallback lane's own USD day-ledger cap (task-f5897132)
- feat(docs): capability-counts drift guard — derive shipped truth, block stale releases (task-cebe9567)
- feat(ci): auditable JSONL ledger for local-ci.sh posted commit statuses
- feat(llm): OpenRouter backend for the Kimi tier — free K2 lane without a paid Moonshot key (task-13b8f283)
- feat(ci): tracked-file hygiene gate — machine-local ledgers can never enter the index (task-3e11b004)
- feat(notifications): content-hash dedup + per-channel storm collapse in delivery path
- feat(dashboard): add loading + error boundaries to control-plane routes
- feat(llm): wire Gemini API as a Class-B gateway provider (task-1351f6ee)
- feat(repos): seed repocards-only repos into the tenant roster (ADR-021 Phase 2 tail, task-30683891)
- feat(brain): brain_lookup v2 — embedding-scored branch selection (task-62c8c6b8)
- feat(brain): ADR-020 one-time topic backfill pass + untagged-atom drift report (task-30874db9)
- feat(ops): myai sync schedule — installable timer for mongo_sync.sh + staleness alert (ADR-022)
- feat(dashboard): /marketplace — ADR-019 catalog browse + free-tier install UI (task-4ea6f99f)
- feat(brain): git-over-HTTP transport route for the hosted brain remote (ADR-017 deferred slice)
- feat(brain): explicit topic on every bash/runner brain_commit caller (ADR-020 rollout tail) (task-dfe2cbb7)
- feat(security): enforce RBAC capabilities on the MCP tool surface (task-6ff79627)
- feat(cli): myai setup — global first-run brain wizard
- feat(memory): feed brain session atoms into the RAG vector corpus
- feat(budget): add BudgetUsage daily/weekly rollup model for analytics
- feat(runner): anti-destructive guard for local-tier (qwen) commits
- feat(runner): capability×cost×availability model/account router (task-21dc2746)
- feat(brain): B-2 boot manifest in the boot path + B-8 prompt-cache-aware bundle ordering (task-463fce7d)
- feat(runner): $155 personal API credit as capped metered-fallback RESERVE pool (task-874364a3)
- feat(dashboard): hook enable/disable toggle from the UI — settings.json-backed (task-7ad7cb6d)
- feat(billing): downloadable branded invoice PDF — SDK-free Stripe fetch + built-in PDF writer (task-4dff7336)
- feat(monitoring): pool-capacity threshold alert — push when a subscription pool's weekly budget runs low (task-81e269ed)
- feat(billing): wire the usage meter into a real Stripe overage push — premium stamping + fleet period-end sweep (task-b3e501e8)
- feat(runner): non-Claude agentic fallback lane — DeepSeek/Kimi real edit→test→commit→push for Claude session-cap windows (task-4f813e39)
- feat(qa): external-repo fresh-install init E2E — 3 real stacks in a clean container (task-502c1aba)
- feat(ops): schedule the Atlas→local mongo mirror (launchd/cron) + doctor last-run check (task-b4c58215)
- feat(gateway): read-side local-first DB failover — MYAI_DB_FAILOVER=local (task-605e90b6)
- feat(runner): capacity-aware Fable auto-routing + all-3-models standard (task-56e65748)
- Merge pull request #392 from knofler/test
- feat(runner): Fable is mainstream — default worker model + pacing-ledger exemption
- feat(gateway): Docker MCP Toolkit catalog packaging for myAI (Phase 7)
- feat(budget): adaptive budget-cap suggestions from historical spend (Phase 5b §8)
- Merge pull request #391 from knofler/test
- feat(brain): ADR-020 topic-indexed GOLD/SILVER/BRONZE hierarchy + brain_lookup
- feat(hooks): session-start brain status sign (orange 🧠)

### Fixed
- fix(mcp): inline WORK_TYPE_ENUM into tool defs + refresh tool-surface baseline (132)
- fix(security): gate marketplace review-queue routes to operator-only (403)
- fix(compliance): wire runErasureSweep into the daily scheduler
- Merge pull request #399 from knofler/test
- fix(ops): queue_topup reads tasks JSON from stdin, not argv (ARG_MAX)
- fix(billing): mark usage-reconcile sweep as sanctioned cross-tenant (ADR-010 §3.4)
- fix(ops): archive_runner_backlog reads tasks JSON from stdin, not argv
- fix(runner): PLANNER duplicate-guard must check working/review, not just pending
- fix(budgets): wire BudgetCapOverride into gateway enforcement path
- fix(gateway): inventory brain_bandit_stats in TOOL_CAPS + contracts; pin budget tests to mid-month
- fix(selfheal): escalate gateway image-staleness warning across consecutive sessions
- fix(brain): close free-tier rotate loophole in hosted-brain plan gate
- fix(security): B-9 obfuscation salt — no shared fixed-default, mint+persist per-install salt
- fix(tests): resolve the 6 untracked pre-existing vitest failures
- fix(sdk): regenerate TS/Python SDKs for hooks-toggle + tenant MCP-tools endpoints
- fix: 2 test-gate failures from the overnight runner batch
- fix(runner): route_task_model exhaustion branch — defer instead of stall/misroute
- fix(tasks): guard against unauthorized bulk pending→blocked transitions
- fix(monitoring): broaden Atlas index health alert to all non-ok self-heal outcomes
- fix(runner): apply per-task worktree isolation to the default tenant too (task-6adc8df1)
- fix(rbac): gate webhook mutations + memory/vector import routes
- fix: restore scripts/fleet_resume.sh gutted by local-tier automated fix
- fix(planner): drop 2 items from the just-pushed refill made stale by concurrent test-branch work
- fix(security): remove stray unsanitized wt_sanitize redefinition in cli_task_runner.sh fallback
- fix(release): npm-auth preflight + post-publish verification in publish_release.sh
- fix(security): eliminate the well-known default GATEWAY_LOCAL_TOKEN (task-7f8b20a3)
- fix(ollama): write-time guard on local-tier tool_write_file + finish 4ece268 repair
- fix(billing): dedup Stripe webhook deliveries + out-of-order guard
- fix(git): restore .gitignore from main (qwen 4ece268 gutted 88 rules)
- fix(memory): provision the Atlas $vectorSearch index + boot-time self-heal (task-b875cf92)
- fix(init): stage init artifacts individually — missing .mcp.json no longer aborts the greenfield init commit
- fix(runner): stale-worktree sweep + working-watchdog honor per-tenant maxMinutes
- fix(security): wt_sanitize permits '.' and '/' — tenant-id path traversal in worktree paths
- Merge pull request #390 from knofler/test
- fix(memory): repair RAG vector retrieval returning empty for all queries

### Performance
- perf(runner): consolidate pick/resolve field extraction into one python3 parse

> 150+ commits since `v0.6.4` — grouped below by conventional-commit type. State/handoff
> checkpoint commits (`chore(state): ...`), routine runner-backlog refills
> (`chore(planner): refill runner backlog well ...`), and local-tier auto-fix/revert noise
> are intentionally omitted as non-user-facing.

### Added
- feat(dashboard): `/marketplace` — ADR-019 catalog browse + listing/install UI. Published-only catalog with search + kind/category filters, listing detail (versions table with manifest-hash integrity anchor), and an install panel driving the specced install state machine (install gate → active ↔ disabled → uninstalled, tenant-scoped). Free-tier installs only — paid listings render with pricing but return 402 at the install boundary until the Stripe charge/payout follow-ups land. Catalog seeds from the ADR-019 fixtures; installs live in process memory pending the deferred gateway db.ts store.
- feat(runner): concurrency-lease dual-account binding (ADR-011 slice 6) — `runner_lease_heartbeat` now validates the caller's current Claude account/profile against the account the lease slot was acquired with; a mismatch (`CLAUDE_CONFIG_DIR` resolution drift) releases the slot instead of extending it, so the fleet reclaims it rather than trust a stale account binding.
- feat(dashboard): replace connect 'coming soon' placeholder on /showcase with real content
- feat(dashboard): replace agentFlow 'coming soon' placeholder on /showcase with real content
- feat(fleet): wire ADR-015 §3 — FleetRun for the /projects fan-out composer
- feat(dashboard): surface task-defer starvation on /work Up Next tab
- feat(brain): implement B-4's $MYAI_RERANK_CMD hook backend
- feat(observability): promote pricing-staleness warning to SCHEDULE banner
- feat(soc2): continuous evidence store for Type II observation window (ADR-013 §5 follow-up)
- feat(billing): daily usage-metering reconcile sweep (ADR-014 follow-up)
- feat(runner): runner-lease runs log + dashboard view (ADR-011 slice 7)
- feat(marketplace): Stripe Connect payout wiring for revenue-share enforcement (ADR-019 follow-up #4)
- feat(dashboard): surface work-type routing decision on task views
- feat(dashboard): surface agentic-fallback per-provider pass-rate on PoolCapacityPanel
- feat(myai-init): default greenfield scaffolds to bypassPermissions
- feat(runner): wire all-pools-capped exhaustion into agentic_fallback demotion lane
- feat(hooks): surface backlog-well-low warning on the SCHEDULE banner
- feat(monitoring): alert on N consecutive route_task_model exhaustion defers
- feat(monitoring): wire pool-capacity drift detection into the alert pipeline
- feat(dashboard): Retrieval strategy card surfacing the retrieval_bandit's favored arm
- feat(observability): lane filter chip + fallback-ratio stat for execution-lane stamp
- feat(budgets): add one-click apply for adaptive budget-cap suggestions
- feat(repos): tag headless new-app self-registration with its own provenance
- feat(observability): surface agentic-fallback day-ledger on dashboard + session close
- feat(dashboard): add gift-codes admin tab (mint/list/revoke)
- feat(agentic-fallback): opt-in queue-depth overflow trigger (ADR follow-up)
- feat(agentic-fallback): per-provider quality ledger + rolling pass-rate
- feat(agentic-fallback): pre-run pricing-staleness check for DeepSeek/Kimi $/token table
- feat(router): wire the 13-work-type routing table from MULTI_PROVIDER_ORCHESTRATION.md §3
- feat(cli): wire `myai new-app <idea>` to agentFlow's headless pipeline
- feat(gateway): pool-capacity ground-truth drift self-check
- feat(brain): ADR-023 Slice P2/P3 — onboarding upsell moment + cross-machine-sync KPI
- feat(doctor): warn when the runner-backlog well runs low
- feat(alerts): proactive alert on the API-credit RESERVE hard cap
- feat(brain): wire retrieval_bandit's recommended config into live B-3/B-4 loop
- feat(ops): proactive Docker VM disk-pressure guard before mongo WT_PANIC
- feat(dashboard): hosted-brain provisioning UI (ADR-023 Slice P1a)
- feat(revenue): nightly MRR-snapshot job + real historical NRR cohorts
- feat(security): admin surface for per-org MCP tool visibility override
- feat(dashboard): surface adaptive budget-cap suggestions (Phase 5b §8 follow-up)
- feat(ops): push alert for the mongo-mirror schedule check
- feat(governance): audit-log PATCH /api/hooks toggles
- feat(runner): stamp execution lane (claude|agentic-fallback) on task docs
- feat(brain): thread ADR-020 topic/tier into B-8 bundle ordering
- feat(dashboard): Fleet Overview v0 observability fields on /projects
- feat(rbac): persist shadow-mode denials + surface a soak panel (ADR-013 §6)
- feat(ci): guard MCP tool surface against silent regression (Mythos Track 3)
- feat(router): stamp {routedProfile,routedModel,routedComplexity} on tasks for dashboard audit trail
- feat(monitoring): alert on repeated Atlas index recreate-on-wrong-type self-heal
- feat(monitoring): alert on agentic-fallback lane's own USD day-ledger cap
- feat(docs): capability-counts drift guard — derive shipped truth, block stale releases
- feat(ci): auditable JSONL ledger for local-ci.sh posted commit statuses
- feat(llm): OpenRouter backend for the Kimi tier — free K2 lane without a paid Moonshot key
- feat(ci): tracked-file hygiene gate — machine-local ledgers can never enter the index
- feat(notifications): content-hash dedup + per-channel storm collapse in delivery path
- feat(dashboard): add loading + error boundaries to control-plane routes
- feat(llm): wire Gemini API as a Class-B gateway provider
- feat(repos): seed repocards-only repos into the tenant roster (ADR-021 Phase 2 tail)
- feat(brain): brain_lookup v2 — embedding-scored branch selection
- feat(brain): ADR-020 one-time topic backfill pass + untagged-atom drift report
- feat(ops): myai sync schedule — installable timer for mongo_sync.sh + staleness alert (ADR-022)
- feat(brain): git-over-HTTP transport route for the hosted brain remote (ADR-017 deferred slice)
- feat(brain): explicit topic on every bash/runner brain_commit caller (ADR-020 rollout tail)
- feat(security): enforce RBAC capabilities on the MCP tool surface
- feat(cli): myai setup — global first-run brain wizard
- feat(memory): feed brain session atoms into the RAG vector corpus
- feat(budget): add BudgetUsage daily/weekly rollup model for analytics
- feat(runner): anti-destructive guard for local-tier (qwen) commits
- feat(runner): capability×cost×availability model/account router
- feat(brain): B-2 boot manifest in the boot path + B-8 prompt-cache-aware bundle ordering
- feat(runner): $155 personal API credit as capped metered-fallback RESERVE pool
- feat(dashboard): hook enable/disable toggle from the UI — settings.json-backed
- feat(billing): downloadable branded invoice PDF — SDK-free Stripe fetch + built-in PDF writer
- feat(monitoring): pool-capacity threshold alert — push when a subscription pool's weekly budget runs low
- feat(billing): wire the usage meter into a real Stripe overage push — premium stamping + fleet period-end sweep
- feat(runner): non-Claude agentic fallback lane — DeepSeek/Kimi real edit→test→commit→push for Claude session-cap windows
- feat(qa): external-repo fresh-install init E2E — 3 real stacks in a clean container
- feat(ops): schedule the Atlas→local mongo mirror (launchd/cron) + doctor last-run check
- feat(gateway): read-side local-first DB failover — MYAI_DB_FAILOVER=local
- feat(runner): capacity-aware Fable auto-routing + all-3-models standard
- feat(runner): Fable is mainstream — default worker model + pacing-ledger exemption
- feat(gateway): Docker MCP Toolkit catalog packaging for myAI (Phase 7)
- feat(budget): adaptive budget-cap suggestions from historical spend (Phase 5b §8)
- feat(brain): ADR-020 topic-indexed GOLD/SILVER/BRONZE hierarchy + brain_lookup
- feat(hooks): session-start brain status sign (orange 🧠)

### Fixed
- fix(budgets): wire BudgetCapOverride into gateway enforcement path
- fix(gateway): inventory brain_bandit_stats in TOOL_CAPS + contracts; pin budget tests to mid-month
- fix(selfheal): escalate gateway image-staleness warning across consecutive sessions
- fix(brain): close free-tier rotate loophole in hosted-brain plan gate
- fix(tests): resolve the 6 untracked pre-existing vitest failures
- fix(sdk): regenerate TS/Python SDKs for hooks-toggle + tenant MCP-tools endpoints
- fix: 2 test-gate failures from the overnight runner batch
- fix(runner): route_task_model exhaustion branch — defer instead of stall/misroute
- fix(tasks): guard against unauthorized bulk pending→blocked transitions
- fix(monitoring): broaden Atlas index health alert to all non-ok self-heal outcomes
- fix(runner): apply per-task worktree isolation to the default tenant too
- fix(rbac): gate webhook mutations + memory/vector import routes
- fix(release): npm-auth preflight + post-publish verification in publish_release.sh
- fix(ollama): write-time guard on local-tier tool_write_file + finish 4ece268 repair
- fix(billing): dedup Stripe webhook deliveries + out-of-order guard
- fix(git): restore .gitignore from main (qwen 4ece268 gutted 88 rules)
- fix(memory): provision the Atlas $vectorSearch index + boot-time self-heal
- fix(init): stage init artifacts individually — missing .mcp.json no longer aborts the greenfield init commit
- fix(runner): stale-worktree sweep + working-watchdog honor per-tenant maxMinutes
- fix(memory): repair RAG vector retrieval returning empty for all queries

### Security
- security(mcp): per-org tool visibility — hide operator-only tools from tenants
- fix(security): B-9 obfuscation salt — no shared fixed-default, mint+persist per-install salt
- fix(security): remove stray unsanitized wt_sanitize redefinition in cli_task_runner.sh fallback
- fix(security): eliminate the well-known default GATEWAY_LOCAL_TOKEN
- fix(security): wt_sanitize permits '.' and '/' — tenant-id path traversal in worktree paths

### Changed
- rollout(agentic-overflow): activation checklist + before/after canary comparison
- rollout(inline-exec): wire the missing activation cron for ADR-018 inline lane
- decide(B-9): keep BRAIN_OBFUSCATE_REMOTE default off; document recall risk + salt gap
- decide(ADR-020): keep BRAIN_LOOKUP_EMBED default off; fix silent hash-fallback gap
- chore(billing): wire the monthly overage-sweep endpoint to an actual scheduled trigger
- chore(brain): bundle tiktoken into the gateway image for exact brain_token_eval.py counts
- build(release): make npm publish + public mirror sync one atomic routine
- perf(runner): consolidate pick/resolve field extraction into one python3 parse

### Tests
- test(ops): regression-lock Docker VM disk snapshot as cwd/worktree-invariant
- test(inline-exec): lock in OFF-path regression for ADR-018 default
- test(brain): exercise compactManifest's budget-pressure drop through a real tight-budget boot
- test(mcp): drift smoke test for the Docker MCP catalog file (Phase 7)
- test(billing): strengthen invoice PDF writer coverage
- test(runner): static guard against duplicate fallback-stub definitions in cli_task_runner.sh
- test(eval): enforce recall-eval baseline in the merge gate
- test(perf): token-budget regression guard for context_boot + brain_delta boot payloads
- test(hooks): hermetic suites for the safety-critical hooks with zero coverage
- test(memory): regression tests for vector-store Atlas-fallthrough + select('+embedding') fix
- test(dashboard): vitest harness for /api route handlers — auth, billing, notifications-push
- test(runtime): enforce coverage thresholds + wire CI/local-ci gate

### Documentation
- docs(architecture): spec Phase-3 physical per-tenant DB isolation (ADR-010 §1.5 deferred item)
- docs(plan): reconcile §5 L1 auto-failover status with §6 roadmap
- docs(marketplace): spec artifact hosting/CDN for listing versions (ADR-019 deferred item)
- docs(marketplace): spec third-party developer SDK contract (ADR-019 Phase-4 remaining item)
- docs(plan): mark Connect fix-engine MVP + validate/learn as shipped
- docs(security): spec sandboxed execution model for marketplace packages (ADR-027)
- docs(runbook): full alert-triage procedures for disk-pressure guard + pool-capacity drift
- docs(architecture): ADR-026 — connect gateway-identity additional login path (design)
- docs(architecture): ADR-025 — agentFlow/Connect Hub gateway-identity middleware (design)
- docs(plan): ADR-015 phase-3 spec — fan-out batch observability (corrects stale premise)
- docs(plan): usage-metering (S2) spec — corrects stale GAP_BACKLOG #16 premise
- docs(plan): refresh GRAND_PRODUCT_ROADMAP.md — mark Phase 1 MVP as SHIPPED
- docs(adr): renumber data-residency ADR-023 -> ADR-024 to resolve duplicate ADR number
- docs(plan): flag GAP_BACKLOG_SCHEDULE #15 as done
- docs(env): reconstruct .env.example lost in the local-tier incident
- docs: operator runbook for the non-Claude agentic fallback lane
- docs(product): multi-repo orchestration UI v0 feature spec
- docs: operator incident runbook for recurring gateway/runner failure modes
- docs(runner): verify P1a — Fable routes + RAM-cap kills already fixed

## [0.6.4] — 2026-07-24

### Fixed
- fix(links): repoint every packaged file that still linked to the **private** `knofler/ai_management` repo → the public `knofler/myai` mirror. These URLs 404'd for anyone installing from npm. Covers the README "Maintenance & contributing" push URL, `SECURITY.md` advisory link, `CHANGELOG.md` compare links, `documentation/LOCAL_DEV_QUICKSTART.md` clone URL, `server.json` (`url`/`websiteUrl`), the generated docs footer (`scripts/build_docs.mjs`), and the dashboard legal/security/welcome UI + demo install URL. The live `knofler.github.io/ai_management/` docs-site links (HTTP 200) are intentionally kept.

## [0.6.3] — 2026-07-24

### Added
- docs(security): ship root `SECURITY.md` in the npm package (`files[]`) — data-locality guarantee + threat model now travel with the package
- build(mirror): `scripts/publish_public_mirror.sh` — one-way, scrubbed publish of the curated public file set to the `knofler/myai` showcase repo (never exposes the private working repo's history/state/logs/brain)

### Changed
- fix(meta): repoint `homepage`/`repository`/`bugs` to the public `knofler/myai` mirror (the old GitHub Pages / private-repo links were dead)
- chore(privacy): genericize machine hostnames + Atlas cluster identifiers in shipped source/docs (`MULTI_MACHINE_WORKFLOW.md`, `runtime/src/**`, `docker-compose.yml`)

## [0.6.2] — 2026-07-24

### Added
- feat(dashboard): in-UI agent/skill source editor with diff preview + commit-on-save
- feat(runner): queue_topup --report — PLANNER drift report vs consumed backlog
- feat(budget): provider invoice reconciliation job (Phase 5b follow-up)
- feat(compliance): data-retention purge for task/plan/audit collections
- feat(proof): public "continuity savings" share card — GTM proof artifact
- feat(dashboard): idle-session timeout with warning modal + auto-logout
- feat(analytics): self-serve conversion funnel — signup → first task shipped → retained
- feat(dashboard): Team Activity panel on /fleet — the Team-tier fleet console
- feat(ci): Windows/pwsh compatibility lane for the top-3 framework scripts
- feat(apps): show test-vs-main commits-ahead on App Directory cards
- feat(runner): token-overlap near-duplicate detector for runner_backlog.jsonl
- feat(gateway): env-configurable per-tenant rate/quota limits (config default + per-tier override)
- feat(docs): in-page TOC + client-side search for the public docs site
- feat(gateway): expose gift-code mint/preview/redeem/list/revoke over REST
- feat(dashboard): public developer portal — API-key issuance, curl quickstarts, rate limits
- feat(notifications): branded transactional-email template system
- feat(gateway): data-residency / region pinning (ADR-024)
- feat(brain): composite health-score index (freshness, coverage, contradictions, recall)
- feat(cli): myai login / whoami — CLI session identity against a hosted gateway
- feat(gateway): task age-based auto-escalation — pending priority aging curve
- feat(runner): predictive pre-claim cost estimate + defer-expensive gate
- feat(gateway): per-tenant billing-anchor quota-reset sweep
- feat(gateway): live task-output relay — stream runner log over SSE
- feat(runner): fleet kill-switch + scheduled maintenance window
- feat(lifecycle): activation email sequence + in-app what's new widget
- feat(runner): P1c reserve-floor pacing — time-varying tech/Fable reserve
- feat(routing): add fable + kimi tiers and complexity->model map (P1b)
- Merge pull request #384 from knofler/test
- feat(runner): env-driven budget — personal allowance in .env, generic derivation in conf

### Fixed
- fix(docs): keep provider_maintenance tool enums literal for build_docs VM eval
- fix(monitoring): mark self-serve funnel aggregates tenant-ok (ADR-010 §3.4)
- fix(brain): B-9 follow-up — move obfuscation reverse map out of remote row metadata
- fix(brain): wire the SMART returning-boot token-cap (brief+min(delta,working))
- fix(mcp): validate provider IDs in provider_maintenance_enter/exit
- fix: address 5 Copilot review findings from PR #368
- fix(mcp): rename MCP server key 'ai-framework' -> 'myai' (naming drift, task-887c7fcb)
- Merge pull request #382 from knofler/test
- fix(cli): myai init --help must show help, not run a full init

### Added
- feat(lifecycle): activation email sequence (signup, first task queued, first task shipped) — env-gated on the email provider (SMTP_HOST), fires once per tenant per milestone
- feat(dashboard): in-app "what's new" widget — surfaces recent CHANGELOG.md releases from the nav bar to drive re-engagement

## [0.6.1] — 2026-07-23

### Fixed
- fix(cli): `myai init --help` (and any subcommand `-h`/`--help`) now prints usage and exits instead of falling through to the passthrough script and RUNNING it — `myai init --help` was scaffolding a repo and self-registering it in the fleet roster + seeding a queue task. Only `-h`/`--help` is intercepted; real script flags (`--greenfield`/`--managed`/`--force`) still pass through. (#382)

## [0.6.0] — 2026-07-23

### Added
- feat(cli): myai queue — inspect, cancel, and reprioritize the runner task queue
- feat(security): audit-log anomaly alerting — impossible-travel, mass-export, permission-denial-burst detection
- feat(runner): liveness heartbeat + gateway-backed 'runner down' alerting
- feat(gateway): /healthz + /readyz + idempotent migration runner + real graceful drain
- feat(dashboard): i18n scaffold — next-intl, English catalogue, locale switcher
- feat(release): myai release — one-command semver bump + changelog + clean-room validate + tag
- feat(auth): shared myai_token cookie contract for dashboard/agentFlow/Connect Hub
- feat(dashboard): public /proof GTM page — anonymized platform stats
- feat(myai init): seed initial onboarding task on greenfield init
- feat(observability): structured JSON request logging + correlation ids + /logs dashboard viewer
- feat(gateway): inbound GitHub webhook receiver — per-tenant secret + delivery dedup + push-based task advance
- feat(security): active session / device management + revoke-all on password reset
- feat(selfhost): add Helm chart for Kubernetes install (gateway+dashboard+mongo)
- feat(gateway): request idempotency keys for tasks_create/plan_set
- feat(cli): fold runner health into `myai status` / `myai logs`
- feat(dashboard): cross-entity search index + API + results page
- feat(observability): OpenTelemetry-style distributed tracing across gateway→runner→agent + minimal trace viewer
- feat(brain): myai brain search CLI — federated semantic search over atoms + sessions
- feat(dashboard): Cmd-K quick actions — dispatch task, switch tenant, jump to repo

### Fixed
- fix(sdk): regenerate TS/Python SDKs for new gateway endpoints
- fix(release): bash 3.2-safe empty-array expansion in myai_release.sh
- fix(launch-kit): resync MCP registry manifest with shipped release + tool count

### Added
- feat(cli): `myai queue` — inspect, cancel, and reprioritize the runner task queue from the terminal (CLI mirror of the dashboard `/work` orchestration view); `queue list` [--repo][--status][--priority][--all][--json], `queue cancel <taskId>` [--reason][--force], `queue reprioritize <taskId> <P0|P1|P2|P3>`

## [0.5.1] — 2026-07-22

### Changed
- perf(brain): section-scope the `/brain` dashboard explorer so each tab computes only its data — atoms/stash-previews/provenance are gated behind the active tab, and atoms sort by the filename UTC-stamp to read the top-N slice instead of every atom file (#377)

### Fixed
- fix(ci): Linux portability for `init_ai` settings-merge + `machine_selfheal` git-auth-fallback shell tests (#376)

## [0.5.0] — 2026-07-22

### Added
- Merge pull request #375 from knofler/test
- feat(kernel): myAI-default orange highlight for myai + ai-framework MCP calls
- feat(audit): tamper-evident hash-chained audit log + verify command
- feat(runner): dead-letter queue + bounded retry-with-backoff for failed tasks
- feat(myai): token-free 'myai boot' + 'myai recall' — deterministic runtime spine
- feat(repos): ADR-021 Phase 2 — self-register via myai init/scan
- feat(dashboard): explain brain-unreachable-on-Vercel + document data source
- feat(mongo): local-first mode — designated-primary sync (ADR-022)
- feat(dashboard): group + collapse the sidebar nav into labelled sections
- feat(gateway): B-1.5 gateway MCP exposure — get_neighbors/shortest_path
- feat(gateway): operator-initiated per-provider maintenance mode
- Merge pull request #372 from knofler/test
- feat(repos): ADR-021 Phase 1 complete — DB-backed repos_list/fleet_overview + boot seed
- feat(repos): ADR-021 Phase 1 foundation — per-tenant repos DB roster + union resolver
- Merge pull request #370 from knofler/test
- feat(runner): per-tenant git-worktree isolation + guardrail config (GRAND_PRODUCT §3.3)
- feat(brain): per-namespace sharing — owner grants read/read-write access to one namespace
- feat(telegram): remote-approve review tasks with inline Approve/Reject buttons
- feat(security): envelope encryption at rest for connector secrets
- feat(billing): /pricing self-serve page — plan carry-through checkout + public route
- feat(dashboard): first-run activation checklist on Mission Control + helpful empty-states
- feat(security): TOTP 2FA — enroll/verify, recovery codes, per-tenant enforce policy
- feat(security): tenant-isolation regression suite + row-scope fuzzing in CI
- feat(myai): module-based .mcp.json propagation + local Mongo mirror (#367)
- feat(myai): module-based .mcp.json propagation + local Mongo mirror

### Fixed
- fix(selfheal): auto-repair hung Docker credsStore after machine switch
- fix(dashboard): mobile card-table labels on /system's remaining tabs
- fix(repos): source only in $setOnInsert — Mongo path-conflict broke the seed
- Merge pull request #371 from knofler/test
- fix(config): restore full fleet roster — managed_repos.txt drives the DASHBOARD, not just propagation
- fix(portability): GNU-first stat ordering fleet-wide — unbreaks runner-worktree + sync-guard tests on Linux CI
- fix(hooks): enforce AI_RULES §19 in no-local-npm guard (Copilot review #368) (#369)
- fix(hooks): enforce AI_RULES §19 in no-local-npm guard (Copilot review #368)
- fix(e2e): scope onboarding-smoke queue assertion to the table
- fix(hooks): exempt global npm installs from no-local-npm guard + codify registry-only CLI install
- Merge pull request #366 from knofler/test
- fix(mcp+runner): register ai-framework MCP server + fix schedule_task health-probe port
- Merge pull request #365 from knofler/test
- fix(mcp): send x-gateway-local-token header from .mcp.json ai-framework entry

### Added
- feat(audit): tamper-evident hash-chained audit log + `GET /api/auth/audit/verify` chain-verification endpoint

## [0.4.0] — 2026-07-22

### Added
- feat(runner): dead-letter queue + bounded retry-with-backoff for failed tasks
- feat(myai): token-free 'myai boot' + 'myai recall' — deterministic runtime spine
- feat(repos): ADR-021 Phase 2 — self-register via myai init/scan
- feat(dashboard): explain brain-unreachable-on-Vercel + document data source
- feat(mongo): local-first mode — designated-primary sync (ADR-022)
- feat(dashboard): group + collapse the sidebar nav into labelled sections
- feat(gateway): B-1.5 gateway MCP exposure — get_neighbors/shortest_path
- feat(gateway): operator-initiated per-provider maintenance mode
- Merge pull request #372 from knofler/test
- feat(repos): ADR-021 Phase 1 complete — DB-backed repos_list/fleet_overview + boot seed
- feat(repos): ADR-021 Phase 1 foundation — per-tenant repos DB roster + union resolver
- Merge pull request #370 from knofler/test
- feat(runner): per-tenant git-worktree isolation + guardrail config (GRAND_PRODUCT §3.3)
- feat(brain): per-namespace sharing — owner grants read/read-write access to one namespace
- feat(telegram): remote-approve review tasks with inline Approve/Reject buttons
- feat(security): envelope encryption at rest for connector secrets
- feat(billing): /pricing self-serve page — plan carry-through checkout + public route
- feat(dashboard): first-run activation checklist on Mission Control + helpful empty-states
- feat(security): TOTP 2FA — enroll/verify, recovery codes, per-tenant enforce policy
- feat(security): tenant-isolation regression suite + row-scope fuzzing in CI
- feat(myai): module-based .mcp.json propagation + local Mongo mirror (#367)
- feat(myai): module-based .mcp.json propagation + local Mongo mirror

### Fixed
- fix(selfheal): auto-repair hung Docker credsStore after machine switch
- fix(dashboard): mobile card-table labels on /system's remaining tabs
- fix(repos): source only in $setOnInsert — Mongo path-conflict broke the seed
- Merge pull request #371 from knofler/test
- fix(config): restore full fleet roster — managed_repos.txt drives the DASHBOARD, not just propagation
- fix(portability): GNU-first stat ordering fleet-wide — unbreaks runner-worktree + sync-guard tests on Linux CI
- fix(hooks): enforce AI_RULES §19 in no-local-npm guard (Copilot review #368) (#369)
- fix(hooks): enforce AI_RULES §19 in no-local-npm guard (Copilot review #368)
- fix(e2e): scope onboarding-smoke queue assertion to the table
- fix(hooks): exempt global npm installs from no-local-npm guard + codify registry-only CLI install
- Merge pull request #366 from knofler/test
- fix(mcp+runner): register ai-framework MCP server + fix schedule_task health-probe port
- Merge pull request #365 from knofler/test
- fix(mcp): send x-gateway-local-token header from .mcp.json ai-framework entry

## [0.3.2] — 2026-07-22

### Changed
- **`05-no-local-npm` hook now allows the sanctioned global install AND enforces §19.**
  The host-npm guard blocked `npm i -g` unconditionally, obstructing the framework-CLI
  propagation path. It now allows `npm i -g ai-management` (bare registry) + cleanup
  uninstalls, **blocks** the §19-forbidden global-install forms (tarball `.tgz`, the scoped
  `@knofler/ai-management`, `npm link`), and still blocks project-local `npm install`
  (Docker mandate intact). Regression test: `scripts/tests/test_no_local_npm_guard.sh`
  (11 cases).

### Added
- **AI_RULES §19 — registry-only `npm i -g ai-management`, no exception.** Codifies that
  every machine installs the CLI from the public registry (bare name), never a local tarball
  or the scoped `@knofler/ai-management`, then manages everything through the brain + `myai`
  tool. Prompted by a Mac found running a `0.2.0` tarball install.

## [0.3.1] — 2026-07-21

### Changed
- **Renamed the npm package `@knofler/ai-management` → `ai-management`** (unscoped). No functional change — the CLI is still `myai` and the module resolver is location-based, so kernel repos keep resolving the framework unchanged. The old scoped name is deprecated/unpublished.

## [0.3.0] — 2026-07-21

### Added
- feat(brain): wire get_pr_impact/triage_prs to calls+tests_of edges (B-1.6 follow-up)
- feat(brain): B-1.5 typed code-edge graph — get_neighbors/shortest_path traversal
- feat(project-mgmt): canonical fleet-wide user-owed blockers tracker
- feat(runner): triage the blocked-task pile — misfiled/user-owed/transient
- feat(runner): per-repo runner-log staleness alert
- feat(gateway): content-level config-drift detector beyond health_check.sh
- feat(dashboard): surface schedule_priority.txt + schedule_ignore.txt on /schedule
- feat(runner): auto-write structured postmortem note on YOLO 3-strikes stop
- feat(security): gateway local-token + tenant API-key self-rotation with dual-valid grace window
- feat(docs): TRY_MYAI.md CI drift-check against bin/myai.cjs CLI table
- feat(cli): npm global-install permission preflight — detect root-owned prefix, fall back to ~/.local
- feat(cli): myai init --zero-prompt flag (+ MYAI_ZERO_PROMPT env default)
- feat(security): standing paid bug-bounty program spec — scope, payout tiers, safe harbor, triage workflow
- feat(dashboard): light/dark theme system — system-preference detection + per-user toggle
- feat(brain): hourly brain_sync_verify canary + notification-engine alert
- Merge pull request #363 from knofler/test
- feat(auth): self-serve account auto-unlock via email after lockout
- feat(runner): rebalance credit pacing — token-governed, higher caps, floor 24
- Merge pull request #362 from knofler/test
- feat(llm): fail over on retryable HTTP status (429/5xx/529/408), not just socket errors
- Merge pull request #361 from knofler/test
- feat(llm): wire Kimi/Moonshot into router failover + multi-provider orchestration plan
- feat(finops): tenant-facing LLM spend alert — 80%/100% of plan-included spend
- feat(brain): brain_token_eval.py — measure cold-start token savings (BRAIN_BUILD_PLAN §0)
- Merge pull request #359 from knofler/test
- feat(brain): Leiden-style community summaries over the entity graph (B-6)
- feat(brain): B-3/B-4/B-7/B-9 deterministic cores — activate the B-1 index
- feat(brain): B-7.1 local-qwen distillation spike — real-trace harvester + offline-replay eval harness before any LoRA trust
- feat(analytics): per-tenant year-in-review usage recap export
- feat(billing): gift/redeemable subscription-code system (GROWTH)
- feat(billing): SLA uptime service-credit automation (enterprise contracts)
- feat(brain): graph-driven PR blast-radius — get_pr_impact + triage_prs MCP tools (B-1.6)
- feat(gateway): self-serve account deletion — GDPR/CCPA right-to-erasure flow
- feat(auth): magic-link passwordless email login for the dashboard
- feat(gateway): audit connector config changes with before/after diff
- feat(gateway): bulk tenant provisioning via CSV/JSON import
- feat(gateway): plan-tier entitlement enforcement — hard-cap repos/seats/off-hours/generation credits
- feat(billing): Stripe Tax — automatic sales-tax/VAT/GST at checkout
- feat(monitoring): queue-wait-time SLO + P0/P1 starvation alert
- feat(cli): myai runner — install/start/stop/status/logs the off-hours runner
- feat(analytics): NRR cohort report — expansion vs contraction vs churn per signup-month cohort
- feat(brain): session-atom quality lint before brain_commit — non-blocking
- feat(brain): federated cross-repo-brain search — unified atom/session recall
- feat(runner): per-task artifact capture — diff/build-log/test-report downloads
- feat(runner): job-log retention + rotation (age gzip + size cap)
- feat(brain): B-5 idle consolidation "dreaming" job — blue-green, never overwrites raw atoms
- feat(runner): priority preemption — pause in-flight P2/P3 for arriving P0/P1, resume after
- feat(connectors): OAuth token auto-refresh worker for tenant connectors
- feat(brain): B-2 control-plane boot manifest — brain_manifest MCP tool
- feat(brain): B-1 repo-local SQLite symbol/atom index
- feat(gateway): prompt-cache-aware system prompt ordering (BRAIN B-8)
- feat(runner): trivial→local tier + brain/memory build plan synthesis
- feat(runner): autonomous credit pacing — daily spread + weekly reserve caps
- feat(runner): failure-gated Opus escalation with hard daily cap (cost policy)
- feat(keywords): auto-check + enable remote control (current repo) on agent mode / -min
- feat(runner): cost policy — Sonnet default + hard museum-org ban
- feat(runner): fleet-wide pause gate (config/runner_pause_until) + fix(gateway): brain repo mount
- Merge pull request #350 from knofler/test
- feat(state): handoff auto-trim in rotate_state.sh (TOKEN-OPT 1)
- feat(sdk): typed TS + Python client libraries generated from gateway OpenAPI
- feat(marketplace): ADR-019 + data model + revenue-share spec + lifecycle model layer
- feat(runner): per-task RAM/CPU cap + wall-clock auto-kill for runaway tasks
- feat(routing): budget-aware provider failover chain
- feat(observability): per-route SLO error-rate + p95-latency alerting to Telegram
- feat(rag): recall-quality eval harness for recall_session — precision@k/MRR + threshold tuning + regression baseline
- feat(brain): myai brain gc — compact the store (atom dedup + orphan/stash prune + repack) with --dry-run
- feat(cli): myai doctor --fix — idempotent auto-remediation of safe findings
- feat(analytics): operator revenue dashboard — MRR/ARR/NRR/logo-churn/blended-LTV
- feat(billing): annual plans + promo/coupon codes + proration on tier change
- feat(gateway): scoped per-tenant API keys — create/scope/rotate/revoke + last-used, grace-overlap rotation (ADR-010 §3.6)
- feat(billing): dunning + failed-payment recovery (past_due banner + retry-cadence email + auto-downgrade)
- feat(gateway): outbound webhooks — HMAC-signed tenant endpoints on task/plan/runner lifecycle events
- feat(gateway): per-tenant rate-limiting + monthly request-quota enforcement (429 + Retry-After)
- feat(team-brain): activity feed + per-member contribution rollup (ADR-013)
- feat(dashboard): hosted-brain quota bar + soft-limit upgrade prompts (ADR-017)
- feat(soc2): audit-log completeness + access review + evidence export (ADR-013 §5)
- feat(selfhost): one-command docker-compose on-prem bundle + operator docs
- feat(multi-org): repo→org→connector allow-list machinery + tests (MULTI_ORG_AUTH ph3 non-user part)
- feat(gateway): in-gateway inline execution path for lightweight tasks (ADR-018, MYAI_GATEWAY ph6)
- feat(system): cost-aware routing control-plane — per-tenant model rules + budget caps
- feat(auth): enterprise SSO — SAML/OIDC login path, env-gated per tenant
- feat(rbac): RBAC v2 — per-resource permission matrix + audit-log viewer/export
- feat(dashboard): SWARM UI — topology picker + live lane view (/swarm)
- feat(notifications): email as a third opt-in channel (push/email/in-app)
- feat(brain): B10 — lightweight entity/temporal layer for cross-session recall
- feat(dashboard): make first-run ProductTour SEEN — de-emphasize skip, engage before dismissible
- feat(dashboard): CONTEXT-PORT 3 — /context "Your Context" page (view / download / port / upload)
- feat(billing): usage-based overage invoicing via Stripe metered billing (Team tier)
- feat(demo): killer side-by-side — cheap local model WITH vs WITHOUT your context via myAI
- feat(myai): CONTEXT-PORT 2 — `myai context import-external` (ingest from ChatGPT/Claude/Obsidian/markdown/vectors)
- feat(myai): CONTEXT-PORT 1 — `myai context export|import` full portable bundle
- feat(dashboard): multi-repo orchestration UI — /projects cross-repo board + bulk dispatch/reprioritize (ADR-015)
- feat(multi-org): activate direnv auto-switch + scaffold repo_org_map template
- feat(dashboard): mobile polish pass on /work /apps /system
- feat(brain): make cross-machine continuity VERIFIABLE — close the silent-sync gap (LL 2026-07-06)
- feat(dashboard): token-economics + brain-savings hero on /analytics (TOKEN-OPT 5)
- feat(realtime): emit plan.updated + runner.fired events for fleet lifecycle SSE
- feat(cli): myai upgrade — self-update global pkg + idempotent config/brain schema migrations
- feat(cli): myai backup / restore — snapshot+restore brain + config
- feat(betac plug): one front door — `myai plug` unifies connect-agent + shim
- feat(dashboard): /brain explorer — namespaces, atoms, stashes, provenance
- feat(brain): deterministic merge-conflict resolver for concurrent multi-device mains
- feat(brain B9): TS parity for code↔memory git-notes back-links
- feat(release): automated npm publish + semantic-release-equivalent cadence
- feat(analytics): per-user cold-start savings + viral share card (ADR-014/B7)
- feat(onboarding): interactive continuity product tour + headless demo-GIF capture
- feat(trust): public /privacy + /terms + /security trust pack + LICENSE options
- feat(observability): Sentry error tracking + public /status page + uptime
- feat(team-brain ADR-013 slice 1): shared team namespace + RBAC role gate + per-member attribution
- feat(brain ADR-017): hosted brain remote — managed per-tenant git remote (provision/auth/quota)
- feat(analytics): activation funnel + privacy-respecting product analytics
- feat(billing M5): self-serve multi-tier Stripe checkout + tier gating + customer portal
- feat(runner): never-empty queue — auto top-up from a self-regenerating backlog well
- feat(welcome): conversion marketing site — how-it-works + honest comparison strip
- feat(pwa): push-enable onboarding card on /notifications + iOS install hint on /welcome
- feat(betac ADR-016 phase 1): extract context read path behind a service seam
- feat(work ADR-015 S1): repo-scoped work board — filter chips + per-repo queue counts
- feat(usage-metering ADR-014 S2 slice2): rollup aggregation + REST + /system Usage tab
- feat(usage-metering ADR-014 S2 slice1): product-meter write path
- feat(rbac ADR-013 slice 3): member-role management UI + change control
- feat(rbac ADR-013 slice 2): REST route enforcement matrix + contract tests
- feat(rbac ADR-013 slice 1): role model + CtxRole matrix + enforcement helpers
- feat(myai-init S-INIT-6): docs + guardrails + health_check kernel-only awareness
- feat(myai-init S-INIT-5): framework-as-module runtime resolver (myai root)
- feat(myai-init S-INIT-4): register repo as brain namespace on init (idempotent, collision-safe)
- feat(ci-thrift §17): hook-level Actions-credit protection — gate all check+review workflows, PR-guard, Copilot code-PR-only, non-Next Vercel all-false
- feat(hook): block-push-main allows docs-safe direct-to-main + §17 correction
- feat(myai-init S-INIT-3): auto-brain first-run + ~/.myai/config remote persist + auto-clone
- feat(myai-init S-INIT-2): greenfield mode — kernel + gitignored .myai-local, no AI/ scaffold
- feat(myai-init S-INIT-1): end-user kernel CLAUDE.md + .myai-local schema
- feat(autosave §15): mechanical checkpoint-as-you-go enforcement hooks
- feat(ci-thrift v2): gate ci.yml paths-gate injection behind --ci-gate (opt-in)
- feat(ci-thrift v2): AI/docs-only changes build-free at all three gates
- feat(runner): per-model credit cooldown + chain rotation on 'out of usage credits'
- feat(rules): AI_RULES §15 checkpoint-as-you-go — the handoff is always current, never end-loaded
- feat(brain): remote auto-sync — push-on-merge, pull-on-boot, clone-on-init
- feat(ci-thrift): AI/docs-only changes never rebuild the stack — paths-aware Vercel gate + pre-push skip
- feat(runner): Windows support — WSL2 doc (recommended) + experimental schtasks installer
- feat(distribution): MCP registry manifest + Smithery/Glama metadata + awesome-list PR drafts
- feat(cli): myai doctor --json — structured {checks,ok} output for CI/scripts
- feat(betac): blank-agent shim — the wrap-it tier for non-MCP agents (betaC v0 cross-agent demo)
- feat(multi-org): per-org MCP connector filtering in sync_mcp_to_org.sh (MULTI_ORG phase 3)
- feat(gateway): in-gateway agent runtime — execute/spawn/pipeline (MYAI_GATEWAY phase 6)
- feat(runner): fleet-wide N-slot runner lease — true 2-Mac concurrency cap (ADR-011 slice 3)
- feat(notifications): VAPID web push + per-tenant preferences (phases 6+7)
- feat(runner): limit-cooldown parses the actual reset time — no more blunt 45m idle
- feat(remote): 'start --last-start' reopens exactly the last-started set + hermetic remote_fleet test suite
- feat(brain): B8 — 'myai brain' productized: full git-verb CLI + TRY_BRAIN.md + clean-room gate
- feat(demo): hosted read-only demo mode for the dashboard — GO_LIVE P2 item 14
- feat(examples): model-agnostic boot shims — Gemini CLI, opencode, raw Ollama
- feat(budgets): per-member (userId) budget scoping for Team tenants
- feat(team): password reset via email — second M2 gap close
- feat(team): tenant invite + join-existing-tenant flow — M2 gap close
- feat(dashboard): first-run empty-state quickstart cards on Mission Control
- feat(brain): B7 cold-start token meter — today-vs-brain comparison on /analytics
- feat(brain): B6 offline detect — Ollama auto-connect, degraded-read path, doctor probes
- feat(brain): B5 code↔memory provenance — SHA stamps, git notes back-links, brain_blame
- feat(dashboard): /welcome continuity refresh — sleep/wake narrative, install one-liner, GIF slot, Solo/Pro/Team pricing, privacy strip
- feat(dashboard): button-feel nav + registry — animated press states everywhere
- feat(dashboard): vermilion myAI icon (SF Rounded) + edge cache headers for static assets
- feat(dashboard): orange myAI home-screen icon + iOS standalone safe-area fix
- feat(docs): static docs site — quickstart/concepts + generated CLI/MCP references on GitHub Pages
- feat(security): SECURITY.md data-locality guarantee + export-path secret scan
- feat(continuity): cold-start tokens-saved meter — dashboard analytics + myai status
- feat(memory): myai memory export|import — portable markdown+JSON memory bundle
- feat(brain): B4 brain keywords fleet-wide + -min boots via brain_delta + wrap-up brain_merge + kernel CLAUDE.md plan
- feat(brain): B3 compile-at-write distiller + context_boot from brain + brain_delta diff-since-SHA
- feat(brain): B2 gateway brain tools — status/commit/stash/pop/branch/checkout/merge/log/diff/revert
- feat(remote): 'stop --last-start' undo + museum remote-readiness selfheal
- feat(brain): B1 brain store core + 'myai brain init' — git-versioned agent memory
- Merge pull request #299 from knofler/test
- Merge pull request #298 from knofler/test
- feat(remote): wrap-up-aware duplicate guard + TREE column in remote fleet
- feat(qa): clean-Linux cold-start E2E harness + python-free myai status
- Merge pull request #296 from knofler/test
- feat(remote): `remote status|start|stop` keyword works in EVERY repo
- Merge pull request #295 from knofler/test
- feat(fleet): `remote fleet` phone-drivable museum sessions + `agent mode -min` quick start
- feat(continuity): CONTINUITY_DEMO.md — scripted 2-min demo + context_boot operator brief
- Merge pull request #294 from knofler/test
- feat(cli): `myai connect-agent` — plug ANY agent into the continuity layer
- feat(cli): `myai demo` — seed realistic sample data so the first-run dashboard is alive
- Merge pull request #293 from knofler/test
- feat(runner): Linux installer — systemd user timer + cron fallback with platform auto-detect
- Merge pull request #290 from knofler/test
- feat(plan): go-live product plan + runner schedule — continuity positioning, monetization, launch
- feat(myai): self-healing health gate in myai up — bounded retry, log capture, rollback
- feat(cli): myai status + myai logs — post-up observability
- Merge pull request #282 from knofler/test
- feat(dashboard): notification UI — bell, toast stack, history page
- feat(mcp): betaC context_boot tool — callable boot bundle + lazy RAG
- feat(mcp): betaC auto-boot — force-load tight context bundle on MCP connect
- feat(runner): atomic tasks_claim MCP tool + claimTask (ADR-011 slice 2)
- feat(blueprint): bundle templates/blueprint scaffold + wire init_blueprint local mode + docs
- feat(notifications): real-time event bus + SSE stream endpoint
- feat(release): cut v0.1.0 — changelog, distribution docs, demo, publish runbook
- feat(onboarding): myai init guided wizard + independent welcome flow + 5-min README quickstart
- feat(gateway): Connect Hub S1 ticket→task bridge + myai connect install
- feat(gateway): myai new-app — idea→app via agentFlow + directory registration
- feat(packaging): myai doctor preflight + scanner hardening + bundled-vs-fetched decision
- feat(cli): myai scan <dir> — spider git repos, register + seed RAG awareness
- feat(release): clean-room packaging gate — files-allowlist + publish leak-scanner (P0)
- feat(cli): myai up / myai down — self-contained stack on localhost
- feat(cli): myai init <path> — scaffold framework + portable stack into any repo
- feat(cli): myai npm package skeleton + bin entry
- Merge pull request #276 from knofler/test
- feat(color): auto-remap iTerm ANSI green→orange every session (hook 21)
- Merge pull request #274 from knofler/test
- feat(reconcile): recognize state/docs framework commits as chore (not feature)
- Merge pull request #272 from knofler/test
- feat(reconcile): treat chore/state-sync-only divergence as shipped
- feat(dashboard): runner-health panel with zero-work stall flag
- Merge pull request #265 from knofler/test
- feat(tasks): in-place repo re-pointing + unblock content_api build queue
- Merge pull request #263 from knofler/test
- feat(reconcile): per-task ancestor check using stamped pushed-SHAs
- feat(runner): stamp pushed commit SHA(s) onto task on review-flip
- Merge pull request #259 from knofler/test
- feat: self-healing task board — reconcile phantom review→done
- Merge pull request #255 from knofler/test
- Merge pull request #253 from knofler/test
- feat(policy): node_modules in .dockerignore as first provisioning condition (AI_RULES §12a)
- feat(policy): node_modules/build artifacts never sync to Dropbox (AI_RULES §12)
- Merge pull request #252 from knofler/test
- feat(connectors): bundled MCP connector set + dashboard connector manager
- feat(dashboard): guided first-run onboarding wizard at /welcome/start
- feat(betac): 'betaC up' single-command fused-stack launcher
- feat(dashboard): add error boundaries, loading skeletons, a11y + gateway logging
- feat(M2): complete tenant scoping across all dashboard pages
- feat(gateway): session export/import + cross-session recall (betaC context-sharing)
- feat(gateway): first-class handoff store + handoff_write/read MCP+REST (betaC)
- Merge pull request #250 from knofler/test
- feat(keyword): add `jam` — collaborative ideation mode (brainstorm before building)
- feat(schedule): focus-tier so the named focus apps aren't buried at P3
- Merge pull request #246 from knofler/test
- feat(vercel): enforce build-only-main fleet-wide — no repo can go rogue
- Merge pull request #245 from knofler/test
- feat(deploy): batch-ship tracker + deploy-watch memory
- Merge pull request #243 from knofler/test
- feat(auth): hosted login-wall (opt-in, loopback-exempt) + anti-lockout bootstrap admin
- Merge pull request #240 from knofler/test
- feat(dashboard): password login primary, API-key demoted to 'connect a tool' (M2)
- Merge pull request #239 from knofler/test
- feat(auth): graft password/JWT user-login onto API-key tenancy (M2)
- Merge pull request #238 from knofler/test
- feat(dashboard): public landing page + self-serve signup + showcase-as-proof (MVP M6)
- feat(billing): Stripe checkout + Solo-tier subscription gating (MVP M5)
- feat(dashboard): 'New App' flow → agentFlow pipeline + directory registration (MVP M3)
- feat(runner): per-tenant off-hours task pickup + tenant-scoped review flip (MVP M4)
- feat(dashboard): scope /schedule /plan /directory views to active tenant (M2 §7.2 Day 4)
- feat(dashboard): tenant signup/login + tenant context + switcher (MVP M2)
- feat(tenancy): ADR-010 M1 FINISH — §3.4 grep-gate in local-ci + flip enforce=true
- Merge pull request #237 from knofler/test
- feat(schedule): core-product priority + register ai_management MVP plan
- Merge pull request #235 from knofler/test
- feat(schedule): expand no-autonomous-schedule consent list to 5 apps + queuing guards
- feat(self-heal): remind on Macs missing the CLI runner + document per-Mac install
- feat(gateway): ADR-010 Day-3 — scope GatewaySession/BudgetUsage/Notification stores
- Merge pull request #232 from knofler/test
- feat(fleet): add /fleet slash command (skill) for the fleet morning console
- Merge pull request #227 from knofler/test
- feat(tenancy): ADR-010 Day-2 — compile-time tenant isolation (scoped stores)
- Merge pull request #226 from knofler/test
- feat(fleet): agent mode -resume all — fleet morning console (live on /fleet)
- feat(selfheal): auto-heal machine-local config on session start
- feat(runner): 10-min slot-based cadence — up to 5 concurrent, 30-min busy backoff
- feat(gateway): ADR-010 per-tenant auth/enforcement layer (Day-1 steps 4–7)
- Merge pull request #224 from knofler/test
- feat(share+atlas): budget_hook share bundle + MacBook Atlas auto-join
- Merge pull request #223 from knofler/test
- feat(atlas): one-command Atlas cutover (ADR-011 slice 5) + overridable MONGODB_URI
- Merge pull request #222 from knofler/test
- feat(runner): isolated out-of-Dropbox workspace + rebase-before-push (ADR-011 slices 1+4)
- Merge pull request #221 from knofler/test
- feat(statusline): context % as a bold colour-coded usage gauge
- feat(share): portable claude-token-guard hook + drop redundant statusline bypass badge
- feat(dx): forced dark-daltonized theme + unified status line on all sessions
- feat(gateway): ADR-010 data-model foundation — multi-tenant tenantId scoping
- feat(dashboard): rebuild /showcase as myAI capability page + Claude-orange brand
- feat(dashboard): /documentation, /showcase, /analytics pages
- feat(dashboard): mobile-first app-like redesign + installable PWA
- feat(dashboard): blue-green retheme + mobile collapsible nav + gel skin + fix /registry overflow
- feat(dashboard): orange retheme + gel skin + fix /registry skills overflow
- feat(runner): Fable→Opus 4.8 model fallback + productivity assessment
- feat(schedule): ignore-list (exclude repos) + self-improvement track + multi-Mac design
- feat(dashboard): nav collapsed to 6 journey-ordered entries + redirects for all 18 old URLs
- feat(dashboard): 6-destination IA — Mission Control + work/apps/system/registry/memory
- feat(dashboard): shared component system — Badge/Card/Tabs/DataTable + ⌘K palette
- Merge pull request #209 from knofler/test
- feat(schedule): off-hours policy + cross-device schedule plan (ship+wrap, mobile→runner)
- feat(wrap up): schedule plan runs FIRST; add 'wrap up -u' urgent fast-path
- Merge pull request #208 from knofler/test
- feat(schedule): 'schedule plan' keyword + 10-day /plan dashboard + banner/page polish
- feat(dashboard): App Directory — one-point pointer per repo, self-updated on wrap up
- feat(scheduling): standard 'schedule' keyword + schedule_task.sh, propagated fleet-wide
- Merge pull request #207 from knofler/test
- feat(runner): claude-tech profile policy for all scheduled runs + master-repo path fix
- Merge pull request #206 from knofler/test
- feat(keywords): agent mode -resume + mandatory SCHEDULE banner step (profile-independent)
- Merge pull request #205 from knofler/test
- feat(dashboard): searchable + time-sortable Up Next queue; runner PATH fix for launchd
- Merge pull request #204 from knofler/test
- feat(hooks+dashboard): schedule startup banner (17-schedule-status) + Sydney time everywhere
- Merge pull request #203 from knofler/test
- feat(dashboard): /schedule Needs Review section — agent-completed tasks awaiting the human merge gate
- Merge pull request #202 from knofler/test
- feat(scheduler): CLI task runner — headless subscription sessions work the task queue (zero API tokens)
- Merge pull request #200 from knofler/test
- feat(scheduling): Fable free-window router tier + recommendedModel task field + /schedule dashboard
- Merge pull request #195 from knofler/test
- feat: notifications engine, GitHub webhooks, health alerter, Telegram oversight
- feat: boot-time schedule seeding flag + docs, keywords, SHOWCASE, LL
- feat: API-driven platform — REST parity, OpenAPI 3.1, schedule seeding
- feat: Multi-Org Auth Phases 5+6 shipped + Phase 3 scaffold
- feat(multi-org): Phase 2 direnv per-repo auto-switch + secret-scan envrc fix
- feat(token-guard): periodic /usage ground-truth nudge + org-coloured wrap-up banner
- Merge pull request #181 from knofler/test
- feat(multi-org): colour active-org statusline + claude-personal profile
- feat(multi-org): Phase 1 + Phase 4 — side-by-side Claude orgs via CLAUDE_CONFIG_DIR
- feat: mega-build session 3 — router wired, standing agents, production hardening
- feat(guard): real token-burn guard + account rolling-window + auto-checkpoint
- feat: mega-build session 2 — LLM tier router, agent dispatch, Telegram commands, orchestration dashboard
- feat: 2 new MCP tools (30→32) + dashboard health API + test fixes
- feat: dashboard expansion (9→13 pages) + 4 test suites + health_status resilience data
- feat: resilience integration + costs dashboard + Phase B7 rollout + 2 test suites + SHOWCASE update
- feat: production hardening + Phase B6 RAG dashboard + Phase 4a installer + evening sweep + 3 MCP tools
- feat(rag): Phase B5 — RAG_RECALL=1 wires recall_session into agent mode (#168)
- feat(rag): Phase B5 — RAG_RECALL=1 wires recall_session into agent mode
- feat(rag): Phase B4 — backfill_embeddings.sh one-shot RAG corpus backfill (#167)
- feat(rag): Phase B4 — backfill_embeddings.sh one-shot corpus backfill
- Merge pull request #166 from knofler/test
- feat(rag): add recall_session MCP tool — semantic recall over session corpus (Phase B3)
- feat(usage-guard): warn-only by default + raise ceilings (480min/800 actions) (#163)
- feat(usage-guard): warn-only by default + raise ceilings to 480min/800 actions
- feat(gateway): Telegram command center — one-shot /agent + /skill dispatch (Phase 3 Chunk C) (#162)
- feat(gateway): Telegram command center — one-shot /agent + /skill dispatch (Phase 3 Chunk C)
- feat(banners): compact orange session-start + wrap-up banners via session_banner.sh
- feat(mcp): GitHub + Vercel as fleet-wide base MCP servers (#158)
- feat(mcp): add GitHub + Vercel as fleet-wide base MCP servers
- feat(framework): SHOWCASE maintenance in wrap up + scorecard true-up (#157)
- feat(framework): wire SHOWCASE maintenance into wrap up + scorecard true-up
- feat(ci): local-CI status-poster fallback for Actions billing exhaustion (#156)
- feat(ci): local-CI status-poster fallback for Actions billing exhaustion
- Merge pull request #153 from knofler/test
- feat(fork): fork-init kit — templates, init script, clone-ready branch builder
- Merge pull request #150 from knofler/test
- feat(sentry): personal-account DSN setup script + propagate via env file
- feat(policy): zero-prompt fleet policy — bypassPermissions + skip-dialog flags (#147)
- feat(policy): zero-prompt fleet policy — bypassPermissions default + skip-dialog flags
- feat(permissions): broad fleet-wide allow-list — kill the permission-prompt frustration (#146)
- feat(permissions): broad fleet-wide allow-list — close the permission-gate gap across managed repos
- feat(notify): Telegram hooks + UNATTENDED_MODE for hands-off sessions (#143)
- feat(notify): Telegram hooks + UNATTENDED_MODE doc for hands-off sessions
- feat(rag): Phase B1 — archive ingestion + memory_reindex MCP tool (#142)
- feat(rag): Phase B1 — archive ingestion + memory_reindex MCP tool
- feat(state): two-tier rotation (Phase A of RAG) — STATE 41k→4k, HANDOFF 28k→1.5k
- feat(mcp): add Dropbox remote MCP server to base config (#139)
- feat(mcp): add Dropbox remote MCP server to base config (#138)
- feat(mcp): add official Dropbox remote MCP server to base config
- feat(blueprint): fold ai_review lessons + AI/ convention + LL workflow (#136)
- feat(blueprint): fold ai_review AI/LL/ lessons + AI/ convention + LL workflow
- feat(keyword): agent mode -a (auto-mode flag) (#134)
- feat(keyword): agent mode -a (auto-mode flag)
- feat(claude.md): document Powerhouse workspace keywords (#133)
- feat(claude.md): document Powerhouse workspace keywords
- feat(ram-guard): 2 GB per-stack ceiling on every agent-mode kickoff (#129)
- feat(ram-guard): 2 GB per-stack ceiling enforced on every agent-mode kickoff
- feat(blueprint): polished default landing + Tailwind v4 stable (#126)
- feat(blueprint): sed branding.ts so scaffolded projects show their own name
- feat(blueprint): onboarding handshake — fresh scaffold prompts for app idea (#125)
- feat(blueprint): onboarding handshake — fresh scaffold prompts for app idea
- feat(phase-5f): Anthropic Message Batches API for morning_sweep (#122)
- feat(phase-5f): Anthropic Message Batches API for morning_sweep
- feat(blueprint): top-level README + template-mode + propagation polish (#119)
- feat(blueprint): top-level README + template-mode + propagation polish
- feat(blueprint): init_blueprint.sh provisioner + 'init blueprint' keyword + Docker-only fix (#118)
- feat(blueprint): init_blueprint.sh provisioner + 'init blueprint' keyword
- feat(plan): POWERHOUSE BLUEPRINT — org-wide engineering standard + first reference implementation (#117)
- feat(plan): POWERHOUSE BLUEPRINT — org-wide engineering standard + first reference implementation
- feat(dashboard): Phase 5e — /costs page + plan progress meter in wrap up (#115)
- feat(dashboard): Phase 5e — /costs page + plan progress meter in wrap up
- feat(llm): Phase 5d — Anthropic prompt caching (#113)
- feat(llm): Phase 5d — Anthropic prompt caching
- feat(mcp): add Google Stitch AI UI design MCP server (#110)
- feat(mcp): add Google Stitch AI UI design MCP server (#109)
- feat(mcp): add Google Stitch AI UI design MCP server for web projects
- feat(gateway): Phase 5b — opt-in budget guards + tier routing (#108)
- feat(gateway): Phase 5b — opt-in budget guards + tier routing
- feat(channels): real MCP tool-use loop on the channel path (Option C) (#102)
- feat(channels): real MCP tool-use loop on the channel path (Option C)
- feat(llm): Phase 5c — provider auto-fallback chain (#97)
- feat(llm): Phase 5c — provider auto-fallback chain (LLM_MODE_CHAIN)
- feat(llm): Phase 5a — cost estimator + costUsd in provider response (#96)
- feat(llm): Phase 5a — cost estimator + costUsd in provider response
- feat(gateway): bind sibling repos for morning_sweep briefings (#93)
- feat(gateway): bind sibling repos for morning_sweep briefings
- feat(scheduler): Phase 3B — daily morning sweep (#88)
- feat(scheduler): Phase 3 Chunk B — daily morning sweep
- feat(scheduler): Phase 3 Chunk A — autonomous schedule loop (#87)
- feat(scheduler): Phase 3 Chunk A — autonomous schedule loop
- feat(mcp): agents_invoke + skills_invoke tools (Phase 2b) (#86)
- feat(mcp): add agents_invoke + skills_invoke tools (Phase 2b)
- Merge pull request #85 from knofler/test
- feat: add Moonshot/Kimi K2.6 + Ollama LLM provider
- feat: env-overridable Docker memory limits (#83)
- feat: env-overridable memory limits for Docker stack
- feat: Phase 2a — MCP tools expansion (15 tools) (#81)
- feat: Phase 2a — MCP tools expansion (task queue + repo registry + agents/skills)
- Merge pull request #79 from knofler/test
- feat: Phase 1 RAG + MCP — vector memory and MCP server
- Merge pull request #75 from knofler/test
- feat: mandatory API docs — Scalar + OpenAPI MCP for all API projects
- Merge pull request #72 from knofler/test
- feat: Telegram streaming + usage guard whitespace fix
- Merge pull request #67 from knofler/test
- feat: Tailwind + shadcn/ui design system — standard for all repos
- Merge pull request #66 from knofler/test
- feat: add Playwright MCP to base config + master repo mcp.json
- Merge pull request #64 from knofler/test
- feat: Telegram host control — file-based multi-machine switching
- feat: standard MCP servers — Context7, shadcn, Chrome DevTools, Docker (#63)
- feat: add standard MCP servers — Context7, shadcn, Chrome DevTools, Docker
- feat: DeepSeek provider + Telegram fixes
- feat: DeepSeek API provider + simplified Telegram flow
- feat: Gateway Phase 6 — direct Anthropic API (no CLI dependency)
- feat: Gateway Phase 6 — direct Anthropic API integration (no CLI dependency)
- feat: Telegram Phase 1 — instant feedback + response timing
- feat: Telegram Phase 1 — typing indicator, thinking message, response timing
- feat: session usage guard — proactive wrap-up before API limit
- feat: session usage guard — proactive wrap-up before API limit
- Merge pull request #55 from knofler/test
- feat: mandatory WRAPPED UP ASCII banner on every session close
- Merge pull request #54 from knofler/test
- feat: CLI-Mobile agent workflow — self-contained repos + pull-main-first fix
- Merge pull request #53 from knofler/test
- feat: Gateway Phase 5 refinements + Phase 6 LLM provider groundwork
- feat: add codeclot branch strategy for mobile/cloud sessions (#52)
- feat: add codeclot branch strategy for mobile/cloud sessions
- feat: Gateway Phase 5 — Telegram + Discord channel adapters
- Merge pull request #51 from knofler/test
- feat: dashboard healthcheck + managed repos cleanup
- Merge pull request #49 from knofler/test
- feat: YOLO autonomous mode + dashboard bundle optimization
- feat: ConnectHub repo extraction + discovery integration
- feat: ConnectHub autonomous helpdesk product plan + agent mode Connect Hub check
- Merge pull request #48 from knofler/test
- feat: Dashboard Phase 2 — repos health, sessions, SONA analytics
- feat: runtime test suite (75 tests) + fix Docker healthcheck
- Merge pull request #47 from knofler/test
- feat: myAI Dashboard + 6 MongoDB collections + Atlas integration
- Merge pull request #45 from knofler/test
- feat: myAI Gateway Phase 3+4 — TypeScript hooks + SONA vector search
- Merge pull request #43 from knofler/test
- feat: myAI Gateway Runtime — Phase 1+2 (core gateway + Docker)
- Merge pull request #42 from knofler/test
- feat: add post-merge review check to ship it workflow
- Merge pull request #40 from knofler/test
- feat: Phase 9 — Mobile Control (Remote Control + Telegram channels)
- Merge pull request #39 from knofler/test
- Merge pull request #38 from knofler/test
- feat: Codebase Scanner + Generation Pipeline — autonomous idea to deployment
- Merge pull request #33 from knofler/test
- feat: update CLAUDE_TEMPLATE with Docker naming, project identity, dashboard
- Merge pull request #31 from knofler/test
- feat: session traffic-light dashboard + wrap up keyword
- Merge pull request #30 from knofler/test
- feat: sync hooks + settings.json + mcp.json to all managed repos
- Merge pull request #29 from knofler/test
- feat: enforce project identity display + Docker container naming
- Merge pull request #28 from knofler/test
- feat: Phase 5 — MCP server with 15 tools, MongoDB schemas, project generation
- Merge pull request #27 from knofler/test
- feat: Phase 4 swarm coordination + Phase 7 cost-aware routing + fix hooks
- Merge pull request #25 from knofler/test
- feat: SONA neural learning — Phase 3+8 complete
- Merge pull request #24 from knofler/test
- feat: add 23 Claude Code hooks — build, git safety, deployment monitoring, IaC/cloud guards
- Merge pull request #23 from knofler/test
- feat: add external-auditor agent — independent production-grade gate
- feat: agentic lifecycle — scan, tasks, monitoring, integrity
- feat: add agentic lifecycle system — scan, tasks, monitoring, integrity
- feat: expand framework — 53 agents, 124 skills, SONA memory
- feat: expand framework — 53 agents, 124 skills, SONA memory config
- feat: auto-detect VirtioFS + local-cache bind mounts
- feat: auto-detect VirtioFS issues and use local-cache bind mounts
- Merge pull request #16 from knofler/test
- feat: Batch Generation — Anthropic Batch API integration (50% cost savings)
- feat: Real-Time Notifications — event bus, SSE, bell, toasts, history
- feat: Connect Hub module — portable template + init_connect.sh installer
- feat: dark/light theme toggle + Connect Hub docs in README
- feat: add Connect Hub to sidebar navigation
- feat: AI Connect Hub — models, API, frontend pages, AI keywords
- feat: workflow gets its own AI/ folder — ready to become standalone repo
- feat: agent instruction files for workflow app, script handles subdirs
- feat: agent_paths.conf, init [agent] command, all 8 instruction files
- feat: multi-agent instruction files — 8 AI agents supported
- feat: provider badge fix, stage nav bar, complete project button
- feat: credits system, generation modes, content cleaning, and bug fixes
- feat: token usage dashboard, smart model routing, RAG solution design
- feat: replace pdfkit with Puppeteer/Chromium for PDF generation
- feat: add stage descriptions to all pipeline pages
- feat: Phase 5e — Agent Management System, make-prod check-first logic
- feat: Gap Analysis stage — interactive Q&A discovery before BRD generation
- feat: API-driven AI generation — runtime API keys, Settings UI overhaul, full provider support
- feat: Phase 5d — Artifact Viewer with syntax highlighting, file parser for code generation
- feat: add DOCX and XLSX file upload support with zero-dependency text extraction
- feat: Phase 5 — PDF downloads, sticky action bar, file uploads on all stages, full project context awareness
- feat: Phase 4 — Plan/BRD/TRD/Design/Build processors, bridge provider registration, UX fixes
- feat: Phase 3 — Idea Intake + AI Integration, auto-seed on dev boot
- feat: Docker CLI bridge, agent assignment UI, product documentation
- feat: Phase 2.8 — AI provider layer, local agent bridge, settings UI
- feat: add Phase 2.8 — AI provider connectors + local agent bridge
- feat: Phase 2.5 — stage templates, mock outcomes, agent status page
- feat: add 'make prod' keyword — one-command production provisioning
- feat: Vercel + Atlas deployment, artifact system, type fixes
- feat: AgentFlow Phase 2 — project CRUD, pipeline state machine, 183 tests
- feat: AgentFlow Phase 1 complete — 39 files, Docker stack running
- feat: add 'hello' keyword — shows all available keywords as a table
- feat: AgentFlow — founder's brief + detailed implementation plan
- feat: add 'agent mode' keyword — full multi-agent parallel dispatch shortcut
- feat: add quick keywords system — 5 master + 9 project shortcuts
- feat: add old-path migration to update_all.sh
- feat: add multi-agent specialist system with 13 parallel-dispatch agents

### Fixed
- fix(publish): green publish_guard — genericise tarball, exclude operator fleet script
- fix(devops): auto-fallback git origin SSH->HTTPS in machine_selfheal.sh
- fix(devops): close init_ai.sh's settings.json clobber gap (19th incident)
- fix(runner): diagnose + flag RAM-guard tree-kills instead of a bare CAP HIT note
- fix(cli): make greenfield `myai up` runnable on a fresh npm i -g install
- fix(runner): stop headless MCP servers from tree-killing large tasks on RAM
- fix(devops): root-cause + prevent recurring Dropbox conflicted-copy pileup
- fix(runner): gate PLANNER backlog-regen task behind explicit opt-in
- fix(runner): extend reconcile_review_tasks.sh to sweep review+blocked fleet-wide
- fix(ci): local-ci.sh maps non-standard required-check names (Lint/Type-check/Test/Audit)
- fix(gateway): boot-time MongoDB reachability self-check — fail loudly, not silently
- fix(runner): wire HANDOFF/STATE size-guard into SessionStart hook, not just agent-mode/wrap-up
- fix(runner): route local-tier trivial tasks to Ollama's API directly, not `claude -p --model`
- fix(runner): reconcile phantom review tasks BEFORE off-hours/pause/pacing/lease gates
- fix(runner): stage queue top-up ahead of window/pacing gates — never-empty 24/7
- fix(gateway): resolve 9 pre-ship review findings in the runner queue
- fix(runner): portable stat in log-rotate — GNU-first, BSD fallback
- fix(gateway): update frozen MCP tool/route contract to 100 tools
- fix(state): handoff ACTION section was exempt from auto-trim, grew to 60KB+
- Merge pull request #351 from knofler/test
- fix(update_all): propagate scripts/lib/trim_handoff.py to the fleet
- fix(runner): trust-dialog death releases+self-heals instead of poison-blocking (97-task incident)
- fix(runner): throttle planner regen to 1/6h — stop the 20x/morning over-fire (Opus token waste)
- Merge pull request #337 from knofler/test
- fix(ci): resolve Windows pwsh AST parse path (cygpath -w) — kills perpetual red check
- fix(db): cap Atlas connection pools to survive M0 500-conn limit
- fix(color): iTerm ANSI green → orange #FF8700 (operator's locked choice, was brick red)
- fix(clean-room): genericise operator home path in BRAIN_WORKFLOW.md — guard back to GREEN (665 files, 0 leaks)
- fix(runner): recognize 'out of usage credits' as a release-not-block signature
- fix(propagation): ship BRAIN_WORKFLOW.md + BRAIN_OFFLINE.md to all managed repos
- fix(propagation): ship brain CLI + libs to managed repos — myai_brain.sh, lib/brain.sh, lib/secret_patterns.sh
- fix(dashboard): registry mobile UX — full-screen rule sheet, tap feedback, panel animations
- fix(runner): release claim on account-limit death instead of poison-blocking + limit cooldown skips claiming
- fix(gateway): split-brain guard — runner can never compose-up the shared gateway from a ci-workspace
- fix(remote): do_start skips empty target lines — unknown-repo start no longer launches a nameless session or clobbers the last-start record
- fix(remote): anchor rule — 'remote stop' never kills the master-AI doorway session
- fix(clean-room): publish_guard survives npm publish --dry-run + genericise operator refs in MOBILE_CONTROL
- Merge pull request #300 from knofler/test
- fix(remote): 3-state tree detection — clean/residue/DIRTY, no more false mid-work
- fix(runner): pre-trust ci-workspaces in machine_selfheal — trust dialog poison-blocked 13 tasks
- fix(remote): CLI 2.x --remote-control flag + Enterprise org setup notes
- fix(myai): portable python3 resolution in myai_status.sh — ship-pass finding
- Merge pull request #289 from knofler/test
- fix(update_all): deep-merge propagated JSON configs — stop clobbering repo-local settings (18x agentFlow incident)
- Merge pull request #288 from knofler/test
- fix(runner): revive autonomous pipeline — stale-gateway guard + banner auth + Fable-5 chain
- Merge pull request #287 from knofler/test
- fix(myai): portable stack auto-names from folder — never clobbers a live "myai" stack
- Merge pull request #285 from knofler/test
- fix(myai): publish-blockers caught by full install test — init now works end-to-end
- Merge pull request #283 from knofler/test
- fix(packaging): clean-room publish_guard GREEN — genericise operator context + exclude fleet tooling
- Merge pull request #277 from knofler/test
- fix(color): iTerm green slot → brick red #B22222 (operator's pick, was orange)
- Merge pull request #275 from knofler/test
- fix(color): green→orange everywhere — operator can't read green (AI_RULES §13)
- Merge pull request #273 from knofler/test
- fix(gateway): guard .vite-temp mountpoint so a post-purge rebuild can't down the gateway
- Merge pull request #271 from knofler/test
- fix(local-ci): production-faithful build — never verify in the prod container
- fix(scripts): use ${BASH_SOURCE[0]} for self-location so the unit suites pass
- fix(runner): alias content_api/content_app to real git sub-repos
- Merge pull request #260 from knofler/test
- fix(runner): skip+block unresolvable tasks — never starve the queue
- Merge pull request #256 from knofler/test
- fix(local-ci): set -e-safe tenant-scoping call — unblocks shipping in every non-gateway repo
- fix: harden dashboard + gateway — input validation, date guards, pool config
- fix(M2): scope remaining unscoped queries in work page + session search
- fix(update_all): propagate the gateway lib to managed repos
- Merge pull request #247 from knofler/test
- fix(vercel-guard): check origin/test burn layer, not just local working tree
- fix(pipeline): host scripts send GATEWAY_LOCAL_TOKEN — autonomous queue was 401-dead since enforce=true
- Merge pull request #244 from knofler/test
- fix(thrift): gate-vercel creates vercel.json when missing + correct content_api path
- Merge pull request #241 from knofler/test
- fix(auth): make the M2 graft actually work live + harden the auth surface
- fix(local-ci): M1 §3.4 grep-gate was a silent no-op — call after fn def
- fix(runner): set -e death on remote-less repo starved the whole queue
- Merge pull request #230 from knofler/test
- fix(runner): Opus-4.8-first model chain + sleep-guard wake reminder
- Merge pull request #229 from knofler/test
- fix(runner): drop Fable default — Sonnet-first (Fable unavailable 2026-06-16)
- fix(runner): self-heal stale 'working' tasks + fleet heuristic stale-vs-ship
- Merge pull request #220 from knofler/test
- fix(statusline): model name bold/bright again (org + ctx% stay dim)
- Merge pull request #219 from knofler/test
- fix(statusline): 256-colour profile codes — museum=orange, distinct from tech
- Merge pull request #218 from knofler/test
- fix(statusline): consolidate to org-statusline (add repo/dir), drop competing one
- Merge pull request #201 from knofler/test
- fix(dashboard): /fleet + /api-health 500s — schedule field drift surfaced by first seeded schedules
- Merge pull request #199 from knofler/test
- fix(agents): per-agent identity + colored banner — stop Gemini/Codex/Antigravity impersonating Claude
- fix(install): correct Telegram env var + add curl/python3 prereq checks (Phase 4b)
- Merge pull request #193 from knofler/test
- fix(init_ai): install zero-prompt policy + safety hooks at scaffold time
- Merge pull request #191 from knofler/test
- fix(init_blueprint): AI_SOURCE typo -> AI_ROOT (unbound var aborted scaffold)
- fix(followup-183): address Copilot review of PR #183 — 4 hardening fixes
- fix(gateway): resolve FOLLOWUP-178 — dashboard shape mismatch + 3 hardening fixes
- Merge pull request #179 from knofler/test
- fix(runtime): address Copilot review on PR #178 — fallback model, fail-closed config, pattern-index guard
- Merge pull request #173 from knofler/test
- fix(review): address Copilot findings on PR #172 (router/telegram/dashboard)
- fix(merge): post-merge integration fixes for mega-build session 2
- fix(guard): calibrate token budget to real /usage reading (63%@2.76M → 4.4M); document /usage as ground truth
- fix(install): bash 3.2 + set -u empty-array append crash — installer was dead on macOS
- fix: post-merge hardening of mobile mega-build — tests green, dashboard builds, gateway URLs Docker-safe
- fix(update_all): always overwrite session-limits.json so warn-only tuning reaches the fleet (#164)
- fix(update_all): always overwrite session-limits.json (framework-owned)
- fix(update_all): atomic MCP server replacement in overlay merges (#161)
- fix(update_all): replace whole MCP server entries, not deep-merge keys
- fix: reproducible dashboard build + official Stitch MCP endpoint (#160)
- fix(mcp): switch stitch to official Google endpoint + env-var auth
- fix(dashboard): reproducible Docker build via npm ci + lockfile
- fix(hooks): guard host-only session hooks against in-container execution (#159)
- fix(hooks): guard host-only session hooks against in-container execution
- fix(docker): tmpfs overlay for vitest .vite-temp in gateway (#155)
- fix(docker): tmpfs overlay for vitest .vite-temp in gateway
- fix(propagate): notify-telegram hook path + managed_repos.txt inline-comment strip (#144)
- fix(propagate): rewrite notify-telegram hook path + strip inline comments from managed_repos.txt
- fix(update_all): branch bug + Phase A two-tier state rotation (#141)
- fix(update_all): switch to test before commit + track AI/README,config,scripts,templates
- fix(update_all): handle symlinks in AI/.claude/agents{,/skills} without traversal
- fix(update_all): preserve per-repo custom MCP entries on propagation
- fix(mcp): move project config to .mcp.json + dashboard lockfile parity (#140)
- fix(mcp): move project config to .mcp.json (Claude Code's actual path)
- fix(blueprint): wrap $VAR before non-ASCII ellipsis (set -u crash) (#124)
- fix(blueprint): wrap $VAR in ${VAR} before non-ASCII ellipsis (set -u crash)
- fix(blueprint): default vercel deploys to knoflers-projects scope, not powerhouse
- fix(hooks): two false-positive bugs in secret-scan (#111)
- fix(hooks): two false-positive bugs in secret-scan
- fix(channels): tighten Option C from PR #102 review (Copilot) (#103)
- fix(channels): tighten Option C from PR #102 review (Copilot)
- fix(channels): tighten hallucination regex from PR #99 review (#100)
- fix(channels): tighten hallucination regex from PR #99 review
- fix(channels): prevent agent hallucination in chat mode (Options A + D) (#99)
- fix(channels): prevent agent hallucination in chat mode (Options A + D)
- fix(scheduler): trim consistency + whitespace-safe topN (#91)
- fix(scheduler): trim consistency + whitespace-safe topN coercion
- fix(scheduler): polish from PR #89 review (#90)
- fix(scheduler): polish from PR #89 review
- fix(scheduler): harden tool-kind validation + clamp topN (#89)
- fix(scheduler): harden tool-kind args + clamp morning-sweep topN
- fix: docker stats example — invalid template field (#84)
- fix: docker stats example — .MemLimit is not a valid template field
- fix: Copilot review on PR #83 — percentage + docker stats format
- fix: address Copilot review on Phase 2a MCP tools
- Merge pull request #74 from knofler/test
- fix: add git noreply email rule — auto-fix on GH007 push failure
- Merge pull request #71 from knofler/test
- fix: ship it must sync test with main after merge
- Merge pull request #69 from knofler/test
- fix: restore Telegram "Thinking..." message + fix HOST_HOSTNAME env
- Merge pull request #68 from knofler/test
- fix: add DESIGN_SYSTEM.md + templates/design/ to update_all.sh sync
- fix: address code review — async state tracking + remove dead code
- fix: usage guard stale session auto-reset
- fix: usage guard stale session — auto-reset expired metrics instead of blocking
- fix: YOLO review findings — gitignore state/.yolo + 4h god mode cap
- fix: increase mongo healthcheck timeout and start_period
- Merge pull request #41 from knofler/test
- fix: address Copilot review — sync scripts to repos, remove token preview
- fix: audit findings — idiomatic bash and safer python arg passing
- Merge pull request #37 from knofler/test
- fix: Docker naming enforcement uses compose name field over folder name
- Merge pull request #34 from knofler/test
- fix: Docker naming uses exact folder casing, not lowercase
- fix: simplify secret-scan hook — minimal bash with set +e
- fix: address audit findings — macOS compat, secret scan, protected files
- Merge pull request #19 from knofler/test
- fix: add mandatory machine check to agent mode + start work keywords
- Merge pull request #18 from knofler/test
- fix: add MULTI_MACHINE_WORKFLOW.md to update_all.sh sync list
- fix: merge duplicate @/models import in batch-executor (lint error)
- fix: merge duplicate next/server imports in generate routes
- fix: sync templates with bug fixes — upvote mapping, reporter name, populate userId
- fix: update_all.sh pushes to test branch instead of main
- Merge pull request #14 from knofler/test
- fix: CONNECT_HUB.md — explicit: use existing DB/auth, do NOT create new adapters
- Merge pull request #13 from knofler/test
- fix: README project keywords — init connect → connect setup
- Merge pull request #12 from knofler/test
- fix: clarify Connect Hub keyword flow — connect setup is the only local keyword
- Merge pull request #9 from knofler/test
- fix: show reporter name instead of "User" — populate userId on bug/feature lists
- Merge pull request #8 from knofler/test
- fix: upvote button — field name mismatch (upvotes→votes, voted→hasVoted)
- Merge pull request #6 from knofler/test
- fix: Vercel serverless timeout — after() keeps generation alive, model tier rebalance
- fix: rollout script --no-verify for repos with husky hooks
- fix(ci): lower coverage thresholds, fix lint error
- fix(ci): use npm install instead of npm ci — no lockfile in repo
- fix: environment-aware provider routing, DeepSeek default cloud, CLI timeout fallback
- fix: bump CLI timeouts 5min→8min, job executor 6min→9min
- fix: reduce input truncation 12K→8K for later stages, add streaming provider fallback
- fix: production stability — throttle DB queries, save partial on timeout, increase maxTokens
- fix: full keyword set in introduce_agent.sh — matches CLAUDE template
- fix: split a workspace monorepo into 3 actual git repos (api, app, docker)
- fix: managed_repos.txt points to actual git repos, not workspace parents
- fix: introduce_agent.sh arg order in update_all and init_ai
- fix: use cloud-synced paths in managed_repos.txt for cross-machine support
- fix: add ship to pipeline routes, all stages navigate directly
- fix: consistent approved state + regenerate on all pages
- fix: add StageNavBar to idea and gap-analysis pages
- fix: Gemini CLI stdin, provider badges, stage color gradient, timer
- fix: use static imports in AI registry for Vercel/webpack compatibility
- fix: skip ESLint and TypeScript checks during Vercel build
- fix: vercelignore was excluding src/components/artifacts/ — scope to root only
- fix: make husky prepare script safe for Vercel/CI environments
- fix: graceful PDF fallback for Vercel — serve styled HTML when Chromium unavailable
- fix: resolve text overlap in PDF renderer for inline segments and list items
- fix: add shiki dependency for CodeViewer syntax highlighting
- fix: restore PDF download — install pdfkit in Docker, enable bufferPages
- fix: switch download from PDF to markdown — pdfkit font path broken in Docker
- fix: standardise all later stages to 10-min timeout, remove dead additionalContext
- fix: remove code generation rules from build/ship system prompts
- fix: strip allStageOutputs from design/build/ship routes to prevent CLI timeout
- fix: Design stage timeout — context truncation, undici extended timeouts, stdin piping
- fix: AI suggest error handling, rename Local Agents → Local Tools
- fix: update managed_repos.txt paths (rummanahmed → rumman.ahmed)
- fix: timeline overflow + document viewer + logout UI
- fix: update stale username paths in managed_repos.txt and handoff

### Performance
- perf(gateway): hot-path p95 latency meter + slow-query log on /analytics
- perf(gateway): index audit + explicit compound indexes for hot-path collections
- perf(dashboard): registry tab taps now instant — full sibling-tab prefetch + 60s revalidate
- perf(dashboard): registry data cache + client router cache — kill per-tap Atlas round-trips
- perf(memory): indexed vector search — Atlas $vectorSearch + embedded ANN
- Merge pull request #151 from knofler/test
- perf(indexer): stream archive files per-file in indexArchiveFiles

### Added

- **Self-hosted / on-prem install bundle (GRAND_PRODUCT Phase 3).** A
  self-contained `selfhost/` distribution that stands up the whole platform —
  gateway + dashboard + MongoDB — on customer-owned hardware:
  - `selfhost/docker-compose.yml` — self-contained stack (build contexts
    relative to the repo, bundled Mongo as the default store, all values
    env-overridable, healthchecks + `unless-stopped` on every service,
    `REQUIRE_LOGIN`/`TENANT_ENFORCE` on by default for an enterprise deploy).
  - `selfhost/install.sh` — one command: verifies Docker, generates strong
    secrets into a `chmod 600` `.env` on first run, builds, brings the stack up,
    and waits for every healthcheck. `--no-build` / `--status` / `--down`.
  - `selfhost/.env.example` — fully annotated template (secrets auto-filled by
    the installer; no baked-in credentials).
  - `selfhost/README.md` — operator docs (quick start, config reference, data
    locality + backup, TLS/reverse-proxy, upgrade, troubleshooting).
  - `selfhost/test.sh` + `scripts/tests/test_selfhost_bundle.sh` — hermetic
    structure + `docker compose config` lint (auto-skips without Docker; wired
    into `run_all.sh` → `script-unit-tests.yml`) plus an opt-in
    `SELFHOST_SMOKE=1` full build/up/health smoke.

- **Automated release cadence (semantic-release equivalent).** Zero-dependency
  release automation that computes the next version from Conventional Commits:
  - `scripts/release_version.py` — `current` / `bump` / `next` / `notes` /
    `apply` subcommands (stdlib only). `feat` → minor, `fix`/`perf` → patch,
    `!` / `BREAKING CHANGE:` → major; `apply` bumps `package.json` + prepends a
    Keep-a-Changelog section. Exposed as `npm run release:plan|notes|apply`.
  - `.github/workflows/release.yml` — two human-gated, CI-thrift-compliant
    entry points (never a `push` trigger): `workflow_dispatch` **plans** a
    dry-run (version + notes + guard + tests, published to the job summary), and
    `release: published` **publishes** to npm (tag↔package.json check →
    `publish_guard.sh` → unit suite → `npm publish --access public` → registry
    verify), gated on the `NPM_TOKEN` secret.
  - `scripts/tests/test_release_version.sh` — 23 hermetic unit assertions
    (bump precedence, semver math, notes grouping, `apply` mutation), wired into
    `run_all.sh` → `script-unit-tests.yml`.
  - The **first publish stays manual** per `documentation/RELEASE.md`; the
    automated cadence takes over from the next release.

## [0.2.0] — 2026-07-03

The **go-live hardening** release: first-run experience (`demo`, `status`,
`logs`, self-healing `up`), agent continuity plumbing (`connect-agent`,
`context_boot`), Linux support (runner installer, clean-Linux cold-start E2E),
and a pile of publish-blocker fixes found by full-install testing. No breaking
changes — minor bump per semver.

### Added

- **`myai status`** — post-up observability in one command: gateway + dashboard
  `/health` probes, `docker compose ps` for the stack's containers, and
  task-queue counts (pending/working/review/blocked/done) fetched through the
  gateway MCP `tasks_list` tool with the `x-gateway-local-token` header.
  `--json` for scripts, `--repo <name>` to scope the queue counts; exits 0 only
  when the stack is healthy, so it doubles as a poll target. Python-free —
  works on a clean Linux box with no `python3`.
- **`myai logs [service]`** — tail stack logs; wraps `docker compose logs -f`
  with the same project detection as `up`/`down` (portable project vs master
  repo). `--no-follow` prints and exits; `--tail <n>` sets the backlog depth
  (default 100).
- **`myai demo`** — seed realistic sample data (tasks, plans, directory cards,
  notifications) so the first-run dashboard is alive instead of empty.
- **`myai connect-agent`** — one command to plug ANY agent (Claude Code, Gemini,
  Copilot, custom) into the continuity layer: writes the MCP client config and
  boot instructions for the target agent.
- **Self-healing health gate in `myai up`** — bounded retry with log capture and
  rollback when a service fails its health probe, instead of hanging or leaving
  a half-up stack.
- **Linux runner installer** — systemd user timer with cron fallback and
  platform auto-detect, so the autonomous CLI runner is installable beyond
  macOS launchd.
- **Clean-Linux cold-start E2E harness** — scripted acceptance run proving
  `npx` init → healthy dashboard on a fresh Linux box in under 5 minutes.
- **`context_boot` MCP tool (betaC)** — callable boot bundle with lazy RAG, plus
  auto-boot that force-loads a tight context bundle on MCP connect; the core of
  the agent-continuity story.
- **Atomic `tasks_claim` MCP tool** — race-free task claiming for multi-runner
  fleets (ADR-011 slice 2).
- **Real-time notifications** — event bus + SSE stream endpoint in the gateway,
  with dashboard bell, toast stack, and history page.
- **Blueprint bundled** — `templates/blueprint` scaffold ships in the package
  and `init_blueprint` gains a local mode, so `myai new-app` works offline.
- **Unit suite for `bin/myai.cjs`** — dispatch + doctor surface covered.
- **`CONTINUITY_DEMO.md`** — scripted 2-minute demo of the continuity layer,
  plus a `context_boot` operator brief.

### Fixed

- **Publish blockers caught by full-install testing** — `myai init` now works
  end-to-end from a packed tarball (missing files, path assumptions).
- **Portable stack auto-names from its folder** — a second install no longer
  clobbers a live `myai` compose stack.
- **`update_all` deep-merges propagated JSON configs** — stops clobbering
  repo-local settings when the framework syncs (18× repeat-incident fix), with
  portable mtime handling for Linux CI.
- **Runner pipeline revival** — stale-gateway guard + banner auth so the
  autonomous queue never starves on a stale gateway image.
- **Portable `python3` resolution** in `myai_status.sh` (later superseded by
  the python-free rewrite above).
- **Remote control on CLI 2.x** — correct `--remote-control` flag handling.

### Security / clean-room

- **Clean-room publish gate green** — operator context genericised in shipped
  docs (`acme`/`myapp` examples), fleet-only tooling excluded from the tarball;
  `publish_guard.sh` exits 0 and remains wired into `prepublishOnly`.

## [0.1.0] — 2026-06-26

First public release — the **Independent Edition**. The framework, previously
operated only from the master repo, is now packaged as an installable npm CLI
(`myai` / `ai-manage`) that scaffolds and runs the whole stack in any project,
on any machine, with no access to the operator's private context.

### Added

- **`myai` CLI** (`@knofler/ai-management`) — a thin, zero-required-dependency
  dispatcher that shells into the framework's `scripts/*.sh` and `docker compose`
  so the bash playbooks remain the single source of truth. Installs two bins:
  `myai` and `ai-manage`. Works before `npm install` via a built-in fallback
  parser; uses `commander` for richer help when present.
  - `myai init [path]` — scaffold the framework + portable `docker-compose` +
    `.env` into a target repo. Guided first-run wizard on a TTY (API key,
    profile, scan dir); `--no-wizard` to skip.
  - `myai up` / `myai down` — start/stop the self-contained stack (gateway +
    dashboard + mongo) on localhost, wait for health, print the dashboard URL.
    `myai down --volumes` also drops the mongo data volume.
  - `myai scan [path]` — spider git repos under a directory, register each in
    the gateway directory, and seed RAG awareness. `--register` also lists in
    `managed_repos.txt`; `--dry-run` previews.
  - `myai new-app [path]` — scaffold a new full-stack app from the Powerhouse
    Blueprint and register it in the directory.
  - `myai connect [path]` — install the Connect Hub module (ticket → task
    bridge) into a project.
  - `myai schedule [args...]` — queue an autonomous task for the CLI runner.
  - `myai doctor` — preflight checks: node ≥ 20, docker + engine running,
    docker compose, git, `claude` CLI, `ANTHROPIC_API_KEY`, framework files
    present, and stack ports (3100/3200/3201/3210/27200) free.
- **Self-contained stack** — portable `docker-compose.yml` (gateway, dashboard,
  mongo) that any installed project can bring up on localhost without touching
  the master repo.
- **Clean-room packaging (P0 release gate)** — defence-in-depth so the published
  tarball contains the framework **only**, never operator context:
  - Layer 1 — opt-in `files` allowlist in `package.json`.
  - Layer 2 — `scripts/publish_guard.sh`: `npm pack` → extract → fail if the
    tarball contains anything under `state/ plan/ memory/ logs/ LL/` etc., the
    operator's home path, email, known repo names, or secret-shaped strings.
    Wired into `prepublishOnly`, so `npm publish` hard-blocks on any leak.
- **Onboarding** — independent welcome flow + 5-minute README quickstart for a
  fresh install with no prior framework knowledge.
- **E2E acceptance harness + security pass** — `scripts/e2e_acceptance.sh`
  (loopback-only, no shipped secrets, env hygiene) plus `scripts/smoke-cli.sh`.
- **Distribution docs** (`documentation/DISTRIBUTION.md`), a runnable demo
  walkthrough (`scripts/demo.sh`), and a release/publish runbook
  (`documentation/RELEASE.md`).

### Notes

- **Docker-only / no-host-build.** The CLI never runs `npm install` on the host;
  everything builds inside containers.
- **Privacy.** Operator-specific state, plans, memory, logs, `SHOWCASE.md`,
  `CLAUDE.md`, env files, and managed-repo lists are excluded from the package
  by both the allowlist and the leak scanner.

[Unreleased]: https://github.com/knofler/myai/compare/v0.6.4...HEAD
[0.6.4]: https://github.com/knofler/myai/compare/v0.6.3...v0.6.4
[0.2.0]: https://github.com/knofler/myai/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/knofler/myai/releases/tag/v0.1.0

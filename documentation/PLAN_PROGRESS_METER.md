# Plan Progress Meter — `wrap up` reference

Source of truth for the **Roadmap status** table rendered at the end of every `wrap up` session in this master repo (per `CLAUDE.md` keyword step 4b).

The meter answers three questions in one glance:
1. What's done?
2. What's in flight or paused?
3. What's the highest-velocity next item?

It's master-repo-only because it reads `plan/AI_AUTOMATION_PLAN.md` and the phase-specific plans (`plan/PHASE_5B_*.md`, etc.). Managed projects have their own plans (e.g. `content_api/AI/plan/SANITY_UPGRADE_PLAN.md`) and the in-repo agent renders its own meter there.

---

## How to render it

Read the plan files in this order and bucket phases by status:

| File | What it tells you |
|---|---|
| `plan/AI_AUTOMATION_PLAN.md` | Top-level phase list (1, 2a, 2b, 3a, 3b, 3c, 4, 5a, 5b, 5c, 5d, 5e, 5f). The "Implementation Order" table is the canonical ledger. |
| `plan/PHASE_5B_BUDGET_GUARDS.md` | Detailed status of Phase 5b sub-tasks |
| `state/STATE.md` "Recently Implemented" sections | Confirms which PRs landed each phase. Cross-reference against git log: `git log --oneline --grep='Phase'` |
| `state/AI_AGENT_HANDOFF.md` "NEW:" section | Most recent session's wins — usually shows the latest phase completion |

For each phase, determine status:
- **✅ Done** — STATE.md has an entry confirming the ship, and there's a merged PR on `main`
- **🟡 Partial** — some sub-tasks done, others pending; mention what's done in the "% done" column
- **⏳ Pending** — no work started, or kicked off but not yet merged

---

## Output format

Render this as a markdown table. Group phases in implementation order, not chronological.

```markdown
## 📊 Roadmap status — % done

The full vision (`plan/AI_AUTOMATION_PLAN.md`) is ~18.5 sessions. Where we are:

| Phase | Description | Status | % |
|---|---|---|---|
| **0** | Framework foundation (agents, skills, hooks, multi-repo) | ✅ Done | 100% |
| **1** | RAG memory (MongoDB vector + indexer) | ✅ Done | 100% |
| **2a** | MCP server foundation (15 tools) | ✅ Done | 100% |
| **2b** | `agents_invoke` + `skills_invoke` MCP tools | ✅ Done | 100% |
| **3a** | Autonomous scheduler (cron loop, 5 schedule tools) | ✅ Done | 100% |
| **3b** | Morning sweep (typed schedule + orchestrator) | ✅ Done | 100% |
| **3c** | Telegram command center (`/agent` / `/skill` parsing) | ⏳ Pending | 0% |
| **4** | Distributable package | ⏳ Pending | 0% |
| **5a** | Cost estimator + `costUsd` per call | ✅ Done | 100% |
| **5b** | Budget guards + tier routing | ✅ Done | 100% |
| **5c** | Provider auto-fallback chain | ✅ Done | 100% |
| **5d** | Anthropic prompt caching | ✅ Done | 100% |
| **5e** | Dashboard `/costs` page | ✅ Done | 100% |
| **5f** | Anthropic Batch API (for morning_sweep) | ⏳ Pending | 0% |
| **C** | Real MCP tool-use loop on channel path | ✅ Done | 100% |
| **A+D** | Hallucination guardrail (system prompt + regex detector) | ✅ Done | 100% |

**Overall ≈ XX% complete on the original 18.5-session vision.**

**Next high-velocity item:** [phase] — [one-sentence rationale: why this is the right next ship in terms of effort × value].
```

---

## How to keep the % calculation honest

- Compute % done as (sum of `% done` per phase) / (count of listed phases). Round to whole %.
- A phase is 100% only when at least one PR has merged to `main` AND the STATE.md entry exists.
- If a phase has multiple sub-items (e.g. Phase 5b had Lanes A-E), express partial completion granularly: `Phase 5b: Lane A/B/C/E ✓, Lane D blocked → 80%`.
- Round phase weight equally — don't try to weight by complexity unless the plan explicitly does (it doesn't yet).

---

## Picking "next high-velocity"

The recommendation at the bottom should optimise for **effort × value**, with bias toward:
1. **Smallest unblock** — finishes carryover from a recent ship (e.g. dashboard view that surfaces data already being collected)
2. **Highest cost lever** — anything that materially reduces $ spend or accelerates other ships
3. **Largest cohort of downstream beneficiaries** — anything propagated to all 22 managed repos

Avoid recommending:
- Items blocked on external user input (sponsor decisions, API keys) — flag them but don't make them "next"
- Items needing > 2 sessions — break them into smaller ships first
- Live-test or QA-only items unless we just shipped something that needs validation

---

## Update protocol

This document is itself part of the framework. Update it when:
- A new phase is added to `plan/AI_AUTOMATION_PLAN.md`
- The output format changes
- The phase numbering scheme changes (e.g. Phase 6 added)

`update_all.sh` does NOT propagate this file to managed repos — it's master-only by design.

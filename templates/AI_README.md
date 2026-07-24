# AI Management Framework

> Multi-agent development framework with 59 specialist agents, 135 skills, and seamless CLI-Mobile workflow.

---

## CLI-Mobile Agent Workflow

Work on any repo from your phone, then continue seamlessly from your desktop — and vice versa. Every repo is fully self-contained with state, agents, skills, and documentation.

### How It Works

```
┌──────────────────────────┐                    ┌──────────────────────────┐
│    MOBILE SESSION        │                    │    CLI SESSION            │
│    (phone/tablet/browser)│                    │    (desktop/laptop)       │
├──────────────────────────┤                    ├──────────────────────────┤
│                          │                    │                          │
│  agent mode              │                    │  agent mode              │
│  ├─ git fetch origin     │                    │  ├─ git fetch origin     │
│  ├─ pull latest main ◄───┼── latest code ─────┤  ├─ pull current branch  │
│  ├─ read STATE.md    ◄───┼── latest context ──┤  ├─ find codeclot*       │
│  ├─ read HANDOFF     ◄───┼── latest handoff ──┤  ├─ merge codeclot*      │
│  └─ checkout codeclot    │                    │  └─ delete codeclot*     │
│                          │                    │                          │
│  Work: code, fix, plan   │                    │  Work: code, fix, plan   │
│                          │                    │                          │
│  wrap up                 │                    │  ship it                 │
│  ├─ commit ALL to        │                    │  ├─ push to test         │
│  │  codeclot branch      │                    │  ├─ CI passes            │
│  ├─ push codeclot ───────┼── mobile work ────►│  ├─ PR to main           │
│  └─ state + handoff      │                    │  ├─ merge to main        │
│     saved in codeclot    │                    │  └─ state on main ───────┼──► next mobile
│                          │                    │                          │
│  NEXT MOBILE SESSION     │                    │  wrap up                 │
│  agent mode → pull main  │                    │  ├─ state committed      │
│  → ALL code + context    │                    │  └─ pushed to main       │
│    instantly available   │                    │                          │
└──────────────────────────┘                    └──────────────────────────┘
```

### Quick Reference

| Action | Mobile | CLI |
|--------|--------|-----|
| Start work | `agent mode` (pulls `main`) | `agent mode` (merges `codeclot*`) |
| Save work | `wrap up` (pushes `codeclot`) | `ship it` (pushes `test` → `main`) |
| Working branch | `codeclot` | `test` |
| State sync direction | Pulls from `main` | Pushes to `main` via PR |

### Session Detection

| Signal | Type | Branch |
|--------|------|--------|
| hostname = `vm` | Mobile | `codeclot` |
| `CODECLOT_OVERRIDE=1` | Forced mobile | `codeclot` |
| Any other hostname | CLI | `test` |

### Branch Names (Both Patterns)

Mobile branches come in two forms — CLI `agent mode` checks both:

| Source | Branch Pattern | Example |
|--------|---------------|---------|
| Manual codeclot | `codeclot` or `codeclot/<timestamp>` | `codeclot/20260405-1430` |
| Claude Code web (auto) | `claude/agent-mode-*` or `claude/*` | `claude/agent-mode-lF3SR` |

CLI merge command: `git branch -r | grep -E 'codeclot|claude/'`

### Concurrent Mobile Sessions

```
Session 1 → codeclot
Session 2 → codeclot/20260405-1430
Session 3 → claude/agent-mode-xY7qR  (auto-created by Claude Code web)

CLI agent mode → merges ALL, deletes each after merge
```

### Critical: Mobile MUST Pull Main First

**The most important step in the mobile `agent mode` is `git checkout main && git pull origin main`.** Without this, mobile works on stale code and stale state. The CLI pushes everything to `main` via PR — mobile must pull `main` to get it.

Full documentation: `AI/documentation/CLI_MOBILE_WORKFLOW.md`

---

## Keyword Quick Reference

| Keyword | What It Does |
|---------|-------------|
| `agent mode` | Full multi-agent activation — syncs code, reads state, dispatches specialists |
| `ship it` | Commit → push test → CI → PR → merge main → update state |
| `wrap up` | Session close — summarize, update state/handoff, push, dashboard |
| `start work` | Read state + handoff, assess status, identify next priority |
| `status` | Quick summary of done/in-progress/blocked/next |
| `review` | Code review + test coverage check |
| `audit` | Security (OWASP) + quality + standards check |
| `scaffold [thing]` | Generate boilerplate: `api`, `page`, `schema`, `docker`, `tests` |
| `plan [feature]` | Break down a feature into specs, stories, and ADR |
| `yolo [minutes]` | Autonomous mode — no permission prompts for N minutes |
| `yolo god` | Full autonomous until commit or plan completion |

---

## Specialist Agents (59)

Agents are auto-discovered from `AI/.claude/agents/` (Claude Code) or used manually from `AI/agents/` (Gemini/Copilot).

### Core 13

| Agent | Domain |
|-------|--------|
| `solution-architect` | ADRs, system design, tech choices |
| `frontend-specialist` | Next.js, React, Vercel |
| `api-specialist` | Node.js/Python APIs, REST/GraphQL, Render |
| `database-specialist` | MongoDB, Mongoose, Atlas |
| `devops-specialist` | Docker, GitHub Actions, CI/CD |
| `ui-ux-specialist` | Design system, Tailwind, accessibility |
| `security-specialist` | OWASP, auth, secrets, rate limiting |
| `documentation-specialist` | README, API docs, changelogs |
| `product-manager` | Feature specs, user stories, roadmap |
| `qa-specialist` | Testing strategy, unit/integration/E2E |
| `tech-ba` | Requirements, data flows, functional specs |
| `tech-lead` | Code review, standards, cross-lane coherence |
| `project-manager` | Delivery, milestones, blockers, STATE.md |

### Extended (46)

`swarm-*` (7), `dev-*` (6), `analysis-*` (5), `neural-*` (4), `github-*` (5), `ops-*` (6), `data-*` (4), `content-*` (4), `external-auditor`, `project-onboarder`, and more.

See `AI/agents/CATALOG.md` for the full registry.

---

## Parallel Dispatch Lanes

| Lane | Agents | Owns |
|------|--------|------|
| A (Frontend) | `frontend-specialist` + `ui-ux-specialist` | `src/app/`, `src/components/` |
| B (Backend) | `api-specialist` + `database-specialist` | `src/routes/`, `src/models/` |
| C (Infrastructure) | `devops-specialist` + `security-specialist` | `docker-compose.yml`, `.github/` |
| D (Async) | `documentation-specialist`, `solution-architect`, `product-manager`, `tech-ba`, `project-manager` | `AI/`, `README.md` |
| Cross-Lane | `tech-lead` (reviews all), `qa-specialist` (tests) | All files (read-only review) |

---

## State Management

```
Session start:  Read AI/state/STATE.md + AI/state/AI_AGENT_HANDOFF.md
After each task: Update AI/state/STATE.md autonomously
Session end:    Update AI/state/STATE.md + AI/state/AI_AGENT_HANDOFF.md
Agent log:      Write to AI/logs/claude_log.md with timestamp
```

State is NEVER waiting for the user to ask. Agents update autonomously after every significant action.

---

## Directory Structure

```
AI/
├── .claude/
│   ├── agents/     → symlink to AI/agents/ (Claude Code auto-discovers)
│   └── skills/     → symlink to AI/skills/ (Claude Code auto-discovers)
├── agents/          59 specialist agent definitions
├── skills/          135 skill playbooks
├── documentation/
│   ├── AI_RULES.md              Tech mandates (Docker, Next.js, MongoDB)
│   ├── MULTI_AGENT_ROUTING.md   Agent routing reference
│   ├── CLI_MOBILE_WORKFLOW.md   Full CLI-Mobile workflow guide
│   ├── MOBILE_CONTROL.md        Remote control + Telegram
│   └── INTEGRATION_GUIDE.md     Framework integration guide
├── state/
│   ├── STATE.md                 Project progress + decisions
│   └── AI_AGENT_HANDOFF.md      Handoff context for next session
├── logs/
│   ├── claude_log.md            Claude session logs
│   ├── gemini.md                Gemini session logs
│   └── copilot.md               Copilot session logs
├── architecture/    ADRs
├── design/          Design docs
└── plan/            Project plans
```

---

## Session Usage Guard — Never Lose Context Again

AI agents hit API rate limits mid-session with zero warning. The session dies — no state saved, no handoff, context lost. The Usage Guard detects approaching limits and forces a clean wrap-up before the crash.

### How It Works

Two metrics tracked (the **higher** percentage wins):

| Metric | Default limit | What it measures |
|--------|---------------|------------------|
| **Elapsed time** | 240 minutes (4h) | Clock time since session start |
| **Weighted actions** | 300 | Tool calls weighted by cost (Bash=1.0, Read=0.3) |

### Three Escalation Levels

```
0%────────────80%──────90%──────95%────100%
               │        │        │       │
               │        │        │       └─ Agent rate limit (CRASH — nothing saved)
               │        │        └─ 🔴 EMERGENCY: tools BLOCKED, only handoff writes allowed
               │        └─ 🔴 RED: mandatory wrap up (commit, push, handoff)
               └─ 🟡 YELLOW: finish current task, start wrapping up
```

| Level | What happens | Why |
|-------|-------------|-----|
| **80% Yellow** | Warning banner. Finish task, don't start new work. | Budget for wrap-up ceremony |
| **90% Red** | Stop work. Run full `wrap up`. Commit, push, handoff. | Last chance for clean exit |
| **95% Emergency** | Bash/Edit/Write **blocked**. Only AI_AGENT_HANDOFF.md writes allowed. | Controlled landing — spend last 5% on handoff only |

**Why block at 95%?** The agent's rate limit at 100% is instant death. The 95% block forces the agent to spend its remaining budget **only on your handoff**, not on random commands that waste the last tokens.

### After It Triggers

1. Agent saves `AI_AGENT_HANDOFF.md` with full context
2. If at 95% (Bash blocked), commit manually:
   ```bash
   git add -A && git commit -m "chore: emergency handoff" && git push origin test
   ```
3. Open another agent → `agent mode` → picks up from handoff

### Configuration

Edit `AI/config/session-limits.json` to adjust thresholds per repo:

```json
{
  "session_duration_minutes": 240,
  "max_weighted_actions": 300,
  "action_weights": { "Bash": 1.0, "Edit": 1.0, "Write": 1.0, "Read": 0.3, "Glob": 0.3, "Grep": 0.3 },
  "block_at_percent": 95
}
```

### If You Get Locked Out

```bash
# In Claude prompt (! prefix runs shell directly):
! bash AI/hooks/session/12-usage-guard-init.sh

# Or in a separate terminal:
bash AI/hooks/session/12-usage-guard-init.sh
```

Resets the timer and action counter. Block lifts immediately. Starting a new session also auto-resets.

---

## Branching Strategy

```
main ──────────────────────────── production (never push directly)
  ↑                    │
  │ PR merge           │ mobile pulls
  │                    ↓
test ◄── CI ◄── push   codeclot ◄── mobile work
```

- **`main`**: Production. PR required, CI must pass.
- **`test`**: Staging. Direct push OK, CI runs automatically.
- **`codeclot`**: Mobile sync. Never deployed. Merged by CLI agent mode.

---

## Cost Management

Two layers protect against excessive costs:

**Layer 1: Session Usage Guard** (see above) — detects approaching API limits, forces wrap-up at 80/90/95%.

**Layer 2: Cost-Aware LLM Routing** — routes tasks to cheapest capable provider:

```
Tier 0: Skip-LLM    → Templates, grep, file ops ($0)
Tier 1: Local CLI    → Claude Code, Gemini CLI ($0)
Tier 2: Budget Cloud → DeepSeek V3, Gemini Flash (~$0.001/req)
Tier 3: Premium      → Claude Sonnet, GPT-4o (~$0.01/req)
Tier 4: Ultra        → Claude Opus (~$0.05/req)
```

Budget guards warn at $1/session, $5/day, $50/month. Full details: `AI/documentation/COST_AWARE_ROUTING.md`

---

## Critical Rules

1. **NEVER push directly to `main`** — always via `test` → PR
2. **NEVER run npm/node locally** — use `docker compose exec app <command>`
3. **NEVER commit secrets** — check `.gitignore` before staging
4. **Docker naming**: `container_name` must use `{folderName}-` prefix

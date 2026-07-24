# Skill: Codebase Scan

> Agent: **project-onboarder** (primary), all specialists (parallel dispatch)
> Triggers: `scan`, `scan codebase`, `full scan`, `onboard project`, `analyze codebase`, `detect stack`

---

## Purpose

Scan any project directory to detect its tech stack, frameworks, dependencies, Docker setup, CI/CD, and produce a comprehensive JSON report. This is the entry point for onboarding any project into the AI management framework.

---

## Inputs

| Input | Source | Required |
|-------|--------|----------|
| Project root path | User or `config/managed_repos.txt` | Yes |
| Existing `state/STATE.md` | Auto-detected | No |
| Previous scan report | `AI/scan-report.json` | No |

---

## Steps

### 1. Run the Automated Scanner

```bash
./scripts/scan-project.sh /path/to/project
```

Options:
- `--json` — JSON only output (no pretty print)
- `--output /custom/path.json` — Custom report location

Default output: `<project>/AI/scan-report.json`

### 2. Review the Scan Report

The report contains these sections:

| Section | Contents |
|---------|----------|
| `project` | Name, path, package info, scan timestamp |
| `stack.types` | Language types: nodejs, python, nextjs, rust, go, ruby, java |
| `stack.frameworks` | Next.js, React, Express, FastAPI, Django, Tailwind, Mongoose, etc. |
| `stack.databases` | MongoDB, PostgreSQL, MySQL, Redis |
| `stack.auth` | Auth0, NextAuth, Passport, JWT, Clerk, Firebase Auth |
| `stack.deployment` | Vercel, Render, Docker, GitHub Actions, Fly.io, Netlify |
| `stack.test_frameworks` | Jest, Vitest, Playwright, Cypress, pytest |
| `structure` | File counts by type, entry points, API routes, models |
| `dependencies` | Production/dev dependency counts, npm scripts |
| `docker` | Dockerfile, docker-compose, services, compose name |
| `git` | Remote URL, branch, total commits |
| `ai_framework` | Whether AI/ dir, STATE.md, CLAUDE.md exist |
| `recommendations` | Gaps: needs Docker, CI, tests, AI framework, env example |

### 3. Map Technologies to Agents

Based on the scan, route to relevant specialists:

| Detected | Agent |
|----------|-------|
| Next.js / React / TSX files | `frontend-specialist` + `ui-ux-specialist` |
| Express / FastAPI / API routes | `api-specialist` |
| MongoDB / Mongoose / models | `database-specialist` |
| Docker / docker-compose | `devops-specialist` |
| Auth0 / JWT / NextAuth | `security-specialist` |
| Test files / Jest / Vitest | `qa-specialist` |

### 4. Act on Recommendations

| Flag | Action |
|------|--------|
| `needs_docker: true` | Run `dockerfile-create` skill |
| `needs_ci: true` | Run `github-actions-pipeline` skill |
| `needs_tests: true` | Run `test-strategy` skill |
| `needs_ai_framework: true` | Run `./scripts/init_ai.sh /path/to/project` |
| `needs_env_example: true` | Create `.env.example` from `.env` |

### 5. Feed into Generation Pipeline (Optional)

For existing projects, use the scan as context for the generator:

```bash
./scripts/generate-project.sh "enhancement idea" --scan /path/to/project --name project-v2
```

### 6. Parallel Agent Dispatch (For Deep Scan)

For a thorough analysis beyond the automated scan:
- Invoke `agent-opinion-gather` skill with the agent dispatch list from Step 3
- Each agent scans ONLY its domain files
- Agents run in parallel across lanes A/B/C/D per `MULTI_AGENT_ROUTING.md`

### 7. Update State

- Write findings to `state/STATE.md`
- Create tasks from recommendations via `auto-task-assign` skill

---

## Outputs

| Output | Location |
|--------|----------|
| Scan report (JSON) | `<project>/AI/scan-report.json` |
| Console summary | Pretty-printed stack, structure, recommendations |

---

## Notes

- The scanner runs as a bash script — no Docker required
- First scan of a project takes ~2-5 seconds
- Scan report is consumed by the generation pipeline for context-aware generation
- Always update `state/STATE.md` after scan completes

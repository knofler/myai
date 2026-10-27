# myAI — shipped rules and core keywords

The generic source that `scripts/generate_tool_instructions.sh` splices into
the instruction files it renders for non-Claude tools (`templates/copilot-instructions.md`,
and any repo without its own `CLAUDE.md`). A repo that has a `CLAUDE.md` with
these two sections uses its own instead. Keep both section headings and the
`---` that closes each: the generator cuts on them.

## CRITICAL RULES (read before doing anything)

1. **NEVER push directly to `main`.** All code goes to the `test` branch first: push to `test` → verify the preview → PR to `main` → merge.
2. **Run Node tooling in Docker, not on the host.** Use `docker compose exec app <command>` for `npm install`, `npm ci`, `npx` and `node`. CI runners are the only exception.
3. **NEVER commit `node_modules/`, `.env`, or secrets.** Check `.gitignore` before staging.
4. **Docker container naming.** Every `container_name` in `docker-compose.yml` uses the exact repo folder name as its prefix (casing preserved): `{folderName}-app`, `{folderName}-mongo`, `{folderName}-api`.
5. **Frontend standard: Tailwind CSS + shadcn/ui.** Next.js projects use Tailwind v4 (CSS-first `@theme` config) and shadcn/ui components. Utility classes only, with no CSS modules, styled-components or inline styles. Design tokens live in `globals.css`, shadcn components in `src/components/ui/`, and the `cn()` helper in `src/lib/utils.ts`.
6. **Git email privacy.** If `git push` fails with `GH007` or an email-privacy error, set this repo's `user.email` to your GitHub noreply address and amend the commit so that both author and committer use it. Never change `--global` config to do this.
7. **API documentation is mandatory.** A project with API endpoints has (a) an OpenAPI 3.0 spec at `/api/openapi.json`, (b) interactive docs at `/docs`, and (c) an OpenAPI MCP server in `.mcp.json`. An endpoint that isn't in the spec isn't finished.
8. **CI and preview deploys must not run on every push.** Verify locally in Docker first (`./AI/scripts/local-ci.sh`: type-check, tests, build). CI triggers on `pull_request` and `workflow_dispatch` only, with no `push:` trigger. Keep `test` in the PR trigger wherever `test` has required status checks. Gate preview/production deploys in `vercel.json` (or `vercel.ts`), and keep that file in the Vercel project's Root Directory, because Vercel ignores it anywhere else.
9. **Self-hosted CI runners.** GitHub-hosted Actions minutes cost money, so CI runs on the local self-hosted runner (`runs-on: [self-hosted, myai-local]`) with no `push:` trigger. Repos owned by an org listed in `config/hosted_runner_orgs.txt` (empty by default) may keep hosted runners. `scripts/runner_selfhosted.sh up <owner/repo>` registers a repo's own runner.

---

## Quick Keywords — Core

| Keyword | What it does |
|---------|--------------|
| `hello` | Table of all keywords (core + `KEYWORDS_REFERENCE.md`). |
| `jam` / `jam <idea>` | Brainstorm before building. A conversation, not code: questions and pushback are the work. |
| `start work` | Read the project state and handoff, report done / in progress / blocked, then name the next priority. |
| `agent mode` / `agent mode -a` | Full session start: sync git, load the brain, check the machine and stack, report, and dispatch work. `-a` then runs autonomously. |
| `agent mode -min` / `agent min` | Lightweight start in under a minute: sync, boot from the brain, report the last session and the queue. |
| `agent mode -resume` / `agent resume` | Join the last scheduled run for this repo and continue its work. |
| `resync` | Bring the code repo and the brain up to date in one step, safely, at any time. |
| `boot` | Read this machine's last boot report (`state/boot/BOOT_REPORT.<host>.md`); never re-run the checks. |
| `ship it` | Commit → push `test` → CI → preview → PR `test`→`main` → review → merge → update state. |
| `wrap up` / `wrap up -u` | Close the session: handoff delta, brain commit and merge, push state, then the WRAPPED UP banner. |
| `merge it` | PR `test`→`main` (create it if missing), wait for green CI, merge, confirm production. |
| `yolo god` / `yolo <min>` / `yolo off` | Autonomous mode until the next commit or plan step / for N minutes / stop. Safety rails stay on. |

---

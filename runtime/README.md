# myAI — Self-Hosted AI Gateway

> Standalone runtime daemon for the AI Management Framework. HTTP API + WebSocket + CLI + Docker.

## Quick Start

```bash
cd runtime
docker compose up -d

# Verify
curl http://localhost:3200/health
# → {"status":"ok","uptime":5,"mongodb":"connected"}

curl http://localhost:3200/status
# → {"agents":57,"skills":135,"sessions":{"total":0,"active":0}}
```

## Architecture

```
runtime/
  src/
    core/           ← HTTP server, session manager, message router, bootstrap
    agents/         ← Agent/skill loader (reads agents/*.md + skills/*/SKILL.md)
    ws/             ← WebSocket server (typed protocol, heartbeat)
    cli/            ← CLI: myai start|stop|status|agents|sessions
    shared/         ← Config, logger, types, Mongoose schemas
  Dockerfile        ← Multi-stage Node 20 Alpine
  docker-compose.yml ← Gateway + MongoDB 7
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Uptime, agents, skills, sessions |
| GET | `/api/agents` | List all agents (optional `?category=swarm`) |
| GET | `/api/agents/:name` | Agent detail with full instructions |
| GET | `/api/skills` | List all skills (optional `?agent=tech-lead`) |
| GET | `/api/skills/:name` | Skill detail with full playbook |
| POST | `/api/sessions` | Create session `{"agentName":"tech-lead"}` |
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Session detail with messages |
| DELETE | `/api/sessions/:id` | Close session |
| POST | `/api/sessions/:id/messages` | Send message `{"content":"..."}` |
| POST | `/api/new-app` | Idea → app: `{"idea":"...","name?":"...","trigger?":true}` — drives agentFlow's idea→app pipeline + registers the repo in the directory |

## WebSocket

Connect to `ws://localhost:3201`. Messages are JSON:

```json
{"type":"session.create","agentName":"tech-lead","content":"Hello"}
{"type":"session.message","sessionId":"...","content":"Review the PR"}
{"type":"agent.list"}
{"type":"ping"}
```

## CLI

```bash
# Inside Docker
docker exec myai-gateway node dist/cli/main.js status
docker exec myai-gateway node dist/cli/main.js agents
docker exec myai-gateway node dist/cli/main.js sessions

# Create a new app from an idea (drives agentFlow's idea→app pipeline)
npx myai new-app "a recipe sharing app with meal planning"
npx myai new-app "internal CRM" --name acme-crm --no-trigger

# Or via npx (after npm publish)
npx myai start
npx myai status
```

The `new-app` command POSTs to the gateway `/api/new-app`, which creates an
agentFlow project, fires its auto-run codegen→runner pipeline, and registers the
generated repo in the app-directory. Set `AGENTFLOW_URL` (default
`http://host.docker.internal:3000`) and `AGENTFLOW_TOKEN` (a bearer token) so the
gateway can reach agentFlow; the directory card is registered regardless.

## Configuration

Environment variables override `gateway.config.json`:

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_HTTP_PORT` | 3200 | HTTP API port |
| `GATEWAY_WS_PORT` | 3201 | WebSocket port |
| `MONGODB_URI` | `mongodb://admin:password@localhost:27017/myai?authSource=admin` | MongoDB connection |
| `AI_ROOT` | `../` | Path to AI framework root (agents/, skills/) |
| `LOG_LEVEL` | info | Logging level (debug/info/warn/error) |
| `AGENTFLOW_URL` | `http://host.docker.internal:3000` | agentFlow base URL for `new-app` idea→app trigger |
| `AGENTFLOW_TOKEN` | — | Bearer token the gateway uses to authenticate to agentFlow |
| `BETAC_AUTOBOOT` | on | betaC auto-boot. On MCP `initialize`, the gateway force-loads a tight context bundle via the standard `instructions` field. Set `0`/`false`/`off`/`no` to disable (handshake then omits `instructions`). |
| `BETAC_IDENTITY` | — | One-line user identity injected into the auto-boot bundle (e.g. "Rumman — solution architect at Powerhouse"). Falls back to `<AI_ROOT>/state/identity.md`, then a neutral default. |
| `BETAC_BUDGET_CHARS` | 1800 | Hard char budget for the auto-boot bundle (~4 chars/token). Keeps the boot cheap; deeper context is pulled lazily via `handoff_read`/`recall_session`/`memory_search`. |

### betaC auto-boot (MCP server-instructions)

Cooperating MCP clients (Claude CLI/desktop) load `InitializeResult.instructions`
into the model's context automatically on connect. The gateway populates that
field with a **tight** bundle — identity + active project + last-handoff summary +
active plan — so a fresh/blank agent on any machine is bootstrapped with the
user's context with **no keyword and no ritual** (generalizing `agent mode -a`).

By design it stays cheap: the bundle is hard-capped (`BETAC_BUDGET_CHARS`) and
points to `handoff_read` / `recall_session` / `memory_search` for deeper context
pulled lazily — it builds **on** those tools, it does not recreate them. Assembly
is best-effort: a DB outage degrades to an identity-only bundle and never fails
the handshake. See `src/mcp/context-bundle.ts`. Spec: `plan/jam/betac.md`.

## Docker

```bash
# Start
docker compose up -d

# Logs
docker compose logs -f gateway

# Rebuild after code changes
docker compose up -d --build gateway

# Stop
docker compose down
```

Ports: HTTP 3200, WebSocket 3201, MongoDB 27200 (mapped from 27017).

## Docker MCP Toolkit

Docker Desktop's MCP Toolkit (`docker mcp`) can manage the connection to this
gateway instead of hand-editing `.mcp.json`. One-time setup:

```bash
# Requires: Docker Desktop with MCP Toolkit enabled, and the gateway running
# (docker compose up -d gateway).
./scripts/docker-mcp-setup.sh
```

This registers a `myai` catalog entry (`mcp/catalog/myai-server.yaml`) pointing
at the gateway's existing HTTP MCP endpoint (`http://host.docker.internal:3100/mcp`),
creates a `myai` profile, and stores `GATEWAY_LOCAL_TOKEN` in the OS Keychain via
`docker mcp secret` (no more plaintext token in `.env`/`.mcp.json`). To connect a
client:

```bash
docker mcp client connect claude-code --profile myai
docker mcp tools ls --profile myai
```

`client connect` merges a single `MCP_DOCKER` entry into `.mcp.json` alongside
your other servers — it does not remove the manual `myai` HTTP entry, so drop
that by hand once you've confirmed the toolkit path works.

Verify the packaging (image build + catalog/profile/secret/connect round trip,
all against throwaway names — never touches the real `myai` catalog/profile or
this repo's `.mcp.json`):

```bash
./scripts/docker-mcp-verify.sh          # catalog/profile smoke test
./scripts/docker-mcp-verify.sh --build  # + OCI image build check
```

Catch the catalog file drifting from the gateway it describes (port move,
`/mcp` route rename, `x-gateway-local-token` header rename, `GATEWAY_LOCAL_TOKEN`
rename) — structural checks run hermetically in CI
(`scripts/tests/test_docker_mcp_catalog.sh`); the live-gateway + docker-mcp-CLI
checks run best-effort when available:

```bash
./scripts/docker-mcp-catalog-check.sh               # all checks (schema + docker CLI + live gateway)
./scripts/docker-mcp-catalog-check.sh --schema-only  # hermetic subset only
```

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | Done | Core gateway (HTTP + WS + sessions + agent loader) |
| 2 | Done | Docker + CLI |
| 3 | Next | TypeScript hook system (replace bash hooks) |
| 4 | Next | SONA vector search (semantic memory) |
| 5 | Planned | Channel system (Telegram, Discord, Slack) |
| 6 | Planned | LLM integration (Claude, OpenAI providers) |
| 7 | Partial | npm publish (`npx myai start`) planned; Docker MCP Toolkit catalog packaging done |

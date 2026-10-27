# Troubleshooting

Start with:

```bash
myai doctor            # every check, with a why: and fix: line for each WARN/FAIL
myai doctor --json     # the same, for scripts (exit 0 = passed)
myai doctor --dry-run  # preview the safe automatic fixes
myai doctor --fix      # apply them (never touches secrets or restarts the stack)
```

Each line reads `[OK  ]`, `[WARN]` or `[FAIL] <check> — <detail>`. Find the check
below by its label.

## Doctor checks

### Tools on this machine

| Check | What it means | What to do |
|---|---|---|
| `node >= 20` | The CLI and gateway need Node 20+. | Install Node 20 or newer, then re-run `myai doctor`. |
| `docker on PATH` | The gateway, dashboard and database run as Docker containers. | Install Docker Desktop (macOS/Windows) or Docker Engine (Linux). |
| `docker engine running` | Docker is installed but not running. | Start Docker Desktop (or `sudo systemctl start docker`) and wait until it is running. |
| `docker compose` | `myai up` uses the Docker Compose v2 plugin. | Update Docker Desktop, or install `docker-compose-plugin` on Linux. |
| `git on PATH` | The brain is a git repository. | Install git. |
| `tmux on PATH` (WARN) | Only needed for remote, phone-driven sessions. | Install tmux if you use remote sessions; otherwise ignore. |
| `claude CLI` (WARN) | The off-hours task runner drives an agent CLI. | Install and sign in to your agent's CLI, or set `ANTHROPIC_API_KEY`. Ignore if you don't use the runner. |
| `ANTHROPIC_API_KEY` | Model calls and the runner need an API key or a signed-in agent CLI. | Add `ANTHROPIC_API_KEY=...` to the `.env` next to `docker-compose.yml`, or sign in to your agent CLI. |
| `cloud provider reachable` | No network path to the model provider; myAI falls back to local models. | Check network or proxy settings, or install Ollama. |
| `ollama available` (WARN) | Ollama is the optional offline fallback. | Optional: install Ollama and `ollama pull <model>`. |
| `offline inference path` | Neither the cloud nor Ollama is available; only read-only brain access works. | Restore network access, or install Ollama. |

### Gateway and agents

| Check | What it means | What to do |
|---|---|---|
| `MCP mode` — offline | The gateway is not answering, so agents use the local brain server: brain and recall work, other tools are missing. | `myai up`, then restart your agent. |
| `GATEWAY_LOCAL_TOKEN` | The token local tools use to call the gateway. "Not set" is fine before the first `myai up` (it generates one). The published default is public. | `myai rotate-keys local` for a private token, then reconnect agents (`myai plug <agent> --install`). |
| `GATEWAY_LOCAL_TOKEN_PREVIOUS` | The rotation grace slot holds the public default. | Remove it from `.env`, or rotate again with `myai rotate-keys local`. |
| `<agent> MCP` | Your agent's MCP config has no `myai` entry, so it starts without your context. | `myai plug <agent> --install` (see [agents/](./agents/README.md)), then restart the agent. |
| `.mcp.json` | This folder has no `.mcp.json`, so a project-scoped agent won't connect here. | `myai init` in this repo, or `myai mcp repo`. |
| `repo connected` | This git repo is not connected to myAI. | `myai init` in the repo. |
| `port <n> free` | Another process holds a port the stack needs (3100, 3200, 3201, 3210, 27200). | Find it with `lsof -i :<port>` and stop it, or `myai down` if it is an old myAI stack. |
| `docker-compose.yml` | The compose file is missing, so `myai up` can't start the stack. | Reinstall the package, or run from the folder that has it. |
| `scripts/ directory` | The install is incomplete. | `npm i -g ai-management`. |

### Brain and upkeep

| Check | What it means | What to do |
|---|---|---|
| `brain freshness` | The brain is missing, or unchanged for a week, so agents start without recent context. | `myai brain init` if missing; otherwise end sessions with a wrap-up so they commit. |
| `brain integrity` | The brain repository is damaged (broken HEAD or missing objects). | `git -C <brain dir> fsck`, then restore from your latest `myai backup` or a remote copy. |
| `config migrations` | Your `~/.myai` config or brain layout is older than this version. | `myai upgrade` (it snapshots the brain first). |
| `scheduled job <name>` | A background job is installed but not loaded, or points at a missing script. | Re-run its `--install-schedule` command, or remove it with its uninstall option. |
| `mongo mirror schedule` (WARN) | Optional local copy of a cloud database. | Optional: `myai mirror --install-schedule`; failures log to `~/.myai/logs/mongo-mirror.err`. |
| `swarm master` | No coordinating session is set for this device. | `myai swarm master set`. |
| `runner backlog well` | The runner's background work list is low; a planning task refills it. | Usually nothing. If it stays low, check `myai runner logs`. |
| `session hook timing` | Slow start-up hooks delay every agent session. | `myai doctor --json` shows the timing; disable or speed up the slowest hook. |

## Common symptoms

**The agent starts without my context.**
1. `myai status`: is the gateway healthy? If not, `myai up`.
2. `myai plug proof`: does the round-trip work with no agent involved?
3. `myai plug <agent>`: is the agent's config pointing at `http://localhost:3100/mcp` with your current token?
4. Restart the agent; MCP config is read at start-up.

**The agent's tools fail with 401 after a token change.** `myai rotate-keys local`
changed `GATEWAY_LOCAL_TOKEN`. The old value stays valid for the grace window,
then stops. Re-run `myai plug <agent> --install` (or edit the token in a
hand-written config) and restart the agent.

**`myai up` fails: "required variable MONGO_ROOT_PASSWORD is missing a value".**
You ran `docker compose up` directly in the stack folder before `myai up`
generated the password. Run `myai up`; it writes the password into
`~/.myai/standalone/.env` and starts the stack.

**The gateway refuses to start: "JWT_SECRET is the published default".** Your
`.env` still holds a default from an old release. Run `myai up` (it replaces it
with a generated secret), or set `JWT_SECRET` to the output of
`openssl rand -hex 32`.

**Signup returns 403.** The local stack ships with `SIGNUP_ENABLED=false`; the
single-user install doesn't need accounts. Set `SIGNUP_ENABLED=true` in the
stack's `.env` only if you run myAI for several people.

**The dashboard or gateway can't be reached from another computer.** Ports
bind to `127.0.0.1` by default. To open them to your LAN, set
`HOST_BIND=0.0.0.0` in the stack's `.env` and run `myai up` again. Read
[`../SECURITY.md`](../SECURITY.md) first.

**Logs.** `myai logs` (all services), `myai logs gateway`, and
`myai logs --runner` for the off-hours runner.

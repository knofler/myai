# Connect your agent to myAI

myAI runs a small gateway on your machine (`http://localhost:3100/mcp`). Any
agent that speaks MCP can connect to it. On its first handshake the agent calls
`context_boot` and starts with your context: who you are, your projects, your
last handoff and the next step. That context lives in your brain
(`~/.myai/brain`), not in the agent, so every agent you connect reads the same
memory.

Pick your agent:

| Agent | Page | How it connects |
|---|---|---|
| Claude Code | [claude-code.md](./claude-code.md) | `myai plug claude --install` writes `./.mcp.json` in the repo |
| Cursor | [cursor.md](./cursor.md) | `myai plug cursor --install` writes `~/.cursor/mcp.json` |
| Codex CLI | [codex-cli.md](./codex-cli.md) | `myai plug codex --install` writes `~/.codex/config.toml` |
| Gemini CLI | [gemini-cli.md](./gemini-cli.md) | `myai plug gemini` prints the entry; you merge it into `.gemini/settings.json` |

`myai plug` with no arguments lists every supported agent, including Windsurf,
opencode, and the non-MCP options (Ollama, ChatGPT, or any agent via a printed
primer).

## Before you start (every agent)

```bash
npm i -g ai-management     # once per machine
myai doctor                # preflight: Docker, Node, git, ports
myai up                    # start the gateway, dashboard and database
cd /path/to/your/repo
myai init                  # connect this repo (writes + commits CLAUDE.md, .mcp.json, …)
```

`myai doctor` shows a FAIL for `ANTHROPIC_API_KEY` until you add a key or sign
in to an agent CLI. That only affects model calls and the background task
runner; the stack and every agent connection work without it.

`myai up` generates a private `GATEWAY_LOCAL_TOKEN` into
`~/.myai/standalone/.env` on first start. Agents send it in the
`x-gateway-local-token` header. `myai plug <agent> --install` fills it in for
you; for a config you write by hand, copy it from that file.

## Check the connection

```bash
myai plug proof            # live round-trip against the gateway, no agent needed
myai plug <agent>          # print the config and verify the gateway side
```

Then restart the agent. MCP config is read when the agent starts, so an agent
that was already open does not see a new entry until it restarts.

## When something is off

Run `myai doctor`. Each warning or failure prints a `why:` and a `fix:` line.
[`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) lists every check with the
same explanations, plus the agent-side symptoms.

If the gateway is down, agents fall back to the local brain server: the brain
and recall still work, the rest of the tools do not. `myai doctor` reports this
as `MCP mode — offline`; run `myai up` and restart the agent.

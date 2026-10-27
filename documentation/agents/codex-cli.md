# Codex CLI

Codex CLI reads MCP servers from `~/.codex/config.toml`. Its MCP support is
stdio-first, so myAI connects it through `mcp-remote`, a small bridge that
`npx` runs on demand and that forwards to the gateway over HTTP.

## Connect

```bash
myai up                          # gateway running on localhost:3100
cd /path/to/your/repo
myai init                        # connects the repo to your brain
myai plug codex --install        # adds a [mcp_servers.myai] block to ~/.codex/config.toml and verifies it
```

The install updates only the `[mcp_servers.myai]` block; the rest of
`config.toml` is kept. The block runs:

```toml
[mcp_servers.myai]
command = "npx"
args = ["-y", "mcp-remote", "http://localhost:3100/mcp", "--header", "x-gateway-local-token:<your token>"]
```

`myai plug codex` (without `--install`) prints the block and verifies the
gateway side without writing anything.

## Start

Start a new Codex session in the repo. The `myai` tools are available from the
first turn, and the session boots from your brain.

## Check

- `myai plug proof` runs the continuity round-trip against the gateway.
- `npx` must be on your `PATH` (it ships with Node.js 20+, which myAI already
  needs).
- After `myai rotate-keys local`, run `myai plug codex --install` again so the
  block carries the new token.

# Cursor

Cursor reads MCP servers from `~/.cursor/mcp.json`. That file is user-wide, so
one entry serves every project you open in Cursor.

## Connect

```bash
myai up                          # gateway running on localhost:3100
cd /path/to/your/repo
myai init                        # connects the repo to your brain
myai plug cursor --install       # merges the myai entry into ~/.cursor/mcp.json and verifies it
```

The install is a merge: other servers in `~/.cursor/mcp.json` are kept, and
only the `myai` entry is added or updated. A file with invalid JSON is refused
and nothing is written.

To see the entry without writing it:

```bash
myai plug cursor                 # print the entry + verify the gateway side
```

The entry points at `http://localhost:3100/mcp` and sends your
`GATEWAY_LOCAL_TOKEN` in the `x-gateway-local-token` header.

## Start

Restart Cursor so it reloads `~/.cursor/mcp.json`, then check that the `myai`
server shows as connected in Cursor's MCP settings. Ask the agent who you are
or what you were working on; it answers from your brain.

## Check

- `myai plug proof` runs the continuity round-trip against the gateway.
- After `myai rotate-keys local`, run `myai plug cursor --install` again so the
  entry carries the new token, then restart Cursor.

# Gemini CLI

Gemini CLI is a full MCP client. It reads MCP servers from
`~/.gemini/settings.json` (user-wide) or `<project>/.gemini/settings.json`
(one project). `myai plug gemini` prints the `myai` entry, filled in with this
machine's gateway URL and token, and verifies the gateway side; you merge it
into your settings file.

## Connect

```bash
myai up                          # gateway running on localhost:3100
cd /path/to/your/repo
myai init                        # connects the repo to your brain
myai plug gemini                 # prints the entry (your URL + token) + verifies the gateway side
```

Add the printed `myai` server under `mcpServers` in your settings file. If the
file already has other servers, add it next to them; don't replace the file. It
looks like this:

```json
{
  "mcpServers": {
    "myai": {
      "httpUrl": "http://localhost:3100/mcp",
      "headers": { "x-gateway-local-token": "<your GATEWAY_LOCAL_TOKEN>" },
      "timeout": 30000,
      "trust": false
    }
  }
}
```

The printed entry already carries your token. If you write the entry by hand,
use the `GATEWAY_LOCAL_TOKEN` value from `~/.myai/standalone/.env` (written by
`myai up` on first start). Don't copy the token from
`examples/agents/gemini-cli/settings.json` in the source repository: that is the
published development default, which is public, and a gateway with tenancy
enforcement on does not accept it.

- `httpUrl` selects Gemini CLI's streamable HTTP transport, which is what the
  gateway speaks. Don't use `url` (the legacy SSE transport).
- `trust: false` keeps Gemini's confirmation prompt for each tool call.

## Start

Start Gemini CLI in the repo. The `myai` server's tools, including
`context_boot`, are listed with the other MCP tools, and the session boots with
your context.

## Check

- `myai plug proof` runs the continuity round-trip against the gateway.
- After `myai rotate-keys local`, update the token in your settings file and
  restart Gemini CLI.

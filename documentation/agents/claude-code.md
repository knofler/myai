# Claude Code

Claude Code reads MCP servers from a project file, `.mcp.json`, in the repo you
open. myAI uses that project scope.

## Connect

```bash
myai up                          # gateway running on localhost:3100
cd /path/to/your/repo
myai init                        # connects the repo: kernel CLAUDE.md, .myai-local, .mcp.json
myai plug claude --install       # (re)writes the myai entry in ./.mcp.json and verifies it
```

`myai init` already writes `.mcp.json` (and commits it with `CLAUDE.md`,
`.claude/settings.json` and the `.gitignore` line). Besides `myai`, the
template lists optional servers (for example GitHub, Vercel, Dropbox,
Playwright); Claude Code asks before using each one, and you can delete the
entries you don't want. Use `myai plug claude --install` to
repair or refresh the entry, for example after `myai rotate-keys local`. The
install is a merge: other servers in `.mcp.json` are kept, and only the `myai`
entry is added or updated.

To see the config without writing anything:

```bash
myai plug claude                 # print the entry + verify the gateway side
myai plug claude --no-verify     # print only
```

## Start

Open the repo in Claude Code. If it was already open, restart it: `.mcp.json`
is read at start-up. Then type `agent mode`; it boots from your brain through
`context_boot`.

## Check

- `myai plug proof` runs the continuity round-trip against the gateway.
- `myai doctor` reports `.mcp.json — present` when the file exists in the
  current folder.

## Notes

- `CLAUDE.md` written by `myai init` is a short kernel that points at your brain
  and the installed module (`myai root`). Commit it; `.myai-local` is
  gitignored.
- The off-hours task runner drives an agent CLI. `myai doctor` checks for the
  `claude` CLI or an `ANTHROPIC_API_KEY`; you only need one of them if you use
  the runner.

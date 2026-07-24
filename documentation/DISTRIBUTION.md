# Distribution & Installation

`ai-management` ships the **`myai`** CLI (alias `ai-manage`) plus the
full AI Management Framework it scaffolds. There are two supported install
paths: **npm** (recommended) and the **`curl | sh` bootstrap** (no npm needed).

> **Prerequisites:** Docker Desktop / engine (running), Node.js ≥ 20, and `git`.
> An `ANTHROPIC_API_KEY` (or a logged-in `claude` CLI) is needed for the runner
> and API. Run `myai doctor` after install to verify all of these at once.

---

## Option A — npm (recommended)

### Run without installing (npx)

```bash
npx ai-management doctor          # preflight checks, no install
npx ai-management init ~/my-app   # scaffold into a project
```

### Preflight — avoid the EACCES root-prefix trap

`npm install -g` writes into npm's configured *prefix* directory. On some
setups (Homebrew-installed Node, an OS-bundled Node, a prior `sudo npm i -g`)
that prefix resolves to a root-owned path like `/usr/local`, and the install
fails with a raw `EACCES` permission error instead of a clear message. Check
first, and redirect to a user-writable prefix (`~/.local`) if needed:

```bash
p="$(npm config get prefix)"; [ -w "$p" ] || {
  npm config set prefix "$HOME/.local"
  export PATH="$HOME/.local/bin:$PATH"   # add this line to your shell rc to persist it
  echo "npm prefix was not writable ($p) — switched to $HOME/.local"
}
```

Already have this repo checked out? Run `./scripts/npm_prefix_preflight.sh`
instead (same check; `--fix` applies the switch automatically).

### Install globally

```bash
npm install -g ai-management
myai --version
myai doctor
```

This installs two equivalent binaries: `myai` and `ai-manage`.

### First run

```bash
myai init ~/path/to/your-project   # guided wizard on a TTY (key + profile + scan dir)
cd ~/path/to/your-project
myai up                            # gateway + dashboard + mongo on localhost
# → opens the dashboard URL (default http://localhost:3210)
myai down                          # stop the stack (--volumes also drops mongo data)
```

---

## Option B — `curl | sh` bootstrap (no npm)

For machines without npm, or to register many existing repos at once, use the
bundled `install.sh`. It scans a directory for git repos, detects their tech
stacks, registers them with the framework, and starts the management hub.

```bash
# Inspect first (always read a remote script before piping to a shell):
curl -fsSL https://raw.githubusercontent.com/knofler/ai_management/main/install.sh -o install.sh
less install.sh

# Run it against a directory of projects:
bash install.sh ~/path/to/projects
```

One-liner (only after you've reviewed the script you trust):

```bash
curl -fsSL https://raw.githubusercontent.com/knofler/ai_management/main/install.sh | bash -s -- ~/path/to/projects
```

Useful flags:

| Flag | Effect |
|---|---|
| `--dry-run` | Show what would happen, make no changes |
| `--yes` | Auto-confirm all prompts (non-interactive) |
| `--skip-docker` | Register repos but don't start the Docker stack |
| `--max-depth N` | Repo-scan depth (default 4) |
| `--help` | Usage |

---

## What gets installed

The package is **clean-room**: it contains the framework only — never operator
context. Shipped: the `myai` bin, agents, skills, hooks, scripts, templates, the
runtime gateway + dashboard sources, the portable `docker-compose.yml`, docs,
and `*.example` configs. **Excluded** (by both the `package.json` `files`
allowlist and `scripts/publish_guard.sh`): `state/`, `plan/`, `memory/`,
`logs/`, `LL/`, `SHOWCASE.md`, `CLAUDE.md`, `.env`, and any managed-repo lists.

## Verifying an install

```bash
myai doctor          # node, docker (+engine), compose, git, key, ports, files
myai --help          # command list
```

## Updating

```bash
npm update -g ai-management     # npm path
# curl|sh path: re-run install.sh; it is idempotent and skips already-registered repos
```

## Uninstalling

```bash
myai down --volumes                       # stop stack + drop data volume
npm uninstall -g ai-management   # remove the CLI
```

See `CHANGELOG.md` for version history and `documentation/RELEASE.md` for the
publish runbook.

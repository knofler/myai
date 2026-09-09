# MACHINE_SETUP.md — blank Mac to fleet-ready

The runbook for a machine swap. Pairs with `scripts/bootstrap_mac.sh` (does the
work) and `config/machine_manifest.txt` (says what to install).

**Read this once end-to-end before you start.** The order matters in two
places: Dropbox must finish syncing before the repo stage, and the SSH keys must
be registered with GitHub before the clone.

> **Related, and deliberately separate:**
> `MULTI_MACHINE_WORKFLOW.md` — what to do when you *switch between* two
> already-set-up Macs. `MULTI_ORG_WORKFLOW.md` — day-to-day use of the three
> Claude accounts. This file covers only the one-time build-out of a new box.

---

## 0. The 30-second version

On the new Mac, in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/knofler/ai_management/main/scripts/bootstrap_mac.sh -o /tmp/bootstrap_mac.sh
bash /tmp/bootstrap_mac.sh
```

It installs the base layer (Xcode CLT → Homebrew → shell → SSH → git), clones
`ai_management`, then re-execs itself from the clone to finish the
manifest-driven stages. It prompts before anything slow and prints an
**OPERATOR TODO** list of the things a script genuinely cannot do for you
(browser logins, MDM apps, secrets).

Preview without changing anything:

```bash
bash /tmp/bootstrap_mac.sh --dry-run
```

Expect to run it **more than once** — the Xcode CLT installer and the Dropbox
initial sync both hand control back to a GUI. Re-running is safe and cheap;
every stage checks before it acts.

---

## 1. What you must do by hand FIRST

A script cannot log into your identity provider or click through an MDM portal.
Do these before anything else:

| # | Do this | Why it must be first |
|---|---------|----------------------|
| 1 | Sign into the Mac with your corporate account; let Jamf/MDM finish enrolling | Self Service is where the corporate apps come from |
| 2 | **Install Dropbox and let the initial sync COMPLETE** | The whole workspace (your `$MYAI_WORKSPACE` root — a Dropbox-synced folder in the fleet setup) lives in it. Cloning before the sync settles produces conflicted copies you then have to triage |
| 3 | Install Xcode from the Mac App Store *(only if you build iOS/macOS apps)* | Large download; start it early and let it run in the background |
| 4 | Have your password manager open | `.env` files and API keys are gitignored by design and cannot be restored from the repo |

**Do not** copy `~/.ssh` private keys across by casually zipping them. Either
move them over an encrypted channel you trust, or let the script generate fresh
ed25519 keys and register the new public keys — that is the cleaner path and
what the script does by default.

---

## 2. The stages

`bootstrap_mac.sh` runs these in order. Run one on its own with
`--only <stage>`, or skip one with `--skip <stage>`.

| Stage | What it does |
|-------|--------------|
| `preflight` | Reports arch, macOS version, bash version, Dropbox presence |
| `xcode` | Triggers the Command Line Tools installer; flags an unaccepted Xcode licence |
| `brew` | Installs Homebrew, wires `brew shellenv` into `~/.zprofile` |
| `formulae` | Installs every `[brew_formula]` + `[brew_tap]` from the manifest |
| `casks` | Installs `[brew_cask]`; **skips anything already in /Applications** so it does not fight Jamf. Then reports `[app_manual]` |
| `node` | Checks the Node major, repairs the npm prefix, installs `[npm_global]` |
| `shell` | `~/.local/bin` on PATH, direnv hook, project `.env` autoload |
| `ssh` | Generates any missing `[ssh_key]`, prints the public keys, writes a `github.com` block into `~/.ssh/config` |
| `git` | Verifies git identity, `gh auth`, gh-as-credential-helper, `az login` |
| `repo` | Creates the workspace, clones `ai_management`, installs the repo's git hooks |
| `claude` | Installs the Claude Code CLI, then hands off to `setup_org_dirs.sh` for the three accounts |
| `myai` | Verifies the `myai` CLI + Docker, then hands off to `myai setup --machine` |
| `editors` | Restores the `[vscode_ext]` VS Code extensions |
| `verify` | Final doctor: every expected binary, the Docker daemon, the gateway health endpoint |

### Why it hands off instead of reimplementing

The repo already owns the *arrival* logic, and duplicating it is how two copies
drift apart:

- `scripts/setup_org_dirs.sh` — the three Claude config dirs + shell aliases
- `scripts/myai_setup_machine.sh` — Dropbox conflict sweep, npm prefix, git
  metadata repair, runner registration, Docker rebuild
- `scripts/restore_git_metadata.sh` — re-attaches `.git` when Dropbox eats it
- `scripts/install_git_hooks.sh` — the `pre-push` local-CI gate

`bootstrap_mac.sh` is only the layer *below* these: the layer that makes
Homebrew, Node, Docker and a clone exist in the first place.

---

## 3. The manifest is the source of truth

`config/machine_manifest.txt` is **data, not code**. It holds the brew formulae
and casks, the global npm packages, the VS Code extensions, the SSH keys this
machine should hold, the Claude profiles, and the apps no package manager owns.

Refresh it from whichever machine is currently known-good:

```bash
./scripts/bootstrap_mac.sh --scan     # rewrites the manifest from THIS machine
git diff config/machine_manifest.txt  # review
git add config/machine_manifest.txt && git commit -m "chore(machine): refresh manifest from <host>"
```

`--scan` regenerates the machine-derivable sections and **carries the
hand-written ones through verbatim** (`[app_manual]`, `[ssh_key]`,
`[claude_profile]`) — a scan cannot infer intent, only inventory.

**Do this after any significant tooling change.** That habit is the difference
between an ongoing migration tool and a snapshot of one afternoon.

### Pins that are deliberate

- **`node`** (unpinned) — the host gets the *current* release. See below.
- **`jq`** — macOS 15 still ships `/usr/bin/jq`, but every session hook depends
  on it. It is installed explicitly so a future macOS that drops it does not
  silently break the hook layer.
- **`mongosh`** — arrives as a dependency of `mongodb-atlas-cli`, but the fleet
  scripts call it directly, so it is listed in its own right.

### Node: host and containers move separately, on purpose

Two Node versions are in play. Conflating them causes needless churn.

| | Version | Set by | What runs on it |
|---|---|---|---|
| **Host** | *current* (unpinned `node`) | `config/machine_manifest.txt` | only the global CLIs: `myai`, `vercel`, `gemini-cli`, `copilot`, `aws-cdk` |
| **Containers** | pinned per Dockerfile | `runtime/`, `dashboard/`, `mcp/`, `templates/blueprint/` | the gateway, the dashboard build, everything real |

The host is deliberately unpinned so **a new Mac always gets the latest Node**.
That is safe because nothing here builds or runs on the host — the standing rule
is `docker compose exec app <command>`, never `npm`/`node` directly. `engines`
declares `>=20`, a floor with no ceiling.

The containers are the version-locked half, and they only move when someone
edits a `FROM` line. `bootstrap_mac.sh --verify` compares the two and warns when
the containers have fallen behind the host, so the drift is visible instead of
silent.

Both halves are checked on every run:

```
--only node   host Node vs what brew ships today, plus every stale global npm package
--verify      container base images vs the host major
```

### The npm-prefix trap — read this before debugging a stale `myai`

The single highest-consequence failure this kit exists to prevent, because it
presents as "everything looks fine":

> `npm config get prefix` pointed at a root-owned `/usr/local`, while the `myai`
> on `PATH` resolved to `~/.local/lib/node_modules`. So `npm i -g ai-management`
> both failed with EACCES **and** would have installed to a directory `PATH`
> never looks at. The module sat at 0.6.4 while 0.8.0 was published — four
> releases.

That matters far beyond one stale CLI. Under the **kernel model**, a repo
carrying only a 30-line `CLAUDE.md` resolves *all* of its agents, skills, hooks
and rule bodies at runtime from the globally-installed module (`myai root`). One
stale global silently degrades **every kernel repo on the machine at once**.

`bootstrap_mac.sh` now runs `npm_prefix_preflight.sh --fix` (not check-only), so
a new Mac cannot reach that state, and the `node` stage reports any global
package that has a newer version available.

Fix it by hand with:

```bash
./scripts/npm_prefix_preflight.sh --fix   # repoints the prefix to ~/.local
npm i -g ai-management
myai --version
```

---

## 4. The three Claude accounts

Three separate accounts, three separate config dirs. **Auth is per
`CLAUDE_CONFIG_DIR`** — logging into one does not log into the others, and that
isolation is the point: enterprise, team and personal history/settings/billing
never mix.

| Alias | `CLAUDE_CONFIG_DIR` | Account |
|-------|--------------------|---------|
| `claude` | `~/.claude` | bare default (whichever is primary) |
| `claude-museum` | `~/.claude-museum` | Powerhouse Museum (Enterprise) |
| `claude-tech` | `~/.claude-tech` | Powerhouse Technology (Team) |
| `claude-personal` | `~/.claude-personal` | personal, pinned |

`scripts/setup_org_dirs.sh` creates the dirs and installs the aliases into
`~/.zshrc` inside a managed, idempotent block. It does **not** log you in.

Then, once per account, in its own shell:

```bash
claude-museum      # then: /login  → browser → pick the Museum account
claude-tech        # then: /login  → browser → pick the Technology account
claude-personal    # then: /login  → browser → pick the personal account
```

Verify with `/status` in each — the org name in the status line should match the
alias you launched.

**Which one to use:** the fleet's autonomous/remote sessions run on
`claude-museum` (see `remote_fleet.sh`, which only ever starts museum sessions).
Interactive fleet work also runs there. Keep `claude-personal` for anything not
Powerhouse work.

> **Cost note.** Per the standing slow-burn policy: the runner is Sonnet-only,
> the museum org is interactive-only, and no fan-outs or marathons without
> asking first. A fresh machine with all three accounts logged in makes it easy
> to accidentally spend on the wrong one.

---

## 5. Starting myAI on the new machine

Once the repo is cloned and Docker is running:

```bash
cd "$MYAI_WORKSPACE/AI"   # your workspace root (set by the 'repo' stage; default $HOME/_MY_PROJECT)

# 1. Restore the environment. Nothing can recreate this for you.
cp .env.example .env    # then fill it in from your password manager

# 2. Arrival heal — Dropbox conflicts, npm prefix, git metadata, runner, docker.
#    Report-only by default; --yes also installs the runner and rebuilds Docker.
./scripts/myai_setup_machine.sh
./scripts/myai_setup_machine.sh --yes

# 3. Bring the stack up.
docker compose up -d --build

# 4. Confirm.
curl -s localhost:3100/health          # gateway
open http://localhost:3210             # dashboard
```

Containers use the folder name as prefix: `myai-gateway`, `myai-dashboard`,
`myai-mongo`, `myai-gh-runner`.

| Port | Service |
|------|---------|
| 3100 | myAI gateway (MCP + REST) |
| 3210 | dashboard (`/fleet`, `/schedule`, `/plan`, `/directory`) |

### The autonomous runner

`myai setup --machine --yes` registers the launchd CLI runner
(`~/Library/LaunchAgents/com.myai.cli-task-runner.plist`). It works the queued
task list on the free window. Check it with:

```bash
launchctl list | grep myai
bash hooks/session/17-schedule-status.sh    # the SCHEDULE banner
```

---

## 6. Working with `ai_management`

Open Claude Code in the repo directory and type a keyword. The repo is
self-contained: agents, skills, hooks, state and docs all travel with it.

```bash
cd "$MYAI_WORKSPACE/AI"   # your workspace root (set by the 'repo' stage; default $HOME/_MY_PROJECT)
claude-museum
```

Then:

| Keyword | What it does |
|---------|--------------|
| `agent mode -min` | Fast session start — sync, brain boot, report. Under a minute |
| `agent mode` | Full start — adds Docker checks, branch merges, lessons-learned scan, agent dispatch |
| `agent mode -resume` | Join and continue the last scheduled/headless run for this repo |
| `ship it` | Commit → push `test` → CI → PR → merge `main` |
| `wrap up` | Session close: state, handoff, brain atom, dashboard banner |
| `hello` | Print the full keyword table |

The non-negotiables, in short: **never push directly to `main`** (everything
goes `test` → PR → `main`), and **never run `npm`/`node` on the host** — use
`docker compose exec app <command>`. The full set is in `CLAUDE.md`, which
Claude Code reads automatically at startup.

**Continuity across machines** is the brain, not the files. Each session boots a
diff-only catch-up (`brain_delta`) from the gateway and `wrap up` appends one
session atom. The state files are the offline fallback for when the gateway is
unreachable. This is why a new machine needs the gateway up before it is really
"ready" — without it, sessions boot blind.

---

## 7. Secrets checklist — nothing here is in git

Restore these by hand. The script flags them but cannot fetch them.

- [ ] `AI/.env` — gateway, Atlas, and provider keys
- [ ] `.env` in each managed repo you work on
- [ ] `gh auth login` — GitHub
- [ ] `az login` — Azure
- [ ] SSH public keys registered: GitHub (Settings → SSH keys), Azure DevOps
- [ ] Claude `/login` × 3 accounts
- [ ] MongoDB Atlas access (`atlas auth login`) if you touch the cluster
- [ ] Vercel (`vercel login`) if you deploy frontends
- [ ] Dropbox signed in and synced

---

## 8. When something is wrong

| Symptom | Fix |
|---------|-----|
| `npm i -g` fails with EACCES | `./scripts/npm_prefix_preflight.sh` — root-owned npm prefix, the most common day-one failure |
| A repo has no `.git` after Dropbox sync | `./scripts/restore_git_metadata.sh` — **do not** delete and re-clone, there may be uncommitted work |
| Conflicted-copy files everywhere | `./scripts/dropbox_conflicts.sh --list` then `--diff`; `--clean-identical` is safe, `--clean-all` needs `--yes` |
| Gateway up but serving old code | It self-heals at session start (`hooks/session/28-gateway-freshness.sh`). Force it: `./scripts/gateway_ensure.sh` |
| Brain diverged between Macs | It self-heals at session start (`hooks/session/22a-brain-converge.sh`). Only escalates when real session atoms conflict |
| Session hooks silently do nothing | Check `jq` is installed — most hooks parse their input with it |
| `node` is stale or ambiguous | `brew upgrade node`. If two installs are on PATH, `bootstrap_mac.sh --only node` names both and which one wins |
| `myai` stuck on an old version | The npm-prefix trap — see §3. `./scripts/npm_prefix_preflight.sh --fix` then `npm i -g ai-management` |
| Docker naming looks wrong | Containers must be `myai-*`. `docker compose down`, fix `container_name`, `up -d --build` |

Deeper procedures — disk-full mongo crash-loop, Atlas unreachable, blocked-task
pileup, billing-blocked merges — are in `documentation/RUNBOOK.md`, one
copy-pasteable procedure per failure mode.

---

## 9. Keeping this file honest

This runbook and the manifest are only worth having if they stay true. After the
next machine swap, or any significant tooling change:

1. `./scripts/bootstrap_mac.sh --scan` and commit the manifest diff.
2. Fix anything in §1–§7 that turned out to be wrong or missing — especially the
   manual steps, which are the ones that bite.
3. `bash scripts/tests/test_bootstrap_mac.sh` must stay green.

_Captured from work-desktop (macOS 15.7.4, arm64), 2026-08-31._

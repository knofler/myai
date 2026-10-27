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

## New Mac, fast path — keyword `new mac`

Brew, Docker, git and node already installed? Open `claude` in this repo and type
`new mac`. It runs `scripts/new_mac_setup.sh` (`--check` first = report only).
Skips anything already done, never stops on a failure, and prints a
"YOU NEED TO DO" list at the end. Order:

| # | Step | Done by |
|---|------|---------|
| 0 | Check brew / git / node / docker / python3; install only `gh jq tmux` if missing | script |
| 1 | myAI: `npm i -g ai-management` (if missing or outdated), `~/.myai/.env` gateway token from the repo `.env`, connect the EXISTING brain `<owner>/myai-brain` | script |
| 2 | Claude profiles: `~/.claude-<master-profile>` `~/.claude-<runner-profile>` `~/.claude-<personal-profile>` + aliases, import the old Mac's bundle (`claude_profiles_transfer.sh export` there first) | script |
| 3 | Restore any missing `.git`, `git fetch` every repo in `config/managed_repos.txt` | script |
| 4 | Stack: `docker compose up -d --build` only if not already running HEAD | script |
| 5 | Brain sync (`resync.sh`) + fleet MCP converge and handshake | script |
| 6 | **Remote Control on in every profile** (`remoteControlAtStartup: true`) | script |
| 6 | **No sleep on the charger** — `sudo pmset -c sleep 0 disksleep 0 displaysleep 30 womp 1 autorestart 1 powernap 1` (screen still sleeps; auto-restart after power loss) | **you** (needs password) |
| 6b | **Power-aware lid-close guard** — `sudo bash AI/scripts/sleep_guard.sh --install-daemon` (root daemon runs a root-owned copy every 60s: on AC `disablesleep 1`, so lid close never sleeps; on battery `disablesleep 0`, so macOS sleeps on lid close natively — the 2026-10-21 fix for a Mac running hot in a bag, never deciding on the lid since 2026-10-23 (the clamshell probe read "open" all night and the Mac drained); a lid still closed on battery after 5 min is put to sleep as a backstop for a close that lands before the guard's next tick; `sudo … --stay-awake 2h` keeps it awake, max 12h; screen still locks). Row 6 alone does NOT cover lid close/battery — office-mac slept on every lid close until 2026-10-02 because only row 6 was done. Verify: `scripts/sleep_guard.sh --check` rc 0 | **you** (needs password) |
| 7 | `gh auth login` if the brain clone or fetch needs it | **you** |
| 8 | `source ~/.zshrc`; `/login` once in `claude-<master-profile>`, `claude-<runner-profile>`, `claude-<personal-profile>` (Remote Control needs a claude.ai login) | **you** |
| 9 | 08:00 boot launchd agent (`setup_boot_schedule.sh`) — `boot_machines.txt` is universal `*:0-6`, no host line needed | script |
| 10 | **Bruno + MongoDB Compass in one go:** `./scripts/dev_apps.sh` — installs either if missing, registers every `api_management/bruno` collection (`setup_bruno.sh`), imports Compass connections (old Mac first: `./scripts/dev_apps.sh export` — no passwords exported; re-enter each once), opens both. `--check` = report only | script (+ you: passwords) |
| 11 | Restart `claude`, type `agent mode -min` | **you** |

The full blank-Mac path (Xcode, casks, editors) is `bootstrap_mac.sh` below — not
needed for a Mac that already has the basics.

---

## 0. The 30-second version

On the new Mac, in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/bootstrap_mac.sh -o /tmp/bootstrap_mac.sh
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
| `profiles` | Imports the old Mac's profile bundle (settings, auto-memory, skills, plugins, user MCP servers — never logins) via `claude_profiles_transfer.sh import`, then turns Remote Control on in every profile |
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
| `claude-<master-profile>` | `~/.claude-<master-profile>` | work org (Enterprise) |
| `claude-<runner-profile>` | `~/.claude-<runner-profile>` | work org (Team) |
| `claude-<personal-profile>` | `~/.claude-<personal-profile>` | personal, pinned |

`scripts/setup_org_dirs.sh` creates the dirs and installs the aliases into
`~/.zshrc` inside a managed, idempotent block. It does **not** log you in.

Then, once per account, in its own shell:

```bash
claude-<master-profile>      # then: /login  → browser → pick the Enterprise account
claude-<runner-profile>        # then: /login  → browser → pick the Team account
claude-<personal-profile>    # then: /login  → browser → pick the personal account
```

Verify with `/status` in each — the org name in the status line should match the
alias you launched.

### Antigravity (`agy`) — the fourth lane, one keyword

`agy` in any repo starts Antigravity the same way `claude-<runner-profile>` starts Claude:
**in the current iTerm tab** (never a hidden tmux session — operator direction
2026-10-03), bypass mode, Remote Control on, and the myAI **agy profile** loaded
(`MYAI_SESSION_PROFILE=agy`, so mail/registry helpers agy runs address it as
`<host>/agy`). Not installed by any script yet — add this block to `~/.zshrc`
by hand on a new Mac (after the Antigravity CLI installer has put `agy` on PATH):

```bash
# >>> antigravity defaults (bypass permissions & remote control by default) >>>
agy() {
  case "${1:-}" in
    agent|agents|changelog|help|install|mcp|mic-serve|models|plugin|plugins|remote-control|update|-h|--help|-v|--version)
      command agy "$@"
      ;;
    *)
      # --remote-control-name is undocumented (found in the agy binary, verified
      # 2026-10-03): names this session's RC instance "<device> - <repo>".
      local _repo; _repo="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
      MYAI_SESSION_PROFILE=agy command agy --dangerously-skip-permissions --remote-control \
        --remote-control-name "$(hostname -s) - $_repo" "$@"
      ;;
  esac
}
# <<< antigravity defaults <<<
```

Then `agy` (start idle), `agy -i boot` (start and boot) or `agy -c` (rejoin the
last conversation). Sign in once with the Google account agy uses. Quit with `/quit`.

**Remote Control naming** (antigravity.google.com): the always-on daemon is the
machine entry, named with the bare host — once per Mac:
`agy remote-control start --name "$(hostname -s)"`. Each `agy` session adds its
own entry `<host> - <repo>` and drops it when it quits. Never rename the daemon
to a repo name.

### Carrying the profiles to a new Mac

The dirs live in `$HOME`, outside Dropbox, so a new Mac gets them **empty**:
no settings, no auto-memory, no plugins, no Remote Control. Move the config (never
the logins) with `scripts/claude_profiles_transfer.sh`:

```bash
# OLD Mac — writes ../.machine-transfer/claude-profiles-<host>-<ts>.tar.gz
# (next to the repo in the Dropbox workspace, outside git, mode 0600)
./scripts/claude_profiles_transfer.sh export

# NEW Mac — once Dropbox has synced; the bootstrap 'profiles' stage does this
./scripts/claude_profiles_transfer.sh import      # newest bundle; re-run = no-op
./scripts/claude_profiles_transfer.sh status      # remoteControl / memory / imported per profile
```

Moves: `settings*.json`, `CLAUDE.md`, `keybindings.json`, `agents/ commands/
skills/ hooks/ output-styles/ plugins/`, `projects/*/memory/`, and the
`mcpServers` of `.claude.json`. Old-`$HOME` paths and memory slugs are re-keyed,
so a different username still lands. Whatever an import replaces goes to
`<profile>/.pre-import-<ts>/`. Logins, history, sessions and transcripts stay
behind — `/login` each profile once afterwards.

**Remote Control** is `remoteControlAtStartup: true` in each profile's
`settings.json`; `import` and `claude_profiles_transfer.sh remote-control` set it
everywhere. It needs a claude.ai login, not an API key. The 08:00 boot and its
master doorway are universal — `config/boot_machines.txt` is `*:0-6`, so a new
Mac needs no host line; `boot_sync.sh` installs its launchd agent at the first
session (or run `./scripts/setup_boot_schedule.sh`).

**Which one to use:** the fleet's autonomous/remote sessions run on
`claude-<master-profile>` (see `remote_fleet.sh`, which only ever starts master sessions).
Interactive fleet work also runs there. Keep `claude-<personal-profile>` for anything not
work-org work.

> **Cost note.** Per the standing slow-burn policy: the runner is Sonnet-only,
> the master profile's org is interactive-only, and no fan-outs or marathons without
> asking first. A fresh machine with all three accounts logged in makes it easy
> to accidentally spend on the wrong one.

---

## 5. Starting myAI on the new machine

Once the repo is cloned and Docker is running:

```bash
cd "$MYAI_WORKSPACE/AI"   # your workspace root (set by the 'repo' stage; default: the parent of the checkout you ran it from)

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
`myai-mongo`, and one `myai-gh-runner-<repo>[-N]` per self-hosted CI runner
(slots of the same `myai` project — `scripts/runner_selfhosted.sh list`).

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
cd "$MYAI_WORKSPACE/AI"   # your workspace root (set by the 'repo' stage; default: the parent of the checkout you ran it from)
claude-<master-profile>
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
| Conflicted-copy files everywhere | `./scripts/dropbox_conflicts.sh --clean-safe` removes every copy it can prove lossless (identical · content already in git · regenerated snapshot per `config/dropbox_conflict_policy.txt` · append-only log merged); then `--list` / `--diff` for what is left; `--clean-all` needs `--yes` |
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

_Captured from one office Mac (macOS 15.7.4, arm64), 2026-08-31._

---

## 10. Local models (office-mac, 2026-10-02)

| Model | Role | Size | Speed | Notes |
|-------|------|------|-------|-------|
| `qwen3-coder:30b` | Coder | 18 GB on disk / ~21 GB loaded at 32k context | ~94 tok/s | |
| `gpt-oss:20b` | Reasoning + tools | 13 GB | ~62 tok/s | Use low reasoning for short jobs |
| `qwen3:8b` | Fast small | 5.2 GB | ~47 tok/s | |
| `nomic-embed-text` | Embeddings | 0.3 GB | — | 768 dims |

Models run natively on the Mac GPU via the Ollama app (not in Docker), load on demand and unload after 5 min idle; Ollama's "Expose to network" should stay OFF.

### 10.1 The qwen swarm lane (office-mac)

`qwen3:8b` can't drive tools reliably, so the qwen lane is a **job runner**, not an agent:
`scripts/qwen_lane.sh` reads the files, asks the model once (no tools), and always
mails the answer or the failure back to whoever queued the job.

| What | How |
|------|-----|
| Queue a job (from any session) | `scripts/qwen_job.sh --files 'state/boot/BOOT_REPORT.*.md' --prompt "…"` — the reply comes back to your mailbox |
| Runner (headless, survives reboot + crash) | `scripts/qwen_lane.sh install-agent` → LaunchAgent `com.myai.qwen-lane` (KeepAlive), log `~/.myai/logs/qwen_lane.log` |
| See it inside the `claude-qwen` chat | `scripts/qwen_lane.sh install-statusline` → statusLine in `~/.claude-qwen/settings.json`: `qwen lane: idle · last job 6s ago from personal (done)` / `working on job from tech (12s)` / `paused — on battery` / `DOWN` |
| Check it | `scripts/qwen_lane.sh status` |
| Quiet Ollama env (reboot-proof) | `scripts/setup_ollama_env.sh --install` → LaunchAgent `com.myai.ollama-env` (`CONTEXT_LENGTH=65536 NUM_PARALLEL=1 MAX_LOADED_MODELS=1 KEEP_ALIVE=5m`); restart Ollama.app once after a change |

The operator's qwen tab stays the `claude-qwen` chat; the runner never needs a tab.
It runs one job at a time, pauses on battery or when macOS records a thermal warning,
and cools down between jobs. All three LaunchAgents/settings are **this Mac only**:
journal each install with `scripts/config_journal.sh note`. Treat model answers as a first pass.

## 11. Fleet roles — one coordinator, config by role (2026-10-05)

Config is by **role**, never by hostname: `config/fleet_roles.txt` maps hosts → roles
(`office`, `home`, `spare`; several hosts per role is fine) → a resource profile, plus the
coordinator schedule. Plan: `plan/MULTI_MAC_SWARM_BRIEF.md`.

| What | How |
|------|-----|
| See this Mac's role | `scripts/fleet_role.sh` (role, profile, who coordinates now, runner gate, local LLM, fleet DB) |
| New Mac joins | add its host to the right `role` line in `config/fleet_roles.txt` and commit; before that, `scripts/fleet_role.sh set office` sets a machine-local override |
| Coordinator | ONE fleet-wide lease `swarm-coordinator:fleet`. Schedule: office Mon–Thu 09–18, home Fri, otherwise open. `swarm master take` on an off-schedule Mac needs `--force` (the override). A live holder of the old per-host key migrates on its next tick. |
| Runner (until phase 3) | only `runner_host` hosts fire; other Macs' runners stay installed and idle |
| Home (16 GB) | identical to office except the `lean` profile: no local LLM at all (qwen lane / Ollama env refuse; qwen jobs go to an office Mac), smaller gateway / gh-runner / Docker VM / worker sizes |
| Shared DB | boot FAILs a Mac whose gateway isn't on `fleet_db` (a split DB = two coordinators) |

A host in no role is `unassigned` and behaves exactly as before (per-host swarm key,
runner unrestricted). office-mac stays `office` until the operator reassigns it.

## 12. Account usage ledger — real quota across both Macs (2026-10-05)

Every account (one per lane's profile) has its own 5-hour and weekly limit, shared by
both Macs. The ledger lives in the shared Atlas DB (gateway tools `account_usage_record` /
`account_usage_status`).

| Input | Where it comes from |
|-------|---------------------|
| **Real %** (best) | Claude Code's statusLine payload carries `rate_limits.five_hour/seven_day` (`used_percentage`, `resets_at`); `scripts/org-statusline.sh` saves it to `~/.myai/usage-live/<account>.json` whenever a session for that account is open. agy writes `~/.myai/agy-statusline-last.json`. |
| Token buckets | `scripts/usage_push.sh` (every runner tick, on every Mac, before any gate): hourly totals per account × model from this Mac's transcripts, **deduped by message.id** (Claude Code repeats usage on every content-block line). |
| Operator readings | Only for what the statusLine lacks — the per-model weekly rows (Fable-only / Opus-only). |

**See it:** `scripts/usage_reading.sh status` (also in `swarm master who`): per account 5h % ·
weekly % · source (`real` ≤15 min old · `anchored` = last real % + fitted cost of tokens since ·
`estimate` · `unknown`) · headroom after the interactive reserve (33% weekly / 40% 5h) ·
`IN USE` · flags · recommendations.

**Give a reading** (about once a week per account): in that account's profile type `/usage`, then

```
scripts/usage_reading.sh add tech 5h=3 week=20 fable=5 opus=12
```

**Assets** (recommendations only — nothing is ever triggered):
`scripts/usage_reading.sh asset personal full_reset expires=2026-10-23` ·
`… asset personal cloud_credit usd=100 expires=2026-11-05` ·
`… asset personal spend_flag note="usage credits on, no monthly limit"`.

Each account keeps its **own** reset times (tech's week Sat→Sat, personal's Mon→Mon).

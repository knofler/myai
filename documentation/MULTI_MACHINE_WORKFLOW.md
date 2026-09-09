# Multi-Machine Workflow (Dropbox Sync)

> The developer works across multiple machines (e.g. a work desktop and a home laptop) with the codebase synced via Dropbox. This creates specific challenges that every AI agent and the developer must handle on session start.

> **Setting up a BRAND NEW Mac?** This file assumes the machine is already
> built — Homebrew, Node, Docker, a clone, the Claude accounts. For a blank box,
> start at **`documentation/MACHINE_SETUP.md`** (`scripts/bootstrap_mac.sh` +
> `config/machine_manifest.txt`), which installs that layer and then hands off
> to `myai setup --machine` below.

---

## THE machine-arrival command

**`myai setup --machine` is the one command that replaces the whole manual checklist below.** Run it the moment you sit down at a Mac that's been away for a while — before Docker, before `git status`, before anything else:

```bash
myai setup --machine            # idempotent: applies the safe fixes, reports the rest
myai setup --machine --dry-run  # report only, write nothing
myai setup --machine --yes      # also installs the runner + rebuilds the Docker stack
myai setup --machine --json     # machine-readable report (fixed / ok / needsOperator / skipped)
```

In one pass it: cleans Dropbox conflicted-copy files, checks `.git` re-attachment across the whole repo fleet (`config/managed_repos.txt`), validates/rebuilds this repo's Docker stack (only ever on a detected master checkout — never a `ci-workspaces` clone, and only with `--rebuild-docker`/`--yes`), fixes an unwritable npm global prefix, checks/installs this machine's autonomous runner registration (`--install-runner`/`--yes`), and runs the general `machine_selfheal.sh` pass (Docker credsStore hangs, gateway split-brain, brain remote wiring, git-hooks). It ends with a report split into **fixed** / **ok** / **needs operator** (e.g. `sudo chown -R $(whoami) $(npm config get prefix)`, or a `restore_git_metadata.sh --apply` command for a repo whose remote couldn't be resolved) / **skipped** — never silent about what it couldn't do itself. Exits non-zero when anything still needs you. See `scripts/myai_setup_machine.sh -h` for every flag; `scripts/tests/test_myai_setup_machine.sh` covers it hermetically.

Everything below this section is the manual reference the command automates — read it to understand *why* each step exists, or to run a piece of it by hand when you want finer-grained control than the one-shot command gives you.

---

## The Problem

1. **Stale Docker containers**: Code syncs via Dropbox but Docker containers on the other machine still run the old build. The app serves outdated code until containers are rebuilt.
2. **Dropbox conflict files**: When both machines edit the same file (or Dropbox syncs mid-write), Dropbox creates `(Machine's conflicted copy YYYY-MM-DD)` duplicates. These pollute the repo.
3. **Git state divergence**: The `.git` directory syncs via Dropbox, which can cause lock files, stale refs, or index corruption.
4. **node_modules / .next cache**: These directories may contain platform-specific binaries (darwin vs linux) that break when synced.

---

## Mandatory: Session Start Checklist (Every Machine Switch)

Run these steps **every time** you start work on a different machine from where the last session ended. AI agents must execute this automatically on `session start` or `agent mode`.

### Step 1: Wait for Dropbox Sync

```bash
# Check Dropbox sync status (macOS)
dropbox status 2>/dev/null || echo "Check Dropbox icon in menu bar — wait for 'Up to date'"
```

**Do NOT start work until Dropbox shows "Up to date".** Starting with a partial sync will create conflicts.

### Step 2: Clean Dropbox Conflict Files

```bash
# Find and count conflicts
find . -name "*conflicted*" -o -name "* (1)*" -o -name "* (2)*" 2>/dev/null | wc -l

# Review them (always review before deleting)
find . -name "*conflicted*" -o -name "* (1)*" -o -name "* (2)*" 2>/dev/null

# Delete all (safe — originals are always the non-suffixed files)
find . -name "*conflicted*" -delete 2>/dev/null
```

### Step 3: Fix Git State

```bash
# Remove stale lock files
rm -f .git/index.lock .git/refs/heads/*.lock 2>/dev/null

# Verify git is healthy
git status
git log --oneline -3
```

If `git status` shows unexpected changes or errors, run:
```bash
git checkout -- .  # Only if you're sure all changes were committed last session
```

### Step 3b: Fleet-Wide `.git` Preflight (MANDATORY, automatic)

Step 3 above only checks the *current* repo. A machine that has been away for a
while can come back with `.git` missing from other repos in the fleet entirely
(Dropbox purges `.git` as a sync-config change when the ignore-flag policy
sweeps a folder — see `scripts/restore_git_metadata.sh`'s header for the
2026-08-27 incident this guards against). That must be caught **at boot**, not
discovered hours into a session on an unrelated repo.

`hooks/session/26-git-fleet-preflight.sh` runs this automatically on every
session start (dry-run only, never writes anything):

```bash
./scripts/restore_git_metadata.sh --fleet   # dry-run by default; no --apply
```

- **All repos attached** → the hook prints nothing. Boot stays quiet.
- **A repo is missing `.git`** → the hook names the repo and the exact fix
  command, e.g.:
  ```
  GIT FLEET PREFLIGHT: 1 repo(s) need attention (not discovered mid-session):
    · CONTENT_API — no .git, remote unresolved
        → fix: add "CONTENT_API  knofler/<repo>" to config/repo_remotes.txt, then: /…/scripts/restore_git_metadata.sh --apply "/…/CONTENT_API"
  ```
  Run the printed `--apply` command (adding a `config/repo_remotes.txt` mapping
  first if the remote could not be resolved) to re-attach it. Never runs
  `--apply` automatically — the working tree is preserved but the fix is always
  a manual, reviewed step.

### Step 4: Rebuild Docker Containers

**This is the critical step.** The Docker container has cached the old code. You must rebuild.

```bash
# For any project with Docker Compose
docker compose down
docker compose up -d --build

# Wait for healthy status
docker compose ps  # Should show "healthy"

# Verify the app is running with latest code
docker compose logs app --tail 20
```

**Why `--build` is required**: Docker Compose volumes mount the source code, but:
- `node_modules` inside the container may be stale (missing new packages)
- `.next` cache may reference deleted/renamed files
- The entrypoint script pre-compiles routes on startup — stale cache = stale routes

If you only need to refresh the code (no new packages), a restart may suffice:
```bash
docker compose restart app
# Then verify the app compiled the latest files:
docker compose logs app --tail 30
```

### Step 5: Verify Build

```bash
# Type check
docker compose exec app npx tsc --noEmit --pretty

# Quick health check
curl -s http://localhost:3400/api/health | jq .
```

### Step 6: Pull Latest Git State

```bash
git fetch origin
git log --oneline origin/main..HEAD   # Check if local is ahead
git log --oneline HEAD..origin/main   # Check if remote is ahead
```

If remote is ahead (changes pushed from the other machine):
```bash
git pull origin main
```

---

## When to Full Rebuild vs Restart

| Scenario | Action |
|----------|--------|
| Only code changes (same packages) | `docker compose restart app` |
| New npm packages added | `docker compose down && docker compose up -d --build` |
| New models/schemas added | Restart is fine (Mongoose auto-registers) |
| Docker Compose file changed | `docker compose down && docker compose up -d --build` |
| Env vars changed | `docker compose down && docker compose up -d` |
| Strange build errors | `docker compose down -v && docker compose up -d --build` (nuclear — rebuilds everything including volumes) |

---

## For AI Agents: Auto-Detection

When an AI agent starts a session (`session start`, `agent mode`, or `hello`), it MUST:

1. **Check the last session's machine** — compare the hostname in `AI_AGENT_HANDOFF.md` or `claude_log.md` with the current hostname (`hostname` command).
2. **If different machine** — execute the full checklist above before any other work.
3. **If same machine** — skip to normal session start, but still check for Dropbox conflicts.

### Hostname Detection

```bash
# Get current machine name
hostname -s
# e.g. "work-desktop" or "home-laptop" (whatever `hostname -s` returns on each machine)
```

Agents should log the hostname in `claude_log.md` on every session start so the next session can compare.

---

## Session Close: Machine Handoff

When closing a session, the agent MUST:

1. **Ensure all changes are committed and pushed** — the other machine gets code via both Dropbox AND git. Git is the authoritative source; Dropbox is the fast sync.
2. **Log the current hostname** in `AI_AGENT_HANDOFF.md`:
   ```
   > Last machine: work-desktop
   ```
3. **Stop Docker containers** (optional but recommended to prevent port conflicts and stale state):
   ```bash
   docker compose stop
   ```

---

## Dropbox .gitignore Best Practices

Ensure these are in `.gitignore` to reduce Dropbox sync noise:

```
node_modules/
.next/
*.lock
.git/gk/
```

The `.git/gk/` directory (GitKraken) is the biggest offender for Dropbox conflicts — 67 conflict files were cleaned up in the 2026-03-23 session.

---

## Root Cause + Durable Fix (DEVOPS, 2026-07-20)

Nearly every session across ai_management, agentFlow, connect, and playground was independently cleaning 3-5 conflicted-copy files (CLAUDE.md variants, `AI/scripts/*`, hook scripts) — always ad hoc, never at the source. Investigation found the actual write pattern:

**Root cause:** every path in `config/managed_repos.txt` lives under a cloud-synced directory — the sync client mirrors the working tree itself, not just what git tracks. `scripts/update_all.sh` used to `cp -v`/`cp -r` CLAUDE.md, `hooks/`, `AI/scripts/*`, `agents/`, `skills/` into every managed repo **unconditionally, every run**, whether or not the content had changed. When two machines synced within the same Dropbox propagation window (the autonomous CLI runner on one Mac + an interactive session on another, or two Macs both running `wrap up`/`ship it` around the same time), both touched the same destination paths — and Dropbox's conflict reconciliation can't distinguish "two machines editing the same bytes" from "two machines innocently re-writing identical bytes," so it defensively spins up `<file> (<machine>'s conflicted copy <date>)`.

**Fix (`scripts/lib/sync_guard.sh`, sourced by `update_all.sh`):**
1. `sync_file`/`sync_tree` — skip the write entirely when the destination is already byte-identical. Most `update_all.sh` runs re-sync unchanged framework files, so this removes the touch (and therefore the Dropbox event) for the dominant case. Verified: a second consecutive run produces zero `synced:` lines.
2. `acquire_repo_lock`/`release_repo_lock` — best-effort mkdir-based mutual exclusion per target repo, so two machines starting a sync within the same few seconds serialize instead of racing raw writes. A lock older than 5 minutes is treated as abandoned and reclaimed rather than blocking forever.
3. **Pre-commit guard** (`.githooks/pre-commit`, installed via `scripts/install_git_hooks.sh` which sets `core.hooksPath=.githooks`) — a hard, non-bypassable-by-habit gate: `git commit` is refused if any staged file matches `*conflicted copy*` / `*Case Conflict*`. Propagated fleet-wide by `update_all.sh` (copies `.githooks/` + runs the installer per managed repo) and self-healed every session by `scripts/machine_selfheal.sh` step 10, so no machine needs a manual one-time setup step.
4. **`.gitignore`** broadened beyond `*conflicted copy*` to also cover Case-Conflict dedup suffixes, so a conflict file that does slip through is never accidentally staged in the first place.

Tests: `scripts/tests/test_sync_guard.sh` (skip-if-identical + lock semantics), `scripts/tests/test_git_hooks_conflict_guard.sh` (installer + commit-block behavior).

---

## Root Cause + Durable Fix, layer 2 — hook-written ephemeral state (DEVOPS, 2026-08-31)

The 2026-07-20 fix closed the `update_all.sh` push-down path, but conflicted copies kept recurring — `hooks/session/02-dropbox-conflicts.sh`'s workspace-wide sweep was still finding them weeks later, several explicitly `.state/.*metrics` files. That fix only covered files `update_all.sh` copies from the master into managed repos; it never covered files a hook writes locally at every session.

**Root cause:** a handful of hook-written scratch files — `state/.session-metrics` (session-start + every tool call), `state/.autosave-metrics` (every tool call — the hottest write path in the framework), `state/.token-metrics` and `state/.token-rolling-cache` (every tool call / session start) — are rewritten wholesale (`cat > file`) on a shared path. Their content is 100% machine/session-local (wall-clock counters, a dedup key keyed off *this* machine's `~/.claude/projects/**/*.jsonl` transcript path) — no hook ever needs to read another machine's copy. Because the repo is a literal Dropbox-synced path shared by every Mac (not separate clones), two machines with sessions open in the same propagation window raced these exact writes, dozens of times per session — a far higher-frequency race than the once-per-`update_all.sh`-run case layer 1 fixed.

**Fix (`scripts/lib/local_state.sh`):** `local_state_path` appends a sanitized short-hostname suffix to these four paths, so each machine reads and writes its own file (`state/.session-metrics.<hostname>`, etc.) — no shared path, no race, independent of timing. This also fixed a latent correctness bug, not just a cosmetic one: before this fix a machine could silently read another machine's dedup/rolling-window counters (whichever synced last) and treat them as its own. `.gitignore` broadened to the wildcard form (`state/.session-metrics*` etc.) to match. Deliberately NOT applied to `state/.yolo`, `state/.mongo_primary`, `state/.telegram-active-host` — those are intentionally shared cross-machine singletons (operator toggles, "last active host"), rewritten rarely, not the observed offenders.

Tests: `scripts/tests/test_local_state_path.sh` (suffix/path unit tests + an end-to-end check that two simulated machines, via a PATH-shadowed `hostname` stub, never touch each other's file).

---

## Docker credsStore hang after a machine switch (2026-07-22)

**Symptom:** on a Mac freshly switched to, `docker pull` and `docker compose build` hang at the auth step and die with `DeadlineExceeded: context deadline exceeded` — even for public images (e.g. the gateway's `node:20-slim` base) that need no login. Docker Hub itself is reachable in <0.3s, so it reads like a network problem but isn't.

**Root cause:** Docker Desktop's `credsStore: "desktop"` credential helper (`~/.docker/config.json`) blocks indefinitely on `get` when the Desktop creds backend isn't responsive after the switch. Every image resolution funnels through that helper first, so the whole build stalls.

**Durable fix (`scripts/machine_selfheal.sh` step 12, self-healed every session):** probe the configured helper with a hard 3s ceiling; if it hangs, flip `credsStore` from `desktop` to the standalone `osxkeychain` helper (talks to the macOS keychain directly, no Desktop backend). Merge-never-clobber, and it only acts on a genuine hang — a fast non-zero exit ("no stored creds") is healthy and left alone. Manual one-off if ever needed: set `"credsStore": "osxkeychain"` in `~/.docker/config.json`, or pull a public base with an isolated empty config (`DOCKER_CONFIG=$(mktemp -d); echo '{}' > $DOCKER_CONFIG/config.json; docker pull …`).

---

## Quick Reference

```
Machine switch? → Wait for Dropbox sync → Clean conflicts → docker compose up -d --build → Verify
Same machine?   → Check for conflicts → docker compose restart app (if needed) → Continue
```

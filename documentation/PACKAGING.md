# Packaging & Distribution — `ai-management` (Independent Edition)

> Day-5 hardening reference. Covers the **bundled-vs-fetched decision**, version
> pinning, the `myai doctor` preflight, the no-secrets publish gate, and the
> install flow. Pairs with `plan/INDEPENDENT_EDITION_PLAN.md` §2a (clean-room).

## 1. Install flow (what a downloader does)

```bash
# 1. Install the CLI globally (bring your own Claude key/subscription).
npm i -g ai-management        # bins: myai, ai-manage

# 2. Preflight — confirm the host can run the stack.
myai doctor                            # docker(+engine), node, claude CLI,
                                       # ANTHROPIC_API_KEY, ports free

# 3. Scaffold the framework into a target repo (idempotent).
myai init /path/to/repo

# 4. Bring the self-hosted stack live on localhost (loopback single-tenant).
myai up                                # gateway + dashboard + mongo (Docker)

# 5. Make it aware of your repos, then drive it.
myai scan ~/code                       # spider git repos → register + seed RAG
myai schedule "<task>"                 # queue work for the off-hours runner
myai down                              # stop the stack
```

`myai doctor` is **non-fatal on warnings** (e.g. a busy port from a prior
`myai up`, or no `ANTHROPIC_API_KEY` when the Claude CLI is logged in) and
**exits non-zero only on blockers** (no Docker engine, no compose, etc.).
For CI/scripts, `myai doctor --json` emits the same check set as structured
output — `{checks:[{label,status,detail}],ok}` with `status` one of
`ok|warn|fail` — so a pipeline can gate on `.ok` (or `jq` individual checks)
instead of scraping the human lines. Both output paths render from one shared
check run, so they can never drift.

## 2. Bundled vs fetched — the decision

**Decision: BUNDLE the framework core; FETCH nothing at runtime; SHIP NONE of
the operator's context.** A downloader gets a self-contained tool in one
`npm install` — no post-install network fetch (reproducible, offline-friendly,
and it can't be tampered with between publish and install). The published
tarball carries only the genericised framework.

Two layers of defence-in-depth keep operator context out (plan §2a):

1. **Allowlist (opt-in, layer 1)** — `package.json#files` lists exactly what
   ships. A denylist (`.npmignore`) risks silent leaks; the allowlist ships
   nothing unless named. Negations (`!…`) inside the allowlist exclude
   operator-context that lives *inside* an otherwise-shipped directory:
   - `!**/tests/**`, `!**/*.test.ts`, `!scripts/tests/**` — tests never ship.
   - `!scripts/{setup_sentry,rollout_branching,reconcile_review_tasks,audit-state,build_clone_ready_branch,fleet_resume}.sh`
     — operator **fleet-orchestration** scripts that encode the operator's own
     repo inventory. A downloader builds *their own* fleet; these are not part
     of a clean framework.
   - `!documentation/{POWERHOUSE_KEYWORDS,MULTI_ORG_WORKFLOW}.md` —
     operator-personal documentation.
2. **Publish leak-scanner (verify, layer 2)** — `scripts/publish_guard.sh`
   runs `npm pack`, extracts the real tarball, and FAILS (exit 1) on any
   operator home path, the operator Dropbox dev root, operator email, known operator repo name,
   secret-shaped string, or `state|plan|memory|logs|LL` file. Wired as
   `prepublishOnly`, so **`npm publish` is hard-blocked while any leak remains.**

### What ships (clean framework)
`bin/`, `.claude/{agents,skills}/`, `agents/`, `skills/`, `hooks/`, genericised
`scripts/`, `templates/`, `runtime/{src,bin,…}` (no tests), `dashboard/{src,public,…}`,
generic `documentation/`, `config/*.example`, `package.json`, `README`, `LICENSE`.

### What never ships
`state/`, `plan/`, `memory/`, `logs/`, `LL/`, `architecture/`, `design/`,
`SHOWCASE.md`, `CLAUDE.md`, `.env`, `config/*` (non-`.example`), `.git`,
`node_modules`, build artifacts — excluded by the allowlist and verified by the scanner.

## 3. Version pinning

- Package `version` is the single release knob (`0.1.0`); `engines.node` pins
  `>=20` and `myai doctor` enforces it at runtime.
- The CLI (`bin/myai.cjs`) is **dependency-free** — it uses `commander` only
  when present and falls back to a built-in parser, so `myai doctor`/`--help`
  work before any `npm install` (Docker-only-npm hosts included).
- Runtime/dashboard sub-packages carry committed lockfiles
  (`runtime/package-lock.json`, `dashboard/package-lock.json`) so their Docker
  builds are reproducible. The mongo loopback default cred (`admin:password@…`)
  is a documented **public** stack default, not a secret — the scanner
  whitelists loopback/compose hosts so it doesn't false-positive on it.

## 4. The no-secrets scan (run it)

```bash
node bin/myai.cjs doctor          # environment preflight
npm run publish-guard             # == bash scripts/publish_guard.sh
bash scripts/publish_guard.sh --keep   # leave the extracted tarball to inspect
npm pack --dry-run                # see exactly which files would ship
```

`publish_guard.sh` exit codes: `0` clean · `1` leak (publish blocked) · `2` scanner error.

## 5. Residual genericisation backlog (Day-9 security pass)

As of this hardening pass the scanner is down from 146 → 57 findings (via the
loopback-default false-positive fix + the allowlist negations — both
non-breaking). The remaining work — contextual genericisation of operator
literals in shipped files — is **deliberately deferred** to the Day-9 security
pass because the files involved are coupled to the *operator's own live fleet*
(`cli_task_runner.sh` / `setup_*` defaults resolve the operator's real repo
paths); genericising them in place must be config-driven (env / `.env` /
`managed_repos.txt`, all excluded from the package) and verified, not rushed.
The remaining findings are operator **repo-name examples** embedded in core docs
(`documentation/AI_RULES.md`, `KEYWORDS_REFERENCE.md`, `CONNECT_HUB.md`,
`AGENTIC_LIFECYCLE.md`, root `README.md`) and a few operator-environment
references in shipped scripts/hooks (`cli_task_runner.sh` comments,
`hooks/session/17-schedule-status.sh`, `09-docker-naming-enforce.sh`,
`skills/{make-prod,fleet}/SKILL.md`, `templates/CLAUDE_TEMPLATE.md`). These need
a **contextual** genericisation pass (replace `agentFlow/connect/AZURE/…`
examples with generic placeholders, swap the operator central-context
path for a generic one, or ship a dedicated generic package README). They are
NOT yet clean — the `prepublishOnly` gate keeps `npm publish` blocked until they
are, so nothing leaks in the meantime. Tracked for the Day-9 security pass.

# myAI Migration & Install Guide

> **Two audiences, two tracks.** How you get onto myAI depends entirely on whether
> your repo has ever carried a committed `AI/` folder. Pick your track below.
>
> Authoritative source: `architecture/ADR-016-betac-central-context-service.md`
> (§0 product UX, §3 migration path) + `plan/MYAI_INIT_ONE_COMMAND_PLAN.md`.

| Your situation | Your track |
|---|---|
| New repo, or any repo that **never** had an `AI/` folder | **A — End-user greenfield** (`myai init`) |
| Repo with a **committed `AI/` folder** (the operator's managed fleet) | **B — Operator-repo migration** (`myai migrate`) |

The master `ai_management` repo itself is **exempt** from Track B — it stays fat
by design (ADR-016 §0.3). Do not slim its `CLAUDE.md`, `.claude/`, `scripts/`, or
fleet tooling.

---

## Track A — End-user greenfield (`myai init`)

This is the whole story for a repo that never had an `AI/` folder. There is
nothing to migrate — you install the module and initialize.

### 1. Install the framework as a global module

```bash
npm i -g ai-management
```

The published package **is** the framework: agents, skills, hooks, rule bodies,
and templates ship as module content (`files:` in `package.json`). Your repo
never receives copies — it resolves them at runtime from the installed module.
Find the module path any time with `myai root` (≈ `$(npm root -g)/ai-management`).

### 2. Initialize any git repo

```bash
cd /path/to/your/repo
myai init
```

Greenfield `myai init` drops **exactly two artifacts** and nothing else:

- **`CLAUDE.md`** — a ~30-line kernel (committed). Points identity at the brain,
  points the framework at the installed module, and lists the boot protocol. It
  carries **no policy bodies and no secrets** — the only committed framework file.
- **`.myai-local`** — a gitignored per-repo pointer (namespace id, gateway hint,
  ~200-char cached identity blurb for degraded boot). The `.gitignore` rule is
  appended automatically. It is **never committed**.

No `AI/` folder is created. First-ever `myai init` also bootstraps your brain
(`~/.myai/brain`, one per user) and can wire a private git remote persisted in
`~/.myai/config`, so later machines auto-clone the same brain (ADR-016 §0.4).

### 3. Work as normal

Open the repo in your agent and type `agent mode`. It boots from the brain via
`context_boot` (or `brain_delta` for a returning agent). Keywords, agents, skills,
and the PreToolUse safety rails (no push to `main`, no secret commits, Docker-only
npm) all resolve from the module — a kernel-only repo behaves identically to a
scaffolded one.

### Guardrails (asserted by `health_check.sh` / `lint_myai_init.sh`)

A kernel-only repo is **compliant, not broken** — a missing `AI/` folder is correct.
`scripts/lint_myai_init.sh [repo]` asserts, and `health_check.sh` reports GREEN when:

1. a genuine kernel `CLAUDE.md` is present,
2. `.myai-local` is present,
3. `.myai-local` is gitignored **and** not tracked (the pointer never reaches history),
4. the kernel `CLAUDE.md` + `.myai-local` carry no secret material.

```bash
myai root/scripts/lint_myai_init.sh /path/to/your/repo   # exit 0 = GREEN
./scripts/health_check.sh /path/to/your/repo             # kernel-only repo → all checks pass
```

### Idempotency & safety

- Re-running `myai init` is always a safe no-op — it never clobbers a user-edited
  `CLAUDE.md` (only refreshes a genuine kernel, or leaves a non-kernel file alone
  unless `--force`), and never duplicates the `.gitignore` rule or the namespace.
- The legacy `AI/`-scaffold path is preserved behind `--managed` (or master-repo
  auto-detect) for the operator's fleet tooling.

---

## Track B — Operator-repo migration (`myai migrate`, ADR-016 §3)

For the operator's **already-scaffolded** repos that carry a committed `AI/`
folder today and must be walked off it **without losing history**. This is a
per-repo, reversible pipeline (`myai migrate` / `myai eject` / `myai export`).
Track A does **not** apply here, and vice-versa.

> Status: near-term buildable track is the §0 UX (Track A, S-INIT-1…6, shipping now).
> Track B (`myai migrate`) lands after the §0 UX ships and the v0 wedge proves out.

### Phases (dual-home → ingest → flip → remove, all reversible)

- **M0 — Dual-home (shipped):** the gateway serves `context_boot`/brain; `AI/`
  files remain the source of truth. No action.
- **M1 — Ingest:** `myai migrate <repo>` — one-shot, idempotent (checksummed per
  source file). Imports `STATE.md` + `state/archive/` → brain session atoms,
  `HANDOFF` → handoff store, `LL/` → memory atoms, `plan/` → `plan_set`, logs →
  archived atoms, app-card → `repos_card_upsert`. Files stay in place with a
  frozen-banner header; embeddings backfilled.
- **M2 — Flip:** `agent mode` / `wrap up` switch source of truth to the service
  (boot via `context_boot`/`brain_delta`, close via `brain_commit` + `brain_merge`
  + `handoff_write`). File writes stop. `update_all.sh` stops propagating
  agents/skills/docs/state-shaped files to migrated repos (keeps hooks + template).
- **M3 — Remove:** after **N=5 clean sessions** on the service, `myai migrate
  --finalize` deletes `AI/state|logs|agents|skills|documentation|LL` and leaves a
  kernel-only repo (`CLAUDE.md` + `.myai-local`). `health_check.sh` gains a
  phase-aware check for repos stuck in M1/M2 > 14 days.
- **M-R — Rollback (no one-way door):** `myai eject <repo>` regenerates the `AI/`
  file tree from the store at any phase. Because M1 is idempotent and M3 only runs
  after the flip proves itself, rollback is always file-regeneration, never data
  recovery.

**Rollout order:** master repo first (dogfood), then the betaC trio (agentFlow,
connect), then the fleet via `rollout_betac_context.sh`. The `schedule_ignore`
consent list is honored — consent-listed repos migrate only on explicit instruction.

### ⚠ History-scrubbing caveat (non-negotiable, ADR-016 Consequences)

Migration **cannot un-share the past.** The repo history of already-committed
`AI/` state (STATE.md, HANDOFF, logs, LL) **remains visible to every repo
collaborator** even after M3 deletes the working-tree files. Where that history
contains anything sensitive, treat history-scrubbing (e.g. `git filter-repo`) as a
**separate, explicit, out-of-band operation** — it is out of scope for
`myai migrate` and must be run deliberately, per repo, by the operator.

---

## Degraded mode (offline / gateway down)

The service is local by default, so "gateway down" is the main failure, not
"network down". Boot degradation ladder: full bundle → identity-only (on DB
outage) → **`.myai-local` cached blurb** read by the client when the gateway is
entirely unreachable. Writes during an outage end with a normal file-free warning;
re-run `wrap up` when the gateway returns. No shadow file-write path is reintroduced.

---

## Quick reference

| Task | Command |
|---|---|
| Install framework | `npm i -g ai-management` |
| Initialize a repo (greenfield) | `myai init` |
| Find the module path | `myai root` |
| Lint a kernel-only repo | `myai root/scripts/lint_myai_init.sh [repo]` |
| Health check a repo | `./scripts/health_check.sh [repo]` |
| Migrate a scaffolded repo (Track B) | `myai migrate <repo>` |
| Roll back a migration | `myai eject <repo>` |
| Portability bundle | `myai export` |

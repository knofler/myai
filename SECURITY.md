# Security & Privacy — myAI

> **The headline guarantee: your context never leaves your machine.**
> Every byte of agent memory — session state, handoffs, brain atoms, the
> embedded recall corpus — lives in a MongoDB container on your hardware and is
> embedded by a model running **in-process on your CPU**. In the default
> configuration, myAI makes **zero outbound network calls**. Hosted memory
> tools ship your working context to someone else's cloud; myAI's memory is a
> folder of markdown and a local database you can walk away with
> (`myai memory export`).

---

## 1. The data-locality guarantee

### What stays local, always

| Data | Where it lives | Leaves the machine? |
|---|---|---|
| Memory corpus (state, handoffs, patterns, archives) | `myai-mongo` container, volume `myai-mongo-data` | Never |
| Vector embeddings | Same store; computed **in-process** by `Xenova/all-MiniLM-L6-v2` (`@xenova/transformers`) — no embeddings API | Never |
| Brain store (session atoms, compiled briefs) | Local gateway + git-versioned files in your repos | Only via your own `git push` |
| State files (`state/STATE.md`, `state/AI_AGENT_HANDOFF.md`, `logs/`) | Plain files in your repos | Only via your own `git push` |
| Memory export bundles | A local folder of markdown + JSON you choose | Only if you copy them — and they are **secret-scanned first** (§4) |

### The exhaustive outbound surface

Nothing below is contacted unless **you** put a credential in `.env`. No
credential → no call. There is no telemetry, no phone-home, no silent upload.

| Destination | Only when you set | Purpose |
|---|---|---|
| `api.anthropic.com` | `LLM_MODE=api` + `ANTHROPIC_API_KEY` | Channel/LLM responses (chat over Telegram/Discord, LLM router) |
| `api.openai.com/v1/embeddings` | embedding `provider: openai` in gateway config **and** `OPENAI_API_KEY` | Optional remote embeddings. **Default is the local model** — set nothing and embeddings never leave the box |
| `api.telegram.org` | `TELEGRAM_BOT_TOKEN` | Phone control channel (outbound long-poll; no inbound port opened) |
| `discord.com/api` | `DISCORD_BOT_TOKEN` | Discord channel (outbound poll) |
| Moonshot / DeepSeek APIs | their API keys | Optional cheap-tier LLM routing. `ollama` mode is fully local |
| Sentry | `SENTRY_DSN` | Error tracking |
| MongoDB Atlas | `MONGODB_URI` pointed at Atlas (ADR-011 shared queue) | Multi-machine task queue. Point it at the local container and everything stays local |
| GitHub | your own `gh` CLI auth / git remotes | The normal git workflow — driven by you, not the gateway |

**Privacy posture in one sentence:** the recall pipeline (index → embed →
search → `recall_session`) is end-to-end local; cloud services only enter the
picture for the *optional* conveniences you explicitly key in, and none of them
receive the memory corpus.

### BYO-model-key posture

myAI does not sell inference. There is no default LLM key baked into the
product, no proxy that routes your prompts through our infrastructure, and no
usage-based inference billing on our side. Every model call is made **from
your machine, with your own API key, directly to the provider you chose**:

- Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / a DeepSeek or Moonshot key in
  your own `.env` → the gateway calls that provider directly. We never see the
  key, the prompt, or the response — the request never transits our servers,
  because we don't operate any request path between you and the model vendor.
- No key configured → `LLM_MODE` defaults to whatever local/offline path is
  available (e.g. `ollama`); nothing is silently routed to a hosted model.
- This keeps myAI's COGS on inference at zero and means your prompts are
  governed by *your* agreement with *your* model vendor (Anthropic's,
  OpenAI's, etc.), not by us. If your organization has a model-vendor DPA or
  zero-retention agreement already in place, it applies unchanged — myAI
  sits outside that data path entirely.
- The only thing we (the vendor) ever hold is the minimal hosted **account
  and billing** record for a paid subscription tier — never inference
  traffic. See the dashboard's `/privacy` page for the full account-data
  list.

---

## 2. Retention windows

Two different things have retention policies here, and they're deliberately
not the same system: **your local memory corpus** (which you own outright)
and the **hosted account/control-plane data** (the minimal billing/usage
records that exist only if you're on a paid tier).

### Local memory corpus — retained until you delete it

| Data | Retention |
|---|---|
| Memory corpus (`myai-mongo` volume: state, handoffs, patterns) | Indefinite — it's your database. Nothing auto-expires it. |
| `state/STATE.md` hot tier | Kept to the last 3 session blocks / ~20KB by `rotate_state.sh`; older sessions move to `state/archive/YYYY-MM.md`, not deleted |
| `state/AI_AGENT_HANDOFF.md` | Trimmed to a thin delta on rotation; prior content lives in the archive files, still in your git history either way |
| Brain store (session atoms) | Git-versioned — retained per your own repo's git history and remotes, forever unless you rewrite history |
| Memory export bundles | Written to a local path you choose; we impose no expiry. Secret-scanned on write (§4) |

Deleting any of this is entirely in your hands: stop the stack and remove the
`myai-mongo-data` volume, or delete the state/archive files and commit the
removal. There is no server-side copy to separately purge.

### Hosted account/control-plane data — bounded, env-configurable windows

These only exist if you run the multi-tenant gateway with hosted accounts
(billing, invites, the task queue) rather than a pure single-operator local
setup. Each collection ages out on a fixed window, purged by a recurring
sweep (`data_retention_purge`), **unless the tenant is flagged `legalHold`**,
which excludes it from every purge below:

| Collection | Default window | Env override | Scope |
|---|---|---|---|
| Task rows (terminal states: `done` / `dead_letter` only) | 90 days | `TASK_RETENTION_DAYS` | Per tenant |
| PlanDay rows (terminal state: `done` only) | 180 days | `PLAN_RETENTION_DAYS` | Per tenant |
| Audit log day-files | 400 days | `AUDIT_RETENTION_DAYS` | Per tenant (files interleave tenants; purge rewrites the file keeping only non-expired tenants' lines rather than deleting shared files outright) |

Two more windows govern account lifecycle rather than row aging:

- **Right-to-erasure (GDPR/CCPA, user-initiated):** a tenant owner requests
  deletion from account settings; the request is recorded immediately but the
  actual purge is deferred by a **14-day grace window**
  (`ERASURE_GRACE_DAYS`) so a change of mind is recoverable. After the
  window, every tenant-scoped collection is irreversibly deleted and the
  tenant row is scrubbed to a `status=deleted` tombstone carrying no PII.
- **Cancellation purge (billing-driven, operator-side):** once a
  subscription has been fully canceled for **30 days**
  (`CANCELLATION_PURGE_GRACE_DAYS`), the same purge runs automatically —
  this path additionally wipes the tenant's audit trail (the erasure path
  above deliberately does not, so a right-to-erasure request still leaves a
  compliance trail; a billing-driven offboarding has no such requirement).

None of these hosted-tier windows touch your local memory corpus — that
corpus was never on our servers to purge.

---

## 3. What talks to what — ports and tokens

```
 your shell / Claude Code / runner            phone (Telegram app)
        │  x-gateway-local-token                      │
        ▼                                             ▼ (outbound poll only)
 ┌─────────────────┐   http://gateway:3100   ┌──────────────────┐
 │ myai-gateway    │◄────────────────────────│ myai-dashboard   │
 │ :3100 MCP+REST  │                         │ :3210 web UI     │
 │ :3200 channels  │                         └──────────────────┘
 │ :3201 websocket │
 └───────┬─────────┘
         │ mongodb:// (Docker network)
 ┌───────▼─────────┐
 │ myai-mongo      │  host-published on 127.0.0.1:27200 ONLY
 └─────────────────┘
```

**Ports (host side):**

| Port | Service | Default bind |
|---|---|---|
| 3100 | Gateway — MCP + REST API | `HOST_BIND` (default **`127.0.0.1`**) |
| 3200 / 3201 | Gateway — channel HTTP / WebSocket | `HOST_BIND` (same) |
| 3210 | Dashboard | `HOST_BIND` (same) |
| 27200 | MongoDB | **`127.0.0.1` only**. The store must never face the LAN. Opt out with `MONGO_HOST_BIND` only behind a trusted firewall |

Everything is loopback-only by default (v1 gate G5). Containers still reach the
gateway through `host.docker.internal` or the compose network. To use the
dashboard from a phone or another machine on your LAN, opt in explicitly with
`HOST_BIND=0.0.0.0` in your env file. That also turns off the dashboard's local
auto-login, so you get the login page instead.

**First-boot secrets.** `myai up` writes generated values into the env file the
first time it runs: `GATEWAY_LOCAL_TOKEN`, `JWT_SECRET`, and (for a fresh bundled
database) `MONGO_ROOT_PASSWORD`. A value you set yourself is never changed. The
gateway refuses to start with the old published `JWT_SECRET` default. An
existing database volume keeps its password, and `myai up` prints how to change
it. Self-serve signup is off on local stacks (`SIGNUP_ENABLED=false`).

**Tokens & authentication (ADR-010):**

- **Per-tenant API keys** (`myai_live_…` / `myai_test_…`) — full-entropy CSPRNG
  secrets, stored **SHA-256 hashed** (never plaintext), verified with
  constant-time comparison plus a dummy-compare on unknown tenants to flatten
  timing side-channels.
- **Loopback trust** is decided from the **raw socket address**
  (`req.socket.remoteAddress`), never `req.ip` — so `X-Forwarded-For:
  127.0.0.1` spoofing cannot fake local access when a proxy is trusted.
- **`GATEWAY_LOCAL_TOKEN`** — the host→container bridge header
  (`x-gateway-local-token`) for shell scripts hitting the published port, which
  Docker NATs so it doesn't look like loopback. Set a strong value in `.env`
  for anything beyond a dev box.
- **Webhook secrets** (`GITHUB_WEBHOOK_SECRET`, `CONNECT_WEBHOOK_SECRET`) —
  inbound webhooks are HMAC-signature-verified when configured.
- Tenant scoping: every memory/task query goes through `scopedFind` so one
  tenant's corpus is invisible to another (ADR-010).

---

## 4. Memory export is secret-scanned — a bundle never carries a live credential

`myai memory export` produces the portable bundle that is *designed* to leave
the machine (migration, backup, hand-off). It is therefore the one place a
stored secret could escape — so the export path runs the **same secret
patterns the commit hook enforces** over every file it writes (entries,
manifest, `extras/` state copies) and **redacts matches in place**:

- Token-shaped credentials — AWS (`AKIA…`), OpenAI (`sk-…`), GitHub (`ghp_…`),
  GCP (`AIza…`), myAI tenant keys (`myai_live_…`/`myai_test_…`) →
  `[REDACTED-SECRET]`
- Entire PEM private-key blocks (`BEGIN … KEY` through `END … KEY`, body
  included) → `[REDACTED-PRIVATE-KEY]`

Every redaction is announced (`! redacted N secret(s) in <file>`) with a
closing warning to **rotate any credential that was live** — redaction
protects the bundle, not a key that was already stored somewhere it shouldn't
be. If the pattern library is missing, export **refuses to write an unscanned
bundle** rather than failing open. Deliberate raw export:
`MYAI_EXPORT_NO_REDACT=1` (announced loudly, at your own risk).

The single source of truth for the patterns is
`scripts/lib/secret_patterns.sh`, shared by:

1. `hooks/pre-tool/03-secret-scan.sh` — blocks `git commit` when a staged diff
   matches (secrets never reach the repo),
2. `scripts/myai_memory.sh` — redacts bundles (secrets never leave in an
   export).
3. `scripts/myai_context.sh` — the FULL context bundle (`myai context export`)
   redacts the WHOLE staged tree (memory, vectors, brain, `~/.myai` config)
   with the same patterns **before** it computes `CHECKSUMS.sha256`, so the
   integrity manifest reflects the redacted (safe) bytes. `myai context import`
   verifies those checksums and refuses a tampered bundle (exit 3) unless
   `--force`.

Add a pattern once, all gates learn it.

---

## 5. Threat model

Assets: the memory corpus (your working context is the crown jewel), API
keys/tokens in `.env`, the task queue (drives autonomous code execution), and
the git repos themselves.

| Threat (STRIDE) | Vector | Mitigation |
|---|---|---|
| **S**poofing local access | `X-Forwarded-For: 127.0.0.1` against a proxied gateway | Loopback decided from raw socket address only |
| **S**poofing a tenant | Forged/guessed API key | Full-entropy keys, SHA-256 at rest, constant-time compare + dummy compare |
| **T**ampering with the queue | LAN peer posting tasks to the gateway | `tenancy.enforce` on by default → 401 without key/local token; `HOST_BIND=127.0.0.1` removes the surface entirely |
| **T**ampering with framework files | Agent (or prompt-injected agent) deleting state/rules | `04-protected-files.sh` blocks deletion/empty-overwrite of critical files |
| **R**epudiation | "What did the autonomous runner do overnight?" | Runner transcripts in `~/.ai-cli-runner/logs/`, git history, task audit trail in the gateway |
| **I**nfo disclosure — secrets in git | Credential staged in a diff or `.env` added | `03-secret-scan.sh` blocks the commit; `.env`/`.pem`/`.key` staging blocked outright |
| **I**nfo disclosure — secrets in exports | Stored secret rides out in a memory bundle | Export-path scan + redaction (§4) |
| **I**nfo disclosure — LAN Mongo | Default-cred Mongo published on the LAN | Host port bound to `127.0.0.1` by default |
| **D**enial of service | Request floods on gateway | Rate-limit middleware; local-first design means the blast radius is your own box |
| **E**levation — push to production | Agent pushing `main` directly | `01-block-push-main.sh` hook + branch protection; all work lands via `test` → PR |
| **E**levation — split-brain deploy | Workspace clone (no real `.env`) compose-upping the shared gateway | `16-block-workspace-gateway-deploy.sh` — gateway deploys only from the master checkout |

Out of scope (v1): a hostile local user on the same machine (they own the
hardware and the Docker socket), supply-chain compromise of upstream npm/base
images (mitigated by lockfiles and pinned images, not eliminated), and secrets
you paste directly into chat with a cloud LLM you configured.

### Multi-tenant runner mode: trusted tenants only

The default install is single-user: the runner works only your own queue. With
`--tenant <id>` / `--all-tenants` (a tenant keys file), it also works OTHER
tenants' tasks on this machine. Each tenant gets its own repo root and its own
workspace clone (`.tenants/<tenant>/<repo>`, origin checked before reuse), but
the agent CLI still runs as **your OS user** with the permission mode the runner
is configured for. There is no OS-level sandbox yet: a tenant's task can reach
whatever your user can. Serve only tenants you would trust to run code on this
machine, until per-tenant containers or users land. (v1 security audit G5, NEW-2.)

---

## 6. Guardrail model — how autonomous agents are kept on a leash

myAI's autonomous runner executes code changes, commits, and pushes without a
human watching every action. Enterprise buyers evaluating an agentic tool
correctly ask "what stops it from doing something destructive while
unsupervised?" The answer is a layered set of guardrails that hold regardless
of which permission mode (interactive, YOLO-timed, YOLO-god) the agent is
running in:

- **Hooks are not a permission-mode feature — they're always-on.** They run
  as PreToolUse hooks outside the agent's own judgment, so "YOLO mode" or a
  bypassed-permissions session does **not** disable them:

  | Hook | Guarantee |
  |---|---|
  | `01-block-push-main.sh` | No direct pushes to `main` — everything lands via `test` → PR, even for the fully-autonomous runner |
  | `03-secret-scan.sh` | No credentials, `.env`, `.pem`, `.key` in commits |
  | `04-protected-files.sh` | Critical framework files can't be deleted/blanked |
  | `05-no-local-npm.sh` | npm runs in containers only — host stays clean |
  | `16-block-workspace-gateway-deploy.sh` | Shared gateway stack deploys only from the master checkout — a per-task worktree can't split-brain the fleet |

- **Autonomy is scoped, not unlimited.** Timed YOLO (`yolo N`) auto-expires
  after N minutes; god-mode YOLO auto-deactivates on the next successful
  commit or on plan completion — neither is "run forever unattended."
  Destructive git operations (force-push, hard reset, branch deletion) stay
  behind explicit user confirmation even inside YOLO; YOLO skips permission
  *prompts*, it does not waive the safety rails above.
- **Failure is bounded, not retried forever.** The 3-strikes rule: if an
  agent fails the same fix three times in a row, it stops and writes a
  postmortem instead of continuing to thrash — no infinite retry loops
  against production state.
- **Every task runs in an isolated worktree**, not against a shared
  checkout — a runaway or compromised task can't clobber another task's
  in-flight work, and can only merge its output through the same
  `test`-branch → PR path every human contributor uses.
- **The runner's actions are fully auditable after the fact:** transcripts in
  `~/.ai-cli-runner/logs/`, normal git history for every commit, and the
  gateway's own task audit trail — "what did the autonomous runner do
  overnight" always has an answer.

## 7. Hardening checklist (recommended for anything beyond a single dev laptop)

1. Keep `HOST_BIND` at its `127.0.0.1` default unless you need LAN access.
2. Set a strong, unique `GATEWAY_LOCAL_TOKEN` (the compose dev default is not
   a secret).
3. Keep the generated `JWT_SECRET` and `MONGO_ROOT_PASSWORD` private. If your
   database still uses the old default password, change it with the command
   `myai up` prints, especially before you ever widen `MONGO_HOST_BIND`.
4. Restrict channel access: `TELEGRAM_ALLOWED_CHATS` / `DISCORD_ALLOWED_CHANNELS`
   (empty = allow all).
5. Keep `tenancy.enforce` on (the default) — don't set `TENANT_ENFORCE=false`
   outside tests.
6. Run the supply-chain gate: `./scripts/dependency_scan.sh` — `npm audit`
   (fails on any high/critical CVE in production deps) plus a license-
   compliance pass against a permissive allowlist, per npm surface
   (`runtime/`, `dashboard/`). CI runs it automatically on dependency-touching
   PRs and on a weekly schedule (`.github/workflows/dependency-scan.yml`),
   which also opens a bounded auto-upgrade PR for safe semver-patch bumps
   (lockfile-only, verified, capped at 5, `deps/auto-patch-*` → `test` —
   never straight to `main`).

---

## 8. Vulnerability disclosure policy

- **Report privately** via GitHub Security Advisories on
  [the myAI repo's private advisory form](https://github.com/knofler/myai/security/advisories/new) —
  click **"Report a vulnerability"** (private vulnerability reporting is
  enabled on this public repo). Title the advisory `[SECURITY] myAI`. This is
  the supported private channel — there is no email intake, and the private
  development repo is not an external intake.
- Please include: affected component (gateway / dashboard / hooks / scripts),
  reproduction steps, and impact. A proof-of-concept helps; exploitation of
  other users' data does not — don't.
- **Response targets:** acknowledgement within 72 hours; triage verdict within
  7 days; fix or documented mitigation for confirmed issues within 30 days
  (critical: as fast as humanly possible, with a fleet-wide propagation via
  `update_all.sh`).
- **Safe harbor:** good-faith research against your own installation is
  welcome; credit given in release notes on request.
- Please do not open public issues for unpatched vulnerabilities.
- **Responsible disclosure only — no paid bounty.** myAI does not offer a
  monetary reward for vulnerability reports. Confirmed reporters are credited
  in the release notes on request.

---

*Maintained by the security-specialist lane. Changes to the outbound surface,
ports, or token model MUST update this file in the same PR — the guarantee is
only as good as its documentation.*

*Last updated: 2026-08-16*

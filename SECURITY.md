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
| Memory export bundles | A local folder of markdown + JSON you choose | Only if you copy them — and they are **secret-scanned first** (§3) |

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

---

## 2. What talks to what — ports and tokens

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
| 3100 | Gateway — MCP + REST API | `HOST_BIND` (default all interfaces, for LAN dashboard/phone workflows) |
| 3200 / 3201 | Gateway — channel HTTP / WebSocket | `HOST_BIND` (same) |
| 3210 | Dashboard | `HOST_BIND` (same) |
| 27200 | MongoDB | **`127.0.0.1` only** — the store ships with default credentials and must never face the LAN. Opt out with `MONGO_HOST_BIND` behind a trusted firewall |

Set `HOST_BIND=127.0.0.1` in `.env` to lock the whole stack to the local
machine (single-laptop setups should).

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

## 3. Memory export is secret-scanned — a bundle never carries a live credential

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

## 4. Threat model

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
| **I**nfo disclosure — secrets in exports | Stored secret rides out in a memory bundle | Export-path scan + redaction (§3) |
| **I**nfo disclosure — LAN Mongo | Default-cred Mongo published on the LAN | Host port bound to `127.0.0.1` by default |
| **D**enial of service | Request floods on gateway | Rate-limit middleware; local-first design means the blast radius is your own box |
| **E**levation — push to production | Agent pushing `main` directly | `01-block-push-main.sh` hook + branch protection; all work lands via `test` → PR |
| **E**levation — split-brain deploy | Workspace clone (no real `.env`) compose-upping the shared gateway | `16-block-workspace-gateway-deploy.sh` — gateway deploys only from the master checkout |

Out of scope (v1): a hostile local user on the same machine (they own the
hardware and the Docker socket), supply-chain compromise of upstream npm/base
images (mitigated by lockfiles and pinned images, not eliminated), and secrets
you paste directly into chat with a cloud LLM you configured.

---

## 5. Defense in depth — the always-on hooks

These run as Claude Code PreToolUse hooks, independent of permission mode
(bypass/YOLO does **not** disable them):

| Hook | Guarantee |
|---|---|
| `01-block-push-main.sh` | No direct pushes to `main` |
| `03-secret-scan.sh` | No credentials, `.env`, `.pem`, `.key` in commits |
| `04-protected-files.sh` | Critical framework files can't be deleted/blanked |
| `05-no-local-npm.sh` | npm runs in containers only — host stays clean |
| `16-block-workspace-gateway-deploy.sh` | Shared gateway stack deploys only from the master checkout |

## 6. Hardening checklist (recommended for anything beyond a single dev laptop)

1. `HOST_BIND=127.0.0.1` in `.env` — gateway/dashboard loopback-only.
2. Set a strong, unique `GATEWAY_LOCAL_TOKEN` (the compose dev default is not
   a secret).
3. Change the Mongo root credentials in `docker-compose.yml`/`MONGODB_URI` if
   you ever widen `MONGO_HOST_BIND`.
4. Restrict channel access: `TELEGRAM_ALLOWED_CHATS` / `DISCORD_ALLOWED_CHANNELS`
   (empty = allow all).
5. Keep `tenancy.enforce` on (the default) — don't set `TENANT_ENFORCE=false`
   outside tests.

---

## 7. Vulnerability disclosure policy

- **Report privately** via GitHub Security Advisories on
  [`knofler/myai`](https://github.com/knofler/myai/security/advisories/new) —
  click **"Report a vulnerability"** (private vulnerability reporting is
  enabled on this public repo). Title the advisory `[SECURITY] myAI`, or
  `[BUG-BOUNTY]` for the paid track (see below). This is the supported private
  channel — there is no email intake, and the private `knofler/ai_management`
  repo is not an external intake.
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

**Paid bug bounty program:** beyond this passive channel, myAI runs a standing
incentivized bounty program — scope boundaries, severity-based payout tiers
($25–$1,500), safe-harbor legal terms, and the full submission → triage →
payout workflow are in `documentation/BUG_BOUNTY_PROGRAM.md`. Same intake as
above; tag the submission `[BUG-BOUNTY]` to route it into the paid track.

---

*Maintained by the security-specialist lane. Changes to the outbound surface,
ports, or token model MUST update this file in the same PR — the guarantee is
only as good as its documentation.*

*Last updated: 2026-07-18*

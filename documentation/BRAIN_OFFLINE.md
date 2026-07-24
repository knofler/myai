# Offline & Degraded Modes — BRAIN B6

> When the cloud is unreachable, the framework degrades in **layers** — it never
> just dies. Spec: `plan/jam/brain-layer.md` §8 (USER REQUIREMENT).
> Preflight: `myai doctor` reports all three signals (cloud reachability,
> Ollama availability, brain freshness) before you hit them mid-session.

## The degradation ladder

| Layer | What's down | What still works | How |
|---|---|---|---|
| 1 | Nothing | Everything | Normal tier routing (`runtime/src/llm/router.ts`) |
| 2 | Cloud LLM providers | Full gateway + inference | **Ollama auto-connect** (below) |
| 3 | The whole gateway / stack | Reading the brain | **Degraded-read** (below) |
| 4 | Everything but the laptop | Sovereign mode | Laptop + Ollama + local mongo + brain git = an offline agent that remembers |

## Layer 2 — Ollama auto-connect (gateway up, cloud down)

Implemented in `runtime/src/llm/provider.ts` (`complete()`) +
`runtime/src/llm/offline.ts`:

1. Every provider in the mode chain fails with a **recoverable network error**
   (ECONNREFUSED/ENOTFOUND/ETIMEDOUT/…, open circuits, exhausted rate limiters).
   Non-recoverable errors (auth, bad request) abort as before — offline rescue
   never masks a real bug.
2. If `ollama` is **not** already in the chain, the gateway probes the local
   daemon: `GET <OLLAMA_BASE_URL>/api/tags` (default `localhost:11434`,
   1.5 s timeout, result cached 30 s).
3. Daemon answers → the call is re-dispatched through the existing ollama
   provider. Model choice prefers the configured `OLLAMA_MODEL` when installed,
   else the first installed model (`pickOllamaModel`) — auto-connect works even
   when the configured default was never pulled.
4. The response is stamped `offlineFallback: true` + a `notice`, and every
   channel (message-router: chat, stream, tools) appends the notice visibly:

   > ⚠ _Offline mode: cloud LLM providers unreachable — this response was
   > served by local Ollama (llama3:8b). Quality may differ from cloud models;
   > normal routing resumes automatically once connectivity returns._

   The same marking applies when ollama was already in the chain and rescued
   the call as a fallback hop. It is **not** applied when ollama is the
   deliberate primary provider (`LLM_MODE=ollama`) — that's routing, not
   degradation.
5. Recovery is automatic: the next request walks the normal chain first; the
   probe cache expires after 30 s.

**Config knobs:** `OLLAMA_BASE_URL` (default `http://host.docker.internal:11434/v1`
in Docker, `http://localhost:11434/v1` bare), `OLLAMA_MODEL`.

**Tests (simulated offline):** `runtime/tests/unit/offline-fallback.test.ts` —
all cloud hops reject with network errors, the probe is stubbed, and the suite
asserts auto-connect, model pick, the notice, no-rescue on non-recoverable
errors, and no double-dispatch when ollama is already in the chain.

## Layer 3 — Degraded-read (no server at all)

Reading the brain requires **no gateway, no node, no stack** — the compiled
artifacts are plain files checked into brain `main` (compile-at-write, B3).
(When the stack IS up, this pull happens for you: merges/stashes auto-push and
boots auto-pull with a bounded 2s fast-fail — see BRAIN_WORKFLOW.md; the manual
pull below is the zero-runtime path.)

```bash
# on any machine with the brain remote configured:
git -C "$(cat ~/.myai/brain.path 2>/dev/null || echo ~/.myai/brain)" pull origin main

# then just read the compiled files:
cat <brain>/repos/<name>/brief.md     # boot brief (~150 tok)
cat <brain>/repos/<name>/working.md   # working context (~2k tok)
cat <brain>/repos/<name>/rollup.md    # one line per atom
git -C <brain> log -1 --format=%cr    # how fresh is this brain?
```

Atoms themselves (`repos/<name>/sessions/`, `handoffs/`, cross-repo `memory/`)
are also plain markdown — `grep` works when you need the raw facts.

**Test:** `scripts/tests/test_brain_degraded_read.sh` — hermetic two-host
simulation: host A writes + merges sessions and pushes; host B uses ONLY
`git clone`/`git pull` + file reads (no runtime sourced) and asserts the
compiled brief/working files, atom content, and freshness are all readable.

## `myai doctor` — offline preflight

`myai doctor` (bin/myai.cjs) now reports, warn-only (offline is a *supported*
mode, so none of these fail preflight):

- **cloud provider reachable** — TCP probe to `api.anthropic.com:443`;
  unreachable → notes the gateway will auto-connect to local Ollama.
- **ollama available** — `GET /api/tags` on `OLLAMA_BASE_URL` (default
  `127.0.0.1:11434`); reports installed model count, or how to enable the
  offline fallback.
- **offline inference path** — surfaces only when BOTH are down: points at
  degraded-read (`git pull brain → read compiled files`).
- **brain freshness** — locates the brain repo (`$MYAI_BRAIN_DIR` →
  `$MYAI_HOME/brain.path` → `$MYAI_HOME/brain`, mirroring
  `scripts/lib/brain.sh`) and reports the age of the last commit; warns past
  7 days (stale — run `wrap up` / `myai brain session merge`).

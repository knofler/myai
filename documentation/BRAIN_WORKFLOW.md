# Brain Workflow — how every agent uses the operator brain with any code repo

> **For AI agents:** read this when working with the brain. The brain is the operator's
> git-versioned memory — ONE per operator, shared by ALL repos, machine-local at
> `~/.myai/brain`, synced between machines via its own git remote (NEVER via
> Dropbox — git repos inside Dropbox corrupt refs; real incident 2026-06-24).
> The remote URL lives in the master repo's `AI/.env` as `MYAI_BRAIN_REMOTE`
> (Dropbox-synced to every machine, never shipped in the npm package).

## The two-repo model

| | Code repo | Brain |
|---|---|---|
| What | The project you're building | The operator's memory (atoms, briefs, stashes) |
| Where | anywhere on disk | `~/.myai/brain` (namespaced per repo inside) |
| Syncs via | Its own git remote (+ Dropbox) | Its own git remote (`MYAI_BRAIN_REMOTE`) |
| Source of truth for | Source code, state/, handoff | Cross-session memory, boot briefs, stashes |

The handoff (`state/AI_AGENT_HANDOFF.md`) remains the authoritative task pointer.
The brain is the fast, cross-repo, cross-device memory layer on top; `context_boot`
falls back to the handoff store automatically when no brain exists on a machine.

## One-time per machine

1. Install the framework: `npm i -g ai-management` (or use the master checkout).
2. Get the brain: `myai brain init --remote "$MYAI_BRAIN_REMOTE"` — no local brain yet →
   it CLONES the remote (one command, nothing manual); very first machine ever → it
   creates the store and seeds the remote with an initial push.
3. Verify: `myai doctor` (checks gateway, brain freshness, Ollama fallback).

## Work on an EXISTING repo that already has the framework (`AI/` folder)

1. `cd <repo>` → open your agent (`claude`, or any agent via `myai connect-agent` / `myai shim`).
2. `agent mode` (full) or `agent mode -min` (fast) — pulls code `main`, boots context
   via `brain_delta` (~150–800 tokens), reads the handoff ACTION.
3. Work normally.
4. `wrap up` — updates state/handoff, appends a session atom, `brain_merge` to brain main.

## Work on an EXISTING repo WITHOUT the framework

1. `myai scan <path>` (from anywhere) — installs the `AI/` folder + keywords into the repo.
2. Then follow the existing-repo steps above.

## Start a NEW repo

1. `myai new-app <name>` (or master-repo `init blueprint <path>`) — scaffolds app + framework.
2. `agent mode` in the new repo — it onboards you ("what do you want to build?").

## Daily rhythm on ONE machine

1. Morning: `agent mode -min` → brain delta + handoff = context in seconds.
2. Work; ship with `ship it`.
3. Evening: `wrap up` → session atom + brain merge — the merge auto-pushes brain
   main to the remote (bounded, non-fatal when offline).

## Switching MACHINES (multi-machine)

Sync is AUTOMATIC once the brain has an `origin` remote: merges and stashes push
main; boots (`context_boot` / `brain_delta` / session start) do a bounded 2s
fast-fail fetch + ff-only pull before reading. Offline stays first-class — a
failed push/pull is a reported no-op, never an error (`BRAIN_OFFLINE.md`).

1. Machine A, before leaving: `wrap up` (clean) or `brain stash <slug>` (mid-task
   freeze — the stash pushes immediately; cross-device resume is its whole point).
2. Machine B: `agent mode` in the same repo — the boot pulls the latest brain main
   automatically; or `brain pop <slug>` to resume the frozen context.
3. Code changes travel via the CODE repo's remote/Dropbox as always; the brain only
   carries memory. Never put the brain inside Dropbox.

## Switching AGENTS (Claude ↔ Gemini ↔ Ollama ↔ anything)

1. MCP-capable agent: `myai connect-agent --install <agent>` once → it auto-boots
   with your context on every session.
2. Non-MCP / raw model: `myai shim --ollama <model>` (or `--print` to paste anywhere) —
   prepends the operator bundle so a blank model wakes up knowing you.
3. Offline: reads degrade gracefully to plain files on brain main (`BRAIN_OFFLINE.md`);
   chat falls back to local Ollama automatically.

## Quick brain verbs (any session)

`brain status` · `brain delta` (what changed since my last anchor) · `brain stash` /
`brain pop` (freeze/resume anywhere) · `brain blame <sha>` (which session wrote this) ·
`brain log` · full CLI in `TRY_BRAIN.md`.

# Kernel CLAUDE.md — the concrete slimming plan

> BRAIN B4 deliverable, per `plan/jam/brain-layer.md` §7: *"Kernel CLAUDE.md — shrink to
> identity + 'call context_boot' + keyword index. Rules → lazy gateway tools; policy →
> hooks (shell-side, zero tokens); skills → lazy files."*
>
> **Status: PLAN ONLY.** CLAUDE.md is NOT gutted yet — the boot path that makes slimming
> safe (compiled brain brief + `brain_delta`, B3) only just landed, and the first slice
> must be verified in live sessions before anything is removed. This document is the
> execution contract for the slices that follow.
>
> **Two kernels, one plan (operator directive 2026-07-05, ADR-016 §0).** There are two
> distinct kernel artifacts, and this document governs both:
>
> | Kernel | Who | Size | Where it comes from |
> |---|---|---|---|
> | **End-user kernel** — `templates/CLAUDE_KERNEL.md` | any repo where a user runs `myai init` | **~30 lines** | dropped into the repo by `myai init` (ADR-016 §0.2); the only committed framework file the repo carries. Framework body (agents/skills/hooks/rules) is resolved from the installed module, context from the gateway/brain. |
> | **Master/managed kernel** — `CLAUDE.md` / `CLAUDE_TEMPLATE.md` | the operator's `ai_management` master + its legacy managed fleet | ~2k tokens (L0) | the slimming target of S1–S4 below. The **master repo itself stays fat** (ADR-016 §0.3) — only the *template it publishes* is slimmed. |
>
> The end-user kernel is even slimmer than the L0 target because it does not carry
> propagation/fleet identity — it is a pure pointer: *"who you are lives in the brain;
> the framework is the installed `ai-management` module; here is the keyword
> index."* Authoring it is folded into **S1** below.

---

## Why

Every session loads CLAUDE.md in full, every turn, cache-miss or not:

| File | Today | Loaded |
|---|---|---|
| `CLAUDE.md` (master) | ~61 KB ≈ 15k tokens | every session, always |
| `templates/CLAUDE_TEMPLATE.md` (→ every managed repo's `CLAUDE.md`) | ~43 KB ≈ 11k tokens | every session in every managed repo |
| `documentation/KEYWORDS_REFERENCE.md` | ~26 KB | on demand (already lazy — the model) |
| `documentation/AI_RULES.md` | ~30 KB | on demand (already lazy) |

The always-loaded tier is the problem. Most of CLAUDE.md is **protocol bodies** (the
`agent mode` row alone is ~4k tokens) that fire on a handful of keywords, and **policy
text** that hooks already enforce shell-side. The brain layer (B1–B3) replaces the last
big always-loaded consumer — state boot — with a ~150-token compiled brief +
~300–800-token `brain_delta`. Target: **kernel ≤ 2k tokens always loaded**; everything
else lazy.

## Target architecture — kernel + lazy layers

```
L0  KERNEL (always loaded, ≤ ~2k tokens) — the new CLAUDE.md
    ├─ Identity: repo name, master vs managed, propagation role
    ├─ Non-negotiables digest: 6–8 one-liners (never push main, Docker-only npm,
    │  no secrets, test-branch flow, zero-prompt policy pointer)
    ├─ Boot instruction: "state lives in the brain — the MCP initialize bundle /
    │  context_boot gives you the brief + Brain SHA; catch up with brain_delta"
    └─ KEYWORD INDEX: one line per keyword → trigger + pointer to its L1 protocol file

L1  KEYWORD PROTOCOLS (lazy files, read on trigger)
    ├─ documentation/KEYWORDS_REFERENCE.md      (already exists — extended keywords)
    └─ documentation/CORE_KEYWORDS.md           (NEW — full bodies of agent mode /
       wrap up / ship it / init blueprint / yolo / fleet, moved out of CLAUDE.md)

L2  POLICY → HOOKS (zero tokens — enforcement is shell-side)
    ├─ already enforced: push-main block, secret scan, protected files, no-local-npm,
    │  RAM guard, usage/token guards, schedule banner, Vercel gate, selfheal
    └─ kernel keeps only the one-line digest; the paragraphs move to AI_RULES.md (lazy)

L3  STATE → BRAIN (B1–B3, shipped)
    ├─ boot: compiled brief.md (~150 tok) via context_boot / MCP initialize bundle
    ├─ returning agent: brain_delta since=<last-seen SHA> (~300–800 tok)
    └─ file reads (STATE.md / handoff) demoted to fallback when gateway/brain absent

L4  SKILLS / AGENTS (already lazy — auto-discovered, loaded on invocation)
```

## Token economics (per session start, master repo)

| | Today | Kernel |
|---|---|---|
| CLAUDE.md | ~15k tok | ~2k tok |
| State boot (STATE.md + handoff reads) | ~5–6k tok | ~0.15–0.8k (brief/delta) |
| Keyword protocol when one fires | 0 extra (inline) | +1–3k (one lazy Read) |
| **Typical session start** | **~20k+** | **~2.5–3k** |

A keyword session pays one lazy Read (~the same tokens the inline row cost) — but only
in sessions where that keyword actually fires, instead of in every session.

## Migration slices (each independently shippable + verifiable)

**S0 — boot path + keywords (THIS commit, B4). DONE.**
`brain status/commit/stash/pop/branch/checkout/merge/log/diff/delta/blame/revert`
documented fleet-wide (CLAUDE.md + CLAUDE_TEMPLATE.md + both KEYWORDS_REFERENCE
flavors); `agent mode -min` boots via `brain_delta` with file-read fallback; `wrap up`
appends one session atom + calls `brain_merge` and records the `Brain: <sha>` anchor in
the handoff header. Nothing removed — this slice ADDS the rails the later slices stand on.

**S1 — template first (managed repos get the kernel before the master does) + author the end-user kernel.**
Rewrite `templates/CLAUDE_TEMPLATE.md` as the L0 kernel (~120 lines): identity +
non-negotiables digest + brain-boot instruction + keyword index. Move the current
template's protocol bodies into `templates/KEYWORDS_REFERENCE.md` (which `update_all.sh`
already ships to `AI/documentation/KEYWORDS_REFERENCE.md`) — the `agent mode` blueprint
onboarding flow, wrap-up body, ship-it body, YOLO + Usage Guard sections. Verify on ONE
canary managed repo (suggest `todo-blueprint` or another low-stakes repo) for a full
session cycle (`agent mode` → work → `wrap up`) before `update_all.sh` rolls it wide.
*Why template first:* managed repos have simpler CLAUDE.md files, the master gateway is
one network hop away, and a regression is contained to one repo instead of the hub.

**Also in S1 — author the ~30-line end-user kernel `templates/CLAUDE_KERNEL.md`** (ADR-016
§0.2, the artifact `myai init` drops for end users). It is a strict subset of the L0
template: identity-from-brain line + "framework is the installed `ai-management`
module — resolve agents/skills/hooks/rules from it (`myai root`)" + brain-boot instruction
(`context_boot` / `brain_delta`) + a one-line keyword-index pointer + the file-read
fallback line. **No propagation/fleet identity, no policy bodies.** Add a guard test:
`templates/CLAUDE_KERNEL.md` must stay ≤ ~30 lines / ≤ ~600 tokens and carry no secrets
(secret-scan). This artifact is consumed by the `myai init` greenfield slice in
`plan/MYAI_INIT_ONE_COMMAND_PLAN.md` (S-INIT-2).

**S2 — extract master core-keyword bodies → `documentation/CORE_KEYWORDS.md`.**
Master CLAUDE.md keyword rows become index stubs (trigger + one-line + "Read
CORE_KEYWORDS.md → <section>"). The Keyword Execution Protocol (announce/report/summary
table) stays in the kernel — it governs every keyword. Verify: each keyword still
executes its FULL protocol from a cold session (the stub must be compelling enough that
the model actually Reads the file — test `agent mode -min`, `wrap up -u`, `ship it`).

**S3 — policy-to-hook audit.**
For each policy paragraph in master CLAUDE.md (Zero-Prompt, Local-CI, CI Thrift, Usage
Guard, Token Guard, YOLO, Multi-machine, Management-Issue protocol): confirm a hook or
script enforces it shell-side; keep ONE digest line in the kernel; move the full text to
`AI_RULES.md`/dedicated docs (lazy). Anything with no shell enforcement either gets a
hook first or stays in the kernel — **never silently drop an unenforced rule.**

**S4 — master kernel cutover.**
Master CLAUDE.md rewritten to L0 (~2k tokens). Gate: S1 canary green for ≥1 week of
real sessions, S2 keyword-fire verification green, brain boot proven on a second machine
(home MacBook / office PC pulling the brain repo). Measure before/after with the
token-budget guard + `/usage` and record the delta in `SHOWCASE.md` (feeds B7's
cold-start meter).

## Guardrails (apply to every slice)

1. **Safety rails never leave the always-loaded tier** unless a PreToolUse hook provably
   enforces them (push-main, secrets, Docker-only npm already are).
2. **Keyword index rows keep**: trigger phrase(s), one-line intent, pointer. A keyword
   the model can't recognize from the index is a regression.
3. **One slice per PR**, each with a session-cycle verification note in the PR body.
4. **Fallbacks stay**: no gateway / no brain / fresh clone must still boot from files.
   The kernel must say so in one line.
5. **`update_all.sh` is the only distribution path** — never hand-edit a managed repo's
   CLAUDE.md.
6. **Rollback** = revert the one PR; lazy files are additive so reverting the kernel
   restores the inline behavior byte-for-byte.

## Sequencing

S0 (done, this commit) → S1 (template kernel + canary) → S2 (CORE_KEYWORDS extraction)
→ S3 (policy-to-hook audit) → S4 (master cutover + measured token delta). S1–S2 are
each a single runner task; S3–S4 want an interactive session for the verification gates.

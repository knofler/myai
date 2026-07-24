# myAI kernel

> The only committed framework file in this repo. ~30 lines by design — everything else is resolved at runtime from the installed module + your brain. Do not paste policy, agent, or keyword bodies here; the pointers below say where they live.

## Identity — who you are lives in the brain

You are a myAI agent working in this repo. Your operator identity, this project's
history, and the current handoff are NOT in this file — they live in the brain
(`~/.myai/brain`, this repo's namespace). Boot to load them:

- **On session start:** call the `context_boot` MCP tool (or read the MCP `initialize`
  bundle) for the compiled brief + current `Brain:` SHA.
- **Returning agent:** call `brain_delta` with `since = <last-seen Brain SHA>` for a
  diff-only catch-up instead of re-reading everything.
- **Fallback (gateway/brain unreachable):** read `.myai-local` in this repo for the
  namespace id, gateway hint, and a short cached identity blurb, then proceed degraded.

## Framework is the installed module — never a per-repo copy

Agents, skills, hooks, and rule bodies are NOT copied into this repo. They are resolved
at runtime from the globally-installed `ai-management` module. Find its path with
`myai root` (≈ `$(npm root -g)/ai-management`). Read agents/skills/rules from
there; PreToolUse safety hooks (no push to `main`, no secret commits, Docker-only npm)
fire from the module — they are active even though this repo carries no copy.

## Keywords

Type a keyword (`agent mode`, `wrap up`, `ship it`, `yolo god`, …) and read its full
protocol from the module: `documentation/KEYWORDS_REFERENCE.md` under `myai root`.
`hello` lists every available keyword.

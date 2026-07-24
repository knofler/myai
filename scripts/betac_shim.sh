#!/usr/bin/env bash
# =============================================================================
# betac_shim.sh — betaC blank-agent shim: the WRAP-IT tier (jam/betac.md risk 1).
#
# "Any agent plugs into betaC" has TWO tiers, and we are honest about it:
#
#   Tier 1 — COOPERATING MCP clients (Claude Code, Cursor, Windsurf, Codex…):
#            the gateway injects the operator brief automatically on the MCP
#            `initialize` handshake, and the agent can lazily recall more via
#            `context_boot` / `recall_session` / `memory_search`.
#            → `myai connect-agent` (scripts/myai_connect_agent.sh)
#
#   Tier 2 — BLANK / non-cooperating agents (Ollama models, ChatGPT web, any
#            plain LLM with no MCP support): THIS launcher fetches the same
#            tight `context_boot` bundle from the gateway and PREPENDS it to
#            the prompt. The agent never fetches anything itself — the shim
#            wraps it. One-shot context, no live recall: that's the honest
#            limit of the tier, and the composed primer says so to the model.
#
# The demo this enables ("it knows me"): a fresh Ollama/ChatGPT session
# auto-greets with your active projects and answers "what was I doing in
# repo X last week?" — no keyword, no re-explaining. The recall question
# works because a prompt is forwarded as `context_boot`'s `query`, which
# runs ONE capped semantic search and appends short `deeper` snippets
# (cheap by design — no prompt, no search).
#
# Usage:
#   betac_shim.sh ollama [prompt...]        # run local Ollama pre-loaded with your context
#   betac_shim.sh chatgpt [prompt...]       # compose a paste-ready ChatGPT primer (stdout)
#   betac_shim.sh print [prompt...]         # composed primer to stdout (any blank agent)
#
# No prompt → the primer instructs the agent to auto-greet the operator from
# the brief (who / active project / last handoff / next) — the cold-open demo.
#
# Options:
#   --model <m>     Ollama model (default: $BETAC_OLLAMA_MODEL, else first installed)
#   --repo <r>      Override the active project the bundle is built for
#   --no-deep       Don't forward the prompt as a lazy-recall query (no RAG search)
#   --deep <q>      Force a lazy-recall query different from the prompt
#   --budget <n>    Char budget for the tight summary (gateway default 1800)
#   --copy          Also copy the composed primer to the clipboard (pbcopy/xclip)
#
# Requires: bash + node >= 20 (fetch built in) — same footprint as
# myai_connect_agent.sh; `ollama` on PATH only for ollama mode.
# Env: GATEWAY_MCP (default http://localhost:3100/mcp), GATEWAY_LOCAL_TOKEN
#      (via scripts/lib/gateway.sh), BETAC_OLLAMA_MODEL.
# bash 3.2-safe (macOS default bash).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
# Local-token escape hatch — host calls hit the published Docker port, which the
# gateway sees as the bridge IP, not loopback (ADR-010 M1; scripts/lib/gateway.sh).
. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
export GATEWAY_MCP GATEWAY_LOCAL_TOKEN

# ── args ──────────────────────────────────────────────────────────────────────
MODE=""
MODEL="${BETAC_OLLAMA_MODEL:-}"
REPO=""
BUDGET=""
DEEP_QUERY=""
NO_DEEP=false
COPY=false
PROMPT=""

while [ $# -gt 0 ]; do
  case "$1" in
    ollama|chatgpt|print)
      if [ -n "$MODE" ]; then PROMPT="${PROMPT:+$PROMPT }$1"; else MODE="$1"; fi ;;
    --model)  MODEL="${2:?--model needs a value}"; shift ;;
    --repo)   REPO="${2:?--repo needs a value}"; shift ;;
    --budget) BUDGET="${2:?--budget needs a value}"; shift ;;
    --deep)   DEEP_QUERY="${2:?--deep needs a value}"; shift ;;
    --no-deep) NO_DEEP=true ;;
    --copy)   COPY=true ;;
    -h|--help) sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) PROMPT="${PROMPT:+$PROMPT }$1" ;;
  esac
  shift
done

if [ -z "$MODE" ]; then
  echo "usage: betac_shim.sh <ollama|chatgpt|print> [prompt...] (see --help)" >&2
  exit 2
fi

# Lazy recall: forward the prompt as the context_boot query unless told not to.
QUERY="$DEEP_QUERY"
if [ -z "$QUERY" ] && ! $NO_DEEP; then QUERY="$PROMPT"; fi

# ── compose: fetch context_boot + build the primer (node, no curl/jq) ────────
compose_primer() {
  BETAC_SHIM_PROMPT="$PROMPT" BETAC_SHIM_QUERY="$QUERY" BETAC_SHIM_REPO="$REPO" \
  BETAC_SHIM_BUDGET="$BUDGET" node -e '
    const url = process.env.GATEWAY_MCP;
    const headers = {
      "content-type": "application/json",
      "x-gateway-local-token": process.env.GATEWAY_LOCAL_TOKEN || "",
    };
    (async () => {
      const args = {};
      if (process.env.BETAC_SHIM_REPO) args.repo = process.env.BETAC_SHIM_REPO;
      if (process.env.BETAC_SHIM_QUERY) args.query = process.env.BETAC_SHIM_QUERY;
      const budget = Number(process.env.BETAC_SHIM_BUDGET);
      if (Number.isFinite(budget) && budget > 0) args.budget = budget;

      const r = await fetch(url, {
        method: "POST", headers,
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "context_boot", arguments: args },
        }),
      });
      if (!r.ok) throw new Error(`gateway HTTP ${r.status} on context_boot`);
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
      const text = d.result?.content?.[0]?.text ?? "";
      let boot;
      try { boot = JSON.parse(text); } catch { throw new Error("context_boot returned non-JSON payload"); }
      if (boot?.error) throw new Error(`context_boot: ${boot.error}`);
      if (!boot?.bundle) throw new Error("context_boot returned no bundle");

      const lines = [boot.bundle.trim()];

      // Lazy-recall snippets (present only when a query was forwarded).
      if (Array.isArray(boot.deeper) && boot.deeper.length) {
        lines.push("", "## Deeper context (recalled for this question)");
        for (const s of boot.deeper) {
          lines.push(`- [${s.repo}] (${s.source}) ${s.snippet}`);
        }
      }

      // Two-tier honesty, addressed to the MODEL: this tier has no live recall.
      lines.push(
        "",
        "---",
        "You are a blank agent launched through the betaC shim (wrap-it tier).",
        "The operator context above was PREPENDED by the launcher — you did not",
        "fetch it, and you have NO betaC tools in this session (the lazy-recall",
        "tools named above are unavailable here; a cooperating MCP client would",
        "have them). Answer from the context above; never ask the operator to",
        "re-explain who they are or what they are working on.",
        "",
      );

      const prompt = (process.env.BETAC_SHIM_PROMPT || "").trim();
      if (prompt) {
        lines.push(`Operator message: ${prompt}`);
      } else {
        lines.push(
          "Operator message: (none — fresh session) Greet the operator from the",
          "brief above: who you are working with, the active project, the last",
          "handoff, and offer to continue from **Next**.",
        );
      }

      const tokens = boot.tokenEstimate ?? Math.ceil(boot.bundle.length / 4);
      const deeperN = Array.isArray(boot.deeper) ? boot.deeper.length : 0;
      console.error(`betaC shim: operator context loaded (~${tokens} tokens, project: ${boot.parts?.activeProject ?? "?"}${deeperN ? `, +${deeperN} recalled snippet(s)` : ""})`);
      console.log(lines.join("\n"));
    })().catch((e) => {
      console.error(`betaC shim: ${e.message}`);
      console.error("  Is the stack up? Try: myai up   (then re-run this shim)");
      process.exit(1);
    });
  '
}

PRIMER="$(compose_primer)"

maybe_copy() {
  if $COPY; then
    if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$PRIMER" | pbcopy; echo "betaC shim: primer copied to clipboard" >&2
    elif command -v xclip >/dev/null 2>&1; then printf '%s' "$PRIMER" | xclip -selection clipboard; echo "betaC shim: primer copied to clipboard" >&2
    else echo "betaC shim: --copy skipped (no pbcopy/xclip on PATH)" >&2; fi
  fi
}

case "$MODE" in
  print)
    maybe_copy
    printf '%s\n' "$PRIMER"
    ;;
  chatgpt)
    # ChatGPT (web) has no local hook to inject into — the honest shim is a
    # paste-ready primer: banner to stderr, primer alone on stdout.
    maybe_copy
    echo "betaC shim: paste the primer below as your FIRST message in ChatGPT —" >&2
    echo "it pre-loads the session with your operator context (wrap-it tier)." >&2
    printf '%s\n' "$PRIMER"
    ;;
  ollama)
    command -v ollama >/dev/null 2>&1 || { echo "betaC shim: ollama not found on PATH — install it or use 'print' mode" >&2; exit 127; }
    if [ -z "$MODEL" ]; then
      # First installed model (skip the header line of `ollama list`).
      MODEL="$(ollama list 2>/dev/null | awk 'NR==2{print $1}')"
      [ -n "$MODEL" ] || { echo "betaC shim: no Ollama models installed — try: ollama pull llama3.2" >&2; exit 1; }
    fi
    maybe_copy
    echo "betaC shim: launching ollama ($MODEL) pre-loaded with your context…" >&2
    exec ollama run "$MODEL" "$PRIMER"
    ;;
esac

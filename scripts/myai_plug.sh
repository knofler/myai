#!/usr/bin/env bash
# =============================================================================
# myai_plug.sh — ONE front door: plug ANY agent into your brain (continuity).
#
# "Plug any agent into your brain" had two commands the operator had to know
# apart: `connect-agent` (MCP clients) and `shim` (blank agents). This is the
# single polished flow over both — you name the agent, it routes to the right
# tier, and it always ends with the LIVE PROOF that the hookup actually works.
#
# The continuity layer has two honest tiers (plan/jam/betac.md risk 1):
#
#   Cooperating tier — real MCP clients. The gateway force-loads the operator
#     brief on the MCP `initialize` handshake, and the agent can deepen it via
#     `context_boot` / `recall_session` / `memory_search`.
#       claude   Claude Code     cursor   Cursor
#       windsurf Windsurf        codex    Codex CLI     (→ myai connect-agent)
#       gemini   Gemini CLI      opencode opencode      (→ example MCP config)
#
#   Wrap-it tier — blank / non-MCP agents. A launcher fetches the same bundle
#     and PREPENDS it to the prompt (no live recall — the primer says so).
#       ollama   local model     chatgpt  paste primer  (→ myai shim)
#
# Usage:
#   myai plug                       # the menu — every agent + its one-liner
#   myai plug <agent> [args...]     # route + verify (e.g. myai plug claude --install)
#   myai plug proof                 # live continuity proof only (no install)
#   myai plug --list                # same as no args
#
# `myai plug <agent>` forwards any extra args straight through to the underlying
# playbook (e.g. `--install`, `--repo`, `--no-verify`, a shim prompt), so the
# single command is a superset — nothing the two commands could do is lost.
#
# Requires: bash 3.2+ (macOS default) + node >= 20 (via the delegated scripts).
# Env: GATEWAY_MCP, GATEWAY_LOCAL_TOKEN (via scripts/lib/gateway.sh) — same as
#      connect-agent / shim, which do the actual gateway I/O.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONNECT="$SCRIPT_DIR/myai_connect_agent.sh"
SHIM="$SCRIPT_DIR/betac_shim.sh"
GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}

# ── agent registry ────────────────────────────────────────────────────────────
# Every supported agent → its tier + how it plugs in. bash 3.2 has no assoc
# arrays, so this is a flat, greppable table: "agent|tier|label|how".
AGENTS="\
claude|cooperating|Claude Code|myai connect-agent claude --install
cursor|cooperating|Cursor|myai connect-agent cursor --install
windsurf|cooperating|Windsurf|myai connect-agent windsurf --install
codex|cooperating|Codex CLI|myai connect-agent codex --install
gemini|cooperating|Gemini CLI|see examples/agents/gemini-cli/settings.json
opencode|cooperating|opencode|see examples/agents/opencode/opencode.json
ollama|wrap|Ollama (local)|myai shim ollama
chatgpt|wrap|ChatGPT (web)|myai shim chatgpt --copy
print|wrap|any blank agent|myai shim print"

agent_field() { # $1 = agent, $2 = field index (1-based) → prints field or empty
  printf '%s\n' "$AGENTS" | awk -F'|' -v a="$1" -v n="$2" '$1==a{print $n; exit}'
}

# ── the menu ────────────────────────────────────────────────────────────────
print_menu() {
  cat <<EOF
== myai plug — plug any agent into your brain ==

Your identity, projects, last handoff and next step live in YOUR continuity
layer, not the agent's. Name an agent and it boots knowing you — one command.

  Cooperating tier (MCP clients — auto-boot on the handshake, live recall):
    claude      Claude Code    →  myai plug claude       (writes ./.mcp.json)
    cursor      Cursor         →  myai plug cursor
    windsurf    Windsurf       →  myai plug windsurf
    codex       Codex CLI      →  myai plug codex
    gemini      Gemini CLI     →  myai plug gemini        (prints MCP config)
    opencode    opencode       →  myai plug opencode      (prints MCP config)

  Wrap-it tier (blank / non-MCP agents — bundle prepended, one-shot context):
    ollama      Ollama local   →  myai plug ollama [prompt...]
    chatgpt     ChatGPT web    →  myai plug chatgpt        (paste-ready primer)
    print       any agent      →  myai plug print          (primer to stdout)

Prove it works right now, with no agent installed:
    myai plug proof

Extra flags pass straight through, e.g.:
    myai plug claude --install         # write the config AND verify
    myai plug claude --no-verify       # just print the config
    myai plug ollama "what was I doing in repo X last week?"

Gateway: $GATEWAY_MCP   (start it with: myai up)
EOF
}

# ── the live proof (delegates to connect-agent's round-trip) ──────────────────
run_proof() {
  echo "== myai plug — live continuity proof =="
  echo "Handshake + context_boot round-trip against $GATEWAY_MCP"
  echo "(this is what every plugged-in agent receives the moment it connects)"
  echo
  exec bash "$CONNECT" --verify
}

# ── cooperating agents that ship as example MCP config, not connect-agent ─────
print_example_agent() { # $1 = agent (gemini|opencode)
  local label file
  label="$(agent_field "$1" 3)"
  case "$1" in
    gemini)   file="examples/agents/gemini-cli/settings.json" ;;
    opencode) file="examples/agents/opencode/opencode.json" ;;
  esac
  cat <<EOF
── $label — cooperating MCP client (config-file based)

$label reads its MCP servers from a config file. Point it at the local gateway
by copying the ready-made entry from:

    $file

Set the myai server URL to $GATEWAY_MCP and add the
x-gateway-local-token header (your GATEWAY_LOCAL_TOKEN from .env). On its next
start it auto-boots with your operator brief on the MCP handshake.

Verifying the gateway side of that hookup now:
EOF
  echo
  bash "$CONNECT" --verify
}

# ── main ──────────────────────────────────────────────────────────────────────
if [ $# -eq 0 ]; then
  print_menu
  exit 0
fi

AGENT="$1"; shift || true
case "$AGENT" in
  -h|--help|help|--list|list)
    print_menu; exit 0 ;;
  proof|--proof|verify|--verify)
    run_proof ;;
  claude|cursor|windsurf|codex|all)
    exec bash "$CONNECT" "$AGENT" "$@" ;;
  gemini|opencode)
    print_example_agent "$AGENT" ;;
  ollama|chatgpt|print)
    exec bash "$SHIM" "$AGENT" "$@" ;;
  *)
    echo "myai plug: unknown agent '$AGENT'." >&2
    echo "Known agents: claude cursor windsurf codex gemini opencode ollama chatgpt print" >&2
    echo "Run 'myai plug' for the menu, or 'myai plug proof' to test the gateway." >&2
    exit 2 ;;
esac

#!/usr/bin/env bash
# =============================================================================
# killer_demo.sh — THE adoption demo, reproducible + shareable.
#
#   "Connect your context through myAI and the cheapest free/local model
#    answers like a frontier model."
#
# Asks the SAME question to the SAME cheap local model (Ollama, default
# gemma3:4b) TWICE and shows them side by side:
#   (A) RAW / no context   → generic "I don't know you" answer (useless)
#   (B) via myAI context   → expert, personalized, correct answer
#
# (B) prepends the operator brief from the gateway `context_boot` bundle —
# the same wrap-it tier the betaC shim uses (scripts/betac_shim.sh). No model
# fine-tuning, no RAG in the model: just YOUR context, portably attached.
#
# Outputs, every run:
#   • a two-column side-by-side to the terminal
#   • a JSON artifact → dashboard/public/demo/killer-demo.json
#     (powers the dashboard /demo showcase page)
#
# Usage:
#   killer_demo.sh                              # gemma3:4b, default question
#   killer_demo.sh --model mistral:7b-instruct  # any installed Ollama model
#   killer_demo.sh --question "what did I ship yesterday?"
#   killer_demo.sh --repo agentFlow             # context for a specific repo
#   killer_demo.sh --json-only                  # artifact JSON to stdout, no render
#   killer_demo.sh --no-write                   # don't write the dashboard artifact
#   killer_demo.sh --record                     # print the GIF-capture recipe and exit
#
# Env: GATEWAY_MCP (default http://localhost:3100/mcp), GATEWAY_LOCAL_TOKEN
#      (via scripts/lib/gateway.sh), OLLAMA_URL (default http://localhost:11434),
#      BETAC_OLLAMA_MODEL.
# Requires: bash + node >= 20 + a running Ollama with the model pulled.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
OLLAMA_URL=${OLLAMA_URL:-http://localhost:11434}
export GATEWAY_MCP GATEWAY_LOCAL_TOKEN OLLAMA_URL

ARTIFACT="$REPO_ROOT/dashboard/public/demo/killer-demo.json"
WRITE=true
JSON_ONLY=false
PASSTHRU=()

while [ $# -gt 0 ]; do
  case "$1" in
    --no-write) WRITE=false ;;
    --json-only) JSON_ONLY=true; PASSTHRU+=("--json-only") ;;
    --record)
      cat <<'REC'
Record the GIF (macOS, asciinema + agg — both `brew install`):
  asciinema rec killer-demo.cast -c "bash scripts/killer_demo.sh"
  agg killer-demo.cast dashboard/public/demo/killer-demo.gif --theme monokai
Or a plain screen capture: run `bash scripts/killer_demo.sh` in a clean
terminal and record the window. The side-by-side render is the shot.
REC
      exit 0 ;;
    --model|--question|--repo|--budget) PASSTHRU+=("$1" "${2:?$1 needs a value}"); shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PASSTHRU+=("$1") ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || { echo "killer_demo: node >= 20 required" >&2; exit 127; }

if $JSON_ONLY || ! $WRITE; then
  node "$SCRIPT_DIR/lib/killer-demo.mjs" "${PASSTHRU[@]+"${PASSTHRU[@]}"}"
  exit $?
fi

# Render to terminal AND capture the machine-readable last line for the artifact.
mkdir -p "$(dirname "$ARTIFACT")"
OUT="$(node "$SCRIPT_DIR/lib/killer-demo.mjs" "${PASSTHRU[@]+"${PASSTHRU[@]}"}")"
# Everything but the final line is the human render; the final line is JSON.
printf '%s\n' "$OUT" | sed '$d'
printf '%s\n' "$OUT" | tail -n 1 > "$ARTIFACT"
echo "killer_demo: artifact → ${ARTIFACT#$REPO_ROOT/}  (dashboard /demo picks it up)" >&2

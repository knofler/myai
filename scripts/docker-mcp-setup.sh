#!/usr/bin/env bash
# Docker MCP Toolkit setup for the myAI gateway (MYAI_GATEWAY.md Phase 7).
#
# Registers this repo's myAI gateway (runtime/, already served over HTTP at
# :3100/mcp by the docker-compose `gateway` service) as a `docker mcp` catalog
# server, creates a profile for it, and stores the local bridge token in the
# OS Keychain via `docker mcp secret` — replacing manual `.mcp.json` editing.
#
# Verified against a live Docker Desktop MCP Toolkit CLI. Idempotent: safe to
# re-run after editing mcp/catalog/myai-server.yaml.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG_SRC="$REPO_ROOT/mcp/catalog/myai-server.yaml"
CATALOG_NAME="myai"
PROFILE_ID="myai"
DOCKER_MCP_CATALOGS_DIR="$HOME/.docker/mcp/catalogs"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI not found — install Docker Desktop first." >&2
  exit 1
fi

if ! docker mcp --help >/dev/null 2>&1; then
  echo "Docker MCP Toolkit not available ('docker mcp' failed)." >&2
  echo "Enable it in Docker Desktop: Settings > Beta features > Docker MCP Toolkit." >&2
  exit 1
fi

if [[ ! -f "$CATALOG_SRC" ]]; then
  echo "Catalog source not found: $CATALOG_SRC" >&2
  exit 1
fi

echo "==> Installing catalog server definition"
mkdir -p "$DOCKER_MCP_CATALOGS_DIR"
cp "$CATALOG_SRC" "$DOCKER_MCP_CATALOGS_DIR/myai-server.yaml"

echo "==> Registering catalog '$CATALOG_NAME'"
if docker mcp catalog list 2>/dev/null | grep -q "^${CATALOG_NAME}:latest"; then
  docker mcp catalog remove "${CATALOG_NAME}:latest" >/dev/null
fi
docker mcp catalog create "$CATALOG_NAME" \
  --server "file://myai-server.yaml" \
  --title "myAI Gateway"

echo "==> Setting GATEWAY_LOCAL_TOKEN secret (OS Keychain)"
if docker mcp secret ls 2>/dev/null | grep -q "GATEWAY_LOCAL_TOKEN"; then
  echo "    already set — skipping (docker mcp secret rm GATEWAY_LOCAL_TOKEN to reset)"
else
  TOKEN_VALUE="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
  printf '%s' "$TOKEN_VALUE" | docker mcp secret set GATEWAY_LOCAL_TOKEN
fi

# Optional upstream API keys (skipped silently when unset — the gateway tools
# that need them simply no-op, same behavior as an unset .env var today).
for key in OPENAI_API_KEY TELEGRAM_BOT_TOKEN; do
  if [[ -n "${!key:-}" ]] && ! docker mcp secret ls 2>/dev/null | grep -q "^docker/mcp/${key} \|$key"; then
    printf '%s' "${!key}" | docker mcp secret set "$key"
    echo "    set $key"
  fi
done

echo "==> Creating profile '$PROFILE_ID'"
if docker mcp profile list 2>/dev/null | grep -qE "^${PROFILE_ID}\b"; then
  docker mcp profile remove "$PROFILE_ID" >/dev/null
fi
docker mcp profile create --name "$PROFILE_ID" --id "$PROFILE_ID" \
  --server "catalog://${CATALOG_NAME}:latest/myai"

cat <<EOF

Setup complete. myAI is registered as Docker MCP Toolkit profile '$PROFILE_ID'.

Start the gateway (if not already running):
  docker compose up -d gateway

Connect a client (adds a single MCP_DOCKER entry to .mcp.json, merged with
existing entries — it does not remove the manual "myai" entry, do that by
hand once you've confirmed the toolkit path works):
  docker mcp client connect claude-code --profile $PROFILE_ID

Verify:
  docker mcp tools ls --profile $PROFILE_ID
EOF

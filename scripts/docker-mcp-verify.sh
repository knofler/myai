#!/usr/bin/env bash
# Verifies the Docker MCP Toolkit packaging for the myAI gateway
# (MYAI_GATEWAY.md Phase 7): OCI image builds, and the catalog/profile round
# trip (create -> profile -> secret -> connect) succeeds against a live
# `docker mcp` CLI. Uses throwaway names (myai-verify*) so it never touches
# the real 'myai' catalog/profile or this repo's committed .mcp.json.
#
# Usage:
#   scripts/docker-mcp-verify.sh            # catalog/profile smoke test only
#   scripts/docker-mcp-verify.sh --build     # also builds the gateway OCI image
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG_SRC="$REPO_ROOT/mcp/catalog/myai-server.yaml"
CATALOG_NAME="myai-verify"
PROFILE_ID="myai-verify"
SECRET_NAME="GATEWAY_LOCAL_TOKEN_VERIFY"
DOCKER_MCP_CATALOGS_DIR="$HOME/.docker/mcp/catalogs"
SCRATCH_CLIENT_DIR="$(mktemp -d)"

fail=0

cleanup() {
  docker mcp profile remove "$PROFILE_ID" >/dev/null 2>&1 || true
  docker mcp catalog remove "${CATALOG_NAME}:latest" >/dev/null 2>&1 || true
  docker mcp secret rm "$SECRET_NAME" >/dev/null 2>&1 || true
  rm -f "$DOCKER_MCP_CATALOGS_DIR/${CATALOG_NAME}-server.yaml"
  rm -rf "$SCRATCH_CLIENT_DIR"
}
trap cleanup EXIT

echo "==> [1/4] docker mcp CLI available?"
if ! docker mcp --help >/dev/null 2>&1; then
  echo "    SKIP — Docker MCP Toolkit not available on this machine (enable it in Docker Desktop)."
  exit 0
fi
echo "    ok"

if [[ "${1:-}" == "--build" ]]; then
  echo "==> [2/4] OCI image build (scratch tag — does not touch myai-gateway:latest)"
  docker build -t myai-gateway:mcp-verify "$REPO_ROOT/runtime" >/tmp/myai-mcp-verify-build.log 2>&1 \
    && echo "    ok" \
    || { echo "    FAIL — see /tmp/myai-mcp-verify-build.log"; fail=1; }
  docker image rm myai-gateway:mcp-verify >/dev/null 2>&1 || true
else
  echo "==> [2/4] OCI image build — SKIPPED (pass --build to run it; runtime/Dockerfile already verified via docker-compose's myai-gateway:latest)"
fi

echo "==> [3/4] catalog -> profile -> secret round trip (throwaway names)"
mkdir -p "$DOCKER_MCP_CATALOGS_DIR"
sed "s/^name: myai$/name: ${CATALOG_NAME}/" "$CATALOG_SRC" > "$DOCKER_MCP_CATALOGS_DIR/${CATALOG_NAME}-server.yaml"

docker mcp catalog create "$CATALOG_NAME" \
  --server "file://${CATALOG_NAME}-server.yaml" \
  --title "myAI Gateway (verify)" >/dev/null \
  && echo "    catalog create: ok" \
  || { echo "    catalog create: FAIL"; fail=1; }

docker mcp catalog show "${CATALOG_NAME}:latest" 2>/dev/null | grep -q "url: http://host.docker.internal:3100/mcp" \
  && echo "    catalog contents: ok" \
  || { echo "    catalog contents: FAIL (remote url missing)"; fail=1; }

printf 'verify-token' | docker mcp secret set "$SECRET_NAME" >/dev/null \
  && echo "    secret set: ok" \
  || { echo "    secret set: FAIL"; fail=1; }

docker mcp profile create --name "$PROFILE_ID" --id "$PROFILE_ID" \
  --server "catalog://${CATALOG_NAME}:latest/${CATALOG_NAME}" >/dev/null 2>&1 \
  && echo "    profile create: ok" \
  || { echo "    profile create: FAIL"; fail=1; }

docker mcp profile show "$PROFILE_ID" >/dev/null 2>&1 \
  && echo "    profile show: ok" \
  || { echo "    profile show: FAIL"; fail=1; }

echo "==> [4/4] client connect (scratch project dir, not this repo)"
(cd "$SCRATCH_CLIENT_DIR" && git init -q && docker mcp client connect claude-code --profile "$PROFILE_ID" >/dev/null 2>&1)
if grep -q '"MCP_DOCKER"' "$SCRATCH_CLIENT_DIR/.mcp.json" 2>/dev/null; then
  echo "    client connect: ok"
else
  echo "    client connect: FAIL"
  fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  echo "==> PASS"
else
  echo "==> FAIL"
fi
exit "$fail"

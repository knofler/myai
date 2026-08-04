#!/usr/bin/env bash
# docker-mcp-catalog-check.sh — smoke test that mcp/catalog/myai-server.yaml
# (Docker MCP Toolkit packaging, Phase 7, commit 990dbe1) hasn't drifted from
# the gateway it describes.
#
# WHY: the catalog file is hand-authored and only ever exercised by a human
# running `docker mcp client connect`. Nothing catches it silently going stale
# when the gateway's MCP surface changes (port move, /mcp route renamed, the
# x-gateway-local-token auth header renamed, GATEWAY_LOCAL_TOKEN renamed) — it
# would just fail at the point someone actually tries to connect.
#
# Two check groups:
#   A. Structural/cross-source (hermetic — no docker, no network, no gateway):
#      validates the yaml's shape against the docker-mcp catalog format and
#      cross-checks every value that's supposed to match the real gateway
#      source (auth.ts header name, config.ts env var, docker-compose.yml
#      port, handler.ts route mount) — this is what actually catches drift,
#      and it's what runs in CI (see scripts/tests/test_docker_mcp_catalog.sh).
#   B. docker mcp CLI schema validate (best-effort — SKIP if the CLI isn't
#      available, e.g. any headless CI runner; Docker Desktop only).
#   C. Live gateway discovery (best-effort — SKIP if the gateway isn't
#      reachable). Hits the unauthenticated GET /mcp discovery route and
#      compares its reported transport + tool list against the catalog.
#
# Usage:
#   scripts/docker-mcp-catalog-check.sh                    # all groups (A+B+C)
#   scripts/docker-mcp-catalog-check.sh --schema-only       # group A only (hermetic)
#   scripts/docker-mcp-catalog-check.sh --catalog PATH      # check a different file (tests use this)
#   scripts/docker-mcp-catalog-check.sh --gateway-url URL   # override live gateway base (default derived from the catalog's remote.url, host.docker.internal -> localhost)
#
# Exit: 0 all checks passed (SKIPs don't fail); 1 one or more checks failed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG="$REPO_ROOT/mcp/catalog/myai-server.yaml"
AUTH_SRC="$REPO_ROOT/runtime/src/core/auth.ts"
CONFIG_SRC="$REPO_ROOT/runtime/src/shared/config.ts"
COMPOSE_SRC="$REPO_ROOT/docker-compose.yml"
HANDLER_SRC="$REPO_ROOT/runtime/src/mcp/handler.ts"
SCHEMA_ONLY=false
GATEWAY_URL_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --catalog) CATALOG="$2"; shift 2 ;;
    --schema-only) SCHEMA_ONLY=true; shift ;;
    --gateway-url) GATEWAY_URL_OVERRIDE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

fail=0
ok()   { printf '    ok   — %s\n' "$1"; }
bad()  { printf '    FAIL — %s\n         %s\n' "$1" "${2:-}"; fail=1; }
skip() { printf '    SKIP — %s\n' "$1"; }

[ -f "$CATALOG" ] || { echo "FAIL — catalog file not found: $CATALOG"; exit 1; }

# ── awk block extractor: lines indented under a given top-level "key:" ──────
extract_block() {
  awk -v k="^${1}:" '
    $0 ~ k { flag=1; next }
    flag && /^[^ ]/ { flag=0 }
    flag { print }
  ' "$CATALOG"
}

scalar() { # top-level "key: value" -> value (first match)
  grep -E "^${1}:" "$CATALOG" | head -1 | sed -E "s/^${1}:[[:space:]]*//" | sed -E 's/[[:space:]]+$//'
}

echo "==> [A] Structural + cross-source checks (hermetic)"

NAME="$(scalar name)"
[ -n "$NAME" ] && echo "$NAME" | grep -qE '^[a-z][a-z0-9_-]*$' \
  && ok "name: '$NAME'" || bad "name" "expected a non-empty lowercase catalog name, got '$NAME'"

TYPE="$(scalar type)"
case "$TYPE" in
  remote|server) ok "type: '$TYPE'" ;;
  *) bad "type" "expected 'remote' or 'server' (docker mcp catalog schema), got '$TYPE'" ;;
esac

IMAGE="$(scalar image)"
if [ "$TYPE" = "remote" ]; then
  [ "$IMAGE" = '""' ] || [ -z "$IMAGE" ] \
    && ok "image empty (correct for type: remote)" \
    || bad "image" "type: remote must NOT declare an image (got '$IMAGE') — this repo's gateway is a persistent docker-compose service, not a toolkit-launched container"
else
  [ -n "$IMAGE" ] && [ "$IMAGE" != '""' ] \
    && ok "image set (correct for type: server)" \
    || bad "image" "type: server requires a non-empty image"
fi

for k in description title; do
  v="$(scalar "$k")"
  [ -n "$v" ] && ok "$k present" || bad "$k" "missing or empty top-level '$k:'"
done

REMOTE_BLOCK="$(extract_block remote)"
if [ "$TYPE" = "remote" ]; then
  [ -n "$REMOTE_BLOCK" ] && ok "remote: block present" || bad "remote: block" "type: remote requires a 'remote:' block"

  URL="$(printf '%s\n' "$REMOTE_BLOCK" | grep -E '^  url:' | head -1 | sed -E 's/^  url:[[:space:]]*//')"
  if printf '%s' "$URL" | grep -qE '^https?://'; then
    ok "remote.url looks like a URL: $URL"
  else
    bad "remote.url" "expected an http(s) URL, got '$URL'"
  fi

  # Port cross-check against docker-compose.yml's MCP_PORT (the source of truth
  # for which port the gateway's standalone MCP server actually listens on —
  # see runtime/src/core/index.ts startMcpServer(mcpPort)).
  COMPOSE_PORT="$(grep -oE 'MCP_PORT=[0-9]+' "$COMPOSE_SRC" 2>/dev/null | head -1 | grep -oE '[0-9]+')"
  URL_PORT="$(printf '%s' "$URL" | sed -E 's#^https?://[^:/]+:([0-9]+).*#\1#')"
  if [ -n "$COMPOSE_PORT" ]; then
    [ "$URL_PORT" = "$COMPOSE_PORT" ] \
      && ok "remote.url port ($URL_PORT) matches docker-compose.yml MCP_PORT" \
      || bad "remote.url port" "catalog says port $URL_PORT but docker-compose.yml MCP_PORT=$COMPOSE_PORT — gateway port drift"
  else
    skip "remote.url port cross-check (couldn't find MCP_PORT in docker-compose.yml)"
  fi

  # Path cross-check against the real MCP route mount (handler.ts).
  URL_PATH="$(printf '%s' "$URL" | sed -E 's#^https?://[^/]+##')"
  if grep -qE "app\.use\('/mcp'" "$HANDLER_SRC" 2>/dev/null; then
    [ "$URL_PATH" = "/mcp" ] \
      && ok "remote.url path ($URL_PATH) matches the gateway's /mcp route mount" \
      || bad "remote.url path" "catalog path is '$URL_PATH' but handler.ts mounts the MCP router at '/mcp' — route drift"
  else
    skip "remote.url path cross-check (couldn't confirm '/mcp' mount in handler.ts)"
  fi

  TRANSPORT="$(printf '%s\n' "$REMOTE_BLOCK" | grep -E '^  transport_type:' | head -1 | sed -E 's/^  transport_type:[[:space:]]*//')"
  case "$TRANSPORT" in
    streamable-http|sse|http) ok "remote.transport_type: '$TRANSPORT'" ;;
    *) bad "remote.transport_type" "unrecognized transport '$TRANSPORT'" ;;
  esac

  # headers: sub-block — lines indented at 4 spaces within the remote block
  # (2-space children of remote: are url/transport_type/headers; headers'
  # OWN children sit one level deeper, at 4 spaces).
  HEADER_LINES="$(printf '%s\n' "$REMOTE_BLOCK" | grep -E '^    [A-Za-z0-9_-]+:')"
  if [ -z "$HEADER_LINES" ]; then
    bad "remote.headers" "no header entries found under remote.headers"
  else
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      hkey="$(printf '%s' "$line" | sed -E 's/^    ([A-Za-z0-9_-]+):.*/\1/')"
      hval="$(printf '%s' "$line" | sed -E 's/^    [A-Za-z0-9_-]+:[[:space:]]*//')"
      if grep -qi "'${hkey}'" "$AUTH_SRC" 2>/dev/null; then
        ok "header '$hkey' still matches a literal in auth.ts"
      else
        bad "header '$hkey'" "not found as a literal in $AUTH_SRC — auth header may have been renamed (catalog would silently 401 at connect time)"
      fi
      # ${VAR} placeholder -> must resolve to a secrets[].env entry (checked below).
      if printf '%s' "$hval" | grep -qE '\$\{[A-Z_][A-Z0-9_]*\}'; then
        ok "header '$hkey' value references a secret placeholder"
      else
        bad "header '$hkey' value" "expected a \${SECRET_ENV} placeholder, got '$hval' (raw secret in the catalog file?)"
      fi
    done <<< "$HEADER_LINES"
  fi
else
  skip "remote.* checks (type: server, no remote block expected)"
fi

# secrets: list — every entry needs name/env/example, and every env must still
# be read by the gateway (config.ts), and every ${PLACEHOLDER} used anywhere in
# the file must resolve to one of these envs (internal consistency).
SECRETS_BLOCK="$(extract_block secrets)"
SECRET_ENVS="$(printf '%s\n' "$SECRETS_BLOCK" | grep -E '^[[:space:]]*env:' | sed -E 's/^[[:space:]]*env:[[:space:]]*//')"
if [ -z "$SECRET_ENVS" ]; then
  bad "secrets:" "no secrets[].env entries found"
else
  while IFS= read -r envvar; do
    [ -z "$envvar" ] && continue
    if grep -q "process\.env\.${envvar}\b" "$CONFIG_SRC" 2>/dev/null; then
      ok "secrets env '$envvar' still read by config.ts"
    else
      bad "secrets env '$envvar'" "not found as process.env.${envvar} in $CONFIG_SRC — env var may have been renamed/removed"
    fi
  done <<< "$SECRET_ENVS"
fi

ALL_PLACEHOLDERS="$(grep -oE '\$\{[A-Z_][A-Z0-9_]*\}' "$CATALOG" | sed -E 's/^\$\{(.*)\}$/\1/' | sort -u)"
if [ -n "$ALL_PLACEHOLDERS" ]; then
  while IFS= read -r ph; do
    [ -z "$ph" ] && continue
    if printf '%s\n' "$SECRET_ENVS" | grep -qx "$ph"; then
      ok "placeholder \${$ph} has a matching secrets[].env entry"
    else
      bad "placeholder \${$ph}" "no secrets[].env: $ph entry — dangling reference"
    fi
  done <<< "$ALL_PLACEHOLDERS"
fi

METADATA_BLOCK="$(extract_block metadata)"
for k in category license owner; do
  v="$(printf '%s\n' "$METADATA_BLOCK" | grep -E "^  ${k}:" | head -1 | sed -E "s/^  ${k}:[[:space:]]*//")"
  [ -n "$v" ] && ok "metadata.$k: '$v'" || bad "metadata.$k" "missing or empty"
done
TAGS="$(printf '%s\n' "$METADATA_BLOCK" | grep -E '^    - ')"
[ -n "$TAGS" ] && ok "metadata.tags present ($(printf '%s\n' "$TAGS" | wc -l | tr -d ' ') entries)" \
  || bad "metadata.tags" "no tags found"

if [ "$SCHEMA_ONLY" = true ]; then
  echo "==> (schema-only mode — skipping docker CLI + live gateway checks)"
  [ "$fail" -eq 0 ] && echo "==> PASS" || echo "==> FAIL"
  exit "$fail"
fi

echo "==> [B] docker mcp CLI schema validate (best-effort)"
if command -v docker >/dev/null 2>&1 && docker mcp --help >/dev/null 2>&1; then
  TMP_CATALOG_NAME="myai-catalog-check-$$"
  DOCKER_MCP_CATALOGS_DIR="$HOME/.docker/mcp/catalogs"
  mkdir -p "$DOCKER_MCP_CATALOGS_DIR"
  sed "s/^name: myai$/name: ${TMP_CATALOG_NAME}/" "$CATALOG" > "$DOCKER_MCP_CATALOGS_DIR/${TMP_CATALOG_NAME}-server.yaml"
  cleanup_b() {
    docker mcp catalog remove "${TMP_CATALOG_NAME}:latest" >/dev/null 2>&1 || true
    rm -f "$DOCKER_MCP_CATALOGS_DIR/${TMP_CATALOG_NAME}-server.yaml"
  }
  trap cleanup_b RETURN 2>/dev/null || true
  if docker mcp catalog create "$TMP_CATALOG_NAME" --server "file://${TMP_CATALOG_NAME}-server.yaml" --title "myAI Gateway (check)" >/dev/null 2>&1 \
    && docker mcp catalog show "${TMP_CATALOG_NAME}:latest" >/dev/null 2>&1; then
    ok "docker mcp catalog create/show parses the file without error"
  else
    bad "docker mcp catalog create/show" "the CLI rejected the catalog file — schema is no longer valid docker-mcp format"
  fi
  cleanup_b
else
  skip "docker mcp CLI not available on this machine (Docker Desktop MCP Toolkit only)"
fi

echo "==> [C] Live gateway discovery (best-effort)"
if [ -n "$GATEWAY_URL_OVERRIDE" ]; then
  GATEWAY_URL="$GATEWAY_URL_OVERRIDE"
else
  GATEWAY_URL="$(printf '%s' "$URL" | sed -E 's#host\.docker\.internal#localhost#')"
fi
DISCOVERY="$(curl -sf -m 5 "$GATEWAY_URL" 2>/dev/null)"
if [ -z "$DISCOVERY" ]; then
  skip "gateway not reachable at $GATEWAY_URL — skipping live check"
else
  LIVE_TRANSPORT="$(printf '%s' "$DISCOVERY" | /usr/bin/python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("transport",""))
except Exception:
    print("")' 2>/dev/null)"
  [ "$LIVE_TRANSPORT" = "$TRANSPORT" ] \
    && ok "live gateway transport ('$LIVE_TRANSPORT') matches catalog remote.transport_type" \
    || bad "live gateway transport" "gateway reports transport='$LIVE_TRANSPORT' but catalog declares '$TRANSPORT'"

  LIVE_TOOL_COUNT="$(printf '%s' "$DISCOVERY" | /usr/bin/python3 -c 'import json,sys
try:
    print(len(json.load(sys.stdin).get("toolNames") or []))
except Exception:
    print(0)' 2>/dev/null)"
  [ "${LIVE_TOOL_COUNT:-0}" -gt 0 ] 2>/dev/null \
    && ok "live gateway reports $LIVE_TOOL_COUNT tools on /mcp" \
    || bad "live gateway tools" "gateway's /mcp discovery reported zero tools"

  # Future-proofing: if the catalog ever declares its own tools: list, every
  # declared tool must actually exist on the live gateway.
  DECLARED_TOOLS="$(grep -A200 '^tools:' "$CATALOG" 2>/dev/null | grep -E '^[[:space:]]*-?[[:space:]]*name:' | sed -E 's/^[[:space:]]*-?[[:space:]]*name:[[:space:]]*//')"
  if [ -n "$DECLARED_TOOLS" ]; then
    while IFS= read -r t; do
      [ -z "$t" ] && continue
      if printf '%s' "$DISCOVERY" | grep -q "\"$t\""; then
        ok "declared tool '$t' exists on the live gateway"
      else
        bad "declared tool '$t'" "not present in the gateway's live tool list — catalog is stale"
      fi
    done <<< "$DECLARED_TOOLS"
  fi
fi

if [ "$fail" -eq 0 ]; then
  echo "==> PASS"
else
  echo "==> FAIL"
fi
exit "$fail"

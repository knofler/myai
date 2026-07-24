#!/usr/bin/env bash
# myai_login.sh — authenticate this terminal against a HOSTED myAI gateway.
#
# End-user session identity, NOT credential plumbing:
#   • distinct from `myai config` (scripts/lib/myai_config.sh) — that sets raw
#     ~/.myai/config keys with no round-trip check; `login` VALIDATES a key
#     against the gateway's GET /api/auth/whoami before persisting anything.
#   • distinct from `myai rotate-keys tenant` (operator CRUD on a tenant's
#     bootstrap key, local-trust only) — this is the tenant's OWN per-tenant
#     API key (myai_live_… / myai_test_…), the credential a real end user
#     holds after signing up on the hosted gateway.
#
# Auth mode: --key (or MYAI_API_KEY env, or an interactive hidden prompt).
# A device-code flow is intentionally NOT implemented here (no such gateway
# endpoint exists yet) — key-based login is the full v1 surface.
#
# On success, persists NON-secret identity into $MYAI_HOME/config (via
# myai_config.sh, same store `myai init` uses for brain wiring) and the raw
# key into $MYAI_HOME/credentials (chmod 600, never inside config — config is
# the file a brain-remote offer / support bundle might surface, credentials
# never should be).
#
# Usage:
#   myai_login.sh [--key <apiKey>] [--gateway-url URL] [--json]
#
# Tests: scripts/tests/test_myai_login.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=lib/myai_config.sh
. "$HERE/lib/myai_config.sh"

usage() {
  cat <<'EOF'
Usage: myai login [--key <apiKey>] [--gateway-url URL] [--json]

Authenticates the CLI against a hosted myAI gateway. The key is validated via
GET /api/auth/whoami before anything is persisted. Non-secret identity
(gatewayUrl, tenantId, org, plan) is stored in ~/.myai/config; the raw key is
stored separately in ~/.myai/credentials (chmod 600).

  --key <apiKey>       the tenant's API key (myai_live_… / myai_test_…).
                        Falls back to $MYAI_API_KEY, then an interactive
                        hidden prompt (TTY only).
  --gateway-url URL     hosted gateway base URL (default: $GATEWAY_URL or
                        http://localhost:3100)
  --json                machine-readable output
EOF
}

gateway_url="${GATEWAY_URL:-http://localhost:${MYAI_MCP_PORT:-3100}}"
api_key="${MYAI_API_KEY:-}"
as_json=0

while [ $# -gt 0 ]; do
  case "$1" in
    --key) api_key="$2"; shift 2 ;;
    --gateway-url) gateway_url="$2"; shift 2 ;;
    --json) as_json=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "myai login: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$api_key" ]; then
  if [ -t 0 ]; then
    printf 'myAI API key (myai_live_… / myai_test_…): '
    read -rs api_key || api_key=""
    echo
  fi
fi

if [ -z "$api_key" ]; then
  echo "myai login: no key provided — pass --key, set MYAI_API_KEY, or run interactively" >&2
  exit 2
fi

resp="$(curl -s -w '\n%{http_code}' --max-time 10 "$gateway_url/api/auth/whoami" \
  -H "authorization: Bearer $api_key" 2>/dev/null)" || {
  echo "myai login: failed to reach $gateway_url — is the gateway URL correct and reachable?" >&2
  exit 1
}
http_code="${resp##*$'\n'}"
body="${resp%$'\n'*}"
if [ -z "$http_code" ] || ! [ "$http_code" -eq "$http_code" ] 2>/dev/null; then
  echo "myai login: failed to reach $gateway_url — is the gateway URL correct and reachable?" >&2
  exit 1
fi

if [ "$http_code" != "200" ]; then
  echo "myai login: authentication failed (HTTP $http_code) — check the key and gateway URL" >&2
  exit 1
fi

tenant_id="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tenantId") or "")' 2>/dev/null || true)"
org="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("org") or "")' 2>/dev/null || true)"
plan="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("plan") or "")' 2>/dev/null || true)"

if [ -z "$tenant_id" ]; then
  echo "myai login: unexpected response from $gateway_url/api/auth/whoami" >&2
  exit 1
fi

myai_config_set "auth.gatewayUrl" "$gateway_url" >/dev/null
myai_config_set "auth.tenantId" "$tenant_id" >/dev/null
myai_config_set "auth.org" "$org" >/dev/null
myai_config_set "auth.plan" "$plan" >/dev/null

home="$(myai_config_home)"
mkdir -p "$home"
cred_file="$home/credentials"
umask 077
printf '%s\n' "$api_key" > "$cred_file"
chmod 600 "$cred_file" 2>/dev/null || true

if [ "$as_json" = 1 ]; then
  printf '%s\n' "$body"
else
  echo "myai: logged in to $gateway_url"
  echo "  org:    ${org:-(none)}"
  echo "  tenant: $tenant_id"
  echo "  plan:   ${plan:-(unknown)}"
  echo "  credential saved to $cred_file"
fi

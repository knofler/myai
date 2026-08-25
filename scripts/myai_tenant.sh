#!/usr/bin/env bash
# myai_tenant.sh — operator tenant lifecycle CRUD from the terminal
# (`myai tenant create|list|suspend|reactivate|rotate-key`).
#
# Wraps the gateway's admin-gated tenant endpoints (runtime/src/core/server.ts):
#   POST   /api/tenants                — create (+ first API key, show-once)
#   GET    /api/tenants                — list (+ ?status/?plan/?limit filters)
#   POST   /api/tenants/:id/suspend    — suspend (blocks every key call instantly)
#   POST   /api/tenants/:id/reactivate — restore to active
# `rotate-key` delegates to the existing `myai_rotate_keys.sh tenant` subcommand
# (POST /api/auth/tenant-key/rotate, local-trust-gated) rather than duplicating
# that grace-window rotation logic here.
#
# AUTH: two headers, same posture as scripts/lib/gateway.sh's rationale —
#   x-gateway-local-token — passes the global authenticate() gate (loopback OR
#                            a matching GATEWAY_LOCAL_TOKEN; see lib/gateway.sh).
#   x-admin-token          — passes the route-level requireAdmin gate
#                            (ADMIN_API_TOKEN on the gateway; 503 if unset there).
# Both resolve from env, falling back to the repo .env (create/list/suspend/
# reactivate need ADMIN_API_TOKEN configured server-side — there is no
# operator-CRUD equivalent without it, unlike the local-trust-only rotate path).
#
# Usage:
#   myai_tenant.sh create --tenant-id <id> --name <name> [--plan free|solo|team|scale]
#                          [--owner-email <email>] [--env live|test] [--gateway-url URL]
#   myai_tenant.sh list [--status active|suspended|deleted] [--plan <plan>]
#                        [--limit N] [--gateway-url URL]
#   myai_tenant.sh suspend <tenantId> [--reason "..."] [--gateway-url URL]
#   myai_tenant.sh reactivate <tenantId> [--gateway-url URL]
#   myai_tenant.sh rotate-key <tenantId> [--grace-minutes N] [--env live|test] [--gateway-url URL]
#
# Tests: scripts/tests/test_myai_tenant.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  myai_tenant.sh create --tenant-id <id> --name <name> [--plan free|solo|team|scale]
                         [--owner-email <email>] [--env live|test] [--gateway-url URL]
  myai_tenant.sh list [--status active|suspended|deleted] [--plan <plan>]
                       [--limit N] [--gateway-url URL]
  myai_tenant.sh suspend <tenantId> [--reason "..."] [--gateway-url URL]
  myai_tenant.sh reactivate <tenantId> [--gateway-url URL]
  myai_tenant.sh rotate-key <tenantId> [--grace-minutes N] [--env live|test] [--gateway-url URL]
EOF
}

# shellcheck source=lib/gateway.sh
. "$HERE/lib/gateway.sh"

resolve_admin_token() {
  if [ -z "${ADMIN_API_TOKEN:-}" ]; then
    local envf="$REPO_ROOT/.env" t
    if [ -f "$envf" ]; then
      t="$(grep -E '^ADMIN_API_TOKEN=' "$envf" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'\''' | xargs 2>/dev/null || true)"
      [ -n "$t" ] && ADMIN_API_TOKEN="$t"
    fi
  fi
}

default_gateway_url() {
  echo "${GATEWAY_URL:-http://localhost:${MYAI_MCP_PORT:-3100}}"
}

# admin_call <method> <path> [json-body]
admin_call() {
  local method="$1" path="$2" body="${3:-}"
  resolve_admin_token
  if [ -z "${ADMIN_API_TOKEN:-}" ]; then
    echo "myai tenant: ADMIN_API_TOKEN not set (env or repo .env) — required for create/list/suspend/reactivate" >&2
    exit 1
  fi
  local args=(-sf -X "$method" "${GATEWAY_URL_RESOLVED}${path}" \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -H "x-admin-token: $ADMIN_API_TOKEN")
  if [ -n "$body" ]; then
    args+=(-H 'content-type: application/json' -d "$body")
  fi
  curl "${args[@]}"
}

cmd_create() {
  local tenant_id="" name="" plan="" owner_email="" env="" gateway_url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tenant-id) tenant_id="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --plan) plan="$2"; shift 2 ;;
      --owner-email) owner_email="$2"; shift 2 ;;
      --env) env="$2"; shift 2 ;;
      --gateway-url) gateway_url="$2"; shift 2 ;;
      *) echo "myai tenant create: unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done
  [ -n "$tenant_id" ] || { echo "myai tenant create: --tenant-id required" >&2; usage; exit 2; }
  [ -n "$name" ] || { echo "myai tenant create: --name required" >&2; usage; exit 2; }
  GATEWAY_URL_RESOLVED="${gateway_url:-$(default_gateway_url)}"

  local body
  body="$(python3 - "$tenant_id" "$name" "$plan" "$owner_email" "$env" <<'PY'
import json, sys
tenant_id, name, plan, owner_email, env = sys.argv[1:6]
payload = {"tenantId": tenant_id, "name": name}
if plan: payload["plan"] = plan
if owner_email: payload["ownerEmail"] = owner_email
if env: payload["env"] = env
print(json.dumps(payload))
PY
)"

  local resp
  resp="$(admin_call POST /api/tenants "$body")" || { echo "myai tenant create: request failed — is the gateway reachable and ADMIN_API_TOKEN correct?" >&2; exit 1; }
  echo "$resp"
  echo
  echo "NOTE: rawKey above is shown ONCE — save it now before it's lost."
}

cmd_list() {
  local status="" plan="" limit="" gateway_url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --status) status="$2"; shift 2 ;;
      --plan) plan="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      --gateway-url) gateway_url="$2"; shift 2 ;;
      *) echo "myai tenant list: unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done
  GATEWAY_URL_RESOLVED="${gateway_url:-$(default_gateway_url)}"

  local qs="" sep="?"
  if [ -n "$status" ]; then qs="${qs}${sep}status=$status"; sep="&"; fi
  if [ -n "$plan" ]; then qs="${qs}${sep}plan=$plan"; sep="&"; fi
  if [ -n "$limit" ]; then qs="${qs}${sep}limit=$limit"; sep="&"; fi

  admin_call GET "/api/tenants${qs}" || { echo "myai tenant list: request failed — is the gateway reachable and ADMIN_API_TOKEN correct?" >&2; exit 1; }
  echo
}

cmd_suspend() {
  local tenant_id="" reason="" gateway_url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --reason) reason="$2"; shift 2 ;;
      --gateway-url) gateway_url="$2"; shift 2 ;;
      -*) echo "myai tenant suspend: unknown arg: $1" >&2; usage; exit 2 ;;
      *) tenant_id="$1"; shift ;;
    esac
  done
  [ -n "$tenant_id" ] || { echo "myai tenant suspend: <tenantId> required" >&2; usage; exit 2; }
  GATEWAY_URL_RESOLVED="${gateway_url:-$(default_gateway_url)}"

  local body
  body="$(python3 - "$reason" <<'PY'
import json, sys
reason = sys.argv[1]
payload = {}
if reason: payload["reason"] = reason
print(json.dumps(payload))
PY
)"
  admin_call POST "/api/tenants/$tenant_id/suspend" "$body" || { echo "myai tenant suspend: request failed" >&2; exit 1; }
  echo
}

cmd_reactivate() {
  local tenant_id="" gateway_url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --gateway-url) gateway_url="$2"; shift 2 ;;
      -*) echo "myai tenant reactivate: unknown arg: $1" >&2; usage; exit 2 ;;
      *) tenant_id="$1"; shift ;;
    esac
  done
  [ -n "$tenant_id" ] || { echo "myai tenant reactivate: <tenantId> required" >&2; usage; exit 2; }
  GATEWAY_URL_RESOLVED="${gateway_url:-$(default_gateway_url)}"

  admin_call POST "/api/tenants/$tenant_id/reactivate" "{}" || { echo "myai tenant reactivate: request failed" >&2; exit 1; }
  echo
}

cmd_rotate_key() {
  local tenant_id="" grace_minutes="" env="" gateway_url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --grace-minutes) grace_minutes="$2"; shift 2 ;;
      --env) env="$2"; shift 2 ;;
      --gateway-url) gateway_url="$2"; shift 2 ;;
      -*) echo "myai tenant rotate-key: unknown arg: $1" >&2; usage; exit 2 ;;
      *) tenant_id="$1"; shift ;;
    esac
  done
  [ -n "$tenant_id" ] || { echo "myai tenant rotate-key: <tenantId> required" >&2; usage; exit 2; }

  local args=(tenant "$tenant_id")
  [ -n "$grace_minutes" ] && args+=(--grace-minutes "$grace_minutes")
  [ -n "$env" ] && args+=(--env "$env")
  [ -n "$gateway_url" ] && args+=(--gateway-url "$gateway_url")
  exec "$HERE/myai_rotate_keys.sh" "${args[@]}"
}

[ $# -ge 1 ] || { usage; exit 2; }
cmd="$1"; shift
case "$cmd" in
  create) cmd_create "$@" ;;
  list) cmd_list "$@" ;;
  suspend) cmd_suspend "$@" ;;
  reactivate) cmd_reactivate "$@" ;;
  rotate-key) cmd_rotate_key "$@" ;;
  -h|--help) usage ;;
  *) echo "myai tenant: unknown subcommand: $cmd" >&2; usage; exit 2 ;;
esac

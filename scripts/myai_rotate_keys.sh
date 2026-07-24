#!/usr/bin/env bash
# myai_rotate_keys.sh — self-rotation for the two static gateway credentials,
# each with a DUAL-VALID grace window so nothing 401s mid-rotation:
#
#   local  <grace-min>   — GATEWAY_LOCAL_TOKEN (scripts/lib/gateway.sh), the
#                          shared secret host scripts/the CLI runner send as
#                          `x-gateway-local-token` over the Docker bridge.
#                          Rewrites .env: new token becomes GATEWAY_LOCAL_TOKEN,
#                          the old one becomes GATEWAY_LOCAL_TOKEN_PREVIOUS with
#                          a GATEWAY_LOCAL_TOKEN_PREVIOUS_EXPIRES_AT cutoff.
#                          auth.ts (resolveNoKey) accepts EITHER until the
#                          cutoff passes. Purely file-based — the running
#                          gateway process only picks up the new value on its
#                          next restart/rebuild (never done by this script;
#                          see the repo's gateway DEPLOY GUARD).
#
#   tenant <tenantId>     — a tenant's legacy bootstrap API key
#                          (core/tenant-keys.ts), the credential the off-hours
#                          CLI runner and other machine callers hold
#                          (scripts/lib/tenant_keys.sh). Calls the gateway's
#                          POST /api/auth/tenant-key/rotate (local-trust only —
#                          loopback or a valid GATEWAY_LOCAL_TOKEN), which mints
#                          a new key and keeps the OLD one valid server-side
#                          (TenantModel.apiKeyHashPrevious) until its grace
#                          cutoff. The new raw key is shown ONCE — save it into
#                          ~/.ai-cli-runner/tenant-keys.env yourself.
#
# Both default to a 60-minute grace window (env TENANT_KEY_ROTATION_GRACE_MINUTES /
# no local-side default override needed — pass --grace-minutes to change either).
# `--grace-minutes 0` is an immediate cutover (no old credential kept valid).
#
# Usage:
#   myai_rotate_keys.sh local  [--grace-minutes N] [--env-file PATH]
#   myai_rotate_keys.sh tenant <tenantId> [--grace-minutes N] [--env live|test] [--gateway-url URL]
#
# Tests: scripts/tests/test_myai_rotate_keys.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  myai_rotate_keys.sh local  [--grace-minutes N] [--env-file PATH]
  myai_rotate_keys.sh tenant <tenantId> [--grace-minutes N] [--env live|test] [--gateway-url URL]
EOF
}

# ── generic .env upsert/unset (portable — temp file + mv, no `sed -i`) ────────
env_upsert() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if [ -f "$file" ]; then
    grep -v "^${key}=" "$file" > "$tmp" 2>/dev/null || true
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$file"
}

env_unset() {
  local file="$1" key="$2" tmp
  [ -f "$file" ] || return 0
  tmp="$(mktemp "${file}.XXXXXX")"
  grep -v "^${key}=" "$file" > "$tmp" 2>/dev/null || true
  mv "$tmp" "$file"
}

env_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  fi
}

now_ms() { echo $(( $(date +%s) * 1000 )); }

rotate_local() {
  local grace_minutes=60 env_file="$REPO_ROOT/.env"
  while [ $# -gt 0 ]; do
    case "$1" in
      --grace-minutes) grace_minutes="$2"; shift 2 ;;
      --env-file) env_file="$2"; shift 2 ;;
      *) echo "myai rotate-keys local: unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done
  case "$grace_minutes" in ''|*[!0-9]*) echo "--grace-minutes must be a non-negative integer" >&2; exit 2 ;; esac

  local old_token new_token
  old_token="$(env_get "$env_file" GATEWAY_LOCAL_TOKEN)"
  new_token="$(gen_secret)"

  env_upsert "$env_file" GATEWAY_LOCAL_TOKEN "$new_token"
  if [ "$grace_minutes" -gt 0 ] && [ -n "$old_token" ]; then
    local expires_at
    expires_at=$(( $(now_ms) + grace_minutes * 60000 ))
    env_upsert "$env_file" GATEWAY_LOCAL_TOKEN_PREVIOUS "$old_token"
    env_upsert "$env_file" GATEWAY_LOCAL_TOKEN_PREVIOUS_EXPIRES_AT "$expires_at"
    echo "Rotated GATEWAY_LOCAL_TOKEN in $env_file — old token stays valid for ${grace_minutes}m."
  else
    env_unset "$env_file" GATEWAY_LOCAL_TOKEN_PREVIOUS
    env_unset "$env_file" GATEWAY_LOCAL_TOKEN_PREVIOUS_EXPIRES_AT
    echo "Rotated GATEWAY_LOCAL_TOKEN in $env_file — immediate cutover (no grace)."
  fi
  echo "New token: $new_token"
  echo "NOTE: the running gateway only picks this up on its next restart/rebuild —"
  echo "      that redeploy is NOT run by this script (gateway deploys are a"
  echo "      master-checkout/selfheal operation)."
}

rotate_tenant() {
  local tenant_id="" grace_minutes="" env="live"
  local gateway_url="${GATEWAY_URL:-http://localhost:${MYAI_MCP_PORT:-3100}}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --grace-minutes) grace_minutes="$2"; shift 2 ;;
      --env) env="$2"; shift 2 ;;
      --gateway-url) gateway_url="$2"; shift 2 ;;
      -*) echo "myai rotate-keys tenant: unknown arg: $1" >&2; usage; exit 2 ;;
      *) tenant_id="$1"; shift ;;
    esac
  done
  [ -n "$tenant_id" ] || { echo "myai rotate-keys tenant: <tenantId> required" >&2; usage; exit 2; }

  # shellcheck source=lib/gateway.sh
  . "$HERE/lib/gateway.sh"

  local body
  body="$(python3 - "$tenant_id" "$env" "$grace_minutes" <<'PY'
import json, sys
tenant_id, env, grace = sys.argv[1], sys.argv[2], sys.argv[3]
payload = {"tenantId": tenant_id, "env": env}
if grace != "":
    payload["graceMinutes"] = int(grace)
print(json.dumps(payload))
PY
)"

  local resp
  resp="$(curl -sf -X POST "$gateway_url/api/auth/tenant-key/rotate" \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -d "$body")" || { echo "rotate failed — is the gateway reachable at $gateway_url?" >&2; exit 1; }

  echo "$resp"
  echo
  echo "NOTE: rawKey above is shown ONCE — save it now (e.g. into"
  echo "      ~/.ai-cli-runner/tenant-keys.env as '${tenant_id}=<rawKey>') before it's lost."
}

[ $# -ge 1 ] || { usage; exit 2; }
cmd="$1"; shift
case "$cmd" in
  local) rotate_local "$@" ;;
  tenant) rotate_tenant "$@" ;;
  -h|--help) usage ;;
  *) echo "myai rotate-keys: unknown subcommand: $cmd" >&2; usage; exit 2 ;;
esac

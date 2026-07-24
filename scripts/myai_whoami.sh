#!/usr/bin/env bash
# myai_whoami.sh — print the active org/tenant/plan/quota for the credential
# `myai login` saved. Always round-trips to the gateway (never trusts the
# cached ~/.myai/config identity alone) so quota numbers are live.
#
# Usage: myai_whoami.sh [--gateway-url URL] [--json]
#
# Tests: scripts/tests/test_myai_whoami.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=lib/myai_config.sh
. "$HERE/lib/myai_config.sh"

usage() {
  cat <<'EOF'
Usage: myai whoami [--gateway-url URL] [--json]

Prints the org/tenant/plan/quota for the session `myai login` established.
Not logged in? Run `myai login` first.

  --gateway-url URL   override the stored gateway URL
  --json              machine-readable output (the raw gateway response)
EOF
}

as_json=0
gateway_url_override=""

while [ $# -gt 0 ]; do
  case "$1" in
    --gateway-url) gateway_url_override="$2"; shift 2 ;;
    --json) as_json=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "myai whoami: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

home="$(myai_config_home)"
cred_file="$home/credentials"

if [ ! -f "$cred_file" ]; then
  echo "myai whoami: not logged in — run 'myai login' first" >&2
  exit 1
fi
api_key="$(head -1 "$cred_file" 2>/dev/null || true)"
if [ -z "$api_key" ]; then
  echo "myai whoami: no credential found in $cred_file — run 'myai login' again" >&2
  exit 1
fi

gateway_url="$gateway_url_override"
[ -n "$gateway_url" ] || gateway_url="$(myai_config_get "auth.gatewayUrl" 2>/dev/null || true)"
gateway_url="${gateway_url:-http://localhost:${MYAI_MCP_PORT:-3100}}"

resp="$(curl -s -w '\n%{http_code}' --max-time 10 "$gateway_url/api/auth/whoami" \
  -H "authorization: Bearer $api_key" 2>/dev/null)" || {
  echo "myai whoami: failed to reach $gateway_url — is the gateway reachable?" >&2
  exit 1
}
http_code="${resp##*$'\n'}"
body="${resp%$'\n'*}"

if [ "$http_code" != "200" ]; then
  echo "myai whoami: session invalid or expired (HTTP $http_code) — run 'myai login' again" >&2
  exit 1
fi

if [ "$as_json" = 1 ]; then
  printf '%s\n' "$body"
  exit 0
fi

python3 - "$body" "$gateway_url" <<'PY'
import json, sys
body, gateway_url = sys.argv[1], sys.argv[2]
d = json.loads(body)
quota = d.get("quota") or {}
monthly = quota.get("monthlyRequests") or {}
used = monthly.get("used")
limit = monthly.get("limit")
limit_str = "unlimited" if limit is None or limit < 0 else str(limit)
rpm = quota.get("requestsPerMin")
rpm_str = "unlimited" if rpm is None or rpm < 0 else str(rpm)
print(f"myai: {gateway_url}")
print(f"  org:              {d.get('org') or '(none)'}")
print(f"  tenant:           {d.get('tenantId') or '(unknown)'}")
print(f"  plan:             {d.get('plan') or '(unknown)'}")
print(f"  role:             {d.get('role') or '(none)'}")
print(f"  monthly requests: {used}/{limit_str} ({quota.get('period') or '?'})")
print(f"  rate limit:       {rpm_str}/min")
PY

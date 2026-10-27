#!/usr/bin/env bash
# usage_reading.sh — give the shared usage ledger an operator /usage reading or
# an account asset, and see every account's quota across all Macs.
# Multi-Mac phase 2 (plan/MULTI_MAC_SWARM_BRIEF.md); gateway tools
# account_usage_record / account_usage_status.
#
# The statusLine already sends REAL 5h / weekly % whenever a session for the
# account is open; an operator reading is only needed for what it lacks — the
# per-model weekly rows (Fable-only / Opus-only), roughly once a week.
#
# Usage:
#   usage_reading.sh add <account> [5h=N] [week=N] [fable=N] [opus=N] [at=ISO] [note="…"]
#        e.g. usage_reading.sh add tech 5h=3 week=20 fable=5
#   usage_reading.sh asset <account> <full_reset|cloud_credit|spend_flag> [usd=N] [expires=YYYY-MM-DD] [active=false] [note="…"]
#        e.g. usage_reading.sh asset personal cloud_credit usd=100 expires=2026-11-05
#   usage_reading.sh status [account]     one line per account (5h · week · source · headroom · flags)
#   usage_reading.sh status --json        the raw account_usage_status result
# Tests: scripts/tests/test_usage_ledger.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -z "${GATEWAY_LOCAL_TOKEN:-}" ] && [ -f "$HERE/lib/gateway.sh" ]; then
  # shellcheck source=scripts/lib/gateway.sh
  . "$HERE/lib/gateway.sh" 2>/dev/null || true
fi
export GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
export USAGE_GATEWAY_URL="${USAGE_GATEWAY_URL:-http://localhost:${MCP_PORT:-3100}/mcp}"
HOST_LC="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
cmd="${1:-status}"; [ $# -gt 0 ] && shift
case "$cmd" in
  add|asset|status) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
CMD="$cmd" HOST_LC="$HOST_LC" python3 - "$@" <<'PY'
import json, os, sys, time, urllib.request
cmd, argv = os.environ["CMD"], sys.argv[1:]

def call(tool, args):
    body = json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 1,
                       "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(os.environ["USAGE_GATEWAY_URL"], data=body, method="POST",
                                 headers={"content-type": "application/json", "x-gateway-local-token": os.environ["GATEWAY_LOCAL_TOKEN"]})
    try:
        with urllib.request.urlopen(req, timeout=float(os.environ.get('USAGE_TIMEOUT', '15'))) as r:
            out = json.loads(r.read().decode())
    except Exception as e:
        sys.exit("usage_reading: gateway unreachable (%s)" % e)
    res = json.loads(out["result"]["content"][0]["text"])
    if isinstance(res, dict) and res.get("error"):
        sys.exit("usage_reading: refused — %s" % res["error"])
    return res

def kv(items):
    d = {}
    for a in items:
        k, sep, v = a.partition("=")
        if not sep:
            sys.exit("usage_reading: expected key=value, got %r" % a)
        d[k.strip().lower()] = v
    return d

def num(v, what):
    try:
        return float(v)
    except ValueError:
        sys.exit("usage_reading: %s must be a number" % what)

if cmd == "add":
    if not argv:
        sys.exit("usage_reading: add <account> 5h=N week=N fable=N opus=N")
    acct, opts = argv[0], kv(argv[1:])
    rec = {"account": acct, "host": os.environ["HOST_LC"], "source": "operator",
           "at": opts.get("at") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    for key, field in (("5h", "fiveHourPct"), ("week", "sevenDayPct"), ("fable", "fablePct"), ("opus", "opusPct")):
        if key in opts:
            rec[field] = num(opts[key], key)
    if "note" in opts:
        rec["note"] = opts["note"]
    call("account_usage_record", {"readings": [rec]})
    print("usage_reading: recorded %s reading for %s at %s" % (", ".join(k for k in ("5h", "week", "fable", "opus") if k in opts), acct, rec["at"]))
elif cmd == "asset":
    if len(argv) < 2:
        sys.exit("usage_reading: asset <account> <full_reset|cloud_credit|spend_flag> [usd=N] [expires=YYYY-MM-DD]")
    acct, kind, opts = argv[0], argv[1], kv(argv[2:])
    rec = {"account": acct, "kind": kind}
    if "usd" in opts:
        rec["usd"] = num(opts["usd"], "usd")
    if "expires" in opts:
        rec["expires"] = opts["expires"]
    if "active" in opts:
        rec["active"] = opts["active"].lower() == "true"
    if "note" in opts:
        rec["note"] = opts["note"]
    call("account_usage_record", {"assets": [rec]})
    print("usage_reading: asset %s for %s saved" % (kind, acct))
else:
    as_json = "--json" in argv
    rest = [a for a in argv if a != "--json"]
    res = call("account_usage_status", {"account": rest[0]} if rest else {})
    if as_json:
        print(json.dumps(res, indent=1)); sys.exit(0)
    if not res.get("connected", True):
        sys.exit("usage_reading: gateway has no database — no ledger")
    def w(x):
        if x["pct"] is None:
            return "  ?  (%s)" % x["source"]
        return "%3.0f%% (%s)" % (x["pct"], x["source"])
    if not res["accounts"]:
        print("usage ledger: no data yet (scripts/usage_push.sh --force, or open a session on an account)")
    for a in res["accounts"]:
        hr = "headroom %+.0f%%" % a["headroomPct"] if a["headroomPct"] is not None else "headroom ?"
        extra = []
        if a["hot"]:
            extra.append("IN USE")
        extra += a["flags"]
        print("%-9s 5h %-15s week %-15s %s%s" % (a["account"], w(a["fiveHour"]), w(a["sevenDay"]), hr,
              (" · " + " · ".join(extra)) if extra else ""))
        for r in a["recommendations"]:
            print("          → " + r)
PY

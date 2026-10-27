#!/usr/bin/env bash
# account_balancer.sh (lib) — pick the runner ACCOUNT for a fire (multi-Mac
# phase 3, 2026-10-05). Sourced; bash 3.2-safe.
#
# Account budgets are per ACCOUNT and shared by both Macs (5-hour window +
# weekly limit). The gateway's usage ledger (account_usage_status, PR #504)
# already reports each account's headroomPct NET of the interactive reserve
# (33% weekly / 40% 5-hour) and a `hot` flag. The balancer:
#   • candidates: $RUNNER_ACCOUNTS (default "tech personal"); the swarm master
#     (role_is_master) is BANNED from autonomous runs and agy is not a runner
#     account — both are dropped even if listed;
#   • skips hot accounts and any with headroomPct <= 0;
#   • ranks by headroomPct, highest first (unknown headroom ranks last);
#   • takes the first account whose runner-slot lease it gets (rs_acquire), so
#     a busy account on the other Mac is skipped, not waited on.
#
#   ab_rank                 "<account> <headroom|?>" lines, best first (eligible only)
#   ab_pick                 → 0 + AB_ACCOUNT set (slot held) | 1 + AB_REASON
#   ab_opus_pct <account>   that account's Opus weekly usage % (empty = unknown)
#
# Tests: scripts/tests/test_runner_slot.sh.

# shellcheck disable=SC2034  # RS_* / AB_* globals are this lib's public results (read by the runner)
ab_candidates() {
  local a out=""
  # The master is configured per host (swarm_roles.sh), never named here.
  # shellcheck source=scripts/lib/swarm_roles.sh disable=SC1091
  type role_is_master >/dev/null 2>&1 || . "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/swarm_roles.sh" 2>/dev/null || true
  for a in ${RUNNER_ACCOUNTS:-tech personal}; do
    [ "$a" = agy ] && continue
    if type role_is_master >/dev/null 2>&1 && role_is_master "$a"; then continue; fi
    out="$out $a"
  done
  printf '%s' "${out# }"
}

# _ab_status → the raw account_usage_status JSON (overridable in tests).
_ab_status() { kl_call account_usage_status '{}'; }

AB_STATUS=""
ab_rank() {
  AB_STATUS="$(_ab_status 2>/dev/null)" || AB_STATUS=""
  printf '%s' "$AB_STATUS" | CANDS="$(ab_candidates)" /usr/bin/python3 -c '
import json, os, sys
cands = os.environ["CANDS"].split()
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception:
    d = {}
by = {a.get("account"): a for a in d.get("accounts") or []}
rows = []
for c in cands:
    a = by.get(c)
    if a is None:
        rows.append((c, None)); continue
    if a.get("hot"):
        continue
    h = a.get("headroomPct")
    if h is not None and h <= 0:
        continue
    rows.append((c, h))
rows.sort(key=lambda r: (r[1] is None, -(r[1] or 0)))
for c, h in rows:
    print(c, "?" if h is None else h)
' 2>/dev/null
}

AB_ACCOUNT="" AB_REASON="" AB_HEADROOM=""
ab_pick() {
  local ranked acct head busy=""
  AB_ACCOUNT="" AB_REASON="" AB_HEADROOM=""
  ranked="$(ab_rank)"
  if [ -z "$ranked" ]; then
    AB_REASON="no runner account has headroom (candidates: $(ab_candidates); hot or at/below the reserve)"
    return 1
  fi
  while read -r acct head; do
    [ -n "$acct" ] || continue
    if rs_acquire "$acct"; then
      AB_ACCOUNT="$acct"; AB_HEADROOM="$head"
      return 0
    fi
    busy="$busy $acct(${RS_HELD_BY:-busy})"
  done <<EOF
$ranked
EOF
  AB_REASON="every account with headroom is busy on another fire:$busy"
  return 1
}

ab_opus_pct() {
  printf '%s' "$AB_STATUS" | ACCT="$1" /usr/bin/python3 -c '
import json, os, sys
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception:
    sys.exit(0)
for a in d.get("accounts") or []:
    if a.get("account") == os.environ["ACCT"]:
        v = (a.get("perModel") or {}).get("opusPct")
        if v is not None:
            print(v)
' 2>/dev/null
}

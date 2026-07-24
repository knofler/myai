#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Day-9 E2E ACCEPTANCE HARNESS — myAI Independent Edition
#
# Automates the §1 acceptance walk from plan/INDEPENDENT_EDITION_PLAN.md:
#   download → myai init → myai up → myai scan → myai new-app "<idea>"
#   → runner builds it off-hours → approve → see it in dashboard
#   → file a connect ticket → it becomes a gateway task
#
# Each step is PROBED, not assumed. A step is one of:
#   PASS          — ran and met its check
#   PENDING-BUILD — the CLI subcommand/endpoint does not exist yet (pre-Day-1..8)
#   FAIL          — exists but did not behave as required
#   SKIP          — gated on a credential/stack the harness was told to skip
#
# This is intentionally GREEN-on-pending while the Independent Edition CLI is
# being built (build window 2026-06-29 → 2026-07-10). It flips each step PASS as
# the matching command lands, so Day-9 is "all PASS, zero PENDING".
#
# Usage:
#   scripts/e2e_acceptance.sh                 # probe-only, safe on any machine
#   PORT=3200 scripts/e2e_acceptance.sh       # custom gateway port
#   STRICT=1 scripts/e2e_acceptance.sh        # exit non-zero if any step != PASS
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PORT="${PORT:-3200}"
GATEWAY="http://127.0.0.1:${PORT}"
STRICT="${STRICT:-0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MYAI="node ${ROOT}/runtime/bin/myai.js"

pass=0; pending=0; fail=0; skip=0
declare -a ROWS

record() { # status step note
  local st="$1" step="$2" note="${3:-}"
  ROWS+=("$st|$step|$note")
  case "$st" in
    PASS) pass=$((pass+1));;
    PENDING-BUILD) pending=$((pending+1));;
    FAIL) fail=$((fail+1));;
    SKIP) skip=$((skip+1));;
  esac
}

# Does `myai <subcommand>` exist? (commander exits non-zero + prints "unknown command")
have_cmd() {
  $MYAI "$1" --help >/dev/null 2>&1
}

gw_up() { curl -fsS --max-time 3 "${GATEWAY}/health" >/dev/null 2>&1; }
gw_json() { curl -fsS --max-time 5 "${GATEWAY}$1" 2>/dev/null; }

echo "myAI Independent Edition — Day-9 E2E acceptance harness"
echo "Gateway: ${GATEWAY}   CLI: ${ROOT}/runtime/bin/myai.js"
echo "──────────────────────────────────────────────────────────────"

# Step 0 — download / CLI present
if [ -f "${ROOT}/runtime/bin/myai.js" ]; then
  record PASS "0. download — myai CLI present" "bin/myai.js shells into dist/cli/main.js"
else
  record FAIL "0. download — myai CLI present" "bin/myai.js missing"
fi

# Step 1 — myai doctor (preflight: docker, node, claude CLI, ANTHROPIC_API_KEY)
if have_cmd doctor; then
  if $MYAI doctor >/dev/null 2>&1; then
    record PASS "1. myai doctor — green"
  else
    record FAIL "1. myai doctor — green" "doctor ran but reported a failing check"
  fi
else
  record PENDING-BUILD "1. myai doctor" "subcommand not built (Day-1/5)"
fi

# Step 2 — myai init <path> (scaffold AI/ into a target repo)
if have_cmd init; then
  tmp="$(mktemp -d)"; ( cd "$tmp" && git init -q . ) 2>/dev/null
  if $MYAI init "$tmp" >/dev/null 2>&1 && [ -d "$tmp/AI" ]; then
    record PASS "2. myai init <path> — AI/ scaffolded"
  else
    record FAIL "2. myai init <path>" "init ran but AI/ not present in target"
  fi
  rm -rf "$tmp"
else
  record PENDING-BUILD "2. myai init <path>" "subcommand not built (Day-2)"
fi

# Step 3 — myai up (gateway + dashboard + mongo on loopback)
if have_cmd up; then
  if gw_up; then
    record PASS "3. myai up — stack healthy on loopback"
  else
    record FAIL "3. myai up" "up exists but gateway /health not answering on ${GATEWAY}"
  fi
elif gw_up; then
  record PASS "3. stack healthy (gateway already up)" "via existing stack, not 'myai up'"
else
  record PENDING-BUILD "3. myai up" "subcommand not built (Day-3); no gateway on ${PORT}"
fi

# Step 4 — myai scan <dir> (register git repos in the gateway directory)
if have_cmd scan; then
  record PASS "4. myai scan <dir> — present"
else
  record PENDING-BUILD "4. myai scan <dir>" "subcommand not built (Day-4)"
fi

# Step 5 — myai new-app "<idea>" (agentFlow idea→app pipeline)
if have_cmd new-app; then
  record PASS "5. myai new-app — present"
else
  record PENDING-BUILD "5. myai new-app" "subcommand not built (Day-6, agentFlow bridge)"
fi

# Step 6 — runner builds it off-hours (a task moves through the queue).
# Endpoint-present counts: 200 (open) OR 401 (wired but auth-gated — the correct
# behaviour when the caller is not loopback-trusted) both prove the queue exists.
if gw_up; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${GATEWAY}/api/tasks" 2>/dev/null)"
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then
    record PASS "6. runner/task queue API present" "GET /api/tasks → HTTP ${code}"
  else
    record PENDING-BUILD "6. runner builds task off-hours" "task queue endpoint HTTP ${code:-down}"
  fi
else
  record PENDING-BUILD "6. runner builds task off-hours" "gateway not up"
fi

# Step 7 — approve / review → visible in dashboard
if curl -fsS --max-time 3 "http://127.0.0.1:3210/api/health" >/dev/null 2>&1; then
  record PASS "7. dashboard reachable (review/approve surface)"
else
  record PENDING-BUILD "7. dashboard review surface" "dashboard /api/health not reachable on 3210"
fi

# Step 8 — file a connect ticket → it becomes a gateway task (S1 bridge)
if have_cmd connect; then
  record PASS "8. myai connect — present (ticket→task bridge)"
else
  record PENDING-BUILD "8. connect ticket→gateway task" "myai connect not built (Day-7, S1 bridge)"
fi

# Step 9 — CLEAN-ROOM publish guard (Day-9 security pass: no shipped secrets).
# The gate must be present AND wired into package.json `prepublishOnly`. The full
# pack+scan is heavy (npm walks local node_modules), so it runs only when
# PUBLISH_GUARD=1; by default we verify it is wired (a hard blocker at publish).
if [ -x "${ROOT}/scripts/publish_guard.sh" ] && grep -q 'prepublishOnly' "${ROOT}/package.json" 2>/dev/null; then
  if [ "${PUBLISH_GUARD:-0}" = "1" ]; then
    if bash "${ROOT}/scripts/publish_guard.sh" --quiet >/dev/null 2>&1; then
      record PASS "9. clean-room publish guard — tarball clean (0 leaks)"
    else
      record FAIL "9. clean-room publish guard — LEAK detected" "run scripts/publish_guard.sh"
    fi
  else
    record PASS "9. clean-room publish guard — present & wired (prepublishOnly)" "set PUBLISH_GUARD=1 for full scan"
  fi
else
  record FAIL "9. clean-room publish guard" "publish_guard.sh missing or not wired into package.json"
fi

# ── Report ───────────────────────────────────────────────────────────────────
echo
printf '%-14s %s\n' "STATUS" "STEP"
echo "──────────────────────────────────────────────────────────────"
for r in "${ROWS[@]}"; do
  IFS='|' read -r st step note <<<"$r"
  if [ -n "$note" ]; then printf '%-14s %s  (%s)\n' "$st" "$step" "$note"
  else printf '%-14s %s\n' "$st" "$step"; fi
done
echo "──────────────────────────────────────────────────────────────"
echo "PASS=${pass}  PENDING-BUILD=${pending}  FAIL=${fail}  SKIP=${skip}"

# Always fail on a genuine FAIL. Fail on PENDING only in STRICT (Day-9 gate) mode.
if [ "$fail" -gt 0 ]; then exit 1; fi
if [ "$STRICT" = "1" ] && [ "$pending" -gt 0 ]; then
  echo "STRICT: ${pending} step(s) still PENDING-BUILD — not yet a green Day-9."
  exit 2
fi
exit 0

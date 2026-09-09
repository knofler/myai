#!/usr/bin/env bash
# 25-boot-selfcheck.sh — BOOT self-check: one line at session start naming
# exactly what could NOT be evaluated. plan/MYTHOS_IMPROVEMENT_PLAN.md
# Track 1 #2 ("Silence is not health").
#
# PAST INCIDENT this guards against: a Mac returned after 7 weeks with every
# repo's .git missing, the gateway down, the brain 455 commits behind, and the
# myai MCP bridge dark — and every existing guard (17-schedule-status.sh,
# remote_fleet.sh, even 24-myai-mcp-health.sh, the hook written specifically
# for MCP outages one session earlier) degraded to a quiet, healthy-looking
# banner via `|| exit 0`. Nothing at session start told the operator the boot
# was broken. Five independent silent failures, in one boot.
#
# This hook is the terse, always-printed tripwire. It re-checks all four
# pillars itself — git / gateway / brain / mcp — independent of every other
# hook's exit code, so a sibling hook's silence can never hide a broken
# precondition from this line.
#
# Contract (never silent — always prints exactly one line to stdout):
#   - all four checks healthy   -> `boot: ok`
#   - any check degraded/failed -> `boot: git <s> - gateway <s> - brain <s> - mcp <s>`
#     naming ALL FOUR, not just the failing ones — so a partial failure is
#     never mistaken for "only that one thing broke" when in fact a sibling
#     check was simply never evaluated.
set +e

# ── resolve repo root (survives a missing/broken .git — see git check below) ──
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
GIT_STATUS="ok"
[ -z "$ROOT" ] && GIT_STATUS="FAIL (no .git)"
if [ -z "$ROOT" ]; then
  # Fall back to this script's own location so the other three checks can
  # still run for real instead of going dark just because git failed —
  # exactly the kind of cascading silent failure this hook exists to end.
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
fi

# ── gateway: HTTP /health on GATEWAY_HTTP_PORT (default 3200, same convention
#    as scripts/myai_status.sh) ────────────────────────────────────────────
GATEWAY_STATUS="ok"
GW_PORT="${MYAI_GATEWAY_HTTP_PORT:-3200}"
if command -v curl >/dev/null 2>&1; then
  GW_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 4 "http://localhost:${GW_PORT}/health" 2>/dev/null)"
  case "$GW_CODE" in
    200) : ;;
    000|"") GATEWAY_STATUS="FAIL (down)" ;;
    *) GATEWAY_STATUS="FAIL (http $GW_CODE)" ;;
  esac
else
  GATEWAY_STATUS="unknown (no curl)"
fi

# ── brain: pure git, no gateway dependency — commits local main is behind
#    origin/main, the exact staleness the 455-BEHIND incident needed surfaced ──
BRAIN_STATUS="ok"
BRAIN_LIB=""
for _p in "$ROOT/scripts/lib/brain.sh" "$ROOT/AI/scripts/lib/brain.sh"; do
  [ -f "$_p" ] && BRAIN_LIB="$_p" && break
done
if [ -z "$BRAIN_LIB" ]; then
  BRAIN_STATUS="unknown (no brain lib)"
else
  # shellcheck source=/dev/null
  . "$BRAIN_LIB"
  if ! brain_is_repo 2>/dev/null; then
    BRAIN_STATUS="FAIL (not initialized)"
  else
    BD="$(brain_dir)"
    REMOTE="$(brain_remote_url "$BD" 2>/dev/null)"
    if [ -n "$REMOTE" ]; then
      if _brain_net_git "$BD" fetch -q origin main >/dev/null 2>&1; then
        if git -C "$BD" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
          BASE="main"
          git -C "$BD" rev-parse --verify --quiet main >/dev/null 2>&1 || BASE="HEAD"
          N="$(git -C "$BD" rev-list --count "${BASE}..origin/main" 2>/dev/null || echo 0)"
          if [ "${N:-0}" -gt 0 ] 2>/dev/null; then
            BRAIN_STATUS="${N} BEHIND"
          fi
        fi
      else
        BRAIN_STATUS="unknown (fetch failed)"
      fi
    fi
    # no remote configured → a local-only brain isn't "behind" anything; stays ok
  fi
fi

# ── mcp: myai's own stdio wrapper resolvable+executable, and npx present when
#    any declared server actually needs it (context7/shadcn/playwright/docker/
#    github all spawn via `npx`) ────────────────────────────────────────────
MCP_STATUS="ok"
MCPFILE="$ROOT/.mcp.json"
if [ ! -f "$MCPFILE" ]; then
  MCP_STATUS="FAIL (no .mcp.json)"
elif ! command -v python3 >/dev/null 2>&1; then
  MCP_STATUS="unknown (no python3)"
else
  NEEDS_NPX="$(python3 -c "
import json
try:
    d = json.load(open('$MCPFILE'))
    srv = d.get('mcpServers') or {}
    print('1' if any(v.get('command') == 'npx' for v in srv.values()) else '0')
except Exception:
    print('0')
" 2>/dev/null)"
  if [ "$NEEDS_NPX" = "1" ] && ! command -v npx >/dev/null 2>&1; then
    MCP_STATUS="FAIL (npx)"
  elif grep -q "mcp_myai_stdio" "$MCPFILE" 2>/dev/null; then
    WRAPPER="$ROOT/scripts/lib/mcp_myai_stdio.sh"
    [ -f "$WRAPPER" ] || WRAPPER="$ROOT/AI/scripts/lib/mcp_myai_stdio.sh"
    if [ ! -f "$WRAPPER" ]; then
      MCP_STATUS="FAIL (no wrapper)"
    elif [ ! -x "$WRAPPER" ]; then
      MCP_STATUS="FAIL (wrapper not executable)"
    fi
  fi
fi

# ── one line, always ────────────────────────────────────────────────────────
if [ "$GIT_STATUS" = "ok" ] && [ "$GATEWAY_STATUS" = "ok" ] && [ "$BRAIN_STATUS" = "ok" ] && [ "$MCP_STATUS" = "ok" ]; then
  echo "boot: ok"
else
  echo "boot: git ${GIT_STATUS} - gateway ${GATEWAY_STATUS} - brain ${BRAIN_STATUS} - mcp ${MCP_STATUS}"
fi
exit 0

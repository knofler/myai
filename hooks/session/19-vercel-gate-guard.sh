#!/bin/bash
set +e
# 19-vercel-gate-guard.sh — fleet Vercel deploy-gate enforcement (anti-rogue).
#
# Every managed repo MUST build on `main` only (vercel.json: deploymentEnabled
# test/codeclot:false + an ignoreCommand build-only-main guard). Without it a
# repo deploys on every push to every branch; summed account-wide that blows the
# Vercel 100/day cap and blocks production.
#
# WHAT THIS CHECKS (since 2026-06-18 — closes the old local-only blind spot):
# the gate that actually PREVENTS burn is the one live on the branch that receives
# pushes (origin/test) — Vercel reads ignoreCommand from the deployed commit. So
# this hook now classifies BOTH:
#   • origin/test  — the burn layer. ungated here  => 🔴 ROGUE (burning now).
#   • local tree   — if gated locally but origin/test isn't  => 🟡 unpushed (fix: push).
# Uses cached refs (no fetch) so it stays fast. Master repo only. Non-fatal.

REPO_ROOT="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)"
TRACK="$REPO_ROOT/config/managed_repos.txt"
[ -f "$TRACK" ] || exit 0   # not the master repo → no-op
command -v jq >/dev/null 2>&1 || exit 0

# Classify a ref's vercel.json: prints GATED | WEAK | UNGATED | NOFILE
classify() { # $1=dir $2=ref ("" = working tree)
  local content
  if [ -z "$2" ]; then
    [ -f "$1/vercel.json" ] || { echo NOFILE; return; }
    content="$(cat "$1/vercel.json" 2>/dev/null)"
  else
    git -C "$1" cat-file -e "$2:vercel.json" 2>/dev/null || { echo NOFILE; return; }
    content="$(git -C "$1" show "$2:vercel.json" 2>/dev/null)"
  fi
  printf '%s' "$content" | jq -e '.git.deploymentEnabled.test==false' >/dev/null 2>&1 || { echo UNGATED; return; }
  printf '%s' "$content" | jq -e '(.ignoreCommand // "")|length>0' >/dev/null 2>&1 && echo GATED || echo WEAK
}

rogue=""; unpushed=""; weak=""; n_rogue=0; n_unpushed=0; n_weak=0
while IFS= read -r raw || [ -n "$raw" ]; do
  case "$raw" in ''|\#*) continue;; esac
  echo "$raw" | grep -qiE 'NEVER write outside|AI folder only|NEVER push' && continue
  line="${raw%%#*}"; d="$(eval echo "$(echo "$line" | xargs)")"
  [ -d "$d/.git" ] || continue
  git -C "$d" remote get-url origin >/dev/null 2>&1 || continue   # no remote → can't git-deploy
  name="$(basename "$d")"
  remote_state="$(classify "$d" origin/test)"
  local_state="$(classify "$d" "")"
  case "$remote_state" in
    GATED) : ;;  # ✅ burn-safe on the branch that receives pushes
    WEAK)
      # test:false but no ignoreCommand — burn-safe for test pushes, missing belt-and-suspenders
      weak="$weak $name"; n_weak=$((n_weak+1)) ;;
    UNGATED|NOFILE)
      # not gated on origin/test. If gated locally → just needs a push; else truly rogue.
      if [ "$local_state" = "GATED" ] || [ "$local_state" = "WEAK" ]; then
        unpushed="$unpushed $name"; n_unpushed=$((n_unpushed+1))
      else
        rogue="$rogue $name"; n_rogue=$((n_rogue+1))
      fi ;;
  esac
done < "$TRACK"

if [ "$n_rogue" -eq 0 ] && [ "$n_unpushed" -eq 0 ] && [ "$n_weak" -eq 0 ]; then
  echo "Vercel Gate Guard: all managed repos gated build-only-main on origin/test (no burn)."
  exit 0
fi

echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "  VERCEL GATE GUARD — fleet gate gaps detected:"
[ "$n_rogue"   -gt 0 ] && { echo "   🔴 ROGUE (deploying previews on every push, burning quota NOW):"; echo "      $rogue"; }
[ "$n_unpushed" -gt 0 ] && { echo "   🟡 GATED LOCALLY but NOT pushed to origin/test (fix: commit+push the gate):"; echo "      $unpushed"; }
[ "$n_weak"    -gt 0 ] && { echo "   🟠 WEAK on origin/test (test:false but no ignoreCommand — strengthen):"; echo "      $weak"; }
echo ""
echo "  FIX rogue/weak: ./scripts/rollout_ci_thrift.sh --apply  (then commit + push each)"
echo "  FIX unpushed:   cd <repo> && git push origin test"
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
exit 0

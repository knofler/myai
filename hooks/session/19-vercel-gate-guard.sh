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

# ADR-021 Phase 3: enumerate the fleet via the shared resolver when available
# (gateway DB roster preferred, txt seed fallback). The inline parse below
# stays as the no-lib fallback — hermetic tests copy this hook alone into a
# sandbox master repo where scripts/lib/repo_paths.sh does not exist.
[ -f "$REPO_ROOT/scripts/lib/repo_paths.sh" ] && . "$REPO_ROOT/scripts/lib/repo_paths.sh" 2>/dev/null

fleet_roster() {
  if declare -F repo_paths >/dev/null 2>&1; then
    repo_paths
    return
  fi
  while IFS= read -r raw || [ -n "$raw" ]; do
    case "$raw" in ''|\#*) continue;; esac
    echo "$raw" | grep -qiE 'NEVER write outside|AI folder only|NEVER push' && continue
    line="${raw%%#*}"; eval echo "$(echo "$line" | xargs)"
  done < "$TRACK"
}

# Read-only repos (seed lines carrying "AI folder only / NEVER push" guidance)
# are excluded from gating BY NAME — the resolver strips trailing comments, so
# the guidance must be re-read from the seed txt. Flagging such a repo rogue
# would tell an agent to commit+push a vercel.json there, which is forbidden.
readonly_names="$(grep -iE 'NEVER write outside|AI folder only|NEVER push' "$TRACK" 2>/dev/null \
  | sed 's/[[:space:]]*#.*$//' \
  | while IFS= read -r l; do l="$(echo "$l" | xargs 2>/dev/null)"; [ -n "$l" ] && basename "$l"; done)"
is_readonly_repo() { [ -n "$readonly_names" ] && printf '%s\n' "$readonly_names" | grep -qx "$1"; }

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
while IFS= read -r d || [ -n "$d" ]; do
  [ -n "$d" ] || continue
  [ -d "$d/.git" ] || continue
  git -C "$d" remote get-url origin >/dev/null 2>&1 || continue   # no remote → can't git-deploy

  # A repo with no web-app markers cannot deploy to Vercel AT ALL, so a missing
  # vercel.json there means "nothing to gate" — not "burning quota". Without this
  # gate, every docs/ops repo lands in the 🔴 ROGUE list and the banner cries wolf
  # every single session (TNEW-OPS — monitoring reports, no package.json — did
  # exactly that until 2026-08-24). Mirrors CLAUDE.md's web-project detection.
  is_web=0
  for _m in package.json next.config.js next.config.mjs next.config.ts next.config.cjs vercel.json .vercel; do
    if [ -e "$d/$_m" ] || git -C "$d" cat-file -e "origin/test:$_m" 2>/dev/null \
                       || git -C "$d" cat-file -e "origin/main:$_m" 2>/dev/null; then
      is_web=1; break
    fi
  done
  [ "$is_web" = 1 ] || continue

  name="$(basename "$d")"
  is_readonly_repo "$name" && continue
  # The burn layer is whichever branch actually receives day-to-day pushes.
  # Most fleet repos use `test`; a repo without one (DXP ships feature-branch →
  # main) burns on `main` instead. Classifying a non-existent origin/test always
  # returns NOFILE, which pinned such a repo at a permanent 🟡 "unpushed" even
  # once its gate was merged — crying wolf exactly like the missing web-marker
  # check used to (see above).
  burn_ref=origin/test
  git -C "$d" rev-parse --verify -q origin/test >/dev/null 2>&1 || burn_ref=origin/main
  remote_state="$(classify "$d" "$burn_ref")"
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
done < <(fleet_roster)

if [ "$n_rogue" -eq 0 ] && [ "$n_unpushed" -eq 0 ] && [ "$n_weak" -eq 0 ]; then
  echo "Vercel Gate Guard: all managed repos gated build-only-main on their burn branch (no burn)."
  exit 0
fi

echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "  VERCEL GATE GUARD — fleet gate gaps detected:"
[ "$n_rogue"   -gt 0 ] && { echo "   🔴 ROGUE (deploying previews on every push, burning quota NOW):"; echo "      $rogue"; }
[ "$n_unpushed" -gt 0 ] && { echo "   🟡 GATED LOCALLY but NOT on the burn branch yet (fix: commit+push/merge the gate):"; echo "      $unpushed"; }
[ "$n_weak"    -gt 0 ] && { echo "   🟠 WEAK on burn branch (test:false but no ignoreCommand — strengthen):"; echo "      $weak"; }
echo ""
echo "  FIX rogue/weak: ./scripts/rollout_ci_thrift.sh --apply  (then commit + push each)"
echo "  FIX unpushed:   cd <repo> && push the gate to its burn branch (test, or main where there is no test)"
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
exit 0

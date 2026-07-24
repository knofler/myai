#!/usr/bin/env bash
# deploy_status.sh — batch + deploy tracker for the fleet.
#
# Vercel now builds ONLY on `main` merges (every repo is gated test:false), so a
# `main` merge = one production build. To keep build counts low, BATCH: commit
# freely to `test` (0 builds) and only `ship it` once 3-4 changes have queued.
#
# This prints, per managed repo:
#   • queued = commits on `test` ahead of `main` (the batch waiting to ship)
#   • a 🚢 flag when queued >= BATCH_THRESHOLD (default 3) → time to ship
# …then the curated deploy-watch list (repos with a blocked/pending prod deploy).
#
# Usage:
#   ./scripts/deploy_status.sh           # fast — uses local refs (may be slightly stale)
#   ./scripts/deploy_status.sh --fetch   # accurate — git fetch each repo first (slower)
#
# Env: BATCH_THRESHOLD=4 ./scripts/deploy_status.sh   # change the ship threshold
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRACK="$ROOT/config/managed_repos.txt"
WATCH="$ROOT/state/deploy-watch.md"
THRESH="${BATCH_THRESHOLD:-3}"
FETCH=false
[ "${1:-}" = "--fetch" ] && FETCH=true

GREEN=$'\033[38;5;208m'; YELLOW=$'\033[1;33m'; DIM=$'\033[2m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'

echo ""
echo "${CYAN}Batch status${NC} — commits on test not yet shipped to main (ship at ${THRESH}+):"
printf "  %-22s %-7s %s\n" "REPO" "queued" "action"
echo "  ---------------------------------------------------------------"

ready=0; total_queued=0
while IFS= read -r raw || [ -n "$raw" ]; do
  case "$raw" in ''|\#*) continue;; esac
  echo "$raw" | grep -qiE 'NEVER write outside|AI folder only|NEVER push' && continue
  line="${raw%%#*}"; d="$(eval echo "$(echo "$line" | xargs)")"
  [ -d "$d/.git" ] || continue
  git -C "$d" remote get-url origin >/dev/null 2>&1 || continue   # no remote → no Vercel deploy
  [ "$FETCH" = true ] && git -C "$d" fetch -q origin 2>/dev/null
  n=$(git -C "$d" rev-list --count origin/main..origin/test 2>/dev/null || echo "?")
  name=$(basename "$d")
  if [ "$n" = "?" ] || [ "$n" = "" ]; then
    printf "  %-22s %-7s %s\n" "$name" "-" "${DIM}no test/main refs${NC}"
  elif [ "$n" -ge "$THRESH" ]; then
    printf "  %-22s %-7s %s\n" "$name" "$n" "${GREEN}🚢 ship now (batch ready)${NC}"; ready=$((ready+1)); total_queued=$((total_queued+n))
  elif [ "$n" -gt 0 ]; then
    printf "  %-22s %-7s %s\n" "$name" "$n" "${DIM}building batch…${NC}"; total_queued=$((total_queued+n))
  fi
done < "$TRACK"
echo "  ---------------------------------------------------------------"
echo "  ${ready} repo(s) ready to ship · ${total_queued} commits queued fleet-wide"
[ "$FETCH" = false ] && echo "  ${DIM}(local refs — run with --fetch for live counts)${NC}"

echo ""
echo "${YELLOW}Deploy watch${NC} — repos with a blocked/pending prod deploy:"
if [ -f "$WATCH" ]; then
  # print the markdown table rows (skip header/separator/comments/blank)
  grep -E '^\|' "$WATCH" | grep -vE '^\| *repo *\||^\|[-: ]+\|' | sed 's/^/  /' || true
  grep -qE '^\| *[A-Za-z0-9_]' "$WATCH" || echo "  ${DIM}(none — all prod deploys live)${NC}"
else
  echo "  ${DIM}(no state/deploy-watch.md)${NC}"
fi
echo ""

#!/usr/bin/env bash
# swarm_prs_snapshot.sh — write the PR snapshot swarm_live serves (dashboard
# redesign phase 1).
#
# WHY: the gateway is token-free and never calls GitHub, so its `prs` section
# reads a file the HOST writes: state/swarm/prs.json in the main checkout,
# which the gateway sees through its /app/AI read-only mount. This script is
# that writer. It is READ-ONLY on GitHub (two `gh api graphql` searches: open
# PRs, and PRs merged today for the timeline's merge events).
#
# Called in the background by every swarm tick (swarm_master.sh sm_prs_kick),
# so it must be cheap and silent:
#   - rate-limited: does nothing if the snapshot is younger than
#     SWARM_PRS_EVERY seconds (default 60);
#   - single-flight: an atomic mkdir lock, taken over when older than 5 min;
#   - gh missing or logged out → exits 0 without writing (swarm_live then
#     reports prsSource "unavailable", never fake data);
#   - atomic write: tmp file + rename, so the gateway never reads half a file;
#     an unparseable GitHub answer keeps the previous snapshot.
#
# Usage: scripts/swarm_prs_snapshot.sh [--force]   (--force ignores the rate limit)
# Env:   SWARM_PRS_OWNERS   space-separated GitHub owners/orgs (default: the gh login)
#        SWARM_PRS_OUT      output file (default: <main checkout>/state/swarm/prs.json)
#        SWARM_PRS_EVERY    min seconds between refreshes (default 60)
#        GH_BIN             gh binary (default gh) — tests point it at a fake
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
GH_BIN="${GH_BIN:-gh}"
SWARM_PRS_EVERY="${SWARM_PRS_EVERY:-60}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# The main checkout (not a lane worktree) — the gateway mounts that one.
main_checkout() {
  local common
  common="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$common" ]; then dirname "$common"; else (cd "$HERE/.." && pwd); fi
}

OUT="${SWARM_PRS_OUT:-$(main_checkout)/state/swarm/prs.json}"
OUT_DIR="$(dirname "$OUT")"
LOCK="$OUT_DIR/.prs.lock"

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

if [ "$FORCE" != 1 ] && [ -f "$OUT" ]; then
  age=$(( $(date +%s) - $(mtime "$OUT") ))
  [ "$age" -lt "$SWARM_PRS_EVERY" ] && exit 0
fi

command -v "$GH_BIN" >/dev/null 2>&1 || exit 0
"$GH_BIN" auth status >/dev/null 2>&1 || exit 0

mkdir -p "$OUT_DIR" 2>/dev/null || exit 0
if ! mkdir "$LOCK" 2>/dev/null; then
  # A writer that died leaves its lock behind; take it over after 5 minutes.
  [ $(( $(date +%s) - $(mtime "$LOCK") )) -gt 300 ] || exit 0
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
fi
trap 'rm -rf "$LOCK"' EXIT

owners="${SWARM_PRS_OWNERS:-$("$GH_BIN" api user -q .login 2>/dev/null || true)}"
[ -n "$owners" ] || exit 0

scope=""
for o in $owners; do scope="$scope user:$o"; done
# "Today" for the merge search, in the swarm's timezone (Sydney).
today="$(TZ=Australia/Sydney date +%Y-%m-%d)"

# shellcheck disable=SC2016  # $q is a GraphQL variable, not a shell expansion
QUERY='query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest {
  number title url state baseRefName headRefName mergeStateStatus updatedAt mergedAt
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
} } } }'

open_json="$("$GH_BIN" api graphql -f query="$QUERY" -f q="is:pr is:open archived:false$scope" 2>/dev/null)" || exit 0
merged_json="$("$GH_BIN" api graphql -f query="$QUERY" -f q="is:pr is:merged merged:>=$today$scope" 2>/dev/null)" || merged_json='{}'

tmp="$OUT.tmp.$$"
if ! OPEN="$open_json" MERGED="$merged_json" /usr/bin/python3 - > "$tmp" <<'PY'
import json, os, datetime

import sys

def nodes(raw):
    try:
        return json.loads(raw)["data"]["search"]["nodes"] or []
    except Exception:
        return None

open_nodes = nodes(os.environ["OPEN"])
if open_nodes is None:
    sys.exit(1)  # a transient GitHub error must not blank a good snapshot

def checks(n):
    try:
        state = (n["commits"]["nodes"][0]["commit"]["statusCheckRollup"] or {}).get("state")
    except Exception:
        state = None
    if state == "SUCCESS":
        return "pass"
    if state in ("FAILURE", "ERROR"):
        return "fail"
    return "pending"

seen, prs = set(), []
for n in open_nodes + (nodes(os.environ["MERGED"]) or []):
    if not n or "number" not in n:
        continue
    repo = (n.get("repository") or {}).get("nameWithOwner", "")
    if (repo, n["number"]) in seen:
        continue
    seen.add((repo, n["number"]))
    pr = {
        "repo": repo, "number": n["number"], "title": n.get("title", ""),
        "base": n.get("baseRefName", ""), "head": n.get("headRefName", ""),
        "state": (n.get("state") or "").lower(), "checks": checks(n),
        "mergeState": (n.get("mergeStateStatus") or "unknown").lower(),
        "url": n.get("url", ""), "updatedAt": n.get("updatedAt", ""),
    }
    if n.get("mergedAt"):
        pr["mergedAt"] = n["mergedAt"]
    prs.append(pr)

prs.sort(key=lambda p: p["updatedAt"], reverse=True)
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps({"generatedAt": now, "prs": prs}, indent=1))
PY
then
  rm -f "$tmp"; exit 0
fi
mv -f "$tmp" "$OUT"
exit 0

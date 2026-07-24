#!/usr/bin/env bash
set +e
# ════════════════════════════════════════════════════════════════════════════
#  atlas_adopt_check.sh — first-run auto-join to the shared Atlas DB.
#
#  After the Atlas cutover (ADR-011), AI/.env carries the Atlas MONGODB_URI and
#  syncs to every machine via Dropbox. A machine that hasn't restarted its
#  containers yet (e.g. the home MacBook the first time it's used after the
#  cutover) is still on its LOCAL mongo. This makes that machine adopt Atlas
#  automatically: if AI/.env points at Atlas and this machine's gateway isn't on
#  it, run `docker compose up -d` to switch over — then no-op forever after.
#
#  Idempotent + safe: no-op when already on Atlas, when .env has no Atlas URI
#  (still local / pre-cutover), or when docker isn't available. Master AI repo
#  only (the gateway/dashboard live here). Never prints the URI (host only).
# ════════════════════════════════════════════════════════════════════════════
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="$ROOT/.env"

[ -f "$ENVF" ] || exit 0
DESIRED=$(grep -E '^MONGODB_URI=' "$ENVF" 2>/dev/null | head -1 | cut -d= -f2-)
# Only act when .env specifies an Atlas SRV URI (mongodb+srv://…). Local URIs → skip.
case "$DESIRED" in mongodb+srv://*) ;; *) exit 0 ;; esac

command -v docker >/dev/null 2>&1 || exit 0
[ -f "$ROOT/docker-compose.yml" ] || exit 0

host=$(printf '%s' "$DESIRED" | sed -E 's#.*@([^/?]+).*#\1#')
CURRENT=$(docker exec myai-gateway sh -c 'echo "$MONGODB_URI"' 2>/dev/null)

if [ "$CURRENT" = "$DESIRED" ]; then
  exit 0   # already on the shared Atlas — nothing to do
fi

echo "ATLAS ADOPT: this machine's gateway is not on the shared Atlas (${host}) yet — adopting via 'docker compose up -d gateway dashboard'…"
( cd "$ROOT" && docker compose up -d gateway dashboard ) >/dev/null 2>&1
# brief settle; Atlas user/allow-list propagation can lag, so a reconnect may be needed
for _ in 1 2 3; do sleep 3 2>/dev/null || true; done
NOW=$(docker exec myai-gateway sh -c 'echo "$MONGODB_URI"' 2>/dev/null)
if [ "$NOW" = "$DESIRED" ]; then
  echo "ATLAS ADOPT: done — gateway + dashboard now on shared Atlas (${host})."
  echo "  If the dashboard shows 'mongo not connected', Atlas propagation is still settling — run: docker compose restart gateway"
else
  echo "ATLAS ADOPT: attempted — confirm with 'docker exec myai-gateway printenv MONGODB_URI'."
fi
exit 0

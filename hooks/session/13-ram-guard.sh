#!/bin/bash
set +e
# Hook: 2 GB RAM Ceiling Guard
# Event: SessionStart (runs on every `agent mode` kickoff)
#
# Sums Docker container RAM across this project's stack. Warns if total
# exceeds 2 GB. Non-blocking — issues a recommendation, never aborts.
#
# Exempt a heavy-model repo by creating `.ram-exempt` at repo root.

LIMIT_MB=2048

# Docker daemon must be up — borrow the check from 03-docker-health
if ! docker info &>/dev/null; then
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
COMPOSE_FILE="$ROOT/docker-compose.yml"

# No compose file means nothing to measure
if [ ! -f "$COMPOSE_FILE" ]; then
  exit 0
fi

# Exemption marker — projects that legitimately exceed 2 GB (e.g. local LLM)
if [ -f "$ROOT/.ram-exempt" ]; then
  echo "RAM Guard: exempt (.ram-exempt present)"
  exit 0
fi

# Find this project's containers from compose
PROJECT_CONTAINERS=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Name}}' 2>/dev/null)
if [ -z "$PROJECT_CONTAINERS" ]; then
  exit 0
fi

# Sum MemUsage across this project's containers
TOTAL_MB=0
DETAIL=""
while IFS= read -r CNAME; do
  [ -z "$CNAME" ] && continue
  # docker stats output like: "256.4MiB / 7.652GiB"
  STAT=$(docker stats --no-stream --format '{{.MemUsage}}' "$CNAME" 2>/dev/null | awk '{print $1}')
  [ -z "$STAT" ] && continue
  # Normalize to MB
  CONTAINER_MB=$(awk -v s="$STAT" 'BEGIN{
    n=s+0;
    if (s ~ /GiB/ || s ~ /GB/) n=n*1024;
    else if (s ~ /KiB/ || s ~ /kB/ || s ~ /KB/) n=n/1024;
    printf "%.0f", n;
  }')
  [ -z "$CONTAINER_MB" ] && continue
  TOTAL_MB=$((TOTAL_MB + CONTAINER_MB))
  DETAIL="${DETAIL}  - ${CNAME}: ${CONTAINER_MB} MB"$'\n'
done <<< "$PROJECT_CONTAINERS"

if [ "$TOTAL_MB" -eq 0 ]; then
  exit 0
fi

if [ "$TOTAL_MB" -gt "$LIMIT_MB" ]; then
  echo "⚠️  RAM Guard: ${TOTAL_MB} MB used — OVER 2 GB ceiling"
  echo "$DETAIL" | head -10
  echo "  Fix: add mem_limit (e.g. 1g / 512m) to services in docker-compose.yml"
  echo "  Or:  touch .ram-exempt   # if heavy-model repo (Ollama, etc.)"
else
  echo "RAM Guard: ${TOTAL_MB} MB / ${LIMIT_MB} MB (under ceiling)"
fi

exit 0

#!/bin/bash
set +e
# Hook: Docker Health Check
# Event: SessionStart
# Verifies Docker daemon is running and project containers are healthy

# Skip inside a container (e.g. the gateway's own hook registry): there's no
# Docker daemon to query from in here, so this would print a misleading
# "daemon not running" warning. Host-only hook.
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  echo "03-docker-health: skipped (inside container — host-only hook)"
  exit 0
fi

# Check Docker daemon
if ! docker info &>/dev/null; then
  echo "WARNING: Docker daemon is not running. Start Docker Desktop first."
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
COMPOSE_FILE="$ROOT/docker-compose.yml"

if [ ! -f "$COMPOSE_FILE" ]; then
  exit 0
fi

# Runner ci-workspace guard (LL 2026-07-04): a workspace clone has no real .env,
# so compose parsing fails here (MONGODB_URI is `:?` required) — and the shared
# myai stack must NEVER be composed from a workspace anyway. Report the shared
# containers by name instead of nudging a compose-up that hook 16 would block.
WS_ROOT="${CI_WORKSPACES:-$HOME/ci-workspaces}"
if grep -qE '^name:[[:space:]]*myai[[:space:]]*$' "$COMPOSE_FILE" 2>/dev/null; then
  case "$ROOT" in
    "$WS_ROOT"/*)
      RUNNING=$(docker ps --filter 'name=^myai-' --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
      echo "Docker: $RUNNING shared myai container(s) running (workspace clone — gateway deploys run from the master checkout only)"
      exit 0
      ;;
  esac
fi

# Check container status
CONTAINERS=$(docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null)

if [ -z "$CONTAINERS" ]; then
  echo "WARNING: No containers running for this project"
  echo "Start with: docker compose up -d --build"
  exit 0
fi

# Parse container health
UNHEALTHY=$(echo "$CONTAINERS" | jq -r 'select(.Health == "unhealthy" or .State != "running") | .Name' 2>/dev/null)

if [ -n "$UNHEALTHY" ]; then
  echo "UNHEALTHY CONTAINERS:"
  echo "$UNHEALTHY"
  echo "Rebuild with: docker compose down && docker compose up -d --build"
else
  RUNNING=$(echo "$CONTAINERS" | jq -r '.Name' 2>/dev/null | wc -l | tr -d ' ')
  echo "Docker: $RUNNING container(s) running and healthy"
fi

exit 0

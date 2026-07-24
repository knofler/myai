#!/bin/bash
set +e
# Hook: Docker Container Naming Enforcement
# Event: SessionStart
# Enforces: all containers must be prefixed with EXACT repo folder name
# e.g., myapp-app, myapp-mongo, acme-app
# Preserves original casing — no lowercasing

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
COMPOSE_FILE="$ROOT/docker-compose.yml"

# Skip if no docker-compose.yml
if [ ! -f "$COMPOSE_FILE" ]; then
  exit 0
fi

# Skip if Docker not running
if ! docker info &>/dev/null; then
  exit 0
fi

# Get project name: prefer `name:` field from docker-compose.yml, fall back to folder name
# This handles workspace setups where docker-compose is in a sub-repo (e.g., ai-matching-job-docker/)
# but the project name and container prefix should be "ai-matching-job"
COMPOSE_NAME=$(grep -m1 '^name:' "$COMPOSE_FILE" 2>/dev/null | sed 's/^name:[[:space:]]*//' | tr -d ' "'"'"'' | tr -d '\r')
if [ -n "$COMPOSE_NAME" ]; then
  PROJECT="$COMPOSE_NAME"
else
  PROJECT=$(basename "$ROOT")
fi

# Check if docker-compose.yml has container_name directives
HAS_NAMES=$(grep -c 'container_name:' "$COMPOSE_FILE" 2>/dev/null || echo 0)

if [ "$HAS_NAMES" -eq 0 ]; then
  echo "DOCKER NAMING: No container_name directives found in docker-compose.yml"
  echo "  Add container_name: ${PROJECT}-app, ${PROJECT}-mongo, etc."
  exit 0
fi

# Check each container_name matches the project prefix (exact case)
BAD_NAMES=""
while IFS= read -r line; do
  NAME=$(echo "$line" | sed 's/.*container_name:[[:space:]]*//' | tr -d ' "'"'"'' | tr -d '\r')
  if [ -n "$NAME" ] && [[ "$NAME" != ${PROJECT}-* ]] && [[ "$NAME" != ${PROJECT}_* ]]; then
    BAD_NAMES="$BAD_NAMES\n  $NAME (expected: ${PROJECT}-*)"
  fi
done < <(grep 'container_name:' "$COMPOSE_FILE" 2>/dev/null)

if [ -n "$BAD_NAMES" ]; then
  echo "DOCKER NAMING VIOLATION DETECTED"
  echo "  Project: $PROJECT"
  echo "  Non-compliant containers:$BAD_NAMES"
  echo ""
  echo "ACTION REQUIRED:"
  echo "  1. docker compose down"
  echo "  2. Update container_name values in docker-compose.yml:"
  echo "     container_name: ${PROJECT}-app"
  echo "     container_name: ${PROJECT}-mongo"
  echo "     container_name: ${PROJECT}-api"
  echo "     container_name: ${PROJECT}-mongo-express"
  echo "  3. docker compose up -d --build"
else
  echo "Docker naming: All containers use '${PROJECT}-' prefix"
fi

exit 0

#!/bin/bash
set +e
# Hook: TypeScript Check on Commit
# Event: PostToolUse (Bash)
# Runs tsc --noEmit after git commit to catch type errors early

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only trigger on git commit
if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
COMPOSE_FILE="$ROOT/docker-compose.yml"

# Check if this is a TypeScript project with Docker
if [ -f "$COMPOSE_FILE" ]; then
  # Check if Docker is running
  if docker info &>/dev/null 2>&1; then
    echo "Running type check after commit..."
    RESULT=$(docker compose -f "$COMPOSE_FILE" exec -T app npx tsc --noEmit --pretty 2>&1)
    EXIT_CODE=$?
    if [ $EXIT_CODE -ne 0 ]; then
      echo "TYPE CHECK FAILED after commit:"
      echo "$RESULT" | tail -20
      echo ""
      echo "Fix type errors before pushing."
    else
      echo "Type check passed"
    fi
  fi
elif [ -f "$ROOT/tsconfig.json" ]; then
  # Non-Docker TypeScript project
  if command -v npx &>/dev/null; then
    echo "Running type check after commit..."
    RESULT=$(cd "$ROOT" && npx tsc --noEmit --pretty 2>&1)
    if [ $? -ne 0 ]; then
      echo "TYPE CHECK FAILED after commit:"
      echo "$RESULT" | tail -20
    else
      echo "Type check passed"
    fi
  fi
fi

exit 0

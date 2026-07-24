#!/bin/bash
set +e
# Hook: Render Service Health (On-Demand)
# Event: PostToolUse (Bash)
# Checks Render API service health after git push

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only trigger on git push
if ! echo "$COMMAND" | grep -qE 'git\s+push'; then
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Check for render.yaml
if [ ! -f "$ROOT/render.yaml" ]; then
  exit 0
fi

# Check if RENDER_API_KEY is set
if [ -z "$RENDER_API_KEY" ]; then
  # Try loading from .env
  if [ -f "$ROOT/.env" ]; then
    RENDER_API_KEY=$(grep -oP 'RENDER_API_KEY=\K.*' "$ROOT/.env" 2>/dev/null | tr -d '"')
  fi
fi

if [ -z "$RENDER_API_KEY" ]; then
  echo "Render: No RENDER_API_KEY found — cannot check deployment status"
  echo "Set RENDER_API_KEY in .env or export it"
  exit 0
fi

echo "Checking Render service status..."

# Get services
SERVICES=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services?limit=5" 2>/dev/null)

if [ -n "$SERVICES" ]; then
  echo "$SERVICES" | jq -r '.[].service | "\(.name): \(.suspended // "active") — \(.serviceDetails.url // "no URL")"' 2>/dev/null | head -5
else
  echo "Could not fetch Render services"
fi

exit 0

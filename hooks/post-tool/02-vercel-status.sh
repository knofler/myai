#!/bin/bash
set +e
# Hook: Vercel Deployment Status (On-Demand)
# Event: PostToolUse (Bash)
# Checks Vercel deployment status after git push

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only trigger on git push
if ! echo "$COMMAND" | grep -qE 'git\s+push'; then
  exit 0
fi

# Check if vercel CLI is available
if ! command -v vercel &>/dev/null; then
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Check for Vercel project config
if [ ! -f "$ROOT/.vercel/project.json" ]; then
  exit 0
fi

# Give Vercel a moment to pick up the push
echo "Checking Vercel deployment status..."

# Get latest deployment
BRANCH=$(git branch --show-current 2>/dev/null)
DEPLOYMENTS=$(vercel ls --limit 3 2>/dev/null | tail -3)

if [ -n "$DEPLOYMENTS" ]; then
  echo "Recent Vercel deployments:"
  echo "$DEPLOYMENTS"

  if [ "$BRANCH" = "test" ]; then
    echo "Preview URL should be available shortly."
  elif [ "$BRANCH" = "main" ]; then
    echo "Production deployment triggered."
  fi
else
  echo "Could not fetch Vercel deployments. Check manually: vercel ls"
fi

exit 0

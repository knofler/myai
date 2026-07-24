#!/bin/bash
set +e
# Hook: GitHub Actions CI Status (On-Demand)
# Event: PostToolUse (Bash)
# Checks GitHub Actions workflow status after git push

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only trigger on git push
if ! echo "$COMMAND" | grep -qE 'git\s+push'; then
  exit 0
fi

# Check if gh CLI is available
if ! command -v gh &>/dev/null; then
  exit 0
fi

# Check if we're in a GitHub repo
if ! gh repo view &>/dev/null 2>&1; then
  exit 0
fi

echo "Checking GitHub Actions status..."

# Brief wait for workflow to trigger
sleep 2

# Get latest workflow runs
RUNS=$(gh run list --limit 3 --json name,status,conclusion,headBranch,createdAt 2>/dev/null)

if [ -n "$RUNS" ]; then
  echo "Recent CI runs:"
  echo "$RUNS" | jq -r '.[] | "  \(.headBranch) | \(.name): \(.status) \(.conclusion // "")"' 2>/dev/null

  # Check if any are in progress
  IN_PROGRESS=$(echo "$RUNS" | jq -r '.[] | select(.status == "in_progress") | .name' 2>/dev/null)
  if [ -n "$IN_PROGRESS" ]; then
    echo ""
    echo "Workflows in progress — check with: gh run list"
  fi
else
  echo "Could not fetch GitHub Actions runs"
fi

exit 0

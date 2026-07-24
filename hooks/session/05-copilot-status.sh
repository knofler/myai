#!/bin/bash
set +e
# Hook: GitHub Copilot Status Check
# Event: SessionStart
# Checks if GitHub Copilot CLI extension is installed and authenticated

# Check gh CLI
if ! command -v gh &>/dev/null; then
  echo "GitHub CLI (gh) not installed — cannot check Copilot"
  exit 0
fi

# Check gh auth
if ! gh auth status &>/dev/null 2>&1; then
  echo "WARNING: GitHub CLI not authenticated. Run: gh auth login"
  exit 0
fi

# Check Copilot extension
if gh copilot --version &>/dev/null 2>&1; then
  VERSION=$(gh copilot --version 2>&1 | head -1)
  echo "GitHub Copilot: Active ($VERSION)"
else
  echo "GitHub Copilot CLI extension not installed"
  echo "Install with: gh extension install github/gh-copilot"
fi

exit 0

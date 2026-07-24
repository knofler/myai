#!/bin/bash
set +e
# Hook: Project Identity Display
# Event: SessionStart
# ALWAYS shows which project/repo you're working in — impossible to miss

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
REPO_NAME=$(basename "$ROOT")
GIT_REMOTE=$(git remote get-url origin 2>/dev/null | sed 's|.*/||;s|\.git$||' || echo "no-remote")
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  PROJECT: $REPO_NAME"
echo "║  REPO:    $GIT_REMOTE"
echo "║  BRANCH:  $BRANCH"
echo "║  PATH:    $ROOT"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

exit 0

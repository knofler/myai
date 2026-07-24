#!/bin/bash
set -euo pipefail

# Start Claude Code in remote-control mode for this project
# Usage: ./scripts/remote.sh          (from AI root)
#        ./AI/scripts/remote.sh       (from project root)
#
# Opens a remote-control session that you can connect to from:
#   - Claude mobile app (iOS/Android)
#   - claude.ai/code (web browser)
#   - Another machine's browser
#
# The session runs locally — your filesystem, MCP servers, and tools stay on this machine.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AI_ROOT="$(dirname "$SCRIPT_DIR")"

# Detect project root (parent of AI/ if we're inside a managed project)
if [[ "$(basename "$AI_ROOT")" == "AI" ]]; then
  PROJECT_ROOT="$(dirname "$AI_ROOT")"
else
  PROJECT_ROOT="$AI_ROOT"
fi

PROJECT_NAME="$(basename "$PROJECT_ROOT")"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Remote Control: $PROJECT_NAME"
echo "║  Project: $PROJECT_ROOT"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Check claude CLI exists
if ! command -v claude &>/dev/null; then
  echo "ERROR: claude CLI not found in PATH"
  echo "Install: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

# Launch remote control from the project directory
cd "$PROJECT_ROOT"

echo "Org config: ${CLAUDE_CONFIG_DIR:-default (~/.claude)}"
echo "  (your phone's Claude app must be signed into the SAME org to see this session)"
echo ""
echo "Starting remote-control session..."
echo "Connect from your phone or another device using the QR code or URL below."
echo ""

# CLI >= 2.x exposes Remote Control as a flag (--remote-control [name]),
# not the old `claude remote-control` subcommand. The session name makes
# this repo identifiable in the mobile app's session list.
claude --remote-control "$PROJECT_NAME" || {
  EXIT_CODE=$?
  echo ""
  if [[ $EXIT_CODE -eq 1 ]]; then
    echo "Remote Control failed to start."
    echo ""
    echo "Common causes:"
    echo "  - Organization policy blocks remote-control — as an Enterprise admin/"
    echo "    primary owner, enable it in the claude.ai Admin console (Claude Code settings)"
    echo "  - Not authenticated (run: claude auth) or wrong org profile"
    echo "    (run under the intended CLAUDE_CONFIG_DIR, e.g. claude-museum alias)"
    echo "  - Claude Code needs updating (run: claude update)"
  fi
  exit $EXIT_CODE
}

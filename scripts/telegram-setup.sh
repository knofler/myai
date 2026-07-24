#!/bin/bash
set -euo pipefail

# Guided Telegram bot setup for Claude Code channels
# Usage: ./scripts/telegram-setup.sh              (interactive — prompts for token)
#        ./scripts/telegram-setup.sh <bot-token>   (non-interactive)
#
# Prerequisites: Bun (runtime for the Telegram MCP server)
# Creates a Telegram bot that forwards messages to your Claude Code session.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AI_ROOT="$(dirname "$SCRIPT_DIR")"
CHANNEL_DIR="$HOME/.claude/channels/telegram"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Telegram Channel Setup for Claude Code             ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Check claude CLI exists
if ! command -v claude &>/dev/null; then
  echo "ERROR: claude CLI not found in PATH"
  echo "Install: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

# ── Step 1: Check Bun ──────────────────────────────────────

echo "Step 1/4: Checking Bun runtime..."

if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
  echo "  OK: Bun $BUN_VERSION installed"
else
  echo "  MISSING: Bun is required for the Telegram channel plugin."
  echo ""
  echo "  Install Bun with:"
  echo "    curl -fsSL https://bun.sh/install | bash"
  echo ""
  echo "  Then re-run this script."
  exit 1
fi

echo ""

# ── Step 2: Check Telegram plugin ──────────────────────────

echo "Step 2/4: Checking Telegram plugin..."

if claude plugin list 2>/dev/null | grep -q "telegram"; then
  echo "  OK: telegram plugin installed"
else
  echo "  Installing telegram plugin..."
  if claude plugin install telegram@claude-plugins-official 2>/dev/null; then
    echo "  OK: telegram plugin installed"
  else
    echo "  FAILED: Could not install telegram plugin"
    echo "  Try manually: claude plugin install telegram@claude-plugins-official"
    exit 1
  fi
fi

echo ""

# ── Step 3: Configure bot token ────────────────────────────

echo "Step 3/4: Configuring bot token..."

TOKEN="${1:-}"

if [[ -z "$TOKEN" ]]; then
  # Check if already configured
  if [[ -f "$CHANNEL_DIR/.env" ]] && grep -q "TELEGRAM_BOT_TOKEN=" "$CHANNEL_DIR/.env" 2>/dev/null; then
    EXISTING=$(grep "TELEGRAM_BOT_TOKEN=" "$CHANNEL_DIR/.env" | head -1 | cut -d= -f2 | cut -c1-12)
    echo "  Token already configured: ${EXISTING}..."
    echo ""
    read -r -p "  Replace with new token? (y/N): " REPLACE
    if [[ "$REPLACE" != "y" && "$REPLACE" != "Y" ]]; then
      echo "  Keeping existing token."
      TOKEN="SKIP"
    fi
  fi

  if [[ "$TOKEN" != "SKIP" ]]; then
    echo ""
    echo "  Create a bot with @BotFather on Telegram (https://t.me/BotFather):"
    echo "    1. Send /newbot"
    echo "    2. Choose a display name"
    echo "    3. Choose a username (must end in 'bot')"
    echo "    4. Copy the token (looks like 123456789:AAHfiqksKZ8...)"
    echo ""
    read -r -p "  Paste your bot token: " TOKEN

    if [[ -z "$TOKEN" ]]; then
      echo "  ERROR: No token provided."
      exit 1
    fi
  fi
fi

if [[ "$TOKEN" != "SKIP" ]]; then
  mkdir -p "$CHANNEL_DIR"

  # Write or update the .env file
  if [[ -f "$CHANNEL_DIR/.env" ]]; then
    # Remove existing token line and append new one
    grep -v "^TELEGRAM_BOT_TOKEN=" "$CHANNEL_DIR/.env" > "$CHANNEL_DIR/.env.tmp" || true
    echo "TELEGRAM_BOT_TOKEN=$TOKEN" >> "$CHANNEL_DIR/.env.tmp"
    mv "$CHANNEL_DIR/.env.tmp" "$CHANNEL_DIR/.env"
  else
    echo "TELEGRAM_BOT_TOKEN=$TOKEN" > "$CHANNEL_DIR/.env"
  fi

  chmod 600 "$CHANNEL_DIR/.env"
  echo "  OK: Token saved to $CHANNEL_DIR/.env"
fi

echo ""

# ── Step 4: Next steps ─────────────────────────────────────

echo "Step 4/4: Next steps"
echo ""
echo "  1. Start Claude Code with the Telegram channel:"
echo ""
echo "     claude --channels plugin:telegram@claude-plugins-official"
echo ""
echo "  2. DM your bot on Telegram — it replies with a 6-character pairing code."
echo ""
echo "  3. In your Claude Code session, approve the pairing:"
echo ""
echo "     /telegram:access pair <code>"
echo ""
echo "  4. Lock down access (important!):"
echo ""
echo "     /telegram:access policy allowlist"
echo ""
echo "  5. Send messages to your bot — they reach your Claude Code session."
echo ""
echo "  For group setup, access control, and more:"
echo "  See AI/documentation/MOBILE_CONTROL.md"
echo ""
echo "Done."

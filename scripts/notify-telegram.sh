#!/bin/bash
# scripts/notify-telegram.sh — Send a Telegram message from a Claude Code hook
#
# Usage:
#   notify-telegram.sh <event> [<extra_text>]
#
# Events: notification | stop | permission | done | <any custom label>
#
# Reads TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHATS from .env (first chat ID is used).
# Silent on any failure — hooks should never break the session.
#
# NOTIFY_STRICT=1 — for callers that must KNOW whether the ping went out (the
# `boot` routine's ping phase): exit 2 + one stderr line when not configured
# (no .env / empty token / empty TELEGRAM_ALLOWED_CHATS), exit 1 when the send
# fails. WHY (2026-09-22): TELEGRAM_ALLOWED_CHATS was empty, this script exited
# 0 silently at line "[ -z "$CHAT_ID" ] && exit 0", and NO boot ever pinged —
# invisible in every report for a week. Default (unset) behaviour is unchanged.
# NOTIFY_ENV_FILE=<path> overrides the .env search (tests). NOTIFY_DRY_RUN=1
# prints the would-be message instead of sending (tests).
#
# Designed to be called from .claude/settings.json hooks (Notification, Stop, etc.).

set +e  # never fail the parent hook chain

STRICT="${NOTIFY_STRICT:-0}"
# fail <code> <reason> — strict callers get the code + reason; hooks get exit 0.
fail() {
  if [ "$STRICT" = 1 ]; then echo "notify-telegram: $2" >&2; exit "$1"; fi
  exit 0
}

EVENT="${1:-event}"
EXTRA="${2:-}"

# ── Locate .env (script dir → AI root) ─────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
ENV_FILE="${NOTIFY_ENV_FILE:-}"
if [ -z "$ENV_FILE" ]; then
  for candidate in "${SCRIPT_DIR}/../.env" "${PWD}/.env" "${PWD}/AI/.env"; do
    if [ -f "$candidate" ]; then ENV_FILE="$candidate"; break; fi
  done
fi
if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then fail 2 "no .env found (looked next to scripts/, in \$PWD and \$PWD/AI)"; fi

# ── Read token + chat id (first one if comma-list) ─────────────
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
CHATS=$(grep -E '^TELEGRAM_ALLOWED_CHATS=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
CHAT_ID=$(echo "$CHATS" | cut -d, -f1 | tr -d ' ')

[ -z "$TOKEN" ] && fail 2 "TELEGRAM_BOT_TOKEN is empty in $ENV_FILE"
[ -z "$CHAT_ID" ] && fail 2 "TELEGRAM_ALLOWED_CHATS is empty in $ENV_FILE — nobody receives the ping. Message the bot once, then run: ./scripts/telegram_pair.sh --write"

# ── Build message ──────────────────────────────────────────────
HOST=$(hostname -s 2>/dev/null || echo "?")
BRANCH=$(git -C "$(dirname "$ENV_FILE")" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
REPO=$(basename "$(dirname "$ENV_FILE")")
NOW=$(date -u +'%Y-%m-%d %H:%M UTC')

ICON=""
LABEL=""
case "$EVENT" in
  notification|permission)
    ICON="🔔"
    LABEL="PERMISSION NEEDED"
    ;;
  stop|done|finished)
    ICON="✅"
    LABEL="SESSION DONE"
    ;;
  error|failed)
    ICON="🔴"
    LABEL="ERROR"
    ;;
  *)
    ICON="📣"
    LABEL=$(echo "$EVENT" | tr '[:lower:]' '[:upper:]')
    ;;
esac

# Read stdin if available (hook payload) — capture first 500 chars
STDIN_PAYLOAD=""
if [ ! -t 0 ]; then
  STDIN_PAYLOAD=$(cat 2>/dev/null | head -c 500)
fi

TEXT="${ICON} *${LABEL}*

📁 \`${REPO}\` · \`${BRANCH}\`
💻 ${HOST}
🕐 ${NOW}"

if [ -n "$EXTRA" ]; then
  TEXT="${TEXT}

${EXTRA}"
fi

if [ -n "$STDIN_PAYLOAD" ]; then
  # Extract message field from JSON payload if present, else show first line
  MSG=$(echo "$STDIN_PAYLOAD" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get("message") or d.get("prompt") or d.get("tool_name") or "")
except Exception:
    pass' 2>/dev/null)
  [ -z "$MSG" ] && MSG=$(echo "$STDIN_PAYLOAD" | head -1)
  if [ -n "$MSG" ]; then
    TEXT="${TEXT}

\`\`\`
${MSG}
\`\`\`"
  fi
fi

# ── Send ───────────────────────────────────────────────────────
if [ "${NOTIFY_DRY_RUN:-0}" = 1 ]; then
  printf 'notify-telegram DRY-RUN → chat %s:\n%s\n' "$CHAT_ID" "$TEXT"
  exit 0
fi
if curl -sf -m 5 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
     -d "chat_id=${CHAT_ID}" \
     -d "parse_mode=Markdown" \
     --data-urlencode "text=${TEXT}" \
     >/dev/null 2>&1; then
  exit 0
fi
fail 1 "sendMessage to chat $CHAT_ID failed (curl non-zero — network, bad token, or the chat never messaged the bot)"

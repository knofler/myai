#!/bin/bash
set +e
# telegram_pair.sh — finish the Telegram ping setup: discover the operator's
# chat id from the bot's pending updates and (with --write) put it into .env as
# TELEGRAM_ALLOWED_CHATS.
#
# WHY (2026-09-22): .env had TELEGRAM_BOT_TOKEN but TELEGRAM_ALLOWED_CHATS was
# empty, so notify-telegram.sh exited 0 silently and the `boot` routine's D9
# ping never reached anyone for a week. The boot's ping phase now WARNs
# "NOT CONFIGURED" — this script is the one-step fix it points at.
#
# Steps for the operator:
#   1. In Telegram, open the bot (getMe below prints its @username) and send
#      it any message ("hi").
#   2. ./scripts/telegram_pair.sh            # lists the chat id(s) that messaged the bot
#      ./scripts/telegram_pair.sh --write    # writes TELEGRAM_ALLOWED_CHATS=<id> when exactly one chat is seen
#      ./scripts/telegram_pair.sh --write --chat <id>   # pick one explicitly
#   3. ./scripts/notify-telegram.sh done "pairing test"   # you should get a message
#
# Token is read from .env and never printed. Edits .env in place; the backup goes
# to ~/.myai/backups/ (mode 600), NEVER beside .env — a `.env.bak` inside the repo
# matched no .gitignore rule and would stage every secret on the next `git add -A`
# (review 2026-09-22). Exit: 0 ok · 1 nothing seen / ambiguous · 2 config error.

WRITE=0 CHAT="" ENV_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --write) WRITE=1 ;;
    --chat)  shift; CHAT="$1" ;;
    --env)   shift; ENV_FILE="$1" ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "telegram_pair: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
[ -n "$ENV_FILE" ] || ENV_FILE="$SCRIPT_DIR/../.env"
[ -f "$ENV_FILE" ] || { echo "telegram_pair: no .env at $ENV_FILE" >&2; exit 2; }
TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
[ -n "$TOKEN" ] || { echo "telegram_pair: TELEGRAM_BOT_TOKEN is empty in $ENV_FILE — run: telegram setup" >&2; exit 2; }
API="${TELEGRAM_API_BASE:-https://api.telegram.org}"

ME="$(curl -s -m 8 "$API/bot${TOKEN}/getMe" 2>/dev/null | /usr/bin/python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); r=d.get("result",{})
    print(("@"+r["username"]) if d.get("ok") and r.get("username") else "")
except Exception: print("")' 2>/dev/null)"
[ -n "$ME" ] || { echo "telegram_pair: getMe failed — token invalid or no network" >&2; exit 2; }
echo "bot: $ME"

SEEN="$(curl -s -m 8 "$API/bot${TOKEN}/getUpdates" 2>/dev/null | /usr/bin/python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not d.get("ok"): sys.exit(0)
seen={}
for u in d.get("result",[]):
    m=u.get("message") or u.get("edited_message") or u.get("channel_post") or {}
    c=m.get("chat") or {}
    if c.get("id") is not None:
        seen[c["id"]]=(c.get("type",""), c.get("username") or c.get("title") or c.get("first_name") or "")
for k,(t,n) in seen.items(): print(f"{k}\t{t}\t{n}")' 2>/dev/null)"

if [ -z "$SEEN" ]; then
  echo "no chat has messaged $ME yet (or a webhook consumes the updates)."
  echo "  → in Telegram, send $ME any message, then re-run: $0${WRITE:+ --write}"
  exit 1
fi
echo "chats that messaged the bot:"
printf '%s\n' "$SEEN" | while IFS="$(printf '\t')" read -r id type name; do printf '  chat_id %-14s %-8s %s\n' "$id" "$type" "$name"; done

[ "$WRITE" = 1 ] || { echo "  → write one into $ENV_FILE: $0 --write [--chat <id>]"; exit 0; }

if [ -z "$CHAT" ]; then
  N="$(printf '%s\n' "$SEEN" | grep -c .)"
  if [ "$N" != 1 ]; then echo "telegram_pair: $N chats seen — pick one: $0 --write --chat <id>" >&2; exit 1; fi
  CHAT="$(printf '%s\n' "$SEEN" | head -1 | cut -f1)"
fi
case "$CHAT" in ''|*[!0-9-]*) echo "telegram_pair: chat id must be numeric, got '$CHAT'" >&2; exit 2 ;; esac

BAK_DIR="${TELEGRAM_PAIR_BACKUP_DIR:-$HOME/.myai/backups}"
if ! mkdir -p "$BAK_DIR" || ! chmod 700 "$BAK_DIR"; then
  echo "telegram_pair: could not prepare backup dir $BAK_DIR — aborting, $ENV_FILE untouched" >&2
  exit 2
fi
BAK="$BAK_DIR/env-$(date +%Y%m%d-%H%M%S).bak"
if ! cp "$ENV_FILE" "$BAK" || ! chmod 600 "$BAK"; then
  rm -f "$BAK"
  echo "telegram_pair: could not write backup $BAK — aborting, $ENV_FILE untouched" >&2
  exit 2
fi
if grep -qE '^TELEGRAM_ALLOWED_CHATS=' "$ENV_FILE"; then
  /usr/bin/python3 - "$ENV_FILE" "$CHAT" <<'PY'
import re,sys
p,chat=sys.argv[1],sys.argv[2]
s=open(p).read()
s=re.sub(r'(?m)^TELEGRAM_ALLOWED_CHATS=.*$', f'TELEGRAM_ALLOWED_CHATS={chat}', s, count=1)
open(p,'w').write(s)
PY
else
  printf '\nTELEGRAM_ALLOWED_CHATS=%s\n' "$CHAT" >> "$ENV_FILE"
fi
NOW="$(grep -E '^TELEGRAM_ALLOWED_CHATS=' "$ENV_FILE" | head -1)"
echo "wrote $NOW → $ENV_FILE (backup: $BAK)"
echo "  verify: NOTIFY_STRICT=1 $SCRIPT_DIR/notify-telegram.sh done 'pairing test' </dev/null && echo delivered"
exit 0

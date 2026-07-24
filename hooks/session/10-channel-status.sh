#!/bin/bash
set +e

# Show Telegram channel status on session start (silent if not configured)

CHANNEL_DIR="$HOME/.claude/channels/telegram"
ENV_FILE="$CHANNEL_DIR/.env"
ACCESS_FILE="$CHANNEL_DIR/access.json"

# Skip silently if no Telegram channel configured
[[ ! -f "$ENV_FILE" ]] && exit 0
grep -q "TELEGRAM_BOT_TOKEN=" "$ENV_FILE" 2>/dev/null || exit 0

# Token is set — show status without exposing the token
echo "Telegram: configured"

if [[ -f "$ACCESS_FILE" ]]; then
  POLICY=$(grep -o '"dmPolicy"[[:space:]]*:[[:space:]]*"[^"]*"' "$ACCESS_FILE" 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"')
  ALLOW_COUNT=$(grep -o '"allowFrom"' "$ACCESS_FILE" 2>/dev/null | wc -l | tr -d ' ')

  if [[ -n "$POLICY" ]]; then
    echo "  Policy: $POLICY"
  fi

  if [[ "$ALLOW_COUNT" -gt 0 ]]; then
    # Count actual entries in the allowFrom array
    USERS=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('allowFrom',[])))" "$ACCESS_FILE" 2>/dev/null || echo "?")
    echo "  Allowed users: $USERS"
  fi

  if [[ "$POLICY" == "pairing" ]]; then
    echo "  WARNING: Policy is 'pairing' — lock down with: /telegram:access policy allowlist"
  fi
else
  echo "  No access.json — default policy: pairing (run /telegram:access to configure)"
fi

exit 0

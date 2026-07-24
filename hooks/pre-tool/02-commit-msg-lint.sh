#!/bin/bash
set +e
# Hook: Commit Message Lint
# Event: PreToolUse (Bash)
# Enforces conventional commit format on git commit messages
# macOS-compatible (no grep -P)

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only check git commit commands
if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
  exit 0
fi

# Extract commit message from -m flag (handles quotes)
MSG=""
if echo "$COMMAND" | grep -qE -- '-m\s'; then
  # Use sed to extract message between quotes after -m
  MSG=$(echo "$COMMAND" | sed -n 's/.*-m\s*["\x27]\([^"\x27]*\).*/\1/p' | head -1)
fi

# Try heredoc pattern: extract first non-empty line after EOF marker
if [ -z "$MSG" ]; then
  MSG=$(echo "$COMMAND" | sed -n '/cat <<.*EOF/,/^[[:space:]]*EOF/{/cat <</d;/^[[:space:]]*EOF/d;/^[[:space:]]*$/d;p;}' | head -1 | sed 's/^[[:space:]]*//')
fi

if [ -z "$MSG" ]; then
  # Can't parse message — allow and let git handle it
  exit 0
fi

# Check conventional commit format: type(scope): description  OR  type: description
FIRST_LINE=$(echo "$MSG" | head -1)
if ! echo "$FIRST_LINE" | grep -qE '^(feat|fix|chore|docs|style|refactor|perf|test|ci|build|revert)(\(.+\))?[[:space:]]*:[[:space:]]*..+'; then
  echo "WARNING: Commit message doesn't follow conventional commit format."
  echo "  Got: $FIRST_LINE"
  echo "  Expected: type(scope): description"
  echo "  Types: feat, fix, chore, docs, style, refactor, perf, test, ci, build, revert"
  echo ""
  echo "Allowing anyway — this is a soft warning."
fi

exit 0
